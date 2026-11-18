import { describe, expect, it } from "vitest";
import { advanceSystem, applyCommand, createInitialState } from "@richman/game-core";
import type { EngineState } from "@richman/game-core";
import {
  BOT_PERSONALITIES,
  CREDIT,
  MAX_MONEY_CENTS,
  RULES,
} from "@richman/shared";
import type { BotPersonality, GameCommand } from "@richman/shared";
import { betExpectedValueCents, decideBotCommand } from "../src/bots/policy.js";
import type { GameCommandDraft } from "../src/bots/policy.js";

type BankLoan = EngineState["bankLoans"][number];
type PrivateLoan = EngineState["privateLoans"][number];
type LoanRequest = EngineState["requests"][number];
const config = { timerMode: "standard" as const, privateDebtAffectsBankLoan: false };
const BOT = "p1";

function initial(): EngineState {
  return createInitialState("g1", config, [{ nickname: "AI" }, { nickname: "人类" }]);
}

/** 真实 INTEREST → BANK_DUE → ACTION，currentSeatId = 1。 */
function actionState(): EngineState {
  return advanceSystem(initial(), { actorId: "SYSTEM", nowMs: 0, drawResult: 0 }).state as EngineState;
}

function bettingState(): EngineState {
  let state = actionState();
  for (const seat of [1, 2]) {
    const result = applyCommand(state, {
      protocolVersion: 1, gameId: state.gameId, commandId: "end-" + String(seat),
      type: "END_ACTION", payload: {}, expectedGameVersion: state.version,
    }, { actorId: "p" + String(seat), nowMs: 0, drawResult: 0 });
    expect(result.outcome.ok).toBe(true);
    state = result.state as EngineState;
  }
  return state;
}

function bankLoan(patch: Partial<BankLoan> = {}): BankLoan {
  return {
    loanId: "bank-1", borrowerId: BOT, seatId: 1, principalCents: 1_000, remainingCents: 1_100,
    rateBps: 1_000, issuedRound: 1, dueRound: 2, lastInterestRound: 1,
    status: "ACTIVE", origin: "NORMAL", ...patch,
  };
}

function privateLoan(patch: Partial<PrivateLoan> = {}): PrivateLoan {
  return {
    loanId: "p2p-1", requestId: "req-1", borrowerId: BOT, lenderId: "p2",
    principalCents: 500, remainingCents: 500, rateBps: 1_000,
    issuedRound: 1, lastInterestRound: 1, status: "ACTIVE", ...patch,
  };
}

function pendingRequest(patch: Partial<LoanRequest> = {}): LoanRequest {
  return {
    requestId: "req-1", borrowerId: "p2", lenderId: BOT, principalCents: 400, rateBps: 1_000,
    createdRound: 1, createdAtMs: 0, deadlineMs: 10_000, status: "PENDING",
    borrowerCredit: CREDIT.GOOD, borrowerDefaultedBankDebtCents: 0, ...patch,
  };
}

function withState(state: EngineState, patch: Partial<EngineState>): EngineState {
  return { ...structuredClone(state), ...patch };
}

function decide(state: EngineState, personality: BotPersonality, rng: () => number = () => 0.9): GameCommandDraft | null {
  return decideBotCommand(state, BOT, 0, rng, personality);
}

function bankDueState(): EngineState {
  const state = withState(initial(), {
    phase: "BANK_DUE",
    pendingDueLoanId: "bank-1",
    windowDeadlineMs: 45_000,
    deadlineAt: new Date(45_000).toISOString(),
  });
  state.bankLoans = [bankLoan({ dueRound: 1, lastInterestRound: 1, remainingCents: 1_100 })];
  state.players[0]!.cents = 1_100;
  return state;
}

/** 手工构造的 TAX 危险态：p1 为危险玩家，余额 -500。 */
function dangerState(patch: Partial<EngineState> = {}): EngineState {
  const state = withState(actionState(), {
    phase: "TAX",
    phaseInstanceId: "round1-tax-danger-1",
    round: 3,
    currentSeatId: null,
    pendingDueLoanId: null,
    pendingRequestId: null,
    dangerSeatId: 1,
    dangerDeadlineMs: 60_000,
    windowDeadlineMs: 60_000,
    deadlineAt: new Date(60_000).toISOString(),
    taxSeats: [1, 2],
    taxIndex: 2,
    ...patch,
  });
  state.players[0]!.cents = -500;
  state.players[1]!.cents = 10_000;
  return state;
}

