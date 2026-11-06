import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RichmanClient } from "../src/net/client";
import type { ClientHandlers } from "../src/net/client";

class TestSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: TestSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: Record<string, unknown>[] = [];
  closed = false;
  constructor(readonly url: string) { TestSocket.instances.push(this); }
  send(text: string): void { this.sent.push(JSON.parse(text) as Record<string, unknown>); }
  open(): void { this.readyState = TestSocket.OPEN; this.onopen?.(); }
  close(): void { this.closed = true; this.readyState = TestSocket.CLOSED; this.onclose?.(); }
  receive(message: unknown): void { this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent); }
}

const clients: RichmanClient[] = [];
const storage = new Map<string, string>();
beforeEach(() => {
  TestSocket.instances = [];
  storage.clear();
  vi.stubGlobal("WebSocket", TestSocket);
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  });
  vi.stubGlobal("window", {
    location: { protocol: "http:", host: "localhost:8000" },
    setTimeout: (...args: Parameters<typeof globalThis.setTimeout>) => globalThis.setTimeout(...args),
    clearTimeout: (timer: ReturnType<typeof globalThis.setTimeout>) => globalThis.clearTimeout(timer),
  });
});
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function handlers(): ClientHandlers & {
  destroyed: Array<{ roomCode: string; byPlayerId: string }>;
  statuses: string[];
} {
  const destroyed: Array<{ roomCode: string; byPlayerId: string }> = [];
  const statuses: string[] = [];
  return {
    destroyed,
    statuses,
    onStatus: (status) => { statuses.push(status); },
    onJoined: vi.fn(),
    onRoom: vi.fn(),
    onStarted: vi.fn(),
    onSnapshot: vi.fn(),
    onCommandResult: vi.fn(),
    onServerError: vi.fn(),
    onRoomDestroyed: (info) => { destroyed.push(info); },
  };
}

function serverErrorCalls(h: ReturnType<typeof handlers>): number {
  return (h.onServerError as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
}

function joinedClient() {
  const h = handlers();
  const client = new RichmanClient("0042", "甲", h);
  clients.push(client);
  client.connect();
  const socket = TestSocket.instances.at(-1)!;
  socket.open();
  socket.receive({ type: "joined", roomCode: "0042", playerId: "p1", seatId: 1, sessionToken: "test-token-123456" });
  expect(client.hasJoined).toBe(true);
  return { client, h, socket };
}

describe("07C 客户端销毁房间", () => {
  it("joined 后可发送 destroy_room；未 joined 时返回 false", () => {
    const h = handlers();
    const client = new RichmanClient("0042", "甲", h);
    clients.push(client);
    client.connect();
    const socket = TestSocket.instances.at(-1)!;
    expect(client.destroyRoom()).toBe(false);
    socket.open();
    socket.receive({ type: "joined", roomCode: "0042", playerId: "p1", seatId: 1, sessionToken: "test-token-123456" });
    expect(client.destroyRoom()).toBe(true);
    expect(socket.sent.at(-1)).toEqual({ type: "destroy_room" });
  });

  it("收到 room_destroyed 后清 session、停止重连、通知上层", () => {
    const { client, h, socket } = joinedClient();
    expect(storage.size).toBeGreaterThan(0);
    socket.receive({ type: "room_destroyed", roomCode: "0042", byPlayerId: "p1" });
    expect(h.destroyed).toEqual([{ roomCode: "0042", byPlayerId: "p1" }]);
    expect(client.hasJoined).toBe(false);
    expect(client.destroyRoom()).toBe(false);
    expect(storage.size).toBe(0);
    expect(socket.closed).toBe(true);
    expect(h.statuses).not.toContain("closed");
    // T7：销毁通知不能走普通 error 分支，也不能触发重连。
    expect(serverErrorCalls(h)).toBe(0);
    expect(TestSocket.instances).toHaveLength(1);
  });

  it("S4 已加入后收到 ROOM_NOT_FOUND：按销毁路径回首页，不调 onServerError", () => {
    const { client, h, socket } = joinedClient();
    socket.receive({ type: "error", code: "ROOM_NOT_FOUND", message: "房间不存在" });
    expect(h.destroyed).toEqual([{ roomCode: "0042", byPlayerId: "" }]);
    expect(serverErrorCalls(h)).toBe(0);
    expect(client.hasJoined).toBe(false);
    expect(storage.size).toBe(0);
    expect(socket.closed).toBe(true);
    expect(TestSocket.instances).toHaveLength(1);
  });

  it("S4 未加入时 ROOM_NOT_FOUND 仍走原 error 路径", () => {
    const h = handlers();
    const client = new RichmanClient("0042", "甲", h);
    clients.push(client);
    client.connect();
    const socket = TestSocket.instances.at(-1)!;
    socket.open();
    socket.receive({ type: "error", code: "ROOM_NOT_FOUND", message: "房间不存在" });
    expect(h.destroyed).toEqual([]);
    expect(serverErrorCalls(h)).toBe(1);
    expect(client.hasJoined).toBe(false);
  });
});
