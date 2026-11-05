import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import {
  DEFAULT_TIMER_MODE,
  NicknameSchema,
  RULES,
  ROOM_STATE,
  SERVER_DEFAULTS,
} from "@richman/shared";
import type { LobbyErrorCode, LobbyPlayer, RoomConfig, RoomState } from "@richman/shared";
import { createInitialState, RULES_VERSION, resumeFromPause } from "@richman/game-core";
import { PROTOCOL_VERSION } from '@richman/shared';
import type { GameEvent, TransitionResult } from '@richman/shared';
import type { RoomSnapshot, RoomStore } from '../storage/types.js';
import { RoomCommitError } from '../storage/types.js';
import type { SessionRecord } from './session.js';
import type { CommandResultRecord } from './command-queue.js';
import type { EngineState } from "@richman/game-core";

const DEFAULT_ROOM_CONFIG: RoomConfig = {
  timerMode: DEFAULT_TIMER_MODE,
  privateDebtAffectsBankLoan: false,
};

/** 大厅/房间层错误：code 供客户端分支，message 给玩家看。 */
export class LobbyError extends Error {
  constructor(
    readonly code: LobbyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LobbyError";
  }
}

export interface RoomView {
  paused: boolean;
  players: LobbyPlayer[];
  hostId: string | null;
  state: RoomState;
}

export interface JoinResult {
  playerId: string;
  seatId: number;
  sessionToken: string;
  roomCode: string;
  room: RoomView;
}

export type RoomManagerEvent =
  | { type: 'storage_error'; roomCode: string; message?: string }
  | { type: "room"; roomCode: string; room: RoomView }
  | { type: "started"; roomCode: string; gameId: string }
  | { type: "peer_left"; roomCode: string; playerId: string };

export interface RoomManagerOptions {
  /** 便于测试断言“开局确实调用了 createInitialState”。 */
  createGameState?: (gameId: string, config: RoomConfig, seeds: Array<{ nickname: string }>) => EngineState;
  /** 房间码生成器；existing 为已占用房间码，便于碰撞重试。 */
  generateRoomCode?: (existing: ReadonlySet<string>) => string;
  generateToken?: () => string;
  generateGameId?: () => string;
}

interface RoomPlayerRecord {
  playerId: string;
  seatId: number;
  nickname: string;
  ready: boolean;
  online: boolean;
  tokenDigest: string;
}

interface RoomRecord {
  paused: boolean;
  sessionRecords: SessionRecord[];
  commands: Map<string, CommandResultRecord>;
  lastEvents: GameEvent[];
  roomCode: string;
  hostId: string | null;
  state: RoomState;
  players: RoomPlayerRecord[];
  gameId: string | null;
  game: EngineState | null;
  usedGameIds: Set<string>;
}

function digestToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function defaultToken(): string {
  // 32 字节 = 256 位熵，base64url 后 43 个字符。
  return randomBytes(32).toString("base64url");
}

function defaultRoomCode(existing: ReadonlySet<string>): string {
  for (let digits = SERVER_DEFAULTS.roomCodeMinDigits; digits <= SERVER_DEFAULTS.roomCodeMaxDigits; digits += 1) {
    const span = 10 ** digits;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      // 补零后是字符串，允许 "0042" 这类前导零房间码。
      const code = String(randomInt(0, span)).padStart(digits, "0");
      if (!existing.has(code)) return code;
    }
  }
  throw new LobbyError("ROOM_FULL", "房间码空间已用尽");
}

/**
 * 单进程内存房间管理（单元 04A）。所有方法同步执行；
 * WebSocket 层负责把同一房间的消息串行化。
 */
