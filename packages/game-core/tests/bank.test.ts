import { describe, expect, it } from "vitest";
import { MAX_MONEY_CENTS } from "@richman/shared";
import {
  BankRuleError,
  accrueInterest,
  borrowFromBank,
  defaultedBankDebtCents,
  repayBankLoan,
  settleDue,
  totalDebtCents,
} from "../src/bank.js";
import type {
  BankErrorCode,
  BankLoan,
  BorrowFromBankInput,
  DueDecision,
  LoanOrigin,
} from "../src/bank.js";

function borrow(overrides: Partial<BorrowFromBankInput> = {}): BankLoan {
  return borrowFromBank({
    loanId: "L1",
    borrowerId: "p1",
    seatId: 0,
    credit: "GOOD",
    goldCents: 10_000,
    amountCents: 5_000,
    existingLoans: [],
    round: 1,
    ...overrides,
  });
}

/** 手工构造“到期轮利息已计入”的 ACTIVE 贷款快照，用于单独验证失信冻结。 */
function dueActiveLoan(overrides: Partial<BankLoan> = {}): BankLoan {
  return {
    loanId: "L1",
    borrowerId: "p1",
    seatId: 0,
    principalCents: 10_000,
    remainingCents: 10_000,
    rateBps: 1_000,
    issuedRound: 1,
    dueRound: 4,
    lastInterestRound: 4,
    status: "ACTIVE",
    origin: "NORMAL",
    ...overrides,
  };
}

function expectCode(fn: () => unknown, code: BankErrorCode): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(BankRuleError);
    expect((error as BankRuleError).code).toBe(code);
    return;
  }
  throw new Error(`expected BankRuleError with code ${code}`);
}

describe("bank_interest_50", () => {
  it("借 50 金币，第 2/3/4 轮债务为 55/60.50/66.55，第 4 轮计息后到期", () => {
    const loan = borrow({ amountCents: 5_000 });
    expect(loan.principalCents).toBe(5_000);
    expect(loan.remainingCents).toBe(5_000);
    expect(loan.rateBps).toBe(1_000);
    expect(loan.issuedRound).toBe(1);
    expect(loan.dueRound).toBe(4);
    expect(loan.lastInterestRound).toBe(1);
    expect(loan.status).toBe("ACTIVE");

    // 借款当轮不计息
    expect(accrueInterest([loan], 1)[0]?.remainingCents).toBe(5_000);

    const round2 = accrueInterest([loan], 2)[0]!;
    expect(round2.remainingCents).toBe(5_500);
    expect(round2.lastInterestRound).toBe(2);

    const round3 = accrueInterest([round2], 3)[0]!;
    expect(round3.remainingCents).toBe(6_050);

    const round4 = accrueInterest([round3], 4)[0]!;
    expect(round4.remainingCents).toBe(6_655);
    expect(round4.dueRound).toBe(4);

    const settled = settleDue(round4, "REPAY", 6_655, 4);
    expect(settled.loan.status).toBe("REPAID");
    expect(settled.loan.remainingCents).toBe(0);
    expect(settled.paidCents).toBe(6_655);
  });
});

describe("rounding_and_limit", () => {
  it("0.05 金币按 10% 得 0.01 金币利息", () => {
    const tiny = borrow({ goldCents: 10, amountCents: 5 });
    expect(accrueInterest([tiny], 2)[0]?.remainingCents).toBe(6);
  });

  it("5051 分的 50% 上限向下取整为 2525 分", () => {
    const capped = borrow({ goldCents: 5_051, amountCents: 2_525 });
    expect(capped.remainingCents).toBe(2_525);
    expectCode(() => borrow({ loanId: "L2", goldCents: 5_051, amountCents: 2_526 }), "LOAN_CAP_EXCEEDED");
  });
});

