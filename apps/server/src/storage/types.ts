import type { EngineState } from '@richman/game-core';
import type { BotPersonality, GameEvent, RoomState } from '@richman/shared';
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
  players: Array<{playerId: string; seatId: number; nickname: string; ready: boolean; online: boolean; tokenDigest: string; isBot?: boolean; botPersonality?: BotPersonality}>;
  sessions: SessionRecord[];
  game: EngineState | null;
  commands: Array<CommandResultRecord & { key: string }>;
  /** 同提交审计副本（包括开奖结果），恢复不重放。 */
  lastEvents: GameEvent[];
  /** 生命周期时间戳；旧快照缺失时从恢复时刻开始计时。 */
  createdAtMs?: number;
  noHumanSinceMs?: number | null;
  pausedByNoHuman?: boolean;
  pauseStartedAtMs?: number | null;
  pauseShifted?: boolean;
}
export interface RoomStore {
  commitRoom(code: string, snapshot: RoomSnapshot, events: readonly GameEvent[]): Promise<void>;
  deleteRoom(code: string): Promise<void>;
  /** 把 rooms/<code>/ 整体移到 archive/<code>/；不删除存档。 */
  archiveRoom?(code: string): Promise<void>;
  cleanupArchives?(nowMs?: number): Promise<unknown>;
  writeActivationUndo?(code: string, undo: ActivationUndo): Promise<void>;
  deleteActivationUndo?(code: string): Promise<void>;
}

/** 激活前写盘的补偿记录；重启时仅对同局、同版本的未激活快照回滚。 */
export interface ActivationUndo {
  schemaVersion: 1;
  roomCode: string;
  gameId: RoomSnapshot['gameId'];
  joinedPlayerId: string;
  expectedVersion: number;
  beforeGame: EngineState | null;
  noHumanSinceMs: number | null;
  pauseStartedAtMs: number | null;
  pauseShifted: boolean;
  writtenAtMs: number;
}
/** 交付前崩溃的加入不是可恢复身份；保留原房间码，重新选仍有凭据的房主。 */
export function discardPendingDeliveries(snapshot: RoomSnapshot): boolean {
  const pending = new Set(snapshot.sessions.filter(s => s.pendingDelivery).map(s => s.playerId));
  if (!pending.size) return false;
  snapshot.players = snapshot.players.filter(p => !pending.has(p.playerId));
  snapshot.sessions = snapshot.sessions.filter(s => !pending.has(s.playerId));
  if (snapshot.hostId !== null && !snapshot.players.some(p => p.playerId === snapshot.hostId)) {
    // 房主只能由真人接管；只剩 AI 时保持 null，避免把房间交给永不响应的座位。
    snapshot.hostId = [...snapshot.players].filter(p => p.isBot !== true)
      .sort((a,b) => a.seatId-b.seatId)[0]?.playerId ?? null;
  }
  return true;
}
export class RoomCommitError extends Error {
  constructor(readonly durable: RoomSnapshot | null, cause: unknown) { super('存档提交失败', { cause }); }
}
