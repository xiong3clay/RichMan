import { CREDIT, MAX_MONEY_CENTS, RULES } from "@richman/shared";
import type { BotPersonality, Cents, PlayerId } from "@richman/shared";
import type { EngineState } from "@richman/game-core";

/**
 * AI 决策草稿：不含 gameId/commandId，由驱动层补齐后走标准 GameCommand 路径。
 * 所有金额都是整数分；策略只读状态，不修改状态、不接触 IO。
 */
export interface GameCommandDraft {
  type: string;
  payload: Record<string, unknown>;
  expectedGameVersion?: number;
  roundId?: number;
  phaseInstanceId?: string;
  requestId?: string;
}

type Player = EngineState["players"][number];
type BankLoan = EngineState["bankLoans"][number];
type PrivateLoan = EngineState["privateLoans"][number];
type LoanRequest = EngineState["requests"][number];

/** 现金低于 1 元时 PASSIVE 才考虑借银行。 */
const LOW_CASH_CENTS = 100;
/** 出借后至少留 5 元闲置现金，避免把自己借到破产。 */
const LENDER_BUFFER_CENTS = 500;
/** 保守人格的现金缓冲（5 元）。 */
const CONSERVATIVE_BUFFER_CENTS = 500;
/** 激进人格只给自己留 2 元。 */
const AGGRESSIVE_BUFFER_CENTS = 200;
/** 激进人格现金低于 30 元时主动借银行补充下注资金。 */
const AGGRESSIVE_BORROW_BELOW_CENTS = 3_000;
const BET_BASE_CENTS = 10;
const SKIP_BET_THRESHOLD = 0.6;
const CONSERVATIVE_SKIP_THRESHOLD = 0.5;
const RESCUE_RATE_BPS = 1_000;
const GENIUS_RESCUE_RATE_BPS = 500;
const AGGRESSIVE_RESCUE_RATE_BPS = 1_500;
const FOOL_MAX_BET_CENTS = 500;

interface BotContext {
  state: EngineState;
  bot: Player;
  nowMs: number;
  rng: () => number;
  personality: BotPersonality;
}

/**
 * 单人练习 AI 的统一决策入口。
 * 人格只决定「选哪条合法命令、参数取多少」；所有命令都先按引擎前置条件自查，
 * 不产生必被引擎拒绝的非法命令。没有合法动作时返回 END_ACTION / null。
 */
export function decideBotCommand(
  state: EngineState,
  botPlayerId: PlayerId,
  nowMs: number,
  rng: () => number,
  personality: BotPersonality = "PASSIVE",
): GameCommandDraft | null {
  const bot = state.players.find((player) => player.playerId === botPlayerId);
  if (bot === undefined || !bot.alive) return null;
  if (state.phase === "GAME_OVER" || state.phase === "INTEREST") return null;
  const ctx: BotContext = { state, bot, nowMs, rng, personality };

  // 他人发来的待答复请求优先：ACTION 任意时刻、TAX 仅当前等待窗口。
  const request = requestsAwaitingBot(ctx);
  if (request !== null) return decideRequestAnswer(ctx, request);

  if (state.phase === "BANK_DUE") return decideBankDue(ctx);
  if (state.phase === "BETTING") return decideBet(ctx);
  if (state.phase === "TAX") return decideDangerRescue(ctx);

  if (state.phase !== "ACTION" || state.currentSeatId !== bot.seatId) return null;
  return decideAction(ctx);
}

/* ------------------------------------------------------------------ */
/* 请求答复                                                            */
/* ------------------------------------------------------------------ */

function requestsAwaitingBot(ctx: BotContext): LoanRequest | null {
  const { state, bot, nowMs } = ctx;
  if (state.phase !== "ACTION" && state.phase !== "TAX") return null;
  const candidates = state.requests.filter((request) => request.lenderId === bot.playerId
    && request.status === "PENDING"
    && request.createdRound === state.round
    && nowMs < request.deadlineMs
    && (state.phase === "ACTION" || state.pendingRequestId === request.requestId));
  if (candidates.length === 0) return null;
  candidates.sort((left, right) => left.deadlineMs - right.deadlineMs);
  return candidates[0]!;
}

