import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { advanceSystem } from "@richman/game-core";
import { RoomManager } from "../src/rooms/manager.js";
import { FileRoomStore } from "../src/storage/file-store.js";
import { SessionRegistry, SnapshotSessionStore } from "../src/rooms/session.js";
import {
  AI_LOBBY_TTL_MS,
  LOBBY_OFFLINE_ARCHIVE_MS,
  ROOM_PAUSE_ARCHIVE_MS,
} from "../src/rooms/lifecycle.js";
import { BotDriver } from "../src/bots/driver.js";

const dirs: string[] = [];
const drivers: BotDriver[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(async () => {
  for (const driver of drivers.splice(0)) driver.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

function manager(now: () => number): RoomManager {
  let next = 0;
  return new RoomManager({
    generateRoomCode: () => "20" + String(next++).padStart(2, "0"),
    generateGameId: () => "g-" + String(next++),
    generateToken: () => "token-" + String(next++),
    rng: () => 0,
    now,
  });
}

async function tempStore(): Promise<FileRoomStore> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "richman-life-"));
  dirs.push(dir);
  return new FileRoomStore(dir);
}

describe("P1-1 生命周期：删除 vs 归档", () => {
  it("纯 AI 大厅 5 分钟仍直接删除，且不进入归档候选", async () => {
    const store = await tempStore();
    let nowMs = 0;
    const m = manager(() => nowMs);
    m.setStore(store);
    const code = await m.createRoomPersisted(2);

    expect(m.reclaimCandidates(AI_LOBBY_TTL_MS - 1)).toEqual([]);
    expect(m.archiveCandidates(AI_LOBBY_TTL_MS)).toEqual([]);
    nowMs = AI_LOBBY_TTL_MS;
    expect(m.reclaimCandidates()).toEqual([code]);
    expect(await m.reclaimRoom(code)).toBe(true);
    expect(m.getRoom(code)).toBeNull();
    expect(await store.loadAll()).toEqual([]);
  });

  it("PLAYING 无人在线 10 分钟不删除；7 天后只归档，存档仍在", async () => {
    const store = await tempStore();
    let nowMs = 0;
    const m = manager(() => nowMs);
    m.setStore(store);
    const code = await m.createRoomPersisted(1);
    const sessions = new SessionRegistry(m, { store: new SnapshotSessionStore(m) });
    const human = sessions.join(code, "人类");
    m.setReadyFor(code, human.playerId, true);
    m.startFor(code, human.playerId);
    await m.persist(code);
    m.disconnectFor(code, human.playerId);

    // 10 分钟、1 天都不是删除候选，也不是归档候选。
    expect(m.reclaimCandidates(10 * 60_000)).toEqual([]);
    expect(m.archiveCandidates(24 * 60 * 60_000)).toEqual([]);
    expect(m.getRoom(code)).not.toBeNull();

    nowMs = ROOM_PAUSE_ARCHIVE_MS;
    expect(m.reclaimCandidates()).toEqual([]);
    expect(m.archiveCandidates()).toEqual([code]);
    expect(await m.archiveRoom(code)).toBe(true);
    expect(m.getRoom(code)).toBeNull();
    const archived = await readdir(path.join(store.root, "archive", code));
    expect(archived).toContain("snapshot.json");
    expect(await store.loadAll()).toEqual([]);
  });

  it("有真人座位的离线 LOBBY 30 分钟后归档；29:59 不动", async () => {
    const store = await tempStore();
    let nowMs = 0;
    const m = manager(() => nowMs);
    m.setStore(store);
    const code = await m.createRoomPersisted(1);
    const sessions = new SessionRegistry(m, { store: new SnapshotSessionStore(m) });
    const joined = sessions.join(code, "人类");
    await m.persist(code);
    m.disconnectFor(code, joined.playerId);

    expect(m.reclaimCandidates(LOBBY_OFFLINE_ARCHIVE_MS - 1)).toEqual([]);
    expect(m.archiveCandidates(LOBBY_OFFLINE_ARCHIVE_MS - 1)).toEqual([]);
    expect(m.archiveCandidates(LOBBY_OFFLINE_ARCHIVE_MS)).toEqual([code]);
    nowMs = LOBBY_OFFLINE_ARCHIVE_MS;
    expect(await m.archiveRoom(code)).toBe(true);
    const archived = await readdir(path.join(store.root, "archive", code));
    expect(archived).toContain("snapshot.json");
  });

  it("宽限期内重连不会丢档，归档候选立即消失", async () => {
    let nowMs = 0;
    const m = manager(() => nowMs);
    const code = m.createRoom(1);
    const human = m.join(code, "人类");
    m.setReadyFor(code, human.playerId, true);
    m.startFor(code, human.playerId);
    m.disconnectFor(code, human.playerId);
    expect(m.isNoHumanOnline(code)).toBe(true);

    nowMs = ROOM_PAUSE_ARCHIVE_MS - 1;
    m.restoreIdentity(code, human.playerId, "new-token");
    expect(m.isNoHumanOnline(code)).toBe(false);
    expect(m.archiveCandidates(nowMs)).toEqual([]);
    expect(m.getRoom(code)).not.toBeNull();
  });

  it("sweep 与重连同房间队列顺序：先重连则 canReclaim/canArchive 都为 false", async () => {
    const { RoomCommandQueue } = await import("../src/rooms/command-queue.js");
    const queue = new RoomCommandQueue();
    let nowMs = 0;
    const m = manager(() => nowMs);
    const code = m.createRoom(1);
    const human = m.join(code, "人类");
    m.setReadyFor(code, human.playerId, true);
    m.startFor(code, human.playerId);
    m.disconnectFor(code, human.playerId);
    nowMs = ROOM_PAUSE_ARCHIVE_MS;

    // 模拟重连与 sweep 同时到：重连先入队，sweep 复查时必须看到已恢复在线。
    const reconnect = queue.run(code, () => {
      m.restoreIdentity(code, human.playerId, "new-token");
      return true;
    });
    const sweep = queue.run(code, () => ({
      reclaim: m.canReclaim(code, nowMs),
      archive: m.canArchive(code, nowMs),
    }));
    await reconnect;
    expect(await sweep).toEqual({ reclaim: false, archive: false });
    expect(m.getRoom(code)).not.toBeNull();
  });
});

