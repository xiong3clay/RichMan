import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { PROTOCOL_VERSION } from "@richman/shared";
import { startServer } from "../src/http.js";

/**
 * Run with: pnpm exec tsx apps/server/tests/rematch-smoke.ts
 * Two real WS clients verify zero-bet locking and a clean, playable rematch.
 * Only the GAME_OVER transition is a test fixture; HTTP, identities, commands,
 * snapshots, broadcasts and the replacement game's engine are real.
 */
type Json = Record<string, unknown>;
interface Waiter {
  matches: (message: Json) => boolean;
  resolve: (message: Json) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class SmokeClient {
  readonly messages: Json[] = [];
  private readonly inbox: Json[] = [];
  private readonly waiters: Waiter[] = [];
  private readonly socket: WebSocket;

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as Json;
      this.messages.push(message);
      const index = this.waiters.findIndex((waiter) => waiter.matches(message));
      if (index < 0) this.inbox.push(message);
      else {
        const waiter = this.waiters.splice(index, 1)[0]!;
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    });
    this.socket.on("error", (error) => this.rejectPending(error));
    this.socket.on("close", () => this.rejectPending(new Error("WS connection closed")));
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.once("open", resolve);
      this.socket.once("error", reject);
    });
  }

  send(message: Json): void {
    assert.equal(this.socket.readyState, WebSocket.OPEN, "WS must be open before sending");
    this.socket.send(JSON.stringify(message));
  }

  discardInbox(): void {
    assert.equal(this.waiters.length, 0);
    this.inbox.length = 0;
  }

  next(type: string, check: (message: Json) => boolean = () => true): Promise<Json> {
    return this.match((message) => message["type"] === type && check(message), type);
  }

  match(matches: (message: Json) => boolean, label: string): Promise<Json> {
    const index = this.inbox.findIndex(matches);
    if (index >= 0) return Promise.resolve(this.inbox.splice(index, 1)[0]!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const at = this.waiters.findIndex((waiter) => waiter.timer === timer);
        if (at >= 0) this.waiters.splice(at, 1);
        reject(new Error("Timeout waiting for " + label));
      }, 4000);
      this.waiters.push({ matches, resolve, reject, timer });
    });
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => this.socket.terminate(), 1000);
      this.socket.once("close", () => { clearTimeout(timer); resolve(); });
      this.socket.close();
    });
  }

  private rejectPending(error: Error): void {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}

function viewOf(message: Json): Json { return message["view"] as Json; }
function financeOf(view: Json): Json { return view["finance"] as Json; }
function rosterOf(message: Json): unknown[] {
  return (message["players"] as Json[]).map((player) => ({
    playerId: player["playerId"], seatId: player["seatId"],
    nickname: player["nickname"], online: player["online"],
  }));
}
function command(gameId: string, commandId: string, type: string, payload: Json, extra: Json = {}): Json {
  return { protocolVersion: PROTOCOL_VERSION, gameId, commandId, type, payload, ...extra };
}
async function replyFor(client: SmokeClient, sent: Json): Promise<Json> {
  client.send(sent);
  return client.next("command_result", (message) => message["commandId"] === sent["commandId"]);
}
function assertOk(reply: Json, label: string): void {
  assert.equal((reply["outcome"] as Json)["ok"], true, label + ": " + JSON.stringify(reply["outcome"]));
}
function assertClean(view: Json, gameId: string, playerId: unknown): void {
  assert.equal(view["schemaVersion"], 1);
  assert.equal(view["gameId"], gameId);
  assert.equal(view["round"], 1);
  assert.ok(view["phase"] === "INTEREST" || view["phase"] === "ACTION");
  assert.equal((view["me"] as Json)["playerId"], playerId);
  assert.equal(view["winnerId"], null);
  const finance = financeOf(view);
  assert.equal(finance["cents"], "10000", "new game must reset to 100 coins");
  for (const field of ["bankLoans", "privateLoans", "incomingRequests", "betsSubmitted"]) {
    assert.deepEqual(finance[field], [], "new game must clear " + field);
  }
  for (const field of ["bankDebtCents", "bankDefaultedDebtCents", "privateDebtCents", "receivableCents", "frozenCents", "badDebtCents"]) {
    assert.equal(finance[field], "0", "new game must clear " + field);
  }
  assert.equal(finance["pendingRequest"], null);
  assert.equal(finance["myBet"], null, "new game must clear previous zero-bet lock");
}

