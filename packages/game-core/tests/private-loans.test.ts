import { describe, expect, it } from "vitest";
import { MAX_MONEY_CENTS } from "@richman/shared";
import {
  PrivateLoanRuleError,
  accruePrivateInterest,
  acceptLoanRequest,
  badDebtCents,
  cancelLoanRequest,
  closeRequestsForBankrupt,
  collectPrivateDebt,
  createLoanRequest,
  expireLoanRequest,
  frozenCents,
  privateDebtCents,
  receivableCents,
  refuseLoanRequest,
  repayPrivateLoan,
  settleBankruptcy,
} from "../src/private-loans.js";
import type {
  AcceptLoanRequestContext,
  CreateLoanRequestInput,
  LoanRequest,
  PrivateLoan,
  PrivateLoanErrorCode,
} from "../src/private-loans.js";

function request(overrides: Partial<CreateLoanRequestInput> = {}): LoanRequest {
  return createLoanRequest({
    requestId: "R1",
    borrowerId: "B",
    lenderId: "A",
    principalCents: 4_000,
    rateBps: 1_000,
    createdRound: 1,
    nowMs: 1_000,
    deadlineMs: 6_000,
    existingRequests: [],
    borrowerCredit: "GOOD",
    borrowerDefaultedBankDebtCents: 0,
    borrowerAlive: true,
    lenderAlive: true,
    ...overrides,
  });
}

function acceptCtx(overrides: Partial<AcceptLoanRequestContext> = {}): AcceptLoanRequestContext {
  return {
    lenderId: "A",
    nowMs: 2_000,
    lenderCents: 10_000,
    borrowerCents: 10_000,
    lenderAlive: true,
    borrowerAlive: true,
    loanId: "PL1",
    currentRound: 1,
    ...overrides,
  };
}

function activeLoan(overrides: Partial<PrivateLoan> = {}): PrivateLoan {
  return {
    loanId: "PL1",
    requestId: "R1",
    borrowerId: "B",
    lenderId: "A",
    principalCents: 4_000,
    remainingCents: 4_000,
    rateBps: 1_000,
    issuedRound: 1,
    lastInterestRound: 1,
    status: "ACTIVE",
    ...overrides,
  };
}

function expectCode(fn: () => unknown, code: PrivateLoanErrorCode): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(PrivateLoanRuleError);
    expect((error as PrivateLoanRuleError).code).toBe(code);
    return;
  }
  throw new Error(`expected PrivateLoanRuleError with code ${code}`);
}

describe("consent_required", () => {
  it("未经出借人同意不转账、不生成借条；非指定出借人不能批准", () => {
    const pending = request();
    expect(pending.status).toBe("PENDING");

    expectCode(
      () => acceptLoanRequest(pending, acceptCtx({ lenderId: "C" })),
      "LENDER_MISMATCH",
    );

    const refused = refuseLoanRequest(pending);
    expect(refused.status).toBe("REFUSED");
    expectCode(
      () => acceptLoanRequest(refused, acceptCtx()),
      "REQUEST_NOT_PENDING",
    );

    const cancelled = cancelLoanRequest(pending);
    expect(cancelled.status).toBe("CANCELLED");
    expectCode(
      () => acceptLoanRequest(cancelled, acceptCtx()),
      "REQUEST_NOT_PENDING",
    );
  });

  it("只有明确同意才在同一结果里完成转账与借条", () => {
    const accepted = acceptLoanRequest(request(), acceptCtx());
    expect(accepted.request.status).toBe("ACCEPTED");
    expect(accepted.loan).not.toBeNull();
    expect(accepted.lenderCents).toBe(6_000);
    expect(accepted.borrowerCents).toBe(14_000);
    expect(accepted.loan?.remainingCents).toBe(4_000);
  });
});