function dangerWithReceivable(): EngineState {
  const state = dangerState();
  state.privateLoans = [privateLoan({
    loanId: "collect-1", borrowerId: "p2", lenderId: BOT,
    issuedRound: 2, lastInterestRound: 3, remainingCents: 800,
  })];
  return state;
}

function dangerWithLender(): EngineState {
  return dangerState();
}

describe("五种人格：确定性决策", () => {
  it("PASSIVE 保持原行为：只还债、缺钱才借、下注最多 10 分且 60% 跳过", () => {
    expect(decide(actionState(), "PASSIVE")).toMatchObject({ type: "END_ACTION" });
    const poor = actionState();
    poor.players[0]!.cents = 50;
    expect(decide(poor, "PASSIVE")).toMatchObject({ type: "BORROW_BANK", payload: { amountCents: 25 } });
    expect(decide(bettingState(), "PASSIVE", () => 0.1)?.payload).toMatchObject({ betCents: 0 });
    expect(decide(bettingState(), "PASSIVE", () => 0.9)?.payload).toMatchObject({ betCents: 10 });
  });

  it("CONSERVATIVE 保留 5 元缓冲，下注 ≤5% 且 ≤1 元", () => {
    const buffered = withState(actionState(), { privateLoans: [privateLoan({ remainingCents: 300 })] });
    buffered.players[0]!.cents = 600;
    expect(decide(buffered, "CONSERVATIVE")).toMatchObject({ type: "END_ACTION" });

    const bank = withState(actionState(), { bankLoans: [bankLoan({ dueRound: 2, remainingCents: 1_100 })] });
    bank.players[0]!.cents = 1_100;
    expect(decide(bank, "CONSERVATIVE")).toMatchObject({ type: "REPAY_BANK" });

    const rich = bettingState();
    rich.players[0]!.cents = 10_000;
    expect(decide(rich, "CONSERVATIVE", () => 0.9)?.payload).toMatchObject({ betCents: 100, leverage: 1 });
    expect(decide(rich, "CONSERVATIVE", () => 0.1)?.payload).toMatchObject({ betCents: 0 });
  });

  it("AGGRESSIVE 主动借银行、下注 20%–40%、可用两倍杠杆", () => {
    const state = actionState();
    state.players[0]!.cents = 2_000;
    expect(decide(state, "AGGRESSIVE")).toMatchObject({ type: "BORROW_BANK", payload: { amountCents: 1_000 } });

    const rich = bettingState();
    rich.players[0]!.cents = 10_000;
    let index = 0;
    const values = [0.5, 0.5, 0.1];
    const bet = decide(rich, "AGGRESSIVE", () => values[index++ % values.length]!);
    expect(bet?.type).toBe("SUBMIT_BET");
    expect((bet!.payload as { betCents: number }).betCents).toBe(3_000);
    expect((bet!.payload as { leverage: number }).leverage).toBe(2);
  });

  it("GENIUS 按真实赔付公式算 EV：均匀开奖下最优是 0 注，且不无收益借钱", () => {
    expect(betExpectedValueCents(100, 1)).toBe(0);
    expect(betExpectedValueCents(100, 2)).toBe(0);
    const rich = bettingState();
    rich.players[0]!.cents = 10_000;
    expect(decide(rich, "GENIUS")).toMatchObject({ type: "SUBMIT_BET", payload: { betCents: 0 } });

    const poor = actionState();
    poor.players[0]!.cents = 50;
    expect(decide(poor, "GENIUS")).toMatchObject({ type: "END_ACTION" });

    const bank = withState(actionState(), { bankLoans: [bankLoan({ dueRound: 2 })] });
    bank.players[0]!.cents = 2_000;
    expect(decide(bank, "GENIUS")).toMatchObject({ type: "REPAY_BANK" });
  });

  it("FOOL 在合法集合内随机，参数仍合法", () => {
    const state = actionState();
    state.players[0]!.cents = 2_000;
    const draft = decide(state, "FOOL", () => 0);
    expect(["BORROW_BANK", "REQUEST_PRIVATE_LOAN", "END_ACTION"]).toContain(draft?.type);
    const bet = decide(bettingState(), "FOOL", () => 0.5);
    expect(bet?.type).toBe("SUBMIT_BET");
    const payload = bet!.payload as { betCents: number; guess: 0 | 1; leverage: 1 | 2 };
    expect(Number.isSafeInteger(payload.betCents)).toBe(true);
    expect(payload.betCents).toBeGreaterThanOrEqual(0);
    expect([0, 1]).toContain(payload.guess);
    expect([1, 2]).toContain(payload.leverage);
  });
});

