import { describe, expect, it } from "vitest";
import { MAX_MONEY_CENTS } from "@richman/shared";
import { interestFor, mulDivFloor, mulDivRound, ordinaryLoanCap } from "../src/money.js";

describe("mulDiv", () => {
  it("floors and rounds without floating point drift", () => {
    expect(mulDivFloor(1000, 1, 3)).toBe(333);
    expect(mulDivRound(5, 1000, 10_000)).toBe(1); // 0.5 分 -> 1 分
    expect(mulDivRound(4, 1000, 10_000)).toBe(0);
    expect(mulDivFloor(9_999, 1, 10_000)).toBe(0);
  });

  it("keeps precision at the capacity ceiling", () => {
    expect(mulDivFloor(MAX_MONEY_CENTS, 1, 100)).toBe(10_000_000_000);
    expect(mulDivFloor(MAX_MONEY_CENTS, 50, 100)).toBe(500_000_000_000);
  });

  it("rejects unsafe inputs", () => {
    expect(() => mulDivFloor(1.5, 1, 1)).toThrow();
    expect(() => mulDivFloor(1, 1, 0)).toThrow();
  });
});

describe("interest", () => {
  it("10% compounded values from the plan", () => {
    // 借 50 金币 = 5000 分：55 / 60.50 / 66.55
    let debt = 5000;
    debt += interestFor(debt, 1000);
    expect(debt).toBe(5500);
    debt += interestFor(debt, 1000);
    expect(debt).toBe(6050);
    debt += interestFor(debt, 1000);
    expect(debt).toBe(6655);
  });

  it("rounds half a cent up (0.05 金币 -> 0.01 金币 利息)", () => {
    expect(interestFor(5, 1000)).toBe(1);
  });

  it("rejects negative balances and out-of-range bps", () => {
    expect(() => interestFor(-1, 1000)).toThrow();
    expect(() => interestFor(100, 10_001)).toThrow();
  });
});

describe("ordinary loan cap", () => {
  it("is half of current gold, floored", () => {
    expect(ordinaryLoanCap(10_000)).toBe(5000);
    expect(ordinaryLoanCap(5051)).toBe(2525);
    expect(ordinaryLoanCap(0)).toBe(0);
  });
});
