import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { ClientLobbyMessageSchema, ServerLobbyMessageSchema } from "@richman/shared";
import type { EngineState } from "@richman/game-core";
import { RoomManager } from "../src/rooms/manager.js";
import { attachLobbyWebSocket } from "../src/ws.js";

type Message = { type: string } & Record<string, unknown>;

class Client {
  readonly history: Message[] = [];
  private readonly inbox: Message[] = [];
  private readonly waiters: Array<{
    check: (message: Message) => boolean;
    resolve: (message: Message) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(readonly ws: WebSocket) {
    ws.on("message", data => {
      const message = JSON.parse(String(data)) as Message;
      this.history.push(message);
      const index = this.waiters.findIndex(waiter => waiter.check(message));
      if (index < 0) this.inbox.push(message);
      else {
        const waiter = this.waiters.splice(index, 1)[0]!;
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    });
  }

  send(message: unknown): void { this.ws.send(JSON.stringify(message)); }

  next(type: string, check: (message: Message) => boolean = () => true): Promise<Message> {
    return this.match(message => message.type === type && check(message));
  }

  match(check: (message: Message) => boolean): Promise<Message> {
    const index = this.inbox.findIndex(check);
    if (index >= 0) return Promise.resolve(this.inbox.splice(index, 1)[0]!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("等待 WebSocket 消息超时")), 1500);
      this.waiters.push({ check, resolve, timer });
    });
  }

  close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise(resolve => { this.ws.once("close", () => resolve()); this.ws.close(); });
  }
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

