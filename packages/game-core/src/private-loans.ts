import type { Cents, Credit, PlayerId } from "@richman/shared";
import { MAX_MONEY_CENTS, assertCentsRange } from "@richman/shared";
import { interestFor } from "./money.js";

/** 私人贷款状态：FROZEN 与 BAD_DEBT 都是冻结记录，绝不等于 REPAID。 */
export const PRIVATE_LOAN_STATUS = {
  ACTIVE: "ACTIVE",
  REPAID: "REPAID",
  BAD_DEBT: "BAD_DEBT",
  FROZEN: "FROZEN",
} as const;
export type PrivateLoanStatus = (typeof PRIVATE_LOAN_STATUS)[keyof typeof PRIVATE_LOAN_STATUS];

export const LOAN_REQUEST_STATUS = {
  PENDING: "PENDING",
  ACCEPTED: "ACCEPTED",
  REFUSED: "REFUSED",
  EXPIRED: "EXPIRED",
  CANCELLED: "CANCELLED",
  FAILED: "FAILED",
} as const;
export type LoanRequestStatus = (typeof LOAN_REQUEST_STATUS)[keyof typeof LOAN_REQUEST_STATUS];

export interface PrivateLoan {
  loanId: string;
  requestId: string;
  borrowerId: PlayerId;
  lenderId: PlayerId;
  principalCents: Cents;
  remainingCents: Cents;
  rateBps: number;
  issuedRound: number;
  /** 已计息到的轮次；与 bank.ts 一致，用于逐轮复利、漏轮补算与幂等。 */
  lastInterestRound: number;
  status: PrivateLoanStatus;
}

export interface LoanRequest {
  requestId: string;
  borrowerId: PlayerId;
  lenderId: PlayerId;
  principalCents: Cents;
  rateBps: number;
  createdRound: number;
  deadlineMs: number;
  status: LoanRequestStatus;
  /** D5：创建时快照，供出借人看到失信风险。 */
  borrowerCredit: Credit;
  borrowerDefaultedBankDebtCents: Cents;
}

export type PrivateLoanErrorCode =
  | "INVALID_AMOUNT"
  | "INVALID_RATE"
  | "INVALID_ROUND"
  | "INVALID_DEADLINE"
  | "INVALID_REQUEST"
  | "SELF_LOAN"
  | "PARTY_NOT_ALIVE"
  | "DUPLICATE_PENDING_REQUEST"
  | "REQUEST_NOT_PENDING"
  | "LENDER_MISMATCH"
  | "INSUFFICIENT_FUNDS"
  | "NOT_ACTIVE"
  | "AMOUNT_EXCEEDS_DEBT"
  | "AMOUNT_EXCEEDS_COLLECTIBLE";

export class PrivateLoanRuleError extends Error {
  readonly code: PrivateLoanErrorCode;

  constructor(code: PrivateLoanErrorCode, message: string = code) {
    super(message);
    this.name = "PrivateLoanRuleError";
    this.code = code;
  }
}

export interface CreateLoanRequestInput {
  requestId: string;
  borrowerId: PlayerId;
  lenderId: PlayerId;
  principalCents: Cents;
  rateBps: number;
  createdRound: number;
  /** createdRound 对应的服务器当前时间，由调用方注入，不读系统时钟。 */
  nowMs: number;
  deadlineMs: number;
  existingRequests: readonly LoanRequest[];
  borrowerCredit: Credit;
  borrowerDefaultedBankDebtCents: Cents;
  borrowerAlive: boolean;
  lenderAlive: boolean;
}

export interface AcceptLoanRequestContext {
  /** 发起批准操作的人，必须等于请求指定的出借人。 */
  lenderId: PlayerId;
  nowMs: number;
  lenderCents: Cents;
  borrowerCents: Cents;
  lenderAlive: boolean;
  borrowerAlive: boolean;
  loanId: string;
  currentRound: number;
}

export interface AcceptLoanRequestResult {
  request: LoanRequest;
  /** 仅成功批准时存在借条；过期或余额不足时为 null。 */
  loan: PrivateLoan | null;
  lenderCents: Cents;
  borrowerCents: Cents;
}