async function main(): Promise<void> {
  const server = await startServer({
    host: "0.0.0.0", port: 0,
    staticDir: path.resolve("apps/web/does-not-exist-in-rematch-smoke"),
  });
  const clients: SmokeClient[] = [];
  console.log("[05D-smoke] listening " + server.host + ":" + String(server.port));
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) {
        console.log("[05D-smoke] LAN http://" + entry.address + ":" + String(server.port));
      }
    }
  }
  try {
    const response = await fetch("http://127.0.0.1:" + String(server.port) + "/api/rooms", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nickname: "房主甲" }),
    });
    assert.equal(response.status, 201);
    const body = await response.json() as Json;
    assert.equal(body["ok"], true);
    const roomCode = String(body["roomCode"]);
    assert.match(roomCode, /^[0-9]{4,8}$/);
    const url = "ws://127.0.0.1:" + String(server.port) + "/ws?room=" + roomCode;
    const a = new SmokeClient(url);
    clients.push(a);
    await a.open();
    a.send({ type: "join", nickname: "房主甲" });
    const aJoined = await a.next("joined");
    const b = new SmokeClient(url);
    clients.push(b);
    await b.open();
    b.send({ type: "join", nickname: "客人乙" });
    const bJoined = await b.next("joined");
    assert.equal(aJoined["seatId"], 1);
    assert.equal(bJoined["seatId"], 2);
    a.send({ type: "ready", ready: true });
    b.send({ type: "ready", ready: true });
    const readyRoom = await a.next("room", (message) => (message["players"] as Json[]).length === 2
      && (message["players"] as Json[]).every((player) => player["ready"] === true));
    const originalRoster = rosterOf(readyRoom);
    a.send({ type: "start" });
    const oldStarted = await a.next("started");
    const oldGameId = String(oldStarted["gameId"]);
    assert.equal((await b.next("started"))["gameId"], oldGameId);
    const actionA = viewOf(await a.next("snapshot", (message) => viewOf(message)["phase"] === "ACTION"
      && viewOf(message)["currentSeatId"] === 1));
    const oldBorrow = command(oldGameId, "same-id-across-games", "BORROW_BANK", { amountCents: "2500" },
      { expectedGameVersion: actionA["version"] });
    assertOk(await replyFor(a, oldBorrow), "old game bank loan");
    const actionB = viewOf(await b.next("snapshot", (message) => viewOf(message)["phase"] === "ACTION"
      && viewOf(message)["currentSeatId"] === 2));
    assertOk(await replyFor(b, command(oldGameId, "old-b-end", "END_ACTION", {},
      { expectedGameVersion: actionB["version"] })), "guest ends action");
    const betting = viewOf(await a.next("snapshot", (message) => viewOf(message)["phase"] === "BETTING"));
    assert.equal((financeOf(betting)["bankLoans"] as Json[]).length, 1);
    const betFields = { roundId: betting["round"], phaseInstanceId: betting["phaseInstanceId"] };
    assertOk(await replyFor(a, command(oldGameId, "old-a-give-up", "SUBMIT_BET",
      { betCents: "0", guess: 0, leverage: 1 }, betFields)), "zero-bet shortcut");
    const locked = viewOf(await a.next("snapshot", (message) => viewOf(message)["phase"] === "BETTING"
      && financeOf(viewOf(message))["myBet"] !== null));
    assert.deepEqual(financeOf(locked)["myBet"], { betCents: "0", guess: 0, leverage: 1 });
    assert.equal(financeOf(locked)["cents"], "12500", "locking zero bet does not deduct funds");
    const lockedAgain = await replyFor(a, command(oldGameId, "old-a-change-lock", "SUBMIT_BET",
      { betCents: "100", guess: 1, leverage: 1 }, betFields));
    assert.equal((lockedAgain["outcome"] as Json)["ok"], false);
    assert.equal((lockedAgain["outcome"] as Json)["code"], "ALREADY_LOCKED");
    assert.equal(lockedAgain["gameVersion"], locked["version"], "rejected edit does not change gameVersion");
    for (const client of clients) {
      await client.next("events", (message) => (message["events"] as Json[]).some((event) => event["type"] === "BET_SUBMITTED"));
    }
    console.log("[05D-smoke] PASS zero-bet 0/0/1 locks once; edits rejected with ALREADY_LOCKED");

    // Explicit test-only fixture: keep the real debt, bet and event sequence so
    // the replacement must clear them. No alternate rematch path is mocked.
    const oldState = server.manager.getGame(roomCode);
    assert.ok(oldState);
    assert.equal(oldState.bankLoans.length, 1);
    assert.ok(oldState.bets["p1"]);
    const oldEventSeq = oldState.eventSeq;
    Object.assign(oldState, { phase: "GAME_OVER", winnerId: "p1", deadlineAt: null, windowDeadlineMs: null });
    for (const client of clients) client.discardInbox();
    const checkpoints = new Map(clients.map((client) => [client, client.messages.length]));
    a.send({ type: "rematch" });
    const newStarted = await a.match((message) => message["type"] === "started" || message["type"] === "error", "rematch started/error");
    assert.equal(newStarted["type"], "started", "rematch rejected: " + JSON.stringify(newStarted));
    const newGameId = String(newStarted["gameId"]);
    assert.notEqual(newGameId, oldGameId, "rematch must use a fresh gameId");
    assert.equal(newStarted["roomCode"], roomCode);
    const bStarted = await b.next("started");
    assert.equal(bStarted["gameId"], newGameId);
    assert.equal(bStarted["roomCode"], roomCode);
    const freshViews = new Map<SmokeClient, Json>();
    for (const [client, joined] of [[a, aJoined], [b, bJoined]] as const) {
      const room = await client.next("room", (message) => message["state"] === "PLAYING"
        && rosterOf(message).length === 2);
      assert.deepEqual(rosterOf(room), originalRoster, "player/seat/nickname/online identities must survive rematch");
      assert.equal(room["hostId"], aJoined["playerId"]);
      const fresh = viewOf(await client.next("snapshot", (message) => viewOf(message)["gameId"] === newGameId));
      assertClean(fresh, newGameId, joined["playerId"]);
      assert.ok((fresh["eventSeq"] as number) < oldEventSeq, "new game must reset old event sequence");
      freshViews.set(client, fresh);
    }
    console.log("[05D-smoke] PASS rematch broadcasts fresh gameId; seats/nicknames/online identities preserved; debt/bets/winner cleared");

    const firstFresh = freshViews.get(a)!;
    const freshAction = firstFresh["phase"] === "ACTION" ? firstFresh : viewOf(await a.next("snapshot",
      (message) => viewOf(message)["gameId"] === newGameId && viewOf(message)["phase"] === "ACTION"
        && viewOf(message)["currentSeatId"] === 1));
    const freshBorrow = command(newGameId, "same-id-across-games", "BORROW_BANK", { amountCents: "1000" },
      { expectedGameVersion: freshAction["version"] });
    const freshReply = await replyFor(a, freshBorrow);
    assertOk(freshReply, "command in rematch using previous game commandId");
    assert.equal(freshReply["gameId"], newGameId);
    const afterBorrow = viewOf(await a.next("snapshot", (message) => viewOf(message)["gameId"] === newGameId
      && financeOf(viewOf(message))["cents"] === "11000"));
    const newLoans = financeOf(afterBorrow)["bankLoans"] as Json[];
    assert.equal(newLoans.length, 1);
    assert.equal(newLoans[0]!["principalCents"], "1000", "old cached loan result must not satisfy new command");
    await b.next("snapshot", (message) => viewOf(message)["gameId"] === newGameId
      && viewOf(message)["version"] === afterBorrow["version"]);
    for (const client of clients) {
      const following = client.messages.slice(checkpoints.get(client)!);
      const events = following.filter((message) => message["type"] === "events");
      assert.ok(events.length > 0, "new-game events must be observable");
      assert.ok(events.every((message) => message["gameId"] === newGameId), "old-game events must never replay");
      assert.ok(events.every((message) => (message["events"] as Json[]).every((event) => event["type"] !== "BET_SUBMITTED")),
        "old betting event must not appear in new-game stream");
    }
    console.log("[05D-smoke] PASS new-game command accepted on original sockets; commandId isolated by gameId; old events not replayed");
    console.log("[05D-smoke] PASS");
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    await server.close();
    console.log("[05D-smoke] server and client sockets closed");
  }
}

main().then(
  () => { process.exitCode = 0; },
  (error: unknown) => {
    console.error("[05D-smoke] FAIL: " + (error instanceof Error ? error.stack ?? error.message : String(error)));
    process.exitCode = 1;
  },
);
