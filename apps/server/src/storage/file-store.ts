import { mkdir, readFile, readdir, rename, rm, open } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { RULES_VERSION } from '@richman/game-core';
import { PROTOCOL_VERSION, ROOM_STATE, PHASES, MAX_MONEY_CENTS } from '@richman/shared';
import { AtomicWriteError, writeSnapshotAtomic } from './atomic.js';
import type { AtomicOptions } from './atomic.js';
import { RoomCommitError, discardPendingDeliveries } from './types.js';
import type { RoomSnapshot, RoomStore } from './types.js';
import type { GameEvent } from '@richman/shared';
export interface FileStoreOptions extends AtomicOptions { appendFailAt?: 'open' | 'writeFile' | 'sync'; }
class UnsupportedSnapshot extends Error {}
const digest = (s: unknown) => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
export function validateSnapshot(value: unknown, code: string): RoomSnapshot {
  const s = value as RoomSnapshot;
  if (s?.schemaVersion !== 1 || (s.rulesVersion !== undefined && s.rulesVersion !== RULES_VERSION) ||
    (s.protocolVersion !== undefined && s.protocolVersion !== PROTOCOL_VERSION)) throw new UnsupportedSnapshot('存档版本不兼容');
  if (s.roomCode !== code || !/^\d{4,8}$/.test(code) || !Object.values(ROOM_STATE).includes(s.roomState) ||
    !Array.isArray(s.players) || !Array.isArray(s.sessions) || !Array.isArray(s.commands) || !Array.isArray(s.usedGameIds)) throw new Error('房间结构无效');
  if (s.commands.length > 5000 || !Array.isArray(s.lastEvents) || typeof s.paused !== 'boolean') throw new Error('快照集合无效');
  const ids = new Set(), seats = new Set(), tokens = new Set(), recoveries = new Set();
  for (const p of s.players) {
    if (!p || typeof p.playerId !== 'string' || typeof p.nickname !== 'string' || !Number.isInteger(p.seatId) || p.seatId < 1 || p.seatId > 10 ||
      !digest(p.tokenDigest) || ids.has(p.playerId) || seats.has(p.seatId) || tokens.has(p.tokenDigest)) throw new Error('座位结构无效');
    ids.add(p.playerId); seats.add(p.seatId); tokens.add(p.tokenDigest);
  }
  if (s.hostId !== null && !ids.has(s.hostId)) throw new Error('房主无效');
  if ((s.players.length === 0) !== (s.hostId === null) || s.players.length > 10 ||
    (s.roomState === ROOM_STATE.LOBBY ? s.game !== null || s.gameId !== null : s.game === null || s.gameId === null || s.players.length < 2)) throw new Error('房间状态不一致');
  const sessionIds = new Set();
  for (const r of s.sessions) {
    const p = s.players.find(p => p.playerId === r.playerId);
    if (!p || sessionIds.has(r.playerId) || r.roomCode !== code || r.seatId !== p.seatId || r.tokenDigest !== p.tokenDigest ||
      !digest(r.tokenDigest) || !digest(r.recoveryDigest) || recoveries.has(r.recoveryDigest) || tokens.has(r.recoveryDigest) ||
      (r.pendingDelivery !== undefined && typeof r.pendingDelivery !== 'boolean') ||
      (r.pendingDelivery === true && s.roomState !== ROOM_STATE.LOBBY) ||
      !Number.isSafeInteger(r.connectionEpoch) || r.connectionEpoch < 0) throw new Error('身份结构无效');
    sessionIds.add(r.playerId); recoveries.add(r.recoveryDigest);
  }
  if (s.players.length !== s.sessions.length) throw new Error('缺少身份记录');
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
  warn(message: string) { (this.options.warn ?? console.warn)(message); }
  async loadAll(): Promise<RoomSnapshot[]> {
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
      await this.checkAudit(code, s); s.paused = true; s.players.forEach(p => { p.online = false; }); result.push(s);
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