export interface RepayPrivateLoanResult {
  loan: PrivateLoan;
  paidCents: Cents;
  borrowerCents: Cents;
  lenderCents: Cents;
}

export interface CollectPrivateDebtResult {
  loan: PrivateLoan;
  collectedCents: Cents;
  borrowerCents: Cents;
  lenderCents: Cents;
}

function assertPositiveCents(value: Cents, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_MONEY_CENTS) {
    throw new PrivateLoanRuleError("INVALID_AMOUNT", `${label} 必须是 (0, MAX_MONEY_CENTS] 内的整数分`);
  }
}

function assertBalanceCents(value: Cents, label: string, allowNegative = false): void {
  const lower = allowNegative ? -MAX_MONEY_CENTS : 0;
  if (!Number.isSafeInteger(value) || value < lower || value > MAX_MONEY_CENTS) {
    throw new PrivateLoanRuleError("INVALID_AMOUNT", `${label} 不是合法金额`);
  }
}

function assertTimeMs(value: number, label: string, code: PrivateLoanErrorCode): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PrivateLoanRuleError(code, `${label} 必须是非负安全整数毫秒`);
  }
}

function assertRound(round: number, label = "round"): void {
  if (!Number.isSafeInteger(round) || round < 1) {
    throw new PrivateLoanRuleError("INVALID_ROUND", `${label} 必须是正整数轮次`);
  }
}

function assertRateBps(rateBps: number): void {
  if (!Number.isSafeInteger(rateBps) || rateBps < 0 || rateBps > 10_000) {
    throw new PrivateLoanRuleError("INVALID_RATE", "利率必须是 0～10000 的整数基点");
  }
}

/**
 * 批准前重新校验请求自身字段。请求可能来自网络或存档，不能信任其本金、利率与双方身份，
 * 否则被改过的请求会让资金反向流动。
 */
function assertRequestIntegrity(request: LoanRequest): void {
  if (request.borrowerId === request.lenderId) {
    throw new PrivateLoanRuleError("INVALID_REQUEST", "请求的借款人与出借人不能相同");
  }
  if (
    !Number.isSafeInteger(request.principalCents) ||
    request.principalCents <= 0 ||
    request.principalCents > MAX_MONEY_CENTS
  ) {
    throw new PrivateLoanRuleError("INVALID_REQUEST", "请求本金必须是 (0, MAX_MONEY_CENTS] 内的整数分");
  }
  if (!Number.isSafeInteger(request.rateBps) || request.rateBps < 0 || request.rateBps > 10_000) {
    throw new PrivateLoanRuleError("INVALID_REQUEST", "请求利率必须是 0～10000 的整数基点");
  }
  // 截止时间与轮次也必须可信：deadlineMs 为 NaN 时 nowMs >= NaN 恒为 false，迟到同意会被放行。
  assertTimeMs(request.deadlineMs, "deadlineMs", "INVALID_DEADLINE");
  assertRound(request.createdRound, "createdRound");
}

/** 创建私人借款请求；失信借款人也可发起，但请求必须快照信用与失信欠款供出借人查看。 */
export function createLoanRequest(input: CreateLoanRequestInput): LoanRequest {
  assertRound(input.createdRound, "createdRound");
  assertTimeMs(input.nowMs, "nowMs", "INVALID_DEADLINE");
  assertTimeMs(input.deadlineMs, "deadlineMs", "INVALID_DEADLINE");
  if (input.deadlineMs <= input.nowMs) {
    throw new PrivateLoanRuleError("INVALID_DEADLINE", "请求截止时间必须晚于当前时间");
  }
  assertPositiveCents(input.principalCents, "principalCents");
  assertRateBps(input.rateBps);
  assertBalanceCents(input.borrowerDefaultedBankDebtCents, "borrowerDefaultedBankDebtCents");

  if (input.borrowerId === input.lenderId) {
    throw new PrivateLoanRuleError("SELF_LOAN", "不能向自己借款");
  }
  if (!input.borrowerAlive || !input.lenderAlive) {
    throw new PrivateLoanRuleError("PARTY_NOT_ALIVE", "借款双方都必须存活");
  }
  if (
    input.existingRequests.some(
      (request) => request.borrowerId === input.borrowerId && request.status === "PENDING",
    )
  ) {
    throw new PrivateLoanRuleError("DUPLICATE_PENDING_REQUEST", "同一借款人最多只有一个待处理请求");
  }

  return {
    requestId: input.requestId,
    borrowerId: input.borrowerId,
    lenderId: input.lenderId,
    principalCents: input.principalCents,
    rateBps: input.rateBps,
    createdRound: input.createdRound,
    deadlineMs: input.deadlineMs,
    status: "PENDING",
    borrowerCredit: input.borrowerCredit,
    borrowerDefaultedBankDebtCents: input.borrowerDefaultedBankDebtCents,
  };
}

