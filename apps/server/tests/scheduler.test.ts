import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { advanceSystem, applyCommand, createInitialState } from "@richman/game-core";
import type { EngineState } from "@richman/game-core";
import type { TransitionResult } from "@richman/shared";
import { RoomCommandQueue } from "../src/rooms/command-queue.js";
import { RoomScheduler } from "../src/rooms/scheduler.js";

const config = { timerMode: "standard" as const, privateDebtAffectsBankLoan: false };

function initial(gameId = "g1"): EngineState {
  return createInitialState(gameId, config, [{ nickname: "甲" }, { nickname: "乙" }]);
}

function acting(gameId = "g1"): EngineState {
  return advanceSystem(initial(gameId), { actorId: "SYSTEM", nowMs: 0, drawResult: 0 }).state as EngineState;
}

function endAction(state: EngineState, actorId: string, nowMs: number): EngineState {
  const result = applyCommand(state, {
    protocolVersion: 1,
    gameId: state.gameId,
    commandId: `end-${actorId}-${nowMs}`,
    type: "END_ACTION",
    payload: {},
  }, { actorId, nowMs, drawResult: 0 });
  expect(result.outcome.ok).toBe(true);
  return result.state as EngineState;
}

function harness(states: Record<string, EngineState>, draw: () => 0 | 1 = () => 0) {
  const rooms = new Map(Object.entries(states));
  const commits: Array<{ roomCode: string; result: TransitionResult }> = [];
  const queue = new RoomCommandQueue();
  const scheduler = new RoomScheduler({
    queue,
    now: () => Date.now(),
    draw,
    getState: (roomCode) => rooms.get(roomCode) ?? null,
    commit: (roomCode, result) => {
      commits.push({ roomCode, result });
      rooms.set(roomCode, result.state as EngineState);
      // Production commits also schedule their new deadline while the current
      // queued wakeup may still be catching up earlier windows.
      scheduler.schedule(roomCode);
    },
  });
  schedulers.push(scheduler);
  return { scheduler, queue, rooms, commits };
}

