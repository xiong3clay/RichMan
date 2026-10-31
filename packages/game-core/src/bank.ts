import type { Cents, Credit, PlayerId, SeatId } from "@richman/shared";
import { MAX_MONEY_CENTS, RULES, assertCentsRange } from "@richman/shared";
import { interestFor, ordinaryLoanCap } from "./money.js";

/** 贷款状态：DEFAULTED 为永久失信，既不还也不计息。 */
export const LOAN_STATUS = {
  ACTIVE: "ACTIVE",
  REPAID: "REPAID",
  DEFAULTED: "DEFAULTED",
} as const;
export type LoanStatus = (typeof LOAN_STATUS)[keyof typeof LOAN_STATUS];

/** NORMAL 受 50% 上限与“无未结清贷款”限制；OVERDRAFT 由赌博杠杆亏损产生，不受上限限制。 */
export const LOAN_ORIGIN = {
  NORMAL: "NORMAL",
  OVERDRAFT: "OVERDRAFT",
} as const;
export type LoanOrigin = (typeof LOAN_ORIGIN)[keyof typeof LOAN_ORIGIN];

/** 银行贷款固定每轮 10%（1000 基点）。 */
export const BANK_LOAN_RATE_BPS = RULES.interestBps;

export interface BankLoan {
  loanId: string;
  borrowerId: PlayerId;
  seatId: SeatId;
  principalCents: Cents;
  remainingCents: Cents;
  rateBps: number;
  issuedRound: number;
  dueRound: number;
  lastInterestRound: number;
  status: LoanStatus;
  origin: LoanOrigin;
}

export type BankErrorCode =
  | "INVALID_AMOUNT"
  | "INVALID_ROUND"
  | "INVALID_ORIGIN"
  | "INVALID_DECISION"
  | "CREDIT_DEFAULTED"
  | "NO_GOLD"
  | "ACTIVE_LOAN_EXISTS"
  | "LOAN_CAP_EXCEEDED"
  | "NOT_ACTIVE"
  | "DEFAULTED_NOT_REPAYABLE"
  | "AMOUNT_EXCEEDS_DEBT"
  | "LOAN_OVERDUE"
  | "INTEREST_NOT_ACCRUED";

export class BankRuleError extends Error {
  readonly code: BankErrorCode;

  constructor(code: BankErrorCode, message: string = code) {
    super(message);
    this.name = "BankRuleError";
    this.code = code;
  }
}

export interface BorrowFromBankInput {
  loanId: string;
  borrowerId: PlayerId;
  seatId: SeatId;
  credit: Credit;
  goldCents: Cents;
  amountCents: Cents;
  existingLoans: readonly BankLoan[];
  round: number;
  /** 默认 NORMAL；OVERDRAFT 由赌博透支结算调用。 */
  origin?: LoanOrigin;
  /** D1：私人负债不影响银行贷款资格与上限，此字段只供调用方传递完整财务快照。 */
  privateDebtCents?: Cents;
}

export type DueDecision = "REPAY" | "REFUSE";

export interface SettleDueResult {
  loan: BankLoan;
  /** 实际从玩家余额扣走的金额：成功全额偿还时等于原 remainingCents，失信为 0。 */
  paidCents: Cents;
}

function assertPositiveCents(value: Cents, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_MONEY_CENTS) {
    throw new BankRuleError("INVALID_AMOUNT", `${label} 必须是 (0, MAX_MONEY_CENTS] 内的整数分`);
  }
}

function assertNonNegativeCents(value: Cents, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_MONEY_CENTS) {
    throw new BankRuleError("INVALID_AMOUNT", `${label} 必须是非负整数分`);
  }
}

function assertRound(round: number, label = "round"): void {
  if (!Number.isSafeInteger(round) || round < 1) {
    throw new BankRuleError("INVALID_ROUND", `${label} 必须是正整数轮次`);
  }
}

