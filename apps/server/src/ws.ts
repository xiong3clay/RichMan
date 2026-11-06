import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { randomBytes, createHash } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import type { RawData } from "ws";
import { ClientGameCommandSchema, ClientLobbyMessageSchema, SERVER_DEFAULTS } from "@richman/shared";
import type { GameEvent, LobbyErrorCode, ServerLobbyMessage, TransitionResult } from "@richman/shared";
import { SNAPSHOT_SCHEMA_VERSION, eventsForPlayer, getPlayerView } from "@richman/game-core";
import type { EngineState } from "@richman/game-core";
import { LobbyError } from "./rooms/manager.js";
import type { RoomManager, RoomManagerEvent } from "./rooms/manager.js";
import { SessionRegistry, SnapshotSessionStore } from "./rooms/session.js";
import type { SessionIdentity, SessionStore } from "./rooms/session.js";
import { GameCommandProcessor, RoomCommandQueue } from "./rooms/command-queue.js";
import type { CommandResultStore, CommandResultRecord } from "./rooms/command-queue.js";
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
  pauseErrors: number;
}
export interface DestroyPeer {
  ws: { readyState: number; close(code?: number, reason?: string): void };
  identity: { roomCode: string } | null;
}

/**
 * S5：按 identity.roomCode + OPEN 收集销毁广播对象，不要求 current。
 * 这样被替换/旧 epoch 但仍在房间上的连接也会收到 room_destroyed 并被关闭。
 */
export function selectDestroyPeers<T extends DestroyPeer>(
  connections: Iterable<T>,
  roomCode: string,
  openState: number,
): T[] {
  return [...connections].filter(
    (peer) => peer.identity !== null && peer.identity.roomCode === roomCode && peer.ws.readyState === openState,
  );
}

/** S5：逐 peer try/finally；单个 send 抛错不阻断后续 detach/close。 */
export function notifyAndCloseDestroyedPeers<T extends DestroyPeer>(
  peers: readonly T[],
  message: ServerLobbyMessage,
  send: (peer: T, message: ServerLobbyMessage) => void,
  detach: (peer: T) => void,
): void {
  for (const peer of peers) {
    try {
      send(peer, message);
    } catch {
      // 单个连接已断开时.send 可能抛错；忽略并继续清理其余连接。
    } finally {
      try { detach(peer); } catch { /* detach 失败也必须尝试关闭 */ }
      try { peer.ws.close(4002, "ROOM_DESTROYED"); } catch { /* 已关闭则忽略 */ }
    }
  }
}

/**
 * 07C 第三轮 S-B：resume 在 bind 前失败时，旧 owner 可能仍 OPEN 且 non-current。
 * 只有“旧 owner 存在且已不再 current”才需要主动释放；供单测锁住四组合。
 */
