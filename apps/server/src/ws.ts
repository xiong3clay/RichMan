import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { randomBytes } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import type { RawData } from "ws";
import { ClientGameCommandSchema, ClientLobbyMessageSchema, SERVER_DEFAULTS } from "@richman/shared";
import type { GameEvent, LobbyErrorCode, ServerLobbyMessage, TransitionResult } from "@richman/shared";
import { SNAPSHOT_SCHEMA_VERSION, eventsForPlayer, getPlayerView } from "@richman/game-core";
import type { EngineState } from "@richman/game-core";
import { LobbyError } from "./rooms/manager.js";
import type { RoomManager, RoomManagerEvent } from "./rooms/manager.js";
import { SessionRegistry } from "./rooms/session.js";
import type { SessionIdentity, SessionStore } from "./rooms/session.js";
import { GameCommandProcessor, RoomCommandQueue } from "./rooms/command-queue.js";
import type { CommandResultStore } from "./rooms/command-queue.js";
import { RoomScheduler } from "./rooms/scheduler.js";

interface Connection {
  ws: WebSocket;
  id: number;
  identity: SessionIdentity | null;
  epoch: number;
  roomCodeQuery: string | null;
  replaced: boolean;
  closed: boolean;
  serial: Promise<void>;
  ping: Buffer | null;
  missedPongs: number;
  rateStart: number;
  rateCount: number;
}
export interface LobbyWsRuntime { connections: () => number; close: () => Promise<void> }
export interface LobbyWsOptions {
  now?: () => number;
  sessionStore?: SessionStore;
  commandStore?: CommandResultStore;
  heartbeatClock?: {
    setInterval(callback: () => void, ms: number): unknown;
    clearInterval(handle: unknown): void;
  };
}

function rawToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}
function send(conn: Connection, message: ServerLobbyMessage): void {
  if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify(message));
}
function sendError(conn: Connection, code: LobbyErrorCode, message: string): void {
  send(conn, { type: "error", code, message });
}
/** Engine amounts are integers; wire amounts are decimal strings, including filtered events. */
function wireCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (key, item: unknown) =>
    typeof item === "number" && (key === "cents" || key === "centsAfter" || key.endsWith("Cents")) ? String(item) : item)) as T;
}

/** Transport privacy projection for legacy engine events without an audience. */
function visibleEvents(state: EngineState, events: GameEvent[], viewerId: string): GameEvent[] {
  const privateBankEvents = new Set(["BANK_LOAN_ISSUED", "BANK_LOAN_REPAID", "BANK_LOAN_SETTLED", "BANK_DUE_PENDING"]);
  const protectedEvents = events.map(event => {
    if (!privateBankEvents.has(event.type)) return event;
    const payload = event.payload as { loanId?: string };
    const borrower = state.bankLoans.find(loan => loan.loanId === payload.loanId)?.borrowerId;
    return { ...event, audience: borrower ? [borrower] : [] };
  });
  return eventsForPlayer(protectedEvents, viewerId).map(event => {
    const payload = event.payload as Record<string, unknown>;
    if ((event.type === "TAX_CHARGED" || event.type === "DANGER_RESCUED") && payload.playerId !== viewerId) {
      const publicPayload = { ...payload };
      delete publicPayload.centsAfter;
      delete publicPayload.cents;
      return { ...event, payload: publicPayload };
    }
    if (event.type === "BET_SETTLED" && Array.isArray(payload.players)) {
      const players = (payload.players as Array<Record<string, unknown>>).map(player => {
        if (player.playerId === viewerId) return player;
        const publicResult = { ...player };
        delete publicResult.nextCents;
        delete publicResult.overdraftCents;
        return publicResult;
      });
      return { ...event, payload: { ...payload, players } };
    }
    return event;
  });
}

