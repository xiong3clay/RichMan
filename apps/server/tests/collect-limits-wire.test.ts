import { once } from "node:events";
import { afterEach as afterEachHook, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startServer } from "../src/http.js";
import type { StartedServer } from "../src/http.js";

type Message = Record<string, any>;

class Client {
  messages: Message[] = [];
  waiters: Array<{ predicate: (m: Message) => boolean; resolve: (m: Message) => void }> = [];
  constructor(readonly ws: WebSocket) {
    ws.on("message", raw => {
      const m = JSON.parse(String(raw)) as Message;
      const index = this.waiters.findIndex(w => w.predicate(m));
      if (index >= 0) this.waiters.splice(index, 1)[0]!.resolve(m);
      else this.messages.push(m);
    });
    ws.on("error", () => undefined);
  }
  send(m: unknown): void { this.ws.send(JSON.stringify(m)); }
  next(type: string, check: (m: Message) => boolean = () => true): Promise<Message> {
    const predicate = (m: Message): boolean => m.type === type && check(m);
    const index = this.messages.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0]!);
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
afterEachHook(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

async function server(): Promise<StartedServer> {
  const started = await startServer({ host: "127.0.0.1", port: 0 });
  cleanups.push(() => started.close());
  return started;
}

async function open(port: number, room: string): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${room}`);
  const c = new Client(ws);
  await once(ws, "open");
  return c;
}

async function join(port: number, room: string, nickname: string): Promise<[Client, Message]> {
  const c = await open(port, room);
  c.send({ type: "join", nickname });
  return [c, await c.next("joined")];
}

async function game(): Promise<{ s: StartedServer; room: string; clients: Client[] }> {
  const s = await server();
  const room = s.manager.createRoom();
  const clients: Client[] = [];
  for (let i = 0; i < 2; i++) {
    const [c, identity] = await join(s.port, room, `玩家${i}`);
    clients.push(c);
    c.send({ type: "ready", ready: true });
    await c.next("room", m => m.players.find((p: Message) => p.playerId === identity.playerId)?.ready);
  }
  clients[0]!.send({ type: "start" });
  await clients[0]!.next("started");
  await clients[0]!.next("snapshot");
  return { s, room, clients };
}

function command(s: StartedServer, room: string, id: string, type: string, payload: unknown): Message {
  const state = s.manager.getGame(room)!;
  return { protocolVersion: 1, gameId: state.gameId, commandId: id, type, payload,
    expectedGameVersion: state.version, roundId: state.round, phaseInstanceId: state.phaseInstanceId };
}

describe("07C T6 快照 wire 下发 collectLimits", () => {
  it("ACCEPT 后出借人快照含 {loanId,maxCents:string}，借款人没有", async () => {
    const { s, room, clients } = await game();
    const a = clients[0]!, b = clients[1]!;
    a.send(command(s, room, "req", "REQUEST_PRIVATE_LOAN",
      { lenderId: "p2", principalCents: "500", rateBps: 1000, requestId: "req-t6" }));
    expect((await a.next("command_result")).outcome.ok).toBe(true);
    b.send(command(s, room, "accept", "ACCEPT_PRIVATE_LOAN", { requestId: "req-t6" }));
    expect((await b.next("command_result")).outcome.ok).toBe(true);

    const lenderSnapshot = await b.next("snapshot",
      m => (m.view.finance.privateLoans ?? []).length > 0);
    expect(lenderSnapshot.view.finance.collectLimits).toEqual([
      { loanId: expect.any(String), maxCents: "500" },
    ]);
    expect(typeof lenderSnapshot.view.finance.collectLimits[0]!.maxCents).toBe("string");
    // 只含本人为出借人的 ACTIVE 合同：借款人一侧为空。
    const borrowerSnapshot = await a.next("snapshot",
      m => (m.view.finance.privateLoans ?? []).length > 0);
    expect(borrowerSnapshot.view.finance.collectLimits).toEqual([]);
  });
});
