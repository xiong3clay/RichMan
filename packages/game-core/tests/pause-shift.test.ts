import { describe, expect, it } from "vitest";
import { advanceSystem, applyCommand, createInitialState, shiftDeadlinesForPause } from "../src/engine.js";
import type { EngineState } from "../src/engine.js";
import type { LoanRequestStatus } from "../src/private-loans.js";

const config = { timerMode: "standard" as const, privateDebtAffectsBankLoan: false };
const DATE_LIMIT_MS = 8_640_000_000_000_000;

function initial(): EngineState {
  return createInitialState("pause-shift", config, [{ nickname: "借款人" }, { nickname: "出借人" }]);
}

function send(state: EngineState, type: string, actorId: string, payload: Record<string, unknown>, nowMs: number) {
  const result = applyCommand(state, {
    protocolVersion: 1,
    gameId: state.gameId,
    commandId: `${type}-${nowMs}`,
    type,
    payload,
  }, { actorId, nowMs, drawResult: 0 });
  return { ...result, state: result.state as EngineState };
}

function requestedState(): EngineState {
  const action = advanceSystem(initial(), { actorId: "SYSTEM", nowMs: 0, drawResult: 0 }).state as EngineState;
  const requested = send(action, "REQUEST_PRIVATE_LOAN", "p1", {
    requestId: "first", lenderId: "p2", principalCents: 500, rateBps: 1_000,
  }, 1_000);
  expect(requested.outcome).toEqual({ ok: true });
  return requested.state;
}

function refusedRescue(): EngineState {
  const state = initial();
  state.phase = "TAX";
  state.round = 3;
  state.taxSeats = [1, 2];
  state.players[0]!.cents = 500;
  const danger = advanceSystem(state, { actorId: "SYSTEM", nowMs: 0, drawResult: 0 }).state as EngineState;
  expect(danger.dangerSeatId).toBe(1);
  const requested = send(danger, "REQUEST_PRIVATE_LOAN", "p1", {
    requestId: "rescue-first", lenderId: "p2", principalCents: 500, rateBps: 1_000,
  }, 1_000);
  expect(requested.outcome).toEqual({ ok: true });
  const refused = send(requested.state, "REFUSE_PRIVATE_LOAN", "p2", { requestId: "rescue-first" }, 1_100);
  expect(refused.outcome).toEqual({ ok: true });
  expect(refused.state.requests[0]!.status).toBe("REFUSED");
  return refused.state;
}

describe("pause shift N4 request creation timeline", () => {
  it("N4 all_request_creation_times_shift: every request status retains its relative creation time", () => {
    const state = requestedState();
    const statuses: LoanRequestStatus[] = ["PENDING", "ACCEPTED", "REFUSED", "CANCELLED", "EXPIRED", "FAILED"];
    state.requests = statuses.map((status, index) => ({
      ...state.requests[0]!, requestId: `request-${status}`, status,
      createdAtMs: 1_000 - index, deadlineMs: 46_000 - index,
    }));
    const before = structuredClone(state);
    const shifted = shiftDeadlinesForPause(state, 100_000);

    expect(shifted.requests).toEqual(before.requests.map(request => ({
      ...request,
      createdAtMs: request.createdAtMs + 100_000,
      deadlineMs: request.status === "PENDING" ? request.deadlineMs + 100_000 : request.deadlineMs,
    })));
    expect(shifted.version).toBe(before.version + 1);
    expect(shifted.eventSeq).toBe(before.eventSeq);
    expect(shifted.players).toEqual(before.players);
    expect(state).toEqual(before);
  });

  it("N4 refused_rescue_keeps_two_second_interval: pausing cannot bypass the latest closed request's cooldown", () => {
    const before = refusedRescue();
    const copy = structuredClone(before);
    const shifted = shiftDeadlinesForPause(before, 100_000);
    const tooEarly = send(shifted, "REQUEST_PRIVATE_LOAN", "p1", {
      requestId: "rescue-too-early", lenderId: "p2", principalCents: 500, rateBps: 1_000,
    }, 102_999);
    expect(tooEarly.outcome).toMatchObject({ ok: false, code: "INVALID_ACTION", message: "请求间隔不足 2 秒" });
    expect(tooEarly.state).toEqual(shifted);
    expect(tooEarly.events).toEqual([]);

    const atBoundary = send(shifted, "REQUEST_PRIVATE_LOAN", "p1", {
      requestId: "rescue-at-boundary", lenderId: "p2", principalCents: 500, rateBps: 1_000,
    }, 103_000);
    expect(atBoundary.outcome).toEqual({ ok: true });
    expect(atBoundary.state.requests.map(request => request.status)).toEqual(["REFUSED", "PENDING"]);
    expect(atBoundary.state.pendingRequestId).toBe("rescue-at-boundary");
    expect(atBoundary.state.dangerDeadlineMs).toBe(160_000);
    expect(before).toEqual(copy);
  });
});