describe("private_partial_40", () => {
  it("A 借给 B 40（A=60、B=140），下一轮欠款 44；B 还 10 后 A=70、B=130、欠 34", () => {
    const accepted = acceptLoanRequest(request({ principalCents: 4_000 }), acceptCtx());
    expect(accepted.lenderCents).toBe(6_000);
    expect(accepted.borrowerCents).toBe(14_000);

    const loan = accepted.loan!;
    expect(loan.principalCents).toBe(4_000);
    expect(loan.remainingCents).toBe(4_000);
    expect(loan.issuedRound).toBe(1);

    const accrued = accruePrivateInterest([loan], 2)[0]!;
    expect(accrued.remainingCents).toBe(4_400);

    const repaid = repayPrivateLoan(accrued, 1_000, 2, accepted.borrowerCents, accepted.lenderCents);
    expect(repaid.paidCents).toBe(1_000);
    expect(repaid.loan.remainingCents).toBe(3_400);
    expect(repaid.borrowerCents).toBe(13_000);
    expect(repaid.lenderCents).toBe(7_000);
    expect(accepted.lenderCents + repaid.paidCents).toBe(repaid.lenderCents);
  });
});

describe("collect_partial", () => {
  it("催收 20 只转 20、债务只减 20", () => {
    const loan = activeLoan({ principalCents: 5_000, remainingCents: 5_000 });
    const collected = collectPrivateDebt(loan, 2_000, 2, 10_000, "A", 5_000);
    expect(collected.collectedCents).toBe(2_000);
    expect(collected.loan.remainingCents).toBe(3_000);
    expect(collected.borrowerCents).toBe(8_000);
    expect(collected.lenderCents).toBe(7_000);
  });

  it("借出当轮不能催收", () => {
    const loan = activeLoan({ principalCents: 5_000, remainingCents: 5_000 });
    expectCode(() => collectPrivateDebt(loan, 1_000, 1, 10_000, "A", 5_000), "INVALID_ROUND");
  });

  it("催收金额超过可收上限时抛 AMOUNT_EXCEEDS_COLLECTIBLE，金额与余额不变，错误含上限", () => {
    const loan = activeLoan({ principalCents: 3_000, remainingCents: 3_000 });
    const borrowerCents = 1_000;
    const lenderCents = 5_000;

    try {
      collectPrivateDebt(loan, 2_000, 2, borrowerCents, "A", lenderCents);
      throw new Error("expected PrivateLoanRuleError AMOUNT_EXCEEDS_COLLECTIBLE");
    } catch (error) {
      expect(error).toBeInstanceOf(PrivateLoanRuleError);
      expect((error as PrivateLoanRuleError).code).toBe("AMOUNT_EXCEEDS_COLLECTIBLE");
      expect((error as PrivateLoanRuleError).message).toContain("1000");
    }

    expect(loan.remainingCents).toBe(3_000);
    expect(borrowerCents).toBe(1_000);
    expect(lenderCents).toBe(5_000);
  });

  it("借款人余额为 0 时，任何催收金额都抛 AMOUNT_EXCEEDS_COLLECTIBLE（上限 0）", () => {
    const loan = activeLoan({ principalCents: 3_000, remainingCents: 3_000 });
    for (const cents of [1, 100, 3_000]) {
      try {
        collectPrivateDebt(loan, cents, 2, 0, "A", 5_000);
        throw new Error("expected PrivateLoanRuleError AMOUNT_EXCEEDS_COLLECTIBLE");
      } catch (error) {
        expect(error).toBeInstanceOf(PrivateLoanRuleError);
        expect((error as PrivateLoanRuleError).code).toBe("AMOUNT_EXCEEDS_COLLECTIBLE");
        expect((error as PrivateLoanRuleError).message).toContain("上限 0 分");
      }
    }
    expect(loan.remainingCents).toBe(3_000);
  });

  it("借款人余额为负时按 max(0, 余额) 计上限，同样拒绝而非封顶", () => {
    const loan = activeLoan({ principalCents: 3_000, remainingCents: 3_000 });
    try {
      collectPrivateDebt(loan, 1, 2, -500, "A", 5_000);
      throw new Error("expected PrivateLoanRuleError AMOUNT_EXCEEDS_COLLECTIBLE");
    } catch (error) {
      expect(error).toBeInstanceOf(PrivateLoanRuleError);
      expect((error as PrivateLoanRuleError).code).toBe("AMOUNT_EXCEEDS_COLLECTIBLE");
      expect((error as PrivateLoanRuleError).message).toContain("上限 0 分");
    }
    expect(loan.remainingCents).toBe(3_000);
  });

  it("足额催收后置 REPAID，且非指定出借人不能催", () => {
    const loan = activeLoan({ principalCents: 3_000, remainingCents: 3_000 });
    expectCode(() => collectPrivateDebt(loan, 1_000, 2, 10_000, "C", 5_000), "LENDER_MISMATCH");

    const collected = collectPrivateDebt(loan, 3_000, 2, 10_000, "A", 5_000);
    expect(collected.collectedCents).toBe(3_000);
    expect(collected.loan.status).toBe("REPAID");
    expect(collected.loan.remainingCents).toBe(0);
    expect(collected.borrowerCents).toBe(7_000);
    expect(collected.lenderCents).toBe(8_000);
  });
});

