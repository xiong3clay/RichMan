import { describe, expect, it } from "vitest";
import type { CommandOutcome, GameEvent, GameState } from "@richman/shared";
import type { BankLoan } from "../src/bank.js";
import type { EngineState } from "../src/engine.js";
import { applyCommand, createInitialState } from "../src/engine.js";
import type { LoanRequest, PrivateLoan } from "../src/private-loans.js";

const config = { timerMode: "standard" as const, privateDebtAffectsBankLoan: false };

let idSeq = 0;

interface RunResult {
  state: EngineState;
  outcome: CommandOutcome;
  events: GameEvent[];
}

function newState(seats = 2): EngineState {
  return createInitialState(
    "g1",
    config,
    Array.from({ length: seats }, (_, index) => ({ nickname: "p" + (index + 1) })),
  );
}

function run(
  state: GameState,
  type: string,
  payload: Record<string, unknown>,
  nowMs: number,
  drawResult: 0 | 1 = 0,
): RunResult {
  idSeq += 1;
  const result = applyCommand(
    state,
    { protocolVersion: 1, gameId: "g1", commandId: type.toLowerCase() + "-" + String(idSeq), type, payload },
    { actorId: String(payload.playerId ?? "p1"), nowMs, drawResult },
  );
  return { state: result.state as EngineState, outcome: result.outcome, events: result.events };
}

function aliveSeats(state: GameState): Array<{ playerId: string; seatId: number }> {
  return state.players
    .filter((player) => player.alive)
    .sort((a, b) => a.seatId - b.seatId)
    .map((player) => ({ playerId: player.playerId, seatId: player.seatId }));
}

/** 一整个普通轮次：全员结束行动 + 全员 0 注，直到进入下一轮或 TAX。 */
function playZeroRound(state: GameState, startNow: number): { state: EngineState; now: number } {
  let s = state as EngineState;
  let now = startNow;
  for (const player of aliveSeats(state)) {
    now += 1_000;
    const result = run(s, "END_ACTION", { playerId: player.playerId }, now);
    expect(result.outcome.ok).toBe(true);
    s = result.state;
  }
  expect(s.phase).toBe("BETTING");
  for (const player of aliveSeats(s)) {
    now += 1_000;
    const result = run(
      s,
      "SUBMIT_BET",
      { playerId: player.playerId, betCents: 0, guess: 0, leverage: 1 },
      now,
    );
    expect(result.outcome.ok).toBe(true);
    s = result.state;
  }
  return { state: s, now };
}

/** 从开局推进到第 3 轮 BETTING（第 3 轮税前的最后一次锁定之前）。 */
function toRound3Betting(seats = 2): { state: EngineState; now: number } {
  let current = newState(seats);
  let now = 0;
  const first = playZeroRound(current, now);
  current = first.state;
  now = first.now;
  const second = playZeroRound(current, now);
  current = second.state;
  now = second.now;

  for (const player of aliveSeats(current)) {
    now += 1_000;
    const result = run(current, "END_ACTION", { playerId: player.playerId }, now);
    expect(result.outcome.ok).toBe(true);
    current = result.state;
  }
  expect(current.phase).toBe("BETTING");
  return { state: current, now };
}

/** 全员 0 注完成第 3 轮下注，触发开奖与税收；mutate 在提交前改账本。 */
function settleRound3(
  betting: EngineState,
  startNow: number,
  mutate?: (state: EngineState) => void,
): { state: EngineState; now: number } {
  if (mutate) mutate(betting);
  let s = betting;
  let now = startNow;
  for (const player of aliveSeats(betting)) {
    now += 1_000;
    const result = run(
      s,
      "SUBMIT_BET",
      { playerId: player.playerId, betCents: 0, guess: 0, leverage: 1 },
      now,
    );
    expect(result.outcome.ok).toBe(true);
    s = result.state;
  }
  return { state: s, now };
}

function privateLoan(overrides: Partial<PrivateLoan> = {}): PrivateLoan {
  return {
    loanId: "p2p-1",
    requestId: "old-req",
    borrowerId: "p1",
    lenderId: "p2",
    principalCents: 3_000,
    remainingCents: 3_000,
    rateBps: 0,
    issuedRound: 1,
    lastInterestRound: 3,
    status: "ACTIVE",
    ...overrides,
  };
}

