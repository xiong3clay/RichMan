import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { advanceSystem, applyCommand, createInitialState } from "@richman/game-core";
import type { EngineState } from "@richman/game-core";
import { CREDIT } from "@richman/shared";
import type { RoomManager } from "../src/rooms/manager.js";
import { BotDriver } from "../src/bots/driver.js";
import type { BotCommandReply } from "../src/bots/driver.js";

const config = { timerMode: "standard" as const, privateDebtAffectsBankLoan: false };
const cleanups: Array<() => void> = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});

function actionWithRequest(): EngineState {
  const state = advanceSystem(
    createInitialState("g-old", config, [{ nickname: "A" }, { nickname: "B" }, { nickname: "C" }]),
    { actorId: "SYSTEM", nowMs: 0, drawResult: 0 },
  ).state as EngineState;
  state.requests = [{
    requestId: "req-1", borrowerId: "p3", lenderId: "p2", principalCents: 400, rateBps: 1_000,
    createdRound: 1, createdAtMs: 0, deadlineMs: 45_000, status: "PENDING",
    borrowerCredit: CREDIT.GOOD, borrowerDefaultedBankDebtCents: 0,
  }];
  return state;
}

describe("A1 并发提交：AI 当前动作失败后重试", () => {
  it("ACCEPT 先提交造成 VERSION_CONFLICT，END_ACTION 仍会重试成功", async () => {
    let state = actionWithRequest();
    const room = {
      state: "PLAYING",
      paused: false,
      players: [
        { playerId: "p1", seatId: 1, isBot: true, botPersonality: "PASSIVE" },
        { playerId: "p2", seatId: 2, isBot: true, botPersonality: "PASSIVE" },
        { playerId: "p3", seatId: 3, isBot: false, online: true },
      ],
    };
    const manager = {
      getRoom: () => room,
      getGame: () => state,
      isNoHumanOnline: () => false,
    } as unknown as RoomManager;

    const events: string[] = [];
    let conflictOnce = true;
    const driver = new BotDriver({
      manager,
      execute: async (_room, botId, command): Promise<BotCommandReply> => {
        if (command.type === "END_ACTION" && botId === "p1" && conflictOnce) {
          conflictOnce = false;
          events.push("conflict:p1");
          return { outcome: { ok: false, code: "VERSION_CONFLICT" } };
        }
        const result = applyCommand(state, command, { actorId: botId, nowMs: 0, drawResult: 0 });
        if (!result.outcome.ok) {
          events.push("fail:" + command.type + ":" + String(result.outcome.code));
          return { outcome: result.outcome };
        }
        state = result.state as EngineState;
        events.push("ok:" + botId + ":" + command.type);
        return { outcome: { ok: true } };
      },
      now: () => Date.now(),
      rng: () => 0,
      delayMs: () => 0,
      retryDelayMs: () => 150,
      onError: (error) => { throw error; },
      onWarn: () => undefined,
    });
    cleanups.push(() => driver.close());

    driver.notify("0042");
    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    await Promise.resolve();
    // 第一轮：p2 的 ACCEPT 提交，p1 的 END_ACTION 收到一次版本冲突。
    expect(events).toContain("ok:p2:ACCEPT_PRIVATE_LOAN");
    expect(events).toContain("conflict:p1");
    expect(events).not.toContain("ok:p1:END_ACTION");

    // 150ms 后重试 tick 重新决策，p1 仍是当前行动席，这次提交成功。
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toContain("ok:p1:END_ACTION");
    expect(state.actedSeats).toContain(1);
    expect(events.filter((event) => event.startsWith("fail:"))).toEqual([]);
  });

  it("重试超过 3 次后放弃并记 warn，不无限重试", async () => {
    const state = actionWithRequest();
    const room = {
      state: "PLAYING",
      paused: false,
      players: [{ playerId: "p1", seatId: 1, isBot: true }],
    };
    let calls = 0;
    const warnings: string[] = [];
    const driver = new BotDriver({
      manager: { getRoom: () => room, getGame: () => state, isNoHumanOnline: () => false } as unknown as RoomManager,
      execute: async () => {
        calls += 1;
        return { outcome: { ok: false, code: "VERSION_CONFLICT" } };
      },
      now: () => Date.now(),
      rng: () => 0,
      delayMs: () => 0,
      retryDelayMs: () => 100,
      onError: (error) => { throw error; },
      onWarn: (message) => { warnings.push(message); },
    });
    cleanups.push(() => driver.close());

    driver.notify("0042");
    await vi.advanceTimersByTimeAsync(2_000);
    await Promise.resolve();
    // 首次 + 3 次重试 = 4 次，之后放弃。
    expect(calls).toBe(4);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("VERSION_CONFLICT");
  });
});

