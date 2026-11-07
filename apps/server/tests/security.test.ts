import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import WebSocket from "ws";
import { NicknameSchema } from "@richman/shared";
import {
  ConnectionGuard,
  DEFAULT_SECURITY_LIMITS,
  TokenBucket,
  isAllowedOrigin,
  loadSecurityLimits,
} from "../src/security.js";
import type { SecurityLimits } from "../src/security.js";
import { Peer, createRoom, makeLimits, startSecurityServer } from "./security-harness.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function server(partial: Partial<SecurityLimits> = {}, wsOptions: Record<string, unknown> = {}) {
  const started = await startSecurityServer(partial, wsOptions);
  cleanups.push(() => started.close());
  return started;
}

function trackPeer(peer: Peer): Peer {
  cleanups.push(() => peer.close());
  return peer;
}

function rawWsStatus(url: string, options: WebSocket.ClientOptions): Promise<number> {
  return new Promise(resolve => {
    const ws = new WebSocket(url, options);
    ws.on("unexpected-response", (_request, response) => {
      resolve(response.statusCode ?? 0);
      ws.terminate();
    });
    ws.on("open", () => { ws.close(); resolve(0); });
    ws.on("error", () => resolve(0));
  });
}

function commandEnvelope(view: Record<string, any>, commandId: string, type: string, payload: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    gameId: view["gameId"],
    commandId,
    type,
    payload,
    expectedGameVersion: view["version"],
  };
}

async function waitFor(check: () => boolean, timeoutMs = 500): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started >= timeoutMs) throw new Error("等待条件超时");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function waitForClose(ws: WebSocket, timeoutMs = 1500): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("连接未在时限内关闭")), timeoutMs);
    ws.once("close", () => { clearTimeout(timer); resolve(); });
  });
}

/** 真实 TCP 发缺 Sec-WebSocket-Key 的 upgrade，返回服务端状态码。 */
function rawInvalidHandshake(port: number): Promise<number> {
  return new Promise(resolve => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write("GET /ws HTTP/1.1\r\nHost: 127.0.0.1:" + String(port)
        + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    });
    let data = "";
    let settled = false;
    const finish = (status: number): void => {
      if (settled) return;
      settled = true;
      resolve(status);
    };
    socket.on("data", chunk => { data += String(chunk); });
    socket.on("close", () => {
      const match = /^HTTP\/1\.1 (\d+)/.exec(data);
      finish(match ? Number(match[1]) : 0);
    });
    socket.on("error", () => finish(0));
  });
}