/**
 * 银行借款。NORMAL 要求信用 GOOD、金币 > 0、无未结清银行贷款，且金额不超过金币一半；
 * OVERDRAFT 不受这些限制，可与其他银行贷款并存。借款当轮不计息（lastInterestRound = issuedRound）。
 */
export function borrowFromBank(input: BorrowFromBankInput): BankLoan {
  assertRound(input.round);
  if (!Number.isSafeInteger(input.round + RULES.loanInterestRoundsBeforeDue)) {
    throw new BankRuleError("INVALID_ROUND", "round 过大，dueRound 会超出安全整数范围");
  }
  assertPositiveCents(input.amountCents, "amountCents");

  const origin = input.origin ?? "NORMAL";
  if (origin !== "NORMAL" && origin !== "OVERDRAFT") {
    throw new BankRuleError("INVALID_ORIGIN", `未知的贷款来源：${String(origin)}`);
  }

  if (origin === "NORMAL") {
    if (input.credit !== "GOOD") {
      throw new BankRuleError("CREDIT_DEFAULTED", "失信玩家不能新增普通银行贷款");
    }
    if (!Number.isSafeInteger(input.goldCents) || input.goldCents > MAX_MONEY_CENTS || input.goldCents < 0) {
      throw new BankRuleError("INVALID_AMOUNT", "goldCents 必须是范围 [0, MAX_MONEY_CENTS] 内的整数分");
    }
    if (input.goldCents === 0) {
      throw new BankRuleError("NO_GOLD", "金币为 0 时不能申请普通银行贷款");
    }
    if (input.existingLoans.some((loan) => loan.borrowerId === input.borrowerId && loan.status !== "REPAID")) {
      throw new BankRuleError("ACTIVE_LOAN_EXISTS", "本人存在未结清银行贷款，不能新增普通银行贷款");
    }
    if (input.amountCents > ordinaryLoanCap(input.goldCents)) {
      throw new BankRuleError("LOAN_CAP_EXCEEDED", "普通银行贷款不得超过当前金币的一半");
    }
  }

  return {
    loanId: input.loanId,
    borrowerId: input.borrowerId,
    seatId: input.seatId,
    principalCents: input.amountCents,
    remainingCents: input.amountCents,
    rateBps: BANK_LOAN_RATE_BPS,
    issuedRound: input.round,
    dueRound: input.round + RULES.loanInterestRoundsBeforeDue,
    lastInterestRound: input.round,
    status: "ACTIVE",
    origin,
  };
}

/**
 * 为所有 ACTIVE 贷款计息。计息上限为 dueRound：从 lastInterestRound+1 逐轮复利，
 * 最多补算到 min(round, dueRound)，漏轮自动补齐，过期后不再计息。
 * 非 ACTIVE 或未越过放款轮时原样返回；返回新数组，不修改入参。
 * 若复利后金额越过 MAX_MONEY_CENTS 会抛错（不截断、不造钱）；引擎收到该错误应把房间置 ERROR_PAUSED，
 * 不要吞掉后继续推进。
 */
export function accrueInterest(loans: readonly BankLoan[], round: number): BankLoan[] {
  assertRound(round);
  return loans.map((loan) => {
    if (loan.status !== "ACTIVE") return loan;
    if (round <= loan.issuedRound) return loan;

    const targetRound = Math.min(round, loan.dueRound);
    if (loan.lastInterestRound >= targetRound) return loan;

    let remainingCents = loan.remainingCents;
    let lastInterestRound = loan.lastInterestRound;
    while (lastInterestRound < targetRound) {
      lastInterestRound += 1;
      remainingCents += interestFor(remainingCents, loan.rateBps);
      assertCentsRange(remainingCents, "remainingCents");
    }
    return { ...loan, remainingCents, lastInterestRound };
  });
}

