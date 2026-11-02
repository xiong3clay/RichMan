import { createHash, randomBytes } from "node:crypto";
import { ROOM_STATE } from "@richman/shared";
import { LobbyError, RoomManager } from "./manager.js";
import type { JoinResult } from "./manager.js";

/** 已认证的服务端身份；网络层只保存此标识与连接 epoch，不保存秘密原文。 */
export interface SessionIdentity {
  roomCode: string;
  playerId: string;
  seatId: number;
}

/** 04 的内存记录；06 可通过同一接口注入持久化存储，原始秘密永不写入。 */
export interface SessionRecord extends SessionIdentity {
  tokenDigest: string;
  recoveryDigest: string;
  connectionEpoch: number;
}

export interface SessionStore {
  getByTokenDigest(digest: string): SessionRecord | undefined;
  getByRecoveryDigest(digest: string): SessionRecord | undefined;
  getByIdentity(roomCode: string, playerId: string): SessionRecord | undefined;
  save(record: SessionRecord): void;
  delete(roomCode: string, playerId: string): void;
}

function identityKey(roomCode: string, playerId: string): string {
  return JSON.stringify([roomCode, playerId]);
}

function digest(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function secret(): string {
  return randomBytes(32).toString("base64url");
}

export class MemorySessionStore implements SessionStore {
  private readonly identities = new Map<string, SessionRecord>();
  private readonly tokens = new Map<string, string>();
  private readonly recoveries = new Map<string, string>();

  getByTokenDigest(value: string): SessionRecord | undefined {
    const key = this.tokens.get(value);
    return this.copy(key === undefined ? undefined : this.identities.get(key));
  }

  getByRecoveryDigest(value: string): SessionRecord | undefined {
    const key = this.recoveries.get(value);
    return this.copy(key === undefined ? undefined : this.identities.get(key));
  }

  getByIdentity(roomCode: string, playerId: string): SessionRecord | undefined {
    return this.copy(this.identities.get(identityKey(roomCode, playerId)));
  }

  save(record: SessionRecord): void {
    this.delete(record.roomCode, record.playerId);
    const key = identityKey(record.roomCode, record.playerId);
    this.identities.set(key, { ...record });
    this.tokens.set(record.tokenDigest, key);
    this.recoveries.set(record.recoveryDigest, key);
  }

  delete(roomCode: string, playerId: string): void {
    const key = identityKey(roomCode, playerId);
    const old = this.identities.get(key);
    if (old === undefined) return;
    this.tokens.delete(old.tokenDigest);
    this.recoveries.delete(old.recoveryDigest);
    this.identities.delete(key);
  }

  private copy(record: SessionRecord | undefined): SessionRecord | undefined {
    return record === undefined ? undefined : { ...record };
  }
}

export interface SessionRegistryOptions {
  store?: SessionStore;
}

export interface ResumeCredentials {
  sessionToken?: string;
  recoveryCode?: string;
}

export class SessionRegistry {
  private readonly store: SessionStore;

  constructor(private readonly manager: RoomManager, options: SessionRegistryOptions = {}) {
    this.store = options.store ?? new MemorySessionStore();
  }

  /** 恢复码只在首次加入时返回一次；与会话 token 使用独立安全随机源取样。 */
  join(roomCode: string, nickname: string): JoinResult & { recoveryCode: string } {
    const result = this.manager.join(roomCode, nickname);
    const recoveryCode = secret();
    this.store.save({
      roomCode,
      playerId: result.playerId,
      seatId: result.seatId,
      tokenDigest: digest(result.sessionToken),
      recoveryDigest: digest(recoveryCode),
      connectionEpoch: 0,
    });
    return { ...result, recoveryCode };
  }

  /** 无效凭证一律拒绝；恢复身份不会新增玩家或触碰游戏状态。 */
  resume(roomCode: string, credentials: ResumeCredentials): JoinResult {
    if (credentials.sessionToken !== undefined) {
      const record = this.store.getByTokenDigest(digest(credentials.sessionToken));
      if (this.validForRoom(record, roomCode)) {
        return this.manager.restoreIdentity(roomCode, record.playerId, credentials.sessionToken);
      }
    }
    if (credentials.recoveryCode !== undefined) {
      const record = this.store.getByRecoveryDigest(digest(credentials.recoveryCode));
      if (this.validForRoom(record, roomCode)) {
        const sessionToken = secret();
        const result = this.manager.restoreIdentity(roomCode, record.playerId, sessionToken);
        this.store.save({ ...record, tokenDigest: digest(sessionToken) });
        return result;
      }
    }
    throw this.unauthorized();
  }

  claim(identity: SessionIdentity): number {
    const record = this.resolve(identity);
    const connectionEpoch = record.connectionEpoch + 1;
    this.store.save({ ...record, connectionEpoch });
    return connectionEpoch;
  }

  isCurrent(identity: SessionIdentity, epoch: number): boolean {
    const record = this.store.getByIdentity(identity.roomCode, identity.playerId);
    return this.validForRoom(record, identity.roomCode)
      && record.seatId === identity.seatId
      && record.connectionEpoch === epoch;
  }

  setReady(identity: SessionIdentity, ready: boolean): void {
    this.resolve(identity);
    this.manager.setReadyFor(identity.roomCode, identity.playerId, ready);
  }

  start(identity: SessionIdentity): string {
    this.resolve(identity);
    return this.manager.startFor(identity.roomCode, identity.playerId);
  }

  disconnect(identity: SessionIdentity): string {
    this.resolve(identity);
    return this.manager.disconnectFor(identity.roomCode, identity.playerId);
  }

  leave(identity: SessionIdentity): string {
    this.resolve(identity);
    const lobby = this.manager.getRoom(identity.roomCode)?.state === ROOM_STATE.LOBBY;
    // 连接由调用方先解绑；大厅主动离开立即撤销 token 与恢复码。
    if (lobby) this.store.delete(identity.roomCode, identity.playerId);
    return this.manager.leaveFor(identity.roomCode, identity.playerId);
  }

  private resolve(identity: SessionIdentity): SessionRecord {
    const record = this.store.getByIdentity(identity.roomCode, identity.playerId);
    if (!this.validForRoom(record, identity.roomCode) || record.seatId !== identity.seatId) {
      throw this.unauthorized();
    }
    return record;
  }

  private validForRoom(record: SessionRecord | undefined, roomCode: string): record is SessionRecord {
    return record !== undefined && record.roomCode === roomCode
      && this.manager.matchesIdentity(roomCode, record.playerId, record.tokenDigest);
  }

  private unauthorized(): LobbyError {
    return new LobbyError("UNAUTHORIZED", "身份凭证与房间不匹配");
  }
}
