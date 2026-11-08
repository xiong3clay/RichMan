import http from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import WebSocket from "ws";
import { startServer } from "../src/http.js";
import type { StartedServer } from "../src/http.js";
import { RoomManager } from "../src/rooms/manager.js";
import { attachLobbyWebSocket } from "../src/ws.js";
import { MemorySessionStore, SessionRegistry } from "../src/rooms/session.js";
import { ClientGameCommandSchema, ResumeSchema } from "@richman/shared";
import { DEFAULT_SECURITY_LIMITS } from "../src/security.js";
import type { SecurityLimits } from "../src/security.js";

type Message = Record<string, any>;
class Client {
  messages: Message[] = [];
  waiters: Array<{ predicate: (m: Message) => boolean; resolve: (m: Message) => void }> = [];
  constructor(readonly ws: WebSocket) {
    ws.on("message", raw => {
      const m = JSON.parse(String(raw)) as Message;
      const i = this.waiters.findIndex(w => w.predicate(m));
      if (i >= 0) this.waiters.splice(i, 1)[0]!.resolve(m);
      else this.messages.push(m);
    });
    ws.on("error", () => undefined);
  }
  send(m: unknown): void { this.ws.send(JSON.stringify(m)); }
  next(type: string, check: (m: Message) => boolean = () => true): Promise<Message> {
    const predicate = (m: Message): boolean => m.type === type && check(m);
    const i = this.messages.findIndex(predicate);
    if (i >= 0) return Promise.resolve(this.messages.splice(i, 1)[0]!);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve: (m: Message): void => { clearTimeout(timer); resolve(m); } };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(w => w !== waiter);
        reject(new Error("消息超时: " + type));
      }, 1500);
      this.waiters.push(waiter);
    });
  }
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function server(limits: Partial<SecurityLimits> = {}): Promise<StartedServer> {
  const started = await startServer({ host: "127.0.0.1", port: 0,
    security: { limits: { ...DEFAULT_SECURITY_LIMITS, ...limits } } });
  cleanups.push(() => started.close());
  return started;
}
async function open(port: number, room: string, options: WebSocket.ClientOptions = {}): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${room}`, options);
  const c = new Client(ws);
  await once(ws, "open");
  return c;
}
async function join(port: number, room: string, nickname: string): Promise<[Client, Message]> {
  const c = await open(port, room);
  c.send({ type: "join", nickname });
  return [c, await c.next("joined")];
}
async function game(count = 2): Promise<{ s: StartedServer; room: string; clients: Client[]; identities: Message[] }> {
  const s = await server();
  const room = s.manager.createRoom();
  const clients: Client[] = [], identities: Message[] = [];
  for (let i = 0; i < count; i++) {
    const [c, identity] = await join(s.port, room, `玩家${i}`);
    clients.push(c); identities.push(identity);
    c.send({ type: "ready", ready: true });
    await c.next("room", m => m.players.find((p: Message) => p.playerId === identity.playerId)?.ready);
  }
  clients[0]!.send({ type: "start" });
  await clients[0]!.next("started");
  await clients[0]!.next("snapshot");
  return { s, room, clients, identities };
}
function command(s: StartedServer, room: string, id: string, type: string, payload: unknown): Message {
  const state = s.manager.getGame(room)!;
  return { protocolVersion: 1, gameId: state.gameId, commandId: id, type, payload,
    expectedGameVersion: state.version, roundId: state.round, phaseInstanceId: state.phaseInstanceId };
}

it("join_secrets_private: 独立256位秘密只发本人，不出现在房间广播和health", async () => {
  const s = await server(), room = s.manager.createRoom();
  const [a, first] = await join(s.port, room, "甲");
  expect(first.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(first.recoveryCode).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(first.recoveryCode).not.toBe(first.sessionToken);
  const [b] = await join(s.port, room, "乙");
  b.send({ type: "ready", ready: true });
  const roomMessage = await a.next("room", m => m.players.length === 2);
  const health = await fetch(`http://127.0.0.1:${s.port}/health`).then(r => r.text());
  for (const text of [JSON.stringify(roomMessage), health, JSON.stringify(b.messages)]) {
    expect(text).not.toContain(first.sessionToken);
    expect(text).not.toContain(first.recoveryCode);
    expect(text).not.toContain("tokenDigest");
  }
});

