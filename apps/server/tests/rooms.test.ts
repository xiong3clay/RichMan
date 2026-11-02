import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createInitialState } from "@richman/game-core";
import type { LobbyErrorCode } from "@richman/shared";
import { LobbyError, RoomManager } from "../src/rooms/manager.js";
import type { RoomManagerEvent } from "../src/rooms/manager.js";
import { startServer } from "../src/http.js";
import type { StartedServer } from "../src/http.js";

function expectLobbyError(run: () => unknown, code: LobbyErrorCode): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(LobbyError);
    expect((error as LobbyError).code).toBe(code);
    return;
  }
  throw new Error("预期抛出 LobbyError(" + code + ")");
}

function readyAll(manager: RoomManager, roomCode: string, tokens: string[]): void {
  for (const token of tokens) manager.setReady(token, true);
}

describe("room_lifecycle", () => {
  it("建房码为 4～8 位数字字符串并允许前导零，加入分配稳定座位", () => {
    const manager = new RoomManager({ generateRoomCode: () => "0042" });
    const code = manager.createRoom();
    expect(code).toBe("0042");
    expect(code).toMatch(/^[0-9]{4,8}$/);

    const first = manager.join(code, "甲");
    expect(first.seatId).toBe(1);
    expect(first.playerId).toBe("p1");
    expect(first.sessionToken.length).toBeGreaterThanOrEqual(16);
    expect(manager.getRoom(code)?.hostId).toBe("p1");

    // 同名昵称允许，座位由服务端分配。
    const second = manager.join(code, "甲");
    expect(second.seatId).toBe(2);
    expect(second.playerId).not.toBe(first.playerId);
    expect(manager.getRoom(code)?.players).toHaveLength(2);

    // 同一 token 重复加入返回原座位，不新增玩家、不改变座位。
    const again = manager.join(code, "甲", first.sessionToken);
    expect(again.playerId).toBe(first.playerId);
    expect(again.seatId).toBe(1);
    expect(manager.getRoom(code)?.players).toHaveLength(2);
  });

  it("房间码碰撞会重试，不存在与满员返回明确错误码", () => {
    const codes = ["0001", "0001", "0002"];
    let index = 0;
    const manager = new RoomManager({
      generateRoomCode: () => {
        const code = codes[index] ?? "9999";
        index += 1;
        return code;
      },
    });
    expect(manager.createRoom()).toBe("0001");
    expect(manager.createRoom()).toBe("0002");

    expectLobbyError(() => manager.join("9999", "甲"), "ROOM_NOT_FOUND");

    const roomCode = manager.createRoom();
    for (let seat = 1; seat <= 10; seat += 1) {
      manager.join(roomCode, "玩家" + String(seat));
    }
    expect(manager.getRoom(roomCode)?.players).toHaveLength(10);
    expectLobbyError(() => manager.join(roomCode, "第十一人"), "ROOM_FULL");
  });

  it("昵称按码点计数：空串与 21 个 emoji 被拒，20 个 emoji 通过", () => {
    const manager = new RoomManager({ generateRoomCode: () => "1234" });
    const code = manager.createRoom();
    expectLobbyError(() => manager.join(code, ""), "INVALID_NICKNAME");
    expectLobbyError(() => manager.join(code, "😀".repeat(21)), "INVALID_NICKNAME");
    const accepted = manager.join(code, "😀".repeat(20));
    expect(accepted.playerId).toBe("p1");
  });
});

describe("ready_and_start_permissions", () => {
  it("非房主、人数不足、未全部准备都不能开始；房主且全部准备后进入 PLAYING", () => {
    const manager = new RoomManager({ generateRoomCode: () => "4321", generateGameId: () => "game-x" });
    const code = manager.createRoom();
    const host = manager.join(code, "房主");

    expectLobbyError(() => manager.start(host.sessionToken), "NOT_ENOUGH_PLAYERS");

    const guest = manager.join(code, "客人");
    expectLobbyError(() => manager.start(guest.sessionToken), "NOT_HOST");
    expectLobbyError(() => manager.start(host.sessionToken), "NOT_ALL_READY");

    manager.setReady(host.sessionToken, true);
    expectLobbyError(() => manager.start(host.sessionToken), "NOT_ALL_READY");

    manager.setReady(guest.sessionToken, true);
    const gameId = manager.start(host.sessionToken);
    expect(gameId).toBe("game-x");
    expect(manager.getRoom(code)?.state).toBe("PLAYING");
    expect(manager.getGame(code)?.players).toHaveLength(2);
  });
});

