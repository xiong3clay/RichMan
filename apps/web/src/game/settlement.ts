/**
 * 本轮结算卡的纯展示推导：只读取服务端事件与当前快照，不计算利息/税/输赢。
 * 利息事件本身不带金额（引擎只公布“已计息”），因此这里不臆造数值。
 */
import { formatCents } from "../net/wire";
import type { WireGameEvent, WireSnapshotView } from "../net/wire";

export interface SettlementLine {
  label: string;
  value: string;
  tone: "good" | "bad" | "neutral";
}

export interface RoundSettlement {
  round: number;
  lines: SettlementLine[];
  hasData: boolean;
  /** 本轮开奖点；事件缺少 drawResult 时为 null（不显示“未知”）。 */
  drawResult: 0 | 1 | null;
  /**
   * 按事件推导的本轮结算后余额：优先本人 TAX_CHARGED 的 centsAfter，
   * 其次本人 BET_SETTLED 的 nextCents，都没有时为 null（展示层回退到 before）。
   */
  balanceAfterEvent: string | null;
}

export interface SettlementOptions {
  /** 观看者本人是否有 ACTIVE 债务；false 时不显示利息行。默认 true。 */
  hasOutstandingLoans?: boolean;
}

/**
 * 只按快照筛选本人借入的 ACTIVE 银行/私人债务，不把本人出借的合同当作债务。
 * DEFAULTED/FROZEN/BAD_DEBT 均已停止计息；此处不推算利息金额。
 */
export function hasInterestBearingDebt(view: WireSnapshotView): boolean {
  const mineAndActive = (loan: { borrowerId: string; status: string }) =>
    loan.borrowerId === view.me.playerId && loan.status === "ACTIVE";
  return view.finance.bankLoans.some(mineAndActive) || view.finance.privateLoans.some(mineAndActive);
}

/** 只取服务端给出的余额；无本人结算事件时保留 before，绝不混用下一轮快照余额。 */
export function deriveSettlementBalance(beforeCents: string, settlement: RoundSettlement): string {
  return settlement.balanceAfterEvent ?? beforeCents;
}