function decideRequestAnswer(ctx: BotContext, request: LoanRequest): GameCommandDraft {
  const borrower = findPlayer(ctx.state, request.borrowerId);
  const principal = request.principalCents;
  const canAfford = ctx.bot.cents >= principal;
  // P2-4：借款人收款后不能超过引擎上限，否则 acceptLoanRequest 会抛 INVALID_AMOUNT。
  const withinMax = borrower !== undefined && borrower.cents + principal <= MAX_MONEY_CENTS;
  const borrowerAlive = borrower !== undefined && borrower.alive;
  const creditGood = borrower !== undefined && borrower.credit === CREDIT.GOOD;
  let accept: boolean;
  switch (ctx.personality) {
    case "FOOL":
      // 请求创建后借款人可能已死亡；ACCEPT 前仍按引擎前置条件复查存活。
      accept = canAfford && withinMax && borrowerAlive && ctx.rng() < 0.5;
      break;
    case "AGGRESSIVE":
      accept = canAfford && withinMax && borrowerAlive
        && ctx.bot.cents - principal >= AGGRESSIVE_BUFFER_CENTS;
      break;
    case "GENIUS":
      accept = canAfford && withinMax && borrowerAlive && creditGood
        && ctx.bot.cents - principal >= LENDER_BUFFER_CENTS
        && request.rateBps >= 300;
      break;
    default:
      accept = canAfford && withinMax && borrowerAlive && creditGood
        && ctx.bot.cents - principal >= LENDER_BUFFER_CENTS;
      break;
  }
  return {
    type: accept ? "ACCEPT_PRIVATE_LOAN" : "REFUSE_PRIVATE_LOAN",
    payload: { requestId: request.requestId },
    requestId: request.requestId,
  };
}

/* ------------------------------------------------------------------ */
/* 银行到期                                                            */
/* ------------------------------------------------------------------ */

function decideBankDue(ctx: BotContext): GameCommandDraft | null {
  const { state, bot } = ctx;
  const loan = state.bankLoans.find(
    (item) => item.loanId === state.pendingDueLoanId && item.status === "ACTIVE",
  );
  if (loan === undefined || loan.borrowerId !== bot.playerId) return null;
  const affordable = bot.cents >= loan.remainingCents;
  const decision = ctx.personality === "FOOL"
    ? (ctx.rng() < 0.5 ? "REPAY" : "REFUSE")
    : (affordable ? "REPAY" : "REFUSE");
  return {
    type: "BANK_DUE_DECISION",
    payload: { loanId: loan.loanId, pendingDueLoanId: loan.loanId, decision },
  };
}

/* ------------------------------------------------------------------ */
/* 下注                                                                */
/* ------------------------------------------------------------------ */

/** gamble.ts 的真实赔付：猜对 +bet×leverage，猜错 -bet×leverage；draw 0/1 均匀时 EV=0。 */
export function betExpectedValueCents(betCents: Cents, leverage: 1 | 2): number {
  return 0.5 * (betCents * leverage) + 0.5 * (0 - betCents * leverage);
}

/** 赔付方差；GENIUS 在 EV 相同的候选里用方差做风险调整。 */
export function betVarianceCents(betCents: Cents, leverage: 1 | 2): number {
  const moved = betCents * leverage;
  return 0.5 * moved * moved + 0.5 * moved * moved;
}

interface BetChoice {
  betCents: Cents;
  guess: 0 | 1;
  leverage: 1 | 2;
}