/** 出借人明确同意：扣出借人、加借款人、建 ACTIVE 借条、请求 ACCEPTED 必须同一次原子结果。 */
export function acceptLoanRequest(
  request: LoanRequest,
  ctx: AcceptLoanRequestContext,
): AcceptLoanRequestResult {
  assertRound(ctx.currentRound, "currentRound");
  assertTimeMs(ctx.nowMs, "nowMs", "INVALID_DEADLINE");
  assertBalanceCents(ctx.lenderCents, "lenderCents");
  // R08：危险玩家余额为负，紧急借款时必须允许“负余额借款人”收款；出借人一侧仍必须非负。
  assertBalanceCents(ctx.borrowerCents, "borrowerCents", true);

  if (request.status !== "PENDING") {
    throw new PrivateLoanRuleError("REQUEST_NOT_PENDING", "请求已结束，不能重复批准");
  }
  assertRequestIntegrity(request);
  if (ctx.lenderId !== request.lenderId) {
    throw new PrivateLoanRuleError("LENDER_MISMATCH", "只有请求指定的出借人可以批准");
  }
  if (!ctx.lenderAlive || !ctx.borrowerAlive) {
    throw new PrivateLoanRuleError("PARTY_NOT_ALIVE", "借款双方都必须存活");
  }

  // R05：跨到下一轮的借款请求一律无效，置 EXPIRED 且不转账。
  if (request.createdRound !== ctx.currentRound) {
    return {
      request: { ...request, status: "EXPIRED" },
      loan: null,
      lenderCents: ctx.lenderCents,
      borrowerCents: ctx.borrowerCents,
    };
  }
  if (ctx.nowMs >= request.deadlineMs) {
    return {
      request: { ...request, status: "EXPIRED" },
      loan: null,
      lenderCents: ctx.lenderCents,
      borrowerCents: ctx.borrowerCents,
    };
  }
  if (ctx.lenderCents < request.principalCents) {
    return {
      request: { ...request, status: "FAILED" },
      loan: null,
      lenderCents: ctx.lenderCents,
      borrowerCents: ctx.borrowerCents,
    };
  }

  const nextLenderCents = ctx.lenderCents - request.principalCents;
  const nextBorrowerCents = ctx.borrowerCents + request.principalCents;
  if (nextBorrowerCents > MAX_MONEY_CENTS) {
    throw new PrivateLoanRuleError("INVALID_AMOUNT", "借款后借款人余额超出上限");
  }
  assertCentsRange(nextLenderCents, "lenderCents");
  assertCentsRange(nextBorrowerCents, "borrowerCents");

  const loan: PrivateLoan = {
    loanId: ctx.loanId,
    requestId: request.requestId,
    borrowerId: request.borrowerId,
    lenderId: request.lenderId,
    principalCents: request.principalCents,
    remainingCents: request.principalCents,
    rateBps: request.rateBps,
    issuedRound: ctx.currentRound,
    lastInterestRound: ctx.currentRound,
    status: "ACTIVE",
  };

  return {
    request: { ...request, status: "ACCEPTED" },
    loan,
    lenderCents: nextLenderCents,
    borrowerCents: nextBorrowerCents,
  };
}

function closePendingRequest(request: LoanRequest, status: LoanRequestStatus): LoanRequest {
  if (request.status !== "PENDING") {
    throw new PrivateLoanRuleError("REQUEST_NOT_PENDING", "只有待处理请求可以结束");
  }
  return { ...request, status };
}

/** 出借人拒绝；不产生借条、不转账。 */
export function refuseLoanRequest(request: LoanRequest): LoanRequest {
  return closePendingRequest(request, "REFUSED");
}

