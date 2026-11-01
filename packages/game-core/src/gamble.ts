import type { Cents, Credit, PlayerId } from "@richman/shared";
import { DEFAULTED_PLAYER_LEVERAGE, MAX_MONEY_CENTS } from "@richman/shared";

/** 一次锁定下注：提交后不可修改，提交时不预扣本金。 */
export interface BetLock {
  betCents: Cents;
  guess: 0 | 1;
  leverage: 1 | 2;
}

export type GambleErrorCode =
  | "INVALID_BET"
  | "BET_EXCEEDS_GOLD"
  | "LEVERAGE_NOT_ALLOWED"
  | "NEGATIVE_BALANCE"
  | "BALANCE_OVERFLOW";

export class GambleRuleError extends Error {
  readonly code: GambleErrorCode;

  constructor(code: GambleErrorCode, message: string = code) {
    super(message);
    this.name = "GambleRuleError";
    this.code = code;
  }
}

export interface ValidateBetInput {
  betCents: unknown;
  guess: unknown;
  leverage: unknown;
  /** 提交时的金币，金额上限取它而不是未来可能变化的余额。 */
  cents: Cents;
  credit: Credit;
}

/** 下注参数校验：0～提交时金币的整数分、guess 0/1、leverage 1/2、失信只能一倍。 */
export function validateBet(input: ValidateBetInput): BetLock {
  const betCents = input.betCents;
  if (
    typeof betCents !== "number" ||
    !Number.isSafeInteger(betCents) ||
    betCents < 0 ||
    betCents > MAX_MONEY_CENTS
  ) {
    throw new GambleRuleError("INVALID_BET", "下注金额必须是 [0, MAX_MONEY_CENTS] 内的整数分");
  }
  if (betCents > input.cents) {
    throw new GambleRuleError("BET_EXCEEDS_GOLD", "下注金额不得超过提交时的金币");
  }

  const guess = input.guess;
  if (guess !== 0 && guess !== 1) {
    throw new GambleRuleError("INVALID_BET", "猜测只能是 0 或 1");
  }

  const leverage = input.leverage;
  if (leverage !== 1 && leverage !== 2) {
    throw new GambleRuleError("INVALID_BET", "杠杆只能是 1 或 2");
  }
  if (input.credit === "DEFAULTED" && leverage !== DEFAULTED_PLAYER_LEVERAGE) {
    throw new GambleRuleError("LEVERAGE_NOT_ALLOWED", "失信玩家只能使用一倍杠杆");
  }

  return { betCents, guess, leverage };
}

export interface BetSettlement {
  playerId: PlayerId;
  betCents: Cents;
  guess: 0 | 1;
  leverage: 1 | 2;
  won: boolean;
  /** 猜对为 +bet×leverage，猜错为 -bet×leverage。 */
  deltaCents: Cents;
  /** 结算后金币；杠杆亏损不足时归 0，差额转为透支贷款。 */
  nextCents: Cents;
  /** 需要在同一结算内开出的赌博透支贷款金额，0 表示不需要。 */
  overdraftCents: Cents;
}

/**
 * 单笔下注结算（纯函数）。一倍杠杆出现负余额属于不变量失败，必须抛错，
 * 不能用透支贷款掩盖；二倍杠杆的缺口作为 overdraftCents 交给引擎在同一结算内放款。
 */
export function settleBet(
  bet: BetLock,
  cents: Cents,
  drawResult: 0 | 1,
  playerId: PlayerId,
): BetSettlement {
  if (drawResult !== 0 && drawResult !== 1) {
    throw new GambleRuleError("INVALID_BET", "开奖结果必须是 0 或 1");
  }

  const won = bet.guess === drawResult;
  const movedCents = bet.betCents * bet.leverage;
  // 用 0 - moved 避免 0 注时产生 -0。
  const deltaCents = won ? movedCents : 0 - movedCents;
  const nextCents = cents + deltaCents;

  if (nextCents < 0) {
    if (bet.leverage !== 2) {
      throw new GambleRuleError("NEGATIVE_BALANCE", "一倍杠杆出现负余额，规则不变量失败");
    }
    return {
      playerId,
      betCents: bet.betCents,
      guess: bet.guess,
      leverage: bet.leverage,
      won,
      deltaCents,
      nextCents: 0,
      overdraftCents: -nextCents,
    };
  }
  if (nextCents > MAX_MONEY_CENTS) {
    throw new GambleRuleError("BALANCE_OVERFLOW", "结算后金币超过上限，规则不变量失败");
  }

  return {
    playerId,
    betCents: bet.betCents,
    guess: bet.guess,
    leverage: bet.leverage,
    won,
    deltaCents,
    nextCents,
    overdraftCents: 0,
  };
}