describe("A2 旧 timer 跨局/跨阶段必须丢弃", () => {
  function bettingState(gameId = "g-old", phaseInstanceId = "round1-betting-2"): EngineState {
    const state = createInitialState(gameId, config, [{ nickname: "AI" }, { nickname: "人" }]);
    state.phase = "BETTING";
    state.phaseInstanceId = phaseInstanceId;
    state.round = 1;
    state.version = 5;
    state.deadlineAt = new Date(45_000).toISOString();
    state.windowDeadlineMs = 45_000;
    return state;
  }

  it("换局（rematch）后旧 draft 不会提交到新局", async () => {
    let state = bettingState();
    const room = {
      state: "PLAYING", paused: false,
      players: [{ playerId: "p1", seatId: 1, isBot: true }],
    };
    const commands: string[] = [];
    const driver = new BotDriver({
      manager: { getRoom: () => room, getGame: () => state, isNoHumanOnline: () => false } as unknown as RoomManager,
      execute: async (_room, _bot, command) => { commands.push(command.gameId); return { outcome: { ok: true } }; },
      now: () => Date.now(),
      rng: () => 0.9,
      delayMs: () => 100,
    });
    cleanups.push(() => driver.close());

    driver.notify("0042");
    await vi.advanceTimersByTimeAsync(50);
    // 新局复用同样的 round/phaseInstance 字符串，仅 gameId 不同。
    state = bettingState("g-new", "round1-betting-2");
    await vi.advanceTimersByTimeAsync(100);
    expect(commands).toEqual([]);
  });

  it("阶段切换后旧 SUBMIT_BET 不会提交", async () => {
    let state = bettingState();
    const room = {
      state: "PLAYING", paused: false,
      players: [{ playerId: "p1", seatId: 1, isBot: true }],
    };
    const commands: string[] = [];
    const driver = new BotDriver({
      manager: { getRoom: () => room, getGame: () => state, isNoHumanOnline: () => false } as unknown as RoomManager,
      execute: async (_room, _bot, command) => { commands.push(command.type); return { outcome: { ok: true } }; },
      now: () => Date.now(),
      rng: () => 0.9,
      delayMs: () => 100,
    });
    cleanups.push(() => driver.close());

    driver.notify("0042");
    await vi.advanceTimersByTimeAsync(50);
    state = bettingState("g-old", "round1-betting-99");
    await vi.advanceTimersByTimeAsync(100);
    expect(commands).toEqual([]);
  });
});

describe("P2-3 可重试白名单", () => {
  function bettingRoomState(): EngineState {
    const state = createInitialState("g-retry", config, [{ nickname: "AI" }, { nickname: "人" }]);
    state.phase = "BETTING";
    state.phaseInstanceId = "round1-betting-7";
    state.round = 1;
    state.deadlineAt = new Date(45_000).toISOString();
    state.windowDeadlineMs = 45_000;
    return state;
  }
  const room = { state: "PLAYING", paused: false, players: [{ playerId: "p1", seatId: 1, isBot: true }] };

  it("ERROR_PAUSED 重试后成功，不 markDriven 放弃", async () => {
    const state = bettingRoomState();
    let calls = 0;
    const driver = new BotDriver({
      manager: { getRoom: () => room, getGame: () => state, isNoHumanOnline: () => false } as unknown as RoomManager,
      execute: async () => {
        calls += 1;
        return calls === 1 ? { outcome: { ok: false, code: "ERROR_PAUSED" } } : { outcome: { ok: true } };
      },
      now: () => Date.now(),
      rng: () => 0.9,
      delayMs: () => 0,
      retryDelayMs: () => 100,
    });
    cleanups.push(() => driver.close());
    driver.notify("0042");
    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();
    expect(calls).toBe(2);
  });

  it("REQUEST_EXPIRED 这类确定性非法命令不重试", async () => {
    const state = bettingRoomState();
    let calls = 0;
    const warnings: string[] = [];
    const driver = new BotDriver({
      manager: { getRoom: () => room, getGame: () => state, isNoHumanOnline: () => false } as unknown as RoomManager,
      execute: async () => { calls += 1; return { outcome: { ok: false, code: "REQUEST_EXPIRED" } }; },
      now: () => Date.now(),
      rng: () => 0.9,
      delayMs: () => 0,
      retryDelayMs: () => 10,
      onWarn: (message) => { warnings.push(message); },
    });
    cleanups.push(() => driver.close());
    driver.notify("0042");
    await vi.advanceTimersByTimeAsync(500);
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(warnings.length).toBe(1);
  });
});

