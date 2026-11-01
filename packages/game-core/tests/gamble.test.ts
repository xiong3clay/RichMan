import { describe, expect, it } from "vitest";
import type { CommandOutcome, GameEvent, GameState } from "@richman/shared";
import type { EngineState } from "../src/engine.js";
import { applyCommand, createInitialState, getPlayerView } from "../src/engine.js";

const config = { timerMode: "standard" as const, privateDebtAffectsBankLoan: false };

let idSeq = 0;

function newState(seats = 2): EngineState {
  return createInitialState(
    "g1",
    config,
    Array.from({ length: seats }, (_, index) => ({ nickname: "p" + (index + 1) })),
  );
}

interface RunResult {
  state: EngineState;
  outcome: CommandOutcome;
  events: GameEvent[];
}

function run(
  state: GameState,
  type: string,
  payload: Record<string, unknown>,
  nowMs: number,
  drawResult: 0 | 1 = 0,
): RunResult {
  idSeq += 1;
  const commandId = type.toLowerCase() + "-" + String(idSeq);
  const result = applyCommand(
    state,
    { protocolVersion: 1, gameId: "g1", commandId, type, payload },
    { actorId: String(payload.playerId ?? "p1"), nowMs, drawResult },
  );
  return { state: result.state as EngineState, outcome: result.outcome, events: result.events };
}

/** 两人局：p1、p2 各结束行动后进入 BETTING（标准模式截止 nowMs+45 秒）。 */
function enterBetting(nowMs = 10): EngineState {
  const first = run(newState(), "END_ACTION", { playerId: "p1" }, 0);
  expect(first.outcome.ok).toBe(true);
  const second = run(first.state, "END_ACTION", { playerId: "p2" }, nowMs);
  expect(second.outcome.ok).toBe(true);
  expect(second.state.phase).toBe("BETTING");
  return second.state;
}

function submit(
  state: GameState,
  playerId: string,
  betCents: number,
  guess: 0 | 1,
  leverage: 1 | 2,
  nowMs: number,
  drawResult: 0 | 1 = 0,
): RunResult {
  return run(state, "SUBMIT_BET", { playerId, betCents, guess, leverage }, nowMs, drawResult);
}

function failCode(outcome: CommandOutcome): string | null {
  return outcome.ok ? null : outcome.code;
}

function findEvent(events: GameEvent[], type: string): GameEvent | undefined {
  return events.find((event) => event.type === type);
}

/** 下注 100 金币并让 p2 交 0 注，返回结算后的状态。 */
function playGamble(leverage: 1 | 2, drawResult: 0 | 1): RunResult {
  const betting = enterBetting();
  const locked = submit(betting, "p1", 10_000, 0, leverage, 20);
  expect(locked.outcome.ok).toBe(true);
  expect(locked.state.phase).toBe("BETTING");
  const settled = submit(locked.state, "p2", 0, 0, 1, 30, drawResult);
  expect(settled.outcome.ok).toBe(true);
  return settled;
}

describe("gamble_100", () => {
  it("一倍猜输：100 金币归 0", () => {
    const settled = playGamble(1, 1);
    expect(settled.state.players[0]?.cents).toBe(0);
    expect(settled.state.bankLoans).toHaveLength(0);
  });

  it("一倍猜赢：100 -> 200 金币", () => {
    const settled = playGamble(1, 0);
    expect(settled.state.players[0]?.cents).toBe(20_000);
  });

  it("二倍猜赢：100 -> 300 金币", () => {
    const settled = playGamble(2, 0);
    expect(settled.state.players[0]?.cents).toBe(30_000);
  });

  it("二倍猜输：金币归 0，并新增 100 金币的 OVERDRAFT 贷款", () => {
    const settled = playGamble(2, 1);
    expect(settled.state.players[0]?.cents).toBe(0);
    expect(settled.state.bankLoans).toHaveLength(1);
    const loan = settled.state.bankLoans[0];
    expect(loan?.borrowerId).toBe("p1");
    expect(loan?.origin).toBe("OVERDRAFT");
    expect(loan?.principalCents).toBe(10_000);
    expect(loan?.status).toBe("ACTIVE");
    expect(loan?.issuedRound).toBe(1);
    expect(loan?.dueRound).toBe(4);
    expect(settled.state.players[0]?.credit).toBe("GOOD");
  });
});