/** All lobby changes, commands and system transitions share the same room queue. */
export function attachLobbyWebSocket(server: Server, manager: RoomManager, options: LobbyWsOptions = {}): LobbyWsRuntime {
  const wss = new WebSocketServer({ noServer: true, maxPayload: SERVER_DEFAULTS.maxMessageBytes });
  const connections = new Map<WebSocket, Connection>();
  const owners = new Map<string, Connection>();
  const queue = new RoomCommandQueue();
  const sessions = new SessionRegistry(manager, options.sessionStore ? { store: options.sessionStore } : {});
  const now = options.now ?? (() => Date.now());
  let nextId = 1;
  let closing = false;
  const ownerKey = (identity: SessionIdentity): string => JSON.stringify([identity.roomCode, identity.playerId]);
  const current = (conn: Connection): boolean => !conn.closed && !conn.replaced && conn.identity !== null
    && sessions.isCurrent(conn.identity, conn.epoch) && owners.get(ownerKey(conn.identity)) === conn;

  const snapshot = (conn: Connection): void => {
    if (!current(conn)) return;
    const identity = conn.identity!, state = manager.getGame(identity.roomCode);
    if (state === null) return;
    const pendingDueLoan = state.bankLoans.find(loan => loan.loanId === state.pendingDueLoanId);
    send(conn, { type: "snapshot", view: wireCopy({
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      ...getPlayerView(state, identity.playerId, new Date(now())),
      phaseInstanceId: state.phaseInstanceId, eventSeq: state.eventSeq,
      currentSeatId: state.currentSeatId, actedSeats: [...state.actedSeats],
      pendingDueLoanId: pendingDueLoan?.borrowerId === identity.playerId ? pendingDueLoan.loanId : null,
    }) });
  };
  const commit = (roomCode: string, result: TransitionResult): void => {
    const state = manager.getGame(roomCode);
    if (state === null || state.gameId !== result.state.gameId) throw new Error("游戏状态不存在");
    Object.assign(state, result.state);
    for (const conn of connections.values()) {
      if (!current(conn) || conn.identity!.roomCode !== roomCode) continue;
      snapshot(conn);
      const events = visibleEvents(state, result.events, conn.identity!.playerId);
      if (events.length) send(conn, { type: "events", gameId: state.gameId, gameVersion: state.version, events: wireCopy(events) });
    }
    scheduler.schedule(roomCode);
  };
  const scheduler = new RoomScheduler({ queue, getState: code => manager.getGame(code), commit, now });
  const processor = new GameCommandProcessor({ queue, getState: code => manager.getGame(code), commit,
    advance: code => scheduler.advanceDue(code), now, ...(options.commandStore ? { store: options.commandStore } : {}) });
  const broadcast = (event: RoomManagerEvent): void => {
    for (const conn of connections.values()) {
      if (!current(conn) || conn.identity!.roomCode !== event.roomCode) continue;
      if (event.type === "room") send(conn, { type: "room", players: event.room.players, hostId: event.room.hostId, state: event.room.state });
      else if (event.type === "started") send(conn, { type: "started", roomCode: event.roomCode, gameId: event.gameId });
      else send(conn, { type: "peer_left", playerId: event.playerId });
    }
  };
  const unsubscribe = manager.subscribe(broadcast);
  const detach = (conn: Connection): SessionIdentity | null => {
    const identity = conn.identity;
    if (identity && owners.get(ownerKey(identity)) === conn) owners.delete(ownerKey(identity));
    conn.identity = null;
    return identity;
  };
  const bind = (conn: Connection, identity: SessionIdentity): void => {
    const key = ownerKey(identity), previous = owners.get(key);
    conn.epoch = sessions.claim(identity);
    conn.identity = { roomCode: identity.roomCode, playerId: identity.playerId, seatId: identity.seatId };
    owners.set(key, conn);
    if (previous && previous !== conn) {
      previous.replaced = true;
      previous.identity = null;
      sendError(previous, "REPLACED", "这个座位已在另一个页面恢复");
      previous.ws.close(4001, "REPLACED");
    }
  };

  const handleLobby = async (conn: Connection, json: unknown): Promise<void> => {
    if (conn.closed || conn.replaced) return;
    const parsed = ClientLobbyMessageSchema.safeParse(json);
    if (!parsed.success) { sendError(conn, "INVALID_MESSAGE", "消息格式不合法"); return; }
    const message = parsed.data;
    if (message.type === "join" || message.type === "resume") {
      if (conn.identity !== null) { sendError(conn, "INVALID_MESSAGE", "当前连接已有身份，请重新建立连接恢复"); return; }
      const roomCode = message.type === "resume" ? message.roomCode : conn.roomCodeQuery;
      if (roomCode === null) { sendError(conn, "ROOM_NOT_FOUND", "连接缺少房间码"); return; }
      const joined = message.type === "resume" ? sessions.resume(roomCode, message)
        : message.sessionToken !== undefined ? sessions.resume(roomCode, { sessionToken: message.sessionToken })
          : sessions.join(roomCode, message.nickname);
      bind(conn, joined);
      send(conn, { type: "joined", roomCode, playerId: joined.playerId, seatId: joined.seatId,
        sessionToken: joined.sessionToken, connectionEpoch: conn.epoch,
        ...("recoveryCode" in joined ? { recoveryCode: joined.recoveryCode as string } : {}) });
      const room = manager.getRoom(roomCode);
      if (room) send(conn, { type: "room", players: room.players, hostId: room.hostId, state: room.state });
      snapshot(conn);
      return;
    }
    if (!current(conn)) { sendError(conn, "NOT_JOINED", "请先加入房间"); return; }
    const identity = conn.identity!;
    if (message.type === "ready") sessions.setReady(identity, message.ready);
    else if (message.type === "leave") { detach(conn); sessions.leave(identity); }
    else if (message.type === "start" || message.type === "rematch") {
      if (message.type === "start") sessions.start(identity);
      else sessions.rematch(identity);
      await scheduler.advanceDue(identity.roomCode);
      scheduler.schedule(identity.roomCode);
    }
  };
  const handle = async (conn: Connection, raw: string): Promise<void> => {
    if (conn.replaced || conn.closed) return;
    let json: unknown;
    try { json = JSON.parse(raw); }
    catch { sendError(conn, "INVALID_MESSAGE", "消息不是合法JSON"); return; }
    const command = ClientGameCommandSchema.safeParse(json);
    if (command.success) {
      if (!current(conn)) { sendError(conn, "NOT_JOINED", "请先加入房间"); return; }
      const identity = conn.identity!, epoch = conn.epoch;
      const versionBefore = manager.getGame(identity.roomCode)?.version;
      const reply = await processor.execute(identity.roomCode, identity.playerId, command.data,
        () => current(conn) && conn.epoch === epoch);
      if (!current(conn)) return;
      send(conn, wireCopy(reply));
      // commit 已向房间内所有连接推送快照；version 没变说明命令被拒/冲突且没有广播，
      // 补发一次本人快照，避免界面停在过期状态。有 commit 时保持“不重复补发”。
      if (manager.getGame(identity.roomCode)?.version === versionBefore) snapshot(conn);
      return;
    }
    const lobby = ClientLobbyMessageSchema.safeParse(json);
    if (!lobby.success) { sendError(conn, "INVALID_MESSAGE", "消息格式不合法"); return; }
    const code = conn.identity?.roomCode ?? (lobby.data.type === "resume" ? lobby.data.roomCode : conn.roomCodeQuery)
      ?? `connection-${conn.id}`;
    await queue.run(code, () => handleLobby(conn, json));
  };
  const disconnected = (conn: Connection): void => {
    if (conn.closed) return;
    const identity = conn.identity, epoch = conn.epoch, wasCurrent = current(conn);
    conn.closed = true;
    connections.delete(conn.ws);
    if (!wasCurrent || identity === null || closing) return;
    detach(conn);
    void queue.run(identity.roomCode, () => {
      if (sessions.isCurrent(identity, epoch) && !owners.has(ownerKey(identity))) sessions.disconnect(identity);
    }).catch(() => undefined);
  };
  const init = (ws: WebSocket, roomCodeQuery: string | null): void => {
    const conn: Connection = { ws, id: nextId++, identity: null, epoch: 0, roomCodeQuery,
      replaced: false, closed: false, serial: Promise.resolve(), ping: null, missedPongs: 0,
      rateStart: now(), rateCount: 0 };
    connections.set(ws, conn);
    ws.on("message", data => {
      if (conn.closed || conn.replaced) return;
      if (now() - conn.rateStart >= 1000) { conn.rateStart = now(); conn.rateCount = 0; }
      if (++conn.rateCount > 60) { sendError(conn, "RATE_LIMITED", "操作过于频繁，请稍后重试"); return; }
      const raw = rawToString(data);
      conn.serial = conn.serial.then(() => handle(conn, raw)).catch(error => {
        if (error instanceof LobbyError) sendError(conn, error.code, error.message);
        else sendError(conn, "INVALID_MESSAGE", "请求无法处理");
      });
    });
    ws.on("pong", data => {
      if (conn.ping !== null && conn.ping.equals(data)) { conn.ping = null; conn.missedPongs = 0; }
    });
    ws.on("error", () => undefined);
    ws.on("close", () => disconnected(conn));
  };
  const heartbeatClock = options.heartbeatClock ?? {
    setInterval: (callback: () => void, ms: number): unknown => { const timer = setInterval(callback, ms); timer.unref(); return timer; },
    clearInterval: (handle: unknown): void => clearInterval(handle as ReturnType<typeof setInterval>),
  };
  const heartbeat = heartbeatClock.setInterval(() => {
    for (const conn of connections.values()) {
      if (conn.ping !== null) conn.missedPongs += 1;
      if (conn.missedPongs >= 2) { disconnected(conn); conn.ws.terminate(); continue; }
      if (conn.ws.readyState !== WebSocket.OPEN) continue;
      conn.ping = randomBytes(8);
      conn.ws.ping(conn.ping);
    }
  }, 10000);
  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    let url: URL;
    try { url = new URL(req.url ?? "/", "http://localhost"); }
    catch { socket.destroy(); return; }
    if (url.pathname !== "/ws") { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => init(ws, url.searchParams.get("room")));
  };
  server.on("upgrade", onUpgrade);
  return { connections: () => wss.clients.size, close: () => new Promise<void>(resolve => {
    closing = true;
    server.off("upgrade", onUpgrade);
    heartbeatClock.clearInterval(heartbeat);
    scheduler.close(); unsubscribe();
    for (const client of wss.clients) client.terminate();
    wss.close(() => resolve());
  }) };
}
