import { MAX_MONEY_CENTS, RULES } from "@richman/shared";
import { describe, expect, it } from "vitest";
import type { BankLoan } from "../src/bank.js";
import { createInitialState, getPlayerView } from "../src/engine.js";

const config = { timerMode: "standard" as const, privateDebtAffectsBankLoan: false };
const seeds = [{ nickname: "甲" }, { nickname: "乙" }, { nickname: "丙" }];

function loan(overrides: Partial<BankLoan> = {}): BankLoan {
  return {
    loanId: "bank-1",
    borrowerId: "p1",
    seatId: 1,
    principalCents: 5000,
    remainingCents: 5000,
    rateBps: 1000,
    issuedRound: 1,
    dueRound: 1,
    lastInterestRound: 1,
    status: "ACTIVE",
    origin: "NORMAL",
    ...overrides,
  };
}

function stateWith(loans: BankLoan[] = []) {
  const state = createInitialState("g1", config, seeds);
  (state as unknown as { bankLoans: BankLoan[] }).bankLoans = loans;
  return state;
}

function viewOf(state: ReturnType<typeof stateWith>, viewerId = "p1") {
  return getPlayerView(state, viewerId, new Date("2026-11-05T00:00:00Z"));
}

describe("bankBorrowLimitCents：银行普通贷款可借额度", () => {
  it("10000 分、GOOD、无贷款时显示 floor(金币/2)=5000", () => {
    const view = viewOf(stateWith());
    expect(view.me.cents).toBe(RULES.startCents);
    expect(view.finance.bankBorrowLimitCents).toBe(5000);
  });

  it("已有 ACTIVE 贷款时为 0", () => {
    const view = viewOf(stateWith([loan({ status: "ACTIVE" })]));
    expect(view.finance.bankBorrowLimitCents).toBe(0);
  });

  it("已有 DEFAULTED 贷款时为 0", () => {
    const view = viewOf(stateWith([loan({ status: "DEFAULTED" })]));
    expect(view.finance.bankBorrowLimitCents).toBe(0);
  });

  it("只有已结清（REPAID）的贷款记录时仍可借 5000，不会被永久卡死", () => {
    const view = viewOf(stateWith([loan({ status: "REPAID", remainingCents: 0 })]));
    expect(view.finance.bankBorrowLimitCents).toBe(5000);
  });

  it("金币只有 1 分时 floor(1/2)=0", () => {
    const state = stateWith();
    state.players[0]!.cents = 1;
    expect(viewOf(state).finance.bankBorrowLimitCents).toBe(0);
  });

  it("余额接近上限时额度取剩余空间，不按 50% 高报", () => {
    const near = stateWith();
    near.players[0]!.cents = MAX_MONEY_CENTS - 500;
    expect(viewOf(near).finance.bankBorrowLimitCents).toBe(500);
    const roomy = stateWith();
    roomy.players[0]!.cents = MAX_MONEY_CENTS - 1000;
    expect(viewOf(roomy).finance.bankBorrowLimitCents).toBe(1000);
  });

  it("信用失信时为 0", () => {
    const state = stateWith();
    state.players[0]!.credit = "DEFAULTED";
    expect(viewOf(state).finance.bankBorrowLimitCents).toBe(0);
  });

  it("金币为 0 时为 0", () => {
    const state = stateWith();
    state.players[0]!.cents = 0;
    expect(viewOf(state).finance.bankBorrowLimitCents).toBe(0);
  });
});

describe("lenderLimits：每个存活他人的可出借上限", () => {
  it("不含自己、不含已破产者，普通情况等于对方金币", () => {
    const state = stateWith();
    state.players[2]!.alive = false;
    const view = viewOf(state);
    expect(view.finance.lenderLimits.map((entry) => entry.playerId)).toEqual(["p2"]);
    expect(view.finance.lenderLimits[0]!.maxCents).toBe(RULES.startCents);
  });

  it("三名玩家全部存活时列出所有其他玩家", () => {
    const view = viewOf(stateWith());
    expect(view.finance.lenderLimits.map((entry) => entry.playerId)).toEqual(["p2", "p3"]);
  });

  it("本人金币接近上限时取 MAX_MONEY_CENTS - 本人金币", () => {
    const state = stateWith();
    state.players[0]!.cents = MAX_MONEY_CENTS - 1000;
    const view = viewOf(state);
    expect(view.finance.lenderLimits[0]!.maxCents).toBe(1000);
  });

  it("出借人金币为 0 时该条上限为 0", () => {
    const state = stateWith();
    state.players[1]!.cents = 0;
    const view = viewOf(state);
    expect(view.finance.lenderLimits[0]!.maxCents).toBe(0);
  });
});

describe("隐私：可借额度不泄露他人余额字段", () => {
  it("publicPlayers 元素仍不含 cents，本人 finance 带上新字段", () => {
    const view = viewOf(stateWith());
    for (const player of view.publicPlayers) {
      expect(Object.keys(player)).not.toContain("cents");
    }
    expect(Object.keys(view.publicPlayers[0]!)).not.toContain("maxCents");
    expect(view.finance).toHaveProperty("bankBorrowLimitCents");
    expect(view.finance).toHaveProperty("lenderLimits");
  });
});
