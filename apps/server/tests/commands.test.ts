import { describe, expect, it } from "vitest";
import type { CommandOutcome, GameCommand, TransitionResult } from "@richman/shared";
import { advanceSystem, applyCommand, createInitialState, type EngineState } from "@richman/game-core";
import { GameCommandProcessor, RoomCommandQueue, type CommandResultRecord } from "../src/rooms/command-queue.js";

const roomCode = "0042";
const config = { timerMode: "standard" as const, privateDebtAffectsBankLoan: false };

function initial(players = 2): EngineState {
  return advanceSystem(createInitialState("g1", config,
    Array.from({ length: players }, (_, index) => ({ nickname: "玩家" + String(index + 1) }))),
  { actorId: "SYSTEM", nowMs: 0, drawResult: 0 }).state as EngineState;
}

function command(type: string, payload: Record<string, unknown>, extra: Partial<GameCommand> = {}): GameCommand {
  return { protocolVersion: 1, gameId: "g1", commandId: type, type, payload, ...extra };
}

function harness(start = initial()) {
  let state = start;
  let nowMs = 0;
  let advances = 0;
  const committed: TransitionResult[] = [];
  const records = new Map<string, CommandResultRecord>();
  const processor = new GameCommandProcessor({
    queue: new RoomCommandQueue(),
    getState: (code) => code === roomCode ? state : null,
    commit: (_code, result) => { committed.push(result); state = result.state as EngineState; },
    advance: () => {
      advances += 1;
      const result = advanceSystem(state, { actorId: "SYSTEM", nowMs, drawResult: 0 });
      if (result.state.version !== state.version) { committed.push(result); state = result.state as EngineState; }
    },
    now: () => nowMs,
    draw: () => 0,
    store: records,
  });
  return { processor, committed, records, state: () => state, advances: () => advances,
    time: (value: number) => { nowMs = value; } };
}

function code(outcome: CommandOutcome): string | null { return outcome.ok ? null : outcome.code; }

function betting(players = 2): EngineState {
  let state = initial(players);
  for (let seat = 1; seat <= players; seat += 1) {
    const result = applyCommand(state, command("END_ACTION", {}, { commandId: "end-" + String(seat) }),
      { actorId: "p" + String(seat), nowMs: 0, drawResult: 0 });
    expect(result.outcome.ok).toBe(true);
    state = result.state as EngineState;
  }
  return state;
}

function requested(): EngineState {
  const result = applyCommand(initial(), command("REQUEST_PRIVATE_LOAN",
    { lenderId: "p2", principalCents: 1_000, rateBps: 1_000, requestId: "req-1" }),
  { actorId: "p1", nowMs: 0, drawResult: 0 });
  expect(result.outcome.ok).toBe(true);
  return result.state as EngineState;
}

function bankDue(): EngineState {
  const state = createInitialState("g1", config, [{ nickname: "甲" }, { nickname: "乙" }]);
  state.round = 4;
  state.bankLoans = [
    { loanId: "due-1", borrowerId: "p1", seatId: 1, principalCents: 1_000,
      remainingCents: 1_331, rateBps: 1_000, issuedRound: 1, dueRound: 4,
      lastInterestRound: 4, status: "ACTIVE", origin: "NORMAL" },
    { loanId: "due-2", borrowerId: "p1", seatId: 1, principalCents: 1_000,
      remainingCents: 1_331, rateBps: 1_000, issuedRound: 1, dueRound: 4,
      lastInterestRound: 4, status: "ACTIVE", origin: "OVERDRAFT" },
  ];
  return advanceSystem(state, { actorId: "SYSTEM", nowMs: 0, drawResult: 0 }).state as EngineState;
}

describe("RoomCommandQueue", () => {
  it("同房间异步任务按入队顺序执行，其他房间不被阻塞", async () => {
    const queue = new RoomCommandQueue();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = queue.run(roomCode, async () => { order.push("first-start"); await gate; order.push("first-end"); return 1; });
    const second = queue.run(roomCode, () => { order.push("second"); return 2; });
    await queue.run("0043", () => { order.push("other"); });
    expect(order).toEqual(["first-start", "other"]);
    release();
    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(order).toEqual(["first-start", "other", "first-end", "second"]);
  });

  it("异步失败原样拒绝，后续任务仍能执行", async () => {
    const queue = new RoomCommandQueue();
    const first = queue.run(roomCode, async () => { throw new Error("task failed"); });
    const failure = expect(first).rejects.toThrow("task failed");
    const second = queue.run(roomCode, () => 42);
    await failure;
    expect(await second).toBe(42);
  });
});

