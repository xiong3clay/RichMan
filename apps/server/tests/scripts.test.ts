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
  }, 20000);

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

// 09C-B: append-only T16–T22; 09B T1–T15 above remain byte-for-byte unchanged.
async function backupScriptFixture(): Promise<{ data: string; out: string; code: string; bytes: Buffer }> {
  const data = await makeTempDir();
  const out = path.join(await makeTempDir(), 'richman-backup-fixture');
  const code = '0042';
  const { FileRoomStore } = await import('../src/storage/file-store.js');
  const { RULES_VERSION } = await import('@richman/game-core');
  const { PROTOCOL_VERSION } = await import('@richman/shared');
  const players = [{ playerId:'p1',seatId:1,nickname:'脚本验收',ready:false,online:false,tokenDigest:'a'.repeat(64) }];
  await new FileRoomStore(data).commitRoom(code, {
    schemaVersion:1,rulesVersion:RULES_VERSION,protocolVersion:PROTOCOL_VERSION,savedAt:1234,
    roomCode:code,hostId:'p1',roomState:'LOBBY',paused:false,gameId:null,usedGameIds:[],players,
    sessions:[{roomCode:code,playerId:'p1',seatId:1,tokenDigest:'a'.repeat(64),recoveryDigest:'b'.repeat(64),connectionEpoch:1}],
    game:null,commands:[],lastEvents:[],
  }, []);
  const { createBackup } = await import('../src/storage/backup.js');
  await createBackup({root:data,outDir:out});
  return {data,out,code,bytes:await readFile(path.join(data,'rooms',code,'snapshot.json'))};
}
function singleScriptJson(result: RunResult): Record<string, any> {
  expect(result.stdout.trim().split(/\r?\n/), failureMessage(result)).toHaveLength(1);
  expect(result.json, failureMessage(result)).not.toBeNull();
  return result.json!;
}

