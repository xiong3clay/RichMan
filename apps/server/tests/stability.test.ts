import { afterEach, expect, it } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { startServer } from "../src/http.js";
import { DEFAULT_SECURITY_LIMITS } from "../src/security.js";
import { FileRoomStore } from "../src/storage/file-store.js";
import type { RoomSnapshot } from "../src/storage/types.js";
import { Peer, type Message } from "./persistence-harness.js";

class StabilityPeer extends Peer {
  closeCode: number | null = null;
  constructor(url: string) {
    super(url);
    this.ws.on("close", code => { this.closeCode = code; });
  }
}
type Member = { p: StabilityPeer; joined: Message };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
const gameBytes = (saved: RoomSnapshot) => JSON.stringify(saved.game);

/** Disk harness pattern, with explicit existing security configuration for load scenarios.
 * Defaults allow only five immediate resumes/ten room creations, unrelated to these resource tests.
 * No security implementation or production defaults are changed or bypassed.
 */
async function harness() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "richman-stability-"));
  const store = new FileRoomStore(dir);
  const server = await startServer({ host: "0.0.0.0", port: 0, store,
    wsOptions: { now: () => 1_000 },
    security: { limits: { ...DEFAULT_SECURITY_LIMITS, resumeBurst: 50, createRoomBurst: 20, joinBurst: 20 } },
  });
  const peers: StabilityPeer[] = [];
  cleanups.push(async () => {
    await Promise.all(peers.map(p => p.close()));await server.close();
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.port}`;
  const open = async (code: string) => {
    const p = await new StabilityPeer(`ws://127.0.0.1:${server.port}/ws?room=${code}`).open();
    peers.push(p);return p;
  };
  return { dir, base, open,
    async create() {
      const response = await fetch(base + "/api/rooms", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(response.status).toBe(201);
      return (await response.json() as { roomCode: string }).roomCode;
    },
    async connect(code: string, credentials?: Record<string, string>): Promise<Member> {
      const p = await open(code);
      p.send(credentials ? { type: "resume", roomCode: code, ...credentials } : { type: "join", nickname: "玩家" + peers.length });
      const joined = await p.next("joined");await p.next("room");return { p, joined };
    },
    async saved(code: string): Promise<RoomSnapshot> {
      return JSON.parse(await readFile(path.join(dir, "rooms", code, "snapshot.json"), "utf8"));
    },
  };
}
type Harness = Awaited<ReturnType<typeof harness>>;
async function health(base: string, connections: number, rooms: number) {
  await expect.poll(async () => {
    const value = await (await fetch(base + "/health")).json() as Message;
    return { connections: value.connections, rooms: value.rooms };
  }, { timeout: 2_000, interval: 10 }).toEqual({ connections, rooms });
}
async function table(h: Harness, count: number) {
  const code = await h.create(), members: Member[] = [];
  for (let i = 0; i < count; i++) members.push(await h.connect(code));
  for (const member of members) member.p.send({ type: "ready", ready: true });
  await members[0]!.p.next("room", m => m.players.length === count && m.players.every((p: Message) => p.ready));
  members[0]!.p.send({ type: "start" });await members[0]!.p.next("started");
  const view = (await members[0]!.p.next("snapshot", m => m.view.phase === "ACTION")).view;
  return { code, members, view };
}
function envelope(view: Message, id: string, type: string, payload: Record<string, unknown>) {
  return { protocolVersion: 1, gameId: view.gameId, commandId: id, type, payload,
    expectedGameVersion: view.version, roundId: view.round, phaseInstanceId: view.phaseInstanceId };
}
async function execute(p: Peer, view: Message, id: string, type: string, payload: Record<string, unknown>) {
  p.send(envelope(view, id, type, payload));
  const reply = await p.next("command_result", m => m.commandId === id);
  expect(reply.outcome.ok, `${id}: ${JSON.stringify(reply.outcome)}`).toBe(true);
  return (await p.next("snapshot", m => m.view.gameId === view.gameId && m.view.version === reply.gameVersion)).view;
}
async function destroyed(peers: StabilityPeer[], code: string) {
  await expect.poll(() => peers.every(p => p.closeCode === 4002
    && p.history.some(m => m.type === "room_destroyed" && m.roomCode === code)),
  { timeout: 2_000, interval: 10 }).toBe(true);
}
async function rejectToken(h: Harness, code: string, token: string, expectedCode?: string) {
  const p = await h.open(code);p.send({ type: "resume", roomCode: code, sessionToken: token });
  const error = await p.next("error");
  if (expectedCode) expect(error.code).toBe(expectedCode);
  else expect(error.code).toBe("UNAUTHORIZED");
  expect(p.history.some(m => m.type === "joined")).toBe(false);
  p.send({ type: "ready", ready: true });expect((await p.next("error")).code).toBe("NOT_JOINED");
  await p.close();return error;
}

