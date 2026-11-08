import { expect, it } from "vitest";
import { advanceSystem, applyCommand, createInitialState, type EngineState } from "@richman/game-core";
import type { GameCommand } from "@richman/shared";
import { GameCommandProcessor, RoomCommandQueue } from "../src/rooms/command-queue.js";

const roomCode = "0042";
const config = { timerMode: "standard" as const, privateDebtAffectsBankLoan: false };

function command(type: string, requestId: string, commandId = type): GameCommand {
  return { protocolVersion: 1, gameId: "d6", commandId, type, payload: { requestId }, expectedGameVersion: 0 };
}

function requested(): EngineState {
  let state = advanceSystem(createInitialState("d6", config,
    [{ nickname: "甲" }, { nickname: "乙" }, { nickname: "丙" }, { nickname: "丁" }]),
  { actorId: "SYSTEM", nowMs: 0, drawResult: 0 }).state as EngineState;
  for (const [playerId, requestId, amount] of [["p1", "first", 1000], ["p2", "second", 500]] as const) {
    const result = applyCommand(state, {
      protocolVersion: 1, gameId: "d6", commandId: requestId, type: "REQUEST_PRIVATE_LOAN",
      payload: { requestId, lenderId: "p4", principalCents: amount, rateBps: 1000 },
    }, { actorId: playerId, nowMs: 0, drawResult: 0 });
    expect(result.outcome.ok).toBe(true);
    state = result.state as EngineState;
  }
  return state;
}

function processor(start: EngineState) {
  let state = start;
  const instance = new GameCommandProcessor({
    queue: new RoomCommandQueue(), getState: () => state, now: () => 1000,
    advance: () => {
      state = advanceSystem(state, { actorId: "SYSTEM", nowMs: 1000, drawResult: 0 }).state as EngineState;
    },
    commit: (_room, result) => { state = result.state as EngineState; },
  });
  return { execute: (playerId: string, item: GameCommand) => instance.execute(roomCode, playerId, item), state: () => state };
}

it("D6 ACTION pending=null 的非当前出借人同意，重发只转一次且新命令不能重复同意", async () => {
  const h = processor(requested());
  expect(h.state().pendingRequestId).toBeNull();
  expect(h.state().currentSeatId).toBe(3);
  const before = structuredClone(h.state());
  const accept = command("ACCEPT_PRIVATE_LOAN", "first");
  const first = await h.execute("p4", accept);
  expect(first.outcome.ok).toBe(true);
  expect(h.state().players.map(player => player.cents)).toEqual([11000, 10000, 10000, 9000]);
  expect(h.state().privateLoans).toHaveLength(1);
  expect(h.state().requests.map(request => request.status)).toEqual(["ACCEPTED", "PENDING"]);
  expect(h.state().currentSeatId).toBe(3);
  expect(h.state().actedSeats).toEqual([1, 2]);
  expect(h.state().windowDeadlineMs).toBe(before.windowDeadlineMs);
  const committed = structuredClone(h.state());
  expect(await h.execute("p4", structuredClone(accept))).toEqual(first);
  expect(h.state()).toEqual(committed);
  expect((await h.execute("p4", { ...accept, commandId: "second-accept" })).outcome)
    .toMatchObject({ ok: false, code: "REQUEST_EXPIRED" });
  expect(h.state()).toEqual(committed);
});

it("D6 ACTION pending=null 仍只允许指定出借人回应", async () => {
  const h = processor(requested());
  const before = structuredClone(h.state());
  expect((await h.execute("p3", command("ACCEPT_PRIVATE_LOAN", "first"))).outcome)
    .toMatchObject({ ok: false, code: "UNAUTHORIZED" });
  expect(h.state()).toEqual(before);
});

it("D6 ACTION 非当前出借人拒绝只关闭所选请求并保留当前行动窗口", async () => {
  const h = processor(requested());
  const before = structuredClone(h.state());
  expect((await h.execute("p4", command("REFUSE_PRIVATE_LOAN", "first"))).outcome.ok).toBe(true);
  expect(h.state().requests.map(request => request.status)).toEqual(["REFUSED", "PENDING"]);
  expect(h.state().players).toEqual(before.players);
  expect(h.state().currentSeatId).toBe(3);
  expect(h.state().actedSeats).toEqual([1, 2]);
  expect(h.state().windowDeadlineMs).toBe(before.windowDeadlineMs);
});

it("D6 TAX 自救仍拒绝不属于当前 pendingRequestId 的请求回应", async () => {
  let state = createInitialState("d6", config, [{ nickname: "甲" }, { nickname: "乙" }]);
  Object.assign(state, { phase: "TAX", round: 3, taxSeats: [1, 2], taxIndex: 0 });
  state.players[0]!.cents = 500;
  state = advanceSystem(state, { actorId: "SYSTEM", nowMs: 0, drawResult: 0 }).state as EngineState;
  state = applyCommand(state, {
    protocolVersion: 1, gameId: "d6", commandId: "tax-request", type: "REQUEST_PRIVATE_LOAN",
    payload: { requestId: "tax", lenderId: "p2", principalCents: 2000, rateBps: 1000 },
  }, { actorId: "p1", nowMs: 0, drawResult: 0 }).state as EngineState;
  expect(state.requests[0]!.status).toBe("PENDING");
  state.pendingRequestId = null;
  const h = processor(state);
  const before = structuredClone(state);
  expect((await h.execute("p2", command("ACCEPT_PRIVATE_LOAN", "tax"))).outcome)
    .toMatchObject({ ok: false, code: "REQUEST_EXPIRED" });
  expect(h.state()).toEqual(before);
});
