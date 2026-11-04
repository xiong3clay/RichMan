import { afterEach, describe, expect, it } from "vitest";
import { startServer } from "../../server/src/http.js";
import type { StartedServer } from "../../server/src/http.js";
import { RoomManager } from "../../server/src/rooms/manager.js";
import { createInitialState } from "@richman/game-core";
import type { EngineState } from "@richman/game-core";
import { RichmanClient } from "../src/net/client";
import type { WireCommandResult, WireGameEvent, WireSnapshotView, WireRoom } from "../src/net/wire";
import { INITIAL_UI_STATE, deriveStep, uiAfterOutcome } from "../src/game/steps";
import { deriveEventNotices } from "../src/game/notices";
import { commandSuccessText } from "../src/game/results";

class Player {
  readonly client: RichmanClient;
  joined = false;
  room: WireRoom | null = null;
  view: WireSnapshotView | null = null;
  results: WireCommandResult[] = [];
  events: WireGameEvent[] = [];
  constructor(roomCode: string, nickname: string) {
    this.client = new RichmanClient(roomCode, nickname, {
      onStatus() {}, onJoined: () => { this.joined = true; }, onRoom: room => { this.room = room; },
      onStarted() {}, onSnapshot: view => { this.view = view; }, onCommandResult: result => this.results.push(result),
      onEvents: events => this.events.push(...events), onServerError: error => { throw new Error(error.code); },
    });
  }
  async run(submit: () => string | null): Promise<WireCommandResult> {
    const id = submit(); expect(id).not.toBeNull();
    await expect.poll(() => this.results.find(result => result.commandId === id), { timeout: 3000 }).toBeDefined();
    return this.results.find(result => result.commandId === id)!;
  }
  options() { return { expectedGameVersion: this.view!.version }; }
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

async function table(configure: (state: EngineState) => void = () => undefined, afterStart?: (state: EngineState) => void) {
  const manager = new RoomManager({ createGameState: (id, config, seeds) => {
    const state = createInitialState(id, config, seeds); configure(state); return state;
  } });
  const server = await startServer({ host: "127.0.0.1", port: 0, manager, staticDir: "D:/nonexistent-static-dir" });
  const saved = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
    getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value),
    removeItem: (key: string) => saved.delete(key),
  } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    location: { protocol: "http:", host: `127.0.0.1:${server.port}` }, setTimeout, clearTimeout,
  } });
  const code = manager.createRoom(), a = new Player(code, "甲"), b = new Player(code, "乙");
  cleanups.push(async () => { a.client.dispose(); b.client.dispose(); await server.close(); });
  a.client.connect(); await expect.poll(() => a.joined).toBe(true);
  b.client.connect(); await expect.poll(() => b.joined).toBe(true);
  a.client.sendLobby({ type: "ready", ready: true }); b.client.sendLobby({ type: "ready", ready: true });
  await expect.poll(() => a.room?.players.length === 2 && a.room.players.every(p => p.ready)).toBe(true);
  a.client.sendLobby({ type: "start" });
  await expect.poll(() => a.view !== null && b.view !== null).toBe(true);
  // Inject an already-open decision/rescue window after normal startup broadcasts its snapshot.
  // This tests the real client command against the real engine without requiring a saved-game loader.
  afterStart?.(manager.getGame(code)!);
  return { server, code, a, b, state: () => manager.getGame(code)! };
}
function addBank(state: EngineState, dueRound = 4): void {
  state.bankLoans = [{ loanId: "bank-fixture", borrowerId: "p1", seatId: 1, principalCents: 15000,
    remainingCents: 15000, rateBps: 1000, issuedRound: 1, dueRound, lastInterestRound: 1, status: "ACTIVE", origin: "OVERDRAFT" }];
}
async function request(a: Player, amount = "500") {
  expect((await a.run(() => a.client.requestPrivateLoan("p2", amount, 1000, a.options()))).outcome.ok).toBe(true);
  return a.view!.finance.pendingRequest!.requestId;
}

