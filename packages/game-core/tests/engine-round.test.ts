import { describe, expect, it } from "vitest";
import type { CommandContext, GameCommand, GameState } from "@richman/shared";
import { MAX_MONEY_CENTS } from "@richman/shared";
import type { BankLoan } from "../src/bank.js";
import type { EngineState } from "../src/engine.js";
import { advanceSystem, applyCommand, createInitialState, eventsForPlayer, getPlayerView } from "../src/engine.js";

const config = { timerMode: "standard" as const, privateDebtAffectsBankLoan: false };

function newState(seats: number): EngineState {
  return createInitialState(
    "g1",
    config,
    Array.from({ length: seats }, (_, index) => ({ nickname: "p" + (index + 1) })),
  );
}

function command(
  type: string,
  payload: Record<string, unknown>,
  commandId = type.toLowerCase(),
): GameCommand {
  return { protocolVersion: 1, gameId: "g1", commandId, type, payload };
}

function run(
  state: GameState,
  type: string,
  payload: Record<string, unknown>,
  nowMs: number,
  commandId = type.toLowerCase() + "-" + String(nowMs),
  actorId = String(payload.playerId ?? "p1"),
): {
  state: EngineState;
  outcome: ReturnType<typeof applyCommand>["outcome"];
  events: ReturnType<typeof applyCommand>["events"];
  ctx: CommandContext;
} {
  const ctx: CommandContext = { actorId, nowMs, drawResult: 0 };
  const result = applyCommand(state, command(type, payload, commandId), ctx);
  return {
    state: result.state as EngineState,
    outcome: result.outcome,
    events: result.events,
    ctx,
  };
}

function overdueLoan(overrides: Partial<BankLoan> = {}): BankLoan {
  return {
    loanId: "old-loan",
    borrowerId: "p1",
    seatId: 1,
    principalCents: 5_000,
    remainingCents: 6_655,
    rateBps: 1_000,
    issuedRound: 1,
    dueRound: 4,
    lastInterestRound: 4,
    status: "ACTIVE",
    origin: "NORMAL",
    ...overrides,
  };
}

describe("action_timeout_advances", () => {
  it("nowMs 超过 deadlineAt 时自动结束当前行动并轮到下一名", () => {
    const first = run(newState(3), "END_ACTION", { playerId: "p1" }, 0, "c1");
    expect(first.outcome.ok).toBe(true);
    expect(first.state.currentSeatId).toBe(2);
    expect(first.state.windowDeadlineMs).toBe(60_000);

    const late = run(first.state, "END_ACTION", { playerId: "p2" }, 61_000, "c2");
    expect(late.outcome.ok).toBe(false);
    expect(late.outcome.ok ? null : late.outcome.code).toBe("NOT_YOUR_TURN");
    expect(late.state.phase).toBe("ACTION");
    expect(late.state.currentSeatId).toBe(3);
    expect(late.state.windowDeadlineMs).toBe(121_000);
    expect(late.state.deadlineAt).toBe(new Date(121_000).toISOString());
  });
});

describe("waiting_loan_blocks_next_phase", () => {
  it("请求等待答复期间阶段不推进，其他人也不能行动", () => {
    const requested = run(
      newState(2),
      "REQUEST_PRIVATE_LOAN",
      { playerId: "p1", lenderId: "p2", principalCents: 5_000, rateBps: 1_000, requestId: "req-1" },
      0,
      "req-1",
    );
    expect(requested.outcome.ok).toBe(true);
    expect(requested.state.phase).toBe("ACTION");
    expect(requested.state.pendingRequestId).not.toBeNull();
    expect(requested.state.requests[0]?.requestId).toBe("req-1");
    expect(requested.state.requests[0]?.status).toBe("PENDING");
    // 截止 = min(请求 45 秒, 行动 60 秒)
    expect(requested.state.windowDeadlineMs).toBe(45_000);

    const other = run(requested.state, "END_ACTION", { playerId: "p2" }, 1_000, "c2");
    expect(other.outcome.ok).toBe(false);
    expect(other.outcome.ok ? null : other.outcome.code).toBe("INVALID_ACTION");
    expect(other.state.phase).toBe("ACTION");

    const borrowerAgain = run(requested.state, "END_ACTION", { playerId: "p1" }, 1_000, "c3");
    expect(borrowerAgain.outcome.ok).toBe(false);
    expect(borrowerAgain.outcome.ok ? null : borrowerAgain.outcome.code).toBe("INVALID_ACTION");
    expect(borrowerAgain.state.phase).toBe("ACTION");

    const accepted = run(
      requested.state,
      "ACCEPT_PRIVATE_LOAN",
      { playerId: "p2", requestId: "req-1" },
      2_000,
      "c4",
    );
    expect(accepted.outcome.ok).toBe(true);
    expect(accepted.state.privateLoans).toHaveLength(1);
    expect(accepted.state.privateLoans[0]?.principalCents).toBe(5_000);
    expect(accepted.state.players[0]?.cents).toBe(15_000);
    expect(accepted.state.players[1]?.cents).toBe(5_000);
    expect(accepted.state.currentSeatId).toBe(2);
  });
});