export function shouldReleaseSupersededOwner(
  previousExists: boolean,
  previousIsCurrent: boolean,
): boolean {
  return previousExists && !previousIsCurrent;
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
  if (code === 'ERROR_PAUSED') conn.pauseErrors++;
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
  const sessions = new SessionRegistry(manager, { store: options.sessionStore ?? new SnapshotSessionStore(manager) });
  const now = options.now ?? (() => Date.now());
  let nextId = 1;
  let closing = false;
  const ownerKey = (identity: SessionIdentity): string => JSON.stringify([identity.roomCode, identity.playerId]);
  const current = (conn: Connection): boolean => !conn.closed && !conn.replaced && conn.identity !== null
    && sessions.isCurrent(conn.identity, conn.epoch) && owners.get(ownerKey(conn.identity)) === conn;
  const reconcileOwners = (code: string): void => {
    const previous = [...owners.values()].filter(owner => owner.identity?.roomCode === code)
      .map(owner => ({ owner, authenticated: current(owner) }));
    if (!manager.reconcileDurable(code)) return;
    // 仅延续提交前仍有效的owner；离开/复用座位后，即使新旧epoch碰巧相同也不能复活旧身份。
    for (const { owner, authenticated } of previous) {
      const record = manager.sessionRecords().find(r => r.roomCode === code && r.playerId === owner.identity!.playerId);
      if (!authenticated || !record || !current(owner)) detach(owner);
    }
  };

  const snapshot = (conn: Connection): void => {
    if (!current(conn)) return;
    const identity = conn.identity!, state = manager.getGame(identity.roomCode);
    if (state === null) return;
    const pendingDueLoan = state.bankLoans.find(loan => loan.loanId === state.pendingDueLoanId);
    send(conn, { type: "snapshot", view: wireCopy({
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      paused: manager.isPaused(identity.roomCode),
      ...getPlayerView(state, identity.playerId, new Date(now())),
      phaseInstanceId: state.phaseInstanceId, eventSeq: state.eventSeq,
      currentSeatId: state.currentSeatId, actedSeats: [...state.actedSeats],
      pendingDueLoanId: pendingDueLoan?.borrowerId === identity.playerId ? pendingDueLoan.loanId : null,
    }) });
  };
  const commit = async (roomCode: string, result: TransitionResult, command?: {key: string; record: CommandResultRecord}): Promise<void> => {
    const state = manager.getGame(roomCode);
    if (state === null || state.gameId !== result.state.gameId) throw new Error("游戏状态不存在");
    await manager.commitTransition(roomCode, result, command);
    for (const conn of connections.values()) {
      if (!current(conn) || conn.identity!.roomCode !== roomCode) continue;
      snapshot(conn);
      const events = visibleEvents(state, result.events, conn.identity!.playerId);
      if (events.length) send(conn, { type: "events", gameId: state.gameId, gameVersion: state.version, events: wireCopy(events) });
    }
    scheduler.schedule(roomCode);
  };
  const scheduler = new RoomScheduler({ queue, getState: code => manager.isPaused(code) ? null : manager.getGame(code), commit, now,
    onError: (_error,code) => manager.pauseRoom(code,'系统推进失败，本局已暂停，请联系管理员') });
  const commandStore: CommandResultStore = options.commandStore ?? { get: key => manager.getCommand(key), set: (key, value) => manager.setCommand(key, value) };
  const processor = new GameCommandProcessor({ queue, getState: code => manager.getGame(code), commit,
    advance: code => scheduler.advanceDue(code), now, store: commandStore, atomicCommit: true, isPaused: code => manager.isPaused(code),
    onInvariant: code => manager.pauseRoom(code,'规则不变量失败，本局已暂停，请联系管理员') });
  const broadcast = (event: RoomManagerEvent): void => {
    for (const conn of connections.values()) {
      if (!current(conn) || conn.identity!.roomCode !== event.roomCode) continue;
      if (event.type === 'storage_error') { sendError(conn, 'ERROR_PAUSED', event.message ?? '存档写入失败，本局已暂停，请房主重试或联系管理员'); continue; }
      if (event.type === "room") send(conn, { type: "room", players: event.room.players, hostId: event.room.hostId, state: event.room.state, paused: event.room.paused });
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
  const bind = (conn: Connection, identity: SessionIdentity & {sessionToken: string}, epoch: number): void => {
    const key = ownerKey(identity), previous = owners.get(key);
    conn.epoch = epoch;
    conn.identity = { roomCode: identity.roomCode, playerId: identity.playerId, seatId: identity.seatId,
      tokenDigest: createHash('sha256').update(identity.sessionToken).digest('hex') };
    owners.set(key, conn);
    if (previous && previous !== conn) {
      previous.replaced = true;
      previous.identity = null;
      sendError(previous, "REPLACED", "这个座位已在另一个页面恢复");
      previous.ws.close(4001, "REPLACED");
    }
  };
  /** S-B：transact(disconnect) 成功后调用；只释放 superseded 旧连接，绝不关闭新 conn。 */
  const releaseSupersededOwner = (joined: SessionIdentity): void => {
    const previous = owners.get(ownerKey(joined));
    if (!shouldReleaseSupersededOwner(previous !== undefined, previous !== undefined && current(previous))) return;
    detach(previous!);
    if (previous!.ws.readyState === WebSocket.OPEN) previous!.ws.close(4001, "REPLACED");
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
      reconcileOwners(roomCode);
      const freshJoin = message.type === 'join' && message.sessionToken === undefined;
      let joined: Awaited<ReturnType<SessionRegistry['join']>> | Awaited<ReturnType<SessionRegistry['resume']>>;
      let epoch: number;
      try {
      ({ joined, epoch } = await manager.transact(roomCode, () => {
      const joined = message.type === "resume" ? sessions.resume(roomCode, message)
        : message.sessionToken !== undefined ? sessions.resume(roomCode, { sessionToken: message.sessionToken })
          : sessions.join(roomCode, message.nickname);
      if (freshJoin) sessions.delivery(joined,true);
      return { joined, epoch: sessions.claim(joined) };
      }));
      } catch (error) { if (freshJoin) await manager.discardUndelivered(roomCode); throw error; }
      if (conn.closed || conn.replaced) {
        if (freshJoin) await manager.discardUndelivered(roomCode);
        else {
          // 06 契约：resume 在 bind 前被中断时只解绑旧 owner，保留其 socket 以便它
          // 继续收到 NOT_JOINED（M1_M2 disconnect_during_recovery 依赖此行为）。
          // identity 已清空，不会进入 destroy_room 的 identity+OPEN 选择；因此这里
          // 不调用 releaseSupersededOwner 的 close 路径。
          const previous = owners.get(ownerKey(joined));
          if (previous && !current(previous)) detach(previous);
          await manager.transact(roomCode, () => sessions.disconnect(joined));
        }
        return;
      }
      const delivered = await new Promise<boolean>(resolve => conn.ws.send(JSON.stringify({ type: "joined", roomCode, playerId: joined.playerId, seatId: joined.seatId,
        sessionToken: joined.sessionToken, connectionEpoch: epoch,
        ...("recoveryCode" in joined ? { recoveryCode: joined.recoveryCode as string } : {}) }), error => resolve(!error)));
      if (freshJoin) {
        if (!delivered || conn.closed) { await manager.discardUndelivered(roomCode); return; }
        try { await manager.transact(roomCode, () => sessions.delivery(joined,false)); }
        catch (error) { await manager.discardUndelivered(roomCode); throw error; }
      }
      if (conn.closed || !delivered) {
        await manager.transact(roomCode, () => sessions.disconnect(joined));
        releaseSupersededOwner(joined);
        return;
      }
      bind(conn, joined, epoch);
      const room = manager.getRoom(roomCode);
      if (room) send(conn, { type: "room", players: room.players, hostId: room.hostId, state: room.state, paused: room.paused });
      snapshot(conn);
      return;
    }
    if (conn.identity) reconcileOwners(conn.identity.roomCode);
    if (!current(conn)) { sendError(conn, "NOT_JOINED", "请先加入房间"); return; }
    const identity = conn.identity!;
    if (message.type === "ready") await manager.transact(identity.roomCode, () => sessions.setReady(identity, message.ready));
    else if (message.type === "leave") { await manager.transact(identity.roomCode, () => sessions.leave(identity), () => { detach(conn); }); }
    else if (message.type === "start" || message.type === "rematch") {
      await manager.transact(identity.roomCode, () => {
        if (message.type === "start") sessions.start(identity); else sessions.rematch(identity);
      });
      await scheduler.advanceDue(identity.roomCode);
      scheduler.schedule(identity.roomCode);
    } else if (message.type === 'resume_game') {
      const events = await manager.resumeGame(identity.roomCode, identity.playerId, now());
      for (const peer of connections.values()) {
        if (!current(peer) || peer.identity!.roomCode !== identity.roomCode) continue;
        snapshot(peer);
        if (events.length) send(peer, { type: 'events', gameId: manager.getGame(identity.roomCode)!.gameId,
          gameVersion: manager.getGame(identity.roomCode)!.version, events });
      }
      scheduler.schedule(identity.roomCode);
    } else if (message.type === "destroy_room") {
      const roomCode = identity.roomCode;
      // 必须先收集 peers：destroyRoom 成功后 sessions 已清空，current() 会全部为 false。
      const peers = selectDestroyPeers(connections.values(), roomCode, WebSocket.OPEN);
      await manager.destroyRoom(roomCode, identity.playerId);
      scheduler.cancelRoom(roomCode);
      notifyAndCloseDestroyedPeers(
        peers,
        { type: "room_destroyed", roomCode, byPlayerId: identity.playerId },
        (peer, destroyed) => send(peer, destroyed),
        detach,
      );
    }
  };
  const handle = async (conn: Connection, raw: string): Promise<void> => {
    if (conn.replaced || conn.closed) return;
    let json: unknown;
    try { json = JSON.parse(raw); }
    catch { sendError(conn, "INVALID_MESSAGE", "消息不是合法JSON"); return; }
    const command = ClientGameCommandSchema.safeParse(json);
    if (command.success) {
      if (conn.identity) reconcileOwners(conn.identity.roomCode);
      if (!current(conn)) { sendError(conn, "NOT_JOINED", "请先加入房间"); return; }
      const identity = conn.identity!, epoch = conn.epoch;
      const versionBefore = manager.getGame(identity.roomCode)?.version;
      let reply;
      try { reply = await processor.execute(identity.roomCode, identity.playerId, command.data,
        () => current(conn) && conn.epoch === epoch); }
      catch (error) {
        if (error instanceof LobbyError) throw error;
        manager.pauseRoom(identity.roomCode,'系统推进失败，本局已暂停，请联系管理员');
        throw new LobbyError('ERROR_PAUSED','系统推进失败，本局已暂停，请联系管理员');
      }
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
    void queue.run(identity.roomCode, async () => {
      if (sessions.isCurrent(identity, epoch) && !owners.has(ownerKey(identity))) await manager.transact(identity.roomCode, () => sessions.disconnect(identity));
    }).catch(() => undefined);
  };
  const init = (ws: WebSocket, roomCodeQuery: string | null): void => {
    const conn: Connection = { ws, id: nextId++, identity: null, epoch: 0, roomCodeQuery,
      replaced: false, closed: false, serial: Promise.resolve(), ping: null, missedPongs: 0,
      rateStart: now(), rateCount: 0, pauseErrors: 0 };
    connections.set(ws, conn);
    ws.on("message", data => {
      if (conn.closed || conn.replaced) return;
      if (now() - conn.rateStart >= 1000) { conn.rateStart = now(); conn.rateCount = 0; }
      if (++conn.rateCount > 60) { sendError(conn, "RATE_LIMITED", "操作过于频繁，请稍后重试"); return; }
      const raw = rawToString(data);
      conn.serial = conn.serial.then(async () => {
        const before = conn.pauseErrors;
        try { await handle(conn, raw); } catch (error) {
        if (error instanceof LobbyError) { if (error.code !== 'ERROR_PAUSED' || conn.pauseErrors === before) sendError(conn, error.code, error.message); }
        else sendError(conn, "INVALID_MESSAGE", "请求无法处理");
        }
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
  return { connections: () => wss.clients.size, close: async () => {
    closing = true;
    server.off("upgrade", onUpgrade);
    heartbeatClock.clearInterval(heartbeat);
    scheduler.close(); unsubscribe();
    for (const client of wss.clients) client.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await queue.drain();
  } };
}
