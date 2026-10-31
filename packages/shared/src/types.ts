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

export type CommandOutcome = { ok: true } | { ok: false; code: string };

export interface GameEvent {
  seq: number;
  type: string;
  at: string;
  payload: unknown;
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
