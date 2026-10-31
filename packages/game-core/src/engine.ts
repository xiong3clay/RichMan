import type {
  GameCommand,
  GameEvent,
  GameState,
  PlayerSeed,
  PlayerView,
  RoomConfig,
  TransitionResult,
  StoredSnapshot,
} from "@richman/shared";
import { CREDIT, PLAYER_STATUS, RULES, PROTOCOL_VERSION } from "@richman/shared";

export const RULES_VERSION = "1.3.2";
export const SNAPSHOT_SCHEMA_VERSION = 1;

export class NotImplementedError extends Error {
  constructor(feature: string) {
    super("尚未实现：" + feature);
    this.name = "NotImplementedError";
  }
}

export function createInitialState(gameId: string, config: RoomConfig, seeds: PlayerSeed[]): GameState {
  if (seeds.length < RULES.playerMin || seeds.length > RULES.playerMax) {
    throw new Error("玩家人数必须在 " + RULES.playerMin + "～" + RULES.playerMax + " 之间");
  }
  const players = seeds.map((seed, index) => ({
    playerId: "p" + (index + 1),
    seatId: index + 1,
    nickname: seed.nickname,
    cents: RULES.startCents,
    credit: CREDIT.GOOD,
    status: PLAYER_STATUS.ALIVE,
    alive: true,
  }));
  return {
    gameId,
    version: 0,
    round: 1,
    phase: "INTEREST",
    phaseInstanceId: "round1-interest",
    config,
    players,
  };
}

/** 规则引擎入口：单元 01～03 逐步实现；现在显式抛出，避免假装可用。 */
export function applyCommand(_state: GameState, _command: GameCommand, _now: Date): TransitionResult {
  throw new NotImplementedError("applyCommand（按 V1.3 在单元 03 实现）");
}

export function getPlayerView(state: GameState, viewerId: string, now: Date, deadlineAt: string | null = null): PlayerView {
  const me = state.players.find((p) => p.playerId === viewerId);
  if (!me) throw new Error("unknown player: " + viewerId);
  return {
    gameId: state.gameId,
    version: state.version,
    round: state.round,
    phase: state.phase,
    serverNow: now.toISOString(),
    deadlineAt,
    me,
    publicPlayers: state.players.map((p) => ({
      playerId: p.playerId,
      seatId: p.seatId,
      nickname: p.nickname,
      credit: p.credit,
      status: p.status,
      alive: p.alive,
    })),
  };
}

export function encodeSnapshot(state: GameState, now: Date): StoredSnapshot {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    rulesVersion: RULES_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    gameId: state.gameId,
    version: state.version,
    updatedAt: now.toISOString(),
    state,
  };
}

export function decodeSnapshot(snapshot: StoredSnapshot): GameState {
  if (snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new Error("存档 schemaVersion 不兼容：" + snapshot.schemaVersion + "，需要迁移");
  }
  return snapshot.state;
}

export type { GameEvent };
