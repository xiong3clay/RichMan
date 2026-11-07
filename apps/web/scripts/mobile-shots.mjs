/**
 * 08B 可复跑证据：用 build 后的 apps/web/dist + 本机 Edge 无头模式生成 6 张移动截图，
 * 并把每个状态的 scrollWidth/clientWidth 写入 apps/web/artifacts/mobile-metrics.txt。
 *
 * 依赖：Node 24 内置 fetch/WebSocket；本机 Edge；已执行 pnpm build。
 * 不新增 npm 依赖。Q1/Q3 用真实服务端房间（两个 WS 玩家）复现。
 *
 * 用法：node apps/web/scripts/mobile-shots.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const OUT = path.resolve(HERE, "../artifacts");
const DIST = path.resolve(HERE, "../dist/index.html");
const PORT = Number(process.env["RICHMAN_MOBILE_PORT"] ?? 8012);
const BASE = `http://127.0.0.1:${PORT}`;
const EDGE_PORT = Number(process.env["RICHMAN_MOBILE_EDGE_PORT"] ?? 9227);
const EDGE_CANDIDATES = [
  process.env["EDGE_PATH"],
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
].filter((value) => typeof value === "string" && value.length > 0);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const states = new Map();
const checks = [];

function record(state, viewport, scrollWidth, clientWidth, result, reason = "") {
  const line = `state=${state} viewport=${viewport} scrollWidth=${scrollWidth} clientWidth=${clientWidth} ${result}${reason ? " reason=" + reason.replace(/\s+/g, " ").slice(0, 160) : ""}`;
  states.set(state, line);
  console.log(line);
}

async function health() {
  try {
    const response = await fetch(BASE + "/health", { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureServer() {
  if (await health()) return null;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "richman-mobile-data-"));
  const child = spawn(process.execPath, ["--import", "tsx", "apps/server/src/http.ts"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), RICHMAN_DATA_DIR: dataDir },
    stdio: "ignore",
    windowsHide: true,
  });
  for (let index = 0; index < 60; index += 1) {
    if (await health()) return { child, dataDir };
    await sleep(250);
  }
  child.kill();
  throw new Error("无法启动 8012 服务；先执行 pnpm build，或检查 tsx/端口");
}

class Peer {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.inbox = [];
    this.waiters = [];
    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      const index = this.waiters.findIndex((waiter) => waiter.type === message.type && waiter.check(message));
      if (index >= 0) {
        const waiter = this.waiters.splice(index, 1)[0];
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else {
        this.inbox.push(message);
      }
    });
  }
  async open() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
    return this;
  }
  send(message) { this.ws.send(JSON.stringify(message)); }
  next(type, check = () => true, timeout = 8000) {
    const index = this.inbox.findIndex((message) => message.type === type && check(message));
    if (index >= 0) return Promise.resolve(this.inbox.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { type, check, resolve, timer: setTimeout(() => {
        this.waiters = this.waiters.filter((item) => item !== waiter);
        reject(new Error("timeout waiting " + type));
      }, timeout) };
      this.waiters.push(waiter);
    });
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

function command(peer, view, commandId, type, payload = {}) {
  peer.send({ protocolVersion: 1, gameId: view.gameId, commandId, type, payload, expectedGameVersion: view.version });
}

function bet(peer, view, commandId) {
  peer.send({
    protocolVersion: 1,
    gameId: view.gameId,
    commandId,
    type: "SUBMIT_BET",
    payload: { betCents: "0", guess: 0, leverage: 1 },
    expectedGameVersion: view.version,
    roundId: view.round,
    phaseInstanceId: view.phaseInstanceId,
  });
}

async function setupGame() {
  const created = await (await fetch(BASE + "/api/rooms", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    signal: AbortSignal.timeout(3000),
  })).json();
  const roomCode = created.roomCode;
  const url = BASE.replace("http:", "ws:") + "/ws?room=" + roomCode;
  const a = await new Peer(url).open();
  const b = await new Peer(url).open();
  try {
    a.send({ type: "join", nickname: "甲" });
    const joinedA = await a.next("joined");
    await a.next("room");
    b.send({ type: "join", nickname: "乙" });
    await b.next("joined");
    await b.next("room");
    a.send({ type: "ready", ready: true });
    b.send({ type: "ready", ready: true });
    await a.next("room", (message) => message.players.every((player) => player.ready));
    a.send({ type: "start" });
    await a.next("started");
    const view = (await a.next("snapshot")).view;
    await b.next("snapshot");
    command(a, view, "shots-borrow", "BORROW_BANK", { amountCents: "5000" });
    await a.next("command_result", (message) => message.commandId === "shots-borrow");
    const p2ViewB = (await b.next("snapshot", (message) => message.view.currentSeatId === 2 && message.view.phase === "ACTION")).view;
    await a.next("snapshot", (message) => message.view.currentSeatId === 2 && message.view.phase === "ACTION");
    command(b, p2ViewB, "shots-end", "END_ACTION");
    await b.next("command_result", (message) => message.commandId === "shots-end");
    const bettingA = (await a.next("snapshot", (message) => message.view.phase === "BETTING")).view;
    const bettingB = (await b.next("snapshot", (message) => message.view.phase === "BETTING")).view;
    bet(a, bettingA, "shots-bet-a");
    await a.next("command_result", (message) => message.commandId === "shots-bet-a");
    const bettingB2 = (await b.next("snapshot", (message) => message.view.version > bettingB.version)).view;
    bet(b, bettingB2, "shots-bet-b");
    await b.next("command_result", (message) => message.commandId === "shots-bet-b");
    await a.next("snapshot", (message) => message.view.round === 2 && message.view.phase === "ACTION" && message.view.currentSeatId === 1, 12000);
    return {
      roomCode,
      nickname: "甲",
      playerId: joinedA.playerId,
      seatId: joinedA.seatId,
      sessionToken: joinedA.sessionToken,
    };
  } finally {
    a.close();
    b.close();
  }
}

function edgePath() {
  for (const candidate of EDGE_CANDIDATES) if (fs.existsSync(candidate)) return candidate;
  throw new Error("未找到 Edge/Chrome；可设置 EDGE_PATH");
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.seq = 0;
    this.pending = new Map();
    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id && this.pending.has(message.id)) {
        const waiter = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message));
        else waiter.resolve(message.result);
      }
    });
  }
  async open() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
    return this;
  }
  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

async function main() {
  if (!fs.existsSync(DIST)) throw new Error("未找到 apps/web/dist，请先执行 pnpm build");
  fs.mkdirSync(OUT, { recursive: true });
  const server = await ensureServer();
  let edge = null;
  let cdp = null;
  let sessionId = null;
  const userDir = path.join(os.tmpdir(), "richman-mobile-edge-" + Date.now());
  try {
    let gameSession = null;
    let gameSkipReason = "";
    let amountInputFont = "";
    let mobileInputFont = "";
    let desktopInputFont = "";
    try {
      gameSession = await setupGame();
    } catch (error) {
      gameSkipReason = "game setup failed: " + (error instanceof Error ? error.message : String(error));
      console.error(gameSkipReason);
    }

    const executable = edgePath();
    edge = spawn(executable, [
      "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
      "--remote-debugging-port=" + EDGE_PORT, "--user-data-dir=" + userDir, "about:blank",
    ], { stdio: "ignore", windowsHide: true });

    let version = null;
    for (let index = 0; index < 60; index += 1) {
      try {
        version = await (await fetch(`http://127.0.0.1:${EDGE_PORT}/json/version`, { signal: AbortSignal.timeout(1000) })).json();
        break;
      } catch { await sleep(250); }
    }
    if (!version) throw new Error("Edge CDP 未就绪");

    cdp = new Cdp(version.webSocketDebuggerUrl);
    await cdp.open();
    const target = (await cdp.send("Target.createTarget", { url: "about:blank" })).targetId;
    sessionId = (await cdp.send("Target.attachToTarget", { targetId: target, flatten: true })).sessionId;
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);

    const evaluate = async (expression) => {
      const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
      if (result.exceptionDetails) throw new Error("page eval failed: " + expression);
      return result.result.value;
    };
    const waitFor = async (expression, timeout = 12000) => {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        if (await evaluate(expression)) return;
        await sleep(150);
      }
      throw new Error("timeout waiting: " + expression);
    };
    const click = async (text, expected) => {
      await evaluate(`(() => { const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes(${JSON.stringify(text)})); if (!b) throw new Error("missing button: " + ${JSON.stringify(text)}); b.click(); return true; })()`);
      if (expected) await waitFor(expected);
    };
    const setViewport = async (width, height) => {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: true }, sessionId);
    };
    const scrollCardTop = async () => {
      await evaluate(`(() => { const card = document.querySelector('.wizard'); if (!card) throw new Error('missing wizard'); window.scrollTo(0, Math.max(0, card.getBoundingClientRect().top + window.scrollY - 130)); return true; })()`);
      await sleep(200);
    };
    const scrollCardBottom = async () => {
      await evaluate(`(() => { const card = document.querySelector('.wizard'); if (!card) throw new Error('missing wizard'); const bottom = card.getBoundingClientRect().bottom + window.scrollY; window.scrollTo(0, Math.max(0, bottom - window.innerHeight + 24)); return true; })()`);
      await sleep(200);
    };
    const gotoBase = async () => {
      await evaluate("location.href = " + JSON.stringify(BASE + "/"));
      await waitFor("document.readyState === 'complete' && !!document.querySelector('.entry')");
    };
    const capture = async (state, fileName, width, height, prepare) => {
      try {
        await setViewport(width, height);
        await prepare();
        const png = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
        fs.writeFileSync(path.join(OUT, fileName), Buffer.from(png.data, "base64"));
        const [innerWidth, innerHeight, scrollWidth, clientWidth] = await evaluate(
          "[innerWidth, innerHeight, document.documentElement.scrollWidth, document.documentElement.clientWidth]",
        );
        const result = scrollWidth <= clientWidth ? "PASS" : "FAIL";
        record(state, `${innerWidth}x${innerHeight}`, scrollWidth, clientWidth, result);
      } catch (error) {
        record(state, `${width}x${height}`, 0, 0, "SKIP", error instanceof Error ? error.message : String(error));
      }
    };

    // 先抢在 action 倒计时前完成对局截图；失败则记 SKIP，不阻断 entry/tutorial/rules。
    if (gameSession !== null) {
      await setViewport(360, 640);
      await evaluate("location.href = " + JSON.stringify(BASE + "/"));
      await waitFor("document.readyState === 'complete' && !!document.querySelector('.entry')");
      await evaluate(`sessionStorage.setItem("richman.session.v1", ${JSON.stringify(JSON.stringify(gameSession))}); localStorage.setItem("richman.tutorial.seen.v1", "1"); location.reload(); true`);
      await waitFor("document.body.textContent.includes('是否向其他玩家借款？') && !!document.querySelector('.self-panel')");
      await scrollCardTop();
      await capture("game-q1", "mobile-game-q1-360x640.png", 360, 640, async () => {});
      await capture("game-q3", "mobile-game-q3-390x844.png", 390, 844, async () => {
        await click("跳过", "document.body.textContent.includes('是否向银行借款？')");
        await click("不需要", "document.body.textContent.includes('是否还款或催收？')");
        await click("还银行贷款", "document.body.textContent.includes('确认还款')");
        await scrollCardTop();
        amountInputFont = await evaluate("getComputedStyle(document.querySelector('.amount-input')).fontSize");
      });
      await capture("landscape", "mobile-landscape-640x360.png", 640, 360, async () => {
        await scrollCardBottom();
      });
      await capture("rules", "mobile-rules-430x932.png", 430, 932, async () => {
        await click("规则说明", "document.querySelectorAll('.rules-section').length === 8");
      });
      await click("关闭规则", "!document.querySelector('.rules-sheet')");
    } else {
      record("game-q1", "360x640", 0, 0, "SKIP", gameSkipReason);
      record("game-q3", "390x844", 0, 0, "SKIP", gameSkipReason);
      record("landscape", "640x360", 0, 0, "SKIP", gameSkipReason);
    }

    if (gameSession === null) {
      await setViewport(430, 932);
      await gotoBase();
      await evaluate("localStorage.setItem('richman.tutorial.seen.v1', '1'); location.reload(); true");
      await waitFor("document.readyState === 'complete' && !!document.querySelector('.entry')");
      await capture("rules", "mobile-rules-430x932.png", 430, 932, async () => {
        await click("规则说明", "document.querySelectorAll('.rules-section').length === 8");
      });
      await click("关闭规则", "!document.querySelector('.rules-sheet')");
    }

    await setViewport(360, 640);
    await evaluate("sessionStorage.removeItem('richman.session.v1'); localStorage.setItem('richman.tutorial.seen.v1', '1'); location.href = " + JSON.stringify(BASE + "/") + "; true");
    await waitFor("document.readyState === 'complete' && !!document.querySelector('.entry')");
    await capture("entry", "mobile-entry-360x640.png", 360, 640, async () => {
      mobileInputFont = await evaluate("getComputedStyle(document.querySelector('.input')).fontSize");
    });
    await setViewport(640, 360);
    desktopInputFont = await evaluate("getComputedStyle(document.querySelector('.input')).fontSize");
    await setViewport(360, 640);
    await capture("tutorial", "mobile-tutorial-360x640.png", 360, 640, async () => {
      await evaluate("localStorage.removeItem('richman.tutorial.seen.v1'); location.reload(); true");
      await waitFor("document.readyState === 'complete' && !!document.querySelector('.tutorial-overlay')");
    });

    checks.push(`check=amount-input-font value=${amountInputFont || "unavailable"} viewport=390x844 ${amountInputFont === "18px" ? "PASS" : amountInputFont ? "FAIL" : "SKIP"}`);
    checks.push(`check=input-font-mobile value=${mobileInputFont || "unavailable"} viewport=360x640 ${mobileInputFont === "16px" ? "PASS" : mobileInputFont ? "FAIL" : "SKIP"}`);
    checks.push(`check=input-font-desktop value=${desktopInputFont || "unavailable"} viewport=640x360 ${desktopInputFont === "15px" ? "PASS" : desktopInputFont ? "FAIL" : "SKIP"}`);

    const ordered = ["entry", "tutorial", "game-q1", "game-q3", "landscape", "rules"]
      .map((state) => states.get(state) ?? `state=${state} viewport=? scrollWidth=0 clientWidth=0 SKIP reason=missing`);
    const metricsText = "# 08B mobile metrics（PASS 条件：scrollWidth <= clientWidth）\n"
      + ordered.concat(checks).join("\n") + "\n";
    fs.writeFileSync(path.join(OUT, "mobile-metrics.txt"), metricsText, "utf8");
    console.log("\n写出 " + path.join(OUT, "mobile-metrics.txt"));
    console.log(ordered.join("\n"));
  } finally {
    cdp?.close();
    if (edge !== null) {
      edge.kill("SIGKILL");
      await sleep(400);
    }
    fs.rmSync(userDir, { recursive: true, force: true });
    if (server !== null) {
      server.child.kill("SIGKILL");
      fs.rmSync(server.dataDir, { recursive: true, force: true });
    }
  }
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