it("T6 ten_players_round: ten real seats act and lock bets, then destroy releases every connection", async () => {
  const h = await harness();const { code, members, view: initial } = await table(h, 10);
  expect(members.map(m => m.joined.seatId)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  expect(new Set(members.map(m => m.joined.playerId)).size).toBe(10);
  await health(h.base, 10, 1);
  let view = initial;
  for (let i = 0; i < 10; i++) {
    expect(view.phase).toBe("ACTION");expect(view.currentSeatId).toBe(i + 1);
    view = await execute(members[i]!.p, view, "end-" + i, "END_ACTION", {});
  }
  expect(view.phase).toBe("BETTING");
  for (let i = 0; i < 10; i++) view = await execute(members[i]!.p, view, "bet-" + i, "SUBMIT_BET", { betCents: "0", guess: 0, leverage: 1 });
  const saved = await h.saved(code);
  expect(saved.game!.round).toBe(2);expect(saved.lastEvents.some(e => e.type === "BET_SETTLED")).toBe(true);
  await health(h.base, 10, 1);
  members[0]!.p.send({ type: "destroy_room" });
  await destroyed(members.map(m => m.p), code);await health(h.base, 0, 0);
}, 30_000);

it("T7 room_lifecycle_release: twelve real create/join/destroy cycles leave no room directories or connections", async () => {
  const h = await harness();
  for (let i = 0; i < 12; i++) {
    const code = await h.create();const member = await h.connect(code);
    member.p.send({ type: "destroy_room" });await destroyed([member.p], code);
    await health(h.base, 0, 0);
  }
  expect(await readdir(path.join(h.dir, "rooms"))).toEqual([]);
  await health(h.base, 0, 0);
}, 30_000);

it("T8 reconnect_storm: ten concurrent resumes preserve seats and rotate only recovery-code tokens", async () => {
  const h = await harness();const { code, members } = await table(h, 10);
  const before = await h.saved(code);
  await Promise.all(members.map(m => m.p.close()));await health(h.base, 0, 1);
  const restored = await Promise.all(members.map((member, i) => h.connect(code, i < 5
    ? { sessionToken: member.joined.sessionToken } : { recoveryCode: member.joined.recoveryCode })));
  expect(restored.map(m => m.joined.seatId)).toEqual(members.map(m => m.joined.seatId));
  for (let i = 0; i < 10; i++) {
    expect(restored[i]!.joined.playerId).toBe(members[i]!.joined.playerId);
    if (i < 5) expect(restored[i]!.joined.sessionToken).toBe(members[i]!.joined.sessionToken);
    else {
      expect(restored[i]!.joined.sessionToken).not.toBe(members[i]!.joined.sessionToken);
      await rejectToken(h, code, members[i]!.joined.sessionToken);
    }
  }
  await health(h.base, 10, 1);
  const rooms = await (await fetch(h.base + "/api/rooms")).json() as Message;
  expect(rooms.rooms).toEqual([{ roomCode: code, state: "PLAYING", paused: false, playerCount: 10 }]);
  expect(gameBytes(await h.saved(code))).toBe(gameBytes(before));
  await Promise.all(restored.slice(0, 5).map(m => m.p.close()));await health(h.base, 5, 1);
  await Promise.all(restored.slice(5).map(m => m.p.close()));await health(h.base, 0, 1);
}, 30_000);

it("T9 recovery_race: concurrent reusable recovery credentials leave one current socket and one valid token", async () => {
  const h = await harness();const { code, members, view } = await table(h, 2);
  const original = members[0]!, before = await h.saved(code);
  const peers = await Promise.all([h.open(code), h.open(code)]);
  const recovered = await Promise.all(peers.map(async p => {
    p.send({ type: "resume", roomCode: code, recoveryCode: original.joined.recoveryCode });
    const joined = await p.next("joined");await p.next("room");return { p, joined };
  }));
  const after = await h.saved(code);
  expect(after.sessions.filter(s => s.playerId === original.joined.playerId)).toHaveLength(1);
  expect(after.players.filter(p => p.playerId === original.joined.playerId)).toHaveLength(1);
  expect(after.sessions).toHaveLength(2);expect(after.players).toHaveLength(2);
  const current = after.sessions.find(s => s.playerId === original.joined.playerId)!;
  expect(current.recoveryDigest).toBe(before.sessions.find(s => s.playerId === original.joined.playerId)!.recoveryDigest);
  const valid = recovered.filter(m => digest(m.joined.sessionToken) === current.tokenDigest);
  expect(valid).toHaveLength(1);
  const winner = valid[0]!, loser = recovered.find(m => m !== winner)!;
  // A rejected economic operation proves the remaining authenticated socket reaches the engine,
  // while preserving the exact game bytes required by this identity-only scenario.
  await winner.p.next("snapshot", m => m.view.version === view.version); // Drain authentication snapshot first.
  const snapshotsBeforeCommand = winner.p.history.filter(m => m.type === "snapshot").length;
  winner.p.send(envelope(view, "race-current", "BORROW_BANK", { amountCents: "0" }));
  expect((await winner.p.next("command_result", m => m.commandId === "race-current")).outcome)
    .toMatchObject({ ok: false, code: "INVALID_AMOUNT" });
  expect((await winner.p.next("snapshot", m => m.view.version === view.version)).view.version).toBe(view.version);
  expect(winner.p.history.filter(m => m.type === "snapshot")).toHaveLength(snapshotsBeforeCommand + 1);
  // The superseded socket must be closed before we inspect disk: a closed socket
  // cannot deliver a stale command at all, which is stronger than fire-and-forget.
  await expect.poll(() => loser.p.closeCode === 4001
    && loser.p.history.some(m => m.type === "error" && m.code === "REPLACED"),
  { timeout: 2_000, interval: 10 }).toBe(true);
  expect(loser.p.ws.readyState).toBe(WebSocket.CLOSED);
  await health(h.base, 2, 1); // Also detects a replaced socket left physically open.
  expect(gameBytes(await h.saved(code))).toBe(gameBytes(before));
  expect((await h.saved(code)).game!.version).toBe(before.game!.version);
  const stale = recovered.find(m => m !== winner)!;
  await rejectToken(h, code, stale.joined.sessionToken);
  const takeover = await h.connect(code, { sessionToken: winner.joined.sessionToken });
  expect(takeover.joined.sessionToken).toBe(winner.joined.sessionToken);
  await health(h.base, 2, 1);
  expect(gameBytes(await h.saved(code))).toBe(gameBytes(before));
}, 30_000);

it("T10 stale_token_after_rotation: an old token cannot authenticate or let its replaced socket change game bytes", async () => {
  const h = await harness();const { code, members, view } = await table(h, 2);
  const old = members[0]!, before = await h.saved(code);
  const fresh = await h.connect(code, { recoveryCode: old.joined.recoveryCode });
  expect(fresh.joined.sessionToken).not.toBe(old.joined.sessionToken);
  await rejectToken(h, code, old.joined.sessionToken, "UNAUTHORIZED");
  await expect.poll(() => old.p.closeCode === 4001
    && old.p.history.some(m => m.type === "error" && m.code === "REPLACED"),
  { timeout: 2_000, interval: 10 }).toBe(true);
  expect(old.p.ws.readyState).toBe(WebSocket.CLOSED);
  await health(h.base, 2, 1);
  expect(gameBytes(await h.saved(code))).toBe(gameBytes(before));
  expect((await h.saved(code)).game!.version).toBe(view.version);
}, 30_000);

function ipc(child: ChildProcess, type: string): Promise<Message> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.off("message", message);reject(new Error("IPC " + type)); }, 10_000);
    const message = (value: unknown) => {
      const record = value as Message;
      if (record.type === type) { clearTimeout(timeout);child.off("message", message);resolve(record); }
    };
    child.on("message", message);
  });
}
async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  expect(child.kill("SIGKILL")).toBe(true);await exited;
}