describe("start_freezes_roster", () => {
  it("开局调用 createInitialState，冻结名单与座位，之后加入/准备都返回 ALREADY_STARTED", () => {
    const calls: Array<{ gameId: string; players: number }> = [];
    const manager = new RoomManager({
      generateRoomCode: () => "5678",
      generateGameId: () => "game-frozen",
      createGameState: (gameId, config, seeds) => {
        calls.push({ gameId, players: seeds.length });
        return createInitialState(gameId, config, seeds);
      },
    });
    const code = manager.createRoom();
    const host = manager.join(code, "甲");
    const guest = manager.join(code, "乙");
    readyAll(manager, code, [host.sessionToken, guest.sessionToken]);
    manager.start(host.sessionToken);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.gameId).toBe("game-frozen");
    expect(calls[0]?.players).toBe(2);

    const game = manager.getGame(code);
    expect(game?.gameId).toBe("game-frozen");
    expect(game?.players).toHaveLength(2);
    expect(game?.players.map((player) => player.nickname)).toEqual(["甲", "乙"]);

    // 座位与名单冻结。
    const view = manager.getRoom(code);
    expect(view?.players.map((player) => [player.playerId, player.seatId])).toEqual([
      ["p1", 1],
      ["p2", 2],
    ]);
    expectLobbyError(() => manager.join(code, "丙"), "ALREADY_STARTED");
    expectLobbyError(() => manager.setReady(host.sessionToken, false), "ALREADY_STARTED");
  });
});

describe("disconnect_keeps_seat", () => {
  it("断开标记离线并广播 peer_left，座位保留；带原 token 再加入回到原座位", () => {
    const manager = new RoomManager({ generateRoomCode: () => "6789" });
    const code = manager.createRoom();
    const host = manager.join(code, "甲");
    const guest = manager.join(code, "乙");
    readyAll(manager, code, [host.sessionToken, guest.sessionToken]);
    manager.start(host.sessionToken);

    const events: RoomManagerEvent[] = [];
    manager.subscribe((event) => events.push(event));

    const leftId = manager.disconnect(guest.sessionToken);
    expect(leftId).toBe("p2");
    expect(events.filter((event) => event.type === "peer_left")).toEqual([
      { type: "peer_left", roomCode: code, playerId: "p2" },
    ]);

    const view = manager.getRoom(code);
    expect(view?.players).toHaveLength(2);
    expect(view?.players.find((player) => player.playerId === "p2")?.online).toBe(false);
    expect(view?.players.find((player) => player.playerId === "p2")?.seatId).toBe(2);

    const back = manager.join(code, "乙", guest.sessionToken);
    expect(back.playerId).toBe("p2");
    expect(back.seatId).toBe(2);
  });
});

type LobbyMessage = { type: string } & Record<string, unknown>;

interface RoomPlayerMessage {
  playerId: string;
  nickname: string;
  seatId: number;
  ready: boolean;
  online: boolean;
}

class LobbyClient {
  readonly messages: LobbyMessage[] = [];
  private readonly waiters: Array<{
    predicate: (message: LobbyMessage) => boolean;
    resolve: (message: LobbyMessage) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(readonly ws: WebSocket) {
    ws.on("message", (data) => {
      const message = JSON.parse(String(data)) as LobbyMessage;
      const index = this.waiters.findIndex((waiter) => waiter.predicate(message));
      if (index >= 0) {
        const waiter = this.waiters.splice(index, 1)[0]!;
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else {
        this.messages.push(message);
      }
    });
  }

  next(type: string, check: (message: LobbyMessage) => boolean = () => true): Promise<LobbyMessage> {
    const predicate = (message: LobbyMessage) => message.type === type && check(message);
    const index = this.messages.findIndex(predicate);
    if (index >= 0) {
      const found = this.messages.splice(index, 1)[0]!;
      return Promise.resolve(found);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("等待消息超时：" + type)), 3000);
      this.waiters.push({ predicate, resolve, timer });
    });
  }

  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  sendRaw(raw: string): void {
    this.ws.send(raw);
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      this.ws.once("close", () => resolve());
      this.ws.close();
    });
  }
}