describe("approve_deadline", () => {
  it("行动只剩 5 秒时请求只有 5 秒；nowMs 恰好等于 deadlineMs 不生效", () => {
    const pending = request({ nowMs: 1_000, deadlineMs: 6_000 });

    const atDeadline = acceptLoanRequest(pending, acceptCtx({ nowMs: 6_000 }));
    expect(atDeadline.request.status).toBe("EXPIRED");
    expect(atDeadline.loan).toBeNull();
    expect(atDeadline.lenderCents).toBe(10_000);
    expect(atDeadline.borrowerCents).toBe(10_000);

    const justBefore = acceptLoanRequest(pending, acceptCtx({ nowMs: 5_999 }));
    expect(justBefore.request.status).toBe("ACCEPTED");
    expect(justBefore.loan).not.toBeNull();
  });

  it("批准时余额不足 -> FAILED 且双方余额都不变", () => {
    const pending = request({ requestId: "R2" });
    const failed = acceptLoanRequest(pending, acceptCtx({ lenderCents: 3_999 }));
    expect(failed.request.status).toBe("FAILED");
    expect(failed.loan).toBeNull();
    expect(failed.lenderCents).toBe(3_999);
    expect(failed.borrowerCents).toBe(10_000);

    expectCode(
      () => acceptLoanRequest(failed.request, acceptCtx({ lenderCents: 10_000 })),
      "REQUEST_NOT_PENDING",
    );
  });

  it("超时请求可显式置 EXPIRED，且不能再生效", () => {
    const expired = expireLoanRequest(request());
    expect(expired.status).toBe("EXPIRED");
    expectCode(
      () => acceptLoanRequest(expired, acceptCtx()),
      "REQUEST_NOT_PENDING",
    );
  });
});

describe("accept_revalidates_request", () => {
  it("本金被改坏（负数/0/小数/超上限）抛 INVALID_REQUEST，双方余额不变", () => {
    const lenderCents = 10_000;
    const borrowerCents = 10_000;
    for (const principal of [-4_000, 0, 1.5, MAX_MONEY_CENTS + 1]) {
      const tampered: LoanRequest = { ...request(), principalCents: principal };
      expectCode(
        () => acceptLoanRequest(tampered, acceptCtx({ lenderCents, borrowerCents })),
        "INVALID_REQUEST",
      );
      expect(tampered.status).toBe("PENDING");
      expect(tampered.principalCents).toBe(principal);
    }
    expect(lenderCents).toBe(10_000);
    expect(borrowerCents).toBe(10_000);
  });

  it("利率被改坏（-1 / 10001）抛 INVALID_REQUEST，双方余额不变", () => {
    const lenderCents = 10_000;
    const borrowerCents = 10_000;
    for (const rateBps of [-1, 10_001]) {
      const tampered: LoanRequest = { ...request(), rateBps };
      expectCode(
        () => acceptLoanRequest(tampered, acceptCtx({ lenderCents, borrowerCents })),
        "INVALID_REQUEST",
      );
    }
    expect(lenderCents).toBe(10_000);
    expect(borrowerCents).toBe(10_000);
  });

  it("出借人被改成借款人本人时抛 INVALID_REQUEST，而不是照旧转账", () => {
    const lenderCents = 10_000;
    const borrowerCents = 10_000;
    const tampered: LoanRequest = { ...request(), lenderId: "B" };
    expectCode(() => acceptLoanRequest(tampered, acceptCtx({ lenderCents, borrowerCents })), "INVALID_REQUEST");
    expect(tampered.status).toBe("PENDING");
    expect(lenderCents).toBe(10_000);
    expect(borrowerCents).toBe(10_000);
  });
});