describe("P2-5 cancelRoom 取消 notify/retry 定时器", () => {
  function bettingRoomState(): EngineState {
    const state = createInitialState("g-cancel", config, [{ nickname: "AI" }, { nickname: "人" }]);
    state.phase = "BETTING";
    state.phaseInstanceId = "round1-betting-8";
    state.round = 1;
    state.deadlineAt = new Date(45_000).toISOString();
    state.windowDeadlineMs = 45_000;
    return state;
  }
  const room = { state: "PLAYING", paused: false, players: [{ playerId: "p1", seatId: 1, isBot: true }] };

  it("cancelRoom 后排队中的 notify tick 不再执行", async () => {
    const state = bettingRoomState();
    let reads = 0;
    const driver = new BotDriver({
      manager: {
        getRoom: () => room,
        getGame: () => { reads += 1; return state; },
        isNoHumanOnline: () => false,
      } as unknown as RoomManager,
      execute: async () => ({ outcome: { ok: true } }),
      now: () => Date.now(),
      rng: () => 0.9,
      delayMs: () => 1_000,
    });
    cleanups.push(() => driver.close());
    driver.notify("0042");
    driver.cancelRoom("0042");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reads).toBe(0);
  });

  it("cancelRoom 后已经排期的 VERSION_CONFLICT 重试不再提交", async () => {
    const state = bettingRoomState();
    let calls = 0;
    const driver = new BotDriver({
      manager: { getRoom: () => room, getGame: () => state, isNoHumanOnline: () => false } as unknown as RoomManager,
      execute: async () => { calls += 1; return { outcome: { ok: false, code: "VERSION_CONFLICT" } }; },
      now: () => Date.now(),
      rng: () => 0.9,
      delayMs: () => 0,
      retryDelayMs: () => 1_000,
    });
    cleanups.push(() => driver.close());
    driver.notify("0042");
    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    expect(calls).toBe(1);
    driver.cancelRoom("0042");
    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.resolve();
    expect(calls).toBe(1);
  });
});

describe("P2-4 driven 超限按 LRU 淘汰", () => {
  it("超过 500 时只淘汰最旧 key，保留最近成功的幂等记录", () => {
    const state = createInitialState("g-lru", config, [{ nickname: "AI" }, { nickname: "人" }]);
    const room = { state: "PLAYING", paused: false, players: [{ playerId: "p1", seatId: 1, isBot: true }] };
    const driver = new BotDriver({
      manager: { getRoom: () => room, getGame: () => state, isNoHumanOnline: () => false } as unknown as RoomManager,
      execute: async () => ({ outcome: { ok: true } }),
      delayMs: () => 0,
    });
    cleanups.push(() => driver.close());
    const internals = driver as unknown as {
      markDriven(room: string, gameId: string, round: number, key: string): void;
      hasDriven(room: string, gameId: string, key: string): boolean;
    };
    for (let index = 0; index < 500; index += 1) internals.markDriven("r", "g", 1, "old-" + String(index));
    internals.markDriven("r", "g", 1, "recent");
    expect(internals.hasDriven("r", "g", "recent")).toBe(true);
    expect(internals.hasDriven("r", "g", "old-0")).toBe(false);
    expect(internals.hasDriven("r", "g", "old-1")).toBe(true);
  });
});
describe("P2-3 notify 合并", () => {
  it("同一房间连续 notify 只产生一个 tick", async () => {
    const state = bettingState();
    const room = {
      state: "PLAYING", paused: false,
      players: [{ playerId: "p1", seatId: 1, isBot: true }],
    };
    let tickReads = 0;
    const driver = new BotDriver({
      manager: {
        getRoom: () => room,
        getGame: () => { tickReads += 1; return state; },
        isNoHumanOnline: () => false,
      } as unknown as RoomManager,
      execute: async () => ({ outcome: { ok: true } }),
      now: () => Date.now(),
      rng: () => 0.9,
      delayMs: () => 1_000,
    });
    cleanups.push(() => driver.close());
    for (let index = 0; index < 8; index += 1) driver.notify("0042");
    await vi.advanceTimersByTimeAsync(0);
    expect(tickReads).toBe(1);
  });

  function bettingState(): EngineState {
    const state = createInitialState("g-old", config, [{ nickname: "AI" }, { nickname: "人" }]);
    state.phase = "BETTING";
    state.phaseInstanceId = "round1-betting-2";
    state.round = 1;
    state.deadlineAt = new Date(45_000).toISOString();
    state.windowDeadlineMs = 45_000;
    return state;
  }
});