function text(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function payloadOf(event: WireGameEvent): Record<string, unknown> {
  return event.payload;
}

/**
 * 只统计发生在 round 这一轮里的事件：
 * 先按服务端 seq 排序，再按 ROUND_STARTED 确定事件所属轮次。
 * 找不到本轮开始事件时（例如截断的事件列表）允许使用开头未知轮次的事件，
 * 但不会把已知属于其他轮次的税单混进来；带 round 的事件还需精确匹配。
 */
function eventsOfRound(events: readonly WireGameEvent[], round: number): readonly WireGameEvent[] {
  const ordered = [...events].sort((left, right) => left.seq - right.seq);
  const startIndex = ordered.findIndex((event) =>
    event.type === "ROUND_STARTED" && payloadOf(event)["round"] === round,
  );
  let knownRound: number | null = startIndex === -1 ? null : round;
  return ordered.slice(startIndex + 1).filter((event) => {
    const eventRound = payloadOf(event)["round"];
    if (event.type === "ROUND_STARTED") {
      if (typeof eventRound === "number") knownRound = eventRound;
      return false;
    }
    if (knownRound !== null && knownRound !== round) return false;
    return eventRound === undefined || eventRound === round;
  });
}

export function deriveRoundSettlement(
  events: readonly WireGameEvent[],
  round: number,
  viewerId: string,
  options: SettlementOptions = {},
): RoundSettlement {
  const scoped = eventsOfRound(events, round);
  const lines: SettlementLine[] = [];

  const interest = scoped.find((event) => {
    if (event.type !== "INTEREST_ACCRUED") return false;
    return payloadOf(event)["round"] === round;
  });
  if (interest !== undefined && options.hasOutstandingLoans !== false) {
    lines.push({
      label: "利息",
      value: "本轮有贷款计息，具体以本人债务记录为准",
      tone: "neutral",
    });
  }

  let tax: WireGameEvent | null = null;
  for (const event of scoped) {
    if (event.type !== "TAX_CHARGED") continue;
    if (payloadOf(event)["playerId"] !== viewerId) continue;
    tax = event;
  }
  const balanceAfterTax = tax === null ? null : text(payloadOf(tax)["centsAfter"]);
  if (tax !== null) {
    const amount = text(payloadOf(tax)["amountCents"]);
    if (amount !== null && balanceAfterTax !== null) {
      lines.push({
        label: "税",
        value: "-" + formatCents(amount) + "，扣税后余额 " + formatCents(balanceAfterTax),
        tone: "bad",
      });
    } else if (amount !== null) {
      lines.push({ label: "税", value: "-" + formatCents(amount), tone: "bad" });
    }
  }

  let balanceAfterBet: string | null = null;
  let drawResult: 0 | 1 | null = null;
  const betEvent = scoped.find((event) => {
    if (event.type !== "BET_SETTLED") return false;
    return payloadOf(event)["round"] === round;
  });
  if (betEvent !== undefined) {
    const rawDraw = payloadOf(betEvent)["drawResult"];
    if (rawDraw === 0 || rawDraw === 1) drawResult = rawDraw;
    const players = payloadOf(betEvent)["players"];
    const own =
      Array.isArray(players)
        ? (players as Array<Record<string, unknown>>).find((player) => player["playerId"] === viewerId)
        : undefined;
    if (own === undefined) {
      lines.push({ label: "下注", value: "本轮未押注", tone: "neutral" });
    } else {
      const betCents = text(own["betCents"]);
      const deltaCents = text(own["deltaCents"]);
      const nextCents = text(own["nextCents"]);
      balanceAfterBet = nextCents;
      const guess = text(own["guess"]);
      const leverage = text(own["leverage"]);
      const won = own["won"] === true;
      const parts: string[] = [];
      if (guess !== null && leverage !== null && betCents !== null) {
        parts.push("猜 " + guess + " · " + leverage + " 倍 · 押 " + formatCents(betCents));
      }
      if (deltaCents !== null) {
        // deltaCents 带负号时展示绝对值，避免“输 -500 分”叠两个负号。
        const magnitude = deltaCents.startsWith("-") ? deltaCents.slice(1) : deltaCents;
        parts.push((won ? "赢 +" : "输 ") + formatCents(magnitude));
      }
      if (nextCents !== null) {
        parts.push("结算后余额 " + formatCents(nextCents));
      }
      lines.push({
        label: "下注",
        value: parts.length === 0 ? "已开奖" : parts.join("；"),
        tone: won ? "good" : "bad",
      });
      const overdraftCents = text(own["overdraftCents"]);
      if (overdraftCents !== null && Number(overdraftCents) > 0) {
        lines.push({
          label: "透支贷款",
          value: formatCents(overdraftCents) + "（按银行贷款计息）",
          tone: "bad",
        });
      }
    }
  }

  return {
    round,
    lines,
    hasData: lines.length > 0,
    drawResult,
    balanceAfterEvent: balanceAfterTax ?? balanceAfterBet,
  };
}

/**
 * 危险原因只从本轮事件推断：本人下注亏损 → 本轮下注；本人被扣税 → 本轮扣税；
 * 否则不编原因。其它玩家的事件一律不看。
 */
export function deriveDangerReason(
  events: readonly WireGameEvent[],
  round: number,
  viewerId: string,
): string {
  const scoped = eventsOfRound(events, round);
  const bet = scoped.find((event) => event.type === "BET_SETTLED" && payloadOf(event)["round"] === round);
  if (bet !== undefined) {
    const players = payloadOf(bet)["players"];
    const own = Array.isArray(players)
      ? (players as Array<Record<string, unknown>>).find((player) => player["playerId"] === viewerId)
      : undefined;
    const delta = own === undefined ? null : text(own["deltaCents"]);
    if (delta !== null && delta.startsWith("-") && delta !== "-0" && delta !== "0") {
      return "本轮下注亏损导致金币为负";
    }
  }
  const taxed = scoped.some(
    (event) => event.type === "TAX_CHARGED" && payloadOf(event)["playerId"] === viewerId,
  );
  if (taxed) return "本轮扣税导致金币为负";
  return "余额为负，需要在时限内自救";
}
