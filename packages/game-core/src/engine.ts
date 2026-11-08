import type {
  Cents,
  CommandContext,
  CommandOutcome,
  ErrorCode,
  GameCommand,
  GameEvent,
  GameState,
  PlayerId,
  PlayerSeed,
  RoomConfig,
  SeatId,
  StoredSnapshot,
  TransitionResult,
} from "@richman/shared";
import {
  CREDIT,
  MAX_MONEY_CENTS,
  PLAYER_STATUS,
  PROTOCOL_VERSION,
  RULES,
  TIMERS,
  MoneyFormatError,
  assertCentsRange,
} from "@richman/shared";
import type { BankLoan, DueDecision } from "./bank.js";
import {
  BankRuleError,
  accrueInterest,
  borrowFromBank,
  repayBankLoan,
  settleDue,
} from "./bank.js";
import type { LoanRequest, PrivateLoan } from "./private-loans.js";
import {
  PrivateLoanRuleError,
  acceptLoanRequest,
  accruePrivateInterest,
  cancelLoanRequest,
  closeRequestsForBankrupt,
  collectPrivateDebt,
  createLoanRequest,
  expireLoanRequest,
  refuseLoanRequest,
  repayPrivateLoan,
  settleBankruptcy,
} from "./private-loans.js";
import type { BetLock, GambleErrorCode } from "./gamble.js";
import { GambleRuleError, settleBet, validateBet } from "./gamble.js";
import { chargeTax, defaultOutstandingBankLoans, taxDueSeats } from "./tax.js";

export const RULES_VERSION = "1.3.2";
export const SNAPSHOT_SCHEMA_VERSION = 1;

export type { BetLock } from "./gamble.js";

/** 引擎在 GameState 之上追加的运行时数据；shared 的类型不改，避免协议层被迫同步改动。 */
interface EngineExtras {
  bankLoans: BankLoan[];
  privateLoans: PrivateLoan[];
  requests: LoanRequest[];
  /** 本轮已完成主要行动的座位。 */
  actedSeats: SeatId[];
  /** 当前行动玩家座位；null 表示本阶段暂无待行动玩家。 */
  currentSeatId: SeatId | null;
  /** BANK_DUE 正在等待决策的贷款。 */
  pendingDueLoanId: string | null;
  /** 仅TAX自救等待窗口使用；ACTION请求由requests独立管理，不阻塞牌桌。 */
  pendingRequestId: string | null;
  /** 当前窗口截止的数值毫秒，与 deadlineAt 同步。 */
  windowDeadlineMs: number | null;
  phaseCounter: number;
  winnerId: PlayerId | null;
  bets: Record<PlayerId, BetLock>;
  /** TAX 开始时的应收税座位快照，按座位升序。 */
  taxSeats: SeatId[];
  /** 已处理到的 taxSeats 下标；危险玩家处理期间停在该人之后。 */
  taxIndex: number;
  /** 当前处于 DANGER 需要自救的座位。 */
  dangerSeatId: SeatId | null;
  /** 自救截止的数值毫秒；等待出借人答复期间也必须保留。 */
  dangerDeadlineMs: number | null;
}

export type EngineState = GameState & EngineExtras;

type RawEngineState = GameState & Partial<EngineExtras>;

/** 命令层面的失败：code 给程序判断，message 给玩家看，details 放可执行数据（如催收上限）。 */
class CommandFailure extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, string | number | boolean | null>;
  readonly stateChanged: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    details?: Record<string, string | number | boolean | null>,
    stateChanged = false,
  ) {
    super(message);
    this.name = "CommandFailure";
    this.code = code;
    this.details = details;
    this.stateChanged = stateChanged;
  }
}

export function createInitialState(gameId: string, config: RoomConfig, seeds: PlayerSeed[]): EngineState {
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
    phaseInstanceId: "round1-interest-1",
    eventSeq: 0,
    deadlineAt: null,
    config,
    players,
    bankLoans: [],
    privateLoans: [],
    requests: [],
    actedSeats: [],
    currentSeatId: null,
    pendingDueLoanId: null,
    pendingRequestId: null,
    windowDeadlineMs: null,
    phaseCounter: 1,
    winnerId: null,
    bets: {},
    taxSeats: [],
    taxIndex: 0,
    dangerSeatId: null,
    dangerDeadlineMs: null,
  };
}

/**
 * 规则引擎入口。纯函数：只使用 ctx 注入的时间与开奖结果，不读系统时钟、不取随机源。
 * 阶段推进（含超时兜底）在命令前后各执行一次，行动与待答复请求全部收口后进入 BETTING。
 */
export function applyCommand(state: GameState, command: GameCommand, ctx: CommandContext): TransitionResult {
  const s = normalizeState(state);
  const events: GameEvent[] = [];
  const baseVersion = state.version;
  let systemChanged = hasLegacyActionPointer(state);
  let handled = false;
  let outcome: CommandOutcome;

  try {
    validateEnvelope(state, command);
    systemChanged = runSystem(s, ctx, events) || systemChanged;
    handleCommand(s, command, ctx, events);
    handled = true;
    outcome = { ok: true };
  } catch (error) {
    outcome = toFailure(error);
    if (outcome.ok === false && outcome.code === "RULE_INVARIANT") {
      // 不变量失败必须保留最后一致状态：不提交任何部分结算。
      const pristine = normalizeState(state);
      return { state: pristine, events: [], outcome, nextDeadlineAt: pristine.deadlineAt };
    }
    if (error instanceof CommandFailure && error.stateChanged) handled = true;
  }

  if (handled) {
    systemChanged = runSystem(s, ctx, events) || systemChanged;
  }
  if (systemChanged || handled) {
    s.version = baseVersion + 1;
  }

  return { state: s, events, outcome, nextDeadlineAt: s.deadlineAt };
}

/**
 * 系统推进入口：服务器计时器到期时调用，不需要伪造客户端命令。
 * 只跑系统动作（超时结算、阶段推进），不接收玩家操作；有状态变化才 +1 version。
 */
export function advanceSystem(state: GameState, ctx: CommandContext): TransitionResult {
  const s = normalizeState(state);
  const events: GameEvent[] = [];
  const baseVersion = state.version;
  let outcome: CommandOutcome = { ok: true };
  let changed = hasLegacyActionPointer(state);
  try {
    changed = runSystem(s, ctx, events) || changed;
    changed = runSystem(s, ctx, events) || changed;
  } catch (error) {
    outcome = toFailure(error);
    if (outcome.ok === false && outcome.code === "RULE_INVARIANT") {
      const pristine = normalizeState(state);
      return { state: pristine, events: [], outcome, nextDeadlineAt: pristine.deadlineAt };
    }
    changed = true;
  }
  if (changed) s.version = baseVersion + 1;
  return { state: s, events, outcome, nextDeadlineAt: s.deadlineAt };
}

/**
 * 进程重启后的继续：只重建当前等待窗口，不执行计息、开奖、税收或阶段推进。
 * 返回值预留一个事件序号；调用方须将同序号的公开 GAME_RESUMED 事件与状态一起提交。
 */
