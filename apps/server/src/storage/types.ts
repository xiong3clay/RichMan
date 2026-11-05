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
/** 交付前崩溃的加入不是可恢复身份；保留原房间码，重新选仍有凭据的房主。 */
export function discardPendingDeliveries(snapshot: RoomSnapshot): boolean {
  const pending = new Set(snapshot.sessions.filter(s => s.pendingDelivery).map(s => s.playerId));
  if (!pending.size) return false;
  snapshot.players = snapshot.players.filter(p => !pending.has(p.playerId));
  snapshot.sessions = snapshot.sessions.filter(s => !pending.has(s.playerId));
  if (!snapshot.players.some(p => p.playerId === snapshot.hostId)) {
    snapshot.hostId = [...snapshot.players].sort((a,b) => a.seatId-b.seatId)[0]?.playerId ?? null;
  }
  return true;
}
export class RoomCommitError extends Error {
  constructor(readonly durable: RoomSnapshot | null, cause: unknown) { super('存档提交失败', { cause }); }
}