it("refresh_same_seat: resume保留金币、行动、待办、合同与原deadline及已锁下注", async () => {
  const { s, room, clients, identities } = await game();
  const a = clients[0]!;
  a.send(command(s, room, "request", "REQUEST_PRIVATE_LOAN", { lenderId: "p2", principalCents: "500", rateBps: 1000 }));
  expect((await a.next("command_result")).outcome.ok).toBe(true);
  const before = structuredClone(s.manager.getGame(room));
  const replacement = await open(s.port, room);
  replacement.send({ type: "resume", roomCode: room, sessionToken: identities[0]!.sessionToken });
  expect(await replacement.next("joined")).toMatchObject({ playerId: "p1", seatId: 1 });
  const snapshot = await replacement.next("snapshot");
  expect(snapshot.view.finance.pendingRequest).not.toBeNull();
  expect(s.manager.getGame(room)).toEqual(before);
  clients[1]!.send(command(s, room, "accept", "ACCEPT_PRIVATE_LOAN", {
    requestId: before!.requests.find(request => request.borrowerId === "p1" && request.status === "PENDING")!.requestId,
  }));
  expect((await clients[1]!.next("command_result")).outcome.ok).toBe(true);
  clients[1]!.send(command(s, room, "end2", "END_ACTION", {}));
  expect((await clients[1]!.next("command_result")).outcome.ok).toBe(true);
  replacement.send(command(s, room, "bet", "SUBMIT_BET", { betCents: "250", guess: 1, leverage: 1 }));
  expect((await replacement.next("command_result")).outcome.ok).toBe(true);
  const locked = structuredClone(s.manager.getGame(room));
  const again = await open(s.port, room);
  again.send({ type: "resume", roomCode: room, sessionToken: identities[0]!.sessionToken });
  await again.next("joined");
  expect((await again.next("snapshot")).view.finance.myBet).toEqual({ betCents: "250", guess: 1, leverage: 1 });
  expect(s.manager.getGame(room)).toEqual(locked);
});

it("replace_connection: epoch递增且旧close/旧消息不影响新连接与游戏", async () => {
  const { s, room, clients, identities } = await game();
  const first = clients[0]!, state = structuredClone(s.manager.getGame(room));
  const replacement = await open(s.port, room);
  replacement.send({ type: "resume", roomCode: room, sessionToken: identities[0]!.sessionToken });
  const joined = await replacement.next("joined");
  expect(joined.connectionEpoch).toBeGreaterThan(identities[0]!.connectionEpoch);
  expect((await first.next("error")).code).toBe("REPLACED");
  if (first.ws.readyState !== WebSocket.CLOSED) await once(first.ws, "close");
  first.ws.send(JSON.stringify(command(s, room, "stale", "END_ACTION", {})));
  replacement.send(command(s, room, "probe", "END_ACTION", { playerId: "p2" }));
  expect((await replacement.next("command_result")).outcome.code).toBe("UNAUTHORIZED");
  expect(s.manager.getRoom(room)?.players[0]?.online).toBe(true);
  expect(s.manager.getGame(room)).toEqual(state);
});

it("recover_different_origin: recoveryCode回原座位并立即作废旧token", async () => {
  const s = await server({ allowedOrigins: ["https://different.example"] }), room = s.manager.createRoom();
  const [old, identity] = await join(s.port, room, "甲");
  const fresh = await open(s.port, room, { origin: "https://different.example" });
  fresh.send({ type: "resume", roomCode: room, recoveryCode: identity.recoveryCode });
  const recovered = await fresh.next("joined");
  expect(recovered).toMatchObject({ playerId: identity.playerId, seatId: identity.seatId });
  expect(recovered.sessionToken).not.toBe(identity.sessionToken);
  expect(recovered.recoveryCode).toBeUndefined();
  expect((await old.next("error")).code).toBe("REPLACED");
  const thief = await open(s.port, room);
  thief.send({ type: "resume", roomCode: room, sessionToken: identity.sessionToken });
  expect((await thief.next("error")).code).toBe("UNAUTHORIZED");
  expect(s.manager.getRoom(room)?.players).toHaveLength(1);
});

it("resume_room_bound: 跨房token/恢复码与无效join token均拒绝且不新建座位", async () => {
  const s = await server(), a = s.manager.createRoom(), b = s.manager.createRoom();
  const [, identity] = await join(s.port, a, "甲");
  const c = await open(s.port, b);
  for (const secret of [{ sessionToken: identity.sessionToken }, { recoveryCode: identity.recoveryCode }]) {
    c.send({ type: "resume", roomCode: b, ...secret });
    expect((await c.next("error")).code).toBe("UNAUTHORIZED");
  }
  c.send({ type: "join", nickname: "冒领", sessionToken: identity.sessionToken });
  expect((await c.next("error")).code).toBe("UNAUTHORIZED");
  expect(s.manager.getRoom(b)?.players).toHaveLength(0);
});

it("leave_detaches_before_broadcast: 离开者不接收自己的peer_left且大厅身份撤销", async () => {
  const s = await server(), room = s.manager.createRoom();
  const [a, identity] = await join(s.port, room, "甲"), [b] = await join(s.port, room, "乙");
  a.send({ type: "leave" });
  expect((await b.next("peer_left")).playerId).toBe("p1");
  a.send({ type: "ready", ready: true });
  expect((await a.next("error")).code).toBe("NOT_JOINED");
  expect(a.messages.some(m => m.type === "peer_left" && m.playerId === "p1")).toBe(false);
  a.send({ type: "resume", roomCode: room, recoveryCode: identity.recoveryCode });
  expect((await a.next("error")).code).toBe("UNAUTHORIZED");
});

