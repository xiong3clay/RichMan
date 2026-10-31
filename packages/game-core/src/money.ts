import type { Cents } from "@richman/shared";
import { MoneyFormatError, assertCents } from "@richman/shared";

/** 金额乘除的唯一入口：内部用 BigInt 计算，再落回安全整数范围内的 number。 */
export function mulDivFloor(a: Cents, b: number, c: number): Cents {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || !Number.isSafeInteger(c)) {
    throw new MoneyFormatError("mulDiv inputs must be safe integers");
  }
  if (c === 0) throw new MoneyFormatError("mulDiv divisor must not be zero");
  const value = (BigInt(a) * BigInt(b)) / BigInt(c);
  const result = Number(value);
  assertCents(result);
  return result;
}

/** 四舍五入到整数分；负数按远离零方向进位（仅供对称场景使用，正常金额路径不出现负数）。 */
export function mulDivRound(a: Cents, b: number, c: number): Cents {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || !Number.isSafeInteger(c)) {
    throw new MoneyFormatError("mulDiv inputs must be safe integers");
  }
  if (c === 0) throw new MoneyFormatError("mulDiv divisor must not be zero");
  const sign = a < 0 ? -1n : 1n;
  const absA = BigInt(Math.abs(a));
  const numerator = absA * BigInt(Math.abs(b));
  const denominator = BigInt(Math.abs(c));
  const rounded = (numerator + denominator / 2n) / denominator;
  const result = Number(sign * rounded * (b < 0 ? -1n : 1n) * (c < 0 ? -1n : 1n));
  assertCents(result);
  return result;
}

/** 本轮利息：非负余额 * 基点 / 10000，四舍五入到分。 */
export function interestFor(balanceCents: Cents, bps: number): Cents {
  if (balanceCents < 0) throw new MoneyFormatError("interest on negative balance is not allowed");
  if (!Number.isSafeInteger(bps) || bps < 0 || bps > 10_000) throw new MoneyFormatError("interest bps out of range");
  return mulDivRound(balanceCents, bps, 10_000);
}

/** 普通银行贷款上限：当前金币的一半，向下取整。 */
export function ordinaryLoanCap(goldCents: Cents): Cents {
  if (goldCents <= 0) return 0;
  return mulDivFloor(goldCents, 50, 100);
}