describe("borrower_bankrupt", () => {
  it("借款人破产 -> BAD_DEBT，金额冻结、不再计息、应收剔除", () => {
    const loan = activeLoan({ remainingCents: 4_000 });
    const settled = settleBankruptcy([loan], "B")[0]!;
    expect(settled.status).toBe("BAD_DEBT");
    expect(settled.remainingCents).toBe(4_000);

    const accrued = accruePrivateInterest([settled], 2)[0]!;
    expect(accrued.remainingCents).toBe(4_000);
    expect(accrued.status).toBe("BAD_DEBT");

    expect(receivableCents([settled], "A")).toBe(0);
    expect(privateDebtCents([settled], "B")).toBe(4_000);
    expect(badDebtCents([settled])).toBe(4_000);
    expect(frozenCents([settled])).toBe(0);
  });
});

describe("lender_bankrupt", () => {
  it("出借人破产 -> FROZEN，金额冻结、不再计息、应收剔除", () => {
    const loan = activeLoan({ remainingCents: 4_000 });
    const settled = settleBankruptcy([loan], "A")[0]!;
    expect(settled.status).toBe("FROZEN");
    expect(settled.remainingCents).toBe(4_000);

    const accrued = accruePrivateInterest([settled], 2)[0]!;
    expect(accrued.remainingCents).toBe(4_000);
    expect(accrued.status).toBe("FROZEN");

    expect(receivableCents([settled], "A")).toBe(0);
    expect(privateDebtCents([settled], "B")).toBe(4_000);
    expect(frozenCents([settled])).toBe(4_000);
    expect(badDebtCents([settled])).toBe(0);
  });

  it("冻结合同的借款人后来破产 -> BAD_DEBT，保留冻结金额", () => {
    const frozen = settleBankruptcy([activeLoan({ remainingCents: 4_000 })], "A")[0]!;
    const bad = settleBankruptcy([frozen], "B")[0]!;
    expect(bad.status).toBe("BAD_DEBT");
    expect(bad.remainingCents).toBe(4_000);
  });
});

describe("bankrupt_closes_requests", () => {
  it("破产者作为借款人/出借人的 PENDING 请求都置 CANCELLED，非 PENDING 不动，入参不变", () => {
    const asBorrower = request({ requestId: "RB", borrowerId: "B", lenderId: "A" });
    const asLender = request({ requestId: "RL", borrowerId: "C", lenderId: "B" });
    const accepted = acceptLoanRequest(asBorrower, acceptCtx()).request;
    const refused = refuseLoanRequest(request({ requestId: "RR", borrowerId: "B", lenderId: "C" }));
    const unrelated = request({ requestId: "RU", borrowerId: "C", lenderId: "A" });

    const requests = [asBorrower, asLender, accepted, refused, unrelated];
    const closed = closeRequestsForBankrupt(requests, "B");

    expect(closed[0]?.status).toBe("CANCELLED");
    expect(closed[1]?.status).toBe("CANCELLED");
    expect(closed[2]?.status).toBe("ACCEPTED");
    expect(closed[3]?.status).toBe("REFUSED");
    expect(closed[4]?.status).toBe("PENDING");

    expect(requests[0]?.status).toBe("PENDING");
    expect(requests[1]?.status).toBe("PENDING");
    expect(closed[0]).not.toBe(requests[0]);
    expect(closed[4]).toBe(requests[4]);
  });
});

