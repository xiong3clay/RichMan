import type { Cents } from "./money.js";

/** 冻结数值：改这些值必须走规则变更并更新决策表与测试。 */
export const RULES = {
  playerMin: 2,
  playerMax: 10,
  startCents: 10_000 as Cents, // 100 金币
  interestBps: 1_000, // 10%
  ordinaryLoanMaxPercent: 50,
  loanInterestRoundsBeforeDue: 3, // N 轮生效 -> N+3 轮计息后到期
  taxEveryRounds: 3,
  taxCents: 2_000 as Cents, // 20 金币
  rescueRequestMinGapSec: 2,
} as const;

export const TIMERS = {
  standard: { actionSec: 60, requestSec: 45, bankDueSec: 45, bettingSec: 45, rescueSec: 60 },
  fast: { actionSec: 30, requestSec: 20, bankDueSec: 20, bettingSec: 30, rescueSec: 45 },
} as const;

export type TimerMode = keyof typeof TIMERS;
export const DEFAULT_TIMER_MODE: TimerMode = "standard";

export const SERVER_DEFAULTS = {
  port: 8000,
  host: "0.0.0.0",
  roomCodeMinDigits: 4,
  roomCodeMaxDigits: 8,
  maxMessageBytes: 16 * 1024,
  nicknameMaxCodePoints: 20,
} as const;

/** 失信不是淘汰：DEFAULTED 玩家仍存活并可行动。 */
export const DEFAULTED_PLAYER_CAN_BORROW_PRIVATE = true;
export const DEFAULTED_PLAYER_LEVERAGE = 1;
