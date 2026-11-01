import { describe, expect, it } from "vitest";
import type { GameState } from "@richman/shared";
import type { EngineState } from "../src/engine.js";
import { applyCommand, createInitialState } from "../src/engine.js";

const config = { timerMode: "standard" as const, privateDebtAffectsBankLoan: false };

let idSeq = 0;

function newState(seats: number): EngineState {
  return createInitialState(
    "g1",
    config,
    Array.from({ length: seats }, (_, index) => ({ nickname: "p" + (index + 1) })),
  );
}

interface RunResult {
  state: EngineState;
  ok: boolean;
  code: string | null;
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
  return {
    state: result.state as EngineState,
    ok: result.outcome.ok,
    code: result.outcome.ok ? null : result.outcome.code,
  };
}

function aliveSeats(state: GameState): string[] {
  return state.players
    .filter((player) => player.alive)
    .sort((a, b) => a.seatId - b.seatId)
    .map((player) => player.playerId);
}

describe("full-game-2p", () => {
  it("固定脚本从开局跑到 GAME_OVER，覆盖透支、到期失信、税收自救与破产", () => {
    let s = newState(2);
    let now = 0;

    const step = (type: string, payload: Record<string, unknown>, drawResult: 0 | 1 = 0): void => {
      now += 1_000;
      const result = run(s, type, payload, now, drawResult);
      expect(result.code).toBeNull();
      s = result.state;
    };
    const zeroBet = (playerId: string, drawResult: 0 | 1 = 0): void => {
      step("SUBMIT_BET", { playerId, betCents: 0, guess: 0, leverage: 1 }, drawResult);
    };

    // 第 1 轮：p1 普通银行贷款 50 金币（N+3 轮，第 4 轮到期）。
    step("BORROW_BANK", { playerId: "p1", amountCents: 5_000 });
    step("END_ACTION", { playerId: "p2" });
    zeroBet("p1");
    zeroBet("p2");
    expect(s.round).toBe(2);
    expect(s.phase).toBe("ACTION");
    expect(s.players[0]?.cents).toBe(15_000);

    // 第 2 轮：p1 向 p2 借 30 金币，建立私人合同（破产时应转坏账）。
    step("REQUEST_PRIVATE_LOAN", {
      playerId: "p1",
      lenderId: "p2",
      principalCents: 3_000,
      rateBps: 0,
      requestId: "p2p-r2",
    });
    step("ACCEPT_PRIVATE_LOAN", { playerId: "p2", requestId: "p2p-r2" });
    step("END_ACTION", { playerId: "p2" });
    zeroBet("p1");
    zeroBet("p2");
    expect(s.round).toBe(3);
    expect(s.players[0]?.cents).toBe(18_000);
    expect(s.players[1]?.cents).toBe(7_000);
    expect(s.privateLoans).toHaveLength(1);

    // 第 3 轮：p1 二倍杠杆下注 100 金币猜错 -> 透支，金币归 0 并新增 OVERDRAFT 贷款。
    step("END_ACTION", { playerId: "p1" });
    step("END_ACTION", { playerId: "p2" });
    step("SUBMIT_BET", { playerId: "p1", betCents: 10_000, guess: 0, leverage: 2 });
    zeroBet("p2", 1);

    const overdraft = s.bankLoans.find((loan) => loan.origin === "OVERDRAFT");
    expect(overdraft).toBeDefined();
    expect(overdraft?.principalCents).toBe(2_000);
    // 同一提交内先结算透支（金币归 0），随后进入第 3 轮税收并扣成 -20 金币。
    expect(s.phase).toBe("TAX");
    expect(s.players[0]?.cents).toBe(-2_000);
    expect(s.players[0]?.status).toBe("DANGER");

    // 危险自救：向 p2 紧急借 20 金币，金币回到 0 即完成自救并继续收税。
    step("REQUEST_PRIVATE_LOAN", {
      playerId: "p1",
      lenderId: "p2",
      principalCents: 2_000,
      rateBps: 0,
      requestId: "rescue-r3",
    });
    step("ACCEPT_PRIVATE_LOAN", { playerId: "p2", requestId: "rescue-r3" });
    expect(s.players[0]?.cents).toBe(0);
    expect(s.players[0]?.status).toBe("ALIVE");
    expect(s.players[1]?.cents).toBe(3_000);
    expect(s.round).toBe(4);

    // 第 4 轮：普通银行贷款到期，p1 余额 0 < 到期欠款 6655，系统直接按“余额不足”失信。
    expect(s.phase).toBe("ACTION");
    expect(s.currentSeatId).toBe(1);
    const normalLoan = s.bankLoans.find((loan) => loan.origin === "NORMAL");
    expect(normalLoan?.status).toBe("DEFAULTED");
    expect(normalLoan?.remainingCents).toBe(6_655);
    expect(s.players[0]?.credit).toBe("DEFAULTED");

    step("END_ACTION", { playerId: "p1" });
    step("END_ACTION", { playerId: "p2" });
    zeroBet("p1");
    zeroBet("p2");
    expect(s.round).toBe(5);

    // 第 5 轮无到期贷款。
    step("END_ACTION", { playerId: "p1" });
    step("END_ACTION", { playerId: "p2" });
    zeroBet("p1");
    zeroBet("p2");
    expect(s.round).toBe(6);

    // 第 6 轮：透支贷款到期，p1 余额仍为 0，同样直接按“余额不足”失信。
    expect(s.phase).toBe("ACTION");
    expect(overdraft?.loanId).toBeDefined();
    expect(s.bankLoans.find((loan) => loan.origin === "OVERDRAFT")?.status).toBe("DEFAULTED");

    step("END_ACTION", { playerId: "p1" });
    step("END_ACTION", { playerId: "p2" });
    zeroBet("p1");
    zeroBet("p2");

    // 第 6 轮税收：p1 无力纳税进入 DANGER，放弃自救 -> 破产，本轮仍先收完 p2 的税再判胜负。
    expect(s.phase).toBe("TAX");
    expect(s.players[0]?.cents).toBe(-2_000);
    expect(s.players[0]?.status).toBe("DANGER");
    step("RESCUE_GIVE_UP", { playerId: "p1" });

    expect(s.phase).toBe("GAME_OVER");
    expect(s.winnerId).toBe("p2");
    expect(s.players[0]?.alive).toBe(false);
    expect(s.players[0]?.status).toBe("BANKRUPT");
    expect(s.players[0]?.cents).toBe(0);
    expect(s.players[1]?.cents).toBe(1_000);
    expect(s.privateLoans.every((loan) => loan.status === "BAD_DEBT")).toBe(true);
    expect(s.bankLoans.every((loan) => loan.status === "DEFAULTED")).toBe(true);
    expect(s.requests.every((request) => request.status !== "PENDING")).toBe(true);
  });
});

describe("full-game-10p", () => {
  it("10 人稳定推进 9 轮，三次税收都不中断", () => {
    let s = newState(10);
    let now = 0;

    const step = (type: string, payload: Record<string, unknown>): void => {
      now += 1_000;
      const result = run(s, type, payload, now, 0);
      expect(result.code).toBeNull();
      s = result.state;
    };

    for (let round = 1; round <= 9; round += 1) {
      for (const playerId of aliveSeats(s)) {
        step("END_ACTION", { playerId });
      }
      expect(s.phase).toBe("BETTING");
      for (const playerId of aliveSeats(s)) {
        step("SUBMIT_BET", { playerId, betCents: 0, guess: 0, leverage: 1 });
      }
      if (round < 9) {
        expect(s.round).toBe(round + 1);
        expect(s.phase).toBe("ACTION");
      }
    }

    // 第 9 轮税收处理完进入第 10 轮；三次纳税各 20 金币。
    expect(s.round).toBe(10);
    expect(s.phase).toBe("ACTION");
    expect(s.currentSeatId).toBe(1);
    expect(s.players.every((player) => player.alive)).toBe(true);
    expect(s.players.every((player) => player.cents === 4_000)).toBe(true);
    expect(s.taxIndex).toBe(10);
  });
});
