import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import {
  DEFAULT_TIMER_MODE,
  NicknameSchema,
  RULES,
  ROOM_STATE,
  SERVER_DEFAULTS,
} from "@richman/shared";
import type { LobbyErrorCode, LobbyPlayer, RoomConfig, RoomState } from "@richman/shared";
import { createInitialState } from "@richman/game-core";
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
  roomCode: string;
  hostId: string | null;
  state: RoomState;
  players: RoomPlayerRecord[];
  gameId: string | null;
  game: EngineState | null;
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
          roomCode: code,
          hostId: null,
          state: ROOM_STATE.LOBBY,
          players: [],
          gameId: null,
          game: null,
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
    if (room.state !== ROOM_STATE.LOBBY) throw new LobbyError("ALREADY_STARTED", "对局已开始");
    if (room.hostId !== player.playerId) throw new LobbyError("NOT_HOST", "只有房主可以开始游戏");
    if (room.players.length < RULES.playerMin) throw new LobbyError("NOT_ENOUGH_PLAYERS", "至少需要 2 名玩家");
    if (!room.players.every((item) => item.ready)) throw new LobbyError("NOT_ALL_READY", "还有玩家未准备");

    const gameId = this.generateGameId();
    const seeds = [...room.players]
      .sort((a, b) => a.seatId - b.seatId)
      .map((item) => ({ nickname: item.nickname }));
    room.gameId = gameId;
    room.game = this.createGameState(gameId, DEFAULT_ROOM_CONFIG, seeds);
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

  private resolve(sessionToken: string): { room: RoomRecord; player: RoomPlayerRecord } {
    const digest = digestToken(sessionToken);
    const roomCode = this.sessions.get(digest);
    const room = roomCode === undefined ? undefined : this.rooms.get(roomCode);
    const player = room?.players.find((item) => item.tokenDigest === digest);
    if (!room || !player) throw new LobbyError("NOT_JOINED", "尚未加入房间");
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
    for (const listener of this.listeners) listener(event);
  }
}