it("offline_ready_roster: 全员断线仍保留准备和座位；带空洞名单开局身份正确", async () => {
  const s = await server(), room = s.manager.createRoom();
  const [a, ia] = await join(s.port, room, "甲"), [b] = await join(s.port, room, "乙"), [c] = await join(s.port, room, "丙");
  b.send({ type: "leave" }); await a.next("peer_left", m => m.playerId === "p2");
  a.send({ type: "ready", ready: true }); c.send({ type: "ready", ready: true });
  await a.next("room", m => m.players.every((p: Message) => p.ready));
  c.ws.close(); await once(c.ws, "close");
  a.send({ type: "start" }); await a.next("started"); await a.next("snapshot");
  expect(s.manager.getGame(room)?.players.map(p => [p.playerId, p.seatId])).toEqual([["p1", 1], ["p3", 3]]);
  a.ws.close(); await once(a.ws, "close");
  const back = await open(s.port, room);
  back.send({ type: "resume", roomCode: room, sessionToken: ia.sessionToken }); await back.next("joined");
  expect(s.manager.getRoom(room)?.players).toHaveLength(2);
  expect(s.manager.getRoom(room)?.players[1]).toMatchObject({ ready: true, online: false });
});

it("ten_bets_same_version: 十个真实WS同版本下注全部一次接受且他人锁注金额保密", async () => {
  const { s, room, clients } = await game(10);
  for (let i = 0; i < 10; i++) {
    clients[i]!.send(command(s, room, `end${i}`, "END_ACTION", {}));
    expect((await clients[i]!.next("command_result")).outcome.ok).toBe(true);
  }
  const bets = clients.map((_, i) => command(s, room, `bet${i}`, "SUBMIT_BET", { betCents: String(100 + i), guess: 0, leverage: 1 }));
  clients.forEach((c, i) => c.send(bets[i]));
  for (const c of clients) expect((await c.next("command_result")).outcome.ok).toBe(true);
  expect(s.manager.getGame(room)?.round).toBe(2);
  const snapshot = await clients[1]!.next("snapshot", m => m.view.phase === "BETTING" && m.view.finance.betsSubmitted.length > 0);
  expect(snapshot.view.finance.myBet).toBeNull();
  expect(snapshot.view.publicPlayers.every((p: Message) => p.cents === undefined)).toBe(true);
  expect(JSON.stringify(snapshot)).not.toContain('"betCents":"100"');
});

it("ack_lost_retry: 断线恢复后原转账命令只执行一次且同ID改金额被拒", async () => {
  const { s, room, clients, identities } = await game();
  clients[0]!.send(command(s, room, "ask", "REQUEST_PRIVATE_LOAN", { lenderId: "p2", principalCents: "500", rateBps: 0 }));
  expect((await clients[0]!.next("command_result")).outcome.ok).toBe(true);
  const accept = command(s, room, "transfer", "ACCEPT_PRIVATE_LOAN", {
    requestId: s.manager.getGame(room)!.requests.find(request => request.borrowerId === "p1" && request.status === "PENDING")!.requestId,
  });
  clients[1]!.send(accept);
  const committed = await clients[0]!.next("snapshot", m => m.view.finance.cents === "10500");
  expect(committed.view.finance.cents).toBe("10500");
  clients[1]!.ws.terminate(); await once(clients[1]!.ws, "close");
  const back = await open(s.port, room);
  back.send({ type: "resume", roomCode: room, sessionToken: identities[1]!.sessionToken }); await back.next("joined");
  back.send(accept); const replay = await back.next("command_result");
  expect(replay.outcome.ok).toBe(true);
  expect(s.manager.getGame(room)!.players.map(p => p.cents)).toEqual([10500, 9500]);
  back.send({ ...accept, payload: { ...accept.payload, amountCents: "501" } });
  expect((await back.next("command_result")).outcome.code).toBe("COMMAND_ID_REUSED");
});

it("private_events_filtered: 第三人快照/事件不含私人请求、合同金额", async () => {
  const { s, room, clients } = await game(3);
  clients[0]!.send(command(s, room, "private", "REQUEST_PRIVATE_LOAN", { lenderId: "p2", principalCents: "4321", rateBps: 1234 }));
  expect((await clients[0]!.next("command_result")).outcome.ok).toBe(true);
  const third = await clients[2]!.next("snapshot", m => m.view.version === s.manager.getGame(room)!.version);
  expect(third.view.finance.incomingRequests).toEqual([]);
  expect(JSON.stringify(third)).not.toContain("4321");
  clients[2]!.send(command(s, room, "barrier", "END_ACTION", {})); await clients[2]!.next("command_result");
  expect(JSON.stringify(clients[2]!.messages)).not.toContain("4321");
});

