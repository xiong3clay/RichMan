import { afterAll, describe, expect, it } from "vitest";
import { MAX_MONEY_CENTS, PHASES } from "@richman/shared";
import type { GameCommand, GameEvent, TransitionResult } from "@richman/shared";
import { advanceSystem, applyCommand, createInitialState, resumeFromPause } from "../src/engine.js";
import type { EngineState } from "../src/engine.js";

const fileStartedAt = Date.now(); // Performance measurement only; never fed to the engine.
const summaries: Record<string, unknown>[] = [];
type Player = EngineState["players"][number];

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;seed = seed + 0x6d2b79f5 | 0;
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed);
    value ^= value + Math.imul(value ^ value >>> 7, 61 | value);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function invariants(state: EngineState, step: number, previous?: EngineState, transition?: TransitionResult): void {
  const context = `step=${step} phase=${state.phase} round=${state.round} version=${state.version}`;
  const check = (ok: boolean, id: string, object: unknown): void => {
    if (!ok) throw new Error(`${id} ${context}: ${JSON.stringify(object)}`);
  };
  const ids = new Set(state.players.map(player => player.playerId));
  const seats = new Set(state.players.map(player => player.seatId));
  const alive = state.players.filter(player => player.alive);
  check(state.players.length === 10 && ids.size === 10 && seats.size === 10, "I1 players", state.players);
  for (const player of state.players) {
    check(Number.isInteger(player.seatId) && player.seatId >= 1 && player.seatId <= 10
      && player.playerId === `p${player.seatId}`, "I1 identity", player);
    check(["GOOD", "DEFAULTED"].includes(player.credit) && ["ALIVE", "DANGER", "BANKRUPT"].includes(player.status)
      && (player.alive === false) === (player.status === "BANKRUPT"), "I2 player status", player);
    check(player.credit !== "DEFAULTED" || state.bankLoans.some(loan => loan.borrowerId === player.playerId
      && loan.status === "DEFAULTED"), "I3 default requires bank record", { player, bankLoans: state.bankLoans });
  }
  const monetaryKeys = new Set(["cents", "betCents", "remainingCents", "principalCents", "paidCents"]);
  const checkMoney = (value: unknown, path: string): void => {
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (monetaryKeys.has(key)) check(Number.isSafeInteger(child)
        && Math.abs(child as number) <= MAX_MONEY_CENTS, "I4 safe money", { path: `${path}.${key}`, value: child });
      if (key === "paidCents") check(typeof child === "number" && child >= 0,
        "I9 paid amount nonnegative", { path: `${path}.${key}`, value: child });
      checkMoney(child, `${path}.${key}`);
    }
  };
  checkMoney(state, "state");checkMoney(transition?.events ?? [], "events");
  check(Number.isInteger(state.round) && state.round >= 1 && PHASES.includes(state.phase), "I5 phase/round", state);
  if (previous) {
    check(state.round >= previous.round, "I5 round monotonic", { before: previous.round, after: state.round });
    if (previous.phase === "GAME_OVER") check(JSON.stringify(state) === JSON.stringify(previous), "I5 terminal immutable", state);
    check(Number.isSafeInteger(state.version) && state.version >= previous.version, "I6 version", { before: previous.version, after: state.version });
    check(state.eventSeq >= previous.eventSeq, "I6 sequence monotonic", { before: previous.eventSeq, after: state.eventSeq });
    if (transition) {
      check(transition.events.every((event, index) => event.seq === previous.eventSeq + index + 1), "I6 contiguous events", transition.events);
      check(state.eventSeq === previous.eventSeq + transition.events.length, "I6 final sequence", { before: previous.eventSeq, state: state.eventSeq, events: transition.events });
    }
  }
  check((state.deadlineAt === null) === (state.windowDeadlineMs === null), "I7 paired deadline", { iso: state.deadlineAt, ms: state.windowDeadlineMs });
  if (state.deadlineAt !== null) check(Number.isSafeInteger(state.windowDeadlineMs)
    && Number.isFinite(Date.parse(state.deadlineAt)) && Date.parse(state.deadlineAt) === state.windowDeadlineMs,
  "I7 valid deadline", { iso: state.deadlineAt, ms: state.windowDeadlineMs });
  check(state.currentSeatId === null || alive.some(player => player.seatId === state.currentSeatId), "I8 current alive", { current: state.currentSeatId, alive });
  check(new Set(state.actedSeats).size === state.actedSeats.length
    && state.actedSeats.every(seat => alive.some(player => player.seatId === seat)), "I8 acted alive", { acted: state.actedSeats, alive });
  check(new Set(state.bankLoans.map(loan => loan.loanId)).size === state.bankLoans.length, "I9 unique bank loans", state.bankLoans);
  for (const loan of state.bankLoans) {
    check(ids.has(loan.borrowerId) && loan.remainingCents >= 0 && ["ACTIVE", "REPAID", "DEFAULTED"].includes(loan.status), "I9 bank shape", loan);
    check(loan.status !== "REPAID" || loan.remainingCents === 0, "I9 repaid bank", loan);
    check(loan.status !== "DEFAULTED" || loan.remainingCents > 0, "I9 defaulted bank", loan);
  }
  for (const loan of state.privateLoans) {
    check(loan.lenderId !== loan.borrowerId && ids.has(loan.lenderId) && ids.has(loan.borrowerId)
      && loan.remainingCents >= 0 && ["ACTIVE", "REPAID", "FROZEN", "BAD_DEBT"].includes(loan.status), "I10 private shape", loan);
    check(loan.status !== "ACTIVE" || loan.remainingCents > 0, "I10 active private", loan);
    check(loan.status !== "REPAID" || loan.remainingCents === 0, "I10 repaid private", loan);
  }
  check(new Set(state.requests.map(request => request.requestId)).size === state.requests.length, "I11 unique requests", state.requests);
  const pendingCounts = new Map<string, number>();
  for (const request of state.requests) {
    check(["PENDING", "ACCEPTED", "REFUSED", "CANCELLED", "EXPIRED", "FAILED"].includes(request.status), "I11 request status", request);
    if (request.status !== "PENDING") continue;
    check(Number.isSafeInteger(request.deadlineMs) && request.deadlineMs > 0
      && alive.some(player => player.playerId === request.borrowerId)
      && alive.some(player => player.playerId === request.lenderId), "I11 pending parties/deadline", request);
    pendingCounts.set(request.borrowerId, (pendingCounts.get(request.borrowerId) ?? 0) + 1);
    check(pendingCounts.get(request.borrowerId) === 1, "I11 one PENDING per borrower", state.requests);
  }
  check(state.phase === "BETTING" || Object.keys(state.bets).length === 0, "I12 bets outside BETTING", state.bets);
  for (const [playerId, bet] of Object.entries(state.bets)) {
    check(state.players.some(player => player.playerId === playerId && player.alive), "I12 bet player exists and alive", { playerId, bet });
    check(bet.betCents >= 0 && [0, 1].includes(bet.guess) && [1, 2].includes(bet.leverage)
      && (state.players.find(player => player.playerId === playerId)?.credit !== "DEFAULTED" || bet.leverage === 1), "I12 bet", { playerId, bet });
  }
  if (state.phase === "GAME_OVER") check(alive.length <= 1
    && state.winnerId === (alive[0]?.playerId ?? null), "I13 winner", { winnerId: state.winnerId, alive });
}

