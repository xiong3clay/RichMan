import { describe, expect, it } from "vitest";
import { MAX_MONEY_CENTS } from "@richman/shared";
import type { GameCommand, GameEvent } from "@richman/shared";
import {
  advanceSystem, applyCommand, createInitialState, eventsForPlayer, getPlayerView, resumeFromPause,
} from "../src/engine.js";
import type { EngineState } from "../src/engine.js";
import { createLoanRequest } from "../src/private-loans.js";

const config = { timerMode: "standard" as const, privateDebtAffectsBankLoan: false };

function initial(playerCount = 4): EngineState {
  return createInitialState("d6-game", config, ["甲", "乙", "丙", "丁"].slice(0, playerCount).map(nickname => ({ nickname })));
}

function action(playerCount = 4): EngineState {
  return advanceSystem(initial(playerCount), { actorId: "SYSTEM", nowMs: 0, drawResult: 0 }).state as EngineState;
}

function send(state: EngineState, type: string, actorId: string, payload: Record<string, unknown>, nowMs: number) {
  const command: GameCommand = {
    protocolVersion: 1, gameId: state.gameId, commandId: `${type}-${actorId}-${nowMs}`, type, payload,
  };
  const result = applyCommand(state, command, { actorId, nowMs, drawResult: 0 });
  return { ...result, state: result.state as EngineState };
}

function request(state: EngineState, borrowerId: string, lenderId: string, requestId: string, nowMs: number, principalCents = 500) {
  return send(state, "REQUEST_PRIVATE_LOAN", borrowerId, { lenderId, requestId, principalCents, rateBps: 1_000 }, nowMs);
}

/** Existing valid book after two borrowers have already used their turns, independent of request creation. */
function pendingBook(): EngineState {
  const state = action();
  state.requests = [
    createLoanRequest({ requestId: "req-a", borrowerId: "p1", lenderId: "p4", principalCents: 500,
      rateBps: 1_000, createdRound: 1, nowMs: 0, deadlineMs: 45_000, existingRequests: [],
      borrowerCredit: "GOOD", borrowerDefaultedBankDebtCents: 0, borrowerAlive: true, lenderAlive: true }),
    createLoanRequest({ requestId: "req-b", borrowerId: "p2", lenderId: "p4", principalCents: 700,
      rateBps: 1_000, createdRound: 1, nowMs: 10_000, deadlineMs: 55_000, existingRequests: [],
      borrowerCredit: "GOOD", borrowerDefaultedBankDebtCents: 0, borrowerAlive: true, lenderAlive: true }),
  ];
  state.actedSeats = [1, 2];
  state.currentSeatId = 3;
  state.windowDeadlineMs = 70_000;
  state.deadlineAt = new Date(70_000).toISOString();
  return state;
}

function expiryIds(events: GameEvent[]): string[] {
  return events.filter(e => e.type === "LOAN_REQUEST_EXPIRED").map(e => (e.payload as { requestId: string }).requestId);
}