function bankLoan(overrides: Partial<BankLoan> = {}): BankLoan {
  return {
    loanId: "bank-old",
    borrowerId: "p1",
    seatId: 1,
    principalCents: 5_000,
    remainingCents: 5_000,
    rateBps: 1_000,
    issuedRound: 1,
    dueRound: 4,
    lastInterestRound: 3,
    status: "ACTIVE",
    origin: "NORMAL",
    ...overrides,
  };
}

function pendingRequest(overrides: Partial<LoanRequest> = {}): LoanRequest {
  return {
    requestId: "rescue-req",
    borrowerId: "p1",
    lenderId: "p2",
    principalCents: 1_000,
    rateBps: 0,
    createdRound: 3,
    createdAtMs: 0,
    deadlineMs: 10,
    status: "PENDING",
    borrowerCredit: "GOOD",
    borrowerDefaultedBankDebtCents: 0,
    ...overrides,
  };
}

describe("tax_all_due_before_win", () => {
  it("一人破产后仍处理另一人的本轮税收，再判胜负", () => {
    const round3 = toRound3Betting(2);
    const settled = settleRound3(round3.state, round3.now, (state) => {
      state.players[0]!.cents = 0;
      state.players[1]!.cents = 5_000;
    });

    expect(settled.state.phase).toBe("TAX");
    expect(settled.state.dangerSeatId).toBe(1);
    expect(settled.state.players[0]?.cents).toBe(-2_000);
    expect(settled.state.players[0]?.status).toBe("DANGER");
    // 另一人的税还没扣
    expect(settled.state.players[1]?.cents).toBe(5_000);
    expect(settled.state.deadlineAt).toBe(new Date(settled.now + 60_000).toISOString());

    const gaveUp = run(settled.state, "RESCUE_GIVE_UP", { playerId: "p1" }, settled.now + 1_000);
    expect(gaveUp.outcome.ok).toBe(true);
    expect(gaveUp.state.players[0]?.alive).toBe(false);
    expect(gaveUp.state.players[1]?.cents).toBe(3_000);
    expect(gaveUp.state.phase).toBe("GAME_OVER");
    expect(gaveUp.state.winnerId).toBe("p2");
  });
});

describe("danger_partial_rescue", () => {
  it("借到 10 金币仍危险，补到 >= 0 立即结束自救并继续收税", () => {
    const round3 = toRound3Betting(2);
    const settled = settleRound3(round3.state, round3.now, (state) => {
      state.players[0]!.cents = 0;
      state.players[1]!.cents = 5_000;
    });
    expect(settled.state.players[0]?.cents).toBe(-2_000);
    expect(settled.state.dangerSeatId).toBe(1);

    const requested = run(
      settled.state,
      "REQUEST_PRIVATE_LOAN",
      {
        playerId: "p1",
        lenderId: "p2",
        principalCents: 1_000,
        rateBps: 0,
        requestId: "rescue-1",
      },
      settled.now + 1_000,
    );
    expect(requested.outcome.ok).toBe(true);
    expect(requested.state.pendingRequestId).toBe("rescue-1");
    expect(requested.state.players[0]?.cents).toBe(-2_000);

    const firstHalf = run(
      requested.state,
      "ACCEPT_PRIVATE_LOAN",
      { playerId: "p2", requestId: "rescue-1" },
      settled.now + 2_000,
    );
    expect(firstHalf.outcome.ok).toBe(true);
    expect(firstHalf.state.phase).toBe("TAX");
    expect(firstHalf.state.dangerSeatId).toBe(1);
    expect(firstHalf.state.players[0]?.status).toBe("DANGER");
    expect(firstHalf.state.players[0]?.cents).toBe(-1_000);
    expect(firstHalf.state.players[1]?.cents).toBe(4_000);

    const requestedAgain = run(
      firstHalf.state,
      "REQUEST_PRIVATE_LOAN",
      {
        playerId: "p1",
        lenderId: "p2",
        principalCents: 1_000,
        rateBps: 0,
        requestId: "rescue-2",
      },
      settled.now + 3_000,
    );
    expect(requestedAgain.outcome.ok).toBe(true);

    const rescued = run(
      requestedAgain.state,
      "ACCEPT_PRIVATE_LOAN",
      { playerId: "p2", requestId: "rescue-2" },
      settled.now + 4_000,
    );
    expect(rescued.outcome.ok).toBe(true);
    expect(rescued.state.players[0]?.cents).toBe(0);
    expect(rescued.state.players[0]?.status).toBe("ALIVE");
    expect(rescued.state.dangerSeatId).toBeNull();
    expect(rescued.state.phase).toBe("ACTION");
    expect(rescued.state.round).toBe(4);
    expect(rescued.state.players[1]?.cents).toBe(1_000);
  });
});

