import { describe, expect, it } from "vitest";
import { CREDIT } from "@richman/shared";
import { advanceSystem, createInitialState, type EngineState } from "@richman/game-core";
import { decideBotCommand } from "../src/bots/policy.js";
import type { GameCommandDraft } from "../src/bots/policy.js";

type BankLoan = EngineState["bankLoans"][number];
type PrivateLoan = EngineState["privateLoans"][number];
type LoanRequest = EngineState["requests"][number];

const config = { timerMode: "standard" as const, privateDebtAffectsBankLoan: false };
const BOT = "p1";

function initial(): EngineState {
  return createInitialState("g1", config, [{ nickname: "AI" }, { nickname: "人类" }]);
}

/** INTEREST 无截止，系统直接推进到 ACTION，currentSeatId = 1（AI 座位）。 */
function actionState(): EngineState {
  return advanceSystem(initial(), { actorId: "SYSTEM", nowMs: 0, drawResult: 0 }).state as EngineState;
}

function bankLoan(patch: Partial<BankLoan> = {}): BankLoan {
  return {
    loanId: "bank-1",
    borrowerId: BOT,
    seatId: 1,
    principalCents: 1_000,
    remainingCents: 1_100,
    rateBps: 1_000,
    issuedRound: 1,
    dueRound: 4,
    lastInterestRound: 1,
    status: "ACTIVE",
    origin: "NORMAL",
    ...patch,
  };
}

function privateLoan(patch: Partial<PrivateLoan> = {}): PrivateLoan {
  return {
    loanId: "p2p-1",
    requestId: "req-1",
    borrowerId: BOT,
    lenderId: "p2",
    principalCents: 500,
    remainingCents: 500,
    rateBps: 1_000,
    issuedRound: 1,
    lastInterestRound: 1,
    status: "ACTIVE",
    ...patch,
  };
}

function request(patch: Partial<LoanRequest> = {}): LoanRequest {
  return {
    requestId: "req-1",
    borrowerId: "p2",
    lenderId: BOT,
    principalCents: 400,
    rateBps: 1_000,
    createdRound: 1,
    createdAtMs: 0,
    deadlineMs: 10_000,
    status: "PENDING",
    borrowerCredit: CREDIT.GOOD,
    borrowerDefaultedBankDebtCents: 0,
    ...patch,
  };
}

function withState(state: EngineState, patch: Partial<EngineState>): EngineState {
  return { ...structuredClone(state), ...patch };
}

function decide(state: EngineState, rng: () => number = () => 0.9): GameCommandDraft | null {
  return decideBotCommand(state, BOT, 0, rng);
}

