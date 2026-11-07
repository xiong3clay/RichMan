import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const onWindows = process.platform === "win32";
const root = process.cwd();
const scriptsDir = path.join(root, "scripts");
const testDir = path.join(root, "apps/server/tests");

const tempDirs: string[] = [];
async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "richman-scripts-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface RunResult {
  status: number | null;
  json: Record<string, any> | null;
  stdout: string;
  stderr: string;
}

function runScript(name: string, args: string[] = []): RunResult {
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(scriptsDir, name), ...args],
    { cwd: root, encoding: "utf8", timeout: 30000, windowsHide: true },
  );
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const lines = stdout
    .split(/\r?\n/)
    .map(line => line.replace(/^\uFEFF/, "").trim())
    .filter(line => line.length > 0);
  let json: Record<string, any> | null = null;
  if (lines.length > 0) {
    try { json = JSON.parse(lines[lines.length - 1]!) as Record<string, any>; }
    catch { json = null; }
  }
  return { status: result.status, json, stdout, stderr };
}

function failureMessage(result: RunResult): string {
  return "\nSTDOUT:\n" + result.stdout + "\nSTDERR:\n" + result.stderr;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as net.AddressInfo;
      server.close(() => resolve(address.port));
    });
  });
}

function occupyPort(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as net.AddressInfo;
      resolve({
        port: address.port,
        close: () => new Promise<void>(done => { server.close(() => done()); }),
      });
    });
  });
}

describe.skipIf(!onWindows)("09B scripts", () => {
  it("1 六个脚本文件存在、ps1 为 UTF-8 BOM，入口脚本以 param( 开头", async () => {
    expect(existsSync(path.join(testDir, "scripts.test.ts"))).toBe(true);
    for (const name of ["richman-common.ps1", "start-lan.ps1", "start-tunnel.ps1", "stop.ps1", "status.ps1"]) {
      const filePath = path.join(scriptsDir, name);
      expect(existsSync(filePath)).toBe(true);
      const buffer = await readFile(filePath);
      expect(buffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(true);
      const text = buffer.toString("utf8").replace(/^\uFEFF/, "").trimStart();
      if (name !== "richman-common.ps1") {
        expect(text.startsWith("param(")).toBe(true);
      }
    }
  });

  it("2 start-lan -CheckOnly 空闲端口与临时数据目录 ok=true", async () => {
    const port = await freePort();
    const dir = await makeTempDir();
    const result = runScript("start-lan.ps1", ["-CheckOnly", "-Port", String(port), "-DataDir", dir]);
    expect(result.status, failureMessage(result)).toBe(0);
    expect(result.json, failureMessage(result)).toMatchObject({
      ok: true,
      checks: {
        node: { ok: true },
        webDist: { ok: true },
        port: { available: true },
        dataDir: { ok: true },
      },
    });
  });

  it("3 start-lan -CheckOnly 端口被占用时 ok=false、PORT_IN_USE、退出码 1", async () => {
    const occupied = await occupyPort();
    try {
      const dir = await makeTempDir();
      const result = runScript("start-lan.ps1", ["-CheckOnly", "-Port", String(occupied.port), "-DataDir", dir]);
      expect(result.status, failureMessage(result)).toBe(1);
      expect(result.json, failureMessage(result)).toMatchObject({ ok: false, reason: "PORT_IN_USE" });
    } finally {
      await occupied.close();
    }
  });

  it("4 stop -CheckOnly 空数据目录 ok=true、退出码 0、不创建 run 目录", async () => {
    const dir = await makeTempDir();
    const result = runScript("stop.ps1", ["-CheckOnly", "-DataDir", dir]);
    expect(result.status, failureMessage(result)).toBe(0);
    expect(result.json, failureMessage(result)).toMatchObject({ ok: true });
    expect(existsSync(path.join(dir, "run"))).toBe(false);
  });

  it("5 status -CheckOnly -Json 无服务时 ok=false、退出码 1 且不挂起", async () => {
    const port = await freePort();
    const dir = await makeTempDir();
    const result = runScript("status.ps1", ["-CheckOnly", "-Json", "-Port", String(port), "-DataDir", dir]);
    expect(result.status, failureMessage(result)).toBe(1);
    expect(result.json, failureMessage(result)).toMatchObject({ ok: false, server: { ok: false } });
  });
});
