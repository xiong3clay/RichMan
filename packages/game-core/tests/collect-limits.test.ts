import { describe, expect, it } from "vitest";
import { createInitialState, getPlayerView } from "../src/engine.js";
import type { PrivateLoan } from "../src/private-loans.js";

const config = { timerMode: "standard" as const, privateDebtAffectsBankLoan: false };
const seeds = [{ nickname: "甲" }, { nickname: "乙" }, { nickname: "丙" }];

function privateLoan(overrides: Partial<PrivateLoan> = {}): PrivateLoan {
  return {
    loanId: "p2p-1",
    requestId: "req-1",
    borrowerId: "p2",
    lenderId: "p1",
    principalCents: 5000,
    remainingCents: 5000,
    rateBps: 1000,
    issuedRound: 1,
    lastInterestRound: 1,
    status: "ACTIVE",
    ...overrides,
  };
}

function stateWith(loans: PrivateLoan[]) {
  const state = createInitialState("g1", config, seeds);
  (state as unknown as { privateLoans: PrivateLoan[] }).privateLoans = loans;
  return state;
}

function viewOf(state: ReturnType<typeof stateWith>, viewerId = "p1") {
  return getPlayerView(state, viewerId, new Date("2026-11-06T00:00:00Z"));
}

describe("07C collectLimits：本人为出借人的 ACTIVE 合同可收上限", () => {
  it("只包含本人为出借人的 ACTIVE 合同", () => {
    const state = stateWith([
      privateLoan({ loanId: "lend-active", lenderId: "p1", borrowerId: "p2" }),
      privateLoan({ loanId: "borrow-active", lenderId: "p2", borrowerId: "p1" }),
      privateLoan({ loanId: "third-party", lenderId: "p2", borrowerId: "p3" }),
    ]);
    expect(viewOf(state).finance.collectLimits.map((entry) => entry.loanId)).toEqual(["lend-active"]);
  });

  it("maxCents = min(remaining, 借款人当前金币)，借款人为负时取 0", () => {
    const state = stateWith([privateLoan({ loanId: "short", remainingCents: 5000 })]);
    state.players[1]!.cents = 3000;
    expect(viewOf(state).finance.collectLimits).toEqual([{ loanId: "short", maxCents: 3000 }]);

    state.players[1]!.cents = -500;
    expect(viewOf(state).finance.collectLimits).toEqual([{ loanId: "short", maxCents: 0 }]);

    state.players[1]!.cents = 9000;
    expect(viewOf(state).finance.collectLimits).toEqual([{ loanId: "short", maxCents: 5000 }]);
  });

  it("REPAID / BAD_DEBT / FROZEN 不进入可收上限", () => {
    const state = stateWith([
      privateLoan({ loanId: "repaid", status: "REPAID" }),
      privateLoan({ loanId: "bad", status: "BAD_DEBT" }),
      privateLoan({ loanId: "frozen", status: "FROZEN" }),
    ]);
    expect(viewOf(state).finance.collectLimits).toEqual([]);
  });

  it("隐私：只给 loanId 与 maxCents，不出现额外借款人字段", () => {
    const state = stateWith([privateLoan()]);
    const limit = viewOf(state).finance.collectLimits[0]!;
    expect(Object.keys(limit).sort()).toEqual(["loanId", "maxCents"]);
  });
});