function openClient(url: string): Promise<LobbyClient> {
  const ws = new WebSocket(url);
  const client = new LobbyClient(ws);
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(client));
    ws.once("error", reject);
  });
}

function wsUrl(roomCode: string): string {
  return "ws://127.0.0.1:" + String(started.port) + "/ws?room=" + roomCode;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("条件等待超时");
}

function playersOf(message: LobbyMessage): RoomPlayerMessage[] {
  return message["players"] as RoomPlayerMessage[];
}

let started: StartedServer;
let baseUrl: string;
let roomCode: string;

beforeAll(async () => {
  started = await startServer({ host: "127.0.0.1", port: 0, staticDir: "D:/nonexistent-static-dir" });
  baseUrl = "http://127.0.0.1:" + String(started.port);
  roomCode = started.manager.createRoom();
});

afterAll(async () => {
  await started.close();
});

async function readHealth(): Promise<{ connections: number; rooms: number }> {
  const res = await fetch(baseUrl + "/health");
  return (await res.json()) as { connections: number; rooms: number };
}

async function waitHealth(predicate: (body: { connections: number; rooms: number }) => boolean): Promise<{
  connections: number;
  rooms: number;
}> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const body = await readHealth();
    if (predicate(body)) return body;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("/health 计数未达到预期");
}

describe("health_counts", () => {
  it("/health 的 rooms 与 connections 反映真实房间和连接数", async () => {
    const empty = await readHealth();
    expect(empty.rooms).toBe(1);
    expect(empty.connections).toBe(0);

    const first = await openClient("ws://127.0.0.1:" + String(started.port) + "/ws?room=" + roomCode);
    expect((await waitHealth((body) => body.connections === 1)).connections).toBe(1);

    const second = await openClient("ws://127.0.0.1:" + String(started.port) + "/ws?room=" + roomCode);
    expect((await waitHealth((body) => body.connections === 2)).connections).toBe(2);

    await second.close();
    expect((await waitHealth((body) => body.connections === 1)).connections).toBe(1);

    await first.close();
    expect((await waitHealth((body) => body.connections === 0)).connections).toBe(0);
    expect(await readHealth()).toMatchObject({ rooms: 1, connections: 0 });
  });
});

describe("ws_lobby_flow", () => {
  it("加入、准备、房主开始、开局后拒绝新加入、断开广播 peer_left 且保留座位", async () => {
    const url = "ws://127.0.0.1:" + String(started.port) + "/ws?room=" + roomCode;
    const hostClient = await openClient(url);
    hostClient.send({ type: "join", nickname: "甲" });
    const hostJoined = await hostClient.next("joined");
    expect(hostJoined["playerId"]).toBe("p1");
    expect(hostJoined["seatId"]).toBe(1);
    expect(hostJoined["roomCode"]).toBe(roomCode);
    expect(String(hostJoined["sessionToken"]).length).toBeGreaterThanOrEqual(16);
    const hostToken = String(hostJoined["sessionToken"]);
    await hostClient.next("room");

    const guestClient = await openClient(url);
    guestClient.send({ type: "join", nickname: "乙" });
    const guestJoined = await guestClient.next("joined");
    expect(guestJoined["seatId"]).toBe(2);
    await hostClient.next("room", (message) => playersOf(message).length === 2);

    guestClient.send({ type: "ready", ready: true });
    await hostClient.next("room", (message) =>
      playersOf(message).some((player) => player.playerId === "p2" && player.ready),
    );

    hostClient.send({ type: "ready", ready: true });
    await hostClient.next("room", (message) => playersOf(message).every((player) => player.ready));

    guestClient.send({ type: "start" });
    const notHost = await guestClient.next("error");
    expect(notHost["code"]).toBe("NOT_HOST");

    hostClient.send({ type: "start" });
    const playing = await hostClient.next("room", (message) => message["state"] === "PLAYING");
    expect(playing["players"]).toHaveLength(2);
    const startedMessage = await hostClient.next("started");
    const gameId = String(startedMessage["gameId"]);
    expect(started.manager.getGame(roomCode)?.gameId).toBe(gameId);
    expect(started.manager.getGame(roomCode)?.players).toHaveLength(2);

    const lateClient = await openClient(url);
    lateClient.send({ type: "join", nickname: "丙" });
    const lateError = await lateClient.next("error");
    expect(lateError["code"]).toBe("ALREADY_STARTED");
    await lateClient.close();

    await guestClient.close();
    const left = await hostClient.next("peer_left");
    expect(left["playerId"]).toBe("p2");
    const view = started.manager.getRoom(roomCode);
    expect(view?.players).toHaveLength(2);
    expect(view?.players.find((player) => player.playerId === "p2")?.online).toBe(false);
    expect(view?.players.find((player) => player.playerId === "p2")?.seatId).toBe(2);
    expect(hostToken.length).toBeGreaterThanOrEqual(16);

    await hostClient.close();
  });
});