async function harness(ids?: string[]) {
  let time = 0, sequence = 0;
  const manager = new RoomManager({ generateRoomCode: () => "0042",
    generateGameId: () => ids?.[sequence++] ?? `game-${++sequence}` });
  const server = http.createServer();
  const runtime = attachLobbyWebSocket(server, manager, { now: () => time });
  await new Promise<void>(resolve => server.listen(0, "0.0.0.0", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("服务器端口不可用");
  const clients: Client[] = [];
  cleanup.push(async () => {
    await runtime.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const roomCode = manager.createRoom();
  const open = async (): Promise<Client> => {
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws?room=${roomCode}`);
    const client = new Client(ws);
    clients.push(client);
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    return client;
  };
  const join = async (nickname: string): Promise<Client> => {
    const client = await open();
    client.send({ type: "join", nickname });
    await client.next("joined");
    return client;
  };
  const game = (): EngineState => manager.getGame(roomCode)!;
  const finish = (): void => {
    Object.assign(game(), { phase: "GAME_OVER", winnerId: "p1", deadlineAt: null, windowDeadlineMs: null });
  };
  return { manager, roomCode, clients, open, join, game, finish, time: (value: number) => { time = value; } };
}

async function start(h: Awaited<ReturnType<typeof harness>>, hole = false) {
  const host = await h.join("房主甲");
  const leaving = hole ? await h.join("临时玩家") : null;
  const guest = await h.join("客人乙");
  if (leaving) {
    leaving.send({ type: "leave" });
    await host.next("room", message => (message.players as unknown[]).length === 2);
    await leaving.close();
  }
  host.send({ type: "ready", ready: true });
  guest.send({ type: "ready", ready: true });
  await host.next("room", message => (message.players as Array<{ ready: boolean }>).every(player => player.ready));
  host.send({ type: "start" });
  const started = await host.next("started");
  await guest.next("started");
  await host.next("snapshot");
  await guest.next("snapshot");
  return { host, guest, originalId: started.gameId as string };
}

async function rematch(host: Client): Promise<string> {
  host.send({ type: "rematch" });
  const reply = await host.match(message => message.type === "started" || message.type === "error");
  expect(reply.type).toBe("started");
  expect(reply.roomCode).toBe("0042");
  expect(ServerLobbyMessageSchema.safeParse(reply).success).toBe(true);
  await host.next("snapshot", message => (message.view as { gameId: string }).gameId === reply.gameId);
  return reply.gameId as string;
}

describe("rematch over real WebSockets", () => {
  it("房主 GAME_OVER 再开：新 gameId、初始账本、原昵称和空洞座位，离线席保留且不重放旧事件", async () => {
    const h = await harness();
    const { host, guest, originalId } = await start(h, true);
    await guest.close();
    await host.next("room", message => (message.players as Array<{ online: boolean }>).some(player => !player.online));
    h.game().players[0]!.cents = 123;
    h.game().bets = { p1: { betCents: 100, guess: 1, leverage: 1 } };
    h.game().eventSeq = 900;
    h.finish();
    const historyStart = host.history.length;
    const newId = await rematch(host);

    expect(newId).not.toBe(originalId);
    expect(h.game()).toMatchObject({ gameId: newId, phase: "ACTION", version: 1, round: 1,
      currentSeatId: 1, bankLoans: [], privateLoans: [], requests: [], bets: {}, winnerId: null });
    expect(h.game().players.map(player => [player.playerId, player.seatId, player.nickname, player.cents]))
      .toEqual([["p1", 1, "房主甲", 10000], ["p3", 3, "客人乙", 10000]]);
    expect(h.manager.getRoom(h.roomCode)).toMatchObject({ state: "PLAYING", hostId: "p1",
      players: [{ playerId: "p1", online: true }, { playerId: "p3", online: false }] });
    const broadcasts = host.history.slice(historyStart);
    expect(broadcasts.some(message => message.type === "room" && message.state === "PLAYING")).toBe(true);
    expect(broadcasts.filter(message => message.type === "events").every(message => message.gameId === newId)).toBe(true);
    expect(h.game().eventSeq).toBeLessThan(900);

    const outsider = await h.open();
    outsider.send({ type: "rematch" });
    expect(await outsider.next("error")).toMatchObject({ code: "NOT_JOINED" });
    expect(ClientLobbyMessageSchema.safeParse({ type: "rematch" }).success).toBe(true);
    expect(ClientLobbyMessageSchema.safeParse({ type: "rematch", playerId: "p1" }).success).toBe(false);
  });

  it("非房主再开返回 NOT_HOST，旧局及所有房间状态不变", async () => {
    const h = await harness();
    const { guest } = await start(h);
    h.finish();
    const before = structuredClone(h.game()), roomBefore = h.manager.getRoom(h.roomCode);
    guest.send({ type: "rematch" });
    expect(await guest.next("error")).toMatchObject({ code: "NOT_HOST" });
    expect(h.game()).toEqual(before);
    expect(h.manager.getRoom(h.roomCode)).toEqual(roomBefore);
  });

  it("大厅和非 GAME_OVER 时房主再开返回 INVALID_STATE，不改状态或截止时间", async () => {
    const h = await harness();
    const lobbyHost = await h.join("大厅房主");
    const lobbyBefore = h.manager.getRoom(h.roomCode);
    lobbyHost.send({ type: "rematch" });
    expect(await lobbyHost.next("error")).toMatchObject({ code: "INVALID_STATE" });
    expect(h.manager.getRoom(h.roomCode)).toEqual(lobbyBefore);
    expect(h.game()).toBeNull();
    lobbyHost.send({ type: "leave" });
    await lobbyHost.close();

    const playing = await harness();
    const { host } = await start(playing);
    const before = structuredClone(playing.game());
    host.send({ type: "rematch" });
    expect(await host.next("error")).toMatchObject({ code: "INVALID_STATE" });
    expect(playing.game()).toEqual(before);
  });

  it("两次结束后连续再开各有新 gameId，拒绝生成器重复使用历史 gameId 且不改旧局", async () => {
    const h = await harness(["old-game", "rematch-one", "rematch-two", "rematch-one"]);
    const { host, guest, originalId } = await start(h);
    h.finish();
    const firstId = await rematch(host);
    expect(await guest.next("started")).toMatchObject({ gameId: firstId, roomCode: h.roomCode });
    await guest.next("snapshot", message => (message.view as { gameId: string }).gameId === firstId);
    h.finish();
    const secondId = await rematch(host);
    expect(new Set([originalId, firstId, secondId]).size).toBe(3);
    expect(await guest.next("started")).toMatchObject({ gameId: secondId });
    h.finish();
    const before = structuredClone(h.game());
    host.send({ type: "rematch" });
    expect(await host.next("error")).toMatchObject({ code: "INVALID_STATE" });
    expect(h.game()).toEqual(before);
  });

  it("旧 commandId 在新局重新执行；旧 gameId 重发拒绝，不能返回旧成功结果或改新账本", async () => {
    const h = await harness();
    const { host, originalId } = await start(h);
    const command = { protocolVersion: 1, gameId: originalId, commandId: "same-command",
      type: "BORROW_BANK", payload: { amountCents: "500" }, expectedGameVersion: h.game().version };
    host.send(command);
    expect(await host.next("command_result")).toMatchObject({ gameId: originalId, outcome: { ok: true } });
    expect(h.game().players[0]?.cents).toBe(10500);
    h.finish();
    const newId = await rematch(host);
    host.send({ ...command, gameId: newId, expectedGameVersion: h.game().version, payload: { amountCents: "700" } });
    expect(await host.next("command_result")).toMatchObject({ gameId: newId, outcome: { ok: true } });
    expect(h.game().players[0]?.cents).toBe(10700);
    expect(h.game().bankLoans).toHaveLength(1);
    expect(h.game().bankLoans[0]?.principalCents).toBe(700);
    const before = structuredClone(h.game());
    host.send(command);
    expect(await host.next("command_result")).toMatchObject({ gameId: originalId, outcome: { ok: false, code: "UNAUTHORIZED" } });
    expect(h.game()).toEqual(before);
  });

  it("再开按新 deadline 调度，已排队旧 timer 回调即使到期也不能触发新局", async () => {
    const timerSpy = vi.spyOn(globalThis, "setTimeout");
    const h = await harness();
    const { host } = await start(h);
    const oldCallback = timerSpy.mock.calls.find(call => call[1] === 60000)?.[0] as (() => void) | undefined;
    expect(oldCallback).toBeTypeOf("function");
    expect(h.game().deadlineAt).toBe("1970-01-01T00:01:00.000Z");
    h.time(7000);
    h.finish();
    await rematch(host);
    expect(h.game().deadlineAt).toBe("1970-01-01T00:01:07.000Z");
    const callbacks = timerSpy.mock.calls.filter(call => call[1] === 60000).map(call => call[0] as () => void);
    const newCallback = callbacks.at(-1)!;
    expect(newCallback).not.toBe(oldCallback);

    h.time(60000);
    oldCallback!();
    host.send({ type: "rematch" }); // Queue barrier after the stale callback.
    expect(await host.next("error")).toMatchObject({ code: "INVALID_STATE" });
    expect(h.game()).toMatchObject({ phase: "ACTION", currentSeatId: 1, version: 1 });
    h.time(67000);
    oldCallback!();
    host.send({ type: "rematch" });
    expect(await host.next("error")).toMatchObject({ code: "INVALID_STATE" });
    expect(h.game().version).toBe(1);
    newCallback();
    await host.next("snapshot", message => (message.view as { version: number }).version === 2);
    expect(h.game()).toMatchObject({ phase: "ACTION", currentSeatId: 2, version: 2,
      deadlineAt: "1970-01-01T00:02:07.000Z" });
  });
});
