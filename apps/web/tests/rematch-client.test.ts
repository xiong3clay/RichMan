import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { RichmanClient } from "../src/net/client";
import type { ClientHandlers } from "../src/net/client";
import type { WireSnapshotView } from "../src/net/wire";
import { mountDom } from "./dom-harness";
import { viewFixture } from "./view-fixtures";

/** Only the transport is substituted: production client message dispatch and React remain real. */
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
  constructor(readonly url: string) { TestSocket.instances.push(this); }
  send(text: string): void { this.sent.push(JSON.parse(text) as Record<string, unknown>); }
  open(): void { this.readyState = TestSocket.OPEN; this.onopen?.(); }
  close(): void { this.readyState = TestSocket.CLOSED; this.onclose?.(); }
  receive(message: unknown): void { this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent); }
}

const clients: RichmanClient[] = [];
let mounted: Awaited<ReturnType<typeof mountDom>> | undefined;
beforeEach(() => {
  const values = new Map<string, string>();
  TestSocket.instances = [];
  vi.stubGlobal("WebSocket", TestSocket);
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  vi.stubGlobal("window", {
    location: { protocol: "http:", host: "localhost:8000" },
    setTimeout: (...args: Parameters<typeof globalThis.setTimeout>) => globalThis.setTimeout(...args),
    clearTimeout: (timer: ReturnType<typeof globalThis.setTimeout>) => globalThis.clearTimeout(timer),
  });
});
afterEach(async () => {
  await mounted?.cleanup(); mounted = undefined;
  for (const client of clients.splice(0)) client.dispose();
  vi.useRealTimers(); vi.unstubAllGlobals();
});

function joined(socket: TestSocket): void {
  socket.receive({ type: "joined", roomCode: "0042", playerId: "p1", seatId: 1, sessionToken: "test-token" });
}
function snapshot(gameId: string, version: number): WireSnapshotView {
  return { ...viewFixture(), gameId, version };
}
function started(socket: TestSocket, gameId: string): void { socket.receive({ type: "started", gameId }); }
function receiveSnapshot(socket: TestSocket, gameId: string, version: number): void {
  socket.receive({ type: "snapshot", view: snapshot(gameId, version) });
}
function setupClient() {
  const handlers: ClientHandlers = {
    onStatus: vi.fn(), onJoined: vi.fn(), onRoom: vi.fn(), onStarted: vi.fn(), onSnapshot: vi.fn(),
    onEvents: vi.fn(), onCommandResult: vi.fn(), onServerError: vi.fn(),
  };
  const client = new RichmanClient("0042", "甲", handlers);
  clients.push(client); client.connect();
  return { client, handlers, socket: TestSocket.instances.at(-1)! };
}