describe("danger_give_up", () => {
  it("放弃即破产：私人合同转 BAD_DEBT/FROZEN、待处理请求取消、银行贷款转 DEFAULTED", () => {
    const round3 = toRound3Betting(2);
    const settled = settleRound3(round3.state, round3.now, (state) => {
      state.players[0]!.cents = 0;
      state.players[1]!.cents = 5_000;
      state.privateLoans = [
        privateLoan({ loanId: "p1-borrow", borrowerId: "p1", lenderId: "p2" }),
        privateLoan({ loanId: "p1-lend", borrowerId: "p2", lenderId: "p1" }),
      ];
      state.bankLoans = [bankLoan()];
    });
    expect(settled.state.phase).toBe("TAX");
    expect(settled.state.players[0]?.cents).toBe(-2_000);

    const requested = run(
      settled.state,
      "REQUEST_PRIVATE_LOAN",
      { playerId: "p1", lenderId: "p2", principalCents: 1_000, rateBps: 0, requestId: "rescue-req" },
      settled.now + 1_000,
    );
    expect(requested.outcome.ok).toBe(true);
    expect(requested.state.requests[0]?.status).toBe("PENDING");

    const gaveUp = run(requested.state, "RESCUE_GIVE_UP", { playerId: "p1" }, settled.now + 2_000);
    expect(gaveUp.outcome.ok).toBe(true);
    const state = gaveUp.state;
    expect(state.players[0]?.alive).toBe(false);
    expect(state.players[0]?.status).toBe("BANKRUPT");
    expect(state.players[0]?.cents).toBe(0);
    expect(state.players[1]?.cents).toBe(3_000);
    expect(state.phase).toBe("GAME_OVER");
    expect(state.winnerId).toBe("p2");

    expect(state.privateLoans.find((loan) => loan.loanId === "p1-borrow")?.status).toBe("BAD_DEBT");
    expect(state.privateLoans.find((loan) => loan.loanId === "p1-lend")?.status).toBe("FROZEN");
    expect(state.requests[0]?.status).toBe("CANCELLED");
    expect(state.bankLoans[0]?.status).toBe("DEFAULTED");
    expect(state.bankLoans[0]?.remainingCents).toBe(5_000);
    expect(state.pendingRequestId).toBeNull();
    expect(state.dangerSeatId).toBeNull();
  });
});

describe("danger_timeout", () => {
  it("超过自救截止自动破产并继续处理剩余税收", () => {
    const round3 = toRound3Betting(2);
    const settled = settleRound3(round3.state, round3.now, (state) => {
      state.players[0]!.cents = 0;
      state.players[1]!.cents = 5_000;
    });
    expect(settled.state.deadlineAt).toBe(new Date(settled.now + 60_000).toISOString());

    // 超时后任意命令都会先触发系统破产与继续收税
    const late = run(settled.state, "END_ACTION", { playerId: "p2" }, settled.now + 60_001);
    expect(late.state.players[0]?.alive).toBe(false);
    expect(late.state.players[0]?.status).toBe("BANKRUPT");
    expect(late.state.players[1]?.cents).toBe(3_000);
    expect(late.state.phase).toBe("GAME_OVER");
    expect(late.state.winnerId).toBe("p2");
  });
});