class Driver {
  state = createInitialState("endurance", { timerMode: "fast", privateDebtAffectsBankLoan: false },
    Array.from({ length: 10 }, (_, index) => ({ nickname: `player${index + 1}` })));
  now = 0;
  steps = 0;
  failures = 0;
  atomicFailures = 0;
  events: GameEvent[] = [];
  attempts: Record<string, number> = {};
  successes: Record<string, number> = {};
  private commandNo = 0;

  private finish(result: TransitionResult, before: EngineState, input: EngineState): TransitionResult {
    const label = `step=${this.steps} phase=${before.phase} round=${before.round} version=${before.version}`;
    expect(input, `input purity ${label}`).toEqual(before);
    if (!result.outcome.ok) {
      this.failures += 1;
      if (before.deadlineAt !== null && this.now < Date.parse(before.deadlineAt)) {
        this.atomicFailures += 1;
        expect(result.state, `failure atomicity ${label}`).toEqual(before);
      }
    } else if (before.phase !== "GAME_OVER") {
      expect(result.state.version, `successful progress ${label}`).toBeGreaterThan(before.version);
    }
    this.state = result.state as EngineState;
    this.events.push(...result.events);
    invariants(this.state, this.steps, before, result);
    return result;
  }

  send(type: string, actorId: string, payload: Record<string, unknown> = {}, drawResult: 0 | 1 = 0): TransitionResult {
    this.now += 1_000;this.steps += 1;this.commandNo += 1;
    this.attempts[type] = (this.attempts[type] ?? 0) + 1;
    const input = this.state, before = structuredClone(input);
    const command: GameCommand = { protocolVersion: 1, gameId: input.gameId, commandId: `c${this.commandNo}`, type, payload };
    const result = this.finish(applyCommand(input, command, { actorId, nowMs: this.now, drawResult }), before, input);
    if (result.outcome.ok) this.successes[type] = (this.successes[type] ?? 0) + 1;
    return result;
  }

