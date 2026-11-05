import { describe, expect, it } from "vitest";
import { deriveDangerReason, deriveRoundSettlement } from "../src/game/settlement.js";
import type { WireGameEvent } from "../src/net/wire.js";

function event(seq: number, type: string, payload: Record<string, unknown>): WireGameEvent {
  return { seq, type, at: "2026-11-05T00:00:00.000Z", payload };
}

function betSettled(
  seq: number,
  drawResult: unknown,
  players: Array<Record<string, unknown>>,
): WireGameEvent {
  return event(seq, "BET_SETTLED", { round: 3, drawResult, players });
}

describe("07B 结算卡：开奖点与下注结果", () => {
  it("drawResult=1 且本人获胜：开奖 1 + 赢 +2,000 分", () => {
    const card = deriveRoundSettlement(
      [
        betSettled(1, 1, [
          {
            playerId: "p1",
            betCents: "1000",
            guess: 1,
            leverage: 2,
            won: true,
            deltaCents: "2000",
            nextCents: "12000",
            overdraftCents: "0",
          },
        ]),
      ],
      3,
      "p1",
    );
    expect(card.drawResult).toBe(1);
    const value = card.lines[0]!.value;
    expect(value).toContain("猜 1 · 2 倍 · 押 1,000 分");
    expect(value).toContain("赢 +2,000 分");
    expect(value).toContain("结算后余额 12,000 分");
  });

  it("delta 为负时显示“输 500 分”，不出现“输 -500 分”", () => {
    const card = deriveRoundSettlement(
      [
        betSettled(1, 0, [
          {
            playerId: "p1",
            betCents: "500",
            guess: 1,
            leverage: 1,
            won: false,
            deltaCents: "-500",
            nextCents: "9500",
            overdraftCents: "0",
          },
        ]),
      ],
      3,
      "p1",
    );
    const value = card.lines[0]!.value;
    expect(value).toContain("输 500 分");
    expect(value).not.toContain("输 -500");
  });

  it("本人条目 overdraftCents>0 时增加“透支贷款”行", () => {
    const card = deriveRoundSettlement(
      [
        betSettled(1, 1, [
          {
            playerId: "p1",
            betCents: "6000",
            guess: 0,
            leverage: 2,
            won: false,
            deltaCents: "-12000",
            nextCents: "0",
            overdraftCents: "2000",
          },
        ]),
      ],
      3,
      "p1",
    );
    const overdraft = card.lines.find((line) => line.label === "透支贷款");
    expect(overdraft).toBeDefined();
    expect(overdraft!.value).toBe("2,000 分（按银行贷款计息）");
    expect(overdraft!.tone).toBe("bad");
  });

  it("本人无条目仍显示开奖点与“本轮未押注”", () => {
    const card = deriveRoundSettlement(
      [
        betSettled(1, 1, [
          {
            playerId: "p2",
            betCents: "500",
            guess: 1,
            leverage: 1,
            won: true,
            deltaCents: "500",
            nextCents: "10500",
            overdraftCents: "0",
          },
        ]),
      ],
      3,
      "p1",
    );
    expect(card.drawResult).toBe(1);
    expect(card.lines).toEqual([{ label: "下注", value: "本轮未押注", tone: "neutral" }]);
  });

  it("事件缺 drawResult 时为 null，不显示未知", () => {
    const card = deriveRoundSettlement([betSettled(1, undefined, [])], 3, "p1");
    expect(card.drawResult).toBeNull();
  });
});

describe("07B 危险原因只从本轮事件推断", () => {
  it("本人下注亏损优先", () => {
    const events = [
      betSettled(1, 0, [
        { playerId: "p1", deltaCents: "-500", won: false, nextCents: "-500" },
        { playerId: "p2", deltaCents: "-777777", won: false },
      ]),
    ];
    expect(deriveDangerReason(events, 3, "p1")).toBe("本轮下注亏损导致金币为负");
  });

  it("只有本人税单时归因本轮扣税", () => {
    const events = [event(1, "TAX_CHARGED", { playerId: "p1", amountCents: "2000", centsAfter: "-500" })];
    expect(deriveDangerReason(events, 3, "p1")).toBe("本轮扣税导致金币为负");
    expect(deriveDangerReason(events, 3, "p2")).toBe("余额为负，需要在时限内自救");
  });

  it("推断不出原因时不编造", () => {
    expect(deriveDangerReason([], 3, "p1")).toBe("余额为负，需要在时限内自救");
  });
});