function decideBet(ctx: BotContext): GameCommandDraft | null {
  if (ctx.state.bets[ctx.bot.playerId] !== undefined) return null;
  const bet = pickBet(ctx);
  return {
    type: "SUBMIT_BET",
    payload: { betCents: bet.betCents, guess: bet.guess, leverage: bet.leverage },
    roundId: ctx.state.round,
    phaseInstanceId: ctx.state.phaseInstanceId,
  };
}

function pickBet(ctx: BotContext): BetChoice {
  const cents = Math.max(0, ctx.bot.cents);
  switch (ctx.personality) {
    case "CONSERVATIVE": {
      if (ctx.rng() < CONSERVATIVE_SKIP_THRESHOLD) return { betCents: 0, guess: 1, leverage: 1 };
      return { betCents: Math.min(Math.floor(cents * 5 / 100), 100), guess: 1, leverage: 1 };
    }
    case "AGGRESSIVE": {
      const ratio = 0.2 + 0.2 * ctx.rng();
      const betCents = Math.min(Math.floor(cents * ratio), cents);
      const guess: 0 | 1 = ctx.rng() < 0.5 ? 0 : 1;
      const leverage: 1 | 2 = ctx.bot.credit === CREDIT.GOOD && ctx.rng() < 0.4 ? 2 : 1;
      return { betCents, guess, leverage };
    }
    case "GENIUS":
      return pickGeniusBet(cents, ctx.bot.credit === CREDIT.GOOD);
    case "FOOL": {
      const betCents = randomInt(ctx.rng, 0, Math.min(cents, FOOL_MAX_BET_CENTS));
      const guess: 0 | 1 = randomInt(ctx.rng, 0, 1) as 0 | 1;
      const leverage: 1 | 2 = ctx.bot.credit === CREDIT.GOOD && ctx.rng() < 0.5 ? 2 : 1;
      return { betCents, guess, leverage };
    }
    default: {
      if (ctx.rng() < SKIP_BET_THRESHOLD) return { betCents: 0, guess: 1, leverage: 1 };
      return { betCents: Math.min(BET_BASE_CENTS, Math.floor(cents / 10)), guess: 1, leverage: 1 };
    }
  }
}

/**
 * GENIUS：枚举引擎允许的金额/猜点/杠杆，按真实赔付公式算 EV，再用方差做风险调整。
 * 开奖是均匀 0/1，所有非零下注 EV 都是 0；因此风险调整后最优是 0 注（不送钱给波动）。
 */