describe("phase_advance_when_all_done", () => {
  it("最后一名存活玩家 END_ACTION 后立即进入 BETTING，不等倒计时", () => {
    const first = run(newState(2), "END_ACTION", { playerId: "p1" }, 0, "c1");
    expect(first.state.currentSeatId).toBe(2);

    const second = run(first.state, "END_ACTION", { playerId: "p2" }, 10, "c2");
    expect(second.outcome.ok).toBe(true);
    expect(second.state.phase).toBe("BETTING");
    expect(second.state.deadlineAt).not.toBeNull();
    expect(second.state.currentSeatId).toBeNull();

    const bet = run(second.state, "SUBMIT_BET", { playerId: "p1", betCents: 100 }, 20, "c3");
    expect(bet.outcome.ok).toBe(false);
    expect(bet.outcome.ok ? null : bet.outcome.code).toBe("INVALID_ACTION");
  });
});

describe("bank_due_scan_overdue", () => {
  it("dueRound < currentRound 的 ACTIVE 贷款仍被 BANK_DUE 处理，且按超时失信后继续推进", () => {
    const state = newState(2);
    state.round = 5;
    state.phase = "INTEREST";
    state.phaseInstanceId = "round5-interest";
    state.bankLoans = [overdueLoan()];

    const due = run(state, "END_ACTION", { playerId: "p1" }, 0, "c1");
    expect(due.state.phase).toBe("BANK_DUE");
    expect(due.state.pendingDueLoanId).toBe("old-loan");
    expect(due.state.deadlineAt).toBe(new Date(45_000).toISOString());

    const wrongActor = run(due.state, "BANK_DUE_DECISION", { playerId: "p2", decision: "REPAY" }, 1_000, "c2");
    expect(wrongActor.outcome.ok).toBe(false);
    expect(wrongActor.outcome.ok ? null : wrongActor.outcome.code).toBe("UNAUTHORIZED");

    const decided = run(due.state, "BANK_DUE_DECISION", { playerId: "p1", decision: "REPAY" }, 1_000, "c3");
    expect(decided.outcome.ok).toBe(true);
    // 超过到期轮视为超时未决策 -> 失信并冻结金额，不会卡在 ACTIVE
    expect(decided.state.bankLoans[0]?.status).toBe("DEFAULTED");
    expect(decided.state.bankLoans[0]?.remainingCents).toBe(6_655);
    expect(decided.state.players[0]?.credit).toBe("DEFAULTED");
    expect(decided.state.players[0]?.cents).toBe(10_000);
    expect(decided.state.phase).toBe("ACTION");
    expect(decided.state.pendingDueLoanId).toBeNull();
  });

  it("到期决策超时按 REFUSE 失信，并继续推进到 ACTION", () => {
    const state = newState(2);
    state.round = 5;
    state.phase = "INTEREST";
    state.phaseInstanceId = "round5-interest";
    state.bankLoans = [overdueLoan()];

    const due = run(state, "END_ACTION", { playerId: "p1" }, 0, "c1");
    const late = run(due.state, "END_ACTION", { playerId: "p2" }, 45_001, "c2");
    expect(late.outcome.ok).toBe(false);
    expect(late.outcome.ok ? null : late.outcome.code).toBe("NOT_YOUR_TURN");
    expect(late.state.bankLoans[0]?.status).toBe("DEFAULTED");
    expect(late.state.players[0]?.credit).toBe("DEFAULTED");
    expect(late.state.players[0]?.cents).toBe(10_000);
    expect(late.state.phase).toBe("ACTION");
  });
});

