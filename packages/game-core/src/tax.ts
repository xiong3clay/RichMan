import type { Cents, PlayerId, SeatId } from "@richman/shared";
import { RULES } from "@richman/shared";
import type { BankLoan } from "./bank.js";

/** TAX 开始时确定应处理座位：本轮存活玩家按座位升序，每人只扣一次（R08）。 */
export function taxDueSeats(players: readonly { seatId: SeatId; alive: boolean }[]): SeatId[] {
  return players
    .filter((player) => player.alive)
    .map((player) => player.seatId)
    .sort((a, b) => a - b);
}

export interface TaxChargeResult {
  centsAfter: Cents;
  /** 扣税后仍为负 -> 进入 DANGER；余额只有税收自救期间允许为负（R01）。 */
  danger: boolean;
}

/** 单人扣税：只改金币，不改状态；负数由调用方置 DANGER。 */
export function chargeTax(cents: Cents, taxCents: Cents = RULES.taxCents): TaxChargeResult {
  const centsAfter = cents - taxCents;
  return { centsAfter, danger: centsAfter < 0 };
}

/**
 * 破产时该玩家未结清（ACTIVE）银行贷款全部转 DEFAULTED，保留当前欠款金额；
 * 已经 DEFAULTED / REPAID 的原样保留。返回新数组，不修改入参。
 */
export function defaultOutstandingBankLoans(
  loans: readonly BankLoan[],
  borrowerId: PlayerId,
): BankLoan[] {
  return loans.map((loan) =>
    loan.borrowerId === borrowerId && loan.status === "ACTIVE"
      ? { ...loan, status: "DEFAULTED" }
      : loan,
  );
}
