/**
 * 07B 下注/到期/自救的纯展示推导：只用快照金额与本人输入，不调用协议、不重算服务端规则。
 * 金额一律 formatCents；非法/超上限输入不产生任何预估数字。
 */
import { MAX_MONEY_CENTS } from "@richman/shared";
import { formatCents } from "../net/wire";
import { CANONICAL_CENTS } from "./steps";

export type BetRiskState = "idle" | "invalid" | "tooLarge" | "zero" | "normal";

export interface BetRiskLine {
  text: string;
  tone: "good" | "bad" | "neutral";
}

export interface BetRisk {
  state: BetRiskState;
  lines: BetRiskLine[];
  /** 输后需要转为赌博透支贷款的差额；不需要时为 null。 */
  overdraftCents: string | null;
  /** 失信玩家只能 1 倍；风险块需要给出固定提示。 */
  leverageLockedToOne: boolean;
}

export interface BetRiskInput {
  /** 当前金币（十进制分）。 */
  cents: string;
  /** 金额输入框原始内容（不 trim，便于识别空格等非规范串）。 */
  betInput: string;
  leverage: 1 | 2;
  credit: "GOOD" | "DEFAULTED";
}

function coinsLine(cents: string): BetRiskLine {
  return { text: "当前金币 " + formatCents(cents), tone: "neutral" };
}

/**
 * 下注风险：0 注=放弃；非规范串/超过当前金币=不合法；预估超过上限=金额过大。
 * 失信玩家按 1 倍计算（UI 同时禁用 2 倍按钮）。
 */
export function deriveBetRisk(input: BetRiskInput): BetRisk {
  const leverageLockedToOne = input.credit === "DEFAULTED";
  const effectiveLeverage = leverageLockedToOne ? 1 : input.leverage;
  const base = { leverageLockedToOne };

  if (input.betInput === "") {
    return {
      ...base,
      state: "idle",
      lines: [coinsLine(input.cents), { text: "输入金额后显示赢/输预估", tone: "neutral" }],
      overdraftCents: null,
    };
  }

  if (!CANONICAL_CENTS.test(input.betInput)) {
    return {
      ...base,
      state: "invalid",
      lines: [coinsLine(input.cents), { text: "金额不合法，以服务端校验为准", tone: "bad" }],
      overdraftCents: null,
    };
  }

  const bet = Number(input.betInput);
  const cents = Number(input.cents);
  if (
    !Number.isSafeInteger(bet) ||
    !Number.isSafeInteger(cents) ||
    bet > MAX_MONEY_CENTS ||
    bet > cents
  ) {
    // 超过 MAX_MONEY_CENTS 与超过当前金币（服务端 BET_EXCEEDS_GOLD）都不做预估。
    const tooLarge = bet > MAX_MONEY_CENTS;
    return {
      ...base,
      state: tooLarge ? "tooLarge" : "invalid",
      lines: [
        coinsLine(input.cents),
        {
          text: tooLarge ? "金额过大，以服务端结算为准" : "金额不合法，以服务端校验为准",
          tone: "bad",
        },
      ],
      overdraftCents: null,
    };
  }

  if (bet === 0) {
    return {
      ...base,
      state: "zero",
      lines: [coinsLine(input.cents), { text: "押 0 即放弃本轮下注，输赢都为 0", tone: "neutral" }],
      overdraftCents: null,
    };
  }

  const moved = bet * effectiveLeverage;
  if (!Number.isSafeInteger(moved) || moved > MAX_MONEY_CENTS) {
    return {
      ...base,
      state: "tooLarge",
      lines: [coinsLine(input.cents), { text: "金额过大，以服务端结算为准", tone: "bad" }],
      overdraftCents: null,
    };
  }

  const lines: BetRiskLine[] = [
    coinsLine(input.cents),
    { text: "赢 +" + formatCents(String(moved)), tone: "good" },
    { text: "输 -" + formatCents(String(moved)), tone: "bad" },
  ];
  let overdraftCents: string | null = null;
  if (moved <= cents) {
    lines.push({ text: "输后余额 " + formatCents(String(cents - moved)), tone: "neutral" });
  } else {
    overdraftCents = String(moved - cents);
    lines.push({
      text: "输后归零，差额 " + formatCents(overdraftCents) + "转为赌博透支贷款",
      tone: "bad",
    });
    lines.push({
      text: "该贷款按银行贷款计息，到期要还本息；逾期会失信",
      tone: "bad",
    });
  }
  if (leverageLockedToOne) {
    lines.push({ text: "失信玩家只能 1 倍杠杆", tone: "neutral" });
  }
  return { ...base, state: "normal", lines, overdraftCents };
}

/** 用快照 serverNow 与 deadlineAt 求剩余秒数；缺失或非法时返回 null。 */
export function deadlineSeconds(deadlineAt: string | null, serverNow: string): number | null {
  if (deadlineAt === null) return null;
  const deadline = Date.parse(deadlineAt);
  const now = Date.parse(serverNow);
  if (!Number.isFinite(deadline) || !Number.isFinite(now)) return null;
  return Math.floor((deadline - now) / 1000);
}

/** 还款后的余额（可能为负），仅做整数分展示换算，不参与规则判定。 */
export function remainingAfterRepay(cents: string, remainingCents: string): string | null {
  const centsValue = Number(cents);
  const remainingValue = Number(remainingCents);
  if (!Number.isSafeInteger(centsValue) || !Number.isSafeInteger(remainingValue)) return null;
  return String(centsValue - remainingValue);
}