/** 借款人取消；不产生借条、不转账。 */
export function cancelLoanRequest(request: LoanRequest): LoanRequest {
  return closePendingRequest(request, "CANCELLED");
}

/** 超时到期；不产生借条、不转账。 */
export function expireLoanRequest(request: LoanRequest): LoanRequest {
  return closePendingRequest(request, "EXPIRED");
}

/**
 * 私人贷款逐轮复利。issuedRound+1 才第一次计息；漏轮自动补算；
 * FROZEN / BAD_DEBT / REPAID 不计息；返回新数组，不修改入参。
 */
export function accruePrivateInterest(loans: readonly PrivateLoan[], round: number): PrivateLoan[] {
  assertRound(round);
  return loans.map((loan) => {
    if (loan.status !== "ACTIVE") return loan;
    if (round <= loan.issuedRound) return loan;
    if (loan.lastInterestRound >= round) return loan;

    let remainingCents = loan.remainingCents;
    let lastInterestRound = loan.lastInterestRound;
    for (let r = loan.lastInterestRound + 1; r <= round; r += 1) {
      if (r <= loan.issuedRound) continue;
      remainingCents += interestFor(remainingCents, loan.rateBps);
      assertCentsRange(remainingCents, "remainingCents");
      lastInterestRound = r;
    }
    return { ...loan, remainingCents, lastInterestRound };
  });
}

/** 借款人主动部分/全额还款；双方余额在同一次结果里更新，避免调用方漏记出借人入账。 */
export function repayPrivateLoan(
  loan: PrivateLoan,
  cents: Cents,
  currentRound: number,
  borrowerCents: Cents,
  lenderCents: Cents,
): RepayPrivateLoanResult {
  assertRound(currentRound, "currentRound");
  if (loan.status !== "ACTIVE") {
    throw new PrivateLoanRuleError("NOT_ACTIVE", "只有 ACTIVE 私人贷款可以还款");
  }
  assertPositiveCents(cents, "repay cents");
  assertBalanceCents(borrowerCents, "borrowerCents");
  assertBalanceCents(lenderCents, "lenderCents");
  if (cents > loan.remainingCents) {
    throw new PrivateLoanRuleError("AMOUNT_EXCEEDS_DEBT", "还款金额不得超过剩余欠款");
  }
  if (cents > borrowerCents) {
    throw new PrivateLoanRuleError("INSUFFICIENT_FUNDS", "借款人余额不足");
  }
  const nextLenderCents = lenderCents + cents;
  if (nextLenderCents > MAX_MONEY_CENTS) {
    throw new PrivateLoanRuleError("INVALID_AMOUNT", "出借人收款后余额超出上限");
  }

  const remainingCents = loan.remainingCents - cents;
  return {
    loan: { ...loan, remainingCents, status: remainingCents === 0 ? "REPAID" : "ACTIVE" },
    paidCents: cents,
    borrowerCents: borrowerCents - cents,
    lenderCents: nextLenderCents,
  };
}

/**
 * 出借人催收。借出当轮不能催；金额不得超过可收上限
 * = min(剩余本息, max(0, 借款人余额))，超出时拒绝并返回合法上限，绝不静默改额或扣成负数。
 * 双方余额在同一次结果里更新，避免调用方漏记出借人入账。
 */