export function resumeFromPause(state: EngineState, ctx: { nowMs: number }): EngineState {
  if (state.phase === "GAME_OVER") return state;

  const s = normalizeState(state);
  const timers = TIMERS[s.config.timerMode];
  let deadlineMs: number | null = null;
  if (s.phase === "ACTION") {
    // 旧等待快照迁移后借款人已行动；只选下一席，不执行系统结算。
    if (s.currentSeatId === null) s.currentSeatId = nextSeat(s);
    if (s.currentSeatId !== null) deadlineMs = ctx.nowMs + timers.actionSec * 1000;
  }
  if (s.phase === "BANK_DUE") deadlineMs = ctx.nowMs + timers.bankDueSec * 1000;
  if (s.phase === "BETTING") deadlineMs = ctx.nowMs + timers.bettingSec * 1000;
  if (s.phase === "TAX" && s.dangerDeadlineMs !== null) {
    s.dangerDeadlineMs = ctx.nowMs + timers.rescueSec * 1000;
    deadlineMs = s.dangerDeadlineMs;
  }

  // ACTION请求续期独立于当前座位行动窗口，不因45秒请求时限压短60秒行动。
  if (s.phase === "ACTION") {
    s.requests = s.requests.map(request => request.status === "PENDING"
      ? { ...request, deadlineMs: ctx.nowMs + timers.requestSec * 1000 } : request);
    if (s.currentSeatId === null) deadlineMs = earliestPendingRequestDeadline(s);
  }
  // TAX保留原有等待窗口与自救总截止关系。
  if (s.phase === "TAX" && s.pendingRequestId !== null && deadlineMs !== null) {
    const request = s.requests.find(
      (item) => item.requestId === s.pendingRequestId && item.status === "PENDING",
    );
    if (request) {
      deadlineMs = Math.min(deadlineMs, ctx.nowMs + timers.requestSec * 1000);
      replaceRequest(s, request.requestId, { ...request, deadlineMs });
    }
  }

  setPhase(s, s.phase, deadlineMs);
  s.version += 1;
  s.eventSeq += 1;
  return s;
}

/* ------------------------------------------------------------------ */
/* 状态归一化、事件、截止时间                                          */
/* ------------------------------------------------------------------ */

function hasLegacyActionPointer(state: GameState): boolean {
  return state.phase === "ACTION" && (state as RawEngineState).pendingRequestId != null;
}

function normalizeState(state: GameState): EngineState {
  const s = structuredClone(state) as RawEngineState;
  s.bankLoans = s.bankLoans ?? [];
  s.privateLoans = s.privateLoans ?? [];
  s.requests = s.requests ?? [];
  s.actedSeats = s.actedSeats ?? [];
  s.currentSeatId = s.currentSeatId ?? null;
  s.pendingDueLoanId = s.pendingDueLoanId ?? null;
  s.pendingRequestId = s.pendingRequestId ?? null;
  s.windowDeadlineMs = s.windowDeadlineMs ?? null;
  s.phaseCounter = s.phaseCounter ?? 1;
  s.winnerId = s.winnerId ?? null;
  s.bets = s.bets ?? {};
  s.taxSeats = s.taxSeats ?? [];
  s.taxIndex = s.taxIndex ?? 0;
  s.dangerSeatId = s.dangerSeatId ?? null;
  s.dangerDeadlineMs = s.dangerDeadlineMs ?? null;
  // 旧ACTION快照的全局等待指针：提交请求的借款人行动已经用掉。
  if (s.phase === "ACTION" && s.pendingRequestId !== null) {
    const request = s.requests.find(item => item.requestId === s.pendingRequestId);
    const borrower = s.players.find(player => player.playerId === request?.borrowerId);
    if (borrower) {
      if (!s.actedSeats.includes(borrower.seatId)) s.actedSeats.push(borrower.seatId);
      if (s.currentSeatId === borrower.seatId) {
        s.currentSeatId = null;
        s.windowDeadlineMs = null;
        s.deadlineAt = null;
      }
    }
    s.pendingRequestId = null;
  }
  return s as EngineState;
}

function emit(
  s: EngineState,
  events: GameEvent[],
  ctx: CommandContext,
  type: string,
  payload: unknown,
  audience?: PlayerId[],
): void {
  s.eventSeq += 1;
  const event: GameEvent = { seq: s.eventSeq, type, at: new Date(ctx.nowMs).toISOString(), payload };
  if (audience) event.audience = audience;
  events.push(event);
}

/** 按玩家过滤事件流：公开事件人人可见，带 audience 的私人金额事件只给当事人。 */
export function eventsForPlayer(events: readonly GameEvent[], playerId: PlayerId): GameEvent[] {
  return events.filter((event) => event.audience === undefined || event.audience.includes(playerId));
}

function setDeadline(s: EngineState, ms: number | null): void {
  s.windowDeadlineMs = ms;
  s.deadlineAt = ms === null ? null : new Date(ms).toISOString();
}

function setPhase(s: EngineState, phase: GameState["phase"], deadlineMs: number | null): void {
  s.phase = phase;
  s.phaseCounter += 1;
  s.phaseInstanceId = `round${s.round}-${phase.toLowerCase()}-${s.phaseCounter}`;
  setDeadline(s, deadlineMs);
}

function actionSec(s: EngineState): number {
  return TIMERS[s.config.timerMode].actionSec;
}

function earliestPendingRequestDeadline(s: EngineState): number | null {
  let deadlineMs: number | null = null;
  for (const request of s.requests) {
    if (request.status === "PENDING") {
      deadlineMs = deadlineMs === null ? request.deadlineMs : Math.min(deadlineMs, request.deadlineMs);
    }
  }
  return deadlineMs;
}

/* ------------------------------------------------------------------ */
/* 系统阶段推进                                                        */
/* ------------------------------------------------------------------ */