describe.skipIf(!onWindows)('09C-B backup/restore/cleanup scripts',()=>{
  it('T16 backup_script_creates_backup',async()=>{
    const fixture=await backupScriptFixture();const out=path.join(await makeTempDir(),'created');
    const result=runScript('backup.ps1',['-DataDir',fixture.data,'-Out',out,'-Json']);
    expect(result.status,failureMessage(result)).toBe(0);
    expect(singleScriptJson(result)).toMatchObject({ok:true,script:'backup',out,rooms:1,skipped:0,pruned:0});
    expect(JSON.parse(await readFile(path.join(out,'manifest.json'),'utf8')).roomCount).toBe(1);
    const warningModule=path.join(await makeTempDir(),'warning.cjs');
    await writeFile(warningModule,"process.stderr.write('CLI_WARNING_TEST\\n');",'utf8');
    const previousOptions=process.env['NODE_OPTIONS'];
    try{
      process.env['NODE_OPTIONS']=(previousOptions??'')+' --require '+JSON.stringify(warningModule);
      const warned=runScript('backup.ps1',['-DataDir',fixture.data,'-Json']);
      expect(warned.status,failureMessage(warned)).toBe(0);
      expect(singleScriptJson(warned)).toMatchObject({ok:true,rooms:1});expect(warned.stderr).toContain('CLI_WARNING_TEST');
    }finally{if(previousOptions===undefined)delete process.env['NODE_OPTIONS'];else process.env['NODE_OPTIONS']=previousOptions;}
  },60000);
  it('T17 restore_script_refuses_while_running',async()=>{
    const fixture=await backupScriptFixture();const port=await freePort();
    const snapshotPath=path.join(fixture.data,'rooms',fixture.code,'snapshot.json');
    const {createHash}=await import('node:crypto');const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
    try{
      const start=runScriptToFile('start-lan.ps1',['-Port',String(port),'-DataDir',fixture.data],fixture.data);
      expect(start.status,failureMessage(start)).toBe(0);
      const before=hash(await readFile(snapshotPath));
      const result=runScript('restore.ps1',['-DataDir',fixture.data,'-Backup',fixture.out,'-Room',fixture.code,'-Json']);
      expect(result.status,failureMessage(result)).toBe(2);
      expect(singleScriptJson(result)).toMatchObject({ok:false,script:'restore',code:'SERVICE_RUNNING'});
      expect(hash(await readFile(snapshotPath))).toBe(before);
      const {readdir}=await import('node:fs/promises');
      expect((await readdir(path.join(fixture.data,'rooms'))).filter(n=>n.startsWith('restore-keep-'))).toEqual([]);
      const statePath=path.join(fixture.data,'run','server.json'),stateBytes=await readFile(statePath);
      const brokenBytes=Buffer.from('{BROKEN_STATE_TEST','utf8');
      try{
        await writeFile(statePath,brokenBytes);
        const healthy=runScript('restore.ps1',['-DataDir',fixture.data,'-Backup',fixture.out,'-Room',fixture.code,'-Port',String(port),'-Json']);
        expect(healthy.status,failureMessage(healthy)).toBe(2);
        expect(singleScriptJson(healthy)).toMatchObject({ok:false,code:'SERVICE_RUNNING'});
        expect(await readFile(statePath)).toEqual(brokenBytes);expect(hash(await readFile(snapshotPath))).toBe(before);
      }finally{await writeFile(statePath,stateBytes);}
    }finally{
      const stop=runScript('stop.ps1',['-DataDir',fixture.data]);
      expect(stop.status,failureMessage(stop)).toBe(0);await waitFor(async()=>!(await portOpen(port)));
    }
  },60000);
  it('T18 restore_script_restores_after_stop',async()=>{
    const fixture=await backupScriptFixture();const port=await freePort();
    try{
      const start=runScriptToFile('start-lan.ps1',['-Port',String(port),'-DataDir',fixture.data],fixture.data);
      expect(start.status,failureMessage(start)).toBe(0);
      const stop=runScript('stop.ps1',['-DataDir',fixture.data]);expect(stop.status,failureMessage(stop)).toBe(0);
      await waitFor(async()=>!(await portOpen(port)));await rmDirWithRetry(path.join(fixture.data,'rooms',fixture.code));
      const result=runScript('restore.ps1',['-DataDir',fixture.data,'-Backup',fixture.out,'-Room',fixture.code,'-Port',String(port),'-Json']);
      expect(result.status,failureMessage(result)).toBe(0);
      expect(singleScriptJson(result)).toMatchObject({ok:true,script:'restore',restored:[{code:fixture.code,keptPath:null}],pausedHint:true});
      expect(await readFile(path.join(fixture.data,'rooms',fixture.code,'snapshot.json'))).toEqual(fixture.bytes);
    }finally{runScript('stop.ps1',['-DataDir',fixture.data]);}
  },60000);
  it('T19 restore_script_requires_force_for_existing',async()=>{
    const fixture=await backupScriptFixture();const port=await freePort();
    const args=['-DataDir',fixture.data,'-Backup',fixture.out,'-Room',fixture.code,'-Port',String(port),'-Json'];
    const refused=runScript('restore.ps1',args);
    expect(refused.status,failureMessage(refused)).toBe(2);
    expect(singleScriptJson(refused)).toMatchObject({ok:false,code:'RESTORE_TARGET_EXISTS'});
    expect(await readFile(path.join(fixture.data,'rooms',fixture.code,'snapshot.json'))).toEqual(fixture.bytes);
    const force=runScript('restore.ps1',[...args,'-Force']);expect(force.status,failureMessage(force)).toBe(0);
    const result=singleScriptJson(force);expect(result.restored[0].keptPath).toContain('restore-keep-');
    expect(await readFile(path.join(result.restored[0].keptPath,'snapshot.json'))).toEqual(fixture.bytes);
    const manifestPath=path.join(fixture.out,'manifest.json');const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
    manifest.backupFormatVersion=99;await writeFile(manifestPath,JSON.stringify(manifest),'utf8');
    const invalid=runScript('restore.ps1',['-DataDir',fixture.data,'-Backup',fixture.out,'-All','-Port',String(port),'-Json']);
    expect(invalid.status,failureMessage(invalid)).toBe(1);
    expect(singleScriptJson(invalid)).toMatchObject({ok:false,code:'MANIFEST_INVALID'});
  },60000);
  it('T20 cleanup_script_dry_run',async()=>{
    const data=await makeTempDir();const logs=path.join(data,'logs'),tmp=path.join(data,'.tmp');
    await mkdir(logs);await mkdir(tmp);const {utimes}=await import('node:fs/promises');
    for(let i=0;i<3;i++){const file=path.join(logs,'server-'+i+'.log');await writeFile(file,'log');await utimes(file,100+i,100+i);}
    const oldTmp=path.join(tmp,'old.tmp');await writeFile(oldTmp,'tmp');await utimes(oldTmp,100,100);
    const result=runScript('cleanup.ps1',['-DataDir',data,'-DryRun','-KeepLogs','1','-Json']);
    expect(result.status,failureMessage(result)).toBe(0);
    expect(singleScriptJson(result)).toMatchObject({ok:true,script:'cleanup',dryRun:true,removed:{tmp:0,logs:0,backups:0,corrupt:0},wouldRemove:{tmp:1,logs:2,backups:0,corrupt:0},failed:[]});
    for(let i=0;i<3;i++)expect(existsSync(path.join(logs,'server-'+i+'.log'))).toBe(true);
    expect(existsSync(oldTmp)).toBe(true);
  },60000);
  it('T21 cleanup_script_reports_failed',async()=>{
    const data=await makeTempDir();const result=runScript('cleanup.ps1',['-DataDir',data,'-Json']);
    expect(result.status,failureMessage(result)).toBe(0);
    const json=singleScriptJson(result);expect(json.ok).toBe(true);expect(Array.isArray(json.failed)).toBe(true);expect(json.failed).toEqual([]);
    // 真实删除失败由核心 T20 hooks.removePath 注入 EACCES 覆盖；本测试不伪造脚本成功。
    for(const value of ['-1','1.5']){
      const invalid=runScript('cleanup.ps1',['-DataDir',data,'-KeepLogs',value,'-Json']);
      expect(invalid.status,failureMessage(invalid)).toBe(1);
      expect(singleScriptJson(invalid)).toMatchObject({ok:false,code:'BAD_ARGUMENT'});
    }
  },60000);
  it('T22 scripts_reject_unknown_parameter',async()=>{
    for(const name of ['backup.ps1','restore.ps1','cleanup.ps1']){
      const bytes=await readFile(path.join(scriptsDir,name));expect(bytes.subarray(0,3)).toEqual(Buffer.from([0xef,0xbb,0xbf]));
      expect(bytes.toString('utf8').replace(/^\uFEFF/,'')).toMatch(/^\[CmdletBinding\(\)\]/);
    }
    const result=runScript('backup.ps1',['-Nope','1']);expect(result.status,failureMessage(result)).toBe(1);
    expect(result.stderr+result.stdout).toMatch(/Nope/);expect(result.stdout).not.toMatch(/at .*backup\.ps1/i);
  },60000);
});