describe("P2-8 生命周期时间戳持久化", () => {
  it("多次 transact 不会重置 createdAtMs；重启恢复沿用快照时间", () => {
    let nowMs = 0;
    const m = manager(() => nowMs);
    const code = m.createRoom(1);
    const human = m.join(code, "人类");
    nowMs = 120_000;
    m.setReadyFor(code, human.playerId, true);
    expect(m.exportRoom(code)?.createdAtMs).toBe(0);

    const snapshot = m.exportRoom(code)!;
    const restarted = manager(() => 900_000);
    restarted.restoreRoom(snapshot);
    expect(restarted.exportRoom(code)?.createdAtMs).toBe(0);
  });

  it("旧快照缺生命周期字段时按恢复时刻重新计时", () => {
    const m = manager(() => 0);
    const code = m.createRoom(1);
    const snapshot = m.exportRoom(code)!;
    delete snapshot.createdAtMs;
    delete snapshot.noHumanSinceMs;
    delete snapshot.pausedByNoHuman;
    const restarted = manager(() => 5_000);
    restarted.restoreRoom(snapshot);
    expect(restarted.exportRoom(code)?.createdAtMs).toBe(5_000);
  });

  it("PLAYING 的离线起点随快照保存，重启后继续累计", () => {
    let nowMs = 0;
    const m = manager(() => nowMs);
    const code = m.createRoom(1);
    const human = m.join(code, "人类");
    m.setReadyFor(code, human.playerId, true);
    m.startFor(code, human.playerId);
    m.disconnectFor(code, human.playerId);
    const snapshot = m.exportRoom(code)!;
    expect(snapshot.noHumanSinceMs).toBe(0);
    const restarted = manager(() => 60_000);
    restarted.restoreRoom(snapshot);
    expect(restarted.exportRoom(code)?.noHumanSinceMs).toBe(0);
    expect(restarted.isNoHumanOnline(code)).toBe(true);
  });
});

describe("无真人在线时 BotDriver 不行动；重连后继续推进", () => {
  it("暂停期间不提交命令，重连后恢复", async () => {
    const m = manager(() => 0);
    const code = m.createRoom(1);
    const human = m.join(code, "人类");
    m.setReadyFor(code, human.playerId, true);
    m.startFor(code, human.playerId);
    Object.assign(m.getGame(code)!, advanceSystem(m.getGame(code)!, {
      actorId: "SYSTEM", nowMs: 0, drawResult: 0,
    }).state);
    const versionBefore = m.getGame(code)!.version;

    const commands: string[] = [];
    const driver = new BotDriver({
      manager: m,
      execute: async (_room, _bot, command) => {
        commands.push(command.type);
        return { outcome: { ok: true } };
      },
      now: () => 0,
      rng: () => 0,
      delayMs: () => 0,
    });
    drivers.push(driver);

    m.disconnectFor(code, human.playerId);
    expect(m.isNoHumanOnline(code)).toBe(true);
    driver.notify(code);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    expect(commands).toEqual([]);
    expect(m.getGame(code)!.version).toBe(versionBefore);

    m.restoreIdentity(code, human.playerId, "new-token");
    driver.notify(code);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    expect(commands).toEqual(["END_ACTION"]);
  });
});