function runSystem(s: EngineState, ctx: CommandContext, events: GameEvent[]): boolean {
  let changed = false;
  for (let guard = 0; guard < 1000; guard += 1) {
    if (s.phase === "INTEREST") {
      changed = runInterest(s, ctx, events) || changed;
      setPhase(s, "BANK_DUE", null);
      emit(s, events, ctx, "PHASE_CHANGED", { phase: s.phase, round: s.round, phaseInstanceId: s.phaseInstanceId });
      changed = true;
      continue;
    }

    if (s.phase === "BANK_DUE") {
      if (s.pendingDueLoanId !== null) {
        if (s.windowDeadlineMs !== null && ctx.nowMs >= s.windowDeadlineMs) {
          const loan = s.bankLoans.find(
            (item) => item.loanId === s.pendingDueLoanId && item.status === "ACTIVE",
          );
          if (loan) {
            settleDueLoan(s, loan, "REFUSE", ctx, events, "timeout");
          } else {
            s.pendingDueLoanId = null;
            setDeadline(s, null);
          }
          changed = true;
          continue;
        }
        break;
      }
      const due = findDueLoan(s);
      if (due) {
        const borrower = mustPlayer(s, due.borrowerId);
        // 余额不足时没有可决策空间，直接按“余额不足”失信，不占用决策窗口。
        if (borrower.cents < due.remainingCents) {
          settleDueLoan(s, due, "REPAY", ctx, events, "insufficient_funds");
          changed = true;
          continue;
        }
        s.pendingDueLoanId = due.loanId;
        setDeadline(s, ctx.nowMs + TIMERS[s.config.timerMode].bankDueSec * 1000);
        emit(s, events, ctx, "BANK_DUE_PENDING", { loanId: due.loanId, borrowerId: due.borrowerId });
        changed = true;
        break;
      }
      enterAction(s, ctx, events);
      changed = true;
      continue;
    }

    if (s.phase === "ACTION") {
      // 每笔请求各自超时；不结束任何人的当前行动或重设其窗口。
      for (const request of s.requests) {
        if (request.status === "PENDING" && ctx.nowMs >= request.deadlineMs) {
          replaceRequest(s, request.requestId, expireLoanRequest(request));
          emit(s, events, ctx, "LOAN_REQUEST_EXPIRED", { requestId: request.requestId });
          changed = true;
        }
      }

      if (s.currentSeatId === null) {
        const seat = nextSeat(s);
        if (seat === null) {
          const pendingDeadline = earliestPendingRequestDeadline(s);
          if (pendingDeadline !== null) {
            if (s.windowDeadlineMs !== pendingDeadline) {
              setDeadline(s, pendingDeadline);
              changed = true;
            }
            break;
          }
          enterBetting(s, ctx, events);
          changed = true;
          continue;
        }
        s.currentSeatId = seat;
        setDeadline(s, ctx.nowMs + actionSec(s) * 1000);
        changed = true;
        break;
      }

      if (s.windowDeadlineMs !== null && ctx.nowMs >= s.windowDeadlineMs) {
        const seat = s.currentSeatId;
        finishSeatAction(s);
        emit(s, events, ctx, "ACTION_TIMEOUT", { seatId: seat });
        changed = true;
        continue;
      }
      break;
    }

    if (s.phase === "BETTING") {
      const alive = s.players.filter((player) => player.alive);
      const allSubmitted = alive.every((player) => s.bets[player.playerId] !== undefined);
      const timedOut = s.windowDeadlineMs !== null && ctx.nowMs >= s.windowDeadlineMs;
      if (!allSubmitted && !timedOut) break;
      settleBetting(s, ctx, events);
      changed = true;
      continue;
    }

    if (s.phase === "TAX") {
      if (s.pendingRequestId !== null) {
        const request = s.requests.find((item) => item.requestId === s.pendingRequestId);
        if (!request || request.status !== "PENDING") {
          // 请求已被应答或关闭：等待窗口结束，回到自救总截止。
          s.pendingRequestId = null;
          setDeadline(s, s.dangerDeadlineMs);
          changed = true;
          continue;
        }
        if (ctx.nowMs >= request.deadlineMs) {
          replaceRequest(s, request.requestId, expireLoanRequest(request));
          s.pendingRequestId = null;
          setDeadline(s, s.dangerDeadlineMs);
          emit(s, events, ctx, "LOAN_REQUEST_EXPIRED", { requestId: request.requestId });
          changed = true;
          continue;
        }
        break;
      }

      const danger = dangerPlayerOf(s);
      if (danger !== null) {
        // 任何操作后金币 >= 0 立即结束该玩家自救并继续收税（R08）。
        if (danger.cents >= 0) {
          releaseDanger(s, danger, ctx, events);
          changed = true;
          continue;
        }
        if (s.dangerDeadlineMs !== null && ctx.nowMs >= s.dangerDeadlineMs) {
          bankruptPlayer(s, danger, "timeout", ctx, events);
          changed = true;
          continue;
        }
        break;
      }

      const seat = s.taxSeats[s.taxIndex];
      if (seat === undefined) {
        finishTax(s, ctx, events);
        changed = true;
        continue;
      }
      s.taxIndex += 1;
      const player = s.players.find((item) => item.seatId === seat);
      if (!player || !player.alive) {
        changed = true;
        continue;
      }

      const charged = chargeTax(player.cents, RULES.taxCents);
      player.cents = charged.centsAfter;
      emit(s, events, ctx, "TAX_CHARGED", {
        seatId: seat,
        playerId: player.playerId,
        amountCents: RULES.taxCents,
        centsAfter: player.cents,
      });
      if (charged.danger) {
        player.status = PLAYER_STATUS.DANGER;
        s.dangerSeatId = seat;
        s.dangerDeadlineMs = ctx.nowMs + TIMERS[s.config.timerMode].rescueSec * 1000;
        setDeadline(s, s.dangerDeadlineMs);
        emit(s, events, ctx, "DANGER_STARTED", {
          seatId: seat,
          playerId: player.playerId,
          deadlineAt: s.deadlineAt,
        });
        break;
      }
      changed = true;
      continue;
    }

    break;
  }
  return changed;
}

function runInterest(s: EngineState, ctx: CommandContext, events: GameEvent[]): boolean {
  const beforeBank = s.bankLoans.map((loan) => loan.remainingCents);
  s.bankLoans = accrueInterest(s.bankLoans, s.round);
  const bankChanged = s.bankLoans.some((loan, index) => loan.remainingCents !== beforeBank[index]);

  const beforePrivate = s.privateLoans.map((loan) => loan.remainingCents);
  s.privateLoans = accruePrivateInterest(s.privateLoans, s.round);
  const privateChanged = s.privateLoans.some((loan, index) => loan.remainingCents !== beforePrivate[index]);

  if (bankChanged || privateChanged) {
    emit(s, events, ctx, "INTEREST_ACCRUED", { round: s.round });
    return true;
  }
  return false;
}

/** 到期扫描必须用 dueRound <= round，逾期贷款不能永远卡在 ACTIVE。稳定次序：座位 -> 到期轮 -> loanId。 */
function findDueLoan(s: EngineState): BankLoan | null {
  const due = s.bankLoans
    .filter((loan) => loan.status === "ACTIVE" && loan.dueRound <= s.round)
    .sort((a, b) => a.seatId - b.seatId || a.dueRound - b.dueRound || a.loanId.localeCompare(b.loanId));
  return due[0] ?? null;
}

function enterAction(s: EngineState, ctx: CommandContext, events: GameEvent[]): void {
  s.actedSeats = [];
  s.currentSeatId = null;
  s.pendingRequestId = null;
  setPhase(s, "ACTION", null);
  emit(s, events, ctx, "PHASE_CHANGED", { phase: s.phase, round: s.round, phaseInstanceId: s.phaseInstanceId });
}

function enterBetting(s: EngineState, ctx: CommandContext, events: GameEvent[]): void {
  // 跨阶段/跨轮请求一律作废，不能带进下注。
  for (const request of s.requests) {
    if (request.status === "PENDING") {
      replaceRequest(s, request.requestId, expireLoanRequest(request));
      emit(s, events, ctx, "LOAN_REQUEST_EXPIRED", { requestId: request.requestId });
    }
  }
  s.pendingRequestId = null;
  s.currentSeatId = null;
  s.bets = {};
  setPhase(s, "BETTING", ctx.nowMs + TIMERS[s.config.timerMode].bettingSec * 1000);
  emit(s, events, ctx, "PHASE_CHANGED", { phase: s.phase, round: s.round, phaseInstanceId: s.phaseInstanceId });
}

/**
 * 开奖与结算。先按当前锁定（超时未提交按 0 注/猜 0/一倍补齐）算完全部结果，
 * 再一次性落账；任一不变量失败由 applyCommand 回滚整次提交。
 * 开奖结果只取 ctx.drawResult，引擎不取随机源。
 */