export class RoomManager {
  private store: RoomStore | null = null;
  private readonly deferred = new Map<string, RoomManagerEvent[]>();
  private readonly durablePending = new Map<string, RoomSnapshot>();
  setStore(store: RoomStore): void { this.store = store; }
  roomCodes(): string[] { return [...this.rooms.keys()]; }
  isPaused(code: string): boolean { return this.rooms.get(code)?.paused ?? false; }
  pauseRoom(code: string, message: string): void {
    const r = this.rooms.get(code); if (!r || r.paused) return;
    r.paused = true; this.emit({type:'storage_error',roomCode:code,message}); this.emit({type:'room',roomCode:code,room:this.viewOf(r)});
  }
  sessionRecords(): SessionRecord[] { return [...this.rooms.values()].flatMap(r => r.sessionRecords).map(r => ({ ...r })); }
  saveSession(record: SessionRecord): void {
    const room = this.rooms.get(record.roomCode); if (!room) throw new Error('房间不存在');
    room.sessionRecords = [...room.sessionRecords.filter(r => r.playerId !== record.playerId), { ...record }];
  }
  deleteSession(code: string, id: string): void { const r = this.rooms.get(code); if (r) r.sessionRecords = r.sessionRecords.filter(s => s.playerId !== id); }
  getCommand(key: string): CommandResultRecord | undefined {
    const [gameId] = JSON.parse(key) as string[];
    return [...this.rooms.values()].find(r => r.gameId === gameId)?.commands.get(key);
  }
  setCommand(key: string, value: CommandResultRecord): void {
    const [gameId] = JSON.parse(key) as string[];
    const r = [...this.rooms.values()].find(r => r.gameId === gameId);
    if (r) { r.commands.set(key, structuredClone(value)); while (r.commands.size > 5000) r.commands.delete(r.commands.keys().next().value!); }
  }
  exportRoom(code: string): RoomSnapshot | null {
    const r = this.rooms.get(code); if (!r) return null;
    return structuredClone({ schemaVersion: 1, rulesVersion: RULES_VERSION, protocolVersion: PROTOCOL_VERSION,
      savedAt: Date.now(), roomCode: code, hostId: r.hostId, roomState: r.state, paused: r.paused,
      gameId: r.gameId, usedGameIds: [...r.usedGameIds], players: r.players, sessions: r.sessionRecords,
      game: r.game, commands: [...r.commands].map(([key, value]) => ({ key, ...value })), lastEvents: r.lastEvents });
  }
  restoreRoom(s: RoomSnapshot): void {
    for (const [digest, code] of this.sessions) if (code === s.roomCode) this.sessions.delete(digest);
    const copy = structuredClone(s);
    this.rooms.set(s.roomCode, { roomCode: s.roomCode, hostId: copy.hostId, state: copy.roomState,
      paused: copy.paused, gameId: copy.gameId, game: copy.game, players: copy.players,
      usedGameIds: new Set(copy.usedGameIds), sessionRecords: copy.sessions, lastEvents: copy.lastEvents,
      commands: new Map(copy.commands.map(({ key, ...value }) => [key, value])) });
    for (const p of copy.players) this.sessions.set(p.tokenDigest, s.roomCode);
  }
  reconcileDurable(code: string): boolean {
    const pending = this.durablePending.get(code);
    if (pending) { this.restoreRoom({ ...pending, paused: true }); this.durablePending.delete(code); return true; }
    return false;
  }
  private storageFailed(code: string, before: RoomSnapshot | null, error: unknown): never {
    if (before) this.restoreRoom(before); else this.rooms.delete(code);
    if (error instanceof RoomCommitError && error.durable) this.durablePending.set(code, error.durable);
    const r = this.rooms.get(code); if (r) r.paused = true;
    this.emit({ type: 'storage_error', roomCode: code });
    if (r) this.emit({ type: 'room', roomCode: code, room: this.viewOf(r) });
    throw new LobbyError('ERROR_PAUSED', '存档写入失败，本局已暂停，请房主重试或联系管理员');
  }
  async persist(code: string): Promise<void> { const s = this.exportRoom(code); if (this.store && s) await this.store.commitRoom(code, s, []); }
  /** 所有身份/大厅写入共享所在房间队列；提交前缓冲事件，失败恢复完整旧记录。 */
  async transact<T>(code: string, action: () => T, publish?: () => void): Promise<T> {
    this.reconcileDurable(code);
    const before = this.exportRoom(code); this.deferred.set(code, []);
    try {
      const result = action();
      const candidate = this.exportRoom(code);
      // 候选已捕获，await前撤回共享可见态，身份与账务都只在持久成功后发布。
      if (before) this.restoreRoom(before); else this.rooms.delete(code);
      if (this.store) { if (candidate) await this.store.commitRoom(code, candidate, []); else await this.store.deleteRoom(code); }
      if (candidate) this.restoreRoom(candidate); else {
        this.rooms.delete(code); for (const [key, roomCode] of this.sessions) if (roomCode === code) this.sessions.delete(key);
      }
      const events = this.deferred.get(code)!; this.deferred.delete(code);
      publish?.();
      for (const event of events) this.emit(event);
      return result;
    } catch (error) {
      this.deferred.delete(code);
      if (error instanceof LobbyError) { if (before) this.restoreRoom(before); throw error; }
      return this.storageFailed(code, before, error);
    }
  }
  async createRoomPersisted(): Promise<string> {
    const code = this.createRoom();
    try { await this.persist(code); return code; }
    catch { this.rooms.delete(code); throw new LobbyError('ERROR_PAUSED', '存档写入失败，建房未完成'); }
  }
  async commitTransition(code: string, result: TransitionResult, command?: {key: string; record: CommandResultRecord}): Promise<void> {
    const before = this.exportRoom(code); if (!before) throw new Error('房间不存在');
    const candidate = structuredClone(before); candidate.game = result.state as EngineState; candidate.lastEvents = result.events;
    if (command) {
      candidate.commands = [...candidate.commands.filter(c => c.key !== command.key), { key: command.key, ...command.record }].slice(-5000);
    }
    try { if (this.store) await this.store.commitRoom(code, candidate, result.events); }
    catch (error) { this.storageFailed(code, before, error); }
    const r = this.rooms.get(code)!; Object.assign(r.game!, result.state); r.lastEvents = structuredClone(result.events);
    if (command) this.setCommand(command.key, command.record);
  }
  async resumeGame(code: string, id: string, nowMs: number): Promise<GameEvent[]> {
    this.reconcileDurable(code);
    const { room } = this.resolvePlayer(code, id);
    if (room.hostId !== id) throw new LobbyError('NOT_HOST', '只有房主可以继续对局');
    if (!room.paused || room.state !== ROOM_STATE.PLAYING || !room.game) throw new LobbyError('INVALID_STATE', '当前对局不能继续');
    const next = resumeFromPause(room.game, { nowMs });
    const events: GameEvent[] = next === room.game ? [] : [{ seq: next.eventSeq, type: 'GAME_RESUMED', at: new Date(nowMs).toISOString(), payload: { code: 'GAME_RESUMED' } }];
    const before = this.exportRoom(code)!; const candidate = { ...before, paused: false, game: next, lastEvents: events };
    try { if (this.store) await this.store.commitRoom(code, candidate, events); } catch (e) { this.storageFailed(code, before, e); }
    Object.assign(room.game, next); room.paused = false; room.lastEvents = events;
    this.emit({ type: 'room', roomCode: code, room: this.viewOf(room) }); return events;
  }
  private readonly rooms = new Map<string, RoomRecord>();
  private readonly sessions = new Map<string, string>(); // token 摘要 -> roomCode
  private readonly listeners = new Set<(event: RoomManagerEvent) => void>();
  private readonly createGameState: NonNullable<RoomManagerOptions["createGameState"]>;
  private readonly generateRoomCode: NonNullable<RoomManagerOptions["generateRoomCode"]>;
  private readonly generateToken: NonNullable<RoomManagerOptions["generateToken"]>;
  private readonly generateGameId: NonNullable<RoomManagerOptions["generateGameId"]>;

