import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { advanceSystem, createInitialState, type EngineState } from "@richman/game-core";
import type { TransitionResult } from "@richman/shared";
import { RoomManager } from "../src/rooms/manager.js";
import { GameCommandProcessor, RoomCommandQueue } from "../src/rooms/command-queue.js";
import type { CommandReply } from "../src/rooms/command-queue.js";
import { RoomScheduler } from "../src/rooms/scheduler.js";
import { BotDriver } from "../src/bots/driver.js";

const cleanups: Array<() => void> = [];

/** fire() 把提交放在 Promise.resolve().then 里；等待微任务链落定。 */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});

describe("BotDriver 单人练习集成", () => {
  it("1 人 + 1 AI 从开局推进到第 3 轮结束：无卡死、无 RULE_INVARIANT、eventSeq 连续、AI 无非法命令", async () => {
    let counter = 0;
    const manager = new RoomManager({
      generateRoomCode: () => "0042",
      generateGameId: () => "g-" + String(++counter),
    });
    const roomCode = manager.createRoom(1);
    const human = manager.join(roomCode, "人类玩家");
    manager.setReadyFor(roomCode, human.playerId, true);
    manager.startFor(roomCode, human.playerId);

    const queue = new RoomCommandQueue();
    const commits: TransitionResult[] = [];
    const replies: CommandReply[] = [];
    const actions: Array<{ botPlayerId: string; type: string }> = [];
    const errors: unknown[] = [];
    const invariants: string[] = [];

    let scheduler!: RoomScheduler;
    let driver!: BotDriver;
    const commit = async (room: string, result: TransitionResult): Promise<void> => {
      commits.push(result);
      await manager.commitTransition(room, result);
      scheduler.schedule(room);
      driver.notify(room);
    };
    scheduler = new RoomScheduler({
      queue,
      getState: (room) => manager.getGame(room),
      commit,
      now: () => Date.now(),
      draw: () => 1,
    });
    const processor = new GameCommandProcessor({
      queue,
      getState: (room) => manager.getGame(room),
      commit,
      advance: (room) => scheduler.advanceDue(room),
      now: () => Date.now(),
      draw: () => 1,
      store: new Map(),
      onInvariant: (room) => invariants.push(room),
    });
    driver = new BotDriver({
      manager,
      execute: async (room, botPlayerId, command) => {
        const reply = await processor.execute(room, botPlayerId, command);
        replies.push(reply);
        return reply;
      },
      now: () => Date.now(),
      // 固定随机数：每次都会下注 10 分，便于复现。
      rng: () => 0.9,
      delayMs: () => 0,
      onAction: (_room, botPlayerId, command) => {
        actions.push({ botPlayerId, type: command.type });
      },
      onError: (error) => {
        errors.push(error);
      },
    });
    cleanups.push(() => { driver.close(); scheduler.close(); });

    scheduler.schedule(roomCode);
    driver.notify(roomCode);

    // 标准计时：每轮 ACTION 60s（人类超时）+ BETTING 45s（人类超时），足够跑完 3 轮。
    await vi.advanceTimersByTimeAsync(400_000);
    await queue.drain();

    const state = manager.getGame(roomCode)!;
    expect(state.round).toBeGreaterThanOrEqual(4);
    expect(invariants).toEqual([]);
    expect(errors).toEqual([]);
    expect(replies.length).toBeGreaterThan(0);
    expect(replies.filter((reply) => !reply.outcome.ok)).toEqual([]);

    const botIds = new Set([...actions.map((action) => action.botPlayerId)]);
    expect(botIds).toEqual(new Set(["p1"]));
    expect(actions.some((action) => action.type === "END_ACTION")).toBe(true);
    expect(actions.some((action) => action.type === "SUBMIT_BET")).toBe(true);

    // 每次提交的事件序号必须连续，不能重复或跳号。
    let expected = 1;
    for (const result of commits) {
      for (const event of result.events) {
        expect(event.seq).toBe(expected);
        expected += 1;
      }
    }
    expect(state.eventSeq).toBe(expected - 1);
    // AI 必须真实存在于最终名单。
    expect(state.players.map((player) => player.playerId)).toEqual(["p1", "p2"]);
  });

  it("1 真人 + 5 AI 推进 ≥3 轮：无卡死、无非法命令、无 RULE_INVARIANT", async () => {
    let counter = 0;
    let pick = 0;
    const personalitySeq = [0.1, 0.3, 0.5, 0.7, 0.9];
    const rng = (): number => personalitySeq[pick++ % personalitySeq.length]!;
    const manager = new RoomManager({
      generateRoomCode: () => "0044",
      generateGameId: () => "g5-" + String(++counter),
      rng,
    });
    const roomCode = manager.createRoom(5);
    const human = manager.join(roomCode, "人类玩家");
    manager.setReadyFor(roomCode, human.playerId, true);
    manager.startFor(roomCode, human.playerId);
    // 5 个 AI 抽到五种不同人格。
    expect(new Set(manager.getRoom(roomCode)!.players
      .filter((player) => player.isBot === true)
      .map((player) => player.botPersonality)).size).toBe(5);

    const queue = new RoomCommandQueue();
    const replies: CommandReply[] = [];
    const actors = new Set<string>();
    const errors: unknown[] = [];
    const invariants: string[] = [];
    let scheduler!: RoomScheduler;
    let driver!: BotDriver;
    const commit = async (room: string, result: TransitionResult): Promise<void> => {
      await manager.commitTransition(room, result);
      scheduler.schedule(room);
      driver.notify(room);
    };
    scheduler = new RoomScheduler({ queue, getState: (room) => manager.getGame(room), commit,
      now: () => Date.now(), draw: () => 0 });
    const processor = new GameCommandProcessor({ queue, getState: (room) => manager.getGame(room),
      commit, advance: (room) => scheduler.advanceDue(room), now: () => Date.now(), draw: () => 0,
      store: new Map(), onInvariant: (room) => invariants.push(room) });
    driver = new BotDriver({
      manager,
      execute: async (room, botPlayerId, command) => {
        actors.add(botPlayerId);
        const reply = await processor.execute(room, botPlayerId, command);
        replies.push(reply);
        return reply;
      },
      now: () => Date.now(),
      rng,
      delayMs: () => 0,
      onError: (error) => { errors.push(error); },
      onWarn: () => undefined,
    });
    cleanups.push(() => { driver.close(); scheduler.close(); });

    scheduler.schedule(roomCode);
    driver.notify(roomCode);
    await vi.advanceTimersByTimeAsync(400_000);
    await queue.drain();

    const state = manager.getGame(roomCode)!;
    expect(state.round).toBeGreaterThanOrEqual(4);
    expect(invariants).toEqual([]);
    expect(errors).toEqual([]);
    expect(replies.length).toBeGreaterThan(0);
    expect(replies.filter((reply) => !reply.outcome.ok)).toEqual([]);
    expect(state.players).toHaveLength(6);
    // 5 个 AI 都真实提交过命令。
    expect([...actors].sort()).toEqual(["p1", "p2", "p3", "p4", "p5"]);
  });

  it("延迟期间房间被销毁/阶段变化时放弃提交，不产生非法命令", async () => {
    let counter = 0;
    const manager = new RoomManager({
      generateRoomCode: () => "0043",
      generateGameId: () => "g-" + String(++counter),
    });
    const roomCode = manager.createRoom(1);
    const human = manager.join(roomCode, "人类玩家");
    manager.setReadyFor(roomCode, human.playerId, true);
    manager.startFor(roomCode, human.playerId);

    const queue = new RoomCommandQueue();
    const replies: CommandReply[] = [];
    const errors: unknown[] = [];
    let scheduler!: RoomScheduler;
    let driver!: BotDriver;
    const commit = async (room: string, result: TransitionResult): Promise<void> => {
      await manager.commitTransition(room, result);
      scheduler.schedule(room);
      driver.notify(room);
    };
    scheduler = new RoomScheduler({ queue, getState: (room) => manager.getGame(room), commit,
      now: () => Date.now(), draw: () => 0 });
    const processor = new GameCommandProcessor({ queue, getState: (room) => manager.getGame(room),
      commit, advance: (room) => scheduler.advanceDue(room), now: () => Date.now(), draw: () => 0,
      store: new Map() });
    driver = new BotDriver({
      manager,
      execute: async (room, botPlayerId, command) => {
        const reply = await processor.execute(room, botPlayerId, command);
        replies.push(reply);
        return reply;
      },
      now: () => Date.now(),
      delayMs: () => 5_000,
      onError: (error) => { errors.push(error); },
    });
    cleanups.push(() => { driver.close(); scheduler.close(); });

    // 先用系统推进把房间带到 ACTION（AI 回合），再让 notify 排入一个 5 秒后的行动。
    scheduler.schedule(roomCode);
    await vi.advanceTimersByTimeAsync(0);
    await queue.drain();
    expect(manager.getGame(roomCode)?.phase).toBe("ACTION");
    driver.notify(roomCode);
    await vi.advanceTimersByTimeAsync(0);

    await manager.destroyRoom(roomCode, human.playerId);
    driver.cancelRoom(roomCode);
    await vi.advanceTimersByTimeAsync(10_000);
    await queue.drain();

    expect(replies).toEqual([]);
    expect(errors).toEqual([]);
    expect(manager.getGame(roomCode)).toBeNull();
  });

  it("同一 (gameId, phaseInstanceId, botPlayerId) 只驱动一次", async () => {
    const state = advanceSystem(
      createInitialState("g-1", { timerMode: "standard", privateDebtAffectsBankLoan: false },
        [{ nickname: "AI" }, { nickname: "人类" }]),
      { actorId: "SYSTEM", nowMs: 0, drawResult: 0 },
    ).state as EngineState;
    expect(state.phase).toBe("ACTION");
    expect(state.currentSeatId).toBe(1);

    const commands: string[] = [];
    const room = {
      state: "PLAYING",
      paused: false,
      players: [{ playerId: "p1", seatId: 1, isBot: true }],
    };
    const managerStub = {
      getRoom: () => room,
      getGame: () => state,
      isNoHumanOnline: () => false,
    } as unknown as RoomManager;
    const driver = new BotDriver({
      manager: managerStub,
      execute: async (_room, _bot, command) => {
        commands.push(command.type);
        return { outcome: { ok: true } };
      },
      now: () => 0,
      rng: () => 0.9,
      delayMs: () => 0,
      onError: (error) => { throw error; },
    });
    cleanups.push(() => driver.close());

    driver.notify("0042");
    driver.notify("0042");
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(commands).toEqual(["END_ACTION"]);

    // 状态未变化（还没有提交）时再次通知也不能重复提交同一个阶段动作。
    driver.notify("0042");
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(commands).toEqual(["END_ACTION"]);
    driver.cancelRoom("0042");
  });
});