describe("concurrent_intents", () => {
  it("按串行顺序先同意再还款，后一笔按更新后的余额校验，不重复转账", () => {
    const pending = request();
    const first = acceptLoanRequest(pending, acceptCtx());

    expectCode(
      () =>
        acceptLoanRequest(
          first.request,
          acceptCtx({ lenderCents: first.lenderCents, borrowerCents: first.borrowerCents }),
        ),
      "REQUEST_NOT_PENDING",
    );

    const repaid = repayPrivateLoan(
      first.loan!,
      4_000,
      1,
      first.borrowerCents,
      first.lenderCents,
    );
    expect(repaid.loan.status).toBe("REPAID");
    expect(repaid.loan.remainingCents).toBe(0);
    expect(repaid.paidCents).toBe(4_000);
    expect(repaid.borrowerCents).toBe(10_000);
    expect(repaid.lenderCents).toBe(10_000);
    expect(first.lenderCents + repaid.paidCents).toBe(repaid.lenderCents);

    expectCode(() => repayPrivateLoan(repaid.loan, 1, 1, repaid.borrowerCents, repaid.lenderCents), "NOT_ACTIVE");
    expectCode(
      () => collectPrivateDebt(repaid.loan, 1, 2, repaid.borrowerCents, "A", repaid.lenderCents),
      "NOT_ACTIVE",
    );
  });

  it("余额不足的失败结果不能被后续同一请求重新批准", () => {
    const pending = request({ requestId: "R3" });
    const failed = acceptLoanRequest(pending, acceptCtx({ lenderCents: 3_999 }));
    expect(failed.request.status).toBe("FAILED");
    expect(failed.loan).toBeNull();

    expectCode(
      () => acceptLoanRequest(failed.request, acceptCtx({ lenderCents: 10_000 })),
      "REQUEST_NOT_PENDING",
    );
  });
});

describe("request_shows_defaulted_flag", () => {
  it("失信借款人可发起请求，请求快照信用与失信欠款", () => {
    const pending = request({
      borrowerCredit: "DEFAULTED",
      borrowerDefaultedBankDebtCents: 10_000,
    });
    expect(pending.status).toBe("PENDING");
    expect(pending.borrowerCredit).toBe("DEFAULTED");
    expect(pending.borrowerDefaultedBankDebtCents).toBe(10_000);
    expect(pending.principalCents).toBe(4_000);
  });
});

describe("accrue", () => {
  it("下一轮才第一次计息，逐轮复利且漏轮自动补算", () => {
    const loan = activeLoan({ principalCents: 5_000, remainingCents: 5_000 });

    const sameRound = accruePrivateInterest([loan], 1)[0]!;
    expect(sameRound.remainingCents).toBe(5_000);
    expect(sameRound.lastInterestRound).toBe(1);

    const round2 = accruePrivateInterest([loan], 2)[0]!;
    expect(round2.remainingCents).toBe(5_500);
    expect(round2.lastInterestRound).toBe(2);

    const round3 = accruePrivateInterest([round2], 3)[0]!;
    expect(round3.remainingCents).toBe(6_050);

    const caughtUp = accruePrivateInterest([loan], 3)[0]!;
    expect(caughtUp.remainingCents).toBe(6_050);
    expect(caughtUp.lastInterestRound).toBe(3);
  });

  it("同轮重复计息幂等", () => {
    const once = accruePrivateInterest([activeLoan()], 2)[0]!;
    const twice = accruePrivateInterest([once], 2)[0]!;
    expect(once.remainingCents).toBe(4_400);
    expect(twice.remainingCents).toBe(4_400);
  });

  it("FROZEN / BAD_DEBT / REPAID 不计息", () => {
    const loans: PrivateLoan[] = [
      activeLoan({ loanId: "F", status: "FROZEN" }),
      activeLoan({ loanId: "D", status: "BAD_DEBT" }),
      activeLoan({ loanId: "P", status: "REPAID" }),
    ];
    const accrued = accruePrivateInterest(loans, 2);
    for (const loan of accrued) {
      expect(loan.remainingCents).toBe(4_000);
    }
  });
});