const schedulers: RoomScheduler[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  for (const scheduler of schedulers.splice(0)) scheduler.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("room_scheduler", () => {
  it("initializes INTEREST with no deadline without a client command", async () => {
    const { scheduler, rooms, commits } = harness({ "0042": initial() });
    scheduler.schedule("0042");
    await vi.advanceTimersByTimeAsync(0);

    expect(rooms.get("0042")).toMatchObject({ phase: "ACTION", currentSeatId: 1, version: 1 });
    expect(rooms.get("0042")?.deadlineAt).toBe("1970-01-01T00:01:00.000Z");
    expect(commits).toHaveLength(1);
    expect(commits[0]?.result.events.map((event) => event.type)).toContain("PHASE_CHANGED");
  });

  it("advances exactly at the deadline, never early, then arms the next seat", async () => {
    const { scheduler, rooms, commits } = harness({ "0042": acting() });
    scheduler.schedule("0042");
    await vi.advanceTimersByTimeAsync(59_999);
    expect(commits).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(rooms.get("0042")).toMatchObject({ currentSeatId: 2, version: 2 });
    expect(commits).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(rooms.get("0042")?.phase).toBe("BETTING");
    expect(commits).toHaveLength(2);
  });

  it("late deadlines catch up each expired window with one commit per engine version", async () => {
    const draw = vi.fn(() => 1 as const);
    const { scheduler, rooms, commits } = harness({ "0042": acting() }, draw);
    vi.setSystemTime(200_000);
    await scheduler.advanceDue("0042");

    expect(rooms.get("0042")).toMatchObject({ round: 2, phase: "ACTION", currentSeatId: 1, version: 4 });
    expect(rooms.get("0042")?.deadlineAt).toBe("1970-01-01T00:03:45.000Z");
    expect(commits.map(({ result }) => result.state.version)).toEqual([2, 3, 4]);
    const events = commits.flatMap(({ result }) => result.events);
    expect(events.filter((event) => event.type === "ACTION_TIMEOUT").map((event) => event.at))
      .toEqual(["1970-01-01T00:01:00.000Z", "1970-01-01T00:02:00.000Z"]);
    expect(events.filter((event) => event.type === "BET_SETTLED")).toHaveLength(1);
    expect(draw).toHaveBeenCalledTimes(1);
  });

  it("stale_timer_ignored: replaced deadline within the same ACTION instance cannot time out the next seat", async () => {
    const timerSpy = vi.spyOn(globalThis, "setTimeout");
    const { scheduler, rooms, commits, queue } = harness({ "0042": acting() });
    scheduler.schedule("0042");
    expect(timerSpy.mock.calls[0]?.[0]).toBeTypeOf("function");
    const oldCallback = timerSpy.mock.calls[0]![0] as () => void;

    const before = rooms.get("0042")!;
    rooms.set("0042", endAction(before, "p1", 10_000));
    expect(rooms.get("0042")?.phaseInstanceId).toBe(before.phaseInstanceId);
    scheduler.schedule("0042");
    vi.setSystemTime(70_000);
    oldCallback();
    await queue.run("0042", () => undefined);

    expect(commits).toHaveLength(0);
    expect(rooms.get("0042")?.currentSeatId).toBe(2);
    await scheduler.advanceDue("0042");
    expect(rooms.get("0042")?.phase).toBe("BETTING");
    expect(commits).toHaveLength(1);
  });

  it("stale_timer_ignored: validates after queue wait and ignores duplicate callback", async () => {
    const timerSpy = vi.spyOn(globalThis, "setTimeout");
    const { scheduler, rooms, commits, queue } = harness({ "0042": acting() });
    let release!: () => void;
    const blocked = queue.run("0042", () => new Promise<void>((resolve) => { release = resolve; }));
    await Promise.resolve();
    scheduler.schedule("0042");
    expect(timerSpy.mock.calls[0]?.[0]).toBeTypeOf("function");
    const oldCallback = timerSpy.mock.calls[0]![0] as () => void;
    vi.setSystemTime(60_000);
    oldCallback();
    oldCallback();

    rooms.set("0042", endAction(endAction(rooms.get("0042")!, "p1", 1_000), "p2", 2_000));
    scheduler.schedule("0042");
    release();
    await blocked;
    await queue.run("0042", () => undefined);
    expect(commits).toHaveLength(0);
    expect(rooms.get("0042")?.phase).toBe("BETTING");

    await scheduler.advanceDue("0042");
    await scheduler.advanceDue("0042");
    expect(commits).toHaveLength(1);
    expect(commits.flatMap(({ result }) => result.events).filter((event) => event.type === "BET_SETTLED"))
      .toHaveLength(1);
  });

  it("keeps room timers isolated while another room queue is blocked", async () => {
    const { scheduler, rooms, commits, queue } = harness({ "0042": acting("g1"), "0043": acting("g2") });
    let release!: () => void;
    const blocked = queue.run("0042", () => new Promise<void>((resolve) => { release = resolve; }));
    await Promise.resolve();
    scheduler.schedule("0042");
    scheduler.schedule("0043");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(rooms.get("0042")?.currentSeatId).toBe(1);
    expect(rooms.get("0043")?.currentSeatId).toBe(2);
    expect(commits.map(({ roomCode }) => roomCode)).toEqual(["0043"]);
    release();
    await blocked;
    await queue.run("0042", () => undefined);
    expect(rooms.get("0042")?.currentSeatId).toBe(2);
  });

  it("advanceDue can run inside the room queue without enqueueing itself", async () => {
    const { scheduler, rooms, queue } = harness({ "0042": acting() });
    vi.setSystemTime(60_000);
    await queue.run("0042", () => scheduler.advanceDue("0042"));
    expect(rooms.get("0042")?.currentSeatId).toBe(2);
  });

  it("only requests a draw when an expired BETTING phase settles, preserving real balances", async () => {
    const draw = vi.fn(() => 1 as const);
    const betting = endAction(endAction(acting(), "p1", 0), "p2", 0);
    const locked = applyCommand(betting, {
      protocolVersion: 1, gameId: "g1", commandId: "bet-1", type: "SUBMIT_BET",
      payload: { betCents: 500, guess: 1, leverage: 1 },
    }, { actorId: "p1", nowMs: 1, drawResult: 0 }).state as EngineState;
    const { scheduler, rooms, commits } = harness({ "0042": locked }, draw);
    await scheduler.advanceDue("0042");
    expect(draw).not.toHaveBeenCalled();
    vi.setSystemTime(45_000);
    await scheduler.advanceDue("0042");
    expect(draw).toHaveBeenCalledTimes(1);
    expect(rooms.get("0042")?.players.map((player) => player.cents)).toEqual([10_500, 10_000]);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.result.events.some((event) => event.type === "BET_SETTLED")).toBe(true);
  });

  it("close clears timers and invalidates callbacks already waiting in the queue", async () => {
    const timerSpy = vi.spyOn(globalThis, "setTimeout");
    const { scheduler, commits, queue } = harness({ "0042": acting() });
    let release!: () => void;
    const blocked = queue.run("0042", () => new Promise<void>((resolve) => { release = resolve; }));
    await Promise.resolve();
    scheduler.schedule("0042");
    expect(timerSpy.mock.calls[0]?.[0]).toBeTypeOf("function");
    const callback = timerSpy.mock.calls[0]![0] as () => void;
    vi.setSystemTime(60_000);
    callback();
    scheduler.close();
    release();
    await blocked;
    await queue.run("0042", () => undefined);
    scheduler.schedule("0042");
    await scheduler.advanceDue("0042");
    expect(commits).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
