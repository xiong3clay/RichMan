import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SERVER_DEFAULTS, PROTOCOL_VERSION } from "@richman/shared";

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
  host?: string;
  port?: number;
  staticDir?: string;
  startedAt?: number;
}

export interface StartedServer {
  server: http.Server;
  host: string;
  port: number;
  close: () => Promise<void>;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
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
      sendJson(res, 200, {
        ok: true,
        service: "richman",
        version: VERSION,
        protocolVersion: PROTOCOL_VERSION,
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
        connections: 0,
        rooms: 0,
        serverNow: new Date().toISOString(),
      });
      return;
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
  const server = http.createServer(createRequestHandler(opts));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : port;
  return {
    server,
    host,
    port: actualPort,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
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
  startServer()
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
