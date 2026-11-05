import { describe, expect, it } from "vitest";
import type { RoomConfig } from "@richman/shared";
import type { EngineState } from "../src/engine.js";
import { advanceSystem, applyCommand, createInitialState, resumeFromPause } from "../src/engine.js";

type TimerMode = RoomConfig["timerMode"];

function initial(timerMode: TimerMode = "standard"): EngineState {
  return createInitialState("resume-game", { timerMode, privateDebtAffectsBankLoan: false }, [
    { nickname: "甲" },
    { nickname: "乙" },
  ]);
}

function command(
  state: EngineState,
  type: string,
  actorId: string,
  payload: Record<string, unknown>,
  nowMs: number,
): ReturnType<typeof applyCommand> {
  return applyCommand(
    state,
    { protocolVersion: 1, gameId: state.gameId, commandId: `${type}-${nowMs}`, type, payload },
    { actorId, nowMs, drawResult: 0 },
  );
}

function succeed(
  state: EngineState,
  type: string,
  actorId: string,
  payload: Record<string, unknown>,
  nowMs: number,
): EngineState {
  const result = command(state, type, actorId, payload, nowMs);
  expect(result.outcome).toEqual({ ok: true });
  return result.state as EngineState;
}

function acting(timerMode: TimerMode): EngineState {
  return advanceSystem(initial(timerMode), { actorId: "system", nowMs: 0, drawResult: 0 }).state as EngineState;
}

function betting(timerMode: TimerMode): EngineState {
  const first = succeed(acting(timerMode), "END_ACTION", "p1", {}, 1);
  return succeed(first, "END_ACTION", "p2", {}, 2);
}

function bankDue(timerMode: TimerMode): EngineState {
  const state = initial(timerMode);
  state.round = 4;
  state.bankLoans = [{
    loanId: "due-loan", borrowerId: "p1", seatId: 1, principalCents: 1_000,
    remainingCents: 1_210, rateBps: 1_000, issuedRound: 1, dueRound: 4,
    lastInterestRound: 3, status: "ACTIVE", origin: "NORMAL",
  }];
  return advanceSystem(state, { actorId: "system", nowMs: 0, drawResult: 0 }).state as EngineState;
}

function danger(timerMode: TimerMode): EngineState {
  const state = initial(timerMode);
  state.round = 3;
  state.phase = "TAX";
  state.taxSeats = [1, 2];
  state.players[0]!.cents = 500;
  return advanceSystem(state, { actorId: "system", nowMs: 0, drawResult: 0 }).state as EngineState;
}

