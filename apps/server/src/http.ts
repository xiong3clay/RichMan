import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SERVER_DEFAULTS, PROTOCOL_VERSION, NicknameSchema } from "@richman/shared";
import { RoomManager } from "./rooms/manager.js";
import { attachLobbyWebSocket } from "./ws.js";
import type { LobbyWsOptions } from './ws.js';
import { FileRoomStore } from './storage/file-store.js';
import { loadAllRooms } from './rooms/recovery.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_STATIC_DIR = path.resolve(HERE, "../../../apps/web/dist");
const VERSION = "0.0.0";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
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
}

export interface StartedServer {
  server: http.Server;
  host: string;
  port: number;
  manager: RoomManager;
  connections: () => number;
  close: () => Promise<void>;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
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
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (text === "") {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("BAD_REQUEST"));
      }
    });
    req.on("error", reject);
  });
}

/** 同源建房入口：POST /api/rooms，body 为 {} 或 {"nickname": "..."}，返回 4～8 位房间码。 */
async function handleCreateRoom(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  manager: RoomManager,
): Promise<void> {
  try {
    const body = await readJsonBody(req);
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      sendJson(res, 400, { ok: false, error: "BAD_REQUEST" });
      return;
    }
    const nickname = (body as Record<string, unknown>)["nickname"];
    if (nickname !== undefined && !NicknameSchema.safeParse(nickname).success) {
      sendJson(res, 400, { ok: false, error: "INVALID_NICKNAME" });
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

function serveStatic(res: http.ServerResponse, requested: string, staticDir: string): void {
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
              res.writeHead(200, { "content-type": MIME[".html"] ?? "text/html; charset=utf-8" });
              res.end(html);
            }
          });
          return;
        }
      }
      sendJson(res, 404, { ok: false, error: "NOT_FOUND", hint: "尚未构建前端：先运行 pnpm build" });
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(filePath)] ?? "application/octet-stream" });
    res.end(data);
  });
}

export function createRequestHandler(opts: ServerOptions = {}): http.RequestListener {
  const staticDir = opts.staticDir ?? DEFAULT_STATIC_DIR;
  const startedAt = opts.startedAt ?? Date.now();
  const manager = opts.manager ?? new RoomManager();
  const stats = opts.stats ?? (() => ({ connections: 0, rooms: 0 }));
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
    if (req.method === "GET" && url.pathname === "/health") {
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
    if (req.method === "POST" && url.pathname === "/api/rooms") {
      void handleCreateRoom(req, res, manager);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/rooms') {
      sendJson(res, 200, { rooms: manager.roomCodes().map(roomCode => {
        const room = manager.getRoom(roomCode)!;
        return { roomCode, state: room.state, paused: room.paused, playerCount: room.players.length };
      }) }); return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });
      return;
    }
    serveStatic(res, decodedPath, staticDir);
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
  const server = http.createServer(createRequestHandler({ ...opts, manager, stats }));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  runtime = attachLobbyWebSocket(server, manager, opts.wsOptions);
  const address = server.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : port;
  const wsRuntime = runtime;
  return {
    server,
    host,
    port: actualPort,
    manager,
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
  startServer({ dataDir: process.env['RICHMAN_DATA_DIR'] ?? path.resolve(HERE, '../data') })
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