describe("settleDue 边界与时序", () => {
  it("availableCents === remaining 时 REPAID，paidCents 等于实际偿还额", () => {
    const result = settleDue(dueActiveLoan(), "REPAY", 10_000, 4);
    expect(result.loan.status).toBe("REPAID");
    expect(result.loan.remainingCents).toBe(0);
    expect(result.paidCents).toBe(10_000);
  });

  it("availableCents === remaining - 1 时 DEFAULTED，余额冻结且 paidCents 为 0", () => {
    const result = settleDue(dueActiveLoan(), "REPAY", 9_999, 4);
    expect(result.loan.status).toBe("DEFAULTED");
    expect(result.loan.remainingCents).toBe(10_000);
    expect(result.paidCents).toBe(0);
  });

  it("到期轮之前调用原样返回且仍 ACTIVE（REPAY 与 REFUSE 都测）", () => {
    const loan = borrow({ amountCents: 5_000 });
    const repayBeforeDue = settleDue(loan, "REPAY", 5_000, 3);
    expect(repayBeforeDue.loan.status).toBe("ACTIVE");
    expect(repayBeforeDue.loan.remainingCents).toBe(5_000);
    expect(repayBeforeDue.paidCents).toBe(0);

    const refuseBeforeDue = settleDue(loan, "REFUSE", 0, 3);
    expect(refuseBeforeDue.loan.status).toBe("ACTIVE");
    expect(refuseBeforeDue.loan.remainingCents).toBe(5_000);
    expect(refuseBeforeDue.paidCents).toBe(0);
  });

  it("currentRound > dueRound 视为超时未决策，直接 DEFAULTED 且金额冻结", () => {
    const result = settleDue(dueActiveLoan(), "REFUSE", 0, 5);
    expect(result.loan.status).toBe("DEFAULTED");
    expect(result.loan.remainingCents).toBe(10_000);
    expect(result.paidCents).toBe(0);
  });

  it("逾期但到期轮利息未计入时，结算抛 INTEREST_NOT_ACCRUED（防止冻结少一轮利息）", () => {
    const loan = borrow({ amountCents: 10_000, goldCents: 20_000 });
    // lastInterestRound 仍停留在 issuedRound，没有计到 dueRound
    expect(() => settleDue(loan, "REFUSE", 0, 5)).toThrowError(/INTEREST_NOT_ACCRUED|到期轮利息尚未计入/);
  });

  it("逾期 ACTIVE 贷款再计息金额不变、不抛错", () => {
    const loan = dueActiveLoan();
    const accrued = accrueInterest([loan], 6)[0]!;
    expect(accrued.status).toBe("ACTIVE");
    expect(accrued.remainingCents).toBe(10_000);
    expect(accrued.lastInterestRound).toBe(4);
  });

  it("未到期传入非法 decision / availableCents 不抛错，原样返回", () => {
    const loan = borrow({ amountCents: 5_000 });
    const badDecision = settleDue(loan, "MAYBE" as unknown as DueDecision, -1, 3);
    expect(badDecision.loan.status).toBe("ACTIVE");
    expect(badDecision.loan.remainingCents).toBe(5_000);
    expect(badDecision.paidCents).toBe(0);

    const badAvailable = settleDue(loan, "REPAY", 1.5, 3);
    expect(badAvailable.loan.status).toBe("ACTIVE");
    expect(badAvailable.paidCents).toBe(0);
  });

  it("到期轮利息尚未计入就 settleDue 抛 INTEREST_NOT_ACCRUED", () => {
    const loan = borrow({ amountCents: 5_000 });
    expectCode(() => settleDue(loan, "REPAY", 5_000, 4), "INTEREST_NOT_ACCRUED");
    expectCode(() => settleDue(loan, "REFUSE", 0, 4), "INTEREST_NOT_ACCRUED");
  });

  it("还款轮次早于放款轮 -> INVALID_ROUND；当前轮未计息就还款 -> INTEREST_NOT_ACCRUED", () => {
    const futureLoan = dueActiveLoan({ issuedRound: 5, dueRound: 8, lastInterestRound: 5 });
    expectCode(() => repayBankLoan(futureLoan, 1_000, 1), "INVALID_ROUND");

    const loan = borrow({ amountCents: 5_000 });
    expectCode(() => repayBankLoan(loan, 1_000, 2), "INTEREST_NOT_ACCRUED");
  });

  it("当前轮超过到期轮后主动还款抛 LOAN_OVERDUE", () => {
    expectCode(() => repayBankLoan(dueActiveLoan(), 1_000, 5), "LOAN_OVERDUE");
  });
});