function settleBetting(s: EngineState, ctx: CommandContext, events: GameEvent[]): void {
  const alive = s.players.filter((player) => player.alive).sort((a, b) => a.seatId - b.seatId);
  const drawResult = ctx.drawResult;
  if (drawResult !== 0 && drawResult !== 1) {
    throw new CommandFailure("RULE_INVARIANT", "开奖结果必须是 0 或 1");
  }

  const settled = alive.map((player) => {
    const bet: BetLock = s.bets[player.playerId] ?? { betCents: 0, guess: 0, leverage: 1 };
    return { player, result: settleBet(bet, player.cents, drawResult, player.playerId) };
  });

  const overdrafts = settled
    .filter(({ result }) => result.overdraftCents > 0)
    .map(({ player, result }) =>
      borrowFromBank({
        loanId: `overdraft-r${s.round}-${player.playerId}`,
        borrowerId: player.playerId,
        seatId: player.seatId,
        credit: player.credit,
        goldCents: player.cents,
        amountCents: result.overdraftCents,
        existingLoans: s.bankLoans,
        round: s.round,
        origin: "OVERDRAFT",
      }),
    );

  for (const { player, result } of settled) {
    if (result.deltaCents > 0) {
      creditPlayer(player, result.deltaCents, "下注派彩");
    } else {
      player.cents = result.nextCents;
    }
  }
  for (const overdraft of overdrafts) {
    appendBankLoan(s, overdraft);
  }
  s.bets = {};
  setDeadline(s, null);

  emit(s, events, ctx, "BET_SETTLED", {
    round: s.round,
    drawResult,
    players: settled.map(({ result }) => result),
  });

  if (s.round % RULES.taxEveryRounds === 0) {
    // 本轮应收税座位在进入 TAX 时一次性确定，避免中途破产改变名单顺序。
    s.taxSeats = taxDueSeats(s.players);
    s.taxIndex = 0;
    s.dangerSeatId = null;
    s.dangerDeadlineMs = null;
    s.pendingRequestId = null;
    setPhase(s, "TAX", null);
    emit(s, events, ctx, "PHASE_CHANGED", { phase: s.phase, round: s.round, phaseInstanceId: s.phaseInstanceId });
    return;
  }

  if (alive.length <= 1) {
    s.winnerId = alive[0]?.playerId ?? null;
    setPhase(s, "GAME_OVER", null);
    emit(s, events, ctx, "GAME_OVER", { round: s.round, winnerId: s.winnerId });
    return;
  }

  s.round += 1;
  s.actedSeats = [];
  s.currentSeatId = null;
  s.pendingRequestId = null;
  s.pendingDueLoanId = null;
  setPhase(s, "INTEREST", null);
  emit(s, events, ctx, "ROUND_STARTED", { round: s.round });
}

function nextSeat(s: EngineState): SeatId | null {
  const alive = s.players.filter((player) => player.alive).sort((a, b) => a.seatId - b.seatId);
  const next = alive.find((player) => !s.actedSeats.includes(player.seatId));
  return next?.seatId ?? null;
}

function finishSeatAction(s: EngineState): void {
  if (s.currentSeatId !== null && !s.actedSeats.includes(s.currentSeatId)) {
    s.actedSeats.push(s.currentSeatId);
  }
  s.currentSeatId = null;
  s.pendingRequestId = null;
  setDeadline(s, null);
}

function dangerPlayerOf(s: EngineState): GameState["players"][number] | null {
  if (s.dangerSeatId === null) return null;
  return s.players.find((player) => player.seatId === s.dangerSeatId) ?? null;
}

function releaseDanger(
  s: EngineState,
  player: GameState["players"][number],
  ctx: CommandContext,
  events: GameEvent[],
): void {
  const seatId = s.dangerSeatId;
  player.status = PLAYER_STATUS.ALIVE;
  s.dangerSeatId = null;
  s.dangerDeadlineMs = null;
  setDeadline(s, null);
  emit(s, events, ctx, "DANGER_RESCUED", { seatId, playerId: player.playerId, cents: player.cents });
}

/**
 * 危险自救失败/放弃：破产结算。私人合同按 R09 转坏账/冻结，关闭该玩家相关待处理请求，
 * 未结清银行贷款全部转 DEFAULTED（保留欠款），金币归 0 并退出后续收税。
 */
function bankruptPlayer(
  s: EngineState,
  player: GameState["players"][number],
  reason: "give_up" | "timeout",
  ctx: CommandContext,
  events: GameEvent[],
): void {
  player.alive = false;
  player.status = PLAYER_STATUS.BANKRUPT;
  player.cents = 0;
  player.credit = CREDIT.DEFAULTED;

  s.privateLoans = settleBankruptcy(s.privateLoans, player.playerId);
  s.requests = closeRequestsForBankrupt(s.requests, player.playerId);
  s.pendingRequestId = null;

  const before = new Map(s.bankLoans.map((loan) => [loan.loanId, loan.status]));
  s.bankLoans = defaultOutstandingBankLoans(s.bankLoans, player.playerId);
  for (const loan of s.bankLoans) {
    if (loan.borrowerId !== player.playerId || loan.status !== "DEFAULTED") continue;
    if (before.get(loan.loanId) === "DEFAULTED") continue;
    emit(s, events, ctx, "BANK_LOAN_DEFAULTED", {
      loanId: loan.loanId,
      borrowerId: player.playerId,
      originalCents: loan.remainingCents,
      defaultedAtRound: s.round,
      reason: "bankrupt",
    });
  }

  s.dangerSeatId = null;
  s.dangerDeadlineMs = null;
  setDeadline(s, null);
  emit(s, events, ctx, "PLAYER_BANKRUPT", {
    playerId: player.playerId,
    seatId: player.seatId,
    reason,
    round: s.round,
  });
}

/** 本轮应收税全部处理完才判胜负（R02-7/R08）：即使中途只剩一人，也可能因纳税后全员破产。 */
function finishTax(s: EngineState, ctx: CommandContext, events: GameEvent[]): void {
  s.dangerSeatId = null;
  s.dangerDeadlineMs = null;
  s.pendingRequestId = null;
  setDeadline(s, null);
  emit(s, events, ctx, "TAX_FINISHED", { round: s.round });

  const alive = s.players.filter((player) => player.alive).sort((a, b) => a.seatId - b.seatId);
  if (alive.length <= 1) {
    s.winnerId = alive[0]?.playerId ?? null;
    setPhase(s, "GAME_OVER", null);
    emit(s, events, ctx, "GAME_OVER", { round: s.round, winnerId: s.winnerId });
    return;
  }

  s.round += 1;
  s.actedSeats = [];
  s.currentSeatId = null;
  s.pendingDueLoanId = null;
  setPhase(s, "INTEREST", null);
  emit(s, events, ctx, "ROUND_STARTED", { round: s.round });
}

/* ------------------------------------------------------------------ */
/* 命令分发                                                            */
/* ------------------------------------------------------------------ */

function handleCommand(
  s: EngineState,
  command: GameCommand,
  ctx: CommandContext,
  events: GameEvent[],
): void {
  if (s.phase === "GAME_OVER") {
    throw new CommandFailure("GAME_OVER", "本局已结束，不能再操作");
  }

  const payload = payloadOf(command);

  if (s.phase === "TAX") {
    return handleTaxCommand(s, command, payload, ctx, events);
  }

  if (s.phase === "BETTING") {
    if (command.type !== "SUBMIT_BET") {
      throw new CommandFailure("INVALID_ACTION", "BETTING 阶段只接受下注");
    }
    return handleSubmitBet(s, payload, ctx, events);
  }
  if (command.type === "SUBMIT_BET") {
    throw new CommandFailure("INVALID_ACTION", "只有在 BETTING 阶段可以下注");
  }

  switch (command.type) {
    case "BORROW_BANK":
      return handleBorrowBank(s, payload, ctx, events);
    case "REQUEST_PRIVATE_LOAN":
      return handleRequestPrivateLoan(s, payload, command, ctx, events);
    case "ACCEPT_PRIVATE_LOAN":
      return handleAcceptPrivateLoan(s, payload, command, ctx, events);
    case "REFUSE_PRIVATE_LOAN":
      return handleRefusePrivateLoan(s, payload, ctx, events);
    case "CANCEL_PRIVATE_LOAN":
      return handleCancelPrivateLoan(s, payload, ctx, events);
    case "REPAY_BANK":
      return handleRepayBank(s, payload, ctx, events);
    case "REPAY_PRIVATE":
      return handleRepayPrivate(s, payload, ctx, events);
    case "COLLECT_PRIVATE":
      return handleCollectPrivate(s, payload, ctx, events);
    case "END_ACTION":
      return handleEndAction(s, payload, ctx, events);
    case "BANK_DUE_DECISION":
      return handleBankDueDecision(s, payload, ctx, events);
    default:
      throw new CommandFailure("INVALID_ACTION", `未知命令：${command.type}`);
  }
}