describe("collector_overflow", () => {
  it("出借人余额接近上限时收款越界 -> INVALID_AMOUNT，双方与债务都不变", () => {
    const loan = activeLoan();
    const lenderCents = MAX_MONEY_CENTS;
    const borrowerCents = 10_000;

    expectCode(
      () => repayPrivateLoan(loan, 1_000, 1, borrowerCents, lenderCents),
      "INVALID_AMOUNT",
    );
    expectCode(
      () => collectPrivateDebt(loan, 1_000, 2, borrowerCents, "A", lenderCents),
      "INVALID_AMOUNT",
    );

    expect(lenderCents).toBe(MAX_MONEY_CENTS);
    expect(borrowerCents).toBe(10_000);
    expect(loan.remainingCents).toBe(4_000);
    expect(loan.status).toBe("ACTIVE");
  });
});

describe("boundaries", () => {
  it("本金与利率越界被拒绝", () => {
    for (const principal of [-1, 0, 1.5, MAX_MONEY_CENTS + 1]) {
      expectCode(() => request({ principalCents: principal }), "INVALID_AMOUNT");
    }
    for (const rate of [-1, 10_001, 1.5]) {
      expectCode(() => request({ rateBps: rate }), "INVALID_RATE");
    }
  });

  it("不能向自己借款，双方必须存活", () => {
    expectCode(() => request({ borrowerId: "A", lenderId: "A" }), "SELF_LOAN");
    expectCode(() => request({ borrowerAlive: false }), "PARTY_NOT_ALIVE");
    expectCode(() => request({ lenderAlive: false }), "PARTY_NOT_ALIVE");
  });

  it("截止时间必须晚于当前时间", () => {
    expectCode(() => request({ nowMs: 5_000, deadlineMs: 5_000 }), "INVALID_DEADLINE");
    expectCode(() => request({ nowMs: 5_001, deadlineMs: 5_000 }), "INVALID_DEADLINE");
    expectCode(() => request({ deadlineMs: 5_000.5 }), "INVALID_DEADLINE");
  });

  it("同一借款人最多一个 PENDING 请求，已结束请求不阻塞", () => {
    const pending = request();
    expectCode(
      () => request({ requestId: "R2", existingRequests: [pending] }),
      "DUPLICATE_PENDING_REQUEST",
    );

    const refused = refuseLoanRequest(pending);
    const next = request({ requestId: "R2", existingRequests: [refused] });
    expect(next.status).toBe("PENDING");
  });

  it("非 PENDING 请求不能拒/取消/过期", () => {
    const accepted = acceptLoanRequest(request(), acceptCtx()).request;
    expectCode(() => refuseLoanRequest(accepted), "REQUEST_NOT_PENDING");
    expectCode(() => cancelLoanRequest(accepted), "REQUEST_NOT_PENDING");
    expectCode(() => expireLoanRequest(accepted), "REQUEST_NOT_PENDING");
  });

  it("还款金额、余额与状态边界", () => {
    const loan = activeLoan();
    for (const cents of [0, -1, 1.5]) {
      expectCode(() => repayPrivateLoan(loan, cents, 1, 10_000, 10_000), "INVALID_AMOUNT");
    }
    expectCode(() => repayPrivateLoan(loan, 4_001, 1, 10_000, 10_000), "AMOUNT_EXCEEDS_DEBT");
    expectCode(() => repayPrivateLoan(loan, 4_000, 1, 3_999, 10_000), "INSUFFICIENT_FUNDS");
    expectCode(
      () => repayPrivateLoan(activeLoan({ status: "REPAID" }), 1, 1, 10_000, 10_000),
      "NOT_ACTIVE",
    );
  });

  it("催收金额与状态边界", () => {
    const loan = activeLoan();
    expectCode(() => collectPrivateDebt(loan, 0, 2, 10_000, "A", 10_000), "INVALID_AMOUNT");
    expectCode(() => collectPrivateDebt(loan, 1, 1, 10_000, "A", 10_000), "INVALID_ROUND");
    expectCode(() => collectPrivateDebt(loan, 1, 2, 10_000, "C", 10_000), "LENDER_MISMATCH");
    expectCode(
      () => collectPrivateDebt(activeLoan({ status: "FROZEN" }), 1, 2, 10_000, "A", 10_000),
      "NOT_ACTIVE",
    );
  });
});