describe("05D 客户端再来一局与局号隔离", () => {
  it("连接且joined后只发送rematch；连接未就绪或关闭时不发送", () => {
    const { client, socket } = setupClient();
    expect(client.rematch()).toBe(false);
    socket.open();
    expect(client.rematch()).toBe(false);
    joined(socket);
    expect(client.rematch()).toBe(true);
    expect(socket.sent).toEqual([{ type: "join", nickname: "甲" }, { type: "rematch" }]);
    socket.close();
    expect(client.rematch()).toBe(false);
    expect(socket.sent).toHaveLength(2);
  });

  it("REPLACED即使socket仍open也不发送rematch", () => {
    const { client, socket } = setupClient(); socket.open(); joined(socket);
    socket.receive({ type: "error", code: "REPLACED", message: "这个座位已在另一个页面恢复" });
    expect(client.rematch()).toBe(false);
    expect(socket.sent).toEqual([{ type: "join", nickname: "甲" }]);
  });

  it("新started先清空旧snapshot，允许新局低version；重复started不倒退版本", () => {
    const { client, socket, handlers } = setupClient(); socket.open(); joined(socket);
    started(socket, "old-game"); receiveSnapshot(socket, "old-game", 100);
    started(socket, "new-game");
    expect(client.currentView).toBeNull();
    expect(client.endAction()).toBeNull();
    receiveSnapshot(socket, "new-game", 1);
    expect(client.currentView).toMatchObject({ gameId: "new-game", version: 1 });
    started(socket, "new-game"); receiveSnapshot(socket, "new-game", 0);
    expect(client.currentView).toMatchObject({ gameId: "new-game", version: 1 });
    expect(handlers.onStarted).toHaveBeenCalledTimes(2);
  });

  it("新started后旧snapshot、events、command_result不能污染新局，当前局消息仍正常", () => {
    const { client, socket, handlers } = setupClient(); socket.open(); joined(socket);
    started(socket, "old-game"); receiveSnapshot(socket, "old-game", 100);
    started(socket, "new-game");
    receiveSnapshot(socket, "old-game", 101);
    expect(client.currentView).toBeNull();
    const oldEvent = { seq: 99, type: "BANK_LOAN_DEFAULTED", at: "2026-11-04T00:00:00Z", payload: {} };
    socket.receive({ type: "events", gameId: "old-game", gameVersion: 101, events: [oldEvent] });
    socket.receive({ type: "command_result", gameId: "old-game", gameVersion: 101,
      commandId: "old-command", outcome: { ok: false, code: "INVALID_STATE", message: "旧局错误" } });
    receiveSnapshot(socket, "new-game", 1);
    receiveSnapshot(socket, "old-game", 102);
    expect(client.currentView).toMatchObject({ gameId: "new-game", version: 1 });
    expect(handlers.onEvents).not.toHaveBeenCalled();
    expect(handlers.onCommandResult).not.toHaveBeenCalled();
    const newEvent = { ...oldEvent, seq: 1 };
    socket.receive({ type: "events", gameId: "new-game", gameVersion: 1, events: [newEvent] });
    socket.receive({ type: "command_result", gameId: "new-game", gameVersion: 1,
      commandId: "new-command", outcome: { ok: true } });
    expect(handlers.onEvents).toHaveBeenCalledWith([newEvent]);
    expect(handlers.onCommandResult).toHaveBeenCalledWith(expect.objectContaining({ commandId: "new-command" }));
  });

  it("重新joined后的首snapshot可恢复断线期间的新局；旧socket迟到消息被忽略", async () => {
    vi.useFakeTimers();
    const { client, socket, handlers } = setupClient(); socket.open(); joined(socket);
    started(socket, "old-game"); receiveSnapshot(socket, "old-game", 100);
    socket.close(); await vi.advanceTimersByTimeAsync(1000);
    const recovered = TestSocket.instances.at(-1)!;
    expect(recovered).not.toBe(socket);
    recovered.open(); joined(recovered);
    receiveSnapshot(recovered, "offline-rematch", 1);
    expect(client.currentView).toMatchObject({ gameId: "offline-rematch", version: 1 });
    expect(handlers.onStarted).toHaveBeenLastCalledWith("offline-rematch");
    started(socket, "old-game"); receiveSnapshot(socket, "old-game", 101);
    expect(client.currentView).toMatchObject({ gameId: "offline-rematch", version: 1 });
    expect(client.hasJoined).toBe(true);
  });

  it("重新joined后同局首snapshot保留版本高水位与局内UI", async () => {
    vi.useFakeTimers();
    const { client, socket, handlers } = setupClient(); socket.open(); joined(socket);
    started(socket, "same-game"); receiveSnapshot(socket, "same-game", 100);
    socket.close(); await vi.advanceTimersByTimeAsync(1000);
    const recovered = TestSocket.instances.at(-1)!;
    expect(recovered).not.toBe(socket);
    recovered.open(); joined(recovered); receiveSnapshot(recovered, "same-game", 99);
    expect(client.currentView).toMatchObject({ gameId: "same-game", version: 100 });
    expect(handlers.onStarted).toHaveBeenCalledTimes(1);
  });
});

it("05D App新started同批收到snapshot后重建向导与抽屉，并清旧通知、结果和原始错误", async () => {
  mounted = await mountDom(createElement(App));
  Object.assign(window, { location: { protocol: "http:", host: "localhost:8000" } });
  await mounted.input("1～20 个字符", "甲"); await mounted.input("4～8 位数字", "0042");
  await mounted.click("加入");
  const socket = TestSocket.instances.at(-1)!;
  await act(async () => {
    socket.open(); joined(socket);
    socket.receive({ type: "room", hostId: "p1", state: "PLAYING", players: [
      { playerId: "p1", nickname: "甲", seatId: 1, online: true, ready: true },
      { playerId: "p2", nickname: "乙", seatId: 2, online: true, ready: true },
    ] });
    started(socket, "old-game"); receiveSnapshot(socket, "old-game", 100);
  });
  await mounted.click("跳过");
  expect(mounted.text()).toContain("是否向银行借款");
  await mounted.click("查看其他玩家");
  expect(mounted.container.querySelectorAll(".drawer")).toHaveLength(1);
  await act(async () => {
    socket.receive({ type: "events", gameId: "old-game", gameVersion: 100, events: [
      { seq: 99, type: "BANK_LOAN_DEFAULTED", at: "2026-11-04T00:00:00Z",
        payload: { borrowerId: "p1", loanId: "old-loan", reason: "timeout" } },
    ] });
    socket.receive({ type: "command_result", gameId: "old-game", gameVersion: 100,
      commandId: "old-command", outcome: { ok: false, code: "INVALID_STATE", message: "旧回执原因" } });
  });
  expect(mounted.text()).toContain("永久失信");
  expect(mounted.text()).toContain("旧回执原因");
  // 05E 复核修复后反馈区只显示一条（优先级 本地提示 > 服务端 error > 命令回执），
  // 因此旧回执在旧 error 到达后被替换；两者仍需在各自出现时可见、并在新局开始时清空。
  await act(async () => {
    socket.receive({ type: "error", code: "INVALID_STATE", message: "旧服务端原因" });
  });
  expect(mounted.text()).toContain("INVALID_STATE：旧服务端原因");
  expect(mounted.text()).not.toContain("旧回执原因");
  await act(async () => { started(socket, "new-game"); receiveSnapshot(socket, "new-game", 1); });
  expect(mounted.text()).toContain("是否向其他玩家借款");
  expect(mounted.text()).not.toContain("永久失信");
  expect(mounted.text()).not.toContain("旧回执原因");
  expect(mounted.text()).not.toContain("旧服务端原因");
  expect(mounted.container.querySelectorAll(".drawer")).toHaveLength(0);
});