/** 主动部分/全额还款；只允许 ACTIVE，DEFAULTED 永久拒绝还款；逾期贷款拒绝拖延还款。 */
export function repayBankLoan(loan: BankLoan, cents: Cents, currentRound: number): BankLoan {
  assertRound(currentRound, "currentRound");
  if (loan.status === "DEFAULTED") {
    throw new BankRuleError("DEFAULTED_NOT_REPAYABLE", "失信贷款不可偿还");
  }
  if (loan.status !== "ACTIVE") {
    throw new BankRuleError("NOT_ACTIVE", "贷款已结清，无需再还款");
  }
  if (currentRound < loan.issuedRound) {
    throw new BankRuleError("INVALID_ROUND", "还款轮次不能早于放款轮次");
  }
  if (currentRound > loan.dueRound) {
    throw new BankRuleError("LOAN_OVERDUE", "贷款已逾期，不能靠还款拖回 ACTIVE，必须先完成到期结算");
  }
  if (currentRound > loan.lastInterestRound) {
    throw new BankRuleError("INTEREST_NOT_ACCRUED", "当前轮利息尚未计入，不能先还款");
  }
  assertPositiveCents(cents, "repay cents");
  if (cents > loan.remainingCents) {
    throw new BankRuleError("AMOUNT_EXCEEDS_DEBT", "还款金额不得超过剩余欠款");
  }

  const remainingCents = loan.remainingCents - cents;
  return { ...loan, remainingCents, status: remainingCents === 0 ? "REPAID" : "ACTIVE" };
}

/**
 * 处理到期银行贷款，返回新贷款与实际应扣金额，避免调用方按 availableCents 多扣。
 * 非 ACTIVE 或未到期原样返回；超过到期轮视为超时未决策，直接失信并冻结欠款。
 * 到期当轮要求利息已计入；REPAY 且余额足够 -> REPAID，否则 DEFAULTED。
 */
export function settleDue(
  loan: BankLoan,
  decision: DueDecision,
  availableCents: Cents,
  currentRound: number,
): SettleDueResult {
  assertRound(currentRound, "currentRound");
  if (loan.status !== "ACTIVE") return { loan, paidCents: 0 };
  if (currentRound < loan.dueRound) return { loan, paidCents: 0 };
  if (currentRound > loan.dueRound) {
    // 超时分支同样必须先计入到期轮利息，否则会冻结一个少一轮利息的欠款。
    if (loan.lastInterestRound < loan.dueRound) {
      throw new BankRuleError("INTEREST_NOT_ACCRUED", "到期轮利息尚未计入，不能按超时结算");
    }
    return { loan: { ...loan, status: "DEFAULTED" }, paidCents: 0 };
  }
  if (loan.lastInterestRound < loan.dueRound) {
    throw new BankRuleError("INTEREST_NOT_ACCRUED", "到期轮利息尚未计入，不能先结算");
  }
  if (decision !== "REPAY" && decision !== "REFUSE") {
    throw new BankRuleError("INVALID_DECISION", `未知的到期决策：${String(decision)}`);
  }
  assertNonNegativeCents(availableCents, "availableCents");

  if (decision === "REPAY" && availableCents >= loan.remainingCents) {
    return { loan: { ...loan, remainingCents: 0, status: "REPAID" }, paidCents: loan.remainingCents };
  }
  return { loan: { ...loan, status: "DEFAULTED" }, paidCents: 0 };
}

/** 全部 DEFAULTED 贷款的剩余欠款之和；失信后不再变化。 */
export function defaultedBankDebtCents(loans: readonly BankLoan[]): Cents {
  return sumRemaining(loans, (loan) => loan.status === "DEFAULTED");
}

/** 全部未结清（非 REPAID）贷款的剩余欠款之和。 */
export function totalDebtCents(loans: readonly BankLoan[]): Cents {
  return sumRemaining(loans, (loan) => loan.status !== "REPAID");
}

function sumRemaining(loans: readonly BankLoan[], predicate: (loan: BankLoan) => boolean): Cents {
  let total = 0;
  for (const loan of loans) {
    if (!predicate(loan)) continue;
    total += loan.remainingCents;
    assertCentsRange(total, "bank debt total");
  }
  return total;
}