function pickGeniusBet(cents: Cents, creditGood: boolean): BetChoice {
  const amounts = new Set<number>([0]);
  for (const percent of [5, 10, 20, 40, 60, 80, 100]) {
    const amount = Math.floor(cents * percent / 100);
    if (amount >= 0 && amount <= cents) amounts.add(amount);
  }
  const leverages: Array<1 | 2> = creditGood ? [1, 2] : [1];
  let best: BetChoice = { betCents: 0, guess: 1, leverage: 1 };
  let bestUtility = Number.NEGATIVE_INFINITY;
  const riskAversion = 1 / 1_000_000;
  for (const betCents of amounts) {
    for (const leverage of leverages) {
      const ev = betExpectedValueCents(betCents, leverage);
      const utility = ev - betVarianceCents(betCents, leverage) * riskAversion;
      if (utility > bestUtility) {
        bestUtility = utility;
        best = { betCents, guess: 1, leverage };
      }
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* ACTION                                                              */
/* ------------------------------------------------------------------ */

function decideAction(ctx: BotContext): GameCommandDraft {
  switch (ctx.personality) {
    case "CONSERVATIVE":
      return conservativeAction(ctx);
    case "AGGRESSIVE":
      return aggressiveAction(ctx);
    case "GENIUS":
      return geniusAction(ctx);
    case "FOOL":
      return foolAction(ctx);
    default:
      return passiveAction(ctx);
  }
}

function passiveAction(ctx: BotContext): GameCommandDraft {
  const privateLoan = firstFullRepayablePrivate(ctx, 0);
  if (privateLoan !== null) return repayPrivateDraft(ctx, privateLoan, privateLoan.remainingCents);
  const bankLoan = firstFullRepayableBank(ctx, 1, 0);
  if (bankLoan !== null) return repayBankDraft(ctx, bankLoan, bankLoan.remainingCents);
  const borrow = passiveBorrowDraft(ctx);
  if (borrow !== null) return borrow;
  return endAction(ctx);
}

function conservativeAction(ctx: BotContext): GameCommandDraft {
  // 到期/临期（下一轮）银行债优先保信用，即使跌破现金缓冲。
  const urgentBank = firstFullRepayableBank(ctx, 1, 0);
  if (urgentBank !== null) return repayBankDraft(ctx, urgentBank, urgentBank.remainingCents);
  // 两轮内到期，且还款后仍保留 5 元缓冲。
  const nearBank = firstFullRepayableBank(ctx, 2, CONSERVATIVE_BUFFER_CENTS);
  if (nearBank !== null) return repayBankDraft(ctx, nearBank, nearBank.remainingCents);
  // 私人债同样保留缓冲。
  const privateLoan = firstFullRepayablePrivate(ctx, CONSERVATIVE_BUFFER_CENTS);
  if (privateLoan !== null) return repayPrivateDraft(ctx, privateLoan, privateLoan.remainingCents);
  // 不主动借银行。
  return endAction(ctx);
}

function aggressiveAction(ctx: BotContext): GameCommandDraft {
  // 私人债先还（10% 复利很贵），但不像保守人格那样留大缓冲。
  const privateLoan = firstFullRepayablePrivate(ctx, 0);
  if (privateLoan !== null) return repayPrivateDraft(ctx, privateLoan, privateLoan.remainingCents);
  // 下一轮到期的银行债必须结清，否则永久失信，得不偿失。
  const bankLoan = firstFullRepayableBank(ctx, 1, 0);
  if (bankLoan !== null) return repayBankDraft(ctx, bankLoan, bankLoan.remainingCents);
  // 为下注/自救主动借银行：没有未结清贷款且现金较少时借满 50% 额度。
  const limit = bankBorrowLimit(ctx);
  if (limit > 0 && ctx.bot.cents < AGGRESSIVE_BORROW_BELOW_CENTS) {
    return borrowBankDraft(ctx, limit);
  }
  return endAction(ctx);
}

function geniusAction(ctx: BotContext): GameCommandDraft {
  // ① 现金够就结清下一轮到期的银行债，避免永久失信。
  const bankLoan = firstFullRepayableBank(ctx, 1, 0);
  if (bankLoan !== null) return repayBankDraft(ctx, bankLoan, bankLoan.remainingCents);
  // ② 私人债 10% 复利，能全额还就还。
  const privateLoan = firstFullRepayablePrivate(ctx, 0);
  if (privateLoan !== null) return repayPrivateDraft(ctx, privateLoan, privateLoan.remainingCents);
  // ③ 不为无收益目的借钱。
  return endAction(ctx);
}

function foolAction(ctx: BotContext): GameCommandDraft {
  const candidates: Array<() => GameCommandDraft> = [];
  for (const loan of activePrivateLoansBorrowed(ctx)) {
    const max = legalPrivateRepayCents(ctx, loan, 0);
    if (max > 0) candidates.push(() => repayPrivateDraft(ctx, loan, randomInt(ctx.rng, 1, max)));
  }
  for (const loan of activeBankLoans(ctx)) {
    if (loan.dueRound <= ctx.state.round) continue;
    const max = Math.min(loan.remainingCents, Math.max(0, ctx.bot.cents));
    if (max > 0) candidates.push(() => repayBankDraft(ctx, loan, randomInt(ctx.rng, 1, max)));
  }
  const limit = bankBorrowLimit(ctx);
  if (limit > 0) candidates.push(() => borrowBankDraft(ctx, randomInt(ctx.rng, 1, limit)));
  if (!hasPendingBorrowerRequest(ctx)) {
    const lenders = ctx.state.players.filter((player) => player.alive && player.playerId !== ctx.bot.playerId);
    if (lenders.length > 0) {
      const lender = lenders[randomInt(ctx.rng, 0, lenders.length - 1)]!;
      const amount = randomInt(ctx.rng, 1, Math.min(1_000, Math.max(1, ctx.bot.cents)));
      const rateBps = randomInt(ctx.rng, 0, 2_000);
      candidates.push(() => requestPrivateLoanDraft(ctx, lender.playerId, amount, rateBps));
    }
  }
  candidates.push(() => endAction(ctx));
  return candidates[randomInt(ctx.rng, 0, candidates.length - 1)]!();
}

/* ------------------------------------------------------------------ */
/* TAX 危险自救                                                        */
/* ------------------------------------------------------------------ */

function decideDangerRescue(ctx: BotContext): GameCommandDraft | null {
  const { state, bot } = ctx;
  if (state.dangerSeatId !== bot.seatId) return null;
  // 等待出借人答复期间只能等待/放弃；不要打断自己的请求。
  if (state.pendingRequestId !== null) return null;
  if (bot.cents >= 0) return null;
  if (ctx.personality === "FOOL") return foolRescue(ctx);

  const collect = collectibleDraft(ctx);
  if (collect !== null) return collect;
  const request = rescueRequestDraft(ctx);
  if (request !== null) return request;
  // 2 秒请求间隔还没过、而且危险窗口还有时间：等下一次巡检，不要提前放弃。
  if (canWaitForRescueRequest(ctx)) return null;
  return giveUpDraft(ctx);
}

function foolRescue(ctx: BotContext): GameCommandDraft {
  const candidates: Array<() => GameCommandDraft> = [];
  const collect = collectibleDraft(ctx);
  if (collect !== null) candidates.push(() => collect);
  const request = rescueRequestDraft(ctx);
  if (request !== null) candidates.push(() => request);
  candidates.push(() => giveUpDraft(ctx));
  return candidates[randomInt(ctx.rng, 0, candidates.length - 1)]!();
}

function collectibleDraft(ctx: BotContext): GameCommandDraft | null {
  const { state, bot } = ctx;
  let best: { loan: PrivateLoan; cents: Cents } | null = null;
  for (const loan of state.privateLoans) {
    if (loan.lenderId !== bot.playerId || loan.status !== "ACTIVE") continue;
    if (state.round < loan.issuedRound + 1) continue;
    const borrower = findPlayer(state, loan.borrowerId);
    if (borrower === undefined) continue;
    const cents = Math.min(
      loan.remainingCents,
      Math.max(0, borrower.cents),
      // P2-2：出借人收款后不能超过 MAX，否则引擎会拒绝 COLLECT_PRIVATE。
      Math.max(0, MAX_MONEY_CENTS - bot.cents),
    );
    if (cents <= 0) continue;
    if (best === null || cents > best.cents) best = { loan, cents };
  }
  if (best === null) return null;
  return {
    type: "COLLECT_PRIVATE",
    payload: { loanId: best.loan.loanId, cents: best.cents },
    expectedGameVersion: state.version,
  };
}

function rescueRequestDraft(ctx: BotContext): GameCommandDraft | null {
  const { state, bot, nowMs } = ctx;
  if (hasPendingBorrowerRequest(ctx)) return null;
  // 引擎自救请求有 2 秒间隔，按同一借款人最近一条请求计算。
  const latest = latestRequestByBorrower(ctx);
  if (latest !== null && nowMs - latest.createdAtMs < RULES.rescueRequestMinGapSec * 1000) return null;
  if (state.dangerDeadlineMs !== null && state.dangerDeadlineMs - nowMs < 2_000) return null;

  const need = Math.max(1, -bot.cents);
  const desired = ctx.personality === "AGGRESSIVE" ? need + 500 : need;
  // 只按公开信息（存活、座位顺序、本人请求历史）挑出借人；不读他人余额做策略选择。
  const candidates = state.players.filter((player) => player.alive && player.playerId !== bot.playerId);
  if (candidates.length === 0) return null;
  const asked = state.requests.filter((request) => request.borrowerId === bot.playerId).length;
  const lender = candidates[asked % candidates.length]!;
  const amount = Math.min(desired, MAX_MONEY_CENTS - bot.cents, MAX_MONEY_CENTS);
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;
  const rateBps = ctx.personality === "GENIUS" ? GENIUS_RESCUE_RATE_BPS
    : ctx.personality === "AGGRESSIVE" ? AGGRESSIVE_RESCUE_RATE_BPS
      : ctx.personality === "FOOL" ? randomInt(ctx.rng, 0, 2_000)
        : RESCUE_RATE_BPS;
  return {
    type: "REQUEST_PRIVATE_LOAN",
    payload: { lenderId: lender.playerId, principalCents: amount, rateBps },
    expectedGameVersion: state.version,
  };
}

function giveUpDraft(ctx: BotContext): GameCommandDraft {
  return { type: "RESCUE_GIVE_UP", payload: {}, expectedGameVersion: ctx.state.version };
}

/** 还有 2 秒间隔可等、且危险窗口没结束、且仍有存活出借人时，等待下一次巡检。 */
function canWaitForRescueRequest(ctx: BotContext): boolean {
  const { state, bot, nowMs } = ctx;
  if (hasPendingBorrowerRequest(ctx)) return false;
  const latest = latestRequestByBorrower(ctx);
  if (latest === null || nowMs - latest.createdAtMs >= RULES.rescueRequestMinGapSec * 1000) return false;
  if (state.dangerDeadlineMs === null || state.dangerDeadlineMs - nowMs <= 2_000) return false;
  return state.players.some((player) => player.alive && player.playerId !== bot.playerId);
}

/* ------------------------------------------------------------------ */
/* 通用判断与命令构造                                                  */
/* ------------------------------------------------------------------ */

function findPlayer(state: EngineState, playerId: PlayerId): Player | undefined {
  return state.players.find((player) => player.playerId === playerId);
}

function activeBankLoans(ctx: BotContext): BankLoan[] {
  return ctx.state.bankLoans.filter((loan) => loan.borrowerId === ctx.bot.playerId
    && loan.status === "ACTIVE"
    && loan.lastInterestRound === ctx.state.round
    && loan.dueRound > ctx.state.round);
}

function activePrivateLoansBorrowed(ctx: BotContext): PrivateLoan[] {
  return ctx.state.privateLoans.filter((loan) => loan.borrowerId === ctx.bot.playerId
    && loan.status === "ACTIVE"
    && loan.lastInterestRound === ctx.state.round);
}

function hasPendingBorrowerRequest(ctx: BotContext): boolean {
  return ctx.state.requests.some((request) => request.borrowerId === ctx.bot.playerId
    && request.status === "PENDING");
}

function latestRequestByBorrower(ctx: BotContext): LoanRequest | null {
  let latest: LoanRequest | null = null;
  for (const request of ctx.state.requests) {
    if (request.borrowerId !== ctx.bot.playerId) continue;
    if (latest === null || request.createdAtMs > latest.createdAtMs) latest = request;
  }
  return latest;
}

/** 普通银行贷款：信用 GOOD、金币 > 0、无未结清贷款、金额不超过 50% 且不超上限。 */
function bankBorrowLimit(ctx: BotContext): Cents {
  const { state, bot } = ctx;
  if (bot.credit !== CREDIT.GOOD || bot.cents <= 0) return 0;
  if (state.bankLoans.some((loan) => loan.borrowerId === bot.playerId && loan.status !== "REPAID")) return 0;
  return Math.max(0, Math.min(Math.floor(bot.cents / 2), MAX_MONEY_CENTS - bot.cents));
}

function passiveBorrowDraft(ctx: BotContext): GameCommandDraft | null {
  if (ctx.bot.cents >= LOW_CASH_CENTS) return null;
  const limit = bankBorrowLimit(ctx);
  const amount = Math.min(limit, LOW_CASH_CENTS - ctx.bot.cents);
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;
  return borrowBankDraft(ctx, amount);
}

/** 找一笔下一轮/两轮内到期、现金足够全额还的银行债。 */
function firstFullRepayableBank(ctx: BotContext, withinRounds: number, reserve: Cents): BankLoan | null {
  const candidates = activeBankLoans(ctx)
    .filter((loan) => loan.dueRound - ctx.state.round <= withinRounds
      && ctx.bot.cents - reserve >= loan.remainingCents)
    .sort((left, right) => left.dueRound - right.dueRound || left.loanId.localeCompare(right.loanId));
  return candidates[0] ?? null;
}

function firstFullRepayablePrivate(ctx: BotContext, reserve: Cents): PrivateLoan | null {
  for (const loan of activePrivateLoansBorrowed(ctx)) {
    if (legalPrivateRepayCents(ctx, loan, reserve) === loan.remainingCents) return loan;
  }
  return null;
}

/**
 * 私人还款的合法上限：不超过剩余本息、不超过自己现金、且出借人收款后不超 MAX。
 * P2-4：极端余额下 engine 会因 nextLenderCents > MAX 抛 INVALID_AMOUNT。
 */
function legalPrivateRepayCents(ctx: BotContext, loan: PrivateLoan, reserve: Cents): Cents {
  const lender = findPlayer(ctx.state, loan.lenderId);
  if (lender === undefined) return 0;
  return Math.max(0, Math.min(
    loan.remainingCents,
    Math.max(0, ctx.bot.cents - reserve),
    Math.max(0, MAX_MONEY_CENTS - lender.cents),
  ));
}

function repayPrivateDraft(ctx: BotContext, loan: PrivateLoan, cents: Cents): GameCommandDraft {
  return {
    type: "REPAY_PRIVATE",
    payload: { loanId: loan.loanId, cents },
    expectedGameVersion: ctx.state.version,
    phaseInstanceId: ctx.state.phaseInstanceId,
  };
}

function repayBankDraft(ctx: BotContext, loan: BankLoan, cents: Cents): GameCommandDraft {
  return {
    type: "REPAY_BANK",
    payload: { loanId: loan.loanId, cents },
    expectedGameVersion: ctx.state.version,
    phaseInstanceId: ctx.state.phaseInstanceId,
  };
}

function borrowBankDraft(ctx: BotContext, amountCents: Cents): GameCommandDraft {
  return {
    type: "BORROW_BANK",
    payload: { amountCents },
    expectedGameVersion: ctx.state.version,
    phaseInstanceId: ctx.state.phaseInstanceId,
  };
}

function requestPrivateLoanDraft(
  ctx: BotContext,
  lenderId: PlayerId,
  principalCents: Cents,
  rateBps: number,
): GameCommandDraft {
  return {
    type: "REQUEST_PRIVATE_LOAN",
    payload: { lenderId, principalCents, rateBps },
    expectedGameVersion: ctx.state.version,
    phaseInstanceId: ctx.state.phaseInstanceId,
  };
}

function endAction(ctx: BotContext): GameCommandDraft {
  return {
    type: "END_ACTION",
    payload: {},
    expectedGameVersion: ctx.state.version,
    phaseInstanceId: ctx.state.phaseInstanceId,
  };
}

/** 闭区间随机整数；兼容注入 rng 返回 1 的边界。 */
function randomInt(rng: () => number, min: number, max: number): number {
  if (max <= min) return min;
  const value = Math.floor(rng() * (max - min + 1));
  return Math.max(min, Math.min(max, min + value));
}
