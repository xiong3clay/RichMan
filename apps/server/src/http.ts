import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SERVER_DEFAULTS, PROTOCOL_VERSION, NicknameSchema } from "@richman/shared";
import { RoomManager } from "./rooms/manager.js";
import { attachLobbyWebSocket } from "./ws.js";
import type { LobbyWsOptions } from './ws.js';
import {
  clientIp,
  createSecurityRuntime,
  isAllowedOrigin,
  loadSecurityLimits,
} from "./security.js";
import type { SecurityOverrides, SecurityRuntime } from "./security.js";
import { FileRoomStore } from './storage/file-store.js';
import { loadAllRooms } from './rooms/recovery.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_STATIC_DIR = path.resolve(HERE, "../../../apps/web/dist");
const VERSION = "1.0.1"; // 发布版本：与根 package.json、CHANGELOG 同步

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".txt": "text/plain; charset=utf-8",
};

export interface ServerOptions {
  /** 嵌入API缺省内存；CLI显式传默认目录，测试传临时目录。 */
  dataDir?: string;
  store?: FileRoomStore;
  wsOptions?: LobbyWsOptions;
  host?: string;
  port?: number;
  staticDir?: string;
  startedAt?: number;
  manager?: RoomManager;
  /** /health 的实时计数，缺省返回 0/0。 */
  stats?: () => { connections: number; rooms: number };
  /** 09A：测试可注入小阈值；缺省 loadSecurityLimits(process.env)。 */
  security?: SecurityOverrides;
}

export interface StartedServer {
  server: http.Server;
  host: string;
  port: number;
  manager: RoomManager;
  security: SecurityRuntime;
  connections: () => number;
  close: () => Promise<void>;
}

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
} as const;

function withSecurityHeaders(headers: http.OutgoingHttpHeaders = {}): http.OutgoingHttpHeaders {
  return { ...SECURITY_HEADERS, ...headers };
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, withSecurityHeaders({
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  }));
  res.end(text);
}