describe("permission_rejects", () => {
  it("非当前玩家行动与伪造出借人同意都被拒，且不消耗行动、不改倒计时", () => {
    const first = run(newState(3), "END_ACTION", { playerId: "p1" }, 0, "c1");
    expect(first.state.currentSeatId).toBe(2);

    const notTurn = run(first.state, "BORROW_BANK", { playerId: "p1", amountCents: 1_000 }, 1_000, "c2");
    expect(notTurn.outcome.ok).toBe(false);
    expect(notTurn.outcome.ok ? null : notTurn.outcome.code).toBe("NOT_YOUR_TURN");
    expect(notTurn.state.bankLoans).toHaveLength(0);
    expect(notTurn.state.version).toBe(first.state.version);
    expect(notTurn.state.deadlineAt).toBe(first.state.deadlineAt);
    expect(notTurn.state.currentSeatId).toBe(2);

    const requested = run(
      first.state,
      "REQUEST_PRIVATE_LOAN",
      { playerId: "p2", lenderId: "p1", principalCents: 5_000, rateBps: 1_000, requestId: "req-1" },
      1_000,
      "req-1",
    );
    expect(requested.outcome.ok).toBe(true);
    const deadlineBefore = requested.state.deadlineAt;

    const forged = run(
      requested.state,
      "ACCEPT_PRIVATE_LOAN",
      { playerId: "p3", requestId: "req-1" },
      2_000,
      "c4",
    );
    expect(forged.outcome.ok).toBe(false);
    expect(forged.outcome.ok ? null : forged.outcome.code).toBe("UNAUTHORIZED");
    expect(forged.state.requests[0]?.status).toBe("PENDING");
    expect(forged.state.privateLoans).toHaveLength(0);
    expect(forged.state.deadlineAt).toBe(deadlineBefore);
    expect(forged.state.version).toBe(requested.state.version);
  });
});

describe("actor_identity", () => {
  it("ctx.actorId 与 payload.playerId 不一致时返回 UNAUTHORIZED，且不改状态", () => {
    const first = run(newState(2), "END_ACTION", { playerId: "p1" }, 0, "c1");
    expect(first.state.currentSeatId).toBe(2);

    const forged = run(first.state, "END_ACTION", { playerId: "p2" }, 1_000, "c2", "p1");
    expect(forged.outcome.ok).toBe(false);
    expect(forged.outcome.ok ? null : forged.outcome.code).toBe("UNAUTHORIZED");
    expect(forged.state.currentSeatId).toBe(2);
    expect(forged.state.version).toBe(first.state.version);
  });
});

describe("bank_loan_ids_unique", () => {
  it("同一轮两名玩家借款生成互不相同的全局唯一 ID", () => {
    const first = run(newState(2), "BORROW_BANK", { playerId: "p1", amountCents: 5_000 }, 0, "c1");
    expect(first.outcome.ok).toBe(true);

    const second = run(first.state, "BORROW_BANK", { playerId: "p2", amountCents: 5_000 }, 1_000, "c2");
    expect(second.outcome.ok).toBe(true);
    expect(second.state.bankLoans).toHaveLength(2);
    expect(second.state.bankLoans[0]?.loanId).toBe("bank-1-r1-0");
    expect(second.state.bankLoans[1]?.loanId).toBe("bank-2-r1-1");
    expect(new Set(second.state.bankLoans.map((loan) => loan.loanId)).size).toBe(2);
  });

  it("同 ID 命中两笔时还款抛 RULE_INVARIANT 并整次回滚", () => {
    const state = newState(2);
    state.phase = "ACTION";
    state.currentSeatId = 1;
    state.windowDeadlineMs = 60_000;
    state.deadlineAt = new Date(60_000).toISOString();
    const duplicate = overdueLoan({
      loanId: "dup-loan",
      principalCents: 5_000,
      remainingCents: 5_000,
      dueRound: 4,
      lastInterestRound: 1,
    });
    state.bankLoans = [duplicate, { ...duplicate }];
    const centsBefore = state.players[0]?.cents ?? 0;

    const result = run(state, "REPAY_BANK", { playerId: "p1", loanId: "dup-loan", cents: 1_000 }, 0, "c1");
    expect(result.outcome.ok).toBe(false);
    expect(result.outcome.ok ? null : result.outcome.code).toBe("RULE_INVARIANT");
    expect(result.state.bankLoans).toHaveLength(2);
    expect(result.state.bankLoans[0]?.remainingCents).toBe(5_000);
    expect(result.state.players[0]?.cents).toBe(centsBefore);
    expect(result.state.version).toBe(state.version);
  });
});

