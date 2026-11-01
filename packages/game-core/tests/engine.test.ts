import { describe, expect, it } from "vitest";
import { RULES } from "@richman/shared";
import {
  NotImplementedError,
  SNAPSHOT_SCHEMA_VERSION,
  applyCommand,
  createInitialState,
  decodeSnapshot,
  encodeSnapshot,
  getPlayerView,
} from "../src/engine.js";

const config = { timerMode: "standard" as const, privateDebtAffectsBankLoan: false };
const seeds = [{ nickname: "甲" }, { nickname: "乙" }];

describe("createInitialState", () => {
  it("creates 2 players with 100 coins and GOOD credit", () => {
    const state = createInitialState("g1", config, seeds);
    expect(state.round).toBe(1);
    expect(state.phase).toBe("INTEREST");
    expect(state.version).toBe(0);
    expect(state.eventSeq).toBe(0);
    expect(state.deadlineAt).toBeNull();
    expect(state.players).toHaveLength(2);
    for (const p of state.players) {
      expect(p.cents).toBe(RULES.startCents);
      expect(p.credit).toBe("GOOD");
      expect(p.alive).toBe(true);
    }
  });

  it("rejects out-of-range player counts", () => {
    expect(() => createInitialState("g1", config, [{ nickname: "only" }])).toThrow();
    expect(() => createInitialState("g1", config, Array.from({ length: 11 }, (_, i) => ({ nickname: "p" + i })))).toThrow();
  });
});

describe("player view", () => {
  it("exposes own state and public player list only", () => {
    const state = createInitialState("g1", config, seeds);
    const view = getPlayerView(state, "p1", new Date("2026-11-01T00:00:00Z"));
    expect(view.me.nickname).toBe("甲");
    expect(view.publicPlayers).toHaveLength(2);
    expect(Object.keys(view.publicPlayers[0] ?? {})).not.toContain("cents");
  });
});

describe("snapshot", () => {
  it("round-trips state with schema version", () => {
    const state = createInitialState("g1", config, seeds);
    const snapshot = encodeSnapshot(state, new Date("2026-11-01T00:00:00Z"));
    expect(snapshot.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);
    expect(decodeSnapshot(snapshot)).toEqual(state);
  });

  it("refuses incompatible schema versions", () => {
    const state = createInitialState("g1", config, seeds);
    const snapshot = encodeSnapshot(state, new Date());
    expect(() => decodeSnapshot({ ...snapshot, schemaVersion: 999 })).toThrow(/schemaVersion/);
  });
});

describe("applyCommand", () => {
  it("is not implemented yet and says so", () => {
    const state = createInitialState("g1", config, seeds);
    expect(() =>
      applyCommand(state, { protocolVersion: 1, gameId: "g1", commandId: "c1", type: "END_ACTION", payload: {} }, { nowMs: 0, drawResult: 0 }),
    ).toThrow(NotImplementedError);
  });
});
