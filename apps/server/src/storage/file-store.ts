import { mkdir, readFile, readdir, rename, rm, open, cp, lstat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { RULES_VERSION } from '@richman/game-core';
import { PROTOCOL_VERSION, ROOM_STATE, PHASES, MAX_MONEY_CENTS, BOTS_MAX, isBotPersonality } from '@richman/shared';
import { AtomicWriteError, writeSnapshotAtomic } from './atomic.js';
import type { AtomicOptions } from './atomic.js';
import { RoomCommitError, discardPendingDeliveries } from './types.js';
import type { ActivationUndo, RoomSnapshot, RoomStore } from './types.js';
import { ARCHIVE_QUARANTINE_FAILURES, ARCHIVE_RESIDUE_TTL_MS } from './archive-policy.js';
import type { GameEvent } from '@richman/shared';
import { DEFAULT_ARCHIVE_POLICY } from './archive-policy.js';
import type { ArchivePolicy } from './archive-policy.js';

export interface FileStoreOptions extends AtomicOptions {
  appendFailAt?: 'open' | 'writeFile' | 'sync';
  archiveNow?: () => number;
  archivePolicy?: Partial<ArchivePolicy>;
  /** Filesystem boundary for real-copy fault injection. */
  archiveRename?: (from: string, to: string) => Promise<void>;
}

interface ArchiveFile { path: string; size: number; sha256: string }
interface ArchiveManifest {
  schemaVersion: 1;
  roomCode: string;
  archivedAtMs: number;
  files: ArchiveFile[];
}
export interface ArchiveCleanupResult {
  removed: string[];
  failed: Array<{ path: string; message: string }>;
  quarantined: string[];
}

async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

async function archiveFiles(directory: string, prefix = '', fingerprint = true): Promise<ArchiveFile[]> {
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('归档目录无效');
  const files: ArchiveFile[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === 'archive.json') continue;
    const file = path.join(directory, entry.name);
    const relative = prefix + entry.name;
    if (entry.isSymbolicLink()) throw new Error('归档内容不能包含链接');
    if (entry.isDirectory()) files.push(...await archiveFiles(file, relative + '/', fingerprint));
    else if (entry.isFile()) {
      const hash = createHash('sha256');
      let size = (await lstat(file)).size;
      if (fingerprint) {
        size = 0;
        for await (const chunk of createReadStream(file)) { hash.update(chunk); size += chunk.length; }
      }
      files.push({ path: relative, size, sha256: fingerprint ? hash.digest('hex') : '' });
    } else throw new Error('归档内容类型无效');
  }
  return files;
}

async function syncArchiveFiles(directory: string, files: ArchiveFile[]): Promise<void> {
  for (const file of [...files.map(item => item.path), 'archive.json']) {
    const handle = await open(path.join(directory, ...file.split('/')), 'r+');
    try { await handle.sync(); } finally { await handle.close(); }
  }
}