it("T11 kill_restart_midgame: real SIGKILL preserves the full locked game, then host resume and final bet settle once", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "richman-stability-kill-"));
  const children: ChildProcess[] = [], peers: StabilityPeer[] = [];
  cleanups.push(async () => { await Promise.all(children.map(kill));await Promise.all(peers.map(p => p.close()));await rm(dir, { recursive: true, force: true }); });
  const boot = async () => {
    const child = fork(fileURLToPath(new URL("./recovery-worker.ts", import.meta.url)), [], {
      execArgv: ["--import", "tsx"], env: { ...process.env, RICHMAN_DATA_DIR: dir },
      stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
    });
    children.push(child);const { port } = await ipc(child, "ready");
    const base = `http://127.0.0.1:${port}`;
    const connect = async (code: string, token?: string): Promise<Member> => {
      const p = await new StabilityPeer(`ws://127.0.0.1:${port}/ws?room=${code}`).open();peers.push(p);
      p.send(token ? { type: "resume", roomCode: code, sessionToken: token } : { type: "join", nickname: "玩家" + peers.length });
      const joined = await p.next("joined");await p.next("room");return { p, joined };
    };
    return { child, base, connect };
  };
  let server = await boot();
  const response = await fetch(server.base + "/api/rooms", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  expect(response.status).toBe(201);const { roomCode: code } = await response.json() as { roomCode: string };
  const members = [await server.connect(code), await server.connect(code), await server.connect(code)];
  for (const member of members) member.p.send({ type: "ready", ready: true });
  await members[0]!.p.next("room", m => m.players.every((p: Message) => p.ready));
  members[0]!.p.send({ type: "start" });await members[0]!.p.next("started");
  let view = (await members[0]!.p.next("snapshot", m => m.view.phase === "ACTION")).view;
  // Restore nonempty financial history and distinct balances, not an initial empty book.
  view = await execute(members[0]!.p, view, "ask", "REQUEST_PRIVATE_LOAN",
    { lenderId: "p2", principalCents: "500", rateBps: 1000 });
  const requestId = view.finance.pendingRequest.requestId;
  view = await execute(members[1]!.p, view, "accept", "ACCEPT_PRIVATE_LOAN", { requestId });
  view = await execute(members[1]!.p, view, "borrow", "BORROW_BANK", { amountCents: "1000" });
  view = await execute(members[2]!.p, view, "end-last", "END_ACTION", {});
  expect(view.phase).toBe("BETTING");
  for (let i = 0; i < 2; i++) view = await execute(members[i]!.p, view, "lock-" + i, "SUBMIT_BET",
    { betCents: String((i + 1) * 100), guess: i, leverage: 1 });
  await kill(server.child);expect(server.child.exitCode !== null || server.child.signalCode !== null).toBe(true);
  const killed: RoomSnapshot = JSON.parse(await readFile(path.join(dir, "rooms", code, "snapshot.json"), "utf8"));
  expect(killed.game!.phase).toBe("BETTING");expect(Object.keys(killed.game!.bets)).toEqual(["p1", "p2"]);
  expect(killed.game!.players.map(p => p.cents)).toEqual([10_500, 10_500, 10_000]);
  expect(killed.game!.bankLoans).toHaveLength(1);expect(killed.game!.privateLoans).toHaveLength(1);
  expect(killed.game!.requests).toHaveLength(1);expect(killed.game!.requests[0]!.status).toBe("ACCEPTED");
  server = await boot();await health(server.base, 0, 1);
  const restored = await Promise.all(members.map(m => server.connect(code, m.joined.sessionToken)));
  const views = await Promise.all(restored.map(m => m.p.next("snapshot", v => v.view.paused === true)));
  for (let i = 0; i < views.length; i++) {
    const current = views[i]!.view;
    expect(current.version).toBe(killed.game!.version);expect(current.eventSeq).toBe(killed.game!.eventSeq);
    expect(current.phase).toBe(killed.game!.phase);expect(current.round).toBe(killed.game!.round);
    expect(current.finance.cents).toBe(String(killed.game!.players[i]!.cents));
    expect(current.finance.myBet).toEqual(i < 2 ? { betCents: String((i + 1) * 100), guess: i, leverage: 1 } : null);
  }
  // Resume authentication persists the loaded in-memory candidate. Comparing this newly written
  // game with the kill-point disk game checks the loader, rather than rereading the same old file.
  const reauthenticated: RoomSnapshot = JSON.parse(await readFile(path.join(dir, "rooms", code, "snapshot.json"), "utf8"));
  expect(reauthenticated.paused).toBe(true);
  expect(reauthenticated.game).toEqual(killed.game);expect(gameBytes(reauthenticated)).toBe(gameBytes(killed));
  restored[0]!.p.send({ type: "resume_game" });
  const resumed = (await restored[0]!.p.next("snapshot", m => m.view.paused === false && m.view.version === killed.game!.version + 1)).view;
  const continued: RoomSnapshot = JSON.parse(await readFile(path.join(dir, "rooms", code, "snapshot.json"), "utf8"));
  expect(continued.lastEvents[0]!.type).toBe("GAME_RESUMED");expect(continued.game!.version).toBe(killed.game!.version + 1);
  expect(continued.game!.players).toEqual(killed.game!.players);expect(continued.game!.requests).toEqual(killed.game!.requests);
  expect(continued.game!.bankLoans).toEqual(killed.game!.bankLoans);expect(continued.game!.privateLoans).toEqual(killed.game!.privateLoans);
  expect(continued.game!.bets).toEqual(killed.game!.bets);
  const settled = await execute(restored[2]!.p, resumed, "last-lock", "SUBMIT_BET", { betCents: "0", guess: 0, leverage: 1 });
  expect(settled.round).toBe(2);expect(settled.phase).toBe("ACTION");
  const final: RoomSnapshot = JSON.parse(await readFile(path.join(dir, "rooms", code, "snapshot.json"), "utf8"));
  const settlements = final.lastEvents.filter(e => e.type === "BET_SETTLED").length;
  expect(settlements).toBe(1);
  const drawResult = (final.lastEvents.find(e => e.type === "BET_SETTLED")!.payload as { drawResult: number }).drawResult;
  expect([0, 1]).toContain(drawResult);
  expect(final.game!.players.map(p => p.cents)).toEqual([
    10_500 + (drawResult === 0 ? 100 : -100), 10_500 + (drawResult === 1 ? 200 : -200), 10_000,
  ]);
  expect(final.game!.bets).toEqual({});
  console.log("[11B SIGKILL]", JSON.stringify({ players: 3, locked: 2, phase: killed.game!.phase,
    killedVersion: killed.game!.version, restoredVersion: reauthenticated.game!.version,
    allGameFieldsEqual: gameBytes(reauthenticated) === gameBytes(killed), resumedVersion: continued.game!.version,
    bankLoans: killed.game!.bankLoans.length, privateLoans: killed.game!.privateLoans.length,
    requests: killed.game!.requests.length, finalRound: final.game!.round, settlements }));
}, 30_000);