describe("09A security", () => {
  it("1 TokenBucket 容量内连续取成功，超出失败", () => {
    const bucket = new TokenBucket(3, 0, () => 1000);
    expect(bucket.tryTake("a")).toBe(true);
    expect(bucket.tryTake("a")).toBe(true);
    expect(bucket.tryTake("a")).toBe(true);
    expect(bucket.tryTake("a")).toBe(false);
  });

  it("2 TokenBucket 按毫秒回填并封顶", () => {
    let now = 0;
    const bucket = new TokenBucket(2, 1 / 1000, () => now);
    bucket.tryTake("a"); bucket.tryTake("a");
    expect(bucket.tryTake("a")).toBe(false);
    now = 1000;
    expect(bucket.tryTake("a")).toBe(true);
    now = 5000;
    expect(bucket.tryTake("a")).toBe(true);
    expect(bucket.tryTake("a")).toBe(true);
    expect(bucket.tryTake("a")).toBe(false);
  });

  it("3 TokenBucket 不同 key 独立", () => {
    const bucket = new TokenBucket(1, 0, () => 0);
    expect(bucket.tryTake("a")).toBe(true);
    expect(bucket.tryTake("a")).toBe(false);
    expect(bucket.tryTake("b")).toBe(true);
  });

  it("4 prune 清掉闲置 key，不影响活跃 key", () => {
    let now = 0;
    const bucket = new TokenBucket(1, 0, () => now);
    bucket.tryTake("old");
    now = 100;
    bucket.tryTake("new");
    now = 200;
    bucket.prune(150);
    expect(bucket.size()).toBe(1);
    expect(bucket.tryTake("new")).toBe(false);
  });

  it("5 Origin 缺失/空串放行", () => {
    expect(isAllowedOrigin(undefined, "localhost:8000", [])).toBe(true);
    expect(isAllowedOrigin("", "localhost:8000", [])).toBe(true);
  });

  it("6 同 Host 放行（含端口）", () => {
    expect(isAllowedOrigin("http://localhost:8000", "localhost:8000", [])).toBe(true);
    expect(isAllowedOrigin("https://example.test:443", "EXAMPLE.TEST:443", [])).toBe(true);
  });

  it("7 额外白名单放行", () => {
    expect(isAllowedOrigin("https://abc.trycloudflare.com", "127.0.0.1:8000",
      ["https://abc.trycloudflare.com/"])).toBe(true);
  });

  it("8 evil origin 拒绝", () => {
    expect(isAllowedOrigin("http://evil.example", "localhost:8000", [])).toBe(false);
  });

  it("9 Host 缺失 + Origin 存在拒绝", () => {
    expect(isAllowedOrigin("http://localhost:8000", undefined, [])).toBe(false);
  });

  it("10 非法 URL 拒绝", () => {
    expect(isAllowedOrigin("not a url", "localhost:8000", [])).toBe(false);
    expect(isAllowedOrigin("ftp://localhost:8000", "localhost:8000", [])).toBe(false);
  });

  it("11 ConnectionGuard 总数上限", () => {
    const guard = new ConnectionGuard(makeLimits({ maxConnectionsTotal: 2, maxConnectionsPerIp: 10, maxUnauthenticated: 10 }));
    expect(guard.admit("a").ok).toBe(true);
    expect(guard.admit("b").ok).toBe(true);
    expect(guard.admit("c")).toMatchObject({ ok: false, code: "TOO_MANY_CONNECTIONS" });
  });

  it("12 ConnectionGuard 单 IP 上限", () => {
    const guard = new ConnectionGuard(makeLimits({ maxConnectionsPerIp: 2, maxConnectionsTotal: 10, maxUnauthenticated: 10 }));
    expect(guard.admit("a").ok).toBe(true);
    expect(guard.admit("a").ok).toBe(true);
    expect(guard.admit("a")).toMatchObject({ ok: false, code: "TOO_MANY_CONNECTIONS" });
  });

  it("13 ConnectionGuard 未认证上限", () => {
    const guard = new ConnectionGuard(makeLimits({ maxUnauthenticated: 2, maxConnectionsTotal: 10, maxConnectionsPerIp: 10 }));
    expect(guard.admit("a").ok).toBe(true);
    expect(guard.admit("b").ok).toBe(true);
    expect(guard.admit("c")).toMatchObject({ ok: false, code: "TOO_MANY_UNAUTHENTICATED" });
  });

  it("14 markAuthenticated 后未认证数下降", () => {
    const guard = new ConnectionGuard(makeLimits({ maxUnauthenticated: 2, maxConnectionsTotal: 10, maxConnectionsPerIp: 10 }));
    guard.admit("a"); guard.admit("b");
    guard.markAuthenticated("a");
    expect(guard.stats().unauthenticated).toBe(1);
    expect(guard.admit("c").ok).toBe(true);
  });

  it("15 release 幂等且计数不为负", () => {
    const guard = new ConnectionGuard(makeLimits({ maxConnectionsTotal: 1, maxConnectionsPerIp: 1, maxUnauthenticated: 1 }));
    guard.admit("a");
    guard.release("a", false);
    guard.release("a", false);
    expect(guard.stats()).toEqual({ total: 0, unauthenticated: 0, perIp: {} });
  });

  it("16 POST /api/rooms 跨站 Origin 403", async () => {
    const s = await server();
    const response = await fetch(`http://127.0.0.1:${s.port}/api/rooms`, {
      method: "POST", headers: { "content-type": "application/json", origin: "http://evil.example" }, body: "{}",
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ ok: false, error: "ORIGIN_NOT_ALLOWED" });
  });

  it("17 非 JSON Content-Type 415", async () => {
    const s = await server();
    const response = await fetch(`http://127.0.0.1:${s.port}/api/rooms`, {
      method: "POST", headers: { "content-type": "text/plain" }, body: '{"nickname":"x"}',
    });
    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({ ok: false, error: "UNSUPPORTED_MEDIA_TYPE" });
  });

  it("18 建房超过 createRoomBurst 连续请求 429", async () => {
    const s = await server({ createRoomBurst: 2, createRoomPerMinute: 0 });
    expect((await createRoom(s.port)).status).toBe(201);
    expect((await createRoom(s.port)).status).toBe(201);
    expect((await createRoom(s.port)).status).toBe(429);
  });

  it("19 房间数达 maxRooms 503", async () => {
    const s = await server({ maxRooms: 1 });
    expect((await createRoom(s.port)).status).toBe(201);
    const second = await createRoom(s.port);
    expect(second.status).toBe(503);
    expect(second.body).toMatchObject({ ok: false, error: "ROOM_LIMIT" });
  });

  it("20 /api/unknown 404 JSON 且不是 index.html", async () => {
    const s = await server();
    const response = await fetch(`http://127.0.0.1:${s.port}/api/unknown`);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({ ok: false, error: "NOT_FOUND" });
  });

  it("21 /health 与静态响应带三个安全头", async () => {
    const s = await server();
    const health = await fetch(`http://127.0.0.1:${s.port}/health`);
    expect(health.headers.get("x-content-type-options")).toBe("nosniff");
    expect(health.headers.get("referrer-policy")).toBe("no-referrer");
    expect(health.headers.get("x-frame-options")).toBe("DENY");
    const page = await fetch(`http://127.0.0.1:${s.port}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("22 升级带 evil Origin 被 403 拒绝", async () => {
    const s = await server();
    const status = await rawWsStatus(`ws://127.0.0.1:${s.port}/ws`, { origin: "http://evil.example" });
    expect(status).toBe(403);
    expect(s.security.guard.stats().total).toBe(0);
  });

  it("23 同 Host Origin 能连上", async () => {
    const s = await server();
    const peer = await Peer.open(s.port, "0000", { origin: `http://127.0.0.1:${s.port}` });
    expect(peer.ws.readyState).toBe(WebSocket.OPEN);
    await peer.close();
  });

  it("24 连接数超 per-IP 上限被 503", async () => {
    const s = await server({ maxConnectionsPerIp: 2, maxConnectionsTotal: 10, maxUnauthenticated: 10 });
    const a = await Peer.open(s.port, "0000");
    const b = await Peer.open(s.port, "0000");
    cleanups.push(() => a.close(), () => b.close());
    const status = await rawWsStatus(`ws://127.0.0.1:${s.port}/ws`, {});
    expect(status).toBe(503);
  });

  it("25 同一玩家命令突发超过 commandBurst 收到 RATE_LIMITED", async () => {
    const s = await server({ commandBurst: 3, commandPerSecond: 0, economicBurst: 10, economicPerSecond: 0 });
    const { body } = await createRoom(s.port);
    const room = body["roomCode"] as string;
    const host = await Peer.open(s.port, room);
    host.send({ type: "join", nickname: "甲" });
    await host.next("joined");
    const guest = await Peer.open(s.port, room);
    guest.send({ type: "join", nickname: "乙" });
    await guest.next("joined");
    host.send({ type: "ready", ready: true });
    guest.send({ type: "ready", ready: true });
    await host.next("room", message => message.players.every((player: Record<string, unknown>) => player["ready"]));
    host.send({ type: "start" });
    const started = await host.next("started");
    const snapshot = await host.next("snapshot");
    await guest.next("snapshot");
    const view = snapshot["view"] as Record<string, any>;
    const versionBefore = s.manager.getGame(room)!.version;
    for (let index = 0; index < 4; index += 1) {
      host.send(commandEnvelope(view, "burst-" + index, "BANK_DUE_DECISION"));
    }
    const error = await host.next("error", message => message.code === "RATE_LIMITED");
    expect(error.code).toBe("RATE_LIMITED");
    expect(s.manager.getGame(room)!.version).toBe(versionBefore);
    await host.close(); await guest.close();
    void started;
  });

  it("26 经济命令桶更严：10 连发 BORROW_BANK 后第 11 条限流", async () => {
    const s = await server({ commandBurst: 20, commandPerSecond: 0, economicBurst: 10, economicPerSecond: 0 });
    const { body } = await createRoom(s.port);
    const room = body["roomCode"] as string;
    const host = await Peer.open(s.port, room);
    host.send({ type: "join", nickname: "甲" });
    await host.next("joined");
    const guest = await Peer.open(s.port, room);
    guest.send({ type: "join", nickname: "乙" });
    await guest.next("joined");
    host.send({ type: "ready", ready: true });
    guest.send({ type: "ready", ready: true });
    await host.next("room", message => message.players.every((player: Record<string, unknown>) => player["ready"]));
    host.send({ type: "start" });
    await host.next("started");
    const view = (await host.next("snapshot"))["view"] as Record<string, any>;
    await guest.next("snapshot");
    for (let index = 0; index < 11; index += 1) {
      host.send(commandEnvelope(view, "borrow-" + index, "BORROW_BANK", { amountCents: "100" }));
    }
    const error = await host.next("error", message => message.code === "RATE_LIMITED");
    expect(error.code).toBe("RATE_LIMITED");
    await host.close(); await guest.close();
  });

  it("27 同 IP 连续 join 超 joinBurst 后 RATE_LIMITED", async () => {
    const s = await server({ joinBurst: 2, joinPerMinute: 0 });
    const room = s.manager.createRoom();
    const first = await Peer.open(s.port, room);
    first.send({ type: "join", nickname: "甲" });
    await first.next("joined");
    const second = await Peer.open(s.port, room);
    second.send({ type: "join", nickname: "乙" });
    await second.next("joined");
    const third = await Peer.open(s.port, room);
    third.send({ type: "join", nickname: "丙" });
    expect((await third.next("error")).code).toBe("RATE_LIMITED");
    cleanups.push(() => first.close(), () => second.close(), () => third.close());
  });

  it("28 昵称 20 个 emoji 通过；21 个/换行/NUL 拒绝", () => {
    expect(NicknameSchema.safeParse("😀".repeat(20)).success).toBe(true);
    expect(NicknameSchema.safeParse("😀".repeat(21)).success).toBe(false);
    expect(NicknameSchema.safeParse("a\nb").success).toBe(false);
    expect(NicknameSchema.safeParse("a\u0000b").success).toBe(false);
  });

  it("29 未认证连接超时先 error 后 close 4003", async () => {
    let clock = 1000;
    let scan: (() => void) | null = null;
    const s = await server({ unauthTimeoutMs: 100 }, {
      now: () => clock,
      authClock: {
        setInterval: (callback: () => void): unknown => { scan = callback; return "auth-interval"; },
        clearInterval: (): void => { scan = null; },
      },
    });
    const peer = trackPeer(await Peer.open(s.port, "4242"));
    const closed = new Promise<number>((resolve, reject) => {
      peer.ws.once("close", code => resolve(code));
      setTimeout(() => reject(new Error("连接未在时限内关闭")), 3000);
    });
    clock += 101;
    expect(scan).not.toBeNull();
    scan!();
    expect((await peer.next("error")).code).toBe("INVALID_MESSAGE");
    expect(await closed).toBe(4003);
  });

  it("30 resume 超过 resumeBurst 后 RATE_LIMITED，座位不变", async () => {
    const s = await server({ resumeBurst: 1, resumePerMinute: 0, resumePerRoomPerMinute: 0 });
    const room = s.manager.createRoom();
    const host = trackPeer(await Peer.open(s.port, room));
    host.send({ type: "join", nickname: "甲" });
    const joined = await host.next("joined");
    const first = trackPeer(await Peer.open(s.port, room));
    first.send({ type: "resume", roomCode: room, sessionToken: joined.sessionToken });
    await first.next("joined");
    const second = trackPeer(await Peer.open(s.port, room));
    second.send({ type: "resume", roomCode: room, sessionToken: joined.sessionToken });
    expect((await second.next("error")).code).toBe("RATE_LIMITED");
    expect(s.manager.getRoom(room)?.players).toHaveLength(1);
  });

  it("31 resume 按房间桶：不同来源 IP 也会被同房限流", async () => {
    const s = await server({
      trustProxy: true,
      resumeBurst: 1,
      resumePerMinute: 0,
      resumePerRoomPerMinute: 0,
      joinBurst: 100,
      joinPerMinute: 1000,
    });
    const room = s.manager.createRoom();
    const a = trackPeer(await Peer.open(s.port, room, { "x-forwarded-for": "10.0.0.1" }));
    a.send({ type: "join", nickname: "甲" });
    const ja = await a.next("joined");
    const b = trackPeer(await Peer.open(s.port, room, { "x-forwarded-for": "10.0.0.2" }));
    b.send({ type: "join", nickname: "乙" });
    await b.next("joined");
    const r1 = trackPeer(await Peer.open(s.port, room, { "x-forwarded-for": "10.0.0.3" }));
    r1.send({ type: "resume", roomCode: room, sessionToken: ja.sessionToken });
    await r1.next("joined");
    const r2 = trackPeer(await Peer.open(s.port, room, { "x-forwarded-for": "10.0.0.4" }));
    r2.send({ type: "resume", roomCode: room, sessionToken: ja.sessionToken });
    expect((await r2.next("error")).code).toBe("RATE_LIMITED");
    expect(s.manager.getRoom(room)?.players).toHaveLength(2);
  });

  it("32 loadSecurityLimits 合法覆盖、非法回退默认、trustProxy 只认 1", () => {
    const env = {
      NODE_ENV: "production",
      RICHMAN_MAX_CONNECTIONS: "12",
      RICHMAN_MAX_CONNECTIONS_PER_IP: "0",
      RICHMAN_MAX_ROOMS: "abc",
      RICHMAN_ALLOWED_ORIGINS: "https://a.example, https://b.example",
      RICHMAN_TRUST_PROXY: "1",
    } as NodeJS.ProcessEnv;
    const limits = loadSecurityLimits(env);
    expect(limits.maxConnectionsTotal).toBe(12);
    expect(limits.maxConnectionsPerIp).toBe(DEFAULT_SECURITY_LIMITS.maxConnectionsPerIp);
    expect(limits.maxRooms).toBe(DEFAULT_SECURITY_LIMITS.maxRooms);
    expect(limits.allowedOrigins).toEqual(["https://a.example", "https://b.example"]);
    expect(limits.trustProxy).toBe(true);
    expect(loadSecurityLimits({}).trustProxy).toBe(false);
    expect(loadSecurityLimits({ RICHMAN_TRUST_PROXY: "true" }).trustProxy).toBe(false);
    expect(loadSecurityLimits({ NODE_ENV: "test" }).allowedOrigins).toEqual([]);
  });

  it("33 release 按真实认证状态记账，不跨维度回退", () => {
    const guard = new ConnectionGuard(makeLimits({ maxUnauthenticated: 10, maxConnectionsTotal: 10, maxConnectionsPerIp: 10 }));
    guard.admit("a");
    guard.admit("a");
    guard.markAuthenticated("a");
    guard.release("a", false);
    expect(guard.stats()).toEqual({ total: 1, unauthenticated: 0, perIp: { a: 1 } });
    guard.release("a", true);
    expect(guard.stats()).toEqual({ total: 0, unauthenticated: 0, perIp: {} });
  });

  it("34 同 IP 已认证+未认证连接关闭后不泄漏未认证名额", async () => {
    const s = await server({ maxConnectionsTotal: 10, maxConnectionsPerIp: 10, maxUnauthenticated: 1 });
    const room = s.manager.createRoom();
    const a = trackPeer(await Peer.open(s.port, room));
    a.send({ type: "join", nickname: "甲" });
    await a.next("joined");
    await waitFor(() => s.security.guard.stats().unauthenticated === 0);
    const b = await Peer.open(s.port, room);
    await b.close();
    await waitFor(() => s.security.guard.stats().unauthenticated === 0);
    const c = trackPeer(await Peer.open(s.port, room));
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    await c.close();
    await a.close();
    await waitFor(() => s.security.guard.stats().total === 0);
  });

  it("35 命令桶按房间码|玩家ID 隔离，不同房间 p1 互不占额度", async () => {
    const s = await server({ commandBurst: 2, commandPerSecond: 0, economicBurst: 99, economicPerSecond: 0 });
    const roomA = s.manager.createRoom();
    const roomB = s.manager.createRoom();
    const a = trackPeer(await Peer.open(s.port, roomA));
    a.send({ type: "join", nickname: "甲" });
    await a.next("joined");
    const b = trackPeer(await Peer.open(s.port, roomB));
    b.send({ type: "join", nickname: "乙" });
    await b.next("joined");
    for (let index = 0; index < 3; index += 1) {
      a.send({ protocolVersion: 1, gameId: "game-a", commandId: "a-" + String(index), type: "END_ACTION", payload: {} });
    }
    expect((await a.next("error", message => message.code === "RATE_LIMITED")).code).toBe("RATE_LIMITED");
    const before = b.messages.length;
    b.send({ protocolVersion: 1, gameId: "game-b", commandId: "b-0", type: "END_ACTION", payload: {} });
    await waitFor(() => b.messages.length > before, 1000);
    expect(b.messages.slice(before).some(message => message.type === "error" && message.code === "RATE_LIMITED")).toBe(false);
  });

  it("36 text/plain + 空对象 {} 不再兼容，返回 415", async () => {
    const s = await server();
    const response = await fetch(`http://127.0.0.1:${s.port}/api/rooms`, {
      method: "POST", headers: { "content-type": "text/plain" }, body: "{}",
    });
    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({ ok: false, error: "UNSUPPORTED_MEDIA_TYPE" });
  });

  it("37 显式白名单 Origin 可建连", async () => {
    const s = await server({ allowedOrigins: ["https://different.example"] });
    const peer = trackPeer(await Peer.open(s.port, "0000", { origin: "https://different.example" }));
    expect(peer.ws.readyState).toBe(WebSocket.OPEN);
    await peer.close();
  });

  it("38 TokenBucket 惰性 prune：清旧 key、保留活跃 key", () => {
    let clock = 1000;
    const bucket = new TokenBucket(1, 0, () => clock);
    for (let index = 0; index < 1024; index += 1) bucket.tryTake("cold-" + String(index));
    expect(bucket.size()).toBe(1024);
    clock += 11 * 60_000;
    expect(bucket.tryTake("fresh")).toBe(true);
    expect(bucket.size()).toBe(1);

    let later = 1000;
    const mixed = new TokenBucket(1, 0, () => later);
    for (let index = 0; index < 1023; index += 1) mixed.tryTake("old-" + String(index));
    later += 11 * 60_000;
    expect(mixed.tryTake("hot")).toBe(true);
    expect(mixed.tryTake("new")).toBe(true);
    expect(mixed.size()).toBe(2);
  });

  it("39 init 创建阶段抛错后 guard 配额归零，随后正常连接可加入", async () => {
    let first = true;
    const s = await server({}, {
      now: (): number => {
        if (first) { first = false; throw new Error("clock"); }
        return Date.now();
      },
    });
    const room = s.manager.createRoom();
    const client = await new Promise<WebSocket>(resolve => {
      const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws?room=${room}`);
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        resolve(ws);
      };
      timer = setTimeout(finish, 3000);
      ws.on("open", finish);
      ws.on("error", finish);
      ws.on("close", finish);
    });
    await waitFor(() => s.security.guard.stats().total === 0);
    try { client.terminate(); } catch { /* 已断开 */ }
    const peer = trackPeer(await Peer.open(s.port, room));
    peer.send({ type: "join", nickname: "甲" });
    await peer.next("joined");
    expect(s.security.guard.stats().total).toBe(1);
  });

  it("40 满房 join 走 fullJoinBucket：前 10 次 ROOM_FULL，第 11 次 RATE_LIMITED", async () => {
    const s = await server({ joinBurst: 10, joinPerMinute: 0 });
    const room = s.manager.createRoom();
    const peers: Peer[] = [];
    for (let index = 0; index < 10; index += 1) {
      const peer = await Peer.open(s.port, room);
      peers.push(trackPeer(peer));
      peer.send({ type: "join", nickname: "玩家" + String(index) });
      await peer.next("joined");
    }
    const late = trackPeer(await Peer.open(s.port, room));
    for (let attempt = 0; attempt < 10; attempt += 1) {
      late.send({ type: "join", nickname: "迟到者" });
      expect((await late.next("error")).code).toBe("ROOM_FULL");
    }
    late.send({ type: "join", nickname: "迟到者" });
    expect((await late.next("error")).code).toBe("RATE_LIMITED");
    expect(peers).toHaveLength(10);
  });

  it("41 被替换连接释放且只减一次", async () => {
    const s = await server();
    const room = s.manager.createRoom();
    const a = trackPeer(await Peer.open(s.port, room));
    a.send({ type: "join", nickname: "甲" });
    const identity = await a.next("joined");
    await waitFor(() => s.security.guard.stats().unauthenticated === 0);
    const b = trackPeer(await Peer.open(s.port, room));
    b.send({ type: "resume", roomCode: room, sessionToken: identity.sessionToken });
    await b.next("joined");
    expect((await a.next("error")).code).toBe("REPLACED");
    await waitFor(() => s.security.guard.stats().total === 1
      && s.security.guard.stats().unauthenticated === 0);
    await b.close();
    await waitFor(() => s.security.guard.stats().total === 0);
  });

  it("42 terminate 断开释放 guard 配额", async () => {
    const s = await server();
    const room = s.manager.createRoom();
    const peer = trackPeer(await Peer.open(s.port, room));
    peer.send({ type: "join", nickname: "甲" });
    await peer.next("joined");
    await waitFor(() => s.security.guard.stats().total === 1);
    peer.ws.terminate();
    await waitFor(() => s.security.guard.stats().total === 0);
  });

  it("43 WS join 昵称含控制字符被拒 INVALID_MESSAGE", async () => {
    const s = await server();
    const room = s.manager.createRoom();
    const peer = trackPeer(await Peer.open(s.port, room));
    peer.send({ type: "join", nickname: "a\u0000b" });
    expect((await peer.next("error")).code).toBe("INVALID_MESSAGE");
    expect(s.manager.getRoom(room)?.players).toHaveLength(0);
  });

  it("44 HTTP 建房昵称含控制字符 400 INVALID_NICKNAME", async () => {
    const s = await server();
    const response = await fetch(`http://127.0.0.1:${s.port}/api/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nickname: "a\u0000b" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, error: "INVALID_NICKNAME" });
  });

  it("45 空 body 建房 201，JSON 且带三安全头", async () => {
    const s = await server();
    const response = await fetch(`http://127.0.0.1:${s.port}/api/rooms`, { method: "POST" });
    expect(response.status).toBe(201);
    const body = await response.json() as Record<string, unknown>;
    expect(typeof body["roomCode"]).toBe("string");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  it("46 403/415/404/静态四类响应都带三安全头", async () => {
    const s = await server();
    const base = `http://127.0.0.1:${s.port}`;
    const responses = [
      await fetch(`${base}/api/rooms`, {
        method: "POST", headers: { "content-type": "application/json", origin: "http://evil.example" }, body: "{}",
      }),
      await fetch(`${base}/api/rooms`, {
        method: "POST", headers: { "content-type": "text/plain" }, body: "{}",
      }),
      await fetch(`${base}/api/unknown`),
      await fetch(`${base}/`),
    ];
    expect(responses.map(response => response.status)).toEqual([403, 415, 404, 200]);
    for (const response of responses) {
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
    }
  });

  it("47 WS 与 startServer 共用同一 guard/runtime", async () => {
    const s = await server();
    const room = s.manager.createRoom();
    const peer = trackPeer(await Peer.open(s.port, room));
    await waitFor(() => s.security.guard.stats().total >= 1);
    peer.send({ type: "join", nickname: "甲" });
    await peer.next("joined");
    await peer.close();
    await waitFor(() => s.security.guard.stats().total === 0);
  });

  it("48 编码 API 路径一律 404 JSON，不回退 index.html", async () => {
    const s = await server();
    const base = `http://127.0.0.1:${s.port}`;
    for (const pathname of ["/api%2Funknown", "/api%2Frooms", "/api%2funknown", "/api"]) {
      const response = await fetch(base + pathname);
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.json()).toMatchObject({ ok: false, error: "NOT_FOUND" });
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });

  it("49 握手失败只释放一次：基线连接 total 不变，60 次后 A 仍可 ready", async () => {
    const s = await server();
    const room = s.manager.createRoom();
    const a = trackPeer(await Peer.open(s.port, room));
    a.send({ type: "join", nickname: "甲" });
    await a.next("joined");
    await waitFor(() => s.security.guard.stats().total === 1
      && s.security.guard.stats().unauthenticated === 0);
    expect(s.security.guard.stats().perIp["127.0.0.1"]).toBe(1);

    // 无效握手先 admit 到 total=2，close 只减 1；若双释放会减到 0。
    expect(await rawInvalidHandshake(s.port)).toBe(400);
    await waitFor(() => {
      const stats = s.security.guard.stats();
      return stats.total === 1 && stats.unauthenticated === 0 && stats.perIp["127.0.0.1"] === 1;
    });

    for (let index = 0; index < 60; index += 1) {
      expect(await rawInvalidHandshake(s.port)).toBe(400);
    }
    await waitFor(() => {
      const stats = s.security.guard.stats();
      return stats.total === 1 && stats.unauthenticated === 0 && stats.perIp["127.0.0.1"] === 1;
    });
    expect(a.ws.readyState).toBe(WebSocket.OPEN);
    a.send({ type: "ready", ready: true });
    await a.next("room", message =>
      message.players.some((player: Record<string, unknown>) =>
        player["playerId"] === "p1" && player["ready"] === true));

    await a.close();
    await waitFor(() => s.security.guard.stats().total === 0);
  });

  it("50 心跳：autoPong 默认保活，autoPong:false 才超时关闭并释放", async () => {
    // 正段：默认 autoPong=true，每次 tick 后等 ping 到达并留 50ms 让 pong 被服务端处理。
    let keepTick: (() => void) | null = null;
    const keepServer = await server({}, {
      heartbeatClock: {
        setInterval: (callback: () => void): unknown => { keepTick = callback; return 1; },
        clearInterval: (): void => { keepTick = null; },
      },
    });
    const keepRoom = keepServer.manager.createRoom();
    const keepPeer = trackPeer(await Peer.open(keepServer.port, keepRoom));
    keepPeer.send({ type: "join", nickname: "保活" });
    await keepPeer.next("joined");
    await waitFor(() => keepServer.manager.getRoom(keepRoom)?.players[0]?.online === true
      && keepServer.security.guard.stats().total === 1);

    for (let index = 0; index < 3; index += 1) {
      const ping = new Promise<void>(resolve => keepPeer.ws.once("ping", () => resolve()));
      keepTick!();
      await ping;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(keepPeer.ws.readyState).toBe(WebSocket.OPEN);
    expect(keepServer.manager.getRoom(keepRoom)?.players[0]?.online).toBe(true);
    expect(keepServer.security.guard.stats().total).toBe(1);

    // 反段：autoPong=false，两次 ping 后第三次 tick 触发 missedPongs>=2 关闭。
    let closeTick: (() => void) | null = null;
    const closeServer = await server({}, {
      heartbeatClock: {
        setInterval: (callback: () => void): unknown => { closeTick = callback; return 1; },
        clearInterval: (): void => { closeTick = null; },
      },
    });
    const closeRoom = closeServer.manager.createRoom();
    const closePeer = trackPeer(await Peer.open(closeServer.port, closeRoom, {}, { autoPong: false }));
    closePeer.send({ type: "join", nickname: "半开" });
    await closePeer.next("joined");
    await waitFor(() => closeServer.manager.getRoom(closeRoom)?.players[0]?.online === true
      && closeServer.security.guard.stats().total === 1);

    const ping1 = new Promise<void>(resolve => closePeer.ws.once("ping", () => resolve()));
    closeTick!();
    await ping1;
    await new Promise(resolve => setTimeout(resolve, 50));
    const ping2 = new Promise<void>(resolve => closePeer.ws.once("ping", () => resolve()));
    closeTick!();
    await ping2;
    await new Promise(resolve => setTimeout(resolve, 50));
    const closed = waitForClose(closePeer.ws, 1500);
    closeTick!();
    await closed;
    await waitFor(() => closeServer.security.guard.stats().total === 0);
    await waitFor(() => closeServer.manager.getRoom(closeRoom)?.players[0]?.online === false);
    expect(closeServer.manager.getRoom(closeRoom)?.players).toHaveLength(1);
  });
});
