import WebSocket from "ws";
import { startServer } from "../src/http.js";
import type { StartedServer } from "../src/http.js";
import type { LobbyWsOptions } from "../src/ws.js";
import { DEFAULT_SECURITY_LIMITS } from "../src/security.js";
import type { SecurityLimits } from "../src/security.js";

export type Message = Record<string, any>;

export function makeLimits(partial: Partial<SecurityLimits> = {}): SecurityLimits {
  return { ...DEFAULT_SECURITY_LIMITS, ...partial };
}

export async function startSecurityServer(
  limits: Partial<SecurityLimits> = {},
  wsOptions: LobbyWsOptions = {},
): Promise<StartedServer> {
  return startServer({
    host: "127.0.0.1",
    port: 0,
    security: { limits: makeLimits(limits) },
    wsOptions,
  });
}

export async function createRoom(
  port: number,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, any> }> {
  const response = await fetch(`http://127.0.0.1:${port}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: "{}",
  });
  return { status: response.status, body: await response.json() as Record<string, any> };
}

export class Peer {
  messages: Message[] = [];
  waiters: Array<{ predicate: (message: Message) => boolean; resolve: (message: Message) => void }> = [];
  private constructor(readonly ws: WebSocket) {
    ws.on("message", raw => {
      const message = JSON.parse(String(raw)) as Message;
      const index = this.waiters.findIndex(waiter => waiter.predicate(message));
      if (index >= 0) this.waiters.splice(index, 1)[0]!.resolve(message);
      else this.messages.push(message);
    });
    ws.on("error", () => undefined);
  }

  static async open(
    port: number,
    room: string,
    headers: Record<string, string> = {},
    options: WebSocket.ClientOptions = {},
  ): Promise<Peer> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${room}`, { headers, ...options });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    return new Peer(ws);
  }

  send(message: unknown): void { this.ws.send(JSON.stringify(message)); }

  next(type: string, check: (message: Message) => boolean = () => true, timeout = 5000): Promise<Message> {
    const predicate = (message: Message): boolean => message.type === type && check(message);
    const index = this.messages.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0]!);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve: (message: Message): void => { clearTimeout(timer); resolve(message); } };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(item => item !== waiter);
        reject(new Error("消息超时: " + type));
      }, timeout);
      this.waiters.push(waiter);
    });
  }

  close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise(resolve => {
      this.ws.once("close", () => resolve());
      this.ws.close();
    });
  }
}

export async function joinAndReady(
  port: number,
  room: string,
  nickname: string,
): Promise<{ peer: Peer; joined: Message; view: Message }> {
  const peer = await Peer.open(port, room);
  peer.send({ type: "join", nickname });
  const joined = await peer.next("joined");
  await peer.next("room");
  return { peer, joined, view: joined };
}

export async function startGame(port: number, room: string): Promise<{ host: Peer; guest: Peer; view: Message }> {
  const host = await Peer.open(port, room);
  host.send({ type: "join", nickname: "甲" });
  const hostJoined = await host.next("joined");
  await host.next("room");
  const guest = await Peer.open(port, room);
  guest.send({ type: "join", nickname: "乙" });
  await guest.next("joined");
  await guest.next("room");
  host.send({ type: "ready", ready: true });
  guest.send({ type: "ready", ready: true });
  await host.next("room", message => message.players.every((player: Message) => player.ready));
  host.send({ type: "start" });
  await host.next("started");
  const view = await host.next("snapshot");
  await guest.next("snapshot");
  return { host, guest, view };
}
