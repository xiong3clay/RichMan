import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, closeSync, openSync, readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const onWindows = process.platform === "win32";
const root = process.cwd();
const scriptsDir = path.join(root, "scripts");
const testDir = path.join(root, "apps/server/tests");

const tempDirs: string[] = [];
const children: ChildProcess[] = [];
async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "richman-scripts-"));
  tempDirs.push(dir);
  return dir;
}

async function killAndWait(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
  const started = Date.now();
  while (child.exitCode === null && child.signalCode === null) {
    if (Date.now() - started > 10000) {
      throw new Error("子进程未在 10 秒内退出: " + String(child.pid));
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function killPidAndWait(pid: number): Promise<void> {
  try { process.kill(pid, "SIGKILL"); } catch { return; }
  await waitFor(() => {
    try { process.kill(pid, 0); return false; } catch { return true; }
  }, 10000);
}

async function rmDirWithRetry(dir: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  throw new Error("清理临时目录失败（已重试 3 次）: " + dir + " : " + String(lastError));
}

afterEach(async () => {
  for (const child of children.splice(0)) await killAndWait(child);
  for (const dir of tempDirs.splice(0)) await rmDirWithRetry(dir);
});

interface RunResult {
  status: number | null;
  json: Record<string, any> | null;
  stdout: string;
  stderr: string;
}

function toRunResult(status: number | null, stdoutRaw: string | null, stderrRaw: string | null): RunResult {
  const stdout = stdoutRaw ?? "";
  const stderr = stderrRaw ?? "";
  const lines = stdout
    .split(/\r?\n/)
    .map(line => line.replace(/^\uFEFF/, "").trim())
    .filter(line => line.length > 0);
  let json: Record<string, any> | null = null;
  if (lines.length > 0) {
    try { json = JSON.parse(lines[lines.length - 1]!) as Record<string, any>; }
    catch { json = null; }
  }
  return { status, json, stdout, stderr };
}

function runScript(name: string, args: string[] = []): RunResult {
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(scriptsDir, name), ...args],
    { cwd: root, encoding: "utf8", timeout: 60000, windowsHide: true },
  );
  return toRunResult(result.status, result.stdout, result.stderr);
}

function runPowerShellCommand(command: string): RunResult {
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
    { cwd: root, encoding: "utf8", timeout: 60000, windowsHide: true },
  );
  return toRunResult(result.status, result.stdout, result.stderr);
}

