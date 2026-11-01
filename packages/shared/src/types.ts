import type { Cents } from "./money.js";

export type GameId = string;
export type PlayerId = string;
export type SeatId = number;
export type CommandId = string;

export const PHASES = [
  "INTEREST",
  "BANK_DUE",
  "ACTION",
  "BETTING",
  "TAX",
  "GAME_OVER",
] as const;
export type Phase = (typeof PHASES)[number];

export const CREDIT = { GOOD: "GOOD", DEFAULTED: "DEFAULTED" } as const;
export type Credit = (typeof CREDIT)[keyof typeof CREDIT];

export const PLAYER_STATUS = { ALIVE: "ALIVE", DANGER: "DANGER", BANKRUPT: "BANKRUPT" } as const;
export type PlayerStatus = (typeof PLAYER_STATUS)[keyof typeof PLAYER_STATUS];

export const ROOM_STATE = { LOBBY: "LOBBY", PLAYING: "PLAYING", PAUSED: "PAUSED", ERROR_PAUSED: "ERROR_PAUSED", ENDED: "ENDED" } as const;
export type RoomState = (typeof ROOM_STATE)[keyof typeof ROOM_STATE];

export interface RoomConfig {
  timerMode: "standard" | "fast";
  privateDebtAffectsBankLoan: boolean; // 已确认 false
}

export interface PlayerSeed {
  nickname: string;
}

export interface PlayerState {
  playerId: PlayerId;
  seatId: SeatId;
  nickname: string;
  cents: Cents;
  credit: Credit;
  status: PlayerStatus;
  alive: boolean;
}

export interface GameState {
  gameId: GameId;
  version: number;
  round: number;
  phase: Phase;
  phaseInstanceId: string;
  /** 审计事件序号：每次产生事件的提交 +1，保证快照 eventSeq 连续。 */
  eventSeq: number;
  /** 当前阶段截止时间（ISO 字符串）；无截止阶段为 null。 */
  deadlineAt: string | null;
  config: RoomConfig;
  players: PlayerState[];
}

export interface GameCommand {
  protocolVersion: number;
  gameId: GameId;
  commandId: CommandId;
  type: string;
  payload: unknown;
  expectedGameVersion?: number;
  roundId?: number;
  phaseInstanceId?: string;
  requestId?: string;
}

import type { ErrorCode } from "./errors.js";

/** 结构化操作结果：code 给程序判断，message 给玩家看，details 放可执行数据（如催收上限 limitCents）。 */
export type CommandOutcome =
  | { ok: true }
  | { ok: false; code: ErrorCode; message: string; details?: Record<string, string | number | boolean | null> };

export interface GameEvent {
  seq: number;
  type: string;
  at: string;
  payload: unknown;
  /** 仅这些玩家可见；缺省表示公开事件。 */
  audience?: PlayerId[];
}

/** 引擎上下文：时间与随机结果都由调用方注入，保证纯函数与可复现测试。 */
export interface CommandContext {
  /** 连接身份对应的玩家；引擎只以此判定操作者，payload.playerId 仅做一致性校验。 */
  actorId: PlayerId;
  nowMs: number;
  /** 本命令需要用到的开奖结果；不需要时为 0，引擎不得自行取随机源。 */
  drawResult: 0 | 1;
}

export interface TransitionResult {
  state: GameState;
  events: GameEvent[];
  outcome: CommandOutcome;
  nextDeadlineAt: string | null;
}

export interface PlayerView {
  gameId: GameId;
  version: number;
  round: number;
  phase: Phase;
  serverNow: string;
  deadlineAt: string | null;
  me: PlayerState;
  publicPlayers: Array<Pick<PlayerState, "playerId" | "seatId" | "nickname" | "credit" | "status" | "alive">>;
}

export interface StoredSnapshot {
  schemaVersion: number;
  rulesVersion: string;
  protocolVersion: number;
  gameId: GameId;
  version: number;
  updatedAt: string;
  state: GameState;
}