describe("defaulted_leverage_only_1", () => {
  it("失信玩家不能使用二倍杠杆，一倍仍可下注", () => {
    const betting = enterBetting();
    betting.players[0]!.credit = "DEFAULTED";

    const denied = submit(betting, "p1", 0, 1, 2, 20);
    expect(failCode(denied.outcome)).toBe("INVALID_ACTION");
    expect(denied.state.version).toBe(betting.version);
    expect(denied.state.bets).toEqual({});

    const allowed = submit(denied.state, "p1", 0, 1, 1, 21);
    expect(allowed.outcome.ok).toBe(true);
    expect(allowed.state.bets.p1).toEqual({ betCents: 0, guess: 1, leverage: 1 });
  });
});

describe("privacy_hide_bets", () => {
  it("开奖前他人看不到金额、猜测、杠杆，本人能看到自己的锁定内容", () => {
    const betting = enterBetting();
    const locked = submit(betting, "p1", 4_321, 1, 2, 20);
    expect(locked.outcome.ok).toBe(true);

    const ownView = getPlayerView(locked.state, "p1", new Date(20));
    expect(ownView.finance.myBet).toEqual({ betCents: 4_321, guess: 1, leverage: 2 });

    const otherView = getPlayerView(locked.state, "p2", new Date(20));
    expect(otherView.finance.myBet).toBeNull();
    expect(otherView.finance.betsSubmitted).toEqual(["p1"]);
    const serialized = JSON.stringify(otherView);
    expect(serialized).not.toContain("4321");
    expect(serialized).not.toContain("betCents");
  });
});

describe("all_submitted_settles_immediately", () => {
  it("两人都提交后立即开奖，不等 nowMs 到截止时间", () => {
    const betting = enterBetting();
    // 标准模式 BETTING 截止为 10 + 45 秒 = 45010
    expect(betting.windowDeadlineMs).toBe(45_010);

    const first = submit(betting, "p1", 0, 0, 1, 20);
    expect(first.outcome.ok).toBe(true);
    expect(first.state.phase).toBe("BETTING");
    expect(first.state.version).toBe(betting.version + 1);

    const second = submit(first.state, "p2", 0, 0, 1, 25, 0);
    expect(second.outcome.ok).toBe(true);
    expect(second.state.phase).toBe("ACTION");
    expect(second.state.round).toBe(2);
    expect(second.state.currentSeatId).toBe(1);
    expect(second.state.bets).toEqual({});

    // 本命令产生的事件 seq 连续，并推进到 state.eventSeq
    const start = first.state.eventSeq + 1;
    second.events.forEach((event, index) => {
      expect(event.seq).toBe(start + index);
    });
    expect(second.state.eventSeq).toBe(second.events.at(-1)?.seq);
  });
});

describe("timeout_fills_zero", () => {
  it("越过截止时间后未提交者按 0 注、猜 0、杠杆 1 补齐并开奖", () => {
    const betting = enterBetting();
    const locked = submit(betting, "p1", 10_000, 0, 1, 20);
    expect(locked.outcome.ok).toBe(true);
    expect(locked.state.phase).toBe("BETTING");

    // 50000 > 45010：先按超时开奖（drawResult=1，p1 一倍猜错归 0），再处理迟到的下注命令
    const late = submit(locked.state, "p2", 0, 0, 1, 50_000, 1);
    expect(failCode(late.outcome)).toBe("INVALID_ACTION");
    expect(late.state.phase).toBe("ACTION");
    expect(late.state.round).toBe(2);
    expect(late.state.players[0]?.cents).toBe(0);
    expect(late.state.players[1]?.cents).toBe(10_000);
    expect(late.state.bets).toEqual({});

    const settledEvent = findEvent(late.events, "BET_SETTLED");
    const payload = settledEvent?.payload as
      | { drawResult: 0 | 1; players: Array<{ playerId: string; betCents: number; guess: 0 | 1; leverage: 1 | 2 }> }
      | undefined;
    expect(payload?.drawResult).toBe(1);
    const filled = payload?.players.find((entry) => entry.playerId === "p2");
    expect(filled).toEqual({
      playerId: "p2",
      betCents: 0,
      guess: 0,
      leverage: 1,
      won: false,
      deltaCents: 0,
      nextCents: 10_000,
      overdraftCents: 0,
    });
  });
});

describe("duplicate_submit_locked", () => {
  it("同一轮重复提交返回 ALREADY_LOCKED，不改状态", () => {
    const betting = enterBetting();
    const locked = submit(betting, "p1", 1_000, 1, 1, 20);
    expect(locked.outcome.ok).toBe(true);

    const again = submit(locked.state, "p1", 2_000, 1, 2, 21);
    expect(failCode(again.outcome)).toBe("ALREADY_LOCKED");
    expect(again.state.version).toBe(locked.state.version);
    expect(again.state.bets.p1).toEqual({ betCents: 1_000, guess: 1, leverage: 1 });
  });
});
