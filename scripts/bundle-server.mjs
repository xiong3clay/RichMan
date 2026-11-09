#!/usr/bin/env node
import { build } from "vite";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(scriptDir);
const alias = {
  "@richman/shared": path.join(repoRoot, "packages/shared/src/index.ts"),
  "@richman/game-core": path.join(repoRoot, "packages/game-core/src/index.ts"),
};

function fail(message) {
  console.error("bundle-server 失败：" + message);
  process.exit(1);
}

function parseOut(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out" || arg === "-Out") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) return null;
      return value;
    }
    if (arg.startsWith("--out=")) {
      const value = arg.slice("--out=".length);
      if (value.length > 0) return value;
    }
  }
  return null;
}

async function bundle(entry, fileName, outDir) {
  await build({
    configFile: false,
    root: repoRoot,
    logLevel: "warn",
    resolve: { alias },
    ssr: { noExternal: true },
    build: {
      ssr: entry,
      outDir,
      emptyOutDir: false,
      rollupOptions: {
        output: { entryFileNames: fileName },
      },
    },
  });
}

function validateFile(file, label) {
  if (!existsSync(file)) fail(label + " 不存在：" + file);
  const bytes = statSync(file).size;
  if (bytes <= 50 * 1024) fail(label + " 小于 50KB：" + String(bytes) + " 字节");
  return bytes;
}

function assertNoTsxRuntime(file) {
  const text = readFileSync(file, "utf8");
  if (/(?:from\s*["']tsx["']|require\s*\(\s*["']tsx["']\s*\)|--import\s+tsx)/.test(text)) {
    fail(path.basename(file) + " 仍依赖 tsx 运行时");
  }
  return text;
}

async function main() {
  const outArg = parseOut(process.argv.slice(2));
  if (outArg === null) fail("缺少参数：--out <输出目录>");
  const outDir = path.resolve(outArg);

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const serverEntry = path.join(repoRoot, "apps/server/src/http.ts");
  const backupEntry = path.join(repoRoot, "apps/server/src/storage/backup-cli.ts");
  await bundle(serverEntry, "server.mjs", outDir);
  await bundle(backupEntry, "backup-cli.mjs", outDir);

  const serverFile = path.join(outDir, "server.mjs");
  const backupFile = path.join(outDir, "backup-cli.mjs");
  const serverBytes = validateFile(serverFile, "server.mjs");
  const backupBytes = validateFile(backupFile, "backup-cli.mjs");
  const serverText = assertNoTsxRuntime(serverFile);
  assertNoTsxRuntime(backupFile);
  if (!/Sec-WebSocket-Key|WebSocketServer/.test(serverText)) {
    fail("server.mjs 未包含 Sec-WebSocket-Key/WebSocketServer，ws 可能未内联");
  }

  console.log(JSON.stringify({
    ok: true,
    out: outDir,
    server: { file: serverFile, bytes: serverBytes },
    backupCli: { file: backupFile, bytes: backupBytes },
  }));
}

main().catch(error => {
  console.error("bundle-server 失败：" + (error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
