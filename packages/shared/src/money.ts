/** 金额内核：整数分（number），只允许安全整数，上限 10^12 分（100 亿金币）。 */
export type Cents = number;

export const MAX_MONEY_CENTS = 1_000_000_000_000 as const;
export const MAX_MONEY_DIGITS = 13 as const;

export class MoneyFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyFormatError";
  }
}

export function assertCents(value: number, label = "amount"): asserts value is Cents {
  if (!Number.isSafeInteger(value)) throw new MoneyFormatError(`${label} must be a safe integer`);
  if (Math.abs(value) > MAX_MONEY_CENTS) throw new MoneyFormatError(`${label} exceeds MAX_MONEY_CENTS`);
}

/** 协议与存档用：规范十进制字符串，零为 "0"，禁止前导零、正号、"-0"，最多 13 位数字。 */
export function parseMoneyString(input: string, opts: { allowNegative?: boolean } = {}): Cents {
  const allowNegative = opts.allowNegative === true;
  if (typeof input !== "string" || input.length === 0) throw new MoneyFormatError("money string is empty");
  if (!/^-?(0|[1-9][0-9]{0,12})$/.test(input)) throw new MoneyFormatError("money string has invalid format: " + input);
  if (input === "-0") throw new MoneyFormatError("negative zero is not allowed");
  const negative = input.startsWith("-");
  if (negative && !allowNegative) throw new MoneyFormatError("negative amount is not allowed here");
  const value = negative ? -Number(input.slice(1)) : Number(input);
  assertCents(value);
  return value;
}

export function formatMoneyString(cents: Cents): string {
  assertCents(cents);
  return String(cents);
}

/** 用户输入的金币（"12.34"）转成整数分；最多两位小数。 */
export function parseCoinsInput(input: string, opts: { allowNegative?: boolean } = {}): Cents {
  const allowNegative = opts.allowNegative === true;
  const raw = typeof input === "string" ? input.trim() : "";
  const pattern = allowNegative ? /^-?(\d{1,10})(?:\.(\d{1,2}))?$/ : /^(\d{1,10})(?:\.(\d{1,2}))?$/;
  const m = pattern.exec(raw);
  if (!m) throw new MoneyFormatError("invalid coin input: " + input);
  const negative = raw.startsWith("-");
  const whole = Number(m[1]);
  const fracText = m[2] ?? "";
  const frac = fracText.length === 0 ? 0 : Number(fracText.padEnd(2, "0"));
  let cents = whole * 100 + frac;
  if (negative) cents = -cents;
  assertCents(cents);
  return cents;
}

/** 金额分转展示用金币字符串；默认去掉末尾多余的 0（12.30 -> "12.3"），整数不显示小数点。 */
export function formatCoins(cents: Cents, opts: { alwaysTwoDecimals?: boolean } = {}): string {
  assertCents(cents);
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.trunc(abs / 100);
  const frac = abs % 100;
  if (opts.alwaysTwoDecimals === true) {
    return `${sign}${whole}.${String(frac).padStart(2, "0")}`;
  }
  if (frac === 0) return `${sign}${whole}`;
  const fracText = String(frac).padStart(2, "0").replace(/0+$/, "");
  return `${sign}${whole}.${fracText}`;
}

/** 债务/应收等汇总金额也必须落在范围内，越界按不变量失败处理（单元 01 使用）。 */
export function assertCentsRange(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) throw new MoneyFormatError(`${label} must be a safe integer`);
  if (Math.abs(value) > MAX_MONEY_CENTS) throw new MoneyFormatError(`${label} exceeds MAX_MONEY_CENTS`);
}