describe("default_no_repay", () => {
  it("失信 100 后任何还款请求被拒，金额恒为 100", () => {
    const loan = dueActiveLoan();
    const result = settleDue(loan, "REFUSE", 0, 4);
    expect(result.loan.status).toBe("DEFAULTED");
    expect(result.loan.remainingCents).toBe(10_000);
    expect(result.paidCents).toBe(0);

    expectCode(() => repayBankLoan(result.loan, 4_000, 4), "DEFAULTED_NOT_REPAYABLE");
    expectCode(() => repayBankLoan(result.loan, 10_000, 4), "DEFAULTED_NOT_REPAYABLE");
    expect(result.loan.remainingCents).toBe(10_000);
    expect(defaultedBankDebtCents([result.loan])).toBe(10_000);
  });
});

describe("default_freezes_interest", () => {
  it("失信后跨轮金额不变，也不参与补算利息", () => {
    const result = settleDue(dueActiveLoan(), "REFUSE", 0, 4);
    expect(result.loan.remainingCents).toBe(10_000);

    let loans = accrueInterest([result.loan], 5);
    expect(loans[0]?.remainingCents).toBe(10_000);
    loans = accrueInterest(loans, 6);
    expect(loans[0]?.remainingCents).toBe(10_000);
    loans = accrueInterest(loans, 7);
    expect(loans[0]?.remainingCents).toBe(10_000);
    expect(loans[0]?.status).toBe("DEFAULTED");
    expect(defaultedBankDebtCents(loans)).toBe(10_000);
  });
});

describe("multiple_bank_loans", () => {
  it("第 4 轮分别决策后，第 5 轮两笔都不再变化", () => {
    const normal = borrow({ loanId: "L1", amountCents: 5_000 });
    const overdraft = borrow({
      loanId: "L2",
      goldCents: 10_000,
      amountCents: 3_000,
      existingLoans: [normal],
      origin: "OVERDRAFT",
    });

    let loans = accrueInterest([normal, overdraft], 2);
    expect(loans[0]?.remainingCents).toBe(5_500);
    expect(loans[1]?.remainingCents).toBe(3_300);

    loans = accrueInterest(loans, 3);
    expect(loans[0]?.remainingCents).toBe(6_050);
    expect(loans[1]?.remainingCents).toBe(3_630);

    loans = accrueInterest(loans, 4);
    expect(loans[0]?.remainingCents).toBe(6_655);
    expect(loans[1]?.remainingCents).toBe(3_993);

    const defaultedNormal = settleDue(loans[0]!, "REFUSE", 0, 4);
    expect(defaultedNormal.loan.status).toBe("DEFAULTED");
    expect(defaultedNormal.loan.remainingCents).toBe(6_655);
    expect(defaultedNormal.paidCents).toBe(0);

    const repaidOverdraft = settleDue(loans[1]!, "REPAY", 3_993, 4);
    expect(repaidOverdraft.loan.status).toBe("REPAID");
    expect(repaidOverdraft.loan.remainingCents).toBe(0);
    expect(repaidOverdraft.paidCents).toBe(3_993);

    const round5 = accrueInterest([defaultedNormal.loan, repaidOverdraft.loan], 5);
    expect(round5[0]?.status).toBe("DEFAULTED");
    expect(round5[0]?.remainingCents).toBe(6_655);
    expect(round5[1]?.status).toBe("REPAID");
    expect(round5[1]?.remainingCents).toBe(0);
    expect(defaultedBankDebtCents(round5)).toBe(6_655);
    expect(totalDebtCents(round5)).toBe(6_655);
  });
});

describe("bank_ignores_private_debt", () => {
  it("有私人负债不影响银行借款资格与上限", () => {
    const loan = borrow({ privateDebtCents: 10_000, amountCents: 5_000 });
    expect(loan.status).toBe("ACTIVE");
    expect(loan.remainingCents).toBe(5_000);
    expectCode(
      () => borrow({ loanId: "L2", privateDebtCents: 10_000, amountCents: 5_001 }),
      "LOAN_CAP_EXCEEDED",
    );
  });
});