// 会拉起常驻子进程的脚本必须把 PowerShell 的 stdout/stderr 重定向到文件，
// 否则子进程会继承管道句柄，spawnSync 会一直等到服务退出（Qoder E3）。
function runScriptToFile(name: string, args: string[], dir: string): RunResult {
  const stamp = String(Date.now()) + "-" + String(Math.random()).slice(2);
  const outFile = path.join(dir, ".run-" + stamp + ".out");
  const errFile = path.join(dir, ".run-" + stamp + ".err");
  const outFd = openSync(outFile, "w");
  const errFd = openSync(errFile, "w");
  try {
    const result = spawnSync(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(scriptsDir, name), ...args],
      { cwd: root, stdio: ["ignore", outFd, errFd], timeout: 60000, windowsHide: true },
    );
    return toRunResult(result.status, readFileSync(outFile, "utf8"), readFileSync(errFile, "utf8"));
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
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

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10000): Promise<void> {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started >= timeoutMs) throw new Error("等待条件超时");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function getStartTime(pid: number): string {
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`],
    { encoding: "utf8", timeout: 30000, windowsHide: true },
  );
  return (result.stdout ?? "").trim();
}

async function writeState(
  dir: string,
  kind: "server" | "tunnel",
  value: Record<string, unknown>,
): Promise<string> {
  const runDir = path.join(dir, "run");
  await mkdir(runDir, { recursive: true });
  const filePath = path.join(runDir, kind + ".json");
  await writeFile(filePath, JSON.stringify(value), "utf8");
  return filePath;
}

function spawnNode(args: string[]): ChildProcess {
  const child = spawn(process.execPath, args, { stdio: "ignore", windowsHide: true });
  children.push(child);
  return child;
}

function portOpen(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const client = net.connect(port, "127.0.0.1");
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      try { client.destroy(); } catch { /* 已关闭 */ }
      resolve(value);
    };
    client.once("connect", () => finish(true));
    client.once("error", () => finish(false));
  });
}

function richmanHttpPids(): number[] {
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*apps/server/src/http.ts*' } | Select-Object -ExpandProperty ProcessId"],
    { encoding: "utf8", timeout: 30000, windowsHide: true },
  );
  return (result.stdout ?? "")
    .split(/\r?\n/)
    .map(line => Number(line.trim()))
    .filter(value => Number.isInteger(value) && value > 0);
}

function psQuote(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

function spawnRichmanHealth(port: number): ChildProcess {
  const code = "require('http').createServer((req,res)=>{"
    + "res.writeHead(200,{'content-type':'application/json'});"
    + "res.end(JSON.stringify({ok:true,service:'richman',rooms:0,connections:0}));"
    + "}).listen(" + String(port) + ",'127.0.0.1');";
  return spawnNode(["-e", code]);
}

async function waitHealthReady(port: number): Promise<void> {
  await waitFor(async () => {
    try {
      const response = await fetch("http://127.0.0.1:" + String(port) + "/health");
      const body = await response.json() as Record<string, unknown>;
      return response.status === 200 && body["ok"] === true && body["service"] === "richman";
    } catch {
      return false;
    }
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
        expect(text).toMatch(/^(?:\[CmdletBinding\(\)\]\s*)?param\(/);
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

  it("6 无关 node + 旧启动时间：stop 不杀、exit 2、保留状态", async () => {
    const dir = await makeTempDir();
    const dummy = spawnNode(["-e", "setTimeout(()=>{},120000)"]);
    expect(dummy.pid).toBeTruthy();
    await waitFor(() => { try { process.kill(dummy.pid!, 0); return true; } catch { return false; } });
    expect(getStartTime(dummy.pid!).length).toBeGreaterThan(0);
    const statePath = await writeState(dir, "server", {
      pid: dummy.pid,
      startedAtUtc: "2020-01-01T00:00:00.0000000Z",
      port: 19999,
    });
    const result = runScript("stop.ps1", ["-DataDir", dir]);
    expect(result.status, failureMessage(result)).toBe(2);
    expect(existsSync(statePath)).toBe(true);
    expect(() => process.kill(dummy.pid!, 0)).not.toThrow();
    expect(result.stdout).toMatch(/不匹配|复用/);
  }, 60000);

  it("7 start-tunnel 认 -DataDir，stop 停掉同目录假 cloudflared", async () => {
    const dirA = await makeTempDir();
    const dirB = await makeTempDir();
    const fakePath = path.join(dirA, "cloudflared.exe");
    await copyFile(process.execPath, fakePath);
    const fake = spawn(fakePath, ["-e", "setTimeout(()=>{},120000)"], { stdio: "ignore", windowsHide: true });
    children.push(fake);
    try {
      await waitFor(() => { try { process.kill(fake.pid!, 0); return true; } catch { return false; } });
      const startedAtUtc = getStartTime(fake.pid!);
      await writeState(dirA, "tunnel", {
        pid: fake.pid,
        startedAtUtc,
        url: "https://probe.trycloudflare.com",
        port: await freePort(),
      });
      const port = await freePort();
      const checkA = runScript("start-tunnel.ps1", ["-CheckOnly", "-Port", String(port), "-DataDir", dirA]);
      expect(checkA.json?.alreadyRunning?.running, failureMessage(checkA)).toBe(true);
      expect(checkA.json?.reason).toBe("ALREADY_RUNNING");
      const checkB = runScript("start-tunnel.ps1", ["-CheckOnly", "-Port", String(port), "-DataDir", dirB]);
      expect(checkB.json?.alreadyRunning?.running, failureMessage(checkB)).toBe(false);
      const stop = runScript("stop.ps1", ["-DataDir", dirA]);
      expect(stop.status, failureMessage(stop)).toBe(0);
      await waitFor(() => { try { process.kill(fake.pid!, 0); return false; } catch { return true; } });
      expect(existsSync(path.join(dirA, "run", "tunnel.json"))).toBe(false);
    } finally {
      await killAndWait(fake);
    }
  }, 60000);

  it("8 普通 HTTP 200 JSON 不被当成 RichMan", async () => {
    const dir = await makeTempDir();
    const port = await freePort();
    const serverCode = "require('http').createServer((req,res)=>{"
      + "res.writeHead(200,{'content-type':'application/json'});"
      + "res.end('{\"hello\":\"world\"}');"
      + "}).listen(" + String(port) + ",'127.0.0.1');";
    const fake = spawnNode(["-e", serverCode]);
    await waitFor(async () => {
      try { return (await fetch("http://127.0.0.1:" + String(port) + "/health")).status === 200; }
      catch { return false; }
    });
    await writeState(dir, "server", {
      pid: fake.pid,
      startedAtUtc: getStartTime(fake.pid!),
      port,
    });
    const otherPort = await freePort();
    const check = runScript("start-lan.ps1", ["-CheckOnly", "-Port", String(otherPort), "-DataDir", dir]);
    expect(check.json?.checks?.alreadyRunning?.running, failureMessage(check)).toBe(false);
    const status = runScript("status.ps1", ["-Json", "-Port", String(port), "-DataDir", dir]);
    expect(status.status, failureMessage(status)).toBe(1);
    expect(status.json?.server?.ok).toBe(false);
  }, 60000);

  it("9 状态目录写入失败时回收本次子进程、端口释放", async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, "run"), "blocked", "utf8");
    const port = await freePort();
    const before = richmanHttpPids();
    try {
      const result = runScriptToFile("start-lan.ps1", ["-Port", String(port), "-DataDir", dir, "-TimeoutSec", "40"], dir);
      expect(result.status, failureMessage(result)).toBe(1);
      expect(result.stdout).toMatch(/失败|无法/);
      await waitFor(async () => !(await portOpen(port)));
      await waitFor(() => richmanHttpPids().every(pid => before.includes(pid)), 15000);
    } finally {
      // 只回收本测试启动后新增的 http.ts 进程，用户已有的服务不受影响。
      for (const pid of richmanHttpPids()) {
        if (!before.includes(pid)) await killPidAndWait(pid);
      }
    }
  }, 60000);

  it("10 坏 JSON 状态文件：stop exit 2、保留文件、不杀进程", async () => {
    const dir = await makeTempDir();
    const dummy = spawnNode(["-e", "setTimeout(()=>{},120000)"]);
    await waitFor(() => { try { process.kill(dummy.pid!, 0); return true; } catch { return false; } });
    const runDir = path.join(dir, "run");
    await mkdir(runDir, { recursive: true });
    const statePath = path.join(runDir, "server.json");
    await writeFile(statePath, "{not valid json", "utf8");
    const result = runScript("stop.ps1", ["-DataDir", dir]);
    expect(result.status, failureMessage(result)).toBe(2);
    expect(existsSync(statePath)).toBe(true);
    expect(() => process.kill(dummy.pid!, 0)).not.toThrow();
    expect(result.stdout).toMatch(/无法解析|损坏/);
  }, 60000);

  it("11 未知参数必须报错", () => {
    const result = runScript("start-lan.ps1", ["-CheckOnly", "-Nope", "1"]);
    expect(result.status, failureMessage(result)).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/Nope|parameter/i);
  }, 60000);

  it("12 完整生命周期：status 默认端口 + stop planned port + 端口释放", async () => {
    const dir = await makeTempDir();
    const port = await freePort();
    try {
      const start = runScriptToFile("start-lan.ps1", ["-Port", String(port), "-DataDir", dir], dir);
      expect(start.status, failureMessage(start)).toBe(0);
      const status = runScript("status.ps1", ["-Json", "-DataDir", dir]);
      expect(status.status, failureMessage(status)).toBe(0);
      expect(status.json?.ok).toBe(true);
      expect(status.json?.port).toBe(port);
      const plan = runScript("stop.ps1", ["-CheckOnly", "-DataDir", dir]);
      expect(plan.status, failureMessage(plan)).toBe(0);
      expect(plan.json?.planned?.[0]?.port).toBe(port);
      const stop = runScript("stop.ps1", ["-DataDir", dir]);
      expect(stop.status, failureMessage(stop)).toBe(0);
      await waitFor(async () => !(await portOpen(port)));
    } finally {
      runScript("stop.ps1", ["-DataDir", dir]);
    }
  }, 60000);

  it("13 Stop-Process 失败必须 STOP_FAILED exit 2 且保留状态", async () => {
    const dir = await makeTempDir();
    const dummy = spawnNode(["-e", "setTimeout(()=>{},120000)"]);
    await waitFor(() => { try { process.kill(dummy.pid!, 0); return true; } catch { return false; } });
    const statePath = await writeState(dir, "server", {
      pid: dummy.pid,
      startedAtUtc: getStartTime(dummy.pid!),
      port: 19999,
    });
    const stopPath = path.join(scriptsDir, "stop.ps1");
    const command = "function Stop-Process { throw 'ACCESS_DENIED_TEST' }; & "
      + psQuote(stopPath) + " -DataDir " + psQuote(dir) + "; exit $LASTEXITCODE";
    const result = runPowerShellCommand(command);
    expect(result.status, failureMessage(result)).toBe(2);
    expect(result.json?.ok, failureMessage(result)).toBe(false);
    expect(result.json?.reason).toBe("STOP_FAILED");
    expect(result.stdout).not.toContain("已全部停止");
    expect(existsSync(statePath)).toBe(true);
    expect(() => process.kill(dummy.pid!, 0)).not.toThrow();
  }, 60000);

  it("14 stale 状态仍探测健康：stateNote=stale、exit 0", async () => {
    const dir = await makeTempDir();
    const port = await freePort();
    spawnRichmanHealth(port);
    await waitHealthReady(port);
    await writeState(dir, "server", {
      pid: 999999,
      startedAtUtc: "2020-01-01T00:00:00.0000000Z",
      port,
    });
    const status = runScript("status.ps1", ["-Json", "-Port", String(port), "-DataDir", dir]);
    expect(status.status, failureMessage(status)).toBe(0);
    expect(status.json?.ok).toBe(true);
    expect(status.json?.server?.ok).toBe(true);
    expect(status.json?.server?.stateNote).toBe("stale");
    expect(status.json?.server?.reason).toBe("");
  }, 60000);

  it("15 坏 JSON + 健康服务：stateNote=broken、exit 0", async () => {
    const dir = await makeTempDir();
    const port = await freePort();
    spawnRichmanHealth(port);
    await waitHealthReady(port);
    const runDir = path.join(dir, "run");
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, "server.json"), "{not valid json", "utf8");
    const status = runScript("status.ps1", ["-Json", "-Port", String(port), "-DataDir", dir]);
    expect(status.status, failureMessage(status)).toBe(0);
    expect(status.json?.ok).toBe(true);
    expect(status.json?.server?.ok).toBe(true);
    expect(status.json?.server?.stateNote).toBe("broken");
    expect(status.json?.server?.reason).toBe("");
  }, 60000);
});