describe("TAX 危险自救", () => {
  it("先催收应收款：能收多少收多少", () => {
    const draft = decide(dangerWithReceivable(), "CONSERVATIVE");
    expect(draft).toMatchObject({ type: "COLLECT_PRIVATE", payload: { loanId: "collect-1", cents: 800 } });
  });

  it("没有应收款时向有现金的玩家发起私人借款（只借到 0 元）", () => {
    const draft = decide(dangerWithLender(), "GENIUS");
    expect(draft).toMatchObject({
      type: "REQUEST_PRIVATE_LOAN",
      payload: { lenderId: "p2", principalCents: 500, rateBps: 500 },
    });
  });

  it("FOOL 也会拒绝已死亡借款人的请求（P2-1）", () => {
    const state = withState(actionState(), { requests: [pendingRequest()] });
    state.players[0]!.cents = 10_000;
    state.players[1]!.alive = false;
    expect(decide(state, "FOOL", () => 0)).toMatchObject({ type: "REFUSE_PRIVATE_LOAN" });
  });

  it("TAX 催收金额不超过出借人 MAX；收不到钱时降级到借款/放弃（P2-2）", () => {
    const state = dangerState();
    state.players[0]!.cents = -1;
    state.privateLoans = [privateLoan({
      loanId: "collect-1", borrowerId: "p2", lenderId: BOT,
      issuedRound: 2, lastInterestRound: 3, remainingCents: MAX_MONEY_CENTS,
    })];
    state.players[1]!.cents = MAX_MONEY_CENTS;
    const collect = decide(state, "GENIUS");
    expect(collect).toMatchObject({ type: "COLLECT_PRIVATE", payload: { loanId: "collect-1" } });
    expect((collect!.payload as { cents: number }).cents)
      .toBeLessThanOrEqual(MAX_MONEY_CENTS - state.players[0]!.cents);

    const empty = dangerState();
    empty.privateLoans = [privateLoan({
      loanId: "collect-1", borrowerId: "p2", lenderId: BOT,
      issuedRound: 2, lastInterestRound: 3, remainingCents: 800,
    })];
    empty.players[1]!.cents = 0; // 催收不到：同一决策降级为借款，而不是死等。
    expect(decide(empty, "CONSERVATIVE")).toMatchObject({ type: "REQUEST_PRIVATE_LOAN" });
  });

  it("没有其他存活玩家时立即 RESCUE_GIVE_UP，而不是等超时破产", () => {
    const state = dangerState();
    state.players[1]!.alive = false;
    expect(decide(state, "PASSIVE")).toMatchObject({ type: "RESCUE_GIVE_UP" });
  });

  it("2 秒间隔未到时等待，不提前放弃也不发非法请求", () => {
    const state = dangerState();
    state.requests = [pendingRequest({
      requestId: "old", borrowerId: BOT, lenderId: "p2", status: "REFUSED",
      createdAtMs: 0, createdRound: 3, deadlineMs: 45_000,
    })];
    expect(decide(state, "CONSERVATIVE")).toBeNull();
  });
});

describe("借贷边界与 MAX 自检", () => {
  it("借款人收款后会超过 MAX 时拒绝，不产生必被引擎拒绝的 ACCEPT", () => {
    const state = withState(actionState(), { requests: [pendingRequest({ principalCents: 100 })] });
    state.players[0]!.cents = 10_000;
    state.players[1]!.cents = MAX_MONEY_CENTS - 50;
    expect(decide(state, "PASSIVE")).toMatchObject({ type: "REFUSE_PRIVATE_LOAN" });

    const ok = structuredClone(state);
    ok.players[1]!.cents = MAX_MONEY_CENTS - 100;
    expect(decide(ok, "PASSIVE")).toMatchObject({ type: "ACCEPT_PRIVATE_LOAN" });
  });

  it("出借人收款后会超过 MAX 时不发起全额私人还款", () => {
    const state = withState(actionState(), { privateLoans: [privateLoan({ remainingCents: 1_000 })] });
    state.players[0]!.cents = 1_000;
    state.players[1]!.cents = MAX_MONEY_CENTS - 100;
    expect(decide(state, "PASSIVE")).toMatchObject({ type: "END_ACTION" });
  });

  it("失信玩家的 DEFAULTED 银行贷款不产生 REPAY_BANK", () => {
    const state = actionState();
    state.players[0]!.credit = CREDIT.DEFAULTED;
    state.players[0]!.cents = 10_000;
    state.bankLoans = [bankLoan({ status: "DEFAULTED", dueRound: 1 })];
    expect(decide(state, "AGGRESSIVE")).toMatchObject({ type: "END_ACTION" });
  });
});