it("borrow_limit_wire: 快照下发的可借额度与出借上限是十进制字符串", async () => {
  const { s, room, identities } = await game();
  const replacement = await open(s.port, room);
  replacement.send({ type: "resume", roomCode: room, sessionToken: identities[0]!.sessionToken });
  await replacement.next("joined");
  const snapshot = await replacement.next("snapshot");
  expect(snapshot.view.finance.bankBorrowLimitCents).toBe("5000");
  expect(typeof snapshot.view.finance.bankBorrowLimitCents).toBe("string");
  expect(Array.isArray(snapshot.view.finance.lenderLimits)).toBe(true);
  expect(snapshot.view.finance.lenderLimits).toEqual([{ playerId: "p2", maxCents: "10000" }]);
  expect(typeof snapshot.view.finance.lenderLimits[0]!.maxCents).toBe("string");
  expect(JSON.stringify(snapshot.view.publicPlayers)).not.toContain('"cents"');
});

it("half_open_closed: 每10s ping，两次无pong关闭并保留离线座位", async () => {
  const manager = new RoomManager(), room = manager.createRoom(), raw = http.createServer();
  let tick: (() => void) | undefined;
  // Production clock injection lets the test advance heartbeats while retaining real WS control frames.
  const runtime = attachLobbyWebSocket(raw, manager, { heartbeatClock: {
    setInterval(callback: () => void, ms: number) { expect(ms).toBe(10000); tick = callback; return 1; },
    clearInterval() {},
  } });
  await new Promise<void>(resolve => raw.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { await runtime.close(); await new Promise<void>(resolve => raw.close(() => resolve())); });
  const port = (raw.address() as { port: number }).port;
  const c = await open(port, room, { autoPong: false });
  c.send({ type: "join", nickname: "半开" }); await c.next("joined");
  const ping1 = once(c.ws, "ping"); tick!(); await ping1;
  const ping2 = once(c.ws, "ping"); tick!(); await ping2;
  expect(manager.getRoom(room)?.players[0]?.online).toBe(true);
  const closed = once(c.ws, "close"); tick!(); await closed;
  expect(manager.getRoom(room)?.players).toHaveLength(1);
  expect(manager.getRoom(room)?.players[0]?.online).toBe(false);
});

it("session_store_digests: 注入store只存摘要，复用store可恢复且轮换删除旧索引", () => {
  const manager = new RoomManager(), room = manager.createRoom(), store = new MemorySessionStore();
  const registry = new SessionRegistry(manager, { store });
  const joined = registry.join(room, "甲");
  const hash = (s: string): string => createHash("sha256").update(s).digest("hex");
  const record = store.getByIdentity(room, joined.playerId)!;
  expect(record.tokenDigest).toBe(hash(joined.sessionToken));
  expect(record.recoveryDigest).toBe(hash(joined.recoveryCode));
  expect(JSON.stringify(record)).not.toContain(joined.sessionToken);
  expect(JSON.stringify(record)).not.toContain(joined.recoveryCode);
  // A caller cannot mutate the stored record through a returned reference.
  record.connectionEpoch = 99;
  expect(registry.claim(joined)).toBe(1);
  const recreated = new SessionRegistry(manager, { store });
  expect(recreated.resume(room, { sessionToken: joined.sessionToken }).playerId).toBe(joined.playerId);
  const recovered = recreated.resume(room, { recoveryCode: joined.recoveryCode });
  expect(store.getByTokenDigest(hash(joined.sessionToken))).toBeUndefined();
  expect(store.getByTokenDigest(hash(recovered.sessionToken))?.playerId).toBe(joined.playerId);
});

it("wire_schema: 客户端不能注入actorId或系统命令，金额必须为规范十进制字符串", () => {
  const base = { protocolVersion: 1, gameId: "g", commandId: "c", type: "BORROW_BANK", payload: { amountCents: "1" } };
  expect(ClientGameCommandSchema.safeParse(base).success).toBe(true);
  for (const amountCents of [1, "01", "-0", "1.0", "1000000000001"]) {
    expect(ClientGameCommandSchema.safeParse({ ...base, payload: { amountCents } }).success).toBe(false);
  }
  expect(ClientGameCommandSchema.safeParse({ ...base, actorId: "p2" }).success).toBe(false);
  expect(ClientGameCommandSchema.safeParse({ ...base, type: "SYSTEM_TIMEOUT" }).success).toBe(false);
  expect(ResumeSchema.safeParse({ type: "resume", roomCode: "0042" }).success).toBe(false);
});