export function collectPrivateDebt(
  loan: PrivateLoan,
  cents: Cents,
  currentRound: number,
  borrowerCents: Cents,
  lenderId: PlayerId,
  lenderCents: Cents,
): CollectPrivateDebtResult {
  assertRound(currentRound, "currentRound");
  if (loan.status !== "ACTIVE") {
    throw new PrivateLoanRuleError("NOT_ACTIVE", "只有 ACTIVE 私人贷款可以催收");
  }
  if (loan.lenderId !== lenderId) {
    throw new PrivateLoanRuleError("LENDER_MISMATCH", "只有该笔贷款的出借人可以催收");
  }
  if (currentRound < loan.issuedRound + 1) {
    throw new PrivateLoanRuleError("INVALID_ROUND", "借出当轮不能催收");
  }
  assertPositiveCents(cents, "collect cents");
  assertBalanceCents(borrowerCents, "borrowerCents", true);
  // R08：危险玩家可作为债权人催收，自己余额为负时必须放行；借款人一侧上限仍是 max(0, 余额)。
  assertBalanceCents(lenderCents, "lenderCents", true);

  const collectibleCents = Math.min(loan.remainingCents, Math.max(0, borrowerCents));
  if (cents > collectibleCents) {
    throw new PrivateLoanRuleError(
      "AMOUNT_EXCEEDS_COLLECTIBLE",
      `催收金额超过可收上限 ${collectibleCents} 分`,
    );
  }
  const nextLenderCents = lenderCents + cents;
  if (nextLenderCents > MAX_MONEY_CENTS) {
    throw new PrivateLoanRuleError("INVALID_AMOUNT", "出借人收款后余额超出上限");
  }

  const remainingCents = loan.remainingCents - cents;
  return {
    loan: { ...loan, remainingCents, status: remainingCents === 0 ? "REPAID" : "ACTIVE" },
    collectedCents: cents,
    borrowerCents: borrowerCents - cents,
    lenderCents: nextLenderCents,
  };
}

/**
 * 破产结算：借款人破产 -> 其 ACTIVE 贷款记 BAD_DEBT；出借人破产 -> 别人欠他的 ACTIVE 贷款 FROZEN。
 * FROZEN 合同若借款人后来也破产，转 BAD_DEBT；所有金额与历史冻结不变。
 */
export function settleBankruptcy(
  loans: readonly PrivateLoan[],
  bankruptPlayerId: PlayerId,
): PrivateLoan[] {
  return loans.map((loan) => {
    if (loan.status === "REPAID" || loan.status === "BAD_DEBT") return loan;
    if (
      loan.borrowerId === bankruptPlayerId &&
      (loan.status === "ACTIVE" || loan.status === "FROZEN")
    ) {
      return { ...loan, status: "BAD_DEBT" };
    }
    if (loan.lenderId === bankruptPlayerId && loan.status === "ACTIVE") {
      return { ...loan, status: "FROZEN" };
    }
    return loan;
  });
}

/**
 * 破产时关闭该玩家的待处理请求：凡他作为借款人或出借人的 PENDING 请求一律 CANCELLED，
 * 其他状态原样保留。返回新数组，不修改入参。
 */
export function closeRequestsForBankrupt(
  requests: readonly LoanRequest[],
  bankruptPlayerId: PlayerId,
): LoanRequest[] {
  return requests.map((request) => {
    if (
      request.status === "PENDING" &&
      (request.borrowerId === bankruptPlayerId || request.lenderId === bankruptPlayerId)
    ) {
      return { ...request, status: "CANCELLED" };
    }
    return request;
  });
}

/** 本人作为借款人的全部非 REPAID 合同剩余之和。 */
export function privateDebtCents(loans: readonly PrivateLoan[], playerId: PlayerId): Cents {
  return sumRemaining(loans, (loan) => loan.borrowerId === playerId && loan.status !== "REPAID");
}

/** 本人作为出借人的 ACTIVE 合同剩余之和；冻结与坏账不计入应收。 */
export function receivableCents(loans: readonly PrivateLoan[], playerId: PlayerId): Cents {
  return sumRemaining(loans, (loan) => loan.lenderId === playerId && loan.status === "ACTIVE");
}

/** 全部 FROZEN 合同剩余之和（保留记录，不是可操作债务）。 */
export function frozenCents(loans: readonly PrivateLoan[]): Cents {
  return sumRemaining(loans, (loan) => loan.status === "FROZEN");
}

/** 全部 BAD_DEBT 合同剩余之和（保留记录，不是可操作债务）。 */
export function badDebtCents(loans: readonly PrivateLoan[]): Cents {
  return sumRemaining(loans, (loan) => loan.status === "BAD_DEBT");
}

function sumRemaining(loans: readonly PrivateLoan[], predicate: (loan: PrivateLoan) => boolean): Cents {
  let total = 0;
  for (const loan of loans) {
    if (!predicate(loan)) continue;
    total += loan.remainingCents;
    assertCentsRange(total, "private loan total");
  }
  return total;
}