function readBodyText(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > SERVER_DEFAULTS.maxMessageBytes) {
        reject(new Error("PAYLOAD_TOO_LARGE"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** 同源建房入口：POST /api/rooms，body 为 {} 或 {"nickname": "..."}，返回 4～8 位房间码。 */
async function handleCreateRoom(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  manager: RoomManager,
  security: SecurityRuntime,
): Promise<void> {
  if (!isAllowedOrigin(req.headers.origin, req.headers.host, security.limits.allowedOrigins)) {
    sendJson(res, 403, { ok: false, error: "ORIGIN_NOT_ALLOWED" });
    return;
  }
  try {
    const text = await readBodyText(req);
    const trimmed = text.trim();
    const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
    if (trimmed !== "" && !contentType.startsWith("application/json")) {
      sendJson(res, 415, { ok: false, error: "UNSUPPORTED_MEDIA_TYPE" });
      return;
    }
    let body: unknown = {};
    if (trimmed !== "") {
      try { body = JSON.parse(trimmed); } catch {
        sendJson(res, 400, { ok: false, error: "BAD_REQUEST" });
        return;
      }
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      sendJson(res, 400, { ok: false, error: "BAD_REQUEST" });
      return;
    }
    const nickname = (body as Record<string, unknown>)["nickname"];
    if (nickname !== undefined && !NicknameSchema.safeParse(nickname).success) {
      sendJson(res, 400, { ok: false, error: "INVALID_NICKNAME" });
      return;
    }
    const ip = clientIp(req, security.limits);
    if (!security.createRoomBucket.tryTake(ip)) {
      sendJson(res, 429, { ok: false, error: "RATE_LIMITED" });
      return;
    }
    if (manager.roomCount() >= security.limits.maxRooms) {
      sendJson(res, 503, { ok: false, error: "ROOM_LIMIT" });
      return;
    }
    sendJson(res, 201, { ok: true, roomCode: await manager.createRoomPersisted() });
  } catch (error) {
    const message = (error as Error).message;
    if ((error as {code?: string}).code === 'ERROR_PAUSED') { sendJson(res, 503, { ok: false, error: 'ERROR_PAUSED' }); return; }
    if (message === "PAYLOAD_TOO_LARGE") {
      sendJson(res, 413, { ok: false, error: "PAYLOAD_TOO_LARGE" });
      return;
    }
    sendJson(res, 400, { ok: false, error: "BAD_REQUEST" });
  }
}

function serveStatic(
  res: http.ServerResponse,
  requested: string,
  staticDir: string,
  rangeHeader?: string,
): void {
  const relative = requested === "/" ? "index.html" : requested.replace(/^\/+/, "");
  const baseDir = path.resolve(staticDir);
  const filePath = path.resolve(baseDir, relative);
  const relToBase = path.relative(baseDir, filePath);
  if (relToBase.startsWith("..") || path.isAbsolute(relToBase)) {
    sendJson(res, 403, { ok: false, error: "FORBIDDEN" });
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (relative !== "index.html") {
        // SPA 回退：非资源路径返回 index.html
        if (!path.extname(relative)) {
          fs.readFile(path.join(staticDir, "index.html"), (err2, html) => {
            if (err2) sendJson(res, 404, { ok: false, error: "NOT_FOUND", hint: "尚未构建前端：先运行 pnpm build" });
            else {
              res.writeHead(200, withSecurityHeaders({ "content-type": MIME[".html"] ?? "text/html; charset=utf-8" }));
              res.end(html);
            }
          });
          return;
        }
      }
      sendJson(res, 404, { ok: false, error: "NOT_FOUND", hint: "尚未构建前端：先运行 pnpm build" });
      return;
    }
    const contentType = MIME[path.extname(filePath)] ?? "application/octet-stream";
    // iOS Safari 对 <audio> 通常先发 Range 请求；不支持 206 时应答 200 全量。
    const match = rangeHeader === undefined ? null : /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (match !== null && data.length > 0) {
      const rawStart = match[1] === "" ? NaN : Number(match[1]);
      const rawEnd = match[2] === "" ? NaN : Number(match[2]);
      let start = Number.isNaN(rawStart) ? 0 : rawStart;
      let end = Number.isNaN(rawEnd) ? data.length - 1 : rawEnd;
      if (start <= end && start < data.length) {
        end = Math.min(end, data.length - 1);
        const chunk = data.subarray(start, end + 1);
        res.writeHead(206, withSecurityHeaders({
          "content-type": contentType,
          "accept-ranges": "bytes",
          "content-range": `bytes ${start}-${end}/${data.length}`,
          "content-length": String(chunk.length),
        }));
        res.end(chunk);
        return;
      }
      res.writeHead(416, withSecurityHeaders({
        "content-type": "text/plain; charset=utf-8",
        "accept-ranges": "bytes",
        "content-range": `bytes */${data.length}`,
      }));
      res.end("RANGE_NOT_SATISFIABLE");
      return;
    }
    res.writeHead(200, withSecurityHeaders({
      "content-type": contentType,
      "accept-ranges": "bytes",
      "content-length": String(data.length),
    }));
    res.end(data);
  });
}

export function createRequestHandler(opts: ServerOptions = {}): http.RequestListener {
  const staticDir = opts.staticDir ?? DEFAULT_STATIC_DIR;
  const startedAt = opts.startedAt ?? Date.now();
  const manager = opts.manager ?? new RoomManager();
  const stats = opts.stats ?? (() => ({ connections: 0, rooms: 0 }));
  const limits = opts.security?.limits ?? loadSecurityLimits(process.env);
  const security = createSecurityRuntime(limits, opts.wsOptions?.now ?? (() => Date.now()), opts.security);
  return (req, res) => {
    let url: URL;
    let decodedPath: string;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
      decodedPath = decodeURIComponent(url.pathname);
    } catch {
      sendJson(res, 400, { ok: false, error: "BAD_REQUEST" });
      return;
    }
    if (decodedPath.includes("\0")) {
      sendJson(res, 400, { ok: false, error: "BAD_REQUEST" });
      return;
    }
    // 编码路径不得别名到 API 路由（如 /api%2Frooms 解码后看似 /api/rooms）；
    // API 命名空间只接受原样路径，否则一律 JSON 404，绝不回退 index.html。
    const apiNamespace = decodedPath === "/api" || decodedPath.startsWith("/api/");
    if (apiNamespace && url.pathname !== decodedPath) {
      sendJson(res, 404, { ok: false, error: "NOT_FOUND" });
      return;
    }
    if (req.method === "GET" && decodedPath === "/health") {
      const counts = stats();
      sendJson(res, 200, {
        ok: true,
        service: "richman",
        version: VERSION,
        protocolVersion: PROTOCOL_VERSION,
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
        connections: counts.connections,
        rooms: counts.rooms,
        serverNow: new Date().toISOString(),
      });
      return;
    }
    if (req.method === "POST" && decodedPath === "/api/rooms") {
      void handleCreateRoom(req, res, manager, security);
      return;
    }
    if (req.method === 'GET' && decodedPath === '/api/rooms') {
      sendJson(res, 200, { rooms: manager.roomCodes().map(roomCode => {
        const room = manager.getRoom(roomCode)!;
        return { roomCode, state: room.state, paused: room.paused, playerCount: room.players.length };
      }) }); return;
    }
    if (decodedPath === "/api" || decodedPath.startsWith("/api/")) {
      sendJson(res, 404, { ok: false, error: "NOT_FOUND" });
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });
      return;
    }
    serveStatic(res, decodedPath, staticDir, req.headers.range);
  };
}