it("pong_keeps_online: 匹配pong持续保活，心跳不会改变游戏版本或截止", async () => {
  const manager = new RoomManager(), room = manager.createRoom(), raw = http.createServer();
  let tick: (() => void) | undefined;
  const runtime = attachLobbyWebSocket(raw, manager, { heartbeatClock: {
    setInterval(callback: () => void) { tick = callback; return 1; }, clearInterval() {},
  } });
  await new Promise<void>(resolve => raw.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { await runtime.close(); await new Promise<void>(resolve => raw.close(() => resolve())); });
  const port = (raw.address() as { port: number }).port;
  const [a] = await join(port, room, "甲"), [b] = await join(port, room, "乙");
  a.send({ type: "ready", ready: true }); b.send({ type: "ready", ready: true });
  await a.next("room", m => m.players.every((p: Message) => p.ready));
  a.send({ type: "start" }); await a.next("snapshot");
  const before = structuredClone(manager.getGame(room));
  for (let i = 0; i < 4; i++) {
    const received = once(a.ws, "ping"); tick!(); await received;
    // Sending a harmless rejected command creates a network barrier after automatic pong.
    a.send({ type: "ready", ready: true }); expect((await a.next("error")).code).toBe("ALREADY_STARTED");
  }
  expect(manager.getRoom(room)?.players[0]?.online).toBe(true);
  expect(manager.getGame(room)).toEqual(before);
});

it("command_error_money_strings: 真实催收失败的合法上限也按字符串分传输", async () => {
  const { s, room, clients } = await game();
  clients[0]!.send(command(s, room, "ask-limit", "REQUEST_PRIVATE_LOAN", { lenderId: "p2", principalCents: "500", rateBps: 1000 }));
  expect((await clients[0]!.next("command_result")).outcome.ok).toBe(true);
  clients[1]!.send(command(s, room, "accept-limit", "ACCEPT_PRIVATE_LOAN", {
    requestId: s.manager.getGame(room)!.requests.find(request => request.borrowerId === "p1" && request.status === "PENDING")!.requestId,
  }));
  expect((await clients[1]!.next("command_result")).outcome.ok).toBe(true);
  clients[1]!.send(command(s, room, "end-limit", "END_ACTION", {}));
  expect((await clients[1]!.next("command_result")).outcome.ok).toBe(true);
  for (let i = 0; i < 2; i++) {
    clients[i]!.send(command(s, room, `zero${i}`, "SUBMIT_BET", { betCents: "0", guess: 0, leverage: 1 }));
    expect((await clients[i]!.next("command_result")).outcome.ok).toBe(true);
  }
  clients[0]!.send(command(s, room, "end-next", "END_ACTION", {}));
  expect((await clients[0]!.next("command_result")).outcome.ok).toBe(true);
  const loanId = s.manager.getGame(room)!.privateLoans[0]!.loanId;
  clients[1]!.send(command(s, room, "over-limit", "COLLECT_PRIVATE", { loanId, cents: "551" }));
  const result = await clients[1]!.next("command_result");
  expect(result.outcome).toMatchObject({ ok: false, details: { limitCents: "550" } });
  expect(s.manager.getGame(room)!.privateLoans[0]!.remainingCents).toBe(550);
});

it("tax_event_money_strings: 第三轮真实收税事件的centsAfter为字符串分", async () => {
  const { s, room, clients } = await game();
  for (let round = 1; round <= 3; round++) {
    for (let i = 0; i < 2; i++) {
      clients[i]!.send(command(s, room, `r${round}-end${i}`, "END_ACTION", {}));
      expect((await clients[i]!.next("command_result")).outcome.ok).toBe(true);
    }
    for (let i = 0; i < 2; i++) {
      clients[i]!.send(command(s, room, `r${round}-bet${i}`, "SUBMIT_BET", { betCents: "0", guess: 0, leverage: 1 }));
      expect((await clients[i]!.next("command_result")).outcome.ok).toBe(true);
    }
  }
  const message = await clients[0]!.next("events", m => m.events.some((e: Message) => e.type === "TAX_CHARGED"));
  expect(message.events.filter((e: Message) => e.type === "TAX_CHARGED").map((e: Message) => e.payload.centsAfter)).toEqual(["8000", undefined]);
  expect(s.manager.getGame(room)!.players.map(p => p.cents)).toEqual([8000, 8000]);
});

it("bank_events_private: 普通银行借款与还款只向借款人发金额事件", async () => {
  const { s, room, clients } = await game();
  clients[0]!.send(command(s, room, "bank-private", "BORROW_BANK", { amountCents: "4321" }));
  expect((await clients[0]!.next("command_result")).outcome.ok).toBe(true);
  const issued = await clients[0]!.next("events", m => m.events.some((e: Message) => e.type === "BANK_LOAN_ISSUED"));
  expect(issued.events.find((e: Message) => e.type === "BANK_LOAN_ISSUED").payload.amountCents).toBe("4321");
  const loanId = s.manager.getGame(room)!.bankLoans[0]!.loanId;
  clients[1]!.send(command(s, room, "end-bank", "END_ACTION", {})); await clients[1]!.next("command_result");
  for (let i = 0; i < 2; i++) {
    clients[i]!.send(command(s, room, `bank-bet${i}`, "SUBMIT_BET", { betCents: "0", guess: 0, leverage: 1 }));
    expect((await clients[i]!.next("command_result")).outcome.ok).toBe(true);
  }
  clients[0]!.send(command(s, room, "bank-repay", "REPAY_BANK", { loanId, cents: "1234" }));
  expect((await clients[0]!.next("command_result")).outcome.ok).toBe(true);
  await clients[0]!.next("events", m => m.events.some((e: Message) => e.type === "BANK_LOAN_REPAID"));
  clients[1]!.send(command(s, room, "bank-barrier", "END_ACTION", {})); await clients[1]!.next("command_result");
  const observer = JSON.stringify(clients[1]!.messages);
  expect(observer).not.toContain('"amountCents":"4321"');
  expect(observer).not.toContain('"paidCents":"1234"');
  expect(observer).not.toContain('"type":"BANK_LOAN_ISSUED"');
  expect(observer).not.toContain('"type":"BANK_LOAN_REPAID"');
});

