#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkZipTopLevel, comparePackageDirs, scanSecrets, validateStaging } from "./release-lib.mjs";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tempDirs = [];

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex").toUpperCase();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function psQuote(value) {
  return "'" + value.replace(/'/g, "''") + "'";
}

function parseArgs(argv) {
  let dir = null;
  let zip = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dir") dir = argv[++index] ?? null;
    else if (arg === "--zip") zip = argv[++index] ?? null;
    else if (arg.startsWith("--dir=")) dir = arg.slice("--dir=".length);
    else if (arg.startsWith("--zip=")) zip = arg.slice("--zip=".length);
    else throw new Error("未知参数：" + arg);
  }
  const version = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;
  const name = "RichMan-v" + version + "-win-x64";
  return {
    dir: path.resolve(dir ?? path.join(repoRoot, "release", name)),
    zip: path.resolve(zip ?? path.join(repoRoot, "release", name + ".zip")),
    version,
  };
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = address.port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function portOpen(port) {
  return new Promise(resolve => {
    const client = net.connect(port, "127.0.0.1");
    client.once("connect", () => { client.destroy(); resolve(true); });
    client.once("error", () => resolve(false));
  });
}

async function waitPortClosed(port) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (!(await portOpen(port))) return;
    await sleep(100);
  }
  throw new Error("端口未释放：" + String(port));
}

async function waitHealth(base, version) {
  const deadline = Date.now() + 20000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(base + "/health");
      if (response.status === 200) {
        const body = await response.json();
        if (body.ok === true && body.service === "richman" && body.version === version) return body;
        lastError = new Error("/health 字段不匹配：" + JSON.stringify(body));
      } else {
        lastError = new Error("/health 状态：" + String(response.status));
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw lastError ?? new Error("/health 超时");
}

function killChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill("SIGKILL"); } catch {}
  if (process.platform === "win32" && child.pid !== undefined) {
    setTimeout(() => {
      try {
        spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      } catch {}
    }, 500).unref();
  }
}