export async function startServer(opts: ServerOptions = {}): Promise<StartedServer> {
  const host = opts.host ?? SERVER_DEFAULTS.host;
  const port = opts.port ?? Number(process.env["PORT"] ?? SERVER_DEFAULTS.port);
  const manager = opts.manager ?? new RoomManager();
  const store = opts.store ?? (opts.dataDir ? new FileRoomStore(opts.dataDir) : null);
  if (store) await loadAllRooms(store, manager);
  let runtime: ReturnType<typeof attachLobbyWebSocket> | null = null;
  const stats =
    opts.stats ??
    (() => ({
      connections: runtime?.connections() ?? 0,
      rooms: manager.roomCount(),
    }));
  const limits = opts.security?.limits ?? loadSecurityLimits(process.env);
  const security = createSecurityRuntime(limits, opts.wsOptions?.now ?? (() => Date.now()), opts.security);
  const server = http.createServer(createRequestHandler({ ...opts, manager, stats, security }));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  runtime = attachLobbyWebSocket(server, manager, { ...opts.wsOptions, security });
  const address = server.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : port;
  const wsRuntime = runtime;
  return {
    server,
    host,
    port: actualPort,
    manager,
    security,
    connections: () => wsRuntime.connections(),
    close: async () => {
      await wsRuntime.close();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

function lanAddresses(): string[] {
  const result: string[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) result.push(entry.address);
    }
  }
  return result;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  startServer({
    dataDir: process.env['RICHMAN_DATA_DIR'] ?? path.resolve(HERE, '../data'),
    staticDir: process.env['RICHMAN_STATIC_DIR'],
  })
    .then((started) => {
      console.log("[richman] 服务已启动，监听 " + started.host + ":" + started.port);
      console.log("[richman] 本机： http://localhost:" + started.port + "/");
      for (const ip of lanAddresses()) console.log("[richman] 局域网： http://" + ip + ":" + started.port + "/");
      console.log("[richman] 健康检查： /health");
    })
    .catch((err) => {
      console.error("[richman] 启动失败：" + (err as Error).message);
      process.exit(1);
    });
}