describe("credit_overflow_guard", () => {
  it("余额接近上限时借款入账被拒 INVALID_AMOUNT，余额与贷款都不变", () => {
    const state = newState(2);
    state.phase = "ACTION";
    state.currentSeatId = 1;
    state.windowDeadlineMs = 60_000;
    state.deadlineAt = new Date(60_000).toISOString();
    state.players[0]!.cents = MAX_MONEY_CENTS - 500;

    const result = run(state, "BORROW_BANK", { playerId: "p1", amountCents: 1_000 }, 0, "c1");
    expect(result.outcome.ok).toBe(false);
    expect(result.outcome.ok ? null : result.outcome.code).toBe("INVALID_AMOUNT");
    expect(result.state.players[0]?.cents).toBe(MAX_MONEY_CENTS - 500);
    expect(result.state.bankLoans).toHaveLength(0);
    expect(result.state.version).toBe(state.version);
  });

  it("额度恰好等于剩余空间时可借成功，多 1 分被拒", () => {
    const state = newState(2);
    state.phase = "ACTION";
    state.currentSeatId = 1;
    state.windowDeadlineMs = 60_000;
    state.deadlineAt = new Date(60_000).toISOString();
    state.players[0]!.cents = MAX_MONEY_CENTS - 500;

    const tooMuch = run(state, "BORROW_BANK", { playerId: "p1", amountCents: 501 }, 0, "c1");
    expect(tooMuch.outcome.ok).toBe(false);
    expect(tooMuch.outcome.ok ? null : tooMuch.outcome.code).toBe("INVALID_AMOUNT");
    expect(tooMuch.state.players[0]?.cents).toBe(MAX_MONEY_CENTS - 500);
    expect(tooMuch.state.bankLoans).toHaveLength(0);

    const exact = run(state, "BORROW_BANK", { playerId: "p1", amountCents: 500 }, 0, "c2");
    expect(exact.outcome.ok).toBe(true);
    expect(exact.state.players[0]?.cents).toBe(MAX_MONEY_CENTS);
    expect(exact.state.bankLoans).toHaveLength(1);
  });
});

describe("views_privacy", () => {
  it("本人看到完整财务，第三人的视图 JSON 不含任何他人合同与下注字段", () => {
    const state = newState(3);
    state.requests = [
      {
        requestId: "req-1",
        borrowerId: "p1",
        lenderId: "p2",
        principalCents: 5_000,
        rateBps: 1_000,
        createdRound: 1,
        createdAtMs: 0,
        deadlineMs: 45_000,
        status: "PENDING",
        borrowerCredit: "GOOD",
        borrowerDefaultedBankDebtCents: 0,
      },
    ];
    state.bankLoans = [
      {
        loanId: "bank-own",
        borrowerId: "p1",
        seatId: 1,
        principalCents: 5_000,
        remainingCents: 5_500,
        rateBps: 1_000,
        issuedRound: 1,
        dueRound: 4,
        lastInterestRound: 1,
        status: "ACTIVE",
        origin: "NORMAL",
      },
    ];
    state.privateLoans = [
      {
        loanId: "pl-active",
        requestId: "req-1",
        borrowerId: "p1",
        lenderId: "p2",
        principalCents: 4_000,
        remainingCents: 4_400,
        rateBps: 1_000,
        issuedRound: 1,
        lastInterestRound: 1,
        status: "ACTIVE",
      },
      {
        loanId: "pl-frozen",
        requestId: "req-f",
        borrowerId: "p2",
        lenderId: "p1",
        principalCents: 2_000,
        remainingCents: 2_000,
        rateBps: 1_000,
        issuedRound: 1,
        lastInterestRound: 1,
        status: "FROZEN",
      },
      {
        loanId: "pl-bad",
        requestId: "req-b",
        borrowerId: "p2",
        lenderId: "p1",
        principalCents: 1_000,
        remainingCents: 1_000,
        rateBps: 1_000,
        issuedRound: 1,
        lastInterestRound: 1,
        status: "BAD_DEBT",
      },
    ];
    state.bets = {
      p1: { betCents: 4_321, guess: 1, leverage: 2 },
      p2: { betCents: 1_111, guess: 0, leverage: 1 },
    };

    const mine = getPlayerView(state, "p1", new Date(0));
    expect(mine.finance.pendingRequest?.requestId).toBe("req-1");
    expect(mine.finance.bankLoans.map((loan) => loan.loanId)).toEqual(["bank-own"]);
    expect(mine.finance.privateLoans.map((loan) => loan.loanId)).toEqual(
      expect.arrayContaining(["pl-active", "pl-frozen", "pl-bad"]),
    );
    expect(mine.finance.myBet).toEqual({ betCents: 4_321, guess: 1, leverage: 2 });
    const mineJson = JSON.stringify(mine);
    for (const key of ["loanId", "remainingCents", "principalCents", "betCents", "guess", "leverage"]) {
      expect(mineJson).toContain(key);
    }

    const third = getPlayerView(state, "p3", new Date(0));
    const thirdJson = JSON.stringify(third);
    for (const key of ["loanId", "remainingCents", "principalCents", "betCents", "guess", "leverage"]) {
      expect(thirdJson).not.toContain(key);
    }
    expect(third.finance.pendingRequest).toBeNull();
    expect(third.finance.incomingRequests).toHaveLength(0);
    expect(third.finance.privateLoans).toHaveLength(0);
    expect(third.finance.bankLoans).toHaveLength(0);
    expect(third.finance.myBet).toBeNull();
  });
});