describe("T7 真实客户端失败与向导", () => {
  it("BORROW_BANK超额拒绝不改版本/金币/行动，停留银行金额问题", async () => {
    const { a, state } = await table();
    const before = structuredClone(state());
    const result = await a.run(() => a.client.borrowBank("6000", a.options()));
    expect(result.outcome.ok).toBe(false); expect(state()).toEqual(before);
    const ui = { ...INITIAL_UI_STATE, actionStage: "bankAmount" as const };
    expect(deriveStep(a.view!, uiAfterOutcome(ui, result.outcome.ok))).toMatchObject({ kind: "actionOwn", stage: "bankAmount" });
  });
  it("REPAY_BANK超过金币拒绝不改账与行动，停留还款金额问题", async () => {
    const { a, state } = await table(addBank);
    const before = structuredClone(state());
    const result = await a.run(() => a.client.repayBank("bank-fixture", "10001", a.options()));
    expect(result.outcome).toMatchObject({ ok: false, code: "INSUFFICIENT_FUNDS" }); expect(state()).toEqual(before);
    const ui = { ...INITIAL_UI_STATE, actionStage: "debtAmount" as const };
    expect(deriveStep(a.view!, uiAfterOutcome(ui, result.outcome.ok))).toMatchObject({ kind: "actionOwn", stage: "debtAmount" });
  });
  it("ACCEPT余额不足是真实ok+FAILED：不转账、不建合同、明确通知且不保留过期待办", async () => {
    const { a, b, state } = await table();
    const id = await request(a, "15000");
    await expect.poll(() => b.view!.finance.incomingRequests.length).toBe(1);
    const beforeSeq = b.view!.eventSeq;
    const result = await b.run(() => b.client.acceptPrivateLoan(id, b.options()));
    expect(result.outcome.ok).toBe(true);
    expect(state().requests[0]!.status).toBe("FAILED"); expect(state().privateLoans).toEqual([]);
    expect(state().players.map(p => p.cents)).toEqual([10000, 10000]);
    expect(state().actedSeats).toContain(1);
    expect(b.view!.finance.incomingRequests).toEqual([]); expect(a.view!.finance.pendingRequest).toBeNull();
    expect(commandSuccessText("accept", b.view!, { requestId: id, afterEventSeq: beforeSeq, events: b.events })).toContain("未转账");
    const borrowerNotices = deriveEventNotices(a.events, "p1", {}, { phase: a.view!.phase, currentCents: a.view!.finance.cents });
    expect(borrowerNotices.some(n => n.text.includes("未成立") && n.text.includes("行动已用掉"))).toBe(true);
    expect(deriveStep(b.view!, INITIAL_UI_STATE).kind).not.toBe("requestLender");
  });
});