describe("GameCommandProcessor", () => {
  it("排队期间被新连接替换的身份在执行前拒绝，重复命令也不能绕过 epoch 校验", async () => {
    const queue = new RoomCommandQueue();
    let state = initial();
    let advances = 0;
    let authorized = true;
    const processor = new GameCommandProcessor({ queue, getState: () => state, now: () => 0,
      advance: () => { advances += 1; },
      commit: (_room, result) => { state = result.state as EngineState; } });
    const c = command("BORROW_BANK", { amountCents: 100 }, { expectedGameVersion: state.version });
    const successful = await processor.execute(roomCode, "p1", c, () => authorized);
    expect(successful.outcome.ok).toBe(true);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const blocked = queue.run(roomCode, () => gate);
    const queuedCommand = command("END_ACTION", {}, { commandId: "queued", expectedGameVersion: state.version });
    const queued = processor.execute(roomCode, "p2", queuedCommand, () => authorized);
    const retry = processor.execute(roomCode, "p1", c, () => authorized);
    authorized = false;
    release();
    await blocked;
    expect(code((await queued).outcome)).toBe("REPLACED");
    expect(code((await retry).outcome)).toBe("REPLACED");
    expect(advances).toBe(1);
    expect(state.players[0]?.cents).toBe(10_100);
    // The rejected connection's queue entry must not consume the command ID.
    authorized = true;
    const valid = await processor.execute(roomCode, "p2", queuedCommand, () => authorized);
    expect(valid.outcome.ok).toBe(true);
    expect(await processor.execute(roomCode, "p1", c, () => authorized)).toEqual(successful);
  });

  it("非 BETTING 命令不会请求开奖结果", async () => {
    let state = initial();
    const processor = new GameCommandProcessor({ queue: new RoomCommandQueue(), getState: () => state,
      advance: () => undefined, now: () => 0,
      draw: () => { throw new Error("non-betting must not draw"); },
      commit: (_room, result) => { state = result.state as EngineState; } });
    const reply = await processor.execute(roomCode, "p1", command("BORROW_BANK", { amountCents: 100 },
      { expectedGameVersion: state.version }));
    expect(reply.outcome.ok).toBe(true);
    expect(state.players[0]?.cents).toBe(10_100);
  });

  it("异步推进期间身份被替换后，不再执行玩家命令或缓存其结果", async () => {
    let state = initial();
    let authorized = true;
    let release!: () => void;
    let advancing!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { advancing = resolve; });
    const records = new Map<string, CommandResultRecord>();
    const processor = new GameCommandProcessor({ queue: new RoomCommandQueue(), getState: () => state,
      now: () => 0, store: records,
      advance: async () => { advancing(); await gate; },
      commit: (_room, result) => { state = result.state as EngineState; } });
    const pending = processor.execute(roomCode, "p1", command("BORROW_BANK", { amountCents: 100 },
      { expectedGameVersion: state.version }), () => authorized);
    await started;
    authorized = false;
    release();
    expect(code((await pending).outcome)).toBe("REPLACED");
    expect(state.players[0]?.cents).toBe(10_000);
    expect(state.bankLoans).toHaveLength(0);
    expect(records.size).toBe(0);
  });

  it("ack_lost_retry：真实私人转账重发只执行一次，同 ID 换载荷拒绝", async () => {
    const h = harness(requested());
    const accept = command("ACCEPT_PRIVATE_LOAN", { requestId: "req-1" }, { expectedGameVersion: 0 });
    const first = await h.processor.execute(roomCode, "p2", accept);
    expect(first.outcome.ok).toBe(true);
    expect(h.state().players.map((player) => player.cents)).toEqual([11_000, 9_000]);
    const version = h.state().version;
    h.time(99_999);
    const retried = await h.processor.execute(roomCode, "p2", structuredClone(accept));
    expect(retried).toEqual(first);
    expect(h.state().version).toBe(version);
    expect(h.state().privateLoans).toHaveLength(1);
    expect(h.advances()).toBe(1);
    expect(h.committed).toHaveLength(1);
    const changed = await h.processor.execute(roomCode, "p2", { ...accept, payload: { requestId: "req-1", principalCents: 2_000 } });
    expect(code(changed.outcome)).toBe("COMMAND_ID_REUSED");
    expect(h.state().players.map((player) => player.cents)).toEqual([11_000, 9_000]);
    expect(h.advances()).toBe(1);
  });

  it("ten_bets_same_version：十人同时持同一版本下注全部接受并只结算一轮", async () => {
    const start = betting(10);
    const h = harness(start);
    const replies = await Promise.all(start.players.map((player) => h.processor.execute(roomCode, player.playerId,
      command("SUBMIT_BET", { betCents: "100", guess: 0, leverage: 1 }, {
        commandId: "bet-" + player.playerId, expectedGameVersion: start.version,
        roundId: start.round, phaseInstanceId: start.phaseInstanceId,
      }))));
    expect(replies.every((reply) => reply.outcome.ok)).toBe(true);
    expect(h.state().version).toBe(start.version + 10);
    expect(h.state().round).toBe(2);
    expect(h.state().phase).toBe("ACTION");
    expect(h.state().players.map((player) => player.cents)).toEqual(Array(10).fill(10_100));
    expect(h.committed).toHaveLength(10);
  });

  it("完整客户端信封规范化对象键序；嵌套键序变化重发返回原结果", async () => {
    const h = harness();
    const first = command("BORROW_BANK", { amountCents: "100", metadata: { a: 1, b: [2, 3] } },
      { expectedGameVersion: h.state().version });
    const reply = await h.processor.execute(roomCode, "p1", first);
    expect(reply.outcome.ok).toBe(true);
    const reordered = { payload: { metadata: { b: [2, 3], a: 1 }, amountCents: "100" }, type: first.type,
      commandId: first.commandId, gameId: first.gameId, protocolVersion: first.protocolVersion,
      expectedGameVersion: first.expectedGameVersion };
    expect(await h.processor.execute(roomCode, "p1", reordered)).toEqual(reply);
    expect(h.advances()).toBe(1);
    expect(h.state().players[0]?.cents).toBe(10_100);
  });

  it("去重摘要保留版本等信封字段，也区分 wire 字符串与内部数值", async () => {
    const h = harness();
    const first = command("BORROW_BANK", { amountCents: "100" }, { expectedGameVersion: h.state().version });
    expect((await h.processor.execute(roomCode, "p1", first)).outcome.ok).toBe(true);
    expect(code((await h.processor.execute(roomCode, "p1", { ...first, expectedGameVersion: 50 })).outcome)).toBe("COMMAND_ID_REUSED");
    expect(code((await h.processor.execute(roomCode, "p1", { ...first, payload: { amountCents: 100 } })).outcome)).toBe("COMMAND_ID_REUSED");
    expect(h.advances()).toBe(1);
  });

  it("纯业务拒绝缓存原始失败与版本，重试不会推进或提交", async () => {
    const h = harness();
    const invalid = command("BORROW_BANK", { amountCents: 20_000 }, { expectedGameVersion: h.state().version });
    const first = await h.processor.execute(roomCode, "p1", invalid);
    expect(code(first.outcome)).toBe("INSUFFICIENT_FUNDS");
    expect(h.committed).toHaveLength(0);
    h.time(60_000);
    expect(await h.processor.execute(roomCode, "p1", invalid)).toEqual(first);
    expect(h.state().currentSeatId).toBe(1);
    expect(h.advances()).toBe(1);
    expect(h.records.size).toBe(1);
  });

  it.each(["SUBMIT_BET", "BORROW_BANK", "ACCEPT_PRIVATE_LOAN"])("%s 的伪造 playerId 在到期推进前拒绝", async (type) => {
    const h = harness();
    h.time(60_000);
    const reply = await h.processor.execute(roomCode, "p1", command(type,
      { playerId: "p2", amountCents: 100, requestId: "req-1" }, { expectedGameVersion: h.state().version }));
    expect(code(reply.outcome)).toBe("UNAUTHORIZED");
    expect(h.advances()).toBe(0);
    expect(h.committed).toHaveLength(0);
    expect(h.state().currentSeatId).toBe(1);
  });

  it("未知连接身份即使命中别人的 commandId 也不能读结果或推进", async () => {
    const h = harness();
    const c = command("BORROW_BANK", { amountCents: 100 }, { expectedGameVersion: h.state().version });
    await h.processor.execute(roomCode, "p1", c);
    const reply = await h.processor.execute(roomCode, "not-a-player", c);
    expect(code(reply.outcome)).toBe("UNAUTHORIZED");
    expect(h.advances()).toBe(1);
    expect(h.records.size).toBe(1);
  });

  it("gameId 不匹配不能改变本局，去重键按玩家隔离", async () => {
    const h = harness();
    const wrong = await h.processor.execute(roomCode, "p1", command("END_ACTION", {},
      { gameId: "other-game", expectedGameVersion: h.state().version }));
    expect(code(wrong.outcome)).toBe("UNAUTHORIZED");
    const c = command("END_ACTION", {}, { expectedGameVersion: h.state().version });
    expect((await h.processor.execute(roomCode, "p1", c)).outcome.ok).toBe(true);
    const other = await h.processor.execute(roomCode, "p2", { ...c, expectedGameVersion: h.state().version });
    expect(other.outcome.ok).toBe(true);
    expect(h.state().phase).toBe("BETTING");
  });

  it.each([undefined, 0])("行动必须严格携带当前 expectedGameVersion（收到 %s）", async (version) => {
    const h = harness();
    const reply = await h.processor.execute(roomCode, "p1", command("END_ACTION", {}, { expectedGameVersion: version }));
    expect(code(reply.outcome)).toBe("VERSION_CONFLICT");
    expect(h.state().currentSeatId).toBe(1);
    expect(h.committed).toHaveLength(0);
  });

  it("截止先推进后版本校验：晚到行动不能使用截止前版本", async () => {
    const h = harness();
    h.time(60_000);
    const reply = await h.processor.execute(roomCode, "p1", command("BORROW_BANK", { amountCents: 100 },
      { expectedGameVersion: h.state().version }));
    expect(code(reply.outcome)).toBe("VERSION_CONFLICT");
    expect(h.state().currentSeatId).toBe(2);
    expect(h.state().bankLoans).toHaveLength(0);
    expect(h.committed).toHaveLength(1);
  });

  it("行动截止在 advance 与 apply 之间到达时，不接受基于上一人阶段版本的操作", async () => {
    let state = initial();
    const processor = new GameCommandProcessor({ queue: new RoomCommandQueue(), getState: () => state,
      advance: () => undefined, now: () => 60_000,
      commit: (_room, result) => { state = result.state as EngineState; } });
    const reply = await processor.execute(roomCode, "p2", command("END_ACTION", {},
      { expectedGameVersion: state.version }));
    expect(code(reply.outcome)).toBe("VERSION_CONFLICT");
    expect(state.phase).toBe("ACTION");
    expect(state.actedSeats).toEqual([]);
  });

  it.each([
    { roundId: undefined, phaseInstanceId: "unused" },
    { roundId: 1, phaseInstanceId: undefined },
    { roundId: 0, phaseInstanceId: "unused" },
  ])("下注要求本轮与当前阶段实例 %j", async (extra) => {
    const h = harness(betting());
    const reply = await h.processor.execute(roomCode, "p1", command("SUBMIT_BET",
      { betCents: 100, guess: 0, leverage: 1 }, extra));
    expect(reply.outcome.ok).toBe(false);
    expect(h.state().bets).toEqual({});
    expect(h.committed).toHaveLength(0);
  });

  it("已锁注玩家新 commandId 仍被引擎拒绝 ALREADY_LOCKED", async () => {
    const start = betting();
    const h = harness(start);
    const c = command("SUBMIT_BET", { betCents: 100, guess: 0, leverage: 1 },
      { roundId: start.round, phaseInstanceId: start.phaseInstanceId });
    expect((await h.processor.execute(roomCode, "p1", c)).outcome.ok).toBe(true);
    expect(code((await h.processor.execute(roomCode, "p1", { ...c, commandId: "bet-again" })).outcome)).toBe("ALREADY_LOCKED");
    expect(h.committed).toHaveLength(1);
  });

  it("私人请求拒绝忽略旧全局版本，指定出借人之外无权处理", async () => {
    const h = harness(requested());
    const c = command("REFUSE_PRIVATE_LOAN", { requestId: "req-1" }, { expectedGameVersion: 0 });
    expect(code((await h.processor.execute(roomCode, "p1", c)).outcome)).toBe("UNAUTHORIZED");
    expect(h.state().requests[0]?.status).toBe("PENDING");
    expect((await h.processor.execute(roomCode, "p2", c)).outcome.ok).toBe(true);
    expect(h.state().requests[0]?.status).toBe("REFUSED");
    expect(h.state().currentSeatId).toBe(2);
  });

  it("私人请求到期先推进，旧请求同意失败且不会转账", async () => {
    const h = harness(requested());
    h.time(45_000);
    const reply = await h.processor.execute(roomCode, "p2", command("ACCEPT_PRIVATE_LOAN", { requestId: "req-1" }));
    expect(code(reply.outcome)).toBe("REQUEST_EXPIRED");
    expect(h.state().requests[0]?.status).toBe("EXPIRED");
    expect(h.state().players.map((player) => player.cents)).toEqual([10_000, 10_000]);
    expect(h.committed).toHaveLength(1);
  });

  it("信封 requestId 可用于请求应答，信封与载荷冲突则拒绝", async () => {
    const h = harness(requested());
    expect(code((await h.processor.execute(roomCode, "p2", command("ACCEPT_PRIVATE_LOAN",
      { requestId: "req-1" }, { requestId: "other-request", commandId: "conflict" }))).outcome)).toBe("INVALID_ACTION");
    const reply = await h.processor.execute(roomCode, "p2", command("ACCEPT_PRIVATE_LOAN", {}, { requestId: "req-1" }));
    expect(reply.outcome.ok).toBe(true);
    expect(h.state().privateLoans).toHaveLength(1);
  });

  it.each([undefined, "due-2"])("银行到期必须指向当前 pendingDueLoanId（收到 %s）", async (loanId) => {
    const h = harness(bankDue());
    const reply = await h.processor.execute(roomCode, "p1", command("BANK_DUE_DECISION",
      { loanId, decision: "REPAY" }, { expectedGameVersion: 0 }));
    expect(reply.outcome.ok).toBe(false);
    expect(h.state().pendingDueLoanId).toBe("due-1");
    expect(h.state().bankLoans.every((loan) => loan.status === "ACTIVE")).toBe(true);
    expect(h.committed).toHaveLength(0);
  });

  it("银行到期忽略旧全局版本，核对借款人与待决实例", async () => {
    const h = harness(bankDue());
    const c = command("BANK_DUE_DECISION", { loanId: "due-1", decision: "REPAY" }, { expectedGameVersion: 0 });
    expect(code((await h.processor.execute(roomCode, "p2", c)).outcome)).toBe("UNAUTHORIZED");
    expect((await h.processor.execute(roomCode, "p1", c)).outcome.ok).toBe(true);
    expect(h.state().bankLoans[0]?.status).toBe("REPAID");
    expect(h.state().bankLoans[1]?.status).toBe("ACTIVE");
    expect(h.state().pendingDueLoanId).toBe("due-2");
    const stale = await h.processor.execute(roomCode, "p1", { ...c, commandId: "old-due-instance" });
    expect(stale.outcome.ok).toBe(false);
    expect(h.state().bankLoans[1]?.status).toBe("ACTIVE");
    expect(h.state().players[0]?.cents).toBe(8_669);
  });

  it("银行截止在 advance 与 apply 之间到达时，旧贷款决策不能误处理下一笔", async () => {
    let state = bankDue();
    const processor = new GameCommandProcessor({ queue: new RoomCommandQueue(), getState: () => state,
      // Simulate advancement completing just before the deadline, then the clock reaching it.
      advance: () => undefined, now: () => 45_000,
      commit: (_room, result) => { state = result.state as EngineState; } });
    const reply = await processor.execute(roomCode, "p1", command("BANK_DUE_DECISION",
      { loanId: "due-1", decision: "REPAY" }));
    expect(code(reply.outcome)).toBe("REQUEST_EXPIRED");
    expect(state.bankLoans.map((loan) => loan.status)).toEqual(["ACTIVE", "ACTIVE"]);
    expect(state.players[0]?.cents).toBe(10_000);
  });

  it("保存去重结果先于异步 commit，execute 等待提交后才返回", async () => {
    let state = initial();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const records = new Map<string, CommandResultRecord>();
    let commitStarted = false;
    let finished = false;
    const processor = new GameCommandProcessor({ queue: new RoomCommandQueue(), getState: () => state,
      store: records, advance: () => undefined, now: () => 0, draw: () => 0,
      commit: async (_room, result) => { commitStarted = true; expect(records.size).toBe(1); await gate; state = result.state as EngineState; } });
    const pending = processor.execute(roomCode, "p1", command("BORROW_BANK", { amountCents: 100 },
      { expectedGameVersion: state.version })).then((reply) => { finished = true; return reply; });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(commitStarted).toBe(true);
    expect(finished).toBe(false);
    expect(state.players[0]?.cents).toBe(10_000);
    release();
    expect((await pending).outcome.ok).toBe(true);
    expect(state.players[0]?.cents).toBe(10_100);
  });

  it("整局累积保留早期命令，调用方修改返回值不改变缓存", async () => {
    const h = harness();
    const earliest = command("BORROW_BANK", { amountCents: 20_000 }, { expectedGameVersion: h.state().version });
    const reply = await h.processor.execute(roomCode, "p1", earliest);
    reply.gameVersion = 999;
    for (let index = 0; index < 200; index += 1) {
      await h.processor.execute(roomCode, "p1", { ...earliest, commandId: "rejected-" + String(index) });
    }
    const retry = await h.processor.execute(roomCode, "p1", earliest);
    expect(retry.gameVersion).toBe(1);
    expect(code(retry.outcome)).toBe("INSUFFICIENT_FUNDS");
    expect(h.records.size).toBe(201);
    expect(h.advances()).toBe(201);
  });
});