  tick(drawResult: 0 | 1 = 0): TransitionResult {
    this.now = Math.max(this.now + 1, this.state.deadlineAt === null ? 0 : Date.parse(this.state.deadlineAt));
    this.steps += 1;
    const input = this.state, before = structuredClone(input);
    const result = this.finish(advanceSystem(input, { actorId: "SYSTEM", nowMs: this.now, drawResult }), before, input);
    expect(result.outcome.ok).toBe(true);
    return result;
  }

  current(): Player {
    const player = this.state.players.find(item => item.seatId === this.state.currentSeatId);
    expect(player).toBeDefined();return player!;
  }

  terminalCheck(): void {
    const before = structuredClone(this.state);
    this.tick();
    expect(this.state).toEqual(before);
    expect(this.send("END_ACTION", "p1").outcome).toMatchObject({ ok: false, code: "GAME_OVER" });
    expect(this.state).toEqual(before);
    expect(resumeFromPause(this.state, { nowMs: this.now + 1_000 })).toEqual(before);
  }

  summary(script: string): Record<string, unknown> {
    return { script, steps: this.steps, phase: this.state.phase, round: this.state.round, version: this.state.version,
      alive: this.state.players.filter(player => player.alive).length, winnerId: this.state.winnerId,
      failures: this.failures, atomicFailures: this.atomicFailures, events: this.events.length,
      attempts: this.attempts, successes: this.successes };
  }
}

function fixed(script: "S1" | "S2"): Driver {
  const driver = new Driver();driver.tick();
  while (driver.state.phase !== "GAME_OVER" && driver.steps < 3000) {
    const state = driver.state;
    let result: TransitionResult;
    if (state.phase === "ACTION" && state.currentSeatId !== null) result = driver.send("END_ACTION", driver.current().playerId);
    else if (state.phase === "BETTING") {
      const player = state.players.find(item => item.alive && state.bets[item.playerId] === undefined)!;
      // The engine consumes integer Cents; the WS layer alone uses decimal strings.
      result = driver.send("SUBMIT_BET", player.playerId, { betCents: script === "S1" ? 0 : Math.min(100, player.cents),
        guess: script === "S1" || player.playerId === "p1" ? 0 : 1, leverage: 1 });
    } else if (state.phase === "TAX" && state.dangerSeatId !== null) {
      result = driver.send("RESCUE_GIVE_UP", state.players.find(player => player.seatId === state.dangerSeatId)!.playerId);
    } else result = driver.tick();
    expect(result.outcome, `fixed ${script} ${JSON.stringify(driver.summary(script))}`).toEqual({ ok: true });
  }
  expect(driver.state.phase, `3000-step cap ${JSON.stringify(driver.summary(script))} lastEvent=${JSON.stringify(driver.events.at(-1))}`).toBe("GAME_OVER");
  expect(driver.state.round).toBeGreaterThanOrEqual(10);expect(driver.state.round).toBeLessThanOrEqual(40);
  driver.terminalCheck();return driver;
}