// 09C-B review: append-only T23–T28. Overrides execute real temporary script
// copies only for mutation verification; normal acceptance uses the original helpers.
function runReviewScript(name: 'backup.ps1' | 'restore.ps1', args: string[]): RunResult {
  const variable = name === 'backup.ps1' ? 'RICHMAN_09CB_BACKUP_TEST_SCRIPT' : 'RICHMAN_09CB_RESTORE_TEST_SCRIPT';
  const copy = process.env[variable];
  if (!copy) return runScript(name, args);
  return runPowerShellCommand('& ' + psQuote(copy) + ' ' + args.map(arg => /^-[A-Za-z]+$/.test(arg) ? arg : psQuote(arg)).join(' ') + '; exit $LASTEXITCODE');
}

describe.skipIf(!onWindows)('09C-B review repairs', () => {
  it('T23 backup_script_refuses_existing_out', async () => {
    const fixture = await backupScriptFixture();
    const empty = await makeTempDir();
    const refused = runScript('backup.ps1', ['-DataDir', fixture.data, '-Out', empty, '-Json']);
    expect(refused.status, failureMessage(refused)).toBe(2);
    expect(singleScriptJson(refused)).toMatchObject({ ok: false, script: 'backup', code: 'BACKUP_OUT_EXISTS' });
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(empty)).toEqual([]);
    const full = await makeTempDir();
    await writeFile(path.join(full, 'keep.txt'), 'KEEP_CONTENT', 'utf8');
    const nonempty = runScript('backup.ps1', ['-DataDir', fixture.data, '-Out', full, '-Json']);
    expect(nonempty.status, failureMessage(nonempty)).toBe(2);
    expect(singleScriptJson(nonempty)).toMatchObject({ ok: false, code: 'BACKUP_OUT_EXISTS' });
    expect(await readFile(path.join(full, 'keep.txt'), 'utf8')).toBe('KEEP_CONTENT');
    expect(existsSync(path.join(full, 'manifest.json'))).toBe(false);
    const file = path.join(await makeTempDir(), 'existing-file');
    await writeFile(file, 'KEEP_FILE', 'utf8');
    const plainFile = runScript('backup.ps1', ['-DataDir', fixture.data, '-Out', file, '-Json']);
    expect(plainFile.status, failureMessage(plainFile)).toBe(2);
    expect(singleScriptJson(plainFile)).toMatchObject({ ok: false, code: 'BACKUP_OUT_EXISTS' });
    expect(await readFile(file, 'utf8')).toBe('KEEP_FILE');
  }, 60000);

  it('T24 restore_all_success', async () => {
    const fixture = await backupScriptFixture();
    const { FileRoomStore } = await import('../src/storage/file-store.js');
    const { createBackup } = await import('../src/storage/backup.js');
    const second = JSON.parse(fixture.bytes.toString('utf8'));
    second.roomCode = '7506';
    for (const session of second.sessions) session.roomCode = '7506';
    await new FileRoomStore(fixture.data).commitRoom('7506', second, []);
    const out = path.join(await makeTempDir(), 'two-rooms');
    await createBackup({ root: fixture.data, outDir: out });
    const port = await freePort();
    expect(port).not.toBe(8000);
    try {
      const start = runScriptToFile('start-lan.ps1', ['-DataDir', fixture.data, '-Port', String(port)], fixture.data);
      expect(start.status, failureMessage(start)).toBe(0);
      const stop = runScript('stop.ps1', ['-DataDir', fixture.data]);
      expect(stop.status, failureMessage(stop)).toBe(0);
      await waitFor(async () => !(await portOpen(port)));
      for (const code of ['0042', '7506']) await rmDirWithRetry(path.join(fixture.data, 'rooms', code));
      const restored = runReviewScript('restore.ps1', ['-DataDir', fixture.data, '-Backup', out, '-All', '-Port', String(port), '-Json']);
      expect(restored.status, failureMessage(restored)).toBe(0);
      expect(singleScriptJson(restored)).toMatchObject({
        ok: true, restored: [{ code: '0042', keptPath: null }, { code: '7506', keptPath: null }], pausedHint: true,
      });
      const again = runScriptToFile('start-lan.ps1', ['-DataDir', fixture.data, '-Port', String(port)], fixture.data);
      expect(again.status, failureMessage(again)).toBe(0);
      const health = await (await fetch('http://127.0.0.1:' + port + '/health')).json();
      expect(health.rooms).toBe(2);
      const listing = await (await fetch('http://127.0.0.1:' + port + '/api/rooms')).json();
      expect(listing.rooms.map((room: any) => room.roomCode).sort()).toEqual(['0042', '7506']);
      expect(listing.rooms.every((room: any) => room.paused === true)).toBe(true);
    } finally {
      const stopped = runScript('stop.ps1', ['-DataDir', fixture.data]);
      expect(stopped.status, failureMessage(stopped)).toBe(0);
      await waitFor(async () => !(await portOpen(port)));
    }
  }, 60000);

  it('T25 restore_all_and_room_conflict', async () => {
    const fixture = await backupScriptFixture();
    const port = await freePort();
    const result = runReviewScript('restore.ps1', ['-DataDir', fixture.data, '-Backup', fixture.out, '-All', '-Room', fixture.code, '-Port', String(port), '-Json']);
    expect(result.status, failureMessage(result)).toBe(1);
    expect(singleScriptJson(result)).toMatchObject({ ok: false, code: 'BAD_ARGUMENT' });
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(path.join(fixture.data, 'rooms'))).some(name => name.startsWith('restore-keep-'))).toBe(false);
    expect(await readFile(path.join(fixture.data, 'rooms', fixture.code, 'snapshot.json'))).toEqual(fixture.bytes);
  }, 60000);

  it('T26 backup_script_parent_junction_refused', async () => {
    const fixture = await backupScriptFixture();
    const target = await makeTempDir(), link = path.join(await makeTempDir(), 'parent-link');
    const { symlink, readdir, rmdir } = await import('node:fs/promises');
    await symlink(target, link, 'junction');
    try {
      const result = runScript('backup.ps1', ['-DataDir', fixture.data, '-Out', path.join(link, 'child'), '-Json']);
      expect(result.status, failureMessage(result)).toBe(1);
      expect(singleScriptJson(result)).toMatchObject({ ok: false, code: 'BACKUP_OUT_INVALID', message: expect.stringContaining('父路径') });
      expect(await readdir(target)).toEqual([]);
    } finally { await rmdir(link); }
  }, 60000);

  it('T27 backup_script_keep_prunes_only_matching', async () => {
    const fixture = await backupScriptFixture(), parent = await makeTempDir();
    await writeFile(path.join(parent, 'keep.txt'), 'UNRELATED_FILE', 'utf8');
    await mkdir(path.join(parent, 'other-dir'));
    await writeFile(path.join(parent, 'other-dir', 'file.txt'), 'UNRELATED_DIRECTORY', 'utf8');
    const first = path.join(parent, 'richman-backup-a'), second = path.join(parent, 'richman-backup-b');
    const a = runReviewScript('backup.ps1', ['-DataDir', fixture.data, '-Out', first, '-Keep', '1', '-Json']);
    expect(a.status, failureMessage(a)).toBe(0); expect(singleScriptJson(a)).toMatchObject({ ok: true, pruned: 0 });
    const b = runReviewScript('backup.ps1', ['-DataDir', fixture.data, '-Out', second, '-Keep', '1', '-Json']);
    expect(b.status, failureMessage(b)).toBe(0); expect(singleScriptJson(b)).toMatchObject({ ok: true, pruned: 1 });
    expect(existsSync(first)).toBe(false); expect(existsSync(path.join(second, 'manifest.json'))).toBe(true);
    expect(await readFile(path.join(parent, 'keep.txt'), 'utf8')).toBe('UNRELATED_FILE');
    expect(await readFile(path.join(parent, 'other-dir', 'file.txt'), 'utf8')).toBe('UNRELATED_DIRECTORY');
  }, 60000);

  it('T28 script_arg_errors', async () => {
    for (const name of ['restore.ps1', 'cleanup.ps1']) {
      const invalid = runScript(name, ['-Nope', '1']);
      expect(invalid.status, failureMessage(invalid)).toBe(1);
      expect(invalid.stdout + invalid.stderr).toMatch(/Nope/);
      expect(invalid.stdout + invalid.stderr).not.toMatch(/at .*\.ps1/i);
    }
    const missing = path.join(await makeTempDir(), 'not-created');
    const result = runScript('cleanup.ps1', ['-DataDir', missing, '-Json']);
    expect(result.status, failureMessage(result)).toBe(1);
    expect(singleScriptJson(result)).toMatchObject({ ok: false, code: 'DATA_DIR_MISSING' });
    expect(existsSync(missing)).toBe(false);
  }, 60000);
});