describe("ws_rejects_invalid_messages", () => {
  it("未知 type、超长昵称、非法布尔值都被拒绝", async () => {
    const client = await openClient(
      "ws://127.0.0.1:" + String(started.port) + "/ws?room=" + roomCode,
    );

    client.send({ type: "bogus" });
    expect((await client.next("error"))["code"]).toBe("INVALID_MESSAGE");

    client.send({ type: "join", nickname: "😀".repeat(21) });
    expect((await client.next("error"))["code"]).toBe("INVALID_MESSAGE");

    client.send({ type: "ready", ready: "yes" });
    expect((await client.next("error"))["code"]).toBe("INVALID_MESSAGE");

    client.sendRaw("not-json");
    expect((await client.next("error"))["code"]).toBe("INVALID_MESSAGE");

    await client.close();
  });
});

describe("m1_token_not_in_url", () => {
  it("token 不通过连接 URL 传达身份；房间广播不含 sessionToken/tokenDigest", async () => {
    const code = started.manager.createRoom();
    const rawLog: string[] = [];
    const seen = new Set<string>();
    const watch = (client: LobbyClient): void => {
      client.ws.on("message", (data) => {
        const raw = String(data);
        rawLog.push(raw);
        seen.add((JSON.parse(raw) as { type: string }).type);
      });
    };

    const firstUrl = wsUrl(code);
    expect(firstUrl).not.toContain("token");
    const first = await openClient(firstUrl);
    watch(first);
    expect(first.ws.url).toBe(firstUrl);

    first.send({ type: "join", nickname: "甲" });
    const firstJoined = await first.next("joined");
    const firstToken = String(firstJoined["sessionToken"]);
    expect(firstToken.length).toBeGreaterThanOrEqual(16);
    await first.next("room");

    // 第二个连接故意把 token 放进 URL，而 join 消息体不带 token：URL 里的 token 不会被当作身份。
    const second = await openClient(wsUrl(code) + "&token=" + firstToken);
    watch(second);
    second.send({ type: "join", nickname: "乙" });
    const secondJoined = await second.next("joined");
    expect(secondJoined["seatId"]).toBe(2);
    expect(secondJoined["playerId"]).not.toBe(firstJoined["playerId"]);
    const secondToken = String(secondJoined["sessionToken"]);
    expect(secondToken).not.toBe(firstToken);
    await second.next("room");

    await first.next("room", (message) => playersOf(message).length === 2);

    first.send({ type: "ready", ready: true });
    await second.next("room", (message) =>
      playersOf(message).some((player) => player.playerId === "p1" && player.ready),
    );
    second.send({ type: "ready", ready: true });
    await first.next("room", (message) => playersOf(message).every((player) => player.ready));

    await second.close();
    await first.next("peer_left", (message) => message["playerId"] === "p2");

    first.send({ type: "start" });
    await first.next("started");

    expect(seen.has("room")).toBe(true);
    expect(seen.has("peer_left")).toBe(true);
    expect(seen.has("started")).toBe(true);
    const broadcastTypes = new Set(["room", "peer_left", "started"]);
    const broadcastRaw = rawLog.filter((raw) =>
      broadcastTypes.has((JSON.parse(raw) as { type: string }).type),
    );
    expect(broadcastRaw.length).toBeGreaterThan(0);
    for (const raw of broadcastRaw) {
      expect(raw).not.toContain("sessionToken");
      expect(raw).not.toContain("tokenDigest");
    }

    await first.close();
  });
});

