import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { advanceSystem } from "@richman/game-core";
import { startServer } from "../src/http.js";
import { RoomManager } from "../src/rooms/manager.js";
import { loadAllRooms } from "../src/rooms/recovery.js";
import { SessionRegistry, SnapshotSessionStore } from "../src/rooms/session.js";
import { FileRoomStore } from "../src/storage/file-store.js";
import type { ActivationUndo, RoomSnapshot } from "../src/storage/types.js";
import { Peer } from "./persistence-harness.js";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function setup(offline = false) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "richman-undo-"));
  dirs.push(dir);
  const store = new FileRoomStore(dir);
  let clock = 0;
  const now = () => clock;
  const manager = new RoomManager({
    generateRoomCode: () => "4040",
    generateGameId: () => "g-undo",
    generateToken: () => "test-token-valid-for-resume",
    now,
    rng: () => 0,
  });
  manager.setStore(store);
  const code = await manager.createRoomPersisted(1);
  const sessions = new SessionRegistry(manager, { store: new SnapshotSessionStore(manager) });
  const human = sessions.join(code, "人类");
  manager.setReadyFor(code, human.playerId, true);
  manager.startFor(code, human.playerId);
  Object.assign(manager.getGame(code)!, advanceSystem(manager.getGame(code)!, {
    actorId: "SYSTEM", nowMs: 0, drawResult: 0,
  }).state);
  if (offline) {
    clock = 77;
    manager.disconnectFor(code, human.playerId);
  }
  await manager.persist(code);
  const snapshot = manager.exportRoom(code)!;
  return { dir, store, manager, code, snapshot, human, now, setNow: (value: number) => { clock = value; } };
}

function undoFor(code: string, snapshot: NonNullable<ReturnType<RoomManager["exportRoom"]>>, expectedVersion: number): ActivationUndo {
  const beforeGame = structuredClone(snapshot.game)!;
  beforeGame.version = 0;
  return {
    schemaVersion: 1,
    roomCode: code,
    gameId: snapshot.gameId,
    joinedPlayerId: snapshot.hostId!,
    expectedVersion,
    beforeGame,
    noHumanSinceMs: 77,
    pauseStartedAtMs: 70,
    pauseShifted: false,
    writtenAtMs: 1,
  };
}

async function undoExists(dir: string, code: string): Promise<boolean> {
  const entries = await readdir(path.join(dir, "rooms", code));
  return entries.includes("activation-undo.json");
}

describe("A 激活跨重启补偿 activation-undo", () => {
  it("磁盘仍是未激活形态：loadAll 回到 beforeGame 且 paused=true", async () => {
    const { dir, store, code, snapshot } = await setup(true);
    expect(snapshot.game!.version).toBe(1);
    await store.writeActivationUndo(code, undoFor(code, snapshot, snapshot.game!.version));

    const loaded = await store.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.game!.version).toBe(0);
    expect(loaded[0]!.paused).toBe(true);
    expect(loaded[0]!.noHumanSinceMs).toBe(77);
    expect(loaded[0]!.pauseStartedAtMs).toBe(70);
    expect(await undoExists(dir, code)).toBe(false);
    // 磁盘权威点也必须回滚，而不是只在内存里。
    const onDisk = JSON.parse(await readFile(path.join(dir, "rooms", code, "snapshot.json"), "utf8")) as { game: { version: number }; paused: boolean };
    expect(onDisk.game.version).toBe(0);
    expect(onDisk.paused).toBe(true);
  });

  it("stale undo（版本已推进）只删记录，不改游戏", async () => {
    const { dir, store, code, snapshot } = await setup();
    await store.writeActivationUndo(code, undoFor(code, snapshot, snapshot.game!.version + 1));

    const loaded = await store.loadAll();
    expect(loaded[0]!.game!.version).toBe(1);
    expect(await undoExists(dir, code)).toBe(false);
  });

  it("正常激活清理后 undo 不存在", async () => {
    const { dir, manager, code, snapshot } = await setup();
    await manager.writeActivationUndo(code, undoFor(code, snapshot, snapshot.game!.version));
    expect(await undoExists(dir, code)).toBe(true);
    await manager.deleteActivationUndo(code);
    expect(await undoExists(dir, code)).toBe(false);

    const loaded = await new FileRoomStore(dir).loadAll();
    expect(loaded[0]!.game!.version).toBe(1);
  });

  it("undo 损坏：保留房间并暂停，不删档", async () => {
    const { dir, code } = await setup();
    await writeFile(path.join(dir, "rooms", code, "activation-undo.json"), "{ not-json", "utf8");

    const loaded = await new FileRoomStore(dir).loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.paused).toBe(true);
    expect(await undoExists(dir, code)).toBe(true);
  });
});