describe("resumeFromPause", () => {
  // A wrong timer branch would expose an expired phase or a different configured duration.
  it.each([
    ["standard", "ACTION", 160_000],
    ["fast", "ACTION", 130_000],
    ["standard", "BANK_DUE", 145_000],
    ["fast", "BANK_DUE", 120_000],
    ["standard", "BETTING", 145_000],
    ["fast", "BETTING", 130_000],
    ["standard", "TAX", 160_000],
    ["fast", "TAX", 145_000],
  ] as const)("%s %s 重新获得完整窗口且不推进阶段", (mode, phase, deadlineMs) => {
    const state = phase === "ACTION" ? acting(mode)
      : phase === "BANK_DUE" ? bankDue(mode)
      : phase === "BETTING" ? betting(mode)
      : danger(mode);
    const before = structuredClone(state);

    const resumed = resumeFromPause(state, { nowMs: 100_000 });

    expect(resumed.phase).toBe(phase);
    expect(resumed.windowDeadlineMs).toBe(deadlineMs);
    expect(resumed.deadlineAt).toBe(new Date(deadlineMs).toISOString());
    expect(resumed.dangerDeadlineMs).toBe(phase === "TAX" ? deadlineMs : null);
    expect(resumed.version).toBe(state.version + 1);
    expect(resumed.eventSeq).toBe(state.eventSeq + 1);
    expect(resumed.phaseCounter).toBe(state.phaseCounter + 1);
    expect(resumed.phaseInstanceId).not.toBe(state.phaseInstanceId);
    expect(state).toEqual(before);
    expect(resumed.players).toEqual(before.players);
    expect(resumed.bankLoans).toEqual(before.bankLoans);
    expect(resumed.actedSeats).toEqual(before.actedSeats);
    expect(resumed.pendingDueLoanId).toBe(before.pendingDueLoanId);
    const ticking = advanceSystem(resumed, { actorId: "system", nowMs: 100_001, drawResult: 0 });
    expect(ticking.state).toEqual(resumed);
    expect(ticking.events).toEqual([]);
  });

  // Resetting only deadlineAt would still expire LoanRequest.deadlineMs in runSystem.
  it.each([
    ["standard", "ACTION", 145_000, null],
    ["fast", "ACTION", 120_000, null],
    ["standard", "TAX", 145_000, 160_000],
    ["fast", "TAX", 120_000, 145_000],
  ] as const)("%s %s 待处理请求续期并仍可同意", (mode, phase, requestDeadline, rescueDeadline) => {
    const active = phase === "ACTION" ? acting(mode) : danger(mode);
    const state = succeed(active, "REQUEST_PRIVATE_LOAN", "p1", {
      lenderId: "p2", principalCents: 100, rateBps: 1_000, requestId: "pending",
    }, 5_000);
    const before = structuredClone(state);

    const resumed = resumeFromPause(state, { nowMs: 100_000 });

    expect(resumed.pendingRequestId).toBe("pending");
    expect(resumed.requests).toEqual([{ ...before.requests[0], deadlineMs: requestDeadline }]);
    expect(resumed.windowDeadlineMs).toBe(requestDeadline);
    expect(resumed.deadlineAt).toBe(new Date(requestDeadline).toISOString());
    expect(resumed.dangerDeadlineMs).toBe(rescueDeadline);
    expect(resumed.privateLoans).toEqual([]);
    expect(resumed.players).toEqual(before.players);
    expect(state).toEqual(before);

    const accepted = command(resumed, "ACCEPT_PRIVATE_LOAN", "p2", { requestId: "pending" }, 100_001);
    expect(accepted.outcome).toEqual({ ok: true });
    expect((accepted.state as EngineState).requests[0]?.status).toBe("ACCEPTED");
    expect((accepted.state as EngineState).privateLoans).toHaveLength(1);
    if (phase === "TAX") {
      expect((accepted.state as EngineState).dangerDeadlineMs).toBe(rescueDeadline);
      expect(accepted.state.deadlineAt).toBe(new Date(rescueDeadline!).toISOString());
    }
  });

  // Re-entering BETTING would erase already locked wagers and completed actions.
  it("保留已锁赌注与已行动记录，旧阶段命令不能在恢复后提交", () => {
    const state = succeed(betting("standard"), "SUBMIT_BET", "p1", {
      betCents: 123, guess: 1, leverage: 2,
    }, 3);
    const before = structuredClone(state);
    const resumed = resumeFromPause(state, { nowMs: 100_000 });

    expect(resumed.bets).toEqual({ p1: { betCents: 123, guess: 1, leverage: 2 } });
    expect(resumed.actedSeats).toEqual([1, 2]);
    expect(resumed.players).toEqual(before.players);
    expect(resumed.requests).toEqual(before.requests);
    expect(resumed.privateLoans).toEqual(before.privateLoans);
    expect(state).toEqual(before);
    const stale = applyCommand(resumed, {
      protocolVersion: 1, gameId: state.gameId, commandId: "stale-bet", type: "SUBMIT_BET",
      phaseInstanceId: state.phaseInstanceId, payload: { betCents: 1, guess: 0, leverage: 1 },
    }, { actorId: "p2", nowMs: 100_001, drawResult: 0 });
    expect(stale.outcome.ok ? null : stale.outcome.code).toBe("VERSION_CONFLICT");
    expect(stale.state).toEqual(resumed);
    expect(stale.events).toEqual([]);
  });

  // A call through runSystem would accrue unpaid interest before the server schedules it.
  it("自动阶段保留 null 截止且不预先计息", () => {
    const state = initial();
    state.round = 2;
    state.bankLoans = [{
      loanId: "interest-loan", borrowerId: "p1", seatId: 1, principalCents: 1_000,
      remainingCents: 1_000, rateBps: 1_000, issuedRound: 1, dueRound: 4,
      lastInterestRound: 1, status: "ACTIVE", origin: "NORMAL",
    }];
    const before = structuredClone(state);
    const resumed = resumeFromPause(state, { nowMs: 100_000 });

    expect(resumed.phase).toBe("INTEREST");
    expect(resumed.deadlineAt).toBeNull();
    expect(resumed.windowDeadlineMs).toBeNull();
    expect(resumed.bankLoans).toEqual(before.bankLoans);
    expect(resumed.version).toBe(1);
    expect(resumed.eventSeq).toBe(1);
    expect(state).toEqual(before);
  });

  // GAME_OVER must not create a new state, version, or resume audit sequence.
  it("GAME_OVER 严格返回同一个 state", () => {
    const state = initial();
    state.phase = "GAME_OVER";
    state.winnerId = "p1";
    const before = structuredClone(state);

    expect(resumeFromPause(state, { nowMs: 100_000 })).toBe(state);
    expect(state).toEqual(before);
  });
});