it("settlement_amounts_private: 开奖结果公开但只下发本人完整结算条目", async () => {
  const { s, room, clients } = await game();
  for (let i = 0; i < 2; i++) {
    clients[i]!.send(command(s, room, `settle-end${i}`, "END_ACTION", {})); await clients[i]!.next("command_result");
  }
  for (let i = 0; i < 2; i++) {
    clients[i]!.send(command(s, room, `settle-bet${i}`, "SUBMIT_BET", { betCents: "100", guess: 0, leverage: 1 }));
    expect((await clients[i]!.next("command_result")).outcome.ok).toBe(true);
  }
  const message = await clients[0]!.next("events", m => m.events.some((e: Message) => e.type === "BET_SETTLED"));
  const event = message.events.find((e: Message) => e.type === "BET_SETTLED");
  const players = event.payload.players;
  expect(players).toHaveLength(1);
  expect(players[0].playerId).toBe("p1");
  expect(players[0].betCents).toBe("100");
  expect(players[0].guess).toBe(0);
  expect(players[0].leverage).toBe(1);
  expect(typeof players[0].won).toBe("boolean");
  expect(typeof players[0].deltaCents).toBe("string");
  expect(typeof players[0].nextCents).toBe("string");
  expect(typeof event.payload.round).toBe("number");
  expect([0, 1]).toContain(event.payload.drawResult);
});

it("bet_amounts_private: 不同下注金额与猜测只向本人下发本人条目", async () => {
  const { s, room, clients } = await game();
  for (let i = 0; i < 2; i++) {
    clients[i]!.send(command(s, room, `amount-end${i}`, "END_ACTION", {})); await clients[i]!.next("command_result");
  }
  const bets = [
    { betCents: "111", guess: 0, leverage: 1 },
    { betCents: "222", guess: 1, leverage: 1 },
  ];
  for (let i = 0; i < 2; i++) {
    clients[i]!.send(command(s, room, `amount-bet${i}`, "SUBMIT_BET", bets[i]));
    expect((await clients[i]!.next("command_result")).outcome.ok).toBe(true);
  }
  const p1Message = await clients[0]!.next("events", m => m.events.some((e: Message) => e.type === "BET_SETTLED"));
  const p1Event = p1Message.events.find((e: Message) => e.type === "BET_SETTLED");
  expect(p1Event.payload.players).toHaveLength(1);
  expect(p1Event.payload.players[0].playerId).toBe("p1");
  expect(JSON.stringify(p1Event)).not.toContain("222");
  expect(JSON.stringify(p1Event)).not.toContain("p2");
  const p2Message = await clients[1]!.next("events", m => m.events.some((e: Message) => e.type === "BET_SETTLED"));
  const p2Event = p2Message.events.find((e: Message) => e.type === "BET_SETTLED");
  expect(p2Event.payload.players).toHaveLength(1);
  expect(p2Event.payload.players[0].playerId).toBe("p2");
  expect(JSON.stringify(p2Event)).not.toContain("111");
  expect(JSON.stringify(p2Event)).not.toContain("p1");
});

it("draw_result_public_third_player: 第三人只收到本人条目但开奖结果全员一致", async () => {
  const { s, room, clients } = await game(3);
  for (let i = 0; i < 3; i++) {
    clients[i]!.send(command(s, room, `third-end${i}`, "END_ACTION", {})); await clients[i]!.next("command_result");
  }
  const bets = [
    { betCents: "111", guess: 0, leverage: 1 },
    { betCents: "222", guess: 1, leverage: 1 },
    { betCents: "0", guess: 0, leverage: 1 },
  ];
  for (let i = 0; i < 3; i++) {
    clients[i]!.send(command(s, room, `third-bet${i}`, "SUBMIT_BET", bets[i]));
    expect((await clients[i]!.next("command_result")).outcome.ok).toBe(true);
  }
  const [aMessage, cMessage] = await Promise.all([
    clients[0]!.next("events", m => m.events.some((e: Message) => e.type === "BET_SETTLED")),
    clients[2]!.next("events", m => m.events.some((e: Message) => e.type === "BET_SETTLED")),
  ]);
  const aEvent = aMessage.events.find((e: Message) => e.type === "BET_SETTLED");
  const cEvent = cMessage.events.find((e: Message) => e.type === "BET_SETTLED");
  expect([0, 1]).toContain(cEvent.payload.drawResult);
  expect(cEvent.payload.drawResult).toBe(aEvent.payload.drawResult);
  expect(cEvent.payload.players).toHaveLength(1);
  expect(cEvent.payload.players[0].playerId).toBe("p3");
  expect(cEvent.payload.players[0].betCents).toBe("0");
  const text = JSON.stringify(cEvent);
  expect(text).not.toContain("111");
  expect(text).not.toContain("222");
  expect(text).not.toContain("p1");
  expect(text).not.toContain("p2");
});