describe("overdraft_loan_no_cap", () => {
  it("赌博透支贷款不受 50% 上限限制，可以与其他贷款并存", () => {
    const normal = borrow({ loanId: "L1", goldCents: 10_000, amountCents: 5_000 });

    expectCode(
      () => borrow({ loanId: "L2", goldCents: 10_000, amountCents: 5_000, existingLoans: [normal] }),
      "ACTIVE_LOAN_EXISTS",
    );

    const overdraft = borrow({
      loanId: "L3",
      goldCents: 10_000,
      amountCents: 20_000,
      existingLoans: [normal],
      origin: "OVERDRAFT",
    });
    expect(overdraft.origin).toBe("OVERDRAFT");
    expect(overdraft.remainingCents).toBe(20_000);
    expect(overdraft.rateBps).toBe(1_000);
    expect(overdraft.issuedRound).toBe(1);
    expect(overdraft.dueRound).toBe(4);
    expect(overdraft.status).toBe("ACTIVE");
    expect(totalDebtCents([normal, overdraft])).toBe(25_000);
  });
});

describe("existing_loans_filter", () => {
  it("其他借款人的贷款与 REPAID 贷款不阻止本人借款", () => {
    const otherBorrower = borrow({ loanId: "L_OTHER", borrowerId: "p2", amountCents: 5_000 });
    const loan = borrow({ loanId: "L1", amountCents: 10_000, goldCents: 20_000 });
    const repaid = repayBankLoan(loan, 10_000, 1);

    const next = borrow({
      loanId: "L2",
      borrowerId: "p1",
      goldCents: 10_000,
      amountCents: 5_000,
      existingLoans: [otherBorrower, repaid],
    });
    expect(next.status).toBe("ACTIVE");
  });

  it("同一借款人含 DEFAULTED 贷款时阻止新增普通贷款", () => {
    const defaulted = dueActiveLoan({ status: "DEFAULTED" });
    expectCode(() => borrow({ existingLoans: [defaulted] }), "ACTIVE_LOAN_EXISTS");
  });
});

describe("invalid_amount", () => {
  it("负数、0、非整数分被拒绝", () => {
    for (const amount of [-100, 0, 1.5]) {
      expectCode(() => borrow({ amountCents: amount }), "INVALID_AMOUNT");
    }
  });

  it("goldCents 超过 MAX_MONEY_CENTS 被拒绝", () => {
    expectCode(() => borrow({ goldCents: MAX_MONEY_CENTS + 1 }), "INVALID_AMOUNT");
  });

  it("goldCents 为负数或 NaN -> INVALID_AMOUNT；恰好为 0 -> NO_GOLD", () => {
    expectCode(() => borrow({ goldCents: -1 }), "INVALID_AMOUNT");
    expectCode(() => borrow({ goldCents: Number.NaN }), "INVALID_AMOUNT");
    expectCode(() => borrow({ goldCents: 0 }), "NO_GOLD");
  });

  it("还款金额同样校验，且不得超过剩余欠款", () => {
    const loan = borrow({ amountCents: 5_000 });
    for (const amount of [0, -1, 1.5]) {
      expectCode(() => repayBankLoan(loan, amount, 1), "INVALID_AMOUNT");
    }
    expectCode(() => repayBankLoan(loan, 5_001, 1), "AMOUNT_EXCEEDS_DEBT");

    const partial = repayBankLoan(loan, 2_000, 1);
    expect(partial.status).toBe("ACTIVE");
    expect(partial.remainingCents).toBe(3_000);

    const repaid = repayBankLoan(partial, 3_000, 1);
    expect(repaid.status).toBe("REPAID");
    expect(repaid.remainingCents).toBe(0);
  });
});

