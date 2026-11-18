import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { advanceSystem, applyCommand, createInitialState, shiftDeadlinesForPause } from "@richman/game-core";
import type { EngineState } from "@richman/game-core";
import { RoomManager } from "../src/rooms/manager.js";
import { RoomCommandQueue, GameCommandProcessor } from "../src/rooms/command-queue.js";
import { RoomScheduler } from "../src/rooms/scheduler.js";

const config = { timerMode: "standard" as const, privateDebtAffectsBankLoan: false };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
});

function actionState(): EngineState {
  return advanceSystem(createInitialState("g1", config, [{ nickname: "AI" }, { nickname: "人" }]),
    { actorId: "SYSTEM", nowMs: 0, drawResult: 0 }).state as EngineState;
}

function bettingState(): EngineState {
  let state = actionState();
  for (const seat of [1, 2]) {
    state = applyCommand(state, {
      protocolVersion: 1, gameId: state.gameId, commandId: "end-" + String(seat),
      type: "END_ACTION", payload: {}, expectedGameVersion: state.version,
    }, { actorId: "p" + String(seat), nowMs: 0, drawResult: 0 }).state as EngineState;
  }
  return state;
}

function dangerState(): EngineState {
  const state = { ...structuredClone(actionState()) } as EngineState;
  state.round = 3;
  state.phase = "TAX";
  state.phaseInstanceId = "round3-tax-danger";
  state.currentSeatId = null;
  state.pendingRequestId = null;
  state.pendingDueLoanId = null;
  state.dangerSeatId = 1;
  state.dangerDeadlineMs = 60_000;
  state.windowDeadlineMs = 60_000;
  state.deadlineAt = new Date(60_000).toISOString();
  state.players[0]!.cents = -500;
  return state;
}

describe("P0-1 shiftDeadlinesForPause 纯函数", () => {
  it("窗口/危险/请求时间整体平移，version+1 且不发事件", () => {
    const state = dangerState();
    state.requests = [{
      requestId: "req-1", borrowerId: "p1", lenderId: "p2", principalCents: 500, rateBps: 1_000,
      createdRound: 3, createdAtMs: 1_000, deadlineMs: 45_000, status: "PENDING",
      borrowerCredit: "GOOD", borrowerDefaultedBankDebtCents: 0,
    }];
    const beforeSeq = state.eventSeq;
    const shifted = shiftDeadlinesForPause(state, 99_000);
    expect(shifted.windowDeadlineMs).toBe(159_000);
    expect(shifted.dangerDeadlineMs).toBe(159_000);
    expect(shifted.deadlineAt).toBe(new Date(159_000).toISOString());
    expect(shifted.requests[0]!.deadlineMs).toBe(144_000);
    expect(shifted.requests[0]!.createdAtMs).toBe(100_000);
    expect(shifted.version).toBe(state.version + 1);
    expect(shifted.eventSeq).toBe(beforeSeq);
    // 原状态不被修改。
    expect(state.windowDeadlineMs).toBe(60_000);
  });

  it("pausedMs 非正/非安全整数时原样返回", () => {
    const state = dangerState();
    expect(shiftDeadlinesForPause(state, 0)).toBe(state);
    expect(shiftDeadlinesForPause(state, -1)).toBe(state);
    expect(shiftDeadlinesForPause(state, 1.5)).toBe(state);
    expect(shiftDeadlinesForPause(state, Number.NaN)).toBe(state);
  });

  it("ACTION 离线超过原截止时间，平移后不会被立即超时", () => {
    const state = actionState();
    const shifted = shiftDeadlinesForPause(state, 99_000);
    const result = advanceSystem(shifted, { actorId: "SYSTEM", nowMs: 100_000, drawResult: 0 });
    expect(result.state.phase).toBe("ACTION");
    expect(result.state.version).toBe(shifted.version);
  });

  it("BETTING 平移后不会按 0 注立即结算", () => {
    const state = bettingState();
    expect(state.phase).toBe("BETTING");
    const shifted = shiftDeadlinesForPause(state, 99_000);
    const result = advanceSystem(shifted, { actorId: "SYSTEM", nowMs: 100_000, drawResult: 0 });
    expect(result.state.phase).toBe("BETTING");
    expect(result.state.version).toBe(shifted.version);
  });

  it("TAX 危险平移后不会立即破产", () => {
    const state = dangerState();
    const shifted = shiftDeadlinesForPause(state, 99_000);
    const result = advanceSystem(shifted, { actorId: "SYSTEM", nowMs: 100_000, drawResult: 0 });
    expect(result.state.phase).toBe("TAX");
    expect(result.state.players[0]!.alive).toBe(true);
    expect(result.state.version).toBe(shifted.version);
  });
});