describe("AI 决策：阶段与边界", () => {
  it("INTEREST/GAME_OVER/未知玩家/破产玩家都不行动", () => {
    expect(decide(withState(initial(), { phase: "INTEREST" }))).toBeNull();
    expect(decide(withState(initial(), { phase: "GAME_OVER" }))).toBeNull();
    expect(decideBotCommand(initial(), "p9", 0, () => 0.9)).toBeNull();
    const dead = withState(actionState(), {});
    dead.players[0]!.alive = false;
    expect(decide(dead)).toBeNull();
  });

  it("ACTION 未轮到自己时不行动", () => {
    expect(decide(withState(actionState(), { currentSeatId: 2 }))).toBeNull();
    expect(decide(withState(actionState(), { currentSeatId: null }))).toBeNull();
  });

  it("BANK_DUE 现金足够时选择一次性结清，不足时只能拒绝", () => {
    const base = withState(initial(), {
      phase: "BANK_DUE",
      pendingDueLoanId: "bank-1",
      bankLoans: [bankLoan({ remainingCents: 1_100 })],
    });
    base.players[0]!.cents = 1_100;
    const repay = decide(base);
    expect(repay?.type).toBe("BANK_DUE_DECISION");
    expect(repay?.payload).toMatchObject({ loanId: "bank-1", pendingDueLoanId: "bank-1", decision: "REPAY" });

    const poor = structuredClone(base);
    poor.players[0]!.cents = 1_099;
    expect(decide(poor)?.payload).toMatchObject({ decision: "REFUSE" });

    const other = structuredClone(base);
    other.bankLoans[0]!.borrowerId = "p2";
    expect(decide(other)).toBeNull();

    expect(decide(withState(initial(), { phase: "BANK_DUE", pendingDueLoanId: null }))).toBeNull();
  });

  it("ACTION 优先一次还清私人债，并带上当前版本", () => {
    const state = withState(actionState(), { privateLoans: [privateLoan({ remainingCents: 640 })] });
    state.players[0]!.cents = 1_000;
    const draft = decide(state);
    expect(draft).toMatchObject({
      type: "REPAY_PRIVATE",
      payload: { loanId: "p2p-1", cents: 640 },
      expectedGameVersion: state.version,
    });
  });

  it("私人债还不起时改还临期银行债；未临期则结束行动", () => {
    const state = withState(actionState(), {
      privateLoans: [privateLoan({ remainingCents: 2_000 })],
      bankLoans: [bankLoan({ dueRound: 2, remainingCents: 1_100 })],
    });
    state.round = 1;
    state.players[0]!.cents = 1_500;
    expect(decide(state)).toMatchObject({
      type: "REPAY_BANK",
      payload: { loanId: "bank-1", cents: 1_100 },
      expectedGameVersion: state.version,
    });

    const notDue = structuredClone(state);
    notDue.bankLoans[0]!.dueRound = 4;
    expect(decide(notDue)).toMatchObject({ type: "END_ACTION" });

    const overdue = structuredClone(state);
    overdue.bankLoans[0]!.dueRound = 1;
    expect(decide(overdue)).toMatchObject({ type: "END_ACTION" });
  });

  it("现金低于 1 元时借最小可用额度，且永不超过 50% 上限", () => {
    const state = actionState();
    state.players[0]!.cents = 50;
    const draft = decide(state);
    expect(draft).toMatchObject({
      type: "BORROW_BANK",
      payload: { amountCents: 25 },
      expectedGameVersion: state.version,
    });
    const amount = (draft!.payload as { amountCents: number }).amountCents;
    expect(amount).toBeLessThanOrEqual(Math.floor(50 / 2));
  });

  it("现金不足 2 分、失信或已有未结清贷款时都不借钱", () => {
    for (const cents of [0, 1]) {
      const state = actionState();
      state.players[0]!.cents = cents;
      expect(decide(state)).toMatchObject({ type: "END_ACTION" });
    }

    const defaulted = actionState();
    defaulted.players[0]!.cents = 50;
    defaulted.players[0]!.credit = CREDIT.DEFAULTED;
    expect(decide(defaulted)).toMatchObject({ type: "END_ACTION" });

    const owed = actionState();
    owed.players[0]!.cents = 50;
    owed.bankLoans = [bankLoan({ dueRound: 9 })];
    expect(decide(owed)).toMatchObject({ type: "END_ACTION" });

    const repaid = actionState();
    repaid.players[0]!.cents = 50;
    repaid.bankLoans = [bankLoan({ status: "REPAID", dueRound: 1, remainingCents: 0 })];
    expect(decide(repaid)).toMatchObject({ type: "BORROW_BANK" });
  });

  it("失信玩家的银行欠款保持 DEFAULTED，不产生 REPAY_BANK", () => {
    const state = actionState();
    state.players[0]!.credit = CREDIT.DEFAULTED;
    state.players[0]!.cents = 10_000;
    state.bankLoans = [bankLoan({ status: "DEFAULTED", dueRound: 1 })];
    expect(decide(state)).toMatchObject({ type: "END_ACTION" });
  });
});