/** 下注只锁定，不动金币；全部存活玩家锁定或超时后才在系统推进里统一结算。 */
function handleSubmitBet(
  s: EngineState,
  payload: Record<string, unknown>,
  ctx: CommandContext,
  events: GameEvent[],
): void {
  const player = mustPlayer(s, actorOf(ctx, payload));
  if (!player.alive) {
    throw new CommandFailure("INVALID_ACTION", "已破产的玩家不能下注");
  }
  if (s.bets[player.playerId] !== undefined) {
    throw new CommandFailure("ALREADY_LOCKED", "本轮下注已锁定，不能修改");
  }

  const bet = validateBet({
    betCents: payload.betCents,
    guess: payload.guess,
    leverage: payload.leverage,
    cents: player.cents,
    credit: player.credit,
  });
  s.bets = { ...s.bets, [player.playerId]: bet };
  // 开奖前事件里也不能带金额、猜测、杠杆，只公布“谁已提交”。
  emit(s, events, ctx, "BET_SUBMITTED", {
    playerId: player.playerId,
    seatId: player.seatId,
    round: s.round,
  });
}

function handleBorrowBank(
  s: EngineState,
  payload: Record<string, unknown>,
  ctx: CommandContext,
  events: GameEvent[],
): void {
  const player = assertTurn(s, actorOf(ctx, payload));
  const amountCents = readPositiveCents(payload, "amountCents");
  if (amountCents > player.cents) {
    throw new CommandFailure("INSUFFICIENT_FUNDS", "金币不足");
  }
  const loan = borrowFromBank({
    loanId: `bank-${player.seatId}-r${s.round}-${s.bankLoans.length}`,
    borrowerId: player.playerId,
    seatId: player.seatId,
    credit: player.credit,
    goldCents: player.cents,
    amountCents,
    existingLoans: s.bankLoans,
    round: s.round,
  });
  const nextCents = creditCents(player.cents, amountCents, "借款入账");
  appendBankLoan(s, loan);
  player.cents = nextCents;
  emit(s, events, ctx, "BANK_LOAN_ISSUED", { loanId: loan.loanId, borrowerId: player.playerId, amountCents });
  finishSeatAction(s);
}

function handleRepayBank(
  s: EngineState,
  payload: Record<string, unknown>,
  ctx: CommandContext,
  events: GameEvent[],
): void {
  const player = assertTurn(s, actorOf(ctx, payload));
  const loan = findLoan(s, readStringField(payload, "loanId"));
  if (loan.borrowerId !== player.playerId) {
    throw new CommandFailure("UNAUTHORIZED", "只能偿还自己的银行贷款");
  }
  const cents = readPositiveCents(payload, "cents");
  if (cents > player.cents) {
    throw new CommandFailure("INSUFFICIENT_FUNDS", "金币不足，不能还款");
  }
  const next = repayBankLoan(loan, cents, s.round);
  replaceBankLoan(s, next);
  player.cents -= cents;
  emit(s, events, ctx, "BANK_LOAN_REPAID", { loanId: loan.loanId, paidCents: cents });
  finishSeatAction(s);
}

/** TAX 阶段只允许当前危险玩家自救，以及被请求出借人的同意/拒绝（R08）。 */
function handleTaxCommand(
  s: EngineState,
  command: GameCommand,
  payload: Record<string, unknown>,
  ctx: CommandContext,
  events: GameEvent[],
): void {
  if (s.pendingRequestId !== null) {
    if (command.type === "ACCEPT_PRIVATE_LOAN") {
      return handleAcceptPrivateLoan(s, payload, command, ctx, events);
    }
    if (command.type === "REFUSE_PRIVATE_LOAN") {
      return handleRefusePrivateLoan(s, payload, ctx, events);
    }
    if (command.type === "CANCEL_PRIVATE_LOAN") {
      return handleCancelPrivateLoan(s, payload, ctx, events);
    }
    if (command.type === "RESCUE_GIVE_UP") {
      return handleRescueGiveUp(s, payload, ctx, events);
    }
    throw new CommandFailure("INVALID_ACTION", "正在等待出借人答复，只能等待或放弃");
  }

  if (dangerPlayerOf(s) === null) {
    throw new CommandFailure("INVALID_ACTION", "当前没有处于危险状态的玩家");
  }

  switch (command.type) {
    case "REQUEST_PRIVATE_LOAN":
      return handleRequestPrivateLoan(s, payload, command, ctx, events);
    case "COLLECT_PRIVATE":
      return handleCollectPrivate(s, payload, ctx, events);
    case "REPAY_PRIVATE":
      return handleRepayPrivate(s, payload, ctx, events);
    case "RESCUE_GIVE_UP":
      return handleRescueGiveUp(s, payload, ctx, events);
    default:
      throw new CommandFailure("INVALID_ACTION", "TAX 阶段只允许危险自救操作");
  }
}

function handleRescueGiveUp(
  s: EngineState,
  payload: Record<string, unknown>,
  ctx: CommandContext,
  events: GameEvent[],
): void {
  if (s.phase !== "TAX") {
    throw new CommandFailure("INVALID_ACTION", `${s.phase} 阶段不允许放弃自救`);
  }
  const player = mustPlayer(s, actorOf(ctx, payload));
  if (s.dangerSeatId !== player.seatId || !player.alive) {
    throw new CommandFailure("NOT_YOUR_TURN", "只有处于危险状态的玩家可以放弃自救");
  }
  bankruptPlayer(s, player, "give_up", ctx, events);
}

function handleRequestPrivateLoan(
  s: EngineState,
  payload: Record<string, unknown>,
  command: GameCommand,
  ctx: CommandContext,
  events: GameEvent[],
): void {
  const rescue = s.phase === "TAX";
  const player = rescue ? assertDangerTurn(s, actorOf(ctx, payload)) : assertTurn(s, actorOf(ctx, payload));
  if (rescue) assertRescueRequestInterval(s, player, ctx);
  // 危险自救的请求截止 = min(发起时刻 + 请求时限, 自救截止)。
  const windowDeadline = rescue
    ? s.dangerDeadlineMs ?? ctx.nowMs + TIMERS[s.config.timerMode].rescueSec * 1000
    : s.windowDeadlineMs ?? ctx.nowMs + actionSec(s) * 1000;
  createPrivateRequest(s, player, payload, command, ctx, events, windowDeadline);
}

/** 自救阶段同一借款人两次请求至少间隔 2 秒，避免靠刷请求拖住税收。 */
function assertRescueRequestInterval(
  s: EngineState,
  player: GameState["players"][number],
  ctx: CommandContext,
): void {
  let latest: LoanRequest | null = null;
  for (const request of s.requests) {
    if (request.borrowerId !== player.playerId) continue;
    if (latest === null || request.createdAtMs > latest.createdAtMs) latest = request;
  }
  if (latest !== null && ctx.nowMs - latest.createdAtMs < 2_000) {
    throw new CommandFailure("INVALID_ACTION", "请求间隔不足 2 秒");
  }
}