describe("激活补偿回滚判据", () => {
  it("T1 跨局版本碰撞只清理过期记录", async () => {
    const { dir, code, store, snapshot } = await setup(true);
    const version = snapshot.game!.version;
    const undo = undoFor(code, snapshot, version);
    await store.writeActivationUndo(code, {
      ...undo, gameId: "previous-game", beforeGame: { ...undo.beforeGame!, gameId: "previous-game" },
    });

    const [loaded] = await store.loadAll();
    expect(loaded!.game!.gameId).toBe(snapshot.gameId);
    expect(loaded!.game!.version).toBe(version);
    expect(await undoExists(dir, code)).toBe(false);
  });

  it("T2 回滚目标校验失败保留原游戏、原磁盘快照与补偿记录", async () => {
    const { dir, code, store, snapshot } = await setup(true);
    const undo = undoFor(code, snapshot, snapshot.game!.version);
    await store.writeActivationUndo(code, {
      ...undo, beforeGame: { ...undo.beforeGame!, gameId: "invalid-target" },
    });
    const file = path.join(dir, "rooms", code, "snapshot.json");
    const before = await readFile(file, "utf8");
    const warnings: string[] = [];

    const recovered = await loadAllRooms(new FileRoomStore(dir, { warn: message => warnings.push(message) }));
    const room = recovered.exportRoom(code)!;
    expect(room.game!.gameId).toBe(room.gameId);
    expect(room.game).toEqual(snapshot.game);
    expect(room.paused).toBe(true);
    expect(await readFile(file, "utf8")).toBe(before);
    expect(await undoExists(dir, code)).toBe(true);
    expect(warnings).toContainEqual(expect.stringContaining("激活补偿回滚校验失败"));
  });

  it("T3 激活成功但删除记录失败，重启与再次恢复身份不会回滚或二次平移", async () => {
    const { dir, code, manager, snapshot, human, now, setNow } = await setup(true);
    class RetainUndoStore extends FileRoomStore {
      override async deleteActivationUndo(): Promise<void> { throw new Error("injected undo deletion failure"); }
    }
    manager.setStore(new RetainUndoStore(dir));
    const file = path.join(dir, "rooms", code, "snapshot.json");
    const resume = async (port: number) => {
      const peer = await new Peer(`ws://127.0.0.1:${port}/ws?room=${code}`).open();
      peer.send({ type: "resume", roomCode: code, sessionToken: human.sessionToken });
      await peer.next("joined");
      return (await peer.next("snapshot")).view;
    };
    const reconnectAt = 100_000;
    const restartAt = 110_000;
    const once = snapshot.game!.windowDeadlineMs! + reconnectAt - snapshot.noHumanSinceMs!;
    setNow(reconnectAt);
    // The first manager already owns the live room. Only the second server loads it from disk.
    const first = await startServer({ port: 0, manager, wsOptions: { now } });
    try {
      const view = await resume(first.port);
      const disk = JSON.parse(await readFile(file, "utf8")) as RoomSnapshot;
      const undo = JSON.parse(await readFile(path.join(dir, "rooms", code, "activation-undo.json"), "utf8")) as ActivationUndo;
      expect(disk.game!.version).toBe(undo.expectedVersion);
      expect(Date.parse(view.deadlineAt)).toBe(once);
      expect(disk.players.find(player => player.playerId === human.playerId)?.online).toBe(true);
      expect(disk.pausedByNoHuman).toBe(false);
      expect(disk.noHumanSinceMs).toBeNull();
      expect(disk.pauseStartedAtMs).toBeNull();
    } finally {
      // Shut down before closing the peer so the committed online snapshot stays on disk.
      await first.close();
    }

    setNow(restartAt);
    const restarted = await startServer({ port: 0, store: new FileRoomStore(dir), wsOptions: { now }, manager: new RoomManager({ now }) });
    try {
      const recovered = restarted.manager.exportRoom(code)!;
      expect(recovered.pauseStartedAtMs).toBe(restartAt);
      expect(recovered.pauseShifted).toBe(true);
      expect(recovered.game!.windowDeadlineMs).toBe(once);
      expect(await undoExists(dir, code)).toBe(false);

      const view = await resume(restarted.port);
      expect(Date.parse(view.deadlineAt)).toBe(once);
      expect(view.version).toBe(snapshot.game!.version + 1);
      expect(view.paused).toBe(true);
      const disk = JSON.parse(await readFile(file, "utf8")) as RoomSnapshot;
      expect(disk.game!.windowDeadlineMs).toBe(once);
      expect(disk.pauseStartedAtMs).toBeNull();
    } finally {
      await restarted.close();
    }
  }, 15_000);

  it("T4 缺 gameId 的旧补偿记录按过期清理并正常加载房间", async () => {
    const { dir, code, store, snapshot } = await setup(true);
    const { gameId: _oldGameId, joinedPlayerId: _oldPlayer, ...legacy } = undoFor(code, snapshot, snapshot.game!.version);
    await writeFile(path.join(dir, "rooms", code, "activation-undo.json"), JSON.stringify(legacy), "utf8");

    const [loaded] = await store.loadAll();
    expect(loaded!.game).toEqual(snapshot.game);
    expect(loaded!.paused).toBe(true);
    expect(await undoExists(dir, code)).toBe(false);
  });
});