it("bank_due_identity_private: 三人WS仅借款人知道到期贷款并可决策及还款", async () => {
  const { createInitialState } = await import("@richman/game-core");
  const dueLoanId = "bank-due-private", activeLoanId = "bank-active-private";
  const manager = new RoomManager({ createGameState(gameId, config, seeds) {
    const state = createInitialState(gameId, config, seeds);
    state.bankLoans = [
      { loanId: dueLoanId, borrowerId: "p1", seatId: 1, principalCents: 1000, remainingCents: 1000,
        rateBps: 1000, issuedRound: 1, dueRound: 1, lastInterestRound: 1, status: "ACTIVE", origin: "NORMAL" },
      // 到期决策发出SETTLED；另一笔未到期贷款用于真实触发REPAY_BANK的REPAID事件。
      { loanId: activeLoanId, borrowerId: "p1", seatId: 1, principalCents: 500, remainingCents: 500,
        rateBps: 1000, issuedRound: 1, dueRound: 4, lastInterestRound: 1, status: "ACTIVE", origin: "OVERDRAFT" },
    ];
    return state;
  } });
  const s = await startServer({ host: "127.0.0.1", port: 0, manager });
  cleanups.push(() => s.close());
  const room = manager.createRoom();
  const clients: Client[] = [];
  for (let i = 0; i < 3; i++) {
    const [client] = await join(s.port, room, `到期玩家${i + 1}`);
    clients.push(client);
    client.send({ type: "ready", ready: true });
    await client.next("room", m => m.players.find((p: Message) => p.playerId === `p${i + 1}`)?.ready);
  }
  const observed: Message[][] = [[], []];
  for (let i = 1; i < 3; i++) {
    clients[i]!.ws.on("message", raw => observed[i - 1]!.push(JSON.parse(String(raw)) as Message));
  }
  const borrower = clients[0]!;
  borrower.send({ type: "start" });
  const pending = await borrower.next("events", m => m.events.some((e: Message) => e.type === "BANK_DUE_PENDING"));
  expect(pending.events.find((e: Message) => e.type === "BANK_DUE_PENDING")).toMatchObject({
    payload: { borrowerId: "p1", loanId: dueLoanId },
  });
  expect((await borrower.next("snapshot")).view.pendingDueLoanId).toBe(dueLoanId);
  for (let i = 1; i < 3; i++) {
    const peerSnapshot = await clients[i]!.next("snapshot");
    expect(peerSnapshot.view.pendingDueLoanId).toBeNull();
    expect(peerSnapshot.view.finance.bankLoans).toEqual([]);
    // The server's response is a network barrier after all start-time snapshots/events.
    clients[i]!.send({ type: "ready", ready: true });
    expect((await clients[i]!.next("error")).code).toBe("ALREADY_STARTED");
    expect(observed[i - 1]!.some(m => m.type === "events")).toBe(true);
    const wire = JSON.stringify(observed[i - 1]);
    for (const secret of ["BANK_DUE_PENDING", '"borrowerId"', '"loanId"', dueLoanId, activeLoanId]) {
      expect(wire).not.toContain(secret);
    }
  }

  borrower.send(command(s, room, "due-private-decision", "BANK_DUE_DECISION", { loanId: dueLoanId, decision: "REPAY" }));
  expect((await borrower.next("command_result")).outcome.ok).toBe(true);
  const settled = await borrower.next("events", m => m.events.some((e: Message) => e.type === "BANK_LOAN_SETTLED"));
  expect(settled.events.find((e: Message) => e.type === "BANK_LOAN_SETTLED").payload).toEqual({ loanId: dueLoanId, paidCents: "1000" });
  expect(manager.getGame(room)!.bankLoans[0]!.status).toBe("REPAID");
  expect(manager.getGame(room)!.phase).toBe("ACTION");
  borrower.send(command(s, room, "due-private-repay", "REPAY_BANK", { loanId: activeLoanId, cents: "250" }));
  expect((await borrower.next("command_result")).outcome.ok).toBe(true);
  const repaid = await borrower.next("events", m => m.events.some((e: Message) => e.type === "BANK_LOAN_REPAID"));
  expect(repaid.events.find((e: Message) => e.type === "BANK_LOAN_REPAID").payload).toEqual({ loanId: activeLoanId, paidCents: "250" });
  expect(manager.getGame(room)!.players[0]!.cents).toBe(8750);
  expect(manager.getGame(room)!.bankLoans[1]!.remainingCents).toBe(250);
  for (let i = 1; i < 3; i++) {
    clients[i]!.send({ type: "ready", ready: true }); await clients[i]!.next("error");
    const peerMessages = observed[i - 1]!;
    expect(peerMessages.filter(m => m.type === "snapshot").every(m => m.view.pendingDueLoanId === null)).toBe(true);
    const wire = JSON.stringify(peerMessages);
    for (const secret of ["BANK_DUE_PENDING", "BANK_LOAN_SETTLED", "BANK_LOAN_REPAID", '"borrowerId"', '"loanId"', dueLoanId, activeLoanId]) {
      expect(wire).not.toContain(secret);
    }
  }
});

