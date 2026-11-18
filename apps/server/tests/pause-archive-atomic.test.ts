import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { advanceSystem, createInitialState } from "@richman/game-core";
import type { EngineState } from "@richman/game-core";
import { startServer } from "../src/http.js";
import { RoomManager } from "../src/rooms/manager.js";
import { GameCommandProcessor, RoomCommandQueue } from "../src/rooms/command-queue.js";
import { ROOM_PAUSE_ARCHIVE_MS } from "../src/rooms/lifecycle.js";
import { FileRoomStore } from "../src/storage/file-store.js";
import { Peer } from "./persistence-harness.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

async function table(phase: "ACTION" | "BETTING" | "TAX" = "ACTION") {
  let clock = 1_000;
  const dir = await mkdtemp(path.join(os.tmpdir(), "richman-pause-atomic-"));
  const store = new FileRoomStore(dir);
  const manager = new RoomManager({ now: () => clock, createGameState: (id, config, seeds) => {
    const state = advanceSystem(createInitialState(id, config, seeds), { actorId: "SYSTEM", nowMs: clock, drawResult: 0 }).state as EngineState;
    if (phase === "BETTING") Object.assign(state, { phase, currentSeatId: null, actedSeats: [1, 2],
      deadlineAt: new Date(46_000).toISOString(), windowDeadlineMs: 46_000 });
    if (phase === "TAX") {
      Object.assign(state, { phase, round: 3, currentSeatId: null, taxSeats: [1, 2], taxIndex: 1,
        dangerSeatId: 1, dangerDeadlineMs: 61_000, deadlineAt: new Date(61_000).toISOString(), windowDeadlineMs: 61_000 });
      state.players[0]!.cents = -500; state.players[0]!.status = "DANGER";
    }
    return state;
  } });
  const server = await startServer({ host: "0.0.0.0", port: 0, manager, store, wsOptions: { now: () => clock } });
  let stopped = false;
  const stop = async () => { if (!stopped) { stopped = true; await server.close(); } };
  const peers: Peer[] = [];
  cleanups.push(async () => {
    store.options.checkpoint = undefined;
    await Promise.all(peers.map(p => p.close())); await stop(); await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.port}`;
  const { roomCode: code } = await (await fetch(base + "/api/rooms", { method: "POST", headers: { "content-type":"application/json" }, body: "{}" })).json() as {roomCode: string};
  const open = async () => { const p = await new Peer(`ws://127.0.0.1:${server.port}/ws?room=${code}`).open(); peers.push(p); return p; };
  const join = async (nickname: string) => { const p = await open(); p.send({ type: "join", nickname }); const identity = await p.next("joined"); await p.next("room"); return { p, identity }; };
  const a = await join("甲"), b = await join("乙");
  a.p.send({ type: "ready", ready: true }); b.p.send({ type: "ready", ready: true });
  await a.p.next("room", m => m.players.every((p: {ready: boolean}) => p.ready)); a.p.send({ type: "start" });
  await a.p.next("started");
  expect(manager.getGame(code)!.phase).toBe(phase);
  await Promise.all([a.p.close(), b.p.close()]);
  await expect.poll(() => manager.isNoHumanOnline(code)).toBe(true);
  const before = structuredClone(manager.getGame(code)!);
  return { dir, store, manager, server, stop, code, a, b, before, open, now: (n: number) => { clock = n; },
    saved: async () => JSON.parse(await readFile(path.join(dir, "rooms", code, "snapshot.json"), "utf8")) };
}

it("N1 invalid resume never consumes pause or changes the game on disk", async () => {
  const h = await table(); h.now(100_000);
  const p = await h.open(); p.send({ type: "resume", roomCode: h.code, sessionToken: "invalid-token-not-authenticated" });
  expect((await p.next("error")).code).toBe("UNAUTHORIZED");
  expect(h.manager.getGame(h.code)).toEqual(h.before);
  expect((await h.saved()).game).toEqual(h.before);
  expect(h.manager.isNoHumanOnline(h.code)).toBe(true);
  expect(h.manager.getPauseSince(h.code)).toBe(1_000);
});

it("N1 disconnect during identity persistence leaves the timeline and archive start intact", async () => {
  const h = await table(); h.now(100_000);
  const p = await h.open(); let reached!: () => void; let release!: () => void;
  const barrier = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  h.store.options.checkpoint = async point => { if (point === "after_rename") { reached(); await gate; } };
  try {
    p.send({ type: "resume", roomCode: h.code, sessionToken: h.a.identity.sessionToken });
    await barrier; await p.close(); h.store.options.checkpoint = undefined; release();
    await expect.poll(() => h.manager.isNoHumanOnline(h.code)).toBe(true);
    // A second queued authentication is a barrier after disconnect compensation.
    const probe = await h.open(); probe.send({ type: "resume", roomCode: h.code, sessionToken: "invalid-token-not-authenticated" }); await probe.next("error");
    expect(h.manager.getGame(h.code)).toEqual(h.before);
    expect((await h.saved()).game).toEqual(h.before);
    expect(h.manager.getPauseSince(h.code)).toBe(1_000);
  } finally { h.store.options.checkpoint = undefined; release(); }
});

it.each(["ACTION", "BETTING", "TAX"] as const)("N1 N2 %s reconnect preserves remaining time and persists consumption", async phase => {
  const h = await table(phase); h.now(100_000);
  const p = await h.open(); p.send({ type: "resume", roomCode: h.code, sessionToken: h.a.identity.sessionToken });
  await p.next("joined"); const view = (await p.next("snapshot")).view;
  expect(view.phase).toBe(phase); expect(view.version).toBe(h.before.version + 1);
  expect(Date.parse(view.deadlineAt)).toBe(h.before.windowDeadlineMs! + 99_000);
  expect(h.manager.getGame(h.code)!.players).toEqual(h.before.players);
  const saved = await h.saved(); expect(saved.pauseShifted).toBe(true); expect(saved.pauseStartedAtMs).toBeNull();
  const loaded = await h.store.loadAll(); const recovered = new RoomManager({ now: () => 200_000 }); recovered.restoreRoom(loaded[0]!);
  expect(recovered.getGame(h.code)).toEqual(h.manager.getGame(h.code));
  expect(recovered.getPauseSince(h.code)).toBeNull();
  const q = new RoomCommandQueue(); const processor = new GameCommandProcessor({ queue: q, getState: code => recovered.getGame(code),
    pauseSince: code => recovered.getPauseSince(code), markPauseShifted: code => recovered.markPauseShifted(code),
    now: () => 200_000, advance: () => undefined, commit: async (code, result) => recovered.commitTransition(code, result) });
  expect(await processor.resumeFromPause(h.code)).toBe(false);
  expect(recovered.getGame(h.code)!.version).toBe(saved.game.version);
});

it("N2 N3 committed shift persists its marker while an offline room still reaches archive eligibility", async () => {
  const h = await table(); h.now(100_000);
  const queue = new RoomCommandQueue();
  const processor = new GameCommandProcessor({ queue, getState: code => h.manager.getGame(code),
    pauseSince: code => h.manager.getPauseSince(code), markPauseShifted: code => h.manager.markPauseShifted(code),
    now: () => 100_000, advance: () => undefined, commit: async (code, result) => h.manager.commitTransition(code, result) });
  expect(await processor.resumeFromPause(h.code)).toBe(true);
  const saved = await h.saved(); expect(saved.pauseShifted).toBe(true); expect(saved.pauseStartedAtMs).toBe(1_000);
  expect(h.manager.getPauseSince(h.code)).toBeNull();
  h.now(1_000 + ROOM_PAUSE_ARCHIVE_MS);
  expect(h.manager.canArchive(h.code)).toBe(true);
  expect(await queue.run(h.code, () => h.manager.archiveRoom(h.code))).toBe(true);
  expect(h.manager.getRoom(h.code)).toBeNull();
  expect(await readFile(path.join(h.dir, "archive", h.code, "snapshot.json"), "utf8")).toContain(h.code);
});

it("N5 a clock rollback returning false keeps the room offline without scheduler catch-up", async () => {
  const h = await table(); h.now(999);
  const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const p = await h.open(); p.send({ type: "resume", roomCode: h.code, sessionToken: h.a.identity.sessionToken });
  // Whether joined was already delivered is separate from activating the authenticated connection.
  expect((await p.next("error")).code).toBe("ERROR_PAUSED");
  expect(h.manager.getGame(h.code)).toEqual(h.before);
  expect(h.manager.isNoHumanOnline(h.code)).toBe(true);
  expect((await h.saved()).game).toEqual(h.before);
  expect(warnings.mock.calls.some(call => String(call[0]).includes(h.code))).toBe(true);
});

it("N6 overflow during successful authentication rolls back the shift and keeps pause", async () => {
  const h = await table(); h.now(8_640_000_000_000_000);
  const p = await h.open(); p.send({ type: "resume", roomCode: h.code, sessionToken: h.a.identity.sessionToken });
  expect((await p.next("error")).code).toBe("ERROR_PAUSED");
  expect(h.manager.getGame(h.code)).toEqual(h.before); expect(h.manager.isNoHumanOnline(h.code)).toBe(true);
  expect((await h.saved()).game).toEqual(h.before);
});

it("N8 no archive capability refuses removal and preserves the real room snapshot", async () => {
  const h = await table(); h.now(1_000 + ROOM_PAUSE_ARCHIVE_MS);
  h.manager.setStore({ commitRoom: h.store.commitRoom.bind(h.store), deleteRoom: h.store.deleteRoom.bind(h.store) });
  expect(await new RoomCommandQueue().run(h.code, () => h.manager.archiveRoom(h.code))).toBe(false);
  expect(h.manager.getRoom(h.code)).not.toBeNull(); expect((await h.saved()).game).toEqual(h.before);
});

it("N8 archive rechecks eligibility after an earlier reconnect in the same queue", async () => {
  const h = await table(); h.now(1_000 + ROOM_PAUSE_ARCHIVE_MS);
  const queue = new RoomCommandQueue();
  await queue.run(h.code, () => h.manager.transact(h.code, () => h.manager.restoreIdentity(h.code, h.a.identity.playerId, h.a.identity.sessionToken)));
  expect(await queue.run(h.code, () => h.manager.archiveRoom(h.code))).toBe(false);
  expect(h.manager.getRoom(h.code)).not.toBeNull(); expect((await h.saved()).game).toEqual(h.before);
});

it("N8 a real archive filesystem error retains memory and the room file", async () => {
  const h = await table(); h.now(1_000 + ROOM_PAUSE_ARCHIVE_MS);
  await rm(path.join(h.dir, "archive"), { recursive: true, force: true });
  await writeFile(path.join(h.dir, "archive"), "not a directory");
  await expect(new RoomCommandQueue().run(h.code, () => h.manager.archiveRoom(h.code))).rejects.toThrow();
  expect(h.manager.getRoom(h.code)).not.toBeNull(); expect((await h.saved()).game).toEqual(h.before);
});

it("N1 final activation disconnected during write restores the original pause transaction", async () => {
  const h = await table(); h.now(100_000);
  const p = await h.open(); let release!: () => void; let reached!: () => void; let writes = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const barrier = new Promise<void>(resolve => { reached = resolve; });
  h.store.options.checkpoint = async point => { if (point === "after_rename" && ++writes === 2) { reached(); await gate; } };
  try {
    p.send({ type: "resume", roomCode: h.code, sessionToken: h.a.identity.sessionToken });
    await p.next("joined"); await barrier; await p.close(); h.store.options.checkpoint = undefined; release();
    const probe = await h.open(); probe.send({ type: "resume", roomCode: h.code, sessionToken: "invalid-token-not-authenticated" }); await probe.next("error");
    expect(h.manager.getGame(h.code)).toEqual(h.before); expect((await h.saved()).game).toEqual(h.before);
    expect(h.manager.isNoHumanOnline(h.code)).toBe(true);
    expect((await h.saved()).pauseStartedAtMs).toBe(1_000);
  } finally { h.store.options.checkpoint = undefined; release(); }
});

it("N1 N3 after-rename activation failure compensates game and keeps the original archive age", async () => {
  const h = await table(); h.now(100_000); let writes = 0;
  h.store.options.checkpoint = point => { if (point === "after_rename" && ++writes === 2) throw new Error("activation publish failed"); };
  const p = await h.open(); p.send({ type: "resume", roomCode: h.code, recoveryCode: h.a.identity.recoveryCode });
  await p.next("joined"); expect((await p.next("error")).code).toBe("ERROR_PAUSED");
  h.store.options.checkpoint = undefined;
  expect(h.manager.getGame(h.code)).toEqual(h.before); expect((await h.saved()).game).toEqual(h.before);
  expect(h.manager.isNoHumanOnline(h.code)).toBe(true); expect((await h.saved()).pauseStartedAtMs).toBe(1_000);
  h.now(1_000 + ROOM_PAUSE_ARCHIVE_MS); expect(h.manager.canArchive(h.code)).toBe(true);
});

it("N2 restarting the actual server then resuming a token cannot apply the consumed shift twice", async () => {
  const h = await table(); h.now(100_000);
  const p = await h.open(); p.send({ type: "resume", roomCode: h.code, sessionToken: h.a.identity.sessionToken });
  await p.next("joined"); await p.next("snapshot"); const shifted = (await h.saved()).game;
  await h.stop();
  const restarted = await startServer({ host: "0.0.0.0", port: 0, store: h.store,
    manager: new RoomManager({ now: () => 200_000 }), wsOptions: { now: () => 200_000 } });
  const q = await new Peer(`ws://127.0.0.1:${restarted.port}/ws?room=${h.code}`).open();
  cleanups.push(async () => { await q.close(); await restarted.close(); });
  q.send({ type: "resume", roomCode: h.code, sessionToken: h.a.identity.sessionToken });
  await q.next("joined"); const view = (await q.next("snapshot")).view;
  expect(view.paused).toBe(true); expect(view.version).toBe(shifted.version); expect(view.deadlineAt).toBe(shifted.deadlineAt);
  expect((await h.saved()).game).toEqual(shifted); expect((await h.saved()).pauseShifted).toBe(true);
});

it("N1 N2 concurrent token recoveries consume one offline interval exactly once", async () => {
  const h = await table(); h.now(100_000);
  const peers = await Promise.all([h.open(), h.open()]);
  await Promise.all(peers.map(async p => {
    p.send({ type: "resume", roomCode: h.code, sessionToken: h.a.identity.sessionToken });
    await p.next("joined"); await p.next("room");
  }));
  const saved = await h.saved(); expect(saved.game.version).toBe(h.before.version + 1);
  expect(saved.game.windowDeadlineMs).toBe(h.before.windowDeadlineMs! + 99_000); expect(saved.pauseShifted).toBe(true);
});

it("N5 a zero elapsed interval activates without a version bump or deadline change", async () => {
  const h = await table();
  const p = await h.open(); p.send({ type: "resume", roomCode: h.code, sessionToken: h.a.identity.sessionToken });
  await p.next("joined");
  await expect.poll(() => p.history.find(m => m.type === "snapshot" || m.type === "error")).toBeDefined();
  const outcome = p.history.find(m => m.type === "snapshot" || m.type === "error")!;
  expect(outcome.type).toBe("snapshot"); expect(h.manager.getGame(h.code)).toEqual(h.before);
  expect(h.manager.isNoHumanOnline(h.code)).toBe(false); expect((await h.saved()).pauseShifted).toBe(true);
});