describe("T6 真实双客户端新增命令", () => {
  it("REQUEST/ACCEPT/REPAY_PRIVATE/COLLECT_PRIVATE字段经过服务端实际入账", async () => {
    const { a, b, state } = await table();
    const id = await request(a);
    await expect.poll(() => b.view!.finance.incomingRequests.length).toBe(1);
    expect((await b.run(() => b.client.acceptPrivateLoan(id, b.options()))).outcome.ok).toBe(true);
    expect(state().players.map(p => p.cents)).toEqual([10500, 9500]);
    expect((await b.run(() => b.client.endAction(b.options()))).outcome.ok).toBe(true);
    for (const p of [a, b]) {
      expect((await p.run(() => p.client.submitBet("0", 0, 1, {
        roundId: p.view!.round, phaseInstanceId: p.view!.phaseInstanceId,
      }))).outcome.ok).toBe(true);
    }
    expect(state().round).toBe(2);
    const loan = state().privateLoans[0]!; expect(loan.remainingCents).toBe(550);
    expect((await a.run(() => a.client.repayPrivateLoan(loan.loanId, "250", a.options()))).outcome.ok).toBe(true);
    expect(state().players.map(p => p.cents)).toEqual([10250, 9750]);
    expect((await b.run(() => b.client.collectPrivateLoan(loan.loanId, "100", b.options()))).outcome.ok).toBe(true);
    expect(state().players.map(p => p.cents)).toEqual([10150, 9850]);
    expect(state().privateLoans[0]!.remainingCents).toBe(200);
  });
  it.each(["REFUSE", "CANCEL"] as const)("%s真实关闭私人请求且双方不转账", async operation => {
    const { a, b, state } = await table(); const id = await request(a);
    await expect.poll(() => b.view!.finance.incomingRequests.length).toBe(1);
    const result = operation === "REFUSE"
      ? await b.run(() => b.client.refusePrivateLoan(id, b.options()))
      : await a.run(() => a.client.cancelPrivateLoan(id, a.options()));
    expect(result.outcome.ok).toBe(true); expect(state().requests[0]!.status).toBe(operation === "REFUSE" ? "REFUSED" : "CANCELLED");
    expect(state().players.map(p => p.cents)).toEqual([10000, 10000]); expect(state().privateLoans).toEqual([]);
  });
  it("BANK_DUE_DECISION真实还款，结果由该贷款状态确认", async () => {
    const { a, state } = await table(s => { addBank(s, 1); s.bankLoans[0]!.remainingCents = 1000; });
    expect(a.view!.phase).toBe("BANK_DUE");
    const result = await a.run(() => a.client.decideBankDue("bank-fixture", "REPAY", a.options()));
    expect(result.outcome.ok).toBe(true); expect(state().players[0]!.cents).toBe(9000);
    expect(commandSuccessText("bankDue", a.view!, { loanId: "bank-fixture", events: a.events })).toContain("已还款");
  });
  it("M3到期窗口内还款余额不足，真实ok后提示失信而不是已还款", async () => {
    const { a, state } = await table(undefined, s => {
      addBank(s, 1); s.phase = "BANK_DUE"; s.pendingDueLoanId = "bank-fixture";
      s.windowDeadlineMs = Date.now() + 45000; s.deadlineAt = new Date(s.windowDeadlineMs).toISOString();
    });
    const result = await a.run(() => a.client.decideBankDue("bank-fixture", "REPAY", a.options()));
    expect(result.outcome.ok).toBe(true); expect(state().players[0]!.credit).toBe("DEFAULTED");
    const text = commandSuccessText("bankDue", a.view!, { loanId: "bank-fixture", events: a.events });
    expect(text).toContain("永久"); expect(text).toContain("余额不足"); expect(text).not.toContain("已还款");
  });
  it("M3自动失信没有command_result也能从真实事件提示", async () => {
    const { a } = await table(s => addBank(s, 1));
    expect(a.results).toEqual([]);
    expect(deriveEventNotices(a.events, "p1", {}, { phase: a.view!.phase, currentCents: a.view!.finance.cents })[0]!.text).toContain("永久");
  });
  it("RESCUE_GIVE_UP真实破产而不是通用操作成功", async () => {
    const { a, state } = await table(undefined, s => {
      s.phase = "TAX"; s.players[0]!.status = "DANGER"; s.players[0]!.cents = -500;
      s.dangerSeatId = 1; s.taxSeats = [1, 2]; s.taxIndex = 1;
      s.dangerDeadlineMs = Date.now() + 60000; s.windowDeadlineMs = s.dangerDeadlineMs;
      s.deadlineAt = new Date(s.dangerDeadlineMs).toISOString();
    });
    const result = await a.run(() => a.client.giveUpRescue(a.options()));
    expect(result.outcome.ok).toBe(true); expect(state().players[0]!.alive).toBe(false);
    expect(commandSuccessText("giveUp", a.view!)).toBe("已放弃自救，你已破产");
  });
});