  constructor(options: RoomManagerOptions = {}) {
    this.createGameState =
      options.createGameState ??
      ((gameId, config, seeds) => createInitialState(gameId, config, seeds));
    this.generateRoomCode = options.generateRoomCode ?? defaultRoomCode;
    this.generateToken = options.generateToken ?? defaultToken;
    this.generateGameId = options.generateGameId ?? (() => randomUUID());
  }

  subscribe(listener: (event: RoomManagerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  roomCount(): number {
    return this.rooms.size;
  }

  /** 创建房间并返回 4～8 位数字房间码（字符串，可能带前导零）。 */
  createRoom(): string {
    const existing = new Set(this.rooms.keys());
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const code = this.generateRoomCode(existing);
      if (!existing.has(code)) {
        this.rooms.set(code, {
          paused: false, sessionRecords: [], commands: new Map(), lastEvents: [],
          roomCode: code,
          hostId: null,
          state: ROOM_STATE.LOBBY,
          players: [],
          gameId: null,
          game: null,
          usedGameIds: new Set(),
        });
        return code;
      }
    }
    throw new LobbyError("ROOM_FULL", "无法分配不冲突的房间码");
  }

  getRoom(roomCode: string): RoomView | null {
    const room = this.rooms.get(roomCode);
    return room ? this.viewOf(room) : null;
  }

  /** 开局后的游戏状态；未开局返回 null（供 04B/05 接游戏命令）。 */
  getGame(roomCode: string): EngineState | null {
    return this.rooms.get(roomCode)?.game ?? null;
  }

  /**
   * 加入房间。同名昵称允许；座位由服务端按最小空闲座位分配。
   * 带同一 token 再次加入时返回原座位，不新增玩家。
   */
  join(roomCode: string, nickname: string, sessionToken?: string): JoinResult {
    const room = this.rooms.get(roomCode);
    if (!room) throw new LobbyError("ROOM_NOT_FOUND", "房间码不存在");
    if (!NicknameSchema.safeParse(nickname).success) {
      throw new LobbyError("INVALID_NICKNAME", "昵称需要 1～" + String(SERVER_DEFAULTS.nicknameMaxCodePoints) + " 个字符");
    }

    if (sessionToken !== undefined) {
      const digest = digestToken(sessionToken);
      const existing = room.players.find((player) => player.tokenDigest === digest);
      if (existing) {
        existing.online = true;
        this.emit({ type: "room", roomCode, room: this.viewOf(room) });
        return {
          playerId: existing.playerId,
          seatId: existing.seatId,
          sessionToken,
          roomCode,
          room: this.viewOf(room),
        };
      }
      throw new LobbyError("UNAUTHORIZED", "身份凭证与房间不匹配");
    }

    if (room.state !== ROOM_STATE.LOBBY) throw new LobbyError("ALREADY_STARTED", "对局已开始，不能新加入");
    if (room.players.length >= RULES.playerMax) throw new LobbyError("ROOM_FULL", "房间已满");

    const seatId = this.nextSeat(room);
    const token = this.generateToken();
    const digest = digestToken(token);
    const playerId = "p" + String(seatId);
    const player: RoomPlayerRecord = {
      playerId,
      seatId,
      nickname,
      ready: false,
      online: true,
      tokenDigest: digest,
    };
    room.players.push(player);
    if (room.hostId === null) room.hostId = playerId;
    this.sessions.set(digest, roomCode);
    this.emit({ type: "room", roomCode, room: this.viewOf(room) });
    return { playerId, seatId, sessionToken: token, roomCode, room: this.viewOf(room) };
  }

  setReady(sessionToken: string, ready: boolean): void {
    const { room, player } = this.resolve(sessionToken);
    this.setReadyFor(room.roomCode, player.playerId, ready);
  }

  /** 仅供完成认证的服务端身份层调用，不接受客户端自报的玩家身份。 */
  setReadyFor(roomCode: string, playerId: string, ready: boolean): void {
    const { room, player } = this.resolvePlayer(roomCode, playerId);
    if (room.state !== ROOM_STATE.LOBBY) throw new LobbyError("ALREADY_STARTED", "对局已开始，不能再准备");
    player.ready = ready;
    this.emit({ type: "room", roomCode: room.roomCode, room: this.viewOf(room) });
  }

  /**
   * 房主开局：2～10 人且全部已准备；冻结名单与座位，调用 createInitialState。
   * 只创建状态，不处理任何游戏命令（04A 边界）。
   */
  start(sessionToken: string): string {
    const { room, player } = this.resolve(sessionToken);
    return this.startFor(room.roomCode, player.playerId);
  }

  /** 仅供完成认证的服务端身份层调用。 */
  startFor(roomCode: string, playerId: string): string {
    const { room, player } = this.resolvePlayer(roomCode, playerId);
    if (room.state !== ROOM_STATE.LOBBY) throw new LobbyError("ALREADY_STARTED", "对局已开始");
    if (room.hostId !== player.playerId) throw new LobbyError("NOT_HOST", "只有房主可以开始游戏");
    if (room.players.length < RULES.playerMin) throw new LobbyError("NOT_ENOUGH_PLAYERS", "至少需要 2 名玩家");
    if (!room.players.every((item) => item.ready)) throw new LobbyError("NOT_ALL_READY", "还有玩家未准备");

    return this.createGame(room);
  }

  /** 已认证房主在结算后复用冻结名单；在线状态不影响再开资格。 */
  rematchFor(roomCode: string, playerId: string): string {
    const { room, player } = this.resolvePlayer(roomCode, playerId);
    if (room.hostId !== player.playerId) throw new LobbyError("NOT_HOST", "只有房主可以再来一局");
    if (room.state !== ROOM_STATE.PLAYING || room.game?.phase !== "GAME_OVER") {
      throw new LobbyError("INVALID_STATE", "本局尚未结束，不能再来一局");
    }
    return this.createGame(room);
  }

  private createGame(room: RoomRecord): string {
    const gameId = this.generateGameId();
    // 去重以 gameId 隔离；拒绝复用历史 ID，不能让旧结果污染任何一局。
    if (room.usedGameIds.has(gameId)) throw new LobbyError("INVALID_STATE", "未能生成新的对局标识，请重试");
    const roster = [...room.players].sort((a, b) => a.seatId - b.seatId);
    const seeds = roster.map((item) => ({ nickname: item.nickname }));
    const game = this.createGameState(gameId, DEFAULT_ROOM_CONFIG, seeds);
    // 引擎按输入顺序分配连续座位；大厅离开可能留空洞，必须恢复冻结名单的真实身份。
    game.players = game.players.map((item, index) => {
      const member = roster[index]!;
      return { ...item, playerId: member.playerId, seatId: member.seatId };
    });
    room.gameId = gameId;
    room.commands.clear(); room.lastEvents = []; room.paused = false;
    room.game = game;
    room.usedGameIds.add(gameId);
    room.state = ROOM_STATE.PLAYING;
    this.emit({ type: "room", roomCode: room.roomCode, room: this.viewOf(room) });
    this.emit({ type: "started", roomCode: room.roomCode, gameId });
    return gameId;
  }

  /**
   * 连接断开：只标记离线并广播 peer_left，保留座位。
   * 返回被标记的玩家 ID，便于调用方记录。
   */
  disconnect(sessionToken: string): string {
    const { room, player } = this.resolve(sessionToken);
    return this.disconnectFor(room.roomCode, player.playerId);
  }

  /** 只标离线，保留准备状态与座位；旧连接必须由会话层先检查 epoch。 */
  disconnectFor(roomCode: string, playerId: string): string {
    const { room, player } = this.resolvePlayer(roomCode, playerId);
    player.online = false;
    this.emit({ type: "peer_left", roomCode: room.roomCode, playerId: player.playerId });
    this.emit({ type: "room", roomCode: room.roomCode, room: this.viewOf(room) });
    return player.playerId;
  }

  /**
   * 主动离开：大厅阶段移除座位并转交房主；开局后按断开处理，不删座位。
   */
  leave(sessionToken: string): string {
    const { room, player } = this.resolve(sessionToken);
    return this.leaveFor(room.roomCode, player.playerId);
  }

  /** 仅供完成认证的服务端身份层调用；调用前应先解绑离开者连接。 */
  leaveFor(roomCode: string, playerId: string): string {
    const { room, player } = this.resolvePlayer(roomCode, playerId);
    if (room.state !== ROOM_STATE.LOBBY) {
      player.online = false;
      this.emit({ type: "peer_left", roomCode: room.roomCode, playerId: player.playerId });
      this.emit({ type: "room", roomCode: room.roomCode, room: this.viewOf(room) });
      return player.playerId;
    }

    room.players = room.players.filter((item) => item.playerId !== player.playerId);
    this.sessions.delete(player.tokenDigest);
    if (room.hostId === player.playerId) {
      room.hostId = this.nextPlayerId(room);
    }
    this.emit({ type: "peer_left", roomCode: room.roomCode, playerId: player.playerId });
    if (room.players.length === 0) {
      this.rooms.delete(room.roomCode);
    } else {
      this.emit({ type: "room", roomCode: room.roomCode, room: this.viewOf(room) });
    }
    return player.playerId;
  }

  /**
   * 身份层校验摘要后恢复座位；恢复码签发新 token 时同步撤销旧 token。
   * 不改游戏状态、版本、阶段或截止时间。
   */
  restoreIdentity(roomCode: string, playerId: string, sessionToken: string): JoinResult {
    const { room, player } = this.resolvePlayer(roomCode, playerId);
    this.sessions.delete(player.tokenDigest);
    player.tokenDigest = digestToken(sessionToken);
    this.sessions.set(player.tokenDigest, roomCode);
    player.online = true;
    this.emit({ type: "room", roomCode, room: this.viewOf(room) });
    return { playerId, seatId: player.seatId, sessionToken, roomCode, room: this.viewOf(room) };
  }

  /** 摘要校验使会话存储不会把已离开并被复用的座位误认为旧身份。 */
  matchesIdentity(roomCode: string, playerId: string, tokenDigest: string): boolean {
    return this.rooms.get(roomCode)?.players.some(
      (player) => player.playerId === playerId && player.tokenDigest === tokenDigest,
    ) ?? false;
  }

  private resolve(sessionToken: string): { room: RoomRecord; player: RoomPlayerRecord } {
    const digest = digestToken(sessionToken);
    const roomCode = this.sessions.get(digest);
    const room = roomCode === undefined ? undefined : this.rooms.get(roomCode);
    const player = room?.players.find((item) => item.tokenDigest === digest);
    if (!room || !player) throw new LobbyError("NOT_JOINED", "尚未加入房间");
    return { room, player };
  }

  private resolvePlayer(roomCode: string, playerId: string): { room: RoomRecord; player: RoomPlayerRecord } {
    const room = this.rooms.get(roomCode);
    const player = room?.players.find((item) => item.playerId === playerId);
    if (!room || !player) throw new LobbyError("UNAUTHORIZED", "身份凭证与房间不匹配");
    return { room, player };
  }

  private nextSeat(room: RoomRecord): number {
    const used = new Set(room.players.map((player) => player.seatId));
    for (let seatId = 1; seatId <= RULES.playerMax; seatId += 1) {
      if (!used.has(seatId)) return seatId;
    }
    throw new LobbyError("ROOM_FULL", "房间已满");
  }

  private nextPlayerId(room: RoomRecord): string | null {
    const first = [...room.players].sort((a, b) => a.seatId - b.seatId)[0];
    return first?.playerId ?? null;
  }

  private viewOf(room: RoomRecord): RoomView {
    return {
      paused: room.paused,
      players: [...room.players]
        .sort((a, b) => a.seatId - b.seatId)
        .map((player) => ({
          playerId: player.playerId,
          nickname: player.nickname,
          seatId: player.seatId,
          ready: player.ready,
          online: player.online,
        })),
      hostId: room.hostId,
      state: room.state,
    };
  }

  private emit(event: RoomManagerEvent): void {
    const deferred = this.deferred.get(event.roomCode); if (deferred) { deferred.push(event); return; }
    for (const listener of this.listeners) listener(event);
  }
}