function createPrivateRequest(
  s: EngineState,
  player: GameState["players"][number],
  payload: Record<string, unknown>,
  command: GameCommand,
  ctx: CommandContext,
  events: GameEvent[],
  windowDeadline: number,
): void {
  const lenderId = readStringField(payload, "lenderId");
  const lender = mustPlayer(s, lenderId);
  const principalCents = readPositiveCents(payload, "principalCents");
  const rateBps = readRateBps(payload);
  const requestId = command.requestId ?? readOptionalString(payload, "requestId") ?? `req-${command.commandId}`;
  if (s.requests.some((request) => request.requestId === requestId)) {
    throw new CommandFailure("INVALID_ACTION", "请求编号已存在");
  }

  const requestDeadline = ctx.nowMs + TIMERS[s.config.timerMode].requestSec * 1000;
  const deadlineMs = s.phase === "TAX" ? Math.min(requestDeadline, windowDeadline) : requestDeadline;

  const request = createLoanRequest({
    requestId,
    borrowerId: player.playerId,
    lenderId: lender.playerId,
    principalCents,
    rateBps,
    createdRound: s.round,
    nowMs: ctx.nowMs,
    deadlineMs,
    existingRequests: s.requests,
    borrowerCredit: player.credit,
    borrowerDefaultedBankDebtCents: ownDefaultedBankDebtCents(s, player.playerId),
    borrowerAlive: player.alive,
    lenderAlive: lender.alive,
  });
  s.requests = [...s.requests, request];
  if (s.phase === "TAX") {
    s.pendingRequestId = request.requestId;
    setDeadline(s, deadlineMs);
  }
  emit(s, events, ctx, "LOAN_REQUESTED", {
    requestId: request.requestId,
    borrowerId: player.playerId,
    lenderId: lender.playerId,
    principalCents,
    rateBps,
  }, [player.playerId, lender.playerId]);
  if (s.phase === "ACTION") finishSeatAction(s);
}

function handleAcceptPrivateLoan(
  s: EngineState,
  payload: Record<string, unknown>,
  command: GameCommand,
  ctx: CommandContext,
  events: GameEvent[],
): void {
  const rescue = s.phase === "TAX";
  if (!rescue) requireActionPhase(s);
  const actor = mustPlayer(s, actorOf(ctx, payload));
  const requestId = readStringField(payload, "requestId") || command.requestId || "";
  const request = findPendingRequest(s, requestId);
  if (actor.playerId !== request.lenderId) {
    throw new CommandFailure("UNAUTHORIZED", "只有请求指定的出借人可以同意");
  }
  if (ctx.nowMs >= request.deadlineMs) {
    replaceRequest(s, request.requestId, expireLoanRequest(request));
    closeRequestWindow(s, rescue);
    throw new CommandFailure("REQUEST_EXPIRED", "请求已过期", undefined, true);
  }

  const borrower = mustPlayer(s, request.borrowerId);
  const result = acceptLoanRequest(request, {
    lenderId: actor.playerId,
    nowMs: ctx.nowMs,
    lenderCents: actor.cents,
    borrowerCents: borrower.cents,
    lenderAlive: actor.alive,
    borrowerAlive: borrower.alive,
    loanId: `p2p-${request.requestId}-${s.round}`,
    currentRound: s.round,
  });

  replaceRequest(s, request.requestId, result.request);
  if (result.loan) {
    actor.cents = result.lenderCents;
    creditPlayer(borrower, result.loan.principalCents, "私人借款入账");
    s.privateLoans = [...s.privateLoans, result.loan];
    emit(s, events, ctx, "PRIVATE_LOAN_ACCEPTED", {
      requestId: request.requestId,
      loanId: result.loan.loanId,
      principalCents: result.loan.principalCents,
    }, [request.borrowerId, request.lenderId]);
  } else {
    emit(s, events, ctx, "LOAN_REQUEST_CLOSED", {
      requestId: request.requestId,
      status: result.request.status,
    });
  }
  closeRequestWindow(s, rescue);
}

function handleRefusePrivateLoan(
  s: EngineState,
  payload: Record<string, unknown>,
  ctx: CommandContext,
  events: GameEvent[],
): void {
  const rescue = s.phase === "TAX";
  if (!rescue) requireActionPhase(s);
  const actor = mustPlayer(s, actorOf(ctx, payload));
  const request = findPendingRequest(s, readStringField(payload, "requestId"));
  if (actor.playerId !== request.lenderId) {
    throw new CommandFailure("UNAUTHORIZED", "只有请求指定的出借人可以拒绝");
  }
  replaceRequest(s, request.requestId, refuseLoanRequest(request));
  emit(s, events, ctx, "LOAN_REQUEST_CLOSED", { requestId: request.requestId, status: "REFUSED" });
  closeRequestWindow(s, rescue);
}

/**
 * ACTION提交时已用掉借款人行动，答复不触碰当前座位；危险自救只是回到自救总截止，
 * 该玩家仍可继续自救（是否结束由系统在金币 >= 0 时判定）。
 */
function closeRequestWindow(s: EngineState, rescue: boolean): void {
  s.pendingRequestId = null;
  if (rescue) {
    setDeadline(s, s.dangerDeadlineMs);
  }
}

/**
 * 借款人取消自己的待处理请求：ACTION提交时已消耗行动，取消不退还也不结束别人行动；
 * TAX 阶段只是回到自救总截止，自救继续、仍可再次发起。
 */
function handleCancelPrivateLoan(
  s: EngineState,
  payload: Record<string, unknown>,
  ctx: CommandContext,
  events: GameEvent[],
): void {
  const request = findPendingRequest(s, readStringField(payload, "requestId"));
  if (s.phase === "TAX" && s.pendingRequestId !== request.requestId) {
    throw new CommandFailure("INVALID_ACTION", "这个请求当前不在等待窗口");
  }
  const actor = mustPlayer(s, actorOf(ctx, payload));

  if (s.phase === "ACTION") {
    if (actor.playerId !== request.borrowerId) {
      throw new CommandFailure("UNAUTHORIZED", "只有借款人可以取消自己的借款请求");
    }
    replaceRequest(s, request.requestId, cancelLoanRequest(request));
    emit(s, events, ctx, "LOAN_REQUEST_CLOSED", {
      requestId: request.requestId,
      status: "CANCELLED",
    });
    return;
  }

  if (s.phase === "TAX") {
    const danger = dangerPlayerOf(s);
    if (danger === null || danger.playerId !== actor.playerId || actor.playerId !== request.borrowerId) {
      throw new CommandFailure("UNAUTHORIZED", "只有当前危险玩家可以取消自己的借款请求");
    }
    replaceRequest(s, request.requestId, cancelLoanRequest(request));
    emit(s, events, ctx, "LOAN_REQUEST_CLOSED", {
      requestId: request.requestId,
      status: "CANCELLED",
    });
    s.pendingRequestId = null;
    setDeadline(s, s.dangerDeadlineMs);
    return;
  }

  throw new CommandFailure("INVALID_ACTION", `${s.phase} 阶段不能取消借款请求`);
}

function handleRepayPrivate(
  s: EngineState,
  payload: Record<string, unknown>,
  ctx: CommandContext,
  events: GameEvent[],
): void {
  const rescue = s.phase === "TAX";
  const player = rescue ? assertDangerTurn(s, actorOf(ctx, payload)) : assertTurn(s, actorOf(ctx, payload));
  repayPrivateCore(s, player, payload, ctx, events);
  if (!rescue) finishSeatAction(s);
}