describe("真实 INTEREST→ACTION 带债路径", () => {
  it("银行债按真实 10% 复利后的 remainingCents 还款", () => {
    const state = createInitialState("g1", config, [{ nickname: "AI" }, { nickname: "人类" }]);
    state.round = 2;
    state.phase = "INTEREST";
    state.phaseInstanceId = "round2-interest-1";
    state.players[0]!.cents = 10_000;
    state.bankLoans = [bankLoan({ issuedRound: 1, dueRound: 3, lastInterestRound: 1, remainingCents: 1_000 })];
    const advanced = advanceSystem(state, { actorId: "SYSTEM", nowMs: 0, drawResult: 0 }).state as EngineState;
    expect(advanced.phase).toBe("ACTION");
    expect(advanced.bankLoans[0]!.remainingCents).toBe(1_100);
    expect(advanced.bankLoans[0]!.lastInterestRound).toBe(2);

    expect(decide(advanced, "PASSIVE")).toMatchObject({
      type: "REPAY_BANK",
      payload: { loanId: "bank-1", cents: 1_100 },
    });
  });

  it("私人债同样使用 INTEREST 后的剩余本息", () => {
    const state = createInitialState("g1", config, [{ nickname: "AI" }, { nickname: "人类" }]);
    state.round = 2;
    state.phase = "INTEREST";
    state.players[0]!.cents = 10_000;
    state.privateLoans = [privateLoan({ issuedRound: 1, lastInterestRound: 1, remainingCents: 500 })];
    const advanced = advanceSystem(state, { actorId: "SYSTEM", nowMs: 0, drawResult: 0 }).state as EngineState;
    expect(advanced.privateLoans[0]!.remainingCents).toBe(550);
    expect(decide(advanced, "PASSIVE")).toMatchObject({
      type: "REPAY_PRIVATE",
      payload: { loanId: "p2p-1", cents: 550 },
    });
  });
});

describe("属性测试：所有人格的决策都能被真实引擎接受", () => {
  // 这里显式收窄 applyCommand 的返回形状，避免 TS 在“全量工程 + 属性循环”下展开
  // 大型交叉类型（EngineState = GameState & EngineExtras）导致 tsc 长时间不返回。
  type ApplyResult = { outcome: { ok: boolean; code?: string } };
  type ApplyFn = (state: EngineState, command: GameCommand,
    ctx: { actorId: string; nowMs: number; drawResult: 0 }) => ApplyResult;
  const runCommand = applyCommand as unknown as ApplyFn;

  it("ACTION / BETTING / BANK_DUE / TAX 的代表性局面全部 outcome.ok", () => {
    const cases: Array<{ name: string; state: EngineState }> = [];
    const empty = actionState();
    cases.push({ name: "action-empty", state: empty });
    const debt = actionState();
    debt.players[0]!.cents = 5_000;
    debt.bankLoans = [bankLoan({ dueRound: 2, remainingCents: 1_100 })];
    debt.privateLoans = [privateLoan({ remainingCents: 500 })];
    cases.push({ name: "action-debt", state: debt });
    cases.push({ name: "betting", state: bettingState() });
    cases.push({ name: "bank-due", state: bankDueState() });
    cases.push({ name: "tax-collect", state: dangerWithReceivable() });
    cases.push({ name: "tax-request", state: dangerWithLender() });
    const noLender = dangerState();
    noLender.players[1]!.alive = false;
    cases.push({ name: "tax-give-up", state: noLender });

    let commandSeq = 0;
    for (const personality of BOT_PERSONALITIES) {
      for (const item of cases) {
        for (const value of [0, 0.2, 0.5, 0.8, 0.99]) {
          const state = structuredClone(item.state) as EngineState;
          const draft = decideBotCommand(state, BOT, 0, () => value, personality);
          if (draft === null) continue;
          commandSeq += 1;
          const command: GameCommand = {
            protocolVersion: 1,
            gameId: state.gameId,
            commandId: "prop-" + String(commandSeq),
            type: draft.type,
            payload: draft.payload,
            expectedGameVersion: draft.expectedGameVersion,
            roundId: draft.roundId,
            phaseInstanceId: draft.phaseInstanceId,
            requestId: draft.requestId,
          };
          const result = runCommand(state, command, { actorId: BOT, nowMs: 0, drawResult: 0 });
          expect(result.outcome.ok, JSON.stringify({
            personality, scenario: item.name, value, draft, outcome: result.outcome,
          })).toBe(true);
        }
      }
    }
  });
});

describe("常量核对", () => {
  it("自救请求最小间隔与 RULES 一致", () => {
    expect(RULES.rescueRequestMinGapSec).toBe(2);
  });
});
