import { describe, expect, it } from "vitest";
import { GameCommandSchema, HealthResponseSchema, MoneyStringSchema, PROTOCOL_VERSION, RoomCodeSchema } from "../src/protocol.js";

describe("protocol schemas", () => {
  it("accepts a valid command envelope", () => {
    const parsed = GameCommandSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      gameId: "g1",
      commandId: "c1",
      type: "END_ACTION",
      payload: {},
    });
    expect(parsed.type).toBe("END_ACTION");
  });

  it("rejects unknown fields and wrong protocol version", () => {
    const base = { protocolVersion: PROTOCOL_VERSION, gameId: "g1", commandId: "c1", type: "END_ACTION", payload: {} };
    expect(() => GameCommandSchema.parse({ ...base, seatId: 1 })).toThrow();
    expect(() => GameCommandSchema.parse({ ...base, protocolVersion: 999 })).toThrow();
  });

  it("validates money strings and room codes", () => {
    expect(MoneyStringSchema.parse("0")).toBe("0");
    expect(MoneyStringSchema.parse("1000000000000")).toBe("1000000000000");
    expect(() => MoneyStringSchema.parse("1000000000001")).toThrow();
    expect(() => MoneyStringSchema.parse("-1000000000001")).toThrow();
    expect(() => MoneyStringSchema.parse("-0")).toThrow();
    expect(() => MoneyStringSchema.parse("01")).toThrow();
    expect(RoomCodeSchema.parse("0042")).toBe("0042");
    expect(() => RoomCodeSchema.parse("123")).toThrow();
    expect(() => RoomCodeSchema.parse("123456789")).toThrow();
  });

  it("validates /health payload", () => {
    const health = {
      ok: true,
      service: "richman",
      version: "0.0.0",
      protocolVersion: PROTOCOL_VERSION,
      uptimeSec: 3,
      connections: 0,
      rooms: 0,
      serverNow: new Date().toISOString(),
    };
    expect(HealthResponseSchema.safeParse(health).success).toBe(true);
    expect(HealthResponseSchema.safeParse({ ...health, token: "secret" }).success).toBe(false);
  });
});