function repayPrivateCore(
  s: EngineState,
  player: GameState["players"][number],
  payload: Record<string, unknown>,
  ctx: CommandContext,
  events: GameEvent[],
): void {
  const loan = findPrivateLoan(s, readStringField(payload, "loanId"));
  if (loan.borrowerId !== player.playerId) {
    throw new CommandFailure("UNAUTHORIZED", "只能偿还自己的私人借款");
  }
  const lender = mustPlayer(s, loan.lenderId);
  const cents = readPositiveCents(payload, "cents");
  if (cents > player.cents) {
    throw new CommandFailure("INSUFFICIENT_FUNDS", "金币不足，不能还款");
  }
  const result = repayPrivateLoan(loan, cents, s.round, player.cents, lender.cents);
  creditPlayer(lender, result.paidCents, "私人还款入账");
  replacePrivateLoan(s, result.loan);
  player.cents = result.borrowerCents;
  emit(s, events, ctx, "PRIVATE_LOAN_REPAID", { loanId: loan.loanId, paidCents: cents }, [
    loan.borrowerId,
    loan.lenderId,
  ]);
}

function handleCollectPrivate(
  s: EngineState,
  payload: Record<string, unknown>,
  ctx: CommandContext,
  events: GameEvent[],
): void {
  const rescue = s.phase === "TAX";
  const player = rescue ? assertDangerTurn(s, actorOf(ctx, payload)) : assertTurn(s, actorOf(ctx, payload));
  collectPrivateCore(s, player, payload, ctx, events);
  if (!rescue) finishSeatAction(s);
}

function collectPrivateCore(
  s: EngineState,
  player: GameState["players"][number],
  payload: Record<string, unknown>,
  ctx: CommandContext,
  events: GameEvent[],
): void {
  const loan = findPrivateLoan(s, readStringField(payload, "loanId"));
  if (loan.lenderId !== player.playerId) {
    throw new CommandFailure("UNAUTHORIZED", "只有出借人可以催收");
  }
  const borrower = mustPlayer(s, loan.borrowerId);
  const cents = readPositiveCents(payload, "cents");
  const limitCents = Math.min(loan.remainingCents, Math.max(0, borrower.cents));
  if (cents > limitCents) {
    throw new CommandFailure(
      "INVALID_AMOUNT",
      `催收金额超过可收上限 ${limitCents} 分`,
      { limitCents },
    );
  }
  const result = collectPrivateDebt(loan, cents, s.round, borrower.cents, player.playerId, player.cents);
  creditPlayer(player, result.collectedCents, "催收入账");
  replacePrivateLoan(s, result.loan);
  borrower.cents = result.borrowerCents;
  emit(s, events, ctx, "PRIVATE_DEBT_COLLECTED", { loanId: loan.loanId, collectedCents: cents }, [
    loan.borrowerId,
    loan.lenderId,
  ]);
}

function handleEndAction(
  s: EngineState,
  payload: Record<string, unknown>,
  ctx: CommandContext,
  events: GameEvent[],
): void {
  const player = assertTurn(s, actorOf(ctx, payload));
  emit(s, events, ctx, "ACTION_ENDED", { playerId: player.playerId, seatId: player.seatId });
  finishSeatAction(s);
}

function handleBankDueDecision(
  s: EngineState,
  payload: Record<string, unknown>,
  ctx: CommandContext,
  events: GameEvent[],
): void {
  if (s.phase !== "BANK_DUE" || s.pendingDueLoanId === null) {
    throw new CommandFailure("INVALID_ACTION", "当前没有等待决策的到期贷款");
  }
  const loan = s.bankLoans.find(
    (item) => item.loanId === s.pendingDueLoanId && item.status === "ACTIVE",
  );
  if (!loan) {
    throw new CommandFailure("INVALID_ACTION", "当前没有等待决策的到期贷款");
  }
  const player = mustPlayer(s, actorOf(ctx, payload));
  if (player.playerId !== loan.borrowerId) {
    throw new CommandFailure("UNAUTHORIZED", "只有借款人可以处理这笔到期贷款");
  }
  const decision = payload.decision;
  if (decision !== "REPAY" && decision !== "REFUSE") {
    throw new CommandFailure("INVALID_ACTION", "到期决策只能是 REPAY 或 REFUSE");
  }
  settleDueLoan(s, loan, decision, ctx, events, decision === "REFUSE" ? "refused" : "insufficient_funds");
}

type DueReason = "timeout" | "refused" | "insufficient_funds";

function settleDueLoan(
  s: EngineState,
  loan: BankLoan,
  decision: DueDecision,
  ctx: CommandContext,
  events: GameEvent[],
  reason: DueReason,
): void {
  const borrower = mustPlayer(s, loan.borrowerId);
  const result = settleDue(loan, decision, borrower.cents, s.round);
  if (result.paidCents > 0) {
    borrower.cents -= result.paidCents;
  }
  replaceBankLoan(s, result.loan);
  s.pendingDueLoanId = null;
  setDeadline(s, null);

  if (result.loan.status === "DEFAULTED") {
    borrower.credit = CREDIT.DEFAULTED;
    emit(s, events, ctx, "BANK_LOAN_DEFAULTED", {
      loanId: loan.loanId,
      borrowerId: borrower.playerId,
      originalCents: loan.remainingCents,
      defaultedAtRound: s.round,
      reason,
    });
  } else if (result.loan.status === "REPAID") {
    emit(s, events, ctx, "BANK_LOAN_SETTLED", { loanId: loan.loanId, paidCents: result.paidCents });
  }
}

/* ------------------------------------------------------------------ */
/* 查询与校验辅助                                                      */
/* ------------------------------------------------------------------ */

function requireActionPhase(s: EngineState): void {
  if (s.phase !== "ACTION") {
    throw new CommandFailure("INVALID_ACTION", `${s.phase} 阶段不允许这个操作`);
  }
}

function assertTurn(s: EngineState, playerId: PlayerId): GameState["players"][number] {
  requireActionPhase(s);
  const player = mustPlayer(s, playerId);
  if (s.currentSeatId !== player.seatId) {
    throw new CommandFailure("NOT_YOUR_TURN", "还没轮到你");
  }
  return player;
}

/** 危险自救不受行动次数限制，但同一时刻只允许当前危险玩家操作，且最多一个待处理请求。 */
function assertDangerTurn(s: EngineState, playerId: PlayerId): GameState["players"][number] {
  if (s.phase !== "TAX") {
    throw new CommandFailure("INVALID_ACTION", `${s.phase} 阶段不允许自救操作`);
  }
  if (s.pendingRequestId !== null) {
    throw new CommandFailure("INVALID_ACTION", "正在等待出借人答复，只能等待或放弃");
  }
  const player = mustPlayer(s, playerId);
  if (s.dangerSeatId !== player.seatId || !player.alive) {
    throw new CommandFailure("NOT_YOUR_TURN", "只有处于危险状态的玩家可以自救");
  }
  return player;
}

function mustPlayer(s: EngineState, playerId: PlayerId): GameState["players"][number] {
  const player = s.players.find((item) => item.playerId === playerId);
  if (!player) {
    throw new CommandFailure("UNAUTHORIZED", `未知玩家：${playerId}`);
  }
  return player;
}

function findLoan(s: EngineState, loanId: string): BankLoan {
  const loan = s.bankLoans.find((item) => item.loanId === loanId);
  if (!loan) throw new CommandFailure("INVALID_ACTION", `未知银行贷款：${loanId}`);
  return loan;
}

function findPrivateLoan(s: EngineState, loanId: string): PrivateLoan {
  const loan = s.privateLoans.find((item) => item.loanId === loanId);
  if (!loan) throw new CommandFailure("INVALID_ACTION", `未知私人贷款：${loanId}`);
  return loan;
}

function findPendingRequest(s: EngineState, requestId: string): LoanRequest {
  const request = s.requests.find(
    (item) => item.requestId === requestId && item.status === "PENDING",
  );
  if (!request) throw new CommandFailure("REQUEST_EXPIRED", "请求已结束或不存在");
  return request;
}