function chaos(seed: number, limit = 1500): Driver {
  const random = mulberry32(seed), driver = new Driver();
  const pick = <T,>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
  const draw = (): 0 | 1 => random() < 0.5 ? 0 : 1;
  driver.tick();
  // These are real commands, not corrupt fixtures: every seed necessarily exercises
  // a rejected money operation and a new request before random exploration.
  expect(driver.send("BORROW_BANK", "p1", { amountCents: 20_000 }, draw()).outcome.ok).toBe(false);
  expect(driver.send("REQUEST_PRIVATE_LOAN", "p1", { lenderId: "p2", principalCents: 500, rateBps: 1000 }, draw()).outcome.ok).toBe(true);
  expect(driver.send("ACCEPT_PRIVATE_LOAN", "p2", { requestId: driver.state.requests[0]!.requestId }, draw()).outcome.ok).toBe(true);
  expect(driver.send("BORROW_BANK", "p2", { amountCents: Math.floor(driver.current().cents * 0.25) }, draw()).outcome.ok).toBe(true);
  while (driver.state.phase !== "GAME_OVER" && driver.steps < limit) {
    const state = driver.state, alive = state.players.filter(player => player.alive);
    const pending = state.requests.filter(request => request.status === "PENDING");
    if ((state.phase === "ACTION" || state.phase === "TAX") && pending.length && random() < 0.4) {
      const request = pick(pending), decision = random();
      driver.send(decision < 0.65 ? "ACCEPT_PRIVATE_LOAN" : decision < 0.85 ? "REFUSE_PRIVATE_LOAN" : "CANCEL_PRIVATE_LOAN",
        decision < 0.85 ? request.lenderId : request.borrowerId, { requestId: request.requestId }, draw());
    } else if (state.phase === "ACTION" && state.currentSeatId !== null) {
      const player = driver.current(), others = alive.filter(item => item.playerId !== player.playerId);
      const options: Array<[string, Record<string, unknown>]> = [
        ["END_ACTION", {}], ["BORROW_BANK", { amountCents: Math.max(1, Math.floor(player.cents * 0.25)) }],
      ];
      if (others.length) options.push(["REQUEST_PRIVATE_LOAN", { lenderId: pick(others).playerId,
        principalCents: Math.max(1, Math.floor(player.cents * 0.2)), rateBps: 1000 }]);
      const bank = state.bankLoans.find(loan => loan.borrowerId === player.playerId && loan.status === "ACTIVE");
      if (bank && player.cents > 0) options.push(["REPAY_BANK", { loanId: bank.loanId, cents: Math.min(bank.remainingCents, player.cents) }]);
      const borrowed = state.privateLoans.find(loan => loan.borrowerId === player.playerId && loan.status === "ACTIVE");
      if (borrowed && player.cents > 0) options.push(["REPAY_PRIVATE", { loanId: borrowed.loanId, cents: Math.min(borrowed.remainingCents, player.cents) }]);
      const collectible = state.privateLoans.find(loan => loan.lenderId === player.playerId && loan.status === "ACTIVE"
        && state.round > loan.issuedRound && state.players.some(item => item.playerId === loan.borrowerId && item.cents > 0));
      if (collectible) options.push(["COLLECT_PRIVATE", { loanId: collectible.loanId,
        cents: Math.min(collectible.remainingCents, state.players.find(item => item.playerId === collectible.borrowerId)!.cents) }]);
      const [type, payload] = pick(options);driver.send(type, player.playerId, payload, draw());
    } else if (state.phase === "BETTING") {
      const player = alive.find(item => state.bets[item.playerId] === undefined)!;
      driver.send("SUBMIT_BET", player.playerId, { betCents: Math.min(pick([0, 100, 500]), Math.max(0, player.cents)),
        guess: pick([0, 1]), leverage: pick([1, 2]) }, draw());
    } else if (state.phase === "TAX" && state.dangerSeatId !== null) {
      const player = alive.find(item => item.seatId === state.dangerSeatId)!, others = alive.filter(item => item.playerId !== player.playerId);
      if (random() < 0.5 || others.length === 0) driver.send("RESCUE_GIVE_UP", player.playerId, {}, draw());
      else driver.send("REQUEST_PRIVATE_LOAN", player.playerId, { lenderId: pick(others).playerId, principalCents: 500, rateBps: 1000 }, draw());
    } else if (state.phase === "BANK_DUE" && state.pendingDueLoanId !== null && random() < 0.5) {
      const loan = state.bankLoans.find(item => item.loanId === state.pendingDueLoanId)!;
      const player = alive.find(item => item.playerId === loan.borrowerId)!;
      if (player.cents >= loan.remainingCents) driver.send("BANK_DUE_DECISION", player.playerId, { loanId: loan.loanId, decision: "REPAY" }, draw());
      else driver.tick(draw());
    } else driver.tick(draw());
  }
  if (driver.state.phase === "GAME_OVER") driver.terminalCheck();
  summaries.push(driver.summary(`chaos-${seed}`));return driver;
}