async function writeArchiveJson(file: string, value: unknown): Promise<void> {
  const temporary = path.join(path.dirname(file), '.archive-manifest-' + randomUUID());
  try {
    const handle = await open(temporary, 'wx');
    try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

class UnsupportedSnapshot extends Error {}
const digest = (s: unknown) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
export function validateSnapshot(value: unknown, code: string): RoomSnapshot {
  const s = value as RoomSnapshot;
  if (s?.schemaVersion !== 1 || (s.rulesVersion !== undefined && s.rulesVersion !== RULES_VERSION) ||
    (s.protocolVersion !== undefined && s.protocolVersion !== PROTOCOL_VERSION)) throw new UnsupportedSnapshot('存档版本不兼容');
  if (s.roomCode !== code || !/^\d{4,8}$/.test(code) || !Object.values(ROOM_STATE).includes(s.roomState) ||
    !Array.isArray(s.players) || !Array.isArray(s.sessions) || !Array.isArray(s.commands) || !Array.isArray(s.usedGameIds)) throw new Error('房间结构无效');
  if (s.commands.length > 5000 || !Array.isArray(s.lastEvents) || typeof s.paused !== 'boolean') throw new Error('快照集合无效');
  if ((s.createdAtMs !== undefined && (!Number.isSafeInteger(s.createdAtMs) || s.createdAtMs < 0)) ||
    (s.noHumanSinceMs !== undefined && s.noHumanSinceMs !== null && (!Number.isSafeInteger(s.noHumanSinceMs) || s.noHumanSinceMs < 0)) ||
    (s.pauseStartedAtMs !== undefined && s.pauseStartedAtMs !== null && (!Number.isSafeInteger(s.pauseStartedAtMs) || s.pauseStartedAtMs < 0)) ||
    (s.pauseShifted !== undefined && typeof s.pauseShifted !== 'boolean') ||
    (s.pausedByNoHuman !== undefined && typeof s.pausedByNoHuman !== 'boolean')) throw new Error('生命周期字段无效');
  const ids = new Set(), seats = new Set(), tokens = new Set(), recoveries = new Set();
  const humans = s.players.filter(p => p?.isBot !== true);
  if (s.players.filter(p => p?.isBot === true).length > BOTS_MAX) throw new Error('AI 座位数量超限');
  for (const p of s.players) {
    // AI 座位的 tokenDigest 是不可认领的占位串，不要求 64 位摘要；人类仍必须严格校验。
    const tokenOk = p?.isBot === true
      ? typeof p.tokenDigest === 'string' && p.tokenDigest.length > 0
      : digest(p?.tokenDigest);
    if (!p || typeof p.playerId !== 'string' || typeof p.nickname !== 'string' || !Number.isInteger(p.seatId) || p.seatId < 1 || p.seatId > 10 ||
      (p.isBot !== undefined && typeof p.isBot !== 'boolean') ||
      (p.isBot === true && p.playerId !== 'p' + String(p.seatId)) ||
      (p.isBot === true
        ? (p.botPersonality !== undefined && !isBotPersonality(p.botPersonality))
        : p.botPersonality !== undefined) ||
      !tokenOk || ids.has(p.playerId) || seats.has(p.seatId) || tokens.has(p.tokenDigest)) throw new Error('座位结构无效');
    ids.add(p.playerId); seats.add(p.seatId); tokens.add(p.tokenDigest);
  }
  // 房主必须是真人；纯 AI 房间（真人尚未入座）允许 hostId 为 null。
  if (s.hostId !== null && !humans.some(p => p.playerId === s.hostId)) throw new Error('房主无效');
  if ((humans.length > 0) !== (s.hostId !== null) || s.players.length > 10 ||
    (s.roomState === ROOM_STATE.LOBBY ? s.game !== null || s.gameId !== null : s.game === null || s.gameId === null || s.players.length < 2)) throw new Error('房间状态不一致');
  const sessionIds = new Set();
  for (const r of s.sessions) {
    const p = s.players.find(p => p.playerId === r.playerId);
    if (!p || p.isBot === true || sessionIds.has(r.playerId) || r.roomCode !== code || r.seatId !== p.seatId || r.tokenDigest !== p.tokenDigest ||
      !digest(r.tokenDigest) || !digest(r.recoveryDigest) || recoveries.has(r.recoveryDigest) || tokens.has(r.recoveryDigest) ||
      (r.pendingDelivery !== undefined && typeof r.pendingDelivery !== 'boolean') ||
      (r.pendingDelivery === true && s.roomState !== ROOM_STATE.LOBBY) ||
      !Number.isSafeInteger(r.connectionEpoch) || r.connectionEpoch < 0) throw new Error('身份结构无效');
    sessionIds.add(r.playerId); recoveries.add(r.recoveryDigest);
  }
  if (humans.length !== s.sessions.length) throw new Error('缺少身份记录');
  if (s.game !== null) {
    const g = s.game;
    if (g.gameId !== s.gameId || !s.usedGameIds.includes(g.gameId) || !PHASES.includes(g.phase) || !Number.isSafeInteger(g.version) ||
      !Number.isSafeInteger(g.eventSeq) || typeof g.phaseInstanceId !== 'string' || !Array.isArray(g.players) ||
      !Array.isArray(g.bankLoans) || !Array.isArray(g.privateLoans) || !Array.isArray(g.requests) ||
      !['standard','fast'].includes(g.config?.timerMode) || g.players.length !== s.players.length ||
      (g.deadlineAt !== null && !Number.isFinite(Date.parse(g.deadlineAt)))) throw new Error('引擎结构无效');
    const engineIds = new Set();
    for (const p of g.players) {
      if (!ids.has(p.playerId) || engineIds.has(p.playerId) || !Number.isSafeInteger(p.cents) || Math.abs(p.cents) > MAX_MONEY_CENTS ||
        !s.players.some(r => r.playerId === p.playerId && r.seatId === p.seatId)) throw new Error('名单或金额不匹配');
      engineIds.add(p.playerId);
    }
    const inspectMoney = (v: unknown, key = ''): void => {
      if ((key === 'cents' || key.endsWith('Cents')) && (typeof v !== 'number' || !Number.isSafeInteger(v) || Math.abs(v) > MAX_MONEY_CENTS)) throw new Error('账务金额类型无效');
      if (v && typeof v === 'object') for (const [k,item] of Object.entries(v)) inspectMoney(item,k);
    }; inspectMoney(g);
    const amount = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= MAX_MONEY_CENTS;
    const finiteTime = (v: unknown) => v === null || (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0);
    const validSeat = (v: unknown) => v === null || seats.has(v);
    const seatList = (v: unknown) => Array.isArray(v) && new Set(v).size === v.length && v.every(seat=>seats.has(seat));
    if (!finiteTime(g.windowDeadlineMs) || !finiteTime(g.dangerDeadlineMs) || !validSeat(g.currentSeatId) || !validSeat(g.dangerSeatId) ||
      !seatList(g.taxSeats) || !seatList(g.actedSeats) || !Number.isInteger(g.taxIndex) || g.taxIndex < 0 || g.taxIndex > g.taxSeats.length) throw new Error('阶段窗口或座位无效');
    const loanIds = new Set();
    for (const loan of [...g.bankLoans,...g.privateLoans]) {
      if (typeof loan.loanId !== 'string' || !ids.has(loan.borrowerId) || !amount(loan.principalCents) || !amount(loan.remainingCents) ||
        !Number.isSafeInteger(loan.rateBps) || loan.rateBps < 0 || loan.rateBps > 10000 || !Number.isSafeInteger(loan.issuedRound) ||
        !Number.isSafeInteger(loan.lastInterestRound) || loanIds.has(loan.loanId)) throw new Error('贷款结构无效');
      loanIds.add(loan.loanId);
    }
    for (const loan of g.bankLoans) if (!['ACTIVE','REPAID','DEFAULTED'].includes(loan.status) || !['NORMAL','OVERDRAFT'].includes(loan.origin) ||
      !Number.isSafeInteger(loan.dueRound) || loan.dueRound < loan.issuedRound || !s.players.some(p=>p.playerId===loan.borrowerId&&p.seatId===loan.seatId)) throw new Error('银行贷款结构无效');
    for (const loan of g.privateLoans) if (!ids.has(loan.lenderId) || loan.borrowerId===loan.lenderId || !['ACTIVE','REPAID','BAD_DEBT','FROZEN'].includes(loan.status)) throw new Error('私人贷款结构无效');
    const requestIds = new Set();
    for (const request of g.requests) if (!ids.has(request.borrowerId) || !ids.has(request.lenderId) || !amount(request.principalCents) ||
      !Number.isSafeInteger(request.deadlineMs) || request.deadlineMs < 0 || typeof request.requestId !== 'string' || requestIds.has(request.requestId) ||
      !['PENDING','ACCEPTED','REFUSED','EXPIRED','CANCELLED','FAILED'].includes(request.status)) throw new Error('请求结构无效');
    else requestIds.add(request.requestId);
    if ((g.pendingRequestId !== null && !g.requests.some(r=>r.requestId===g.pendingRequestId&&r.status==='PENDING')) ||
      (g.pendingDueLoanId !== null && !g.bankLoans.some(l=>l.loanId===g.pendingDueLoanId&&l.status==='ACTIVE'))) throw new Error('阶段等待引用无效');
    if (!g.bets || typeof g.bets !== 'object') throw new Error('赌注结构无效');
    for (const [id,bet] of Object.entries(g.bets)) if (!ids.has(id) || !amount(bet.betCents) || ![0,1].includes(bet.guess) || ![1,2].includes(bet.leverage)) throw new Error('赌注结构无效');
  } else if (s.gameId !== null) throw new Error('缺少游戏状态');
  const inspect = (v: unknown, key = ''): void => {
    if (['token','sessionToken','recoveryCode'].includes(key)) throw new Error('存档禁止原文凭证');
    if (typeof v === 'number' && (!Number.isSafeInteger(v) || ((key === 'cents' || key.endsWith('Cents')) && Math.abs(v) > MAX_MONEY_CENTS))) throw new Error('数值无效');
    if (v && typeof v === 'object') for (const [k, item] of Object.entries(v)) inspect(item, k);
  }; inspect(s);
  for (const c of s.commands) {
    const tuple = JSON.parse(c.key) as unknown[];
    if (tuple.length !== 3 || tuple[0] !== s.gameId || !ids.has(tuple[1]) || typeof tuple[2] !== 'string' ||
      !digest(c.payloadHash) || c.reply.gameId !== s.gameId || c.reply.commandId !== tuple[2] || typeof c.reply.outcome?.ok !== 'boolean') throw new Error('命令记录无效');
  }
  for (const event of s.lastEvents) {
    if (!event || !s.game || !Number.isSafeInteger(event.seq) || event.seq < 1 || event.seq > s.game.eventSeq ||
      typeof event.type !== 'string' || !event.type || typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at)) ||
      !Object.hasOwn(event,'payload') || (event.audience !== undefined && (!Array.isArray(event.audience)||!event.audience.every(id=>ids.has(id))))) throw new Error('事件结构无效');
    if (event.type==='BET_SETTLED' && ![0,1].includes((event.payload as {drawResult:number})?.drawResult)) throw new Error('开奖结果无效');
  }
  return s;
}
export class FileRoomStore implements RoomStore {
  readonly root: string;
  readonly options: FileStoreOptions;
  private archiveTail: Promise<void> = Promise.resolve();
  /** 同一归档目录的连续读取失败计数；成功读取或隔离后清零。 */
  private readonly archiveFailures = new Map<string, number>();
  constructor(root: string, options: FileStoreOptions = {}) { this.root = path.resolve(root); this.options = options; }
  private roomDir(code: string) { if (!/^\d{4,8}$/.test(code)) throw new Error('无效房间码'); return path.join(this.root, 'rooms', code); }
  async commitRoom(code: string, snapshot: RoomSnapshot, events: readonly GameEvent[]): Promise<void> {
    validateSnapshot(snapshot, code);
    let renamed = false;
    try {
      await writeSnapshotAtomic(path.join(this.roomDir(code), 'snapshot.json'), snapshot, this.options); renamed = true;
      if (events.length) {
        if (this.options.appendFailAt === 'open') throw new Error('injected append open');
        const h = await open(path.join(this.roomDir(code), 'events.ndjson'), 'a');
        try {
          if (this.options.appendFailAt === 'writeFile') throw new Error('injected append writeFile');
          await h.writeFile(JSON.stringify({ seq: snapshot.game?.eventSeq ?? 0, gameId: snapshot.gameId, at: snapshot.savedAt, events }) + '\n');
          if (this.options.appendFailAt === 'sync') throw new Error('injected append sync');
          await h.sync();
        }
        finally { await h.close(); }
      }
    } catch (error) { throw new RoomCommitError(renamed || (error instanceof AtomicWriteError && error.committed) ? structuredClone(snapshot) : null, error); }
  }
  async deleteRoom(code: string): Promise<void> {
    const tomb = path.join(this.root, '.tmp', 'deleted-' + randomUUID());
    await mkdir(path.dirname(tomb), { recursive: true });
    try { await rename(this.roomDir(code), tomb); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
    await rm(tomb, { recursive: true, force: true }).catch(() => this.warn('已删除房间的回收目录待清理'));
  }
  private undoPath(code: string) { return path.join(this.roomDir(code), 'activation-undo.json'); }
  /** 激活前写补偿记录；专用 backup=false，避免污染 snapshot.bak.json。 */
  async writeActivationUndo(code: string, undo: ActivationUndo): Promise<void> {
    if (undo?.schemaVersion !== 1 || undo.roomCode !== code
      || !Number.isSafeInteger(undo.expectedVersion) || !Number.isSafeInteger(undo.writtenAtMs)) {
      throw new Error('激活补偿记录无效');
    }
    await writeSnapshotAtomic(this.undoPath(code), undo, { backup: false, warn: this.options.warn });
  }
  async deleteActivationUndo(code: string): Promise<void> {
    await rm(this.undoPath(code), { force: true });
  }
  /** 在 loadAll 把真人设为离线前，用原始快照区分未激活与已提交的激活。 */
  private async applyActivationUndo(code: string, snapshot: RoomSnapshot): Promise<RoomSnapshot> {
    const undoPath = this.undoPath(code);
    let raw: string;
    try { raw = await readFile(undoPath, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return snapshot;
      this.warn('房间 ' + code + ' 激活补偿记录读取失败，保留房间并保持暂停');
      snapshot.paused = true;
      return snapshot;
    }
    let undo: ActivationUndo;
    try {
      undo = JSON.parse(raw) as ActivationUndo;
      if (undo?.schemaVersion !== 1 || undo.roomCode !== code || !Number.isSafeInteger(undo.expectedVersion)
        || !Number.isSafeInteger(undo.writtenAtMs)) throw new Error('激活补偿记录无效');
    } catch {
      // 损坏的 undo 不删档：保留记录与房间，供人工修复。
      this.warn('房间 ' + code + ' 激活补偿记录损坏，保留房间并保持暂停');
      snapshot.paused = true;
      return snapshot;
    }
    const joined = snapshot.players.find(player => player.playerId === undo.joinedPlayerId && player.isBot !== true);
    if (snapshot.game === null || snapshot.game.version !== undo.expectedVersion
      || typeof undo.gameId !== 'string' || snapshot.gameId !== undo.gameId
      || snapshot.pausedByNoHuman !== true || joined?.online !== false
      || snapshot.noHumanSinceMs !== undo.noHumanSinceMs) {
      try {
        await this.deleteActivationUndo(code);
        this.warn('房间 ' + code + ' 激活补偿记录已过期，已清理');
      } catch {
        this.warn('房间 ' + code + ' 激活补偿记录已过期，清理失败待重试');
      }
      return snapshot;
    }
    if (undo.beforeGame === null || typeof undo.beforeGame !== 'object') {
      this.warn('房间 ' + code + ' 激活补偿缺少 beforeGame，保留房间并保持暂停');
      snapshot.paused = true;
      return snapshot;
    }
    const restored: RoomSnapshot = {
      ...snapshot,
      game: undo.beforeGame,
      paused: true,
      noHumanSinceMs: undo.noHumanSinceMs,
      pauseStartedAtMs: undo.pauseStartedAtMs,
      pauseShifted: undo.pauseShifted,
      players: snapshot.players.map(player => player.isBot === true ? player : { ...player, online: false }),
    };
    try {
      validateSnapshot(restored, code);
    } catch {
      this.warn('房间 ' + code + ' 激活补偿回滚校验失败，保留原快照和补偿记录并保持暂停');
      snapshot.paused = true;
      return snapshot;
    }
    try {
      await writeSnapshotAtomic(path.join(this.roomDir(code), 'snapshot.json'), restored, this.options);
    } catch {
      this.warn('房间 ' + code + ' 激活补偿回滚写盘失败待重试，保留补偿记录并保持暂停');
      return restored;
    }
    await this.deleteActivationUndo(code).catch(() => this.warn('房间 ' + code + ' 激活补偿回滚已落盘，记录清理失败待重试'));
    this.warn('房间 ' + code + ' 已按激活补偿回滚到 version ' + String(restored.game?.version ?? -1));
    return restored;
  }
  /** Archive operations share a store-wide queue so retention cannot race a restore. */
  private serializeArchive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.archiveTail.then(task);
    this.archiveTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private archivePolicy(): ArchivePolicy {
    const policy = { ...DEFAULT_ARCHIVE_POLICY, ...this.options.archivePolicy };
    for (const value of Object.values(policy)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error('归档保留参数必须为正安全整数');
    }
    return policy;
  }

  private async validateArchive(directory: string, code: string, files?: ArchiveFile[]): Promise<RoomSnapshot> {
    const actualFiles = await archiveFiles(directory);
    if (files && JSON.stringify(actualFiles) !== JSON.stringify(files)) throw new Error('归档文件校验不一致');
    return validateSnapshot(JSON.parse(await readFile(path.join(directory, 'snapshot.json'), 'utf8')), code);
  }

  /** Preserve the full snapshot and journal, including across filesystem boundaries. */
  async archiveRoom(code: string): Promise<void> {
    return this.serializeArchive(async () => {
      const from = this.roomDir(code);
      const archiveRoot = path.join(this.root, 'archive');
      const now = (this.options.archiveNow ?? Date.now)();
      if (!Number.isSafeInteger(now) || now < 0) throw new Error('归档时钟无效');
      const policy = this.archivePolicy();
      const snapshot = validateSnapshot(JSON.parse(await readFile(path.join(from, 'snapshot.json'), 'utf8')), code);
      const files = await archiveFiles(from);
      const manifest: ArchiveManifest = { schemaVersion: 1, roomCode: snapshot.roomCode, archivedAtMs: now, files };
      const fullSize = files.reduce((sum, file) => sum + file.size, 0)
        + Buffer.byteLength(JSON.stringify(manifest, null, 2) + '\n');
      if (fullSize > policy.maxBytes) throw new Error('单个房间超过归档容量上限');
      await writeArchiveJson(path.join(from, 'archive.json'), manifest);
      await mkdir(archiveRoot, { recursive: true });
      let target = path.join(archiveRoot, code);
      while (await exists(target)) target = path.join(archiveRoot, code + '-' + now + '-' + randomUUID());
      const staging = path.join(archiveRoot, '.staging-' + randomUUID());
      const move = this.options.archiveRename ?? rename;
      let copied = false;
      let published = false;
      try {
        try { await move(from, target); published = true; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
          copied = true;
          await cp(from, staging, { recursive: true, errorOnExist: true, force: false });
          await this.validateArchive(staging, code, files);
          await syncArchiveFiles(staging, files);
          await move(staging, target);
          published = true;
        }
        await this.validateArchive(target, code, files);
        if (copied) {
          await this.validateArchive(from, code, files);
          // The tomb stays on the source filesystem. Once renamed, loadAll cannot revive it.
          const tomb = path.join(path.dirname(from), '.archived-source-' + randomUUID());
          await move(from, tomb);
          await rm(tomb, { recursive: true, force: true }).catch(() => this.warn('已归档源目录待清理'));
        }
        this.warn('房间 ' + code + ' 已归档到 ' + target);
      } catch (error) {
        if (published) {
          if (copied) await rm(target, { recursive: true, force: true });
          else await move(target, from);
        }
        throw error;
      } finally {
        await rm(staging, { recursive: true, force: true }).catch(() => this.warn('归档暂存目录待清理'));
      }
      await this.pruneArchives(now).catch(() => this.warn('归档已保存，保留期清理失败，等待下次巡检'));
    });
  }

  /** Administrator entry point. Restored rooms require the normal paused-game resume. */
  async restoreFromArchive(archiveId: string): Promise<RoomSnapshot> {
    return this.serializeArchive(async () => {
      if (!/^\d{4,8}(?:-[a-zA-Z0-9-]+)?$/.test(archiveId)) throw new Error('无效归档编号');
      const source = path.join(this.root, 'archive', archiveId);
      const snapshot = JSON.parse(await readFile(path.join(source, 'snapshot.json'), 'utf8')) as RoomSnapshot;
      const code = snapshot.roomCode;
      const target = this.roomDir(code);
      if (archiveId.split('-')[0] !== code) throw new Error('归档编号与房间不匹配');
      let manifest: ArchiveManifest | undefined;
      try { manifest = JSON.parse(await readFile(path.join(source, 'archive.json'), 'utf8')) as ArchiveManifest; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (manifest && (manifest.schemaVersion !== 1 || manifest.roomCode !== code)) throw new Error('归档清单无效');
      await this.validateArchive(source, code, manifest?.files);
      if (await exists(target)) throw new Error('房间已存在，不能覆盖');
      await mkdir(path.dirname(target), { recursive: true });
      const staging = path.join(path.dirname(target), '.restore-' + randomUUID());
      let published = false;
      try {
        await cp(source, staging, { recursive: true, errorOnExist: true, force: false });
        const copiedFiles = await archiveFiles(staging);
        await this.validateArchive(staging, code, manifest?.files);
        for (const file of copiedFiles) {
          const handle = await open(path.join(staging, ...file.path.split('/')), 'r+');
          try { await handle.sync(); } finally { await handle.close(); }
        }
        snapshot.paused = true;
        snapshot.players.forEach(player => { if (player.isBot !== true) player.online = false; });
        await writeArchiveJson(path.join(staging, 'snapshot.json'), snapshot);
        await rm(path.join(staging, 'archive.json'), { force: true });
        validateSnapshot(snapshot, code);
        await (this.options.archiveRename ?? rename)(staging, target);
        published = true;
        await this.validateArchive(target, code);
      } catch (error) {
        if (published) await rm(target, { recursive: true, force: true });
        throw error;
      } finally { await rm(staging, { recursive: true, force: true }); }
      await rm(source, { recursive: true, force: true }).catch(() => this.warn('已恢复的归档副本待清理'));
      return snapshot;
    });
  }

  async cleanupArchives(nowMs = (this.options.archiveNow ?? Date.now)()): Promise<ArchiveCleanupResult> {
    return this.serializeArchive(() => this.pruneArchives(nowMs));
  }

  private async pruneArchives(nowMs: number): Promise<ArchiveCleanupResult> {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('归档清理时钟无效');
    const policy = this.archivePolicy();
    const archiveRoot = path.join(this.root, 'archive');
    const roomsRoot = path.join(this.root, 'rooms');
    await mkdir(archiveRoot, { recursive: true });
    await mkdir(roomsRoot, { recursive: true });
    const result: ArchiveCleanupResult = { removed: [], failed: [], quarantined: [] };
    // 清理跨盘归档/恢复留下的隐藏残留目录；只处理超过 1 小时的，避免误删进行中的操作。
    for (const root of [archiveRoot, roomsRoot]) {
      let entries;
      try { entries = await readdir(root, { withFileTypes: true }); }
      catch (error) { result.failed.push({ path: root, message: String(error) }); this.warn('残留目录扫描失败，保留 ' + root); continue; }
      for (const entry of entries) {
        if (!entry.isDirectory() || !/^\.(?:archived-source|staging|restore)-/.test(entry.name)) continue;
        const directory = path.join(root, entry.name);
        try {
          const info = await lstat(directory);
          if (nowMs - info.mtimeMs < ARCHIVE_RESIDUE_TTL_MS) continue;
          await rm(directory, { recursive: true, force: true });
          result.removed.push(directory);
        } catch (error) {
          result.failed.push({ path: directory, message: String(error) });
          this.warn('归档残留目录清理失败，保留 ' + entry.name);
        }
      }
    }
    const archives: Array<{ directory: string; archivedAtMs: number; size: number }> = [];
    const archiveNames = new Set(await readdir(archiveRoot));
    for (const directory of this.archiveFailures.keys()) {
      if (!archiveNames.has(path.basename(directory))) this.archiveFailures.delete(directory);
    }
    for (const name of archiveNames) {
      if (!/^\d{4,8}(?:-[a-zA-Z0-9-]+)?$/.test(name)) continue;
      const directory = path.join(archiveRoot, name);
      try {
        let manifest: ArchiveManifest;
        try { manifest = JSON.parse(await readFile(path.join(directory, 'archive.json'), 'utf8')) as ArchiveManifest; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          const code = name.split('-')[0]!;
          await this.validateArchive(directory, code);
          // Old archives lack a reliable archive date. Start a full retention window on first maintenance.
          manifest = { schemaVersion: 1, roomCode: code, archivedAtMs: nowMs, files: await archiveFiles(directory) };
          await writeArchiveJson(path.join(directory, 'archive.json'), manifest);
        }
        if (manifest.schemaVersion !== 1 || !Number.isSafeInteger(manifest.archivedAtMs) || manifest.archivedAtMs < 0) throw new Error('归档清单无效');
        const files = await archiveFiles(directory, '', false);
        const size = files.reduce((sum, file) => sum + file.size, 0) + (await lstat(path.join(directory, 'archive.json'))).size;
        archives.push({ directory, archivedAtMs: manifest.archivedAtMs, size });
        this.archiveFailures.delete(directory);
      } catch (error) {
        const failures = (this.archiveFailures.get(directory) ?? 0) + 1;
        this.archiveFailures.set(directory, failures);
        if (failures >= ARCHIVE_QUARANTINE_FAILURES) {
          try {
            const quarantineRoot = path.join(archiveRoot, '.quarantine');
            await mkdir(quarantineRoot, { recursive: true });
            let target = path.join(quarantineRoot, name);
            if (await exists(target)) target = path.join(quarantineRoot, name + '-' + String(nowMs) + '-' + randomUUID());
            await rename(directory, target);
            result.quarantined.push(target);
            this.archiveFailures.delete(directory);
            this.warn('归档连续读取失败，已隔离到 ' + target);
          } catch (quarantineError) {
            result.failed.push({ path: directory, message: String(quarantineError) });
            this.warn('归档隔离失败，保留 ' + name);
          }
        } else {
          result.failed.push({ path: directory, message: String(error) });
          this.warn('归档清单读取失败，保留 ' + name);
        }
      }
    }
    archives.sort((a, b) => a.archivedAtMs - b.archivedAtMs || a.directory.localeCompare(b.directory));
    let count = archives.length;
    // 隔离区占用计入容量但不参与 FIFO 删除。
    let quarantinedBytes = 0;
    const quarantineRoot = path.join(archiveRoot, '.quarantine');
    try {
      for (const entry of await readdir(quarantineRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        count += 1;
        const directory = path.join(quarantineRoot, entry.name);
        try {
          const files = await archiveFiles(directory, '', false);
          quarantinedBytes += files.reduce((sum, file) => sum + file.size, 0);
          const manifest = await lstat(path.join(directory, 'archive.json')).catch(error => {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          });
          quarantinedBytes += manifest?.size ?? 0;
        } catch { this.warn('隔离归档容量统计不完整 ' + entry.name); }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.warn('隔离区容量统计失败'); }
    let bytes = archives.reduce((sum, archive) => sum + archive.size, 0) + quarantinedBytes;
    for (const archive of archives) {
      if (nowMs - archive.archivedAtMs < policy.retentionMs && count <= policy.maxCount && bytes <= policy.maxBytes) continue;
      try {
        await rm(archive.directory, { recursive: true, force: true });
        result.removed.push(archive.directory);
        count -= 1;
        bytes -= archive.size;
      } catch (error) {
        result.failed.push({ path: archive.directory, message: String(error) });
        this.warn('归档清理失败，保留 ' + path.basename(archive.directory));
      }
    }
    return result;
  }
  warn(message: string) {
    try { (this.options.warn ?? console.warn)(message); }
    catch { /* A diagnostic callback cannot roll back a committed archive. */ }
  }
  async loadAll(): Promise<RoomSnapshot[]> {
    await this.cleanupArchives();
    await mkdir(path.join(this.root, 'rooms'), { recursive: true });
    const result: RoomSnapshot[] = [];
    for (const code of await readdir(path.join(this.root, 'rooms'))) {
      if (!/^\d{4,8}$/.test(code)) continue;
      let s: RoomSnapshot;
      try {
        try { s = validateSnapshot(JSON.parse(await readFile(path.join(this.roomDir(code), 'snapshot.json'), 'utf8')), code); }
        catch (e) {
          if (e instanceof UnsupportedSnapshot) throw e;
          s = validateSnapshot(JSON.parse(await readFile(path.join(this.roomDir(code), 'snapshot.bak.json'), 'utf8')), code);
          this.warn('房间 ' + code + ' 使用备份快照恢复');
          // 坏主文件不能在下次提交时覆盖唯一好bak。先保留坏文件，再从好bak修复权威点。
          try { await rename(path.join(this.roomDir(code),'snapshot.json'),path.join(this.roomDir(code),'invalid-current-' + randomUUID() + '.json')); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          await writeSnapshotAtomic(path.join(this.roomDir(code),'snapshot.json'),s);
        }
      } catch {
        const dest = path.join(this.root, 'rooms', 'corrupt-' + Date.now() + '-' + code + '-' + randomUUID());
        await rename(this.roomDir(code), dest); this.warn('房间 ' + code + ' 存档无效，已隔离到 ' + path.basename(dest)); continue;
      }
      if (discardPendingDeliveries(s)) await writeSnapshotAtomic(path.join(this.roomDir(code),'snapshot.json'),s);
      s = await this.applyActivationUndo(code, s);
      await this.checkAudit(code, s); s.paused = true;
      // AI 座位没有连接，恢复后仍应显示在线；只有真人座位需要等待重连。
      s.players.forEach(p => { if (p.isBot !== true) p.online = false; });
      result.push(s);
    }
    return result;
  }
  private async checkAudit(code: string, snapshot: RoomSnapshot) {
    let last = 0;
    try {
      const content = await readFile(path.join(this.roomDir(code), 'events.ndjson'), 'utf8');
      for (const line of content.split('\n').filter(Boolean)) {
        try {
          const row = JSON.parse(line) as {seq: number; gameId: string; events: GameEvent[]};
          if (row.gameId !== snapshot.gameId || row.seq > (snapshot.game?.eventSeq ?? 0)) continue;
          for (const event of row.events) { if (event.seq !== last + 1) this.warn('房间 ' + code + ' 审计seq断号'); last = event.seq; }
        } catch { this.warn('房间 ' + code + ' 审计行无效，保留快照'); }
      }
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.warn('审计读取失败，保留快照'); }
    if (last < (snapshot.game?.eventSeq ?? 0)) this.warn('房间 ' + code + ' 审计缺行，保留快照');
  }
}