describe("D6 semantics A: nonblocking ACTION requests", () => {
  it("T1 two_borrowers_one_lender: each submit consumes its turn and two incoming requests coexist", () => {
    const first = request(action(), "p1", "p4", "req-a", 0);
    expect(first.outcome).toEqual({ ok: true });
    expect(first.state.currentSeatId).toBe(2);
    expect(first.state.actedSeats).toEqual([1]);
    expect(first.state.pendingRequestId).toBeNull();
    expect(first.state.windowDeadlineMs).toBe(60_000);
    const second = request(first.state, "p2", "p4", "req-b", 10_000, 700);
    expect(second.outcome).toEqual({ ok: true });
    expect(second.state.phase).toBe("ACTION");
    expect(second.state.currentSeatId).toBe(3);
    expect(second.state.actedSeats).toEqual([1, 2]);
    expect(second.state.pendingRequestId).toBeNull();
    expect(second.state.requests.map(r => [r.requestId, r.status, r.deadlineMs])).toEqual([
      ["req-a", "PENDING", 45_000], ["req-b", "PENDING", 55_000],
    ]);
    const incoming = getPlayerView(second.state, "p4", new Date(10_001)).finance.incomingRequests;
    expect(incoming.map(r => r.requestId)).toEqual(["req-a", "req-b"]);
    expect(incoming).toHaveLength(2);
  });

  it("T2 off_turn_accept: accepting transfers once and preserves the current player's action/deadline", () => {
    const first = request(action(), "p1", "p4", "req-a", 0);
    expect(first.outcome).toEqual({ ok: true });
    const second = request(first.state, "p2", "p4", "req-b", 10_000, 700);
    expect(second.outcome).toEqual({ ok: true });
    const before = second.state;
    expect(before.currentSeatId).toBe(3);
    expect(before.pendingRequestId).toBeNull();
    const accepted = send(before, "ACCEPT_PRIVATE_LOAN", "p4", { requestId: "req-a" }, 11_000);
    expect(accepted.outcome).toEqual({ ok: true });
    expect(accepted.state.requests.map(r => r.status)).toEqual(["ACCEPTED", "PENDING"]);
    expect(accepted.state.currentSeatId).toBe(3);
    expect(accepted.state.actedSeats).toEqual(before.actedSeats);
    expect(accepted.state.deadlineAt).toBe(before.deadlineAt);
    expect(accepted.state.players.map(p => p.cents)).toEqual([10_500, 10_000, 10_000, 9_500]);
    expect(accepted.state.privateLoans).toHaveLength(1);
    const repeated = send(accepted.state, "ACCEPT_PRIVATE_LOAN", "p4", { requestId: "req-a" }, 11_001);
    expect(repeated.outcome).toMatchObject({ ok: false, code: "REQUEST_EXPIRED" });
    expect(repeated.state).toEqual(accepted.state);
  });

  it("T3 current_lender_accept: lender keeps their own action until explicitly ending it", () => {
    const requested = request(action(), "p1", "p2", "req-a", 0);
    expect(requested.outcome).toEqual({ ok: true });
    expect(requested.state.currentSeatId).toBe(2);
    const deadline = requested.state.deadlineAt;
    const accepted = send(requested.state, "ACCEPT_PRIVATE_LOAN", "p2", { requestId: "req-a" }, 1_000);
    expect(accepted.outcome).toEqual({ ok: true });
    expect(accepted.state.currentSeatId).toBe(2);
    expect(accepted.state.actedSeats).toEqual([1]);
    expect(accepted.state.deadlineAt).toBe(deadline);
    const ended = send(accepted.state, "END_ACTION", "p2", {}, 2_000);
    expect(ended.outcome).toEqual({ ok: true });
    expect(ended.state.currentSeatId).toBe(3);
    expect(ended.state.actedSeats).toEqual([1, 2]);
  });

  it("T4 refuse_keeps_action: refusing removes one incoming request without closing the lender/current turn", () => {
    const before = pendingBook();
    const refused = send(before, "REFUSE_PRIVATE_LOAN", "p4", { requestId: "req-a" }, 11_000);
    expect(refused.outcome).toEqual({ ok: true });
    expect(refused.state.currentSeatId).toBe(before.currentSeatId);
    expect(refused.state.actedSeats).toEqual(before.actedSeats);
    expect(refused.state.deadlineAt).toBe(before.deadlineAt);
    expect(refused.state.players).toEqual(before.players);
    expect(refused.state.requests.map(r => r.status)).toEqual(["REFUSED", "PENDING"]);
    expect(getPlayerView(refused.state, "p4", new Date(11_000)).finance.incomingRequests.map(r => r.requestId)).toEqual(["req-b"]);
  });

  it("T5 cancel_no_refund: borrower cancels after submitting without restoring or consuming another action", () => {
    const requested = request(action(), "p1", "p4", "req-a", 0);
    expect(requested.outcome).toEqual({ ok: true });
    const cancelled = send(requested.state, "CANCEL_PRIVATE_LOAN", "p1", { requestId: "req-a" }, 1_000);
    expect(cancelled.outcome).toEqual({ ok: true });
    expect(cancelled.state.requests[0]!.status).toBe("CANCELLED");
    expect(cancelled.state.actedSeats).toEqual([1]);
    expect(cancelled.state.currentSeatId).toBe(2);
    expect(cancelled.state.deadlineAt).toBe(requested.state.deadlineAt);
    expect(cancelled.state.players).toEqual(requested.state.players);
    const tryAgain = send(cancelled.state, "BORROW_BANK", "p1", { amountCents: 100 }, 1_001);
    expect(tryAgain.outcome).toMatchObject({ ok: false, code: "NOT_YOUR_TURN" });
    expect(tryAgain.state).toEqual(cancelled.state);
    const next = send(cancelled.state, "END_ACTION", "p2", {}, 2_000);
    expect(next.outcome).toEqual({ ok: true });expect(next.state.currentSeatId).toBe(3);
    expect(next.state.actedSeats).toEqual([1, 2]);
  });

  it("T6 expire_one_only: one 45-second request expiry leaves the other request/current action untouched", () => {
    const before = pendingBook();
    const tick = advanceSystem(before, { actorId: "SYSTEM", nowMs: 45_000, drawResult: 0 });
    const state = tick.state as EngineState;
    expect(tick.outcome).toEqual({ ok: true });
    expect(state.requests.map(r => r.status)).toEqual(["EXPIRED", "PENDING"]);
    expect(expiryIds(tick.events)).toEqual(["req-a"]);
    expect(state.currentSeatId).toBe(before.currentSeatId);
    expect(state.actedSeats).toEqual(before.actedSeats);
    expect(state.deadlineAt).toBe(before.deadlineAt);
    expect(state.players).toEqual(before.players);
  });

  it("T7 action_end_waits_for_requests: completed seats wait for each pending deadline before entering BETTING", () => {
    const before = pendingBook();
    const third = send(before, "END_ACTION", "p3", {}, 11_000);
    expect(third.outcome).toEqual({ ok: true });expect(third.state.currentSeatId).toBe(4);
    const ended = send(third.state, "END_ACTION", "p4", {}, 12_000);
    expect(ended.outcome).toEqual({ ok: true });
    expect(ended.state.phase).toBe("ACTION");expect(ended.state.currentSeatId).toBeNull();
    expect(ended.state.actedSeats).toEqual([1, 2, 3, 4]);
    expect(ended.state.requests.map(r => r.status)).toEqual(["PENDING", "PENDING"]);
    expect(ended.state.deadlineAt).toBe(new Date(45_000).toISOString());
    expect(ended.state.windowDeadlineMs).toBe(45_000);expect(expiryIds(ended.events)).toEqual([]);
    expect(ended.state.players).toEqual(before.players);
    expect(ended.state.privateLoans).toEqual([]);
    const early = advanceSystem(ended.state, { actorId: "SYSTEM", nowMs: 44_999, drawResult: 0 });
    expect(early.state).toEqual(ended.state);expect(early.events).toEqual([]);
    const first = advanceSystem(ended.state, { actorId: "SYSTEM", nowMs: 45_000, drawResult: 0 });
    expect(first.state.phase).toBe("ACTION");expect((first.state as EngineState).currentSeatId).toBeNull();
    expect((first.state as EngineState).requests.map(r => r.status)).toEqual(["EXPIRED", "PENDING"]);
    expect(expiryIds(first.events)).toEqual(["req-a"]);
    expect(first.state.deadlineAt).toBe(new Date(55_000).toISOString());
    const last = advanceSystem(first.state, { actorId: "SYSTEM", nowMs: 55_000, drawResult: 0 });
    expect(last.state.phase).toBe("BETTING");
    expect((last.state as EngineState).requests.map(r => r.status)).toEqual(["EXPIRED", "EXPIRED"]);
    expect((last.state as EngineState).requests.some(r => r.status === "PENDING")).toBe(false);
    expect(expiryIds(last.events)).toEqual(["req-b"]);
    expect(last.state.players).toEqual(before.players);expect((last.state as EngineState).privateLoans).toEqual([]);
  });

  it("T8 duplicate_borrower: duplicate pending request is rejected before consuming any current action", () => {
    const before = pendingBook();
    before.requests = [before.requests[0]!];before.currentSeatId = 1;before.actedSeats = [];
    const denied = request(before, "p1", "p3", "another", 11_000);
    // The private-loans DUPLICATE_PENDING_REQUEST rule maps to existing public INVALID_ACTION.
    expect(denied.outcome).toMatchObject({ ok: false, code: "INVALID_ACTION", message: "同一借款人最多只有一个待处理请求" });
    expect(denied.state).toEqual(before);expect(denied.events).toEqual([]);
  });

  it("T9 tax_rescue_unchanged: rescue request retains its waiting pointer and clears danger after approval", () => {
    const state = initial();
    Object.assign(state, { phase: "TAX", round: 3, taxSeats: [1, 2, 3, 4], taxIndex: 0 });
    state.players[0]!.cents = 500;
    const danger = advanceSystem(state, { actorId: "SYSTEM", nowMs: 0, drawResult: 0 }).state as EngineState;
    expect(danger.players[0]!.cents).toBe(-1_500);expect(danger.dangerSeatId).toBe(1);
    const requested = request(danger, "p1", "p4", "rescue-a", 1_000, 2_000);
    expect(requested.outcome).toEqual({ ok: true });expect(requested.state.pendingRequestId).toBe("rescue-a");
    expect(requested.state.windowDeadlineMs).toBe(46_000);expect(requested.state.dangerDeadlineMs).toBe(60_000);
    const wait = advanceSystem(requested.state, { actorId: "SYSTEM", nowMs: 2_000, drawResult: 0 }).state as EngineState;
    expect(wait).toEqual(requested.state);
    const rescued = send(wait, "ACCEPT_PRIVATE_LOAN", "p4", { requestId: "rescue-a" }, 3_000);
    expect(rescued.outcome).toEqual({ ok: true });
    expect(rescued.state.players.map(p => p.cents)).toEqual([500, 8_000, 8_000, 6_000]);
    expect(rescued.state.pendingRequestId).toBeNull();expect(rescued.state.dangerSeatId).toBeNull();
    expect(rescued.state.players[0]!.status).toBe("ALIVE");expect(rescued.state.round).toBe(4);
    expect(rescued.state.phase).toBe("ACTION");expect(rescued.events.some(e => e.type === "DANGER_RESCUED")).toBe(true);
  });

  it("T10 migrate_legacy_action_pointer: old ACTION waiting snapshot becomes acted once and play continues", () => {
    const before = pendingBook();
    before.requests = [before.requests[0]!];before.pendingRequestId = "req-a";before.currentSeatId = 1;before.actedSeats = [];
    before.windowDeadlineMs = 45_000;before.deadlineAt = new Date(45_000).toISOString();
    const tick = advanceSystem(before, { actorId: "SYSTEM", nowMs: 10_000, drawResult: 0 });
    const migrated = tick.state as EngineState;
    expect(tick.outcome).toEqual({ ok: true });expect(migrated.pendingRequestId).toBeNull();
    expect(migrated.actedSeats).toEqual([1]);expect(migrated.currentSeatId).toBe(2);
    expect(migrated.requests[0]!.status).toBe("PENDING");
    const again = advanceSystem(migrated, { actorId: "SYSTEM", nowMs: 10_001, drawResult: 0 });
    expect(again.state).toEqual(migrated);expect(again.events).toEqual([]);
    expect(before.pendingRequestId).toBe("req-a");expect(before.actedSeats).toEqual([]);
  });

  it("T11 accept_money_guards: insufficient funds closes only the target as FAILED without transfer or consuming another action", () => {
    const poor = pendingBook();poor.players[3]!.cents = 499;
    const failed = send(poor, "ACCEPT_PRIVATE_LOAN", "p4", { requestId: "req-a" }, 11_000);
    expect(failed.outcome).toEqual({ ok: true });
    expect(failed.state.requests).toEqual([{ ...poor.requests[0], status: "FAILED" }, poor.requests[1]]);
    expect(failed.state.privateLoans).toEqual([]);expect(failed.state.players).toEqual(poor.players);
    expect(failed.state.players[3]!.cents).toBeGreaterThanOrEqual(0);
    expect(failed.state.actedSeats).toEqual([1, 2]);expect(failed.state.currentSeatId).toBe(3);
    expect(failed.state.deadlineAt).toBe(poor.deadlineAt);
    expect(failed.events.map(event => [event.type, event.payload])).toEqual([
      ["LOAN_REQUEST_CLOSED", { requestId: "req-a", status: "FAILED" }],
    ]);
    const retry = send(failed.state, "ACCEPT_PRIVATE_LOAN", "p4", { requestId: "req-a" }, 11_001);
    expect(retry.outcome).toMatchObject({ ok: false, code: "REQUEST_EXPIRED" });
    expect(retry.state).toEqual(failed.state);expect(retry.events).toEqual([]);
    const capped = pendingBook();capped.players[0]!.cents = MAX_MONEY_CENTS - 499;
    const overflow = send(capped, "ACCEPT_PRIVATE_LOAN", "p4", { requestId: "req-a" }, 11_000);
    expect(overflow.outcome).toMatchObject({ ok: false, code: "INVALID_AMOUNT" });
    expect(overflow.state).toEqual(capped);expect(overflow.events).toEqual([]);
    const normal = pendingBook();const accepted = send(normal, "ACCEPT_PRIVATE_LOAN", "p4", { requestId: "req-a" }, 11_000);
    expect(accepted.outcome).toEqual({ ok: true });
    expect(accepted.state.players[0]!.cents - normal.players[0]!.cents).toBe(500);
    expect(normal.players[3]!.cents - accepted.state.players[3]!.cents).toBe(500);
    expect(accepted.state.players.reduce((sum, p) => sum + p.cents, 0)).toBe(normal.players.reduce((sum, p) => sum + p.cents, 0));
  });

  it("T12 resume_all_pending: resuming renews every ACTION request separately from the seat timer and preserves acted seats", () => {
    const before = pendingBook();const copy = structuredClone(before);
    const resumed = resumeFromPause(before, { nowMs: 100_000 });
    expect(resumed.requests).toEqual(before.requests.map(r => ({ ...r, deadlineMs: 145_000 })));
    expect(resumed.pendingRequestId).toBeNull();expect(resumed.currentSeatId).toBe(3);
    expect(resumed.actedSeats).toEqual([1, 2]);expect(resumed.windowDeadlineMs).toBe(160_000);
    expect(resumed.players).toEqual(before.players);expect(resumed.privateLoans).toEqual(before.privateLoans);
    expect(before).toEqual(copy);
    const tick = advanceSystem(resumed, { actorId: "SYSTEM", nowMs: 100_001, drawResult: 0 });
    expect(tick.state).toEqual(resumed);expect(tick.events).toEqual([]);
  });

  it("T13 request_view_privacy: lender sees both chronological requests, borrowers see only theirs and third parties see none", () => {
    const state = pendingBook();
    expect(getPlayerView(state, "p4", new Date(11_000)).finance.incomingRequests.map(r => r.requestId)).toEqual(["req-a", "req-b"]);
    expect(getPlayerView(state, "p1", new Date(11_000)).finance.pendingRequest?.requestId).toBe("req-a");
    expect(getPlayerView(state, "p2", new Date(11_000)).finance.pendingRequest?.requestId).toBe("req-b");
    const third = getPlayerView(state, "p3", new Date(11_000));
    expect(third.finance.pendingRequest).toBeNull();expect(third.finance.incomingRequests).toEqual([]);
    expect(third.finance.privateLoans).toEqual([]);expect(JSON.stringify(third)).not.toContain("req-a");expect(JSON.stringify(third)).not.toContain("req-b");
    const requested = request(action(), "p1", "p4", "privacy-request", 0);
    expect(requested.outcome).toEqual({ ok: true });
    expect(eventsForPlayer(requested.events, "p3").some(e => e.type === "LOAN_REQUESTED")).toBe(false);
    expect(eventsForPlayer(requested.events, "p4").filter(e => e.type === "LOAN_REQUESTED")).toHaveLength(1);
  });

  it("T14 expired_accept: late approval expires only that request and does not consume the current seat", () => {
    const before = pendingBook();
    const late = send(before, "ACCEPT_PRIVATE_LOAN", "p4", { requestId: "req-a" }, 45_000);
    expect(late.outcome).toMatchObject({ ok: false, code: "REQUEST_EXPIRED" });
    expect(late.state.requests.map(r => r.status)).toEqual(["EXPIRED", "PENDING"]);
    expect(late.state.currentSeatId).toBe(3);expect(late.state.actedSeats).toEqual([1, 2]);
    expect(late.state.deadlineAt).toBe(before.deadlineAt);expect(late.state.players).toEqual(before.players);
    expect(expiryIds(late.events)).toEqual(["req-a"]);
  });

  it("T15 late_submit_full_request_window: ACTION submit at 50s gives a full 45s request beyond the old seat deadline", () => {
    const before = action();
    expect(before.windowDeadlineMs).toBe(60_000);
    const late = request(before, "p1", "p4", "late-request", 50_000);
    expect(late.outcome).toEqual({ ok: true });
    expect(late.state.requests[0]!.deadlineMs).toBe(95_000);
    expect(late.state.currentSeatId).toBe(2);
    expect(late.state.actedSeats).toEqual([1]);
    expect(late.state.windowDeadlineMs).toBe(110_000);
    expect(late.state.pendingRequestId).toBeNull();
  });

  it("T16 migrate_does_not_reset_other_seat: old pointer to an earlier borrower preserves the different current seat/deadline", () => {
    const before = pendingBook();
    before.pendingRequestId = "req-a";
    before.actedSeats = [2];
    const migrated = advanceSystem(before, { actorId: "SYSTEM", nowMs: 11_000, drawResult: 0 });
    const state = migrated.state as EngineState;
    expect(migrated.outcome).toEqual({ ok: true });
    expect(state.pendingRequestId).toBeNull();
    expect([...state.actedSeats].sort()).toEqual([1, 2]);
    expect(state.actedSeats.filter(seat => seat === 1)).toHaveLength(1);
    expect(state.currentSeatId).toBe(3);
    expect(state.windowDeadlineMs).toBe(before.windowDeadlineMs);
    expect(state.deadlineAt).toBe(before.deadlineAt);
    expect(state.requests).toEqual(before.requests);
    expect(state.players).toEqual(before.players);
  });

  it("T17 migration_is_versioned: migrating a legacy pointer is a durable state change even without a seat transition", () => {
    const before = pendingBook();before.pendingRequestId = "req-a";before.actedSeats = [2];
    const tick = advanceSystem(before, { actorId: "SYSTEM", nowMs: 11_000, drawResult: 0 });
    expect(tick.state.version).toBe(before.version + 1);
    expect((tick.state as EngineState).pendingRequestId).toBeNull();
    const denied = send(before, "END_ACTION", "p1", {}, 11_000);
    expect(denied.outcome).toMatchObject({ ok: false, code: "NOT_YOUR_TURN" });
    expect(denied.state.version).toBe(before.version + 1);
    expect((denied.state as EngineState).pendingRequestId).toBeNull();
    expect((denied.state as EngineState).currentSeatId).toBe(3);
    expect(denied.state.players).toEqual(before.players);
    const again = advanceSystem(tick.state, { actorId: "SYSTEM", nowMs: 11_001, drawResult: 0 });
    expect(again.state).toEqual(tick.state);
  });

  it("T18 resume_legacy_pointer: next seat is immediately actionable after migration without replaying system settlement", () => {
    const before = pendingBook();before.requests = [before.requests[0]!];before.actedSeats = [];
    before.pendingRequestId = "req-a";before.currentSeatId = 1;
    const copy = structuredClone(before);
    const resumed = resumeFromPause(before, { nowMs: 100_000 });
    expect(resumed.currentSeatId).toBe(2);expect(resumed.actedSeats).toEqual([1]);
    expect(resumed.pendingRequestId).toBeNull();expect(resumed.phase).toBe("ACTION");
    expect(resumed.windowDeadlineMs).toBe(160_000);
    expect(resumed.requests[0]).toEqual({ ...before.requests[0], deadlineMs: 145_000 });
    expect(resumed.players).toEqual(before.players);expect(resumed.privateLoans).toEqual(before.privateLoans);
    expect(resumed.version).toBe(before.version + 1);expect(resumed.eventSeq).toBe(before.eventSeq + 1);
    expect(before).toEqual(copy);
    const end = send(resumed, "END_ACTION", "p2", {}, 100_001);
    expect(end.outcome).toEqual({ ok: true });expect((end.state as EngineState).currentSeatId).toBe(3);
  });

  it("T19 resume_legacy_last_seat: completed ACTION waits for renewed requests without another seat turn or settlement", () => {
    for (const timerMode of ["standard", "fast"] as const) {
    const before = pendingBook();before.pendingRequestId = "req-a";
    before.config.timerMode = timerMode;
    before.currentSeatId = 1;before.actedSeats = [2, 3, 4];
    const copy = structuredClone(before);
    const requestDeadline = timerMode === "standard" ? 145_000 : 120_000;
    const resumed = resumeFromPause(before, { nowMs: 100_000 });
    expect(resumed.phase).toBe("ACTION");expect(resumed.currentSeatId).toBeNull();
    expect(resumed.pendingRequestId).toBeNull();
    expect(resumed.deadlineAt).toBe(new Date(requestDeadline).toISOString());expect(resumed.windowDeadlineMs).toBe(requestDeadline);
    expect([...resumed.actedSeats].sort()).toEqual([1, 2, 3, 4]);
    expect(resumed.requests).toEqual(before.requests.map(r => ({ ...r, deadlineMs: requestDeadline })));
    expect(resumed.players).toEqual(before.players);expect(resumed.privateLoans).toEqual(before.privateLoans);
    expect(before).toEqual(copy);
    const tick = advanceSystem(resumed, { actorId: "SYSTEM", nowMs: 100_001, drawResult: 0 });
    expect(tick.state).toEqual(resumed);expect(tick.events).toEqual([]);
    const expired = advanceSystem(resumed, { actorId: "SYSTEM", nowMs: requestDeadline, drawResult: 0 });
    expect(expired.state.phase).toBe("BETTING");
    expect((expired.state as EngineState).requests.map(r => r.status)).toEqual(["EXPIRED", "EXPIRED"]);
    expect(expiryIds(expired.events)).toEqual(["req-a", "req-b"]);
    expect(expired.events.some(e => e.type === "BET_SETTLED")).toBe(false);
    expect(expired.state.players).toEqual(before.players);
    const repeated = advanceSystem(expired.state, { actorId: "SYSTEM", nowMs: requestDeadline + 1, drawResult: 0 });
    expect(repeated.state).toEqual(expired.state);expect(repeated.events).toEqual([]);
    }
  });

  it("T20 last_seat_request_can_be_accepted: two-player final borrower keeps a full answer window then enters BETTING on approval", () => {
    const ended = send(action(2), "END_ACTION", "p1", {}, 0);
    expect(ended.outcome).toEqual({ ok: true });expect(ended.state.currentSeatId).toBe(2);
    const requested = request(ended.state, "p2", "p1", "last-request", 1_000);
    expect(requested.outcome).toEqual({ ok: true });expect(requested.state.phase).toBe("ACTION");
    expect(requested.state.currentSeatId).toBeNull();expect(requested.state.actedSeats).toEqual([1, 2]);
    expect(requested.state.pendingRequestId).toBeNull();expect(requested.state.requests[0]!.status).toBe("PENDING");
    expect(requested.state.requests[0]!.deadlineMs).toBe(46_000);
    expect(requested.state.deadlineAt).toBe(new Date(46_000).toISOString());expect(requested.state.windowDeadlineMs).toBe(46_000);
    expect(expiryIds(requested.events)).toEqual([]);
    const accepted = send(requested.state, "ACCEPT_PRIVATE_LOAN", "p1", { requestId: "last-request" }, 2_000);
    expect(accepted.outcome).toEqual({ ok: true });expect(accepted.state.phase).toBe("BETTING");
    expect(accepted.state.requests[0]!.status).toBe("ACCEPTED");expect(accepted.state.players.map(p => p.cents)).toEqual([9_500, 10_500]);
    expect(accepted.state.privateLoans).toHaveLength(1);expect(accepted.state.privateLoans[0]!.principalCents).toBe(500);
    expect(expiryIds(accepted.events)).toEqual([]);expect(accepted.state.actedSeats).toEqual([1, 2]);
    const refused = send(requested.state, "REFUSE_PRIVATE_LOAN", "p1", { requestId: "last-request" }, 2_000);
    expect(refused.outcome).toEqual({ ok: true });expect(refused.state.phase).toBe("BETTING");
    expect(refused.state.requests[0]!.status).toBe("REFUSED");expect(refused.state.players).toEqual(requested.state.players);
    expect(refused.state.privateLoans).toEqual([]);
    const cancelled = send(requested.state, "CANCEL_PRIVATE_LOAN", "p2", { requestId: "last-request" }, 2_000);
    expect(cancelled.outcome).toEqual({ ok: true });expect(cancelled.state.phase).toBe("BETTING");
    expect(cancelled.state.requests[0]!.status).toBe("CANCELLED");expect(cancelled.state.players).toEqual(requested.state.players);
    expect(cancelled.state.privateLoans).toEqual([]);
    const poor = structuredClone(requested.state);poor.players[0]!.cents = 499;
    const failed = send(poor, "ACCEPT_PRIVATE_LOAN", "p1", { requestId: "last-request" }, 2_000);
    expect(failed.outcome).toEqual({ ok: true });expect(failed.state.phase).toBe("BETTING");
    expect(failed.state.requests[0]!.status).toBe("FAILED");expect(failed.state.players).toEqual(poor.players);
    expect(failed.state.privateLoans).toEqual([]);
  });

  it("T21 last_seat_request_expires: two-player final request enters BETTING only at its own deadline", () => {
    const ended = send(action(2), "END_ACTION", "p1", {}, 0);
    expect(ended.outcome).toEqual({ ok: true });
    const requested = request(ended.state, "p2", "p1", "last-request", 1_000);
    expect(requested.outcome).toEqual({ ok: true });expect(requested.state.phase).toBe("ACTION");
    expect(requested.state.currentSeatId).toBeNull();expect(requested.state.requests[0]!.status).toBe("PENDING");
    expect(requested.state.deadlineAt).toBe(new Date(46_000).toISOString());
    const early = advanceSystem(requested.state, { actorId: "SYSTEM", nowMs: 45_999, drawResult: 0 });
    expect(early.state).toEqual(requested.state);expect(early.events).toEqual([]);
    const expired = advanceSystem(requested.state, { actorId: "SYSTEM", nowMs: 46_000, drawResult: 0 });
    expect(expired.state.phase).toBe("BETTING");expect((expired.state as EngineState).requests[0]!.status).toBe("EXPIRED");
    expect(expiryIds(expired.events)).toEqual(["last-request"]);
    expect(expired.state.players).toEqual(requested.state.players);expect((expired.state as EngineState).privateLoans).toEqual([]);
  });

  it("T22 tail_requests_use_earliest_deadline: three players wait until 46000 then 47000 and expire only each due request", () => {
    const ended = send(action(3), "END_ACTION", "p1", {}, 0);
    expect(ended.outcome).toEqual({ ok: true });
    const first = request(ended.state, "p2", "p1", "tail-a", 1_000);
    expect(first.outcome).toEqual({ ok: true });expect(first.state.currentSeatId).toBe(3);
    const last = request(first.state, "p3", "p1", "tail-b", 2_000, 700);
    expect(last.outcome).toEqual({ ok: true });expect(last.state.phase).toBe("ACTION");
    expect(last.state.currentSeatId).toBeNull();expect(last.state.actedSeats).toEqual([1, 2, 3]);
    expect(last.state.requests.map(r => [r.requestId, r.status, r.deadlineMs])).toEqual([
      ["tail-a", "PENDING", 46_000], ["tail-b", "PENDING", 47_000],
    ]);
    expect(last.state.deadlineAt).toBe(new Date(46_000).toISOString());expect(last.state.windowDeadlineMs).toBe(46_000);
    const waiting = advanceSystem(last.state, { actorId: "SYSTEM", nowMs: 3_000, drawResult: 0 });
    expect(waiting.state).toEqual(last.state);expect(waiting.events).toEqual([]);
    const firstExpiry = advanceSystem(last.state, { actorId: "SYSTEM", nowMs: 46_000, drawResult: 0 });
    expect(firstExpiry.state.phase).toBe("ACTION");expect((firstExpiry.state as EngineState).currentSeatId).toBeNull();
    expect((firstExpiry.state as EngineState).requests.map(r => r.status)).toEqual(["EXPIRED", "PENDING"]);
    expect(expiryIds(firstExpiry.events)).toEqual(["tail-a"]);
    expect(firstExpiry.state.deadlineAt).toBe(new Date(47_000).toISOString());expect((firstExpiry.state as EngineState).windowDeadlineMs).toBe(47_000);
    const stillWaiting = advanceSystem(firstExpiry.state, { actorId: "SYSTEM", nowMs: 46_500, drawResult: 0 });
    expect(stillWaiting.state).toEqual(firstExpiry.state);expect(stillWaiting.events).toEqual([]);
    const lastExpiry = advanceSystem(firstExpiry.state, { actorId: "SYSTEM", nowMs: 47_000, drawResult: 0 });
    expect(lastExpiry.state.phase).toBe("BETTING");
    expect((lastExpiry.state as EngineState).requests.map(r => r.status)).toEqual(["EXPIRED", "EXPIRED"]);
    expect(expiryIds(lastExpiry.events)).toEqual(["tail-b"]);
    expect(lastExpiry.state.players).toEqual(last.state.players);expect((lastExpiry.state as EngineState).privateLoans).toEqual([]);
  });
});