async function waitChildExit(child, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (child.exitCode === null && child.signalCode === null) {
    if (Date.now() >= deadline) throw new Error("子进程未退出：" + String(child.pid));
    await sleep(50);
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 120000,
    windowsHide: true,
    ...options,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function lastJsonLine(text) {
  const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length === 0) throw new Error("没有 JSON 输出");
  return JSON.parse(lines[lines.length - 1]);
}

function writeReport(lines) {
  const logDir = path.join(repoRoot, "artifacts/test-logs");
  mkdirSync(logDir, { recursive: true });
  writeFileSync(path.join(logDir, "release-verify.txt"), lines.join("\n") + "\n", "utf8");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const checks = [];
  const problems = [];

  function record(name, ok, detail) {
    checks.push({ name, ok, detail });
    if (!ok) problems.push(name + "：" + detail);
    return ok;
  }

  const dirExists = existsSync(options.dir);
  record("staging_exists", dirExists, dirExists ? options.dir : "缺少目录");
  const zipExists = existsSync(options.zip);
  record("zip_exists", zipExists, zipExists ? options.zip : "缺少 zip");
  if (!dirExists || !zipExists) {
    const summary = { ok: false, dir: options.dir, zip: options.zip, version: options.version, checks, problems };
    writeReport([JSON.stringify(summary), ...checks.map(c => (c.ok ? "PASS " : "FAIL ") + c.name + "：" + c.detail), ...problems.map(p => "PROBLEM " + p)]);
    console.log(JSON.stringify(summary));
    return 1;
  }

  const version = (await readFile(path.join(options.dir, "VERSION"), "utf8")).trim();
  const nodeVersion = (await readFile(path.join(options.dir, "node/VERSION"), "utf8")).trim();
  const staging = await validateStaging(options.dir, { version, nodeVersion });
  record("staging_structure", staging.ok, staging.ok ? String(staging.files) + " files / " + String(staging.bytes) + " bytes" : staging.problems.join("；"));
  if (version !== options.version) record("version_matches_package", false, version + " / " + options.version);
  else record("version_matches_package", true, version);

  try {
    const names = ["start-lan.bat", "start-tunnel.bat", "stop.bat", "status.bat", "backup.bat", "restore.bat", "cleanup.bat"];
    for (const name of names) {
      const text = await readFile(path.join(options.dir, name), "utf8");
      const required = ["@echo off", "chcp 65001>nul", "cd /d \"%~dp0\"", "powershell.exe -NoProfile", "pause"];
      for (const part of required) {
        if (!text.includes(part)) throw new Error(name + " 缺少 " + part);
      }
      if (!text.includes("\r\n")) throw new Error(name + " 不是 CRLF");
    }
    record("bat_files", true, "7 个 .bat 内容与 CRLF 正常");
  } catch (error) {
    record("bat_files", false, error instanceof Error ? error.message : String(error));
  }

  try {
    const zipHash = sha256(await readFile(options.zip));
    const releaseSums = await readFile(path.join(path.dirname(options.zip), "SHA256SUMS.txt"), "utf8");
    const line = releaseSums.split(/\r?\n/).find(item => item.endsWith("  " + path.basename(options.zip)));
    if (line === undefined || line.slice(0, 64).toUpperCase() !== zipHash) {
      throw new Error("release/SHA256SUMS.txt 与 zip hash 不匹配");
    }
    record("zip_sha256", true, zipHash);
  } catch (error) {
    record("zip_sha256", false, error instanceof Error ? error.message : String(error));
  }

  const extracted = await mkdtemp(path.join(os.tmpdir(), "richman-verify-zip-"));
  tempDirs.push(extracted);
  let extractedDir = null;
  try {
    const result = run("powershell", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
      "Expand-Archive -LiteralPath " + psQuote(options.zip) + " -DestinationPath " + psQuote(extracted) + " -Force",
    ]);
    if (result.status !== 0) throw new Error(result.stderr || "Expand-Archive 失败");
    const rootEntries = await readdir(extracted, { withFileTypes: true });
    const expectedTop = "RichMan-v" + version + "-win-x64";
    const topCheck = checkZipTopLevel(rootEntries, expectedTop);
    if (!topCheck.ok) throw new Error(topCheck.problems.join("；"));
    extractedDir = path.join(extracted, expectedTop);
    const extractedVersion = (await readFile(path.join(extractedDir, "VERSION"), "utf8")).trim();
    if (extractedVersion !== version) throw new Error("zip 内 VERSION 不匹配");
    const extractedCheck = await validateStaging(extractedDir, { version, nodeVersion });
    const diff = await comparePackageDirs(options.dir, extractedDir);
    if (!extractedCheck.ok || !diff.ok) {
      const merged = [
        ...extractedCheck.problems.map(problem => "zip 内容不完整：" + problem),
        ...diff.problems.map(problem => "zip 与 staging 不一致：" + problem),
      ];
      throw new Error(merged.slice(0, 10).join("；"));
    }
    const actualServerHash = sha256(await readFile(path.join(extractedDir, "app/server/server.mjs")));
    record(
      "zip_extract",
      true,
      expectedTop + " / " + String(extractedCheck.files) + " files / " + String(extractedCheck.bytes) +
        " bytes / server.mjs " + actualServerHash.slice(0, 12),
    );
  } catch (error) {
    record("zip_extract", false, error instanceof Error ? error.message : String(error));
  }

  try {
    let secretHits = await scanSecrets(options.dir);
    if (extractedDir !== null) {
      const zipHits = await scanSecrets(extractedDir);
      secretHits = secretHits.concat(zipHits.map(hit => "zip:" + hit));
    }
    if (secretHits.length > 0) throw new Error("疑似明文 token/恢复码：" + secretHits.join(","));
    record("secret_scan", true, "staging 与 zip 均未发现 token/recovery 明文");
  } catch (error) {
    record("secret_scan", false, error instanceof Error ? error.message : String(error));
  }

  const nodeExe = path.join(options.dir, "node/node.exe");
  const serverEntry = path.join(options.dir, "app/server/server.mjs");
  const staticDir = path.join(options.dir, "app/web");
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "richman-verify-data-"));
  tempDirs.push(dataDir);
  const port = await freePort();
  const outFile = path.join(dataDir, "server.out");
  const errFile = path.join(dataDir, "server.err");
  let child = null;
  let serverOk = false;
  try {
    const outFd = openSync(outFile, "w");
    const errFd = openSync(errFile, "w");
    child = spawn(nodeExe, [serverEntry], {
      cwd: options.dir,
      env: { ...process.env, PORT: String(port), RICHMAN_STATIC_DIR: staticDir, RICHMAN_DATA_DIR: dataDir },
      stdio: ["ignore", outFd, errFd],
      windowsHide: true,
    });
    closeSync(outFd);
    closeSync(errFd);
    const health = await waitHealth("http://127.0.0.1:" + String(port), version);
    const rootResponse = await fetch("http://127.0.0.1:" + String(port) + "/");
    if (rootResponse.status !== 200) throw new Error("GET / 状态 " + String(rootResponse.status));
    const rootText = await rootResponse.text();
    if (!rootText.includes('<div id="root"')) throw new Error("GET / 不含 root 挂载点");
    const audioFiles = await readdir(path.join(staticDir, "audio"));
    const mp3 = audioFiles.find(name => name.endsWith(".mp3"));
    if (mp3 === undefined) throw new Error("app/web/audio 没有 mp3");
    const audioResponse = await fetch("http://127.0.0.1:" + String(port) + "/audio/" + encodeURIComponent(mp3));
    if (audioResponse.status !== 200) throw new Error("mp3 状态 " + String(audioResponse.status));
    const roomResponse = await fetch("http://127.0.0.1:" + String(port) + "/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (roomResponse.status !== 201) throw new Error("POST /api/rooms 状态 " + String(roomResponse.status));
    const room = await roomResponse.json();
    if (typeof room.roomCode !== "string" || !/^\d{4,8}$/.test(room.roomCode)) {
      throw new Error("房间码非法：" + JSON.stringify(room));
    }
    serverOk = true;
    record("server_runtime", true, "health " + version + " / GET 200 / mp3 200 / room " + room.roomCode);
  } catch (error) {
    record("server_runtime", false, error instanceof Error ? error.message : String(error));
  } finally {
    if (child !== null) {
      killChild(child);
      try { await waitChildExit(child, 10000); } catch {}
    }
    try {
      await waitPortClosed(port);
      record("port_released", true, String(port));
    } catch (error) {
      record("port_released", false, error instanceof Error ? error.message : String(error));
    }
    if (!serverOk) {
      try {
        const err = await readFile(errFile, "utf8");
        if (err.trim().length > 0) problems.push("server stderr：" + err.trim().slice(-500));
      } catch {}
    }
  }

  const emptyData = await mkdtemp(path.join(os.tmpdir(), "richman-verify-empty-"));
  tempDirs.push(emptyData);
  const backupOut = path.join(emptyData, "backup-out");
  try {
    const cli = path.join(options.dir, "app/server/backup-cli.mjs");
    const backup = run(nodeExe, [cli, "create", "--data", emptyData, "--out", backupOut]);
    const payload = lastJsonLine(backup.stdout);
    if (backup.status !== 1 || payload.code !== "BACKUP_EMPTY") {
      throw new Error("create exit=" + String(backup.status) + " code=" + String(payload.code));
    }
    if (existsSync(backupOut)) throw new Error("BACKUP_EMPTY 后 out 仍存在");
    const cleanup = run(nodeExe, [cli, "cleanup", "--data", emptyData, "--dry-run"]);
    const cleanupPayload = lastJsonLine(cleanup.stdout);
    if (cleanup.status !== 0 || cleanupPayload.ok !== true) {
      throw new Error("cleanup exit=" + String(cleanup.status));
    }
    record("backup_cli", true, "create BACKUP_EMPTY exit 1；cleanup dry-run exit 0");
  } catch (error) {
    record("backup_cli", false, error instanceof Error ? error.message : String(error));
  }

  const checkData = await mkdtemp(path.join(os.tmpdir(), "richman-verify-check-"));
  tempDirs.push(checkData);
  const checkPort = await freePort();
  try {
    const check = run("powershell", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(options.dir, "scripts/start-lan.ps1"),
      "-CheckOnly", "-Port", String(checkPort), "-DataDir", checkData,
    ], { cwd: options.dir, timeout: 120000 });
    const payload = lastJsonLine(check.stdout);
    const nodeVersionOk = typeof payload.checks?.node?.version === "string" && /^v\d/.test(payload.checks.node.version);
    const webOk = payload.checks?.webDist?.ok === true;
    if (check.status !== 0 || payload.ok !== true || !nodeVersionOk || !webOk) {
      throw new Error("CheckOnly exit=" + String(check.status) + " json=" + JSON.stringify(payload));
    }
    record("packaged_check_only", true, "node " + payload.checks.node.version + " / webDist ok");
  } catch (error) {
    record("packaged_check_only", false, error instanceof Error ? error.message : String(error));
  }

  const ok = problems.length === 0;
  const summary = { ok, dir: options.dir, zip: options.zip, version, checks, problems };
  const report = [
    JSON.stringify(summary),
    ...checks.map(check => (check.ok ? "PASS " : "FAIL ") + check.name + "：" + check.detail),
    ...problems.map(problem => "PROBLEM " + problem),
  ];
  writeReport(report);
  console.log(JSON.stringify(summary));
  return ok ? 0 : 1;
}

main()
  .catch(error => {
    console.error("verify-release 失败：" + (error instanceof Error ? error.message : String(error)));
    return 1;
  })
  .then(async code => {
    for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => {});
    process.exitCode = code;
  });