it("session_token_url_requires_resume: URL里的sessionToken不授予身份，消息体resume才joined", async () => {
  const s = await server(), room = s.manager.createRoom();
  const [original, identity] = await join(s.port, room, "原玩家");
  const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws?room=${room}&sessionToken=${encodeURIComponent(identity.sessionToken)}`);
  const candidate = new Client(ws);
  await once(ws, "open");
  candidate.send({ type: "ready", ready: true });
  expect((await candidate.next("error")).code).toBe("NOT_JOINED");
  expect(candidate.messages.some(m => m.type === "joined")).toBe(false);
  expect(s.manager.getRoom(room)?.players).toHaveLength(1);
  expect(s.manager.getRoom(room)?.players[0]?.ready).toBe(false);
  candidate.send({ type: "resume", roomCode: room, sessionToken: identity.sessionToken });
  expect(await candidate.next("joined")).toMatchObject({ playerId: identity.playerId, seatId: identity.seatId });
  expect((await original.next("error")).code).toBe("REPLACED");
  expect(s.manager.getRoom(room)?.players).toHaveLength(1);
});

it("replaced_half_open_heartbeat: 新连接接管后旧半开连接的心跳超时不影响新连接", async () => {
  const manager = new RoomManager(), room = manager.createRoom(), raw = http.createServer();
  let tick: (() => void) | undefined;
  const runtime = attachLobbyWebSocket(raw, manager, { heartbeatClock: {
    setInterval(callback: () => void, ms: number) { expect(ms).toBe(10000); tick = callback; return 1; },
    clearInterval() {},
  } });
  await new Promise<void>(resolve => raw.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { await runtime.close(); await new Promise<void>(resolve => raw.close(() => resolve())); });
  const port = (raw.address() as { port: number }).port;
  const old = await open(port, room, { autoPong: false });
  old.send({ type: "join", nickname: "原玩家" }); const identity = await old.next("joined");
  const [peer] = await join(port, room, "另一玩家");
  old.send({ type: "ready", ready: true }); peer.send({ type: "ready", ready: true });
  await old.next("room", m => m.players.every((p: Message) => p.ready));
  old.send({ type: "start" }); await old.next("snapshot");
  const before = structuredClone(manager.getGame(room));
  // Two unanswered pings prime the old connection; the post-bind tick reaches its timeout branch.
  for (let i = 0; i < 2; i++) {
    const ping = once(old.ws, "ping"), peerPing = once(peer.ws, "ping");
    tick!(); await Promise.all([ping, peerPing]);
    peer.send({ type: "ready", ready: true }); await peer.next("error");
  }
  // Pause the real TCP reader so the replaced connection cannot finish its close handshake.
  old.ws.pause();
  try {
    const replacement = await open(port, room);
    replacement.send({ type: "resume", roomCode: room, sessionToken: identity.sessionToken });
    const joined = await replacement.next("joined"); await replacement.next("snapshot");
    expect(joined.connectionEpoch).toBeGreaterThan(identity.connectionEpoch);
    expect(old.ws.readyState).toBe(WebSocket.OPEN);
    expect(runtime.connections()).toBe(3);
    const healthyPing = once(replacement.ws, "ping");
    tick!(); await healthyPing;
    // Keep the old reader paused until heartbeat (rather than a close handshake) removes it.
    await expect.poll(() => runtime.connections()).toBe(2);
    replacement.send({ type: "ready", ready: true });
    expect((await replacement.next("error")).code).toBe("ALREADY_STARTED");
    const closed = once(old.ws, "close"); old.ws.resume(); await closed;
    replacement.send({ type: "ready", ready: true }); await replacement.next("error");
    expect(runtime.connections()).toBe(2);
    expect(manager.getRoom(room)?.players[0]).toMatchObject({ playerId: "p1", online: true, ready: true });
    expect(manager.getGame(room)).toEqual(before);
  } finally { old.ws.resume(); }
});
