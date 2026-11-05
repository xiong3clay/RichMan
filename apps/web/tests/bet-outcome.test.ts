import { describe, expect, it } from "vitest";
import {
  deadlineSeconds,
  deriveBetRisk,
  remainingAfterRepay,
} from "../src/game/bet-outcome.js";

function texts(result: ReturnType<typeof deriveBetRisk>): string[] {
  return result.lines.map((line) => line.text);
}

describe("07B 下注风险块", () => {
  it("赢 +B×L、输 -B×L、输后余额（1000/2倍/金币10000）", () => {
    const risk = deriveBetRisk({ cents: "10000", betInput: "1000", leverage: 2, credit: "GOOD" });
    expect(risk.state).toBe("normal");
    expect(texts(risk)).toContain("赢 +2,000 分");
    expect(texts(risk)).toContain("输 -2,000 分");
    expect(texts(risk)).toContain("输后余额 8,000 分");
    expect(risk.overdraftCents).toBeNull();
  });

  it("输后不足时给出透支差额与计息/失信提示（6000/2倍/金币10000）", () => {
    const risk = deriveBetRisk({ cents: "10000", betInput: "6000", leverage: 2, credit: "GOOD" });
    expect(risk.state).toBe("normal");
    expect(risk.overdraftCents).toBe("2000");
    expect(texts(risk).join("\n")).toContain("输后归零，差额 2,000 分转为赌博透支贷款");
    expect(texts(risk).join("\n")).toContain("按银行贷款计息");
    expect(texts(risk).join("\n")).toContain("逾期会失信");
  });

  it("押 0 显示放弃文案，不出现透支警告", () => {
    const risk = deriveBetRisk({ cents: "10000", betInput: "0", leverage: 2, credit: "GOOD" });
    expect(risk.state).toBe("zero");
    expect(texts(risk)).toContain("押 0 即放弃本轮下注，输赢都为 0");
    expect(texts(risk).join("\n")).not.toContain("透支");
  });

  it.each(["1e4", "0x10", " 5001 ", "01", "1.5", "-1"])(
    "非法金额 %s 只提示以服务端校验为准，不给预估",
    (betInput) => {
      const risk = deriveBetRisk({ cents: "10000", betInput, leverage: 2, credit: "GOOD" });
      expect(risk.state).toBe("invalid");
      expect(texts(risk)).toContain("金额不合法，以服务端校验为准");
      expect(texts(risk).join("\n")).not.toContain("赢 ");
      expect(texts(risk).join("\n")).not.toContain("输 ");
      expect(texts(risk).join("\n")).not.toContain("透支");
    },
  );

  it("失信玩家固定 1 倍并给出提示", () => {
    const risk = deriveBetRisk({ cents: "10000", betInput: "1000", leverage: 2, credit: "DEFAULTED" });
    expect(risk.leverageLockedToOne).toBe(true);
    expect(texts(risk)).toContain("失信玩家只能 1 倍杠杆");
    expect(texts(risk)).toContain("赢 +1,000 分");
  });

  it("预估超过 MAX_MONEY_CENTS 只提示金额过大", () => {
    const risk = deriveBetRisk({
      cents: "1000000000000",
      betInput: "600000000000",
      leverage: 2,
      credit: "GOOD",
    });
    expect(risk.state).toBe("tooLarge");
    expect(texts(risk)).toContain("金额过大，以服务端结算为准");
    expect(texts(risk).join("\n")).not.toContain("赢 ");
  });
});

describe("07B 时间与还款后余额", () => {
  it("deadlineSeconds 只按 serverNow 与 deadlineAt 计算", () => {
    expect(deadlineSeconds("2026-11-05T00:00:45.000Z", "2026-11-05T00:00:00.000Z")).toBe(45);
    expect(deadlineSeconds("2026-11-05T00:00:00.000Z", "2026-11-05T00:00:05.000Z")).toBe(-5);
    expect(deadlineSeconds(null, "2026-11-05T00:00:00.000Z")).toBeNull();
    expect(deadlineSeconds("not-a-date", "2026-11-05T00:00:00.000Z")).toBeNull();
  });

  it("remainingAfterRepay 金币减欠款，可为负", () => {
    expect(remainingAfterRepay("10000", "8000")).toBe("2000");
    expect(remainingAfterRepay("10000", "12000")).toBe("-2000");
    expect(remainingAfterRepay("bad", "12000")).toBeNull();
  });
});
