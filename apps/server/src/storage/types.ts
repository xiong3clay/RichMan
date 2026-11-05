import type { EngineState } from '@richman/game-core';
import type { GameEvent, RoomState } from '@richman/shared';
import type { SessionRecord } from '../rooms/session.js';
import type { CommandResultRecord } from '../rooms/command-queue.js';
export interface RoomSnapshot {
  schemaVersion: 1;
  rulesVersion: string;
  protocolVersion: number;
  savedAt: number;
  roomCode: string;
  hostId: string | null;
  roomState: RoomState;
  paused: boolean;
  gameId: string | null;
  usedGameIds: string[];
  players: Array<{playerId: string; seatId: number; nickname: string; ready: boolean; online: boolean; tokenDigest: string}>;
  sessions: SessionRecord[];
  game: EngineState | null;
  commands: Array<CommandResultRecord & { key: string }>;
  /** 同提交审计副本（包括开奖结果），恢复不重放。 */
  lastEvents: GameEvent[];
}
export interface RoomStore {
  commitRoom(code: string, snapshot: RoomSnapshot, events: readonly GameEvent[]): Promise<void>;
  deleteRoom(code: string): Promise<void>;
}
export class RoomCommitError extends Error {
  constructor(readonly durable: RoomSnapshot | null, cause: unknown) { super('存档提交失败', { cause }); }
}
