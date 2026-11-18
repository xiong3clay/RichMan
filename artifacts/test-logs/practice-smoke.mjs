/**
 * 单人练习 WS 冒烟：建房(bots=1) → 自动准备/开局 → 人类按阶段操作 → 观察 AI 行动。
 * 用法：node artifacts/test-logs/practice-smoke.mjs http://127.0.0.1:8000
 */
const base = process.argv[2] ?? "http://127.0.0.1:8000";
const summary = {
  roomCode: null,
  joined: false,
  started: false,
  rounds: new Set(),
  aiActions: [],
  humanCommands: 0,
  commandFailures: [],
  commandResults: [],
  serverErrors: [],
  sent: [],
  snapshots: [],
  phases: new Set(),
  phrases: [],
  personalities: [],
};
let me = null;
let sentStart = false;
let actionSentFor = null;
let betSentFor = null;
let done = false;

function send(ws, message) {
  ws.send(JSON.stringify(message));
}
function commandId(prefix) { return prefix + "-" + String(Date.now()) + "-" + String(Math.random()).slice(2, 8); }

const roomResponse = await fetch(base + "/api/rooms", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ nickname: "验收员", bots: 5 }),
});
const roomJson = await roomResponse.json();
if (roomResponse.status !== 201 || roomJson.ok !== true) {
  console.error(JSON.stringify({ ok: false, stage: "create", status: roomResponse.status, body: roomJson }));
  process.exit(1);
}
summary.roomCode = roomJson.roomCode;

const wsUrl = base.replace(/^http/, "ws") + "/ws?room=" + encodeURIComponent(roomJson.roomCode);
const ws = new WebSocket(wsUrl);

const timer = setTimeout(() => finish("timeout"), 75_000);

function finish(reason) {
  if (done) return;
  done = true;
  clearTimeout(timer);
  try { ws.close(); } catch { /* ignore */ }
  const result = {
    ok: reason === "done" && summary.commandFailures.length === 0 && summary.rounds.size >= 2
      && summary.aiActions.some((a) => a.type === "ACTION_ENDED" && a.playerId === "p1"),
    reason,
    roomCode: summary.roomCode,
    joined: summary.joined,
    started: summary.started,
    rounds: [...summary.rounds].sort((a, b) => a - b),
    phases: [...summary.phases],
    aiActions: summary.aiActions.slice(0, 12),
    humanCommands: summary.humanCommands,
    commandFailures: summary.commandFailures,
    commandResults: summary.commandResults,
    serverErrors: summary.serverErrors,
    sent: summary.sent,
    snapshots: summary.snapshots.slice(-8),
    phrases: summary.phrases,
    personalities: summary.personalities,
  };
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}

ws.addEventListener("open", () => {
  send(ws, { type: "join", nickname: "验收员" });
});
ws.addEventListener("error", (event) => {
  console.error(JSON.stringify({ ok: false, stage: "ws", message: String(event.message ?? "") }));
  finish("ws-error");
});
ws.addEventListener("message", (event) => {
  let message;
  try { message = JSON.parse(String(event.data)); } catch { return; }
  if (message.type === "joined") {
    me = { playerId: message.playerId, seatId: message.seatId };
    summary.joined = true;
    send(ws, { type: "ready", ready: true });
    return;
  }
  if (message.type === "room") {
    if (!sentStart && me !== null && message.state === "LOBBY" && message.hostId === me.playerId
      && message.players.length >= 2 && message.players.every((player) => player.ready)) {
      sentStart = true;
      send(ws, { type: "start" });
    }
    return;
  }
  if (message.type === "started") { summary.started = true; return; }
  if (message.type === "events") {
    for (const item of message.events ?? []) {
      const payload = item.payload ?? {};
      if (item.type === "ACTION_ENDED") summary.aiActions.push({ type: item.type, playerId: payload.playerId, round: payload.round });
      if (item.type === "BET_SUBMITTED") summary.phrases.push({ type: item.type, playerId: payload.playerId, round: payload.round });
      if (item.type === "BET_SUBMITTED" && payload.playerId === "p1") summary.aiActions.push({ type: item.type, playerId: "p1", round: payload.round });
      if (item.type === "GAME_OVER") summary.aiActions.push({ type: item.type, winnerId: payload.winnerId });
    }
    return;
  }
  if (message.type === "command_result") {
    summary.commandResults.push({ commandId: message.commandId, ok: message.outcome?.ok, code: message.outcome?.code });
    if (message.outcome?.ok !== true) {
      summary.commandFailures.push({ code: message.outcome?.code, message: message.outcome?.message });
    }
    return;
  }
  if (message.type === "error") {
    summary.serverErrors.push({ code: message.code, message: message.message });
    return;
  }
  if (message.type !== "snapshot") return;
  const view = message.view;
  summary.rounds.add(view.round);
  summary.phases.add(view.phase);
  for (const player of view.publicPlayers ?? []) {
    if (player.isBot === true && player.botPersonality !== undefined
      && !summary.personalities.includes(player.botPersonality)) {
      summary.personalities.push(player.botPersonality);
    }
  }
  summary.snapshots.push({ round: view.round, phase: view.phase, seat: view.currentSeatId,
    myBet: view.finance.myBet, betsSubmitted: view.finance.betsSubmitted, version: view.version });
  if (view.phase === "ACTION" && view.currentSeatId === view.me.seatId) {
    const key = view.gameId + "|" + view.phaseInstanceId;
    if (actionSentFor !== key) {
      actionSentFor = key;
      summary.humanCommands += 1;
      summary.sent.push({ type: "END_ACTION", version: view.version, phase: view.phaseInstanceId });
      send(ws, {
        protocolVersion: 1, gameId: view.gameId, commandId: commandId("smoke-end"),
        type: "END_ACTION", payload: {}, expectedGameVersion: view.version,
      });
    }
  }
  if (view.phase === "BETTING" && view.finance.myBet === null) {
    const key = view.gameId + "|" + view.phaseInstanceId;
    if (betSentFor !== key) {
      betSentFor = key;
      summary.humanCommands += 1;
      summary.sent.push({ type: "SUBMIT_BET", round: view.round, phase: view.phaseInstanceId });
      send(ws, {
        protocolVersion: 1, gameId: view.gameId, commandId: commandId("smoke-bet"),
        type: "SUBMIT_BET", payload: { betCents: "0", guess: 0, leverage: 1 },
        roundId: view.round, phaseInstanceId: view.phaseInstanceId,
      });
    }
  }
  if (view.round >= 3 || view.phase === "GAME_OVER") finish("done");
});