describe("AI 决策：下注", () => {
  function betting(cents: number): EngineState {
    const state = withState(initial(), { phase: "BETTING" });
    state.players[0]!.cents = cents;
    return state;
  }

  it("rng < 0.6 时不下注直接跳过（0 分合法）", () => {
    const state = betting(10_000);
    const draft = decide(state, () => 0.1);
    expect(draft).toMatchObject({
      type: "SUBMIT_BET",
      payload: { betCents: 0, guess: 1, leverage: 1 },
      roundId: state.round,
      phaseInstanceId: state.phaseInstanceId,
    });
  });

  it("rng >= 0.6 时押 1 点、金额 min(10 分, 现金 10%)", () => {
    const rich = betting(10_000);
    expect(decide(rich, () => 0.9)?.payload).toMatchObject({ betCents: 10, guess: 1, leverage: 1 });
    const poor = betting(55);
    expect(decide(poor, () => 0.9)?.payload).toMatchObject({ betCents: 5 });
    const broke = betting(0);
    expect(decide(broke, () => 0.9)?.payload).toMatchObject({ betCents: 0 });
  });

  it("已锁定下注后不再重复提交", () => {
    const state = betting(10_000);
    state.bets = { [BOT]: { betCents: 10, guess: 0, leverage: 1 } };
    expect(decide(state)).toBeNull();
  });

  it("固定 rng 序列下结果可复现", () => {
    let index = 0;
    const sequence = [0.59, 0.61, 0.2];
    const rng = (): number => sequence[index++ % sequence.length]!;
    const first = decide(betting(10_000), rng);
    index = 0;
    const second = decide(betting(10_000), rng);
    expect(second).toEqual(first);
    expect(first?.payload).toMatchObject({ betCents: 0 });
  });
});

describe("AI 决策：私人借款请求", () => {
  it("闲置现金足够且对方信用良好时同意，否则拒绝", () => {
    const state = withState(actionState(), { requests: [request()] });
    state.players[0]!.cents = 1_000;
    expect(decide(state)).toMatchObject({
      type: "ACCEPT_PRIVATE_LOAN",
      payload: { requestId: "req-1" },
      requestId: "req-1",
    });

    const thin = structuredClone(state);
    thin.players[0]!.cents = 800;
    expect(decide(thin)).toMatchObject({ type: "REFUSE_PRIVATE_LOAN" });

    const risky = structuredClone(state);
    risky.requests[0]!.borrowerCredit = CREDIT.DEFAULTED;
    risky.players[1]!.credit = CREDIT.DEFAULTED;
    expect(decide(risky)).toMatchObject({ type: "REFUSE_PRIVATE_LOAN" });

    const dead = structuredClone(state);
    dead.players[1]!.alive = false;
    expect(decide(dead)).toMatchObject({ type: "REFUSE_PRIVATE_LOAN" });
  });

  it("过期请求与已结束请求都不再应答", () => {
    const expired = withState(actionState(), { requests: [request({ deadlineMs: 0 })] });
    expired.players[0]!.cents = 1_000;
    // 过期请求落到 ACTION 正常分支，不会产生 ACCEPT/REFUSE。
    expect(decide(expired, () => 0.9)).toMatchObject({ type: "END_ACTION" });

    const closed = withState(actionState(), { requests: [request({ status: "ACCEPTED" })] });
    closed.players[0]!.cents = 1_000;
    expect(decide(closed)).toMatchObject({ type: "END_ACTION" });
  });

  it("TAX 只应答当前等待窗口的请求，其余时间不行动", () => {
    const waiting = withState(initial(), {
      phase: "TAX",
      pendingRequestId: "req-1",
      requests: [request()],
      dangerSeatId: 2,
    });
    waiting.players[0]!.cents = 1_000;
    expect(decide(waiting)).toMatchObject({ type: "ACCEPT_PRIVATE_LOAN" });

    const otherWindow = structuredClone(waiting);
    otherWindow.pendingRequestId = "req-other";
    expect(decide(otherWindow)).toBeNull();

    const idle = withState(initial(), { phase: "TAX", dangerSeatId: 2 });
    expect(decide(idle)).toBeNull();
  });
});