describe("cancel_private_loan", () => {
  it("ACTION 取消后座位前进，出借人再同意返回 REQUEST_EXPIRED 且不转账", () => {
    const requested = run(
      newState(2),
      "REQUEST_PRIVATE_LOAN",
      { playerId: "p1", lenderId: "p2", principalCents: 5_000, rateBps: 1_000, requestId: "req-1" },
      0,
      "req-1",
    );
    expect(requested.outcome.ok).toBe(true);
    expect(requested.state.pendingRequestId).toBe("req-1");

    const cancelled = run(
      requested.state,
      "CANCEL_PRIVATE_LOAN",
      { playerId: "p1", requestId: "req-1" },
      1_000,
      "c2",
    );
    expect(cancelled.outcome.ok).toBe(true);
    expect(cancelled.state.requests[0]?.status).toBe("CANCELLED");
    expect(cancelled.state.pendingRequestId).toBeNull();
    expect(cancelled.state.currentSeatId).toBe(2);

    const lateAccept = run(
      cancelled.state,
      "ACCEPT_PRIVATE_LOAN",
      { playerId: "p2", requestId: "req-1" },
      2_000,
      "c3",
    );
    expect(lateAccept.outcome.ok).toBe(false);
    expect(lateAccept.outcome.ok ? null : lateAccept.outcome.code).toBe("REQUEST_EXPIRED");
    expect(lateAccept.state.privateLoans).toHaveLength(0);
    expect(lateAccept.state.players[0]?.cents).toBe(10_000);
    expect(lateAccept.state.players[1]?.cents).toBe(10_000);
  });

  it("第三人取消被拒 UNAUTHORIZED，请求仍 PENDING", () => {
    const requested = run(
      newState(3),
      "REQUEST_PRIVATE_LOAN",
      { playerId: "p1", lenderId: "p2", principalCents: 5_000, rateBps: 1_000, requestId: "req-1" },
      0,
      "req-1",
    );
    expect(requested.outcome.ok).toBe(true);

    const forged = run(
      requested.state,
      "CANCEL_PRIVATE_LOAN",
      { playerId: "p3", requestId: "req-1" },
      1_000,
      "c2",
    );
    expect(forged.outcome.ok).toBe(false);
    expect(forged.outcome.ok ? null : forged.outcome.code).toBe("UNAUTHORIZED");
    expect(forged.state.requests[0]?.status).toBe("PENDING");
    expect(forged.state.pendingRequestId).toBe("req-1");
    expect(forged.state.version).toBe(requested.state.version);
  });
});

describe("bank_due_insufficient_funds", () => {
  it("余额不足时直接失信，不设截止、不发 BANK_DUE_PENDING", () => {
    const state = newState(2);
    state.round = 5;
    state.phase = "INTEREST";
    state.phaseInstanceId = "round5-interest";
    state.bankLoans = [overdueLoan()];
    state.players[0]!.cents = 0;

    const due = run(state, "END_ACTION", { playerId: "p1" }, 0, "c1");
    expect(due.state.pendingDueLoanId).toBeNull();
    expect(due.state.bankLoans[0]?.status).toBe("DEFAULTED");
    expect(due.state.players[0]?.credit).toBe("DEFAULTED");
    expect(due.events.some((event) => event.type === "BANK_DUE_PENDING")).toBe(false);
    const defaulted = due.events.find((event) => event.type === "BANK_LOAN_DEFAULTED");
    expect((defaulted?.payload as { reason: string }).reason).toBe("insufficient_funds");
  });
});