describe("P0-1 房间队列内的 resumeFromPause", () => {
  it("先平移后清暂停；重连后 scheduler 不会补算过期 ACTION 超时", async () => {
    let nowMs = 1_000;
    const manager = new RoomManager({
      generateRoomCode: () => "3030",
      generateGameId: () => "g-resume",
      generateToken: () => "human-token",
      now: () => nowMs,
    });
    const code = manager.createRoom(1);
    const human = manager.join(code, "人类");
    manager.setReadyFor(code, human.playerId, true);
    manager.startFor(code, human.playerId);
    // 模拟 ws 的开局推进：INTEREST → ACTION，p1 是当前座，deadline=60s。
    Object.assign(manager.getGame(code)!, advanceSystem(manager.getGame(code)!, {
      actorId: "SYSTEM", nowMs: 0, drawResult: 0,
    }).state);
    const originalDeadline = manager.getGame(code)!.windowDeadlineMs!;
    manager.disconnectFor(code, human.playerId);
    expect(manager.getPauseSince(code)).toBe(1_000);

    nowMs = 100_000;
    const queue = new RoomCommandQueue();
    const scheduler = new RoomScheduler({
      queue, getState: (room) => manager.isPaused(room) || manager.isNoHumanOnline(room) ? null : manager.getGame(room),
      commit: async (room, result) => { await manager.commitTransition(room, result); },
      now: () => nowMs,
    });
    const processor = new GameCommandProcessor({
      queue,
      getState: (room) => manager.getGame(room),
      commit: async (room, result) => { await manager.commitTransition(room, result); },
      advance: async (room) => { await scheduler.advanceDue(room); },
      now: () => nowMs,
      pauseSince: (room) => manager.getPauseSince(room),
      markPauseShifted: (room) => manager.markPauseShifted(room),
    });

    const shifted = await processor.resumeFromPause(code);
    expect(shifted).toBe(true);
    expect(manager.getPauseSince(code)).toBeNull();
    // 还没上线：仍保持暂停。
    expect(manager.isNoHumanOnline(code)).toBe(true);
    const state = manager.getGame(code)!;
    expect(state.windowDeadlineMs).toBe(originalDeadline + 99_000);
    expect(state.version).toBeGreaterThan(1);

    // 真人上线后再推进：剩余时间与暂停那一刻一致，不触发 ACTION_TIMEOUT。
    manager.restoreIdentity(code, human.playerId, "new-token");
    expect(manager.isNoHumanOnline(code)).toBe(false);
    const versionBefore = state.version;
    scheduler.schedule(code);
    await scheduler.advanceDue(code);
    expect(manager.getGame(code)!.phase).toBe("ACTION");
    expect(manager.getGame(code)!.version).toBe(versionBefore);
    scheduler.close();
  });

  it("提交失败时房间保持暂停并抛出，调用方可以拒绝重连快进", async () => {
    let nowMs = 1_000;
    const manager = new RoomManager({
      generateRoomCode: () => "3131",
      generateGameId: () => "g-fail",
      generateToken: () => "human-token",
      now: () => nowMs,
    });
    const code = manager.createRoom(1);
    const human = manager.join(code, "人类");
    manager.setReadyFor(code, human.playerId, true);
    manager.startFor(code, human.playerId);
    Object.assign(manager.getGame(code)!, advanceSystem(manager.getGame(code)!, {
      actorId: "SYSTEM", nowMs: 0, drawResult: 0,
    }).state);
    manager.disconnectFor(code, human.playerId);
    nowMs = 100_000;

    const queue = new RoomCommandQueue();
    let shifted = false;
    const processor = new GameCommandProcessor({
      queue,
      getState: (room) => manager.getGame(room),
      commit: async () => { throw new Error("disk full"); },
      advance: async () => undefined,
      now: () => nowMs,
      pauseSince: (room) => manager.getPauseSince(room),
      markPauseShifted: () => { shifted = true; },
    });
    await expect(processor.resumeFromPause(code)).rejects.toThrow("disk full");
    expect(shifted).toBe(false);
    expect(manager.isNoHumanOnline(code)).toBe(true);
    expect(manager.getPauseSince(code)).toBe(1_000);
  });

  it("P2-13 processor 的 isPaused 包含无真人在线：暂停时拒绝新命令", async () => {
    let nowMs = 0;
    const manager = new RoomManager({
      generateRoomCode: () => "3232",
      generateGameId: () => "g-pause",
      generateToken: () => "human-token",
      now: () => nowMs,
    });
    const code = manager.createRoom(1);
    const human = manager.join(code, "人类");
    manager.setReadyFor(code, human.playerId, true);
    manager.startFor(code, human.playerId);
    Object.assign(manager.getGame(code)!, advanceSystem(manager.getGame(code)!, {
      actorId: "SYSTEM", nowMs: 0, drawResult: 0,
    }).state);
    manager.disconnectFor(code, human.playerId);
    expect(manager.isNoHumanOnline(code)).toBe(true);

    const queue = new RoomCommandQueue();
    const processor = new GameCommandProcessor({
      queue,
      getState: (room) => manager.getGame(room),
      commit: async (room, result) => { await manager.commitTransition(room, result); },
      advance: async () => undefined,
      now: () => nowMs,
      isPaused: (room) => manager.isPaused(room) || manager.isNoHumanOnline(room),
    });
    const state = manager.getGame(code)!;
    const reply = await processor.execute(code, "p1", {
      protocolVersion: 1, gameId: state.gameId, commandId: "pause-1",
      type: "END_ACTION", payload: {}, expectedGameVersion: state.version,
    });
    expect(reply.outcome).toMatchObject({ ok: false, code: "ERROR_PAUSED" });
    expect(manager.getGame(code)!.version).toBe(state.version);
  });
});