describe("m2_connection_ownership", () => {
  it("同 token 新连接接管座位：旧连接收到 REPLACED 并关闭，旧连接不再影响在线状态", async () => {
    const code = started.manager.createRoom();
    const first = await openClient(wsUrl(code));
    first.send({ type: "join", nickname: "甲" });
    const joined = await first.next("joined");
    const token = String(joined["sessionToken"]);
    expect(joined["playerId"]).toBe("p1");
    first.send({ type: "ready", ready: true });
    await first.next("room", (message) =>
      playersOf(message).some((player) => player.playerId === "p1" && player.ready),
    );

    const second = await openClient(wsUrl(code));
    second.send({ type: "join", nickname: "甲", sessionToken: token });
    const secondJoined = await second.next("joined");
    expect(secondJoined["playerId"]).toBe("p1");
    expect(secondJoined["seatId"]).toBe(1);
    expect(secondJoined["sessionToken"]).toBe(token);

    const replaced = await first.next("error");
    expect(replaced["code"]).toBe("REPLACED");
    await waitFor(() => first.ws.readyState === WebSocket.CLOSED);

    // 旧连接已被关闭；即便再发消息也不会改变房间状态。
    first.ws.send(JSON.stringify({ type: "ready", ready: false }));
    await new Promise((resolve) => setTimeout(resolve, 100));

    const view = started.manager.getRoom(code);
    expect(view?.players).toHaveLength(1);
    const host = view?.players.find((player) => player.playerId === "p1");
    expect(host?.online).toBe(true);
    expect(host?.ready).toBe(true);

    // 新连接仍是该座位的 owner，可以继续操作。
    second.send({ type: "ready", ready: false });
    await waitFor(
      () => started.manager.getRoom(code)?.players.find((player) => player.playerId === "p1")?.ready === false,
    );
    expect(started.manager.getRoom(code)?.players.find((player) => player.playerId === "p1")?.online).toBe(true);

    await second.close();
  });
});

describe("m3_http_create_room", () => {
  it("POST /api/rooms 建房后两个 ws 加入、准备、开始；不存在与满员返回明确错误码", async () => {
    const created = await fetch(baseUrl + "/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nickname: "房主" }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { ok: boolean; roomCode: string };
    expect(body.ok).toBe(true);
    expect(body.roomCode).toMatch(/^[0-9]{4,8}$/);

    const host = await openClient(wsUrl(body.roomCode));
    host.send({ type: "join", nickname: "房主" });
    const hostJoined = await host.next("joined");
    expect(hostJoined["seatId"]).toBe(1);
    expect(String(hostJoined["sessionToken"]).length).toBeGreaterThanOrEqual(16);

    const guest = await openClient(wsUrl(body.roomCode));
    guest.send({ type: "join", nickname: "客人" });
    const guestJoined = await guest.next("joined");
    expect(guestJoined["seatId"]).toBe(2);

    host.send({ type: "ready", ready: true });
    guest.send({ type: "ready", ready: true });
    await host.next("room", (message) =>
      playersOf(message).length === 2 && playersOf(message).every((player) => player.ready),
    );

    host.send({ type: "start" });
    const startedMessage = await host.next("started");
    expect(started.manager.getGame(body.roomCode)?.gameId).toBe(startedMessage["gameId"]);
    expect(started.manager.getRoom(body.roomCode)?.state).toBe("PLAYING");

    await host.close();
    await guest.close();

    let missingCode = "0000";
    while (started.manager.getRoom(missingCode) !== null) {
      missingCode = String(Number(missingCode) + 1).padStart(4, "0");
    }
    const missing = await openClient(wsUrl(missingCode));
    missing.send({ type: "join", nickname: "无" });
    expect((await missing.next("error"))["code"]).toBe("ROOM_NOT_FOUND");
    await missing.close();

    const fullCode = started.manager.createRoom();
    for (let seat = 1; seat <= 10; seat += 1) {
      started.manager.join(fullCode, "玩家" + String(seat));
    }
    const eleventh = await openClient(wsUrl(fullCode));
    eleventh.send({ type: "join", nickname: "第十一人" });
    expect((await eleventh.next("error"))["code"]).toBe("ROOM_FULL");
    await eleventh.close();
  });
});
