import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BOT_PERSONALITIES, DEFAULT_BOT_PERSONALITY } from "@richman/shared";
import { RoomManager } from "../src/rooms/manager.js";
import { SessionRegistry, SnapshotSessionStore } from "../src/rooms/session.js";
import { FileRoomStore, validateSnapshot } from "../src/storage/file-store.js";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "richman-bots-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function managerWith(store: FileRoomStore, rng: () => number = () => 0.4): RoomManager {
  const manager = new RoomManager({
    generateRoomCode: () => "0042",
    generateGameId: () => "g-1",
    generateToken: () => "human-token",
    rng,
    now: () => 0,
  });
  manager.setStore(store);
  return manager;
}

describe("AI 座位的存档兼容", () => {
  it("纯 AI 大厅可以落盘并原样恢复：AI 仍在线、hostId 为 null、没有会话记录", async () => {
    const store = new FileRoomStore(await tempDir());
    const manager = managerWith(store);
    const code = await manager.createRoomPersisted(1);
    expect(code).toBe("0042");

    const loaded = await store.loadAll();
    expect(loaded).toHaveLength(1);
    const snapshot = loaded[0]!;
    expect(snapshot.hostId).toBeNull();
    expect(snapshot.sessions).toEqual([]);
    expect(snapshot.players).toEqual([
      expect.objectContaining({ playerId: "p1", seatId: 1, isBot: true, online: true, ready: true }),
    ]);
    expect(() => validateSnapshot(structuredClone(snapshot), code)).not.toThrow();
  });

  it("真人 + 2 AI 开局后提交不触发 ERROR_PAUSED，恢复时只有真人离线", async () => {
    const store = new FileRoomStore(await tempDir());
    const manager = managerWith(store);
    const code = await manager.createRoomPersisted(2);
    const sessions = new SessionRegistry(manager, { store: new SnapshotSessionStore(manager) });
    const human = sessions.join(code, "人类");
    manager.setReadyFor(code, human.playerId, true);
    manager.startFor(code, human.playerId);

    await manager.persist(code);
    const loaded = await store.loadAll();
    expect(loaded).toHaveLength(1);
    const snapshot = loaded[0]!;
    expect(snapshot.roomState).toBe("PLAYING");
    expect(snapshot.hostId).toBe(human.playerId);
    expect(snapshot.players.map((player) => [player.playerId, player.isBot === true, player.online])).toEqual([
      ["p1", true, true],
      ["p2", true, true],
      ["p3", false, false],
    ]);
    expect(snapshot.sessions.map((session) => session.playerId)).toEqual([human.playerId]);
    expect(() => validateSnapshot(structuredClone(snapshot), code)).not.toThrow();

    // 恢复后的房间仍能被管理器读取，AI 座位保持在线。
    const restored = new RoomManager();
    restored.restoreRoom(snapshot);
    expect(restored.getRoom(code)?.players.map((player) => [player.playerId, player.isBot === true, player.online])).toEqual([
      ["p1", true, true],
      ["p2", true, true],
      ["p3", false, false],
    ]);
  });

  it("房主不能被写成 AI 座位", async () => {
    const store = new FileRoomStore(await tempDir());
    const manager = managerWith(store);
    const code = await manager.createRoomPersisted(1);
    const snapshot = manager.exportRoom(code)!;
    snapshot.hostId = "p1";
    expect(() => validateSnapshot(snapshot, code)).toThrow("房主无效");
  });

  it("人格随快照存→读→恢复保持不变", async () => {
    const store = new FileRoomStore(await tempDir());
    let index = 0;
    const values = [0.1, 0.3, 0.7];
    const manager = managerWith(store, () => values[index++ % values.length]!);
    const code = await manager.createRoomPersisted(3);
    const before = manager.getRoom(code)!.players.map((player) => player.botPersonality);
    expect(new Set(before).size).toBeGreaterThan(1);

    const loaded = await store.loadAll();
    const fromDisk = loaded[0]!.players.map((player) => player.botPersonality);
    expect(fromDisk).toEqual(before);

    const restored = new RoomManager();
    restored.restoreRoom(loaded[0]!);
    expect(restored.getRoom(code)?.players.map((player) => player.botPersonality)).toEqual(before);
    for (const personality of fromDisk) expect(BOT_PERSONALITIES).toContain(personality!);
  });

  it("旧快照缺少 botPersonality 时恢复为 PASSIVE", async () => {
    const store = new FileRoomStore(await tempDir());
    const manager = managerWith(store);
    const code = await manager.createRoomPersisted(1);
    const snapshot = manager.exportRoom(code)!;
    delete snapshot.players[0]!.botPersonality;
    expect(() => validateSnapshot(structuredClone(snapshot), code)).not.toThrow();

    const restored = new RoomManager();
    restored.restoreRoom(snapshot);
    expect(restored.getRoom(code)?.players[0]?.botPersonality).toBe(DEFAULT_BOT_PERSONALITY);
  });
});