describe("danger_cancel_request", () => {
  function dangerState(): { state: EngineState; now: number; rescueDeadline: number } {
    const round3 = toRound3Betting(2);
    const settled = settleRound3(round3.state, round3.now, (state) => {
      state.players[0]!.cents = 0;
      state.players[1]!.cents = 5_000;
    });
    expect(settled.state.phase).toBe("TAX");
    expect(settled.state.dangerSeatId).toBe(1);
    return {
      state: settled.state,
      now: settled.now,
      rescueDeadline: settled.state.dangerDeadlineMs ?? -1,
    };
  }

  it("TAX 取消后仍在 DANGER，自救截止恢复，可再次发起并成功自救", () => {
    const { state, now, rescueDeadline } = dangerState();

    const requested = run(
      state,
      "REQUEST_PRIVATE_LOAN",
      { playerId: "p1", lenderId: "p2", principalCents: 2_000, rateBps: 0, requestId: "rescue-1" },
      now + 1_000,
    );
    expect(requested.outcome.ok).toBe(true);

    const cancelled = run(
      requested.state,
      "CANCEL_PRIVATE_LOAN",
      { playerId: "p1", requestId: "rescue-1" },
      now + 2_000,
    );
    expect(cancelled.outcome.ok).toBe(true);
    expect(cancelled.state.phase).toBe("TAX");
    expect(cancelled.state.dangerSeatId).toBe(1);
    expect(cancelled.state.players[0]?.status).toBe("DANGER");
    expect(cancelled.state.requests[0]?.status).toBe("CANCELLED");
    expect(cancelled.state.pendingRequestId).toBeNull();
    expect(cancelled.state.windowDeadlineMs).toBe(rescueDeadline);

    const again = run(
      cancelled.state,
      "REQUEST_PRIVATE_LOAN",
      { playerId: "p1", lenderId: "p2", principalCents: 2_000, rateBps: 0, requestId: "rescue-2" },
      now + 3_000,
    );
    expect(again.outcome.ok).toBe(true);

    const rescued = run(
      again.state,
      "ACCEPT_PRIVATE_LOAN",
      { playerId: "p2", requestId: "rescue-2" },
      now + 4_000,
    );
    expect(rescued.outcome.ok).toBe(true);
    expect(rescued.state.players[0]?.cents).toBe(0);
    expect(rescued.state.players[0]?.status).toBe("ALIVE");
    expect(rescued.state.phase).toBe("ACTION");
  });

  it("自救请求间隔不足 2 秒被拒，且不消耗状态、不重置自救截止", () => {
    const { state, now, rescueDeadline } = dangerState();

    const requested = run(
      state,
      "REQUEST_PRIVATE_LOAN",
      { playerId: "p1", lenderId: "p2", principalCents: 2_000, rateBps: 0, requestId: "rescue-1" },
      now + 1_000,
    );
    expect(requested.outcome.ok).toBe(true);

    const cancelled = run(
      requested.state,
      "CANCEL_PRIVATE_LOAN",
      { playerId: "p1", requestId: "rescue-1" },
      now + 1_500,
    );
    expect(cancelled.outcome.ok).toBe(true);

    const tooSoon = run(
      cancelled.state,
      "REQUEST_PRIVATE_LOAN",
      { playerId: "p1", lenderId: "p2", principalCents: 2_000, rateBps: 0, requestId: "rescue-2" },
      now + 2_999,
    );
    expect(tooSoon.outcome.ok).toBe(false);
    expect(tooSoon.outcome.ok ? null : tooSoon.outcome.code).toBe("INVALID_ACTION");
    expect(tooSoon.outcome.ok ? "" : tooSoon.outcome.message).toContain("请求间隔不足 2 秒");
    expect(tooSoon.state.version).toBe(cancelled.state.version);
    expect(tooSoon.state.pendingRequestId).toBeNull();
    expect(tooSoon.state.windowDeadlineMs).toBe(rescueDeadline);

    const exactlyTwoSeconds = run(
      cancelled.state,
      "REQUEST_PRIVATE_LOAN",
      { playerId: "p1", lenderId: "p2", principalCents: 2_000, rateBps: 0, requestId: "rescue-3" },
      now + 3_000,
    );
    expect(exactlyTwoSeconds.outcome.ok).toBe(true);
  });
});

describe("phase_advance_when_all_done", () => {
  it("税收全部处理完立即进入下一轮，不等倒计时", () => {
    const round3 = toRound3Betting(3);
    const settled = settleRound3(round3.state, round3.now, (state) => {
      for (const player of state.players) player.cents = 10_000;
    });
    const state = settled.state;
    expect(state.phase).toBe("ACTION");
    expect(state.round).toBe(4);
    expect(state.currentSeatId).toBe(1);
    expect(state.dangerSeatId).toBeNull();
    expect(state.taxIndex).toBe(3);
    expect(state.deadlineAt).toBe(new Date(settled.now + 60_000).toISOString());
    for (const player of state.players) {
      expect(player.cents).toBe(8_000);
    }
  });
});