describe("immutability", () => {
  it("accruePrivateInterest / repayPrivateLoan / collectPrivateDebt 不修改入参", () => {
    const frozenLoan = Object.freeze(activeLoan()) as PrivateLoan;
    const accrued = accruePrivateInterest([frozenLoan], 2)[0]!;
    expect(accrued.remainingCents).toBe(4_400);
    expect(frozenLoan.remainingCents).toBe(4_000);
    expect(frozenLoan.lastInterestRound).toBe(1);
    expect(accrued).not.toBe(frozenLoan);

    const repaid = repayPrivateLoan(frozenLoan, 1_000, 1, 10_000, 10_000);
    expect(repaid.loan.remainingCents).toBe(3_000);
    expect(repaid.borrowerCents).toBe(9_000);
    expect(repaid.lenderCents).toBe(11_000);
    expect(frozenLoan.remainingCents).toBe(4_000);
    expect(repaid.loan).not.toBe(frozenLoan);

    const frozenDue = Object.freeze(activeLoan({ principalCents: 5_000, remainingCents: 5_000 })) as PrivateLoan;
    const collected = collectPrivateDebt(frozenDue, 2_000, 2, 10_000, "A", 5_000);
    expect(collected.loan.remainingCents).toBe(3_000);
    expect(collected.borrowerCents).toBe(8_000);
    expect(collected.lenderCents).toBe(7_000);
    expect(frozenDue.remainingCents).toBe(5_000);
    expect(collected.loan).not.toBe(frozenDue);
  });
});

describe("rereview_negative_balance_and_deadline", () => {
  it("负余额借款人可以被批准（R08 紧急借款路径）", () => {
    const out = acceptLoanRequest(request(), acceptCtx({ borrowerCents: -2_000, lenderCents: 9_000 }));
    expect(out.request.status).toBe("ACCEPTED");
    expect(out.loan?.status).toBe("ACTIVE");
    expect(out.borrowerCents).toBe(2_000);
    expect(out.lenderCents).toBe(5_000);
  });

  it("负余额出借人仍被拒绝（不能凭空造钱）", () => {
    expectCode(
      () => acceptLoanRequest(request(), acceptCtx({ lenderCents: -1 })),
      "INVALID_AMOUNT",
    );
  });

  it("负余额出借人可以催收（R08 危险玩家作为债权人）", () => {
    const out = collectPrivateDebt(activeLoan({ remainingCents: 3_000 }), 1_000, 2, 5_000, "A", -2_000);
    expect(out.collectedCents).toBe(1_000);
    expect(out.lenderCents).toBe(-1_000);
    expect(out.loan.remainingCents).toBe(2_000);
    expect(out.loan.status).toBe("ACTIVE");
  });

  it("deadlineMs 为 NaN 的伪造请求在同意时被拒", () => {
    const forged = { ...request(), deadlineMs: Number.NaN };
    expectCode(() => acceptLoanRequest(forged, acceptCtx()), "INVALID_DEADLINE");
  });

  it("deadlineMs 缺失（undefined）同样被拒", () => {
    const forged = { ...request(), deadlineMs: undefined as unknown as number };
    expectCode(() => acceptLoanRequest(forged, acceptCtx()), "INVALID_DEADLINE");
  });

  it("跨轮请求一律无效：置 EXPIRED 且不转账", () => {
    const out = acceptLoanRequest(request(), acceptCtx({ currentRound: 2 }));
    expect(out.request.status).toBe("EXPIRED");
    expect(out.loan).toBeNull();
    expect(out.lenderCents).toBe(10_000);
    expect(out.borrowerCents).toBe(10_000);
  });
});
