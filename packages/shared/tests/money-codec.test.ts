import { describe, expect, it } from "vitest";
import {
  MAX_MONEY_CENTS,
  MoneyFormatError,
  formatCoins,
  formatMoneyString,
  parseCoinsInput,
  parseMoneyString,
} from "../src/money.js";

describe("money string codec", () => {
  it("accepts canonical strings", () => {
    expect(parseMoneyString("0")).toBe(0);
    expect(parseMoneyString("1")).toBe(1);
    expect(parseMoneyString("10000")).toBe(10000);
    expect(parseMoneyString("999999999999")).toBe(999_999_999_999);
  });

  it("rejects leading zeros, plus signs, -0 and empty", () => {
    for (const bad of ["00", "01", "+1", "-0", "", " 1", "1 ", "1.0", "1e3"]) {
      expect(() => parseMoneyString(bad)).toThrow(MoneyFormatError);
    }
  });

  it("enforces max digits and max value", () => {
    expect(MAX_MONEY_CENTS).toBe(1_000_000_000_000);
    expect(parseMoneyString("1000000000000")).toBe(1_000_000_000_000);
    expect(() => parseMoneyString("99999999999999")).toThrow(MoneyFormatError);
  });

  it("rejects negative unless explicitly allowed", () => {
    expect(() => parseMoneyString("-5")).toThrow(MoneyFormatError);
    expect(parseMoneyString("-5", { allowNegative: true })).toBe(-5);
  });

  it("round-trips through formatMoneyString", () => {
    for (const value of [0, 1, 99, 10_000, -12_345]) {
      expect(parseMoneyString(formatMoneyString(value), { allowNegative: true })).toBe(value);
    }
  });
});

describe("coin input", () => {
  it("parses coins with up to two decimals", () => {
    expect(parseCoinsInput("100")).toBe(10_000);
    expect(parseCoinsInput("12.34")).toBe(1234);
    expect(parseCoinsInput("0.05")).toBe(5);
    expect(parseCoinsInput("12.3")).toBe(1230);
  });

  it("rejects too many decimals, signs and garbage", () => {
    for (const bad of ["12.345", "abc", "", "1.2.3", "1,000", "+5"]) {
      expect(() => parseCoinsInput(bad)).toThrow(MoneyFormatError);
    }
  });

  it("formats for display", () => {
    expect(formatCoins(10_000)).toBe("100");
    expect(formatCoins(1234)).toBe("12.34");
    expect(formatCoins(1230)).toBe("12.3");
    expect(formatCoins(5)).toBe("0.05");
    expect(formatCoins(-505)).toBe("-5.05");
    expect(formatCoins(5, { alwaysTwoDecimals: true })).toBe("0.05");
    expect(formatCoins(1234, { alwaysTwoDecimals: true })).toBe("12.34");
  });
});