describe("invalid_enum_and_round", () => {
  it("非法 origin 抛 INVALID_ORIGIN，不能绕过上限与信用检查", () => {
    expectCode(
      () => borrow({ origin: "WEIRD" as unknown as LoanOrigin, credit: "DEFAULTED", goldCents: 0 }),
      "INVALID_ORIGIN",
    );
  });

  it("非法 decision 抛 INVALID_DECISION", () => {
    expectCode(
      () => settleDue(dueActiveLoan(), "MAYBE" as unknown as DueDecision, 0, 4),
      "INVALID_DECISION",
    );
  });

  it("非法 round 抛 INVALID_ROUND", () => {
    for (const round of [0, 1.5, -1]) {
      expectCode(() => borrow({ round }), "INVALID_ROUND");
    }
    expectCode(() => borrow({ round: Number.MAX_SAFE_INTEGER }), "INVALID_ROUND");
    expectCode(() => accrueInterest([borrow()], 0), "INVALID_ROUND");
    expectCode(() => settleDue(dueActiveLoan(), "REFUSE", 0, 1.5), "INVALID_ROUND");
    expectCode(() => repayBankLoan(dueActiveLoan(), 1_000, 0), "INVALID_ROUND");
  });

  it("非法 availableCents 抛 INVALID_AMOUNT", () => {
    for (const available of [-1, 1.5, MAX_MONEY_CENTS + 1]) {
      expectCode(() => settleDue(dueActiveLoan(), "REPAY", available, 4), "INVALID_AMOUNT");
    }
  });
});

describe("interest_round_integrity", () => {
  it("同轮重复计息幂等，仍为 5500 分", () => {
    const once = accrueInterest([borrow({ amountCents: 5_000 })], 2)[0]!;
    expect(once.remainingCents).toBe(5_500);
    const twice = accrueInterest([once], 2)[0]!;
    expect(twice.remainingCents).toBe(5_500);
  });

  it("漏轮自动补算：issuedRound=1、lastInterestRound=1 时直接计到第 3 轮 -> 6050 分", () => {
    const loan = borrow({ amountCents: 5_000 });
    const caughtUp = accrueInterest([loan], 3)[0]!;
    expect(caughtUp.remainingCents).toBe(6_050);
    expect(caughtUp.lastInterestRound).toBe(3);
  });
});

describe("repaid_loan", () => {
  it("REPAID 后再还款 -> NOT_ACTIVE；settleDue 原样返回", () => {
    const loan = borrow({ amountCents: 10_000, goldCents: 20_000 });
    const repaid = repayBankLoan(loan, 10_000, 1);
    expect(repaid.status).toBe("REPAID");
    expect(repaid.remainingCents).toBe(0);

    expectCode(() => repayBankLoan(repaid, 100, 1), "NOT_ACTIVE");

    const settled = settleDue(repaid, "REPAY", 0, 4);
    expect(settled.loan).toEqual(repaid);
    expect(settled.loan.status).toBe("REPAID");
    expect(settled.paidCents).toBe(0);
  });
});

describe("immutability", () => {
  it("accrueInterest / repayBankLoan / settleDue 不修改入参", () => {
    const frozenLoan = Object.freeze(borrow({ amountCents: 5_000 })) as BankLoan;
    const accrued = accrueInterest([frozenLoan], 2)[0]!;
    expect(accrued.remainingCents).toBe(5_500);
    expect(frozenLoan.remainingCents).toBe(5_000);
    expect(frozenLoan.lastInterestRound).toBe(1);
    expect(accrued).not.toBe(frozenLoan);

    const partial = repayBankLoan(frozenLoan, 2_000, 1);
    expect(partial.remainingCents).toBe(3_000);
    expect(frozenLoan.remainingCents).toBe(5_000);
    expect(partial).not.toBe(frozenLoan);

    const frozenDue = Object.freeze(dueActiveLoan()) as BankLoan;
    const settled = settleDue(frozenDue, "REFUSE", 0, 4);
    expect(settled.loan.status).toBe("DEFAULTED");
    expect(frozenDue.status).toBe("ACTIVE");
    expect(frozenDue.remainingCents).toBe(10_000);
    expect(settled.loan).not.toBe(frozenDue);
  });
});