describe("events_for_player", () => {
  it("私人金额事件只对当事人可见，第三人过滤后不含金额", () => {
    const state = newState(3);
    state.round = 2;
    state.phase = "ACTION";
    state.currentSeatId = 1;
    state.windowDeadlineMs = 60_000;
    state.deadlineAt = new Date(60_000).toISOString();
    state.privateLoans = [
      {
        loanId: "pl-1",
        requestId: "rq-1",
        borrowerId: "p1",
        lenderId: "p2",
        principalCents: 4_000,
        remainingCents: 4_400,
        rateBps: 1_000,
        issuedRound: 1,
        lastInterestRound: 2,
        status: "ACTIVE",
      },
    ];

    const repaid = run(state, "REPAY_PRIVATE", { playerId: "p1", loanId: "pl-1", cents: 1_000 }, 0, "c1");
    expect(repaid.outcome.ok).toBe(true);
    expect(repaid.state.currentSeatId).toBe(2);

    const collected = run(
      repaid.state,
      "COLLECT_PRIVATE",
      { playerId: "p2", loanId: "pl-1", cents: 1_000 },
      1_000,
      "c2",
    );
    expect(collected.outcome.ok).toBe(true);

    // 另外走一遍真实的请求/同意流程，让事件流里同时含有 LOAN_REQUESTED 与 PRIVATE_LOAN_ACCEPTED 的金额。
    const requestedEvents = run(
      state,
      "REQUEST_PRIVATE_LOAN",
      { playerId: "p1", lenderId: "p2", principalCents: 5_000, rateBps: 1_000, requestId: "aud-1" },
      0,
      "aud-1",
    );
    expect(requestedEvents.outcome.ok).toBe(true);
    const acceptedEvents = run(
      requestedEvents.state,
      "ACCEPT_PRIVATE_LOAN",
      { playerId: "p2", requestId: "aud-1" },
      1_000,
      "aud-2",
    );
    expect(acceptedEvents.outcome.ok).toBe(true);

    const all = [...requestedEvents.events, ...acceptedEvents.events, ...repaid.events, ...collected.events];
    const third = eventsForPlayer(all, "p3");
    const thirdJson = JSON.stringify(third);
    expect(thirdJson).not.toContain("principalCents");
    expect(thirdJson).not.toContain("paidCents");
    expect(thirdJson).not.toContain("collectedCents");
    expect(third.map((event) => event.type)).not.toContain("PRIVATE_LOAN_REPAID");
    expect(third.map((event) => event.type)).not.toContain("LOAN_REQUESTED");
    expect(third.map((event) => event.type)).not.toContain("PRIVATE_LOAN_ACCEPTED");

    const party = JSON.stringify(eventsForPlayer(all, "p1"));
    expect(party).toContain("principalCents");
    expect(party).toContain("paidCents");
    expect(party).toContain("collectedCents");
  });
});

describe("advanceSystem", () => {
  it("没有客户端命令时，计时器到期也能把阶段推进到 BETTING", () => {
    const s = newState(2);
    const afterFirst = applyCommand(
      s,
      { protocolVersion: 1, gameId: "g1", commandId: "end-1", type: "END_ACTION", payload: { playerId: "p1" } },
      { actorId: "p1", nowMs: 0, drawResult: 0 },
    );
    expect(afterFirst.state.phase).toBe("ACTION");
    const acting = afterFirst.state as EngineState;

    const advanced = advanceSystem(acting, { actorId: "p2", nowMs: 61_000, drawResult: 0 });
    expect(advanced.outcome.ok).toBe(true);
    expect(advanced.state.phase).toBe("BETTING");
    expect(advanced.state.version).toBe(acting.version + 1);
    expect(advanced.events.length).toBeGreaterThan(0);
    expect(advanced.events[0]!.seq).toBe(advanced.state.eventSeq - advanced.events.length + 1);
  });

  it("进入 ACTION 后未到截止时间时，系统推进不改状态", () => {
    const s = newState(2);
    const afterFirst = applyCommand(
      s,
      { protocolVersion: 1, gameId: "g1", commandId: "end-2", type: "END_ACTION", payload: { playerId: "p1" } },
      { actorId: "p1", nowMs: 0, drawResult: 0 },
    );
    const acting = afterFirst.state as EngineState;
    expect(acting.phase).toBe("ACTION");

    const result = advanceSystem(acting, { actorId: "p2", nowMs: 0, drawResult: 0 });
    expect(result.state.phase).toBe("ACTION");
    expect(result.state.version).toBe(acting.version);
    expect(result.events).toEqual([]);
  });
});