type InvalidTimeCase = {
  name: string;
  update: (state: EngineState) => void;
};

const invalidTimes: InvalidTimeCase[] = [
  { name: "window_safe_integer_overflow", update: state => { state.windowDeadlineMs = Number.MAX_SAFE_INTEGER - 1; } },
  { name: "window_date_range_overflow", update: state => { state.windowDeadlineMs = DATE_LIMIT_MS - 1; } },
  { name: "danger_safe_integer_overflow", update: state => { state.dangerDeadlineMs = Number.MAX_SAFE_INTEGER - 1; } },
  { name: "danger_date_range_overflow", update: state => { state.dangerDeadlineMs = DATE_LIMIT_MS - 1; } },
  { name: "pending_deadline_safe_integer_overflow", update: state => { state.requests[0]!.deadlineMs = Number.MAX_SAFE_INTEGER - 1; } },
  { name: "pending_deadline_date_range_overflow", update: state => { state.requests[0]!.deadlineMs = DATE_LIMIT_MS - 1; } },
  { name: "pending_creation_safe_integer_overflow", update: state => { state.requests[0]!.createdAtMs = Number.MAX_SAFE_INTEGER - 1; } },
  { name: "closed_creation_date_range_overflow", update: state => {
    state.requests[0]!.status = "REFUSED";
    state.requests[0]!.createdAtMs = DATE_LIMIT_MS - 1;
  } },
];

describe("pause shift N6 arithmetic validation", () => {
  it.each(invalidTimes)("N6 $name rejects without changing the input", ({ update }) => {
    const state = requestedState();
    update(state);
    const before = structuredClone(state);
    expect(() => shiftDeadlinesForPause(state, 2)).toThrow();
    expect(state).toEqual(before);
  });

  it("N6 version_overflow rejects before publishing an unsafe version", () => {
    const state = requestedState();
    state.version = Number.MAX_SAFE_INTEGER;
    const before = structuredClone(state);
    expect(() => shiftDeadlinesForPause(state, 1)).toThrow();
    expect(state).toEqual(before);
  });

  it("N6 date_boundary_is_valid accepts the last representable Date and keeps its ISO synchronized", () => {
    const state = requestedState();
    state.windowDeadlineMs = DATE_LIMIT_MS - 10;
    state.deadlineAt = new Date(state.windowDeadlineMs).toISOString();
    state.dangerDeadlineMs = DATE_LIMIT_MS - 10;
    state.requests[0]!.deadlineMs = DATE_LIMIT_MS - 10;
    state.requests[0]!.createdAtMs = DATE_LIMIT_MS - 20;
    state.version = Number.MAX_SAFE_INTEGER - 1;

    const shifted = shiftDeadlinesForPause(state, 10);
    expect(shifted.windowDeadlineMs).toBe(DATE_LIMIT_MS);
    expect(shifted.dangerDeadlineMs).toBe(DATE_LIMIT_MS);
    expect(shifted.deadlineAt).toBe(new Date(DATE_LIMIT_MS).toISOString());
    expect(shifted.requests[0]!.deadlineMs).toBe(DATE_LIMIT_MS);
    expect(shifted.requests[0]!.createdAtMs).toBe(DATE_LIMIT_MS - 10);
    expect(shifted.version).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("N6 invalid_pause_duration keeps the existing no-op contract", () => {
    const state = requestedState();
    for (const pausedMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(shiftDeadlinesForPause(state, pausedMs)).toBe(state);
    }
  });
});