function replaceRequest(s: EngineState, requestId: string, next: LoanRequest): void {
  s.requests = s.requests.map((item) => (item.requestId === requestId ? next : item));
}

/** 银行贷款只允许追加；ID 已存在说明上一步生成逻辑出错，必须整次回滚。 */
function appendBankLoan(s: EngineState, loan: BankLoan): void {
  if (s.bankLoans.some((item) => item.loanId === loan.loanId)) {
    throw new CommandFailure("RULE_INVARIANT", `银行贷款 ID 重复：${loan.loanId}`);
  }
  s.bankLoans = [...s.bankLoans, loan];
}

function replaceBankLoan(s: EngineState, next: BankLoan): void {
  const matches = s.bankLoans.filter((item) => item.loanId === next.loanId).length;
  if (matches !== 1) {
    throw new CommandFailure("RULE_INVARIANT", `银行贷款 ID 命中 ${matches} 笔：${next.loanId}`);
  }
  s.bankLoans = s.bankLoans.map((item) => (item.loanId === next.loanId ? next : item));
}

function replacePrivateLoan(s: EngineState, next: PrivateLoan): void {
  s.privateLoans = s.privateLoans.map((item) => (item.loanId === next.loanId ? next : item));
}

/**
 * 统一入账：先算并校验新余额，越界抛 INVALID_AMOUNT；
 * 校验失败时调用方状态不会发生任何变化。
 */
function creditCents(currentCents: Cents, amountCents: Cents, label: string): Cents {
  if (!Number.isSafeInteger(amountCents) || amountCents < 0) {
    throw new CommandFailure("INVALID_AMOUNT", `${label}必须是非负整数分`);
  }
  const nextCents = currentCents + amountCents;
  try {
    assertCentsRange(nextCents, label);
  } catch (error) {
    if (error instanceof MoneyFormatError) {
      throw new CommandFailure("INVALID_AMOUNT", `${label}后余额超出上限`);
    }
    throw error;
  }
  return nextCents;
}

function creditPlayer(
  player: GameState["players"][number],
  amountCents: Cents,
  label: string,
): void {
  player.cents = creditCents(player.cents, amountCents, label);
}

function ownDefaultedBankDebtCents(s: EngineState, playerId: PlayerId): Cents {
  let total = 0;
  for (const loan of s.bankLoans) {
    if (loan.borrowerId === playerId && loan.status === "DEFAULTED") total += loan.remainingCents;
  }
  return total;
}

/* ------------------------------------------------------------------ */
/* 命令载荷解析                                                        */
/* ------------------------------------------------------------------ */

function payloadOf(command: GameCommand): Record<string, unknown> {
  const payload: unknown = command.payload;
  if (payload === null || typeof payload !== "object") return {};
  return payload as Record<string, unknown>;
}

/**
 * 操作者只来自连接身份 ctx.actorId；payload.playerId 仅做一致性校验，
 * 伪造他人 playerId 一律 UNAUTHORIZED，不能凭载荷冒充。
 */
function actorOf(ctx: CommandContext, payload: Record<string, unknown>): PlayerId {
  const claimed = payload.playerId;
  if (claimed !== undefined && claimed !== ctx.actorId) {
    throw new CommandFailure("UNAUTHORIZED", "命令操作者与连接身份不一致");
  }
  return ctx.actorId;
}

function readPositiveCents(payload: Record<string, unknown>, key: string): Cents {
  const value = payload[key];
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > MAX_MONEY_CENTS) {
    throw new CommandFailure("INVALID_AMOUNT", `${key} 必须是 (0, MAX_MONEY_CENTS] 内的整数分`);
  }
  return value as number;
}

function readRateBps(payload: Record<string, unknown>): number {
  const value = payload.rateBps;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 10_000) {
    throw new CommandFailure("INVALID_AMOUNT", "利率必须是 0～10000 的整数基点");
  }
  return value as number;
}

function readStringField(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new CommandFailure("INVALID_ACTION", `命令缺少 ${key}`);
  }
  return value;
}

function readOptionalString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/* ------------------------------------------------------------------ */
/* 失败映射                                                            */
/* ------------------------------------------------------------------ */

function validateEnvelope(state: GameState, command: GameCommand): void {
  if (command.protocolVersion !== PROTOCOL_VERSION) {
    throw new CommandFailure("INVALID_ACTION", "协议版本不匹配");
  }
  if (command.gameId !== state.gameId) {
    throw new CommandFailure("UNAUTHORIZED", "命令与当前对局不匹配");
  }
  if (command.expectedGameVersion !== undefined && command.expectedGameVersion !== state.version) {
    throw new CommandFailure("VERSION_CONFLICT", "状态已变化，请确认后重试");
  }
  if (command.roundId !== undefined && command.roundId !== state.round) {
    throw new CommandFailure("INVALID_ACTION", "命令属于已结束的轮次");
  }
  if (command.phaseInstanceId !== undefined && command.phaseInstanceId !== state.phaseInstanceId) {
    throw new CommandFailure("VERSION_CONFLICT", "阶段已变化，请重试");
  }
}

function toFailure(error: unknown): CommandOutcome {
  if (error instanceof CommandFailure) {
    return error.details
      ? { ok: false, code: error.code, message: error.message, details: error.details }
      : { ok: false, code: error.code, message: error.message };
  }
  if (error instanceof BankRuleError) {
    return { ok: false, code: mapBankCode(error.code), message: error.message };
  }
  if (error instanceof PrivateLoanRuleError) {
    return { ok: false, code: mapPrivateCode(error.code), message: error.message };
  }
  if (error instanceof GambleRuleError) {
    return { ok: false, code: mapGambleCode(error.code), message: error.message };
  }
  return {
    ok: false,
    code: "RULE_INVARIANT",
    message: error instanceof Error ? error.message : "未知错误",
  };
}

function mapBankCode(code: BankRuleError["code"]): ErrorCode {
  switch (code) {
    case "INVALID_AMOUNT":
    case "LOAN_CAP_EXCEEDED":
    case "AMOUNT_EXCEEDS_DEBT":
      return "INVALID_AMOUNT";
    case "NO_GOLD":
      return "INSUFFICIENT_FUNDS";
    case "INTEREST_NOT_ACCRUED":
      return "RULE_INVARIANT";
    default:
      return "INVALID_ACTION";
  }
}

function mapPrivateCode(code: PrivateLoanRuleError["code"]): ErrorCode {
  switch (code) {
    case "INVALID_AMOUNT":
    case "AMOUNT_EXCEEDS_DEBT":
    case "AMOUNT_EXCEEDS_COLLECTIBLE":
      return "INVALID_AMOUNT";
    case "INSUFFICIENT_FUNDS":
      return "INSUFFICIENT_FUNDS";
    case "REQUEST_NOT_PENDING":
      return "REQUEST_EXPIRED";
    default:
      return "INVALID_ACTION";
  }
}

function mapGambleCode(code: GambleErrorCode): ErrorCode {
  switch (code) {
    case "INVALID_BET":
    case "LEVERAGE_NOT_ALLOWED":
      return "INVALID_ACTION";
    case "BET_EXCEEDS_GOLD":
      return "INSUFFICIENT_FUNDS";
    default:
      return "RULE_INVARIANT";
  }
}

/* ------------------------------------------------------------------ */
/* 视图与存档                                                          */
/* ------------------------------------------------------------------ */

export { getPlayerView } from "./views.js";
export type { RichPlayerView, PlayerFinanceView } from "./views.js";

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