describe("11A ten-player endurance", () => {
  it("T1 scripted_no_winner: ten players actually reach GAME_OVER with no survivor", () => {
    const driver = fixed("S1");
    expect(driver.state.players.filter(player => player.alive)).toEqual([]);expect(driver.state.winnerId).toBeNull();
    expect(driver.events.some(event => event.type === "PLAYER_BANKRUPT")).toBe(true);
    expect(driver.events.some(event => event.type === "GAME_OVER")).toBe(true);
    expect(driver.state.players.every(player => !Number.isNaN(player.cents))).toBe(true);
    summaries.push(driver.summary("S1"));
  });

  it("T2 scripted_unique_winner: fixed different guesses yield one positive-balance winner deterministically", () => {
    const first = fixed("S2"), second = fixed("S2");
    const alive = first.state.players.filter(player => player.alive);
    expect(alive).toHaveLength(1);expect(first.state.winnerId).toBe(alive[0]!.playerId);
    expect(first.state.winnerId).toBe("p1");expect(alive[0]!.cents).toBeGreaterThan(0);
    expect(JSON.stringify(second.state)).toBe(JSON.stringify(first.state));
    summaries.push(first.summary("S2"));
  });

  it("T3 chaos_invariants: seeds 11/12/13 preserve I1-I13 and pre-deadline failure atomicity", () => {
    const runs = [11, 12, 13].map(seed => chaos(seed));
    expect(runs.every(driver => driver.state.phase === "GAME_OVER")).toBe(true);
    expect(runs.every(driver => driver.atomicFailures > 0)).toBe(true);
    expect(runs.every(driver => (driver.successes.REQUEST_PRIVATE_LOAN ?? 0) > 0
      && (driver.successes.BORROW_BANK ?? 0) > 0 && driver.state.bankLoans.length > 0)).toBe(true);
  });

  it("T4 replay_determinism: identical seeded command/time/draw streams yield identical final state and events", () => {
    const first = chaos(12), second = chaos(12);
    expect(JSON.stringify(second.state)).toBe(JSON.stringify(first.state));expect(second.events).toEqual(first.events);
    expect(second.summary("replay")).toEqual(first.summary("replay"));
  });

  it("T12 atomicity_and_I11_probe: public rejected loan/request commands leave the book unchanged before deadlines", () => {
    const driver = new Driver();driver.tick();
    expect(driver.send("BORROW_BANK", "p1", { amountCents: 20_000 }).outcome.ok).toBe(false);
    expect(driver.send("REQUEST_PRIVATE_LOAN", "p1", { lenderId: "p2", principalCents: 500, rateBps: 1000 }).outcome.ok).toBe(true);
    expect(driver.state.requests.filter(request => request.borrowerId === "p1" && request.status === "PENDING")).toHaveLength(1);
    expect(driver.send("REQUEST_PRIVATE_LOAN", "p1", { lenderId: "p3", principalCents: 500, rateBps: 1000 }).outcome.ok).toBe(false);
    const before = structuredClone(driver.state), resumed = resumeFromPause(driver.state, { nowMs: 100_000 });
    invariants(resumed, driver.steps);expect(driver.state).toEqual(before);
    expect(resumed.currentSeatId).toBe(before.currentSeatId);expect(resumed.actedSeats).toEqual(before.actedSeats);
    expect(resumed.requests[0]!.deadlineMs).toBe(120_000);expect(resumed.windowDeadlineMs).toBe(130_000);
    expect(resumed.players).toEqual(before.players);expect(driver.atomicFailures).toBe(2);
  });

  it("T5 snapshot_scale: real S2 terminal state stays below 512KiB and 400 loan/request records", () => {
    const driver = fixed("S2"), bytes = JSON.stringify(driver.state).length;
    const records = driver.state.bankLoans.length + driver.state.privateLoans.length + driver.state.requests.length;
    expect(bytes).toBeLessThan(512 * 1024);expect(records).toBeLessThan(400);
    summaries.push({ script: "snapshot-scale", bytes, records });
    // S2 intentionally has no loans. Also measure a real financial history so the
    // record bound is not supported only by an empty book.
    const dense = chaos(13), denseBytes = JSON.stringify(dense.state).length;
    const denseRecords = dense.state.bankLoans.length + dense.state.privateLoans.length + dense.state.requests.length;
    expect(dense.state.bankLoans.length).toBeGreaterThan(0);expect(dense.state.privateLoans.length).toBeGreaterThan(0);
    expect(dense.state.requests.length).toBeGreaterThan(0);expect(denseRecords).toBeLessThan(400);
    expect(denseBytes).toBeLessThan(512 * 1024);
    summaries.push({ script: "snapshot-financial-history", bytes: denseBytes, records: denseRecords });
  });
});

afterAll(() => {
  const elapsedMs = Date.now() - fileStartedAt;
  console.log("[11A actual runs]", JSON.stringify({ summaries, elapsedMs }));
  expect(elapsedMs, "all endurance.test.ts test bodies must complete within 20s").toBeLessThan(20_000);
});