// 12A: append-only T29/T30. 构造发布包形态的临时 root，dot-source 仓库公共脚本。
describe.skipIf(!onWindows)('12A portable layout', () => {
  async function portableFixture(): Promise<{ dir: string; common: string }> {
    const dir = await makeTempDir();
    await mkdir(path.join(dir, 'scripts'), { recursive: true });
    await mkdir(path.join(dir, 'app/server'), { recursive: true });
    await mkdir(path.join(dir, 'app/web'), { recursive: true });
    await mkdir(path.join(dir, 'node'), { recursive: true });
    const common = path.join(dir, 'scripts', 'richman-common.ps1');
    await copyFile(path.join(scriptsDir, 'richman-common.ps1'), common);
    await writeFile(path.join(dir, 'app/server/server.mjs'), '// fake server', 'utf8');
    await writeFile(path.join(dir, 'app/server/backup-cli.mjs'), '// fake cli', 'utf8');
    await writeFile(path.join(dir, 'app/web/index.html'), '<!doctype html><div id="root"></div>', 'utf8');
    await writeFile(path.join(dir, 'node/node.exe'), 'fake node', 'utf8');
    return { dir, common };
  }

  it('T29 portable_layout', async () => {
    const { dir, common } = await portableFixture();
    const command = '. ' + psQuote(common) + '; $layout=Get-RichManLayout; $layout | ConvertTo-Json -Compress';
    const result = runPowerShellCommand(command);
    expect(result.status, failureMessage(result)).toBe(0);
    expect(result.json, failureMessage(result)).toMatchObject({
      Portable: true,
      DataDir: path.join(dir, 'data'),
      WebDir: path.join(dir, 'app/web'),
      WebIndex: path.join(dir, 'app/web/index.html'),
      ServerEntry: path.join(dir, 'app/server/server.mjs'),
      BackupCli: path.join(dir, 'app/server/backup-cli.mjs'),
    });
    expect(path.basename(String(result.json!.NodeExe))).toBe('node.exe');
  });

  it('T30 portable_data_dir_priority', async () => {
    const { dir, common } = await portableFixture();
    const explicit = path.join(dir, 'custom-data');
    const envDir = path.join(dir, 'env-data');
    const command = '. ' + psQuote(common)
      + '; $env:RICHMAN_DATA_DIR=$null; $default=Resolve-DataDir ""'
      + '; $env:RICHMAN_DATA_DIR=' + psQuote(envDir) + '; $fromEnv=Resolve-DataDir ""'
      + '; $env:RICHMAN_DATA_DIR=$null; $explicit=Resolve-DataDir ' + psQuote(explicit)
      + '; [ordered]@{defaultDir=$default;fromEnv=$fromEnv;explicitDir=$explicit} | ConvertTo-Json -Compress';
    const result = runPowerShellCommand(command);
    expect(result.status, failureMessage(result)).toBe(0);
    expect(result.json, failureMessage(result)).toMatchObject({
      defaultDir: path.join(dir, 'data'),
      fromEnv: envDir,
      explicitDir: explicit,
    });
  });
});
