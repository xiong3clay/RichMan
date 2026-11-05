import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { GameView } from "../src/GameView";
import type { GameViewProps } from "../src/GameView";
import type { RichmanClient } from "../src/net/client";
import type { WireFinance, WireGameEvent, WirePublicPlayer, WireSnapshotView } from "../src/net/wire";
import { bankFixture, viewFixture } from "./view-fixtures";
import { mountDom } from "./dom-harness";

let mounted: Awaited<ReturnType<typeof mountDom>> | undefined;
afterEach(async () => {
  await mounted?.cleanup();
  mounted = undefined;
});

function gameEvent(seq: number, type: string, payload: Record<string, unknown>): WireGameEvent {
  return { seq, type, at: "2026-11-04T00:00:00Z", payload };
}

function propsFor(view: WireSnapshotView, events: WireGameEvent[] = []): GameViewProps {
  return {
    roomCode: "0042",
    view,
    status: "open",
    statusDetail: null,
    result: null,
    error: null,
    events,
    client: { hasJoined: true } as RichmanClient,
  };
}

function bettingView(finance: Partial<WireFinance> = {}, deadlineAt = "2026-11-04T00:01:00.000Z"): WireSnapshotView {
  const view = viewFixture();
  view.phase = "BETTING";
  view.currentSeatId = null;
  view.serverNow = "2026-11-04T00:00:00.000Z";
  view.deadlineAt = deadlineAt;
  view.finance = { ...view.finance, ...finance };
  return view;
}

async function enterAmount(dom: Awaited<ReturnType<typeof mountDom>>, betInput: string): Promise<void> {
  await dom.click("猜 0");
  await dom.input("下注金额（分）", betInput);
}

describe("07B 下注风险块（DOM）", () => {
  it("金额与杠杆变化实时显示赢/输/输后余额", async () => {
    mounted = await mountDom(createElement(GameView, propsFor(bettingView())));
    await enterAmount(mounted, "1000");
    expect(mounted.text()).toContain("赢 +1,000 分");
    expect(mounted.text()).toContain("输 -1,000 分");
    expect(mounted.text()).toContain("输后余额 9,000 分");

    await mounted.click("下一步");
    await mounted.click("2 倍");
    expect(mounted.text()).toContain("赢 +2,000 分");
    expect(mounted.text()).toContain("输 -2,000 分");
    expect(mounted.text()).toContain("输后余额 8,000 分");
  });

  it("输后不足显示透支差额与计息/失信提示", async () => {
    mounted = await mountDom(createElement(GameView, propsFor(bettingView())));
    await enterAmount(mounted, "6000");
    await mounted.click("下一步");
    await mounted.click("2 倍");
    expect(mounted.text()).toContain("差额 2,000 分转为赌博透支贷款");
    expect(mounted.text()).toContain("该贷款按银行贷款计息");
    expect(mounted.text()).toContain("逾期会失信");
  });

  it("押 0 显示放弃文案且无透支提示", async () => {
    mounted = await mountDom(createElement(GameView, propsFor(bettingView())));
    await enterAmount(mounted, "0");
    expect(mounted.text()).toContain("押 0 即放弃本轮下注，输赢都为 0");
    expect(mounted.text()).not.toContain("透支");
  });

  it("非法输入只提示以服务端校验为准，不显示预估", async () => {
    mounted = await mountDom(createElement(GameView, propsFor(bettingView())));
    await enterAmount(mounted, " 5001 ");
    expect(mounted.text()).toContain("金额不合法，以服务端校验为准");
    expect(mounted.text()).not.toContain("赢 +");
  });

  it("失信玩家只能 1 倍：2 倍按钮禁用并显示固定提示", async () => {
    const view = bettingView();
    view.me.credit = "DEFAULTED";
    mounted = await mountDom(createElement(GameView, propsFor(view)));
    await enterAmount(mounted, "1000");
    await mounted.click("下一步");
    expect(mounted.text()).toContain("失信玩家只能 1 倍杠杆");
    const twoX = Array.from(mounted.container.querySelectorAll("button"))
      .find(button => button.textContent.includes("2 倍"));
    expect(twoX?.disabled).toBe(true);
  });
});

describe("07B 等待开奖卡", () => {
  it("显示我的押注/猜点/杠杆/人数与开奖提示", async () => {
    const view = bettingView(
      { myBet: { betCents: "1000", guess: 1, leverage: 2 }, betsSubmitted: ["p1"], aliveCount: 2 },
      "2026-11-03T23:59:00.000Z",
    );
    mounted = await mountDom(createElement(GameView, propsFor(view)));
    expect(mounted.text()).toContain("你押了 1,000 分，猜 1，2 倍");
    expect(mounted.text()).toContain("模式：正常下注");
    expect(mounted.text()).toContain("猜点：猜 1");
    expect(mounted.text()).toContain("杠杆：2 倍");
    expect(mounted.text()).toContain("已提交 1 / 2 人；全员提交立即开奖");
    expect(mounted.text()).toContain("等待服务端开奖");
  });
});

describe("07B 银行到期与自救卡", () => {
  it("bankDue 显示欠款=remaining、到期轮、还清后余额与永久失信固定文案", async () => {
    const view = viewFixture();
    view.phase = "BANK_DUE";
    view.round = 4;
    view.serverNow = "2026-11-04T00:00:00.000Z";
    view.deadlineAt = "2026-11-03T23:59:00.000Z";
    view.finance.cents = "3000";
    view.finance.bankLoans = [
      { ...bankFixture(), issuedRound: 2, dueRound: 4, remainingCents: "8000", status: "ACTIVE" },
    ];
    view.pendingDueLoanId = "bank-1";
    mounted = await mountDom(createElement(GameView, propsFor(view)));
    expect(mounted.text()).toContain("欠款 8,000 分（本金+已计息）");
    expect(mounted.text()).toContain("发放第 2 轮 · 到期第 4 轮 · 当前第 4 轮");
    expect(mounted.text()).toContain("还清后余额 -5,000 分");
    expect(mounted.text()).toContain("金币不足，只能拒绝或等待超时");
    expect(mounted.text()).toContain("即将按超时处理");
    expect(mounted.text()).toContain(
      "拒绝或超时 = 永久失信：不能还这笔款、不能再用银行贷款、下注只能 1 倍；仍可向私人借款（对方会看到失信风险）。",
    );
    expect(mounted.text()).toContain("还款");
    expect(mounted.text()).toContain("拒绝还款");
  });

  it("danger 负余额原样显示、原因来自事件、三条后果含破产与冻结", async () => {
    const view = viewFixture();
    view.phase = "TAX";
    view.round = 3;
    view.me.status = "DANGER";
    view.me.cents = "-500";
    view.finance.cents = "-500";
    view.finance.receivableCents = "3000";
    view.finance.bankBorrowLimitCents = "0";
    view.finance.lenderLimits = [{ playerId: "p2", maxCents: "10000" }];
    view.serverNow = "2026-11-04T00:00:00.000Z";
    view.deadlineAt = "2026-11-04T00:00:45.000Z";
    const events = [
      gameEvent(4, "BET_SETTLED", {
        round: 3,
        drawResult: 0,
        players: [{ playerId: "p1", deltaCents: "-500", won: false, nextCents: "-500" }],
      }),
    ];
    mounted = await mountDom(createElement(GameView, propsFor(view, events)));
    expect(mounted.text()).toContain("-500 分");
    expect(mounted.text()).toContain("本轮下注亏损导致金币为负");
    expect(mounted.text()).toContain("应收");
    expect(mounted.text()).toContain("3,000 分");
    expect(mounted.text()).toContain("放弃自救 = 破产");
    expect(mounted.text()).toContain("私人债务转坏账");
    expect(mounted.text()).toContain("出借人应收冻结");
    expect(mounted.text()).toContain("超时同样按破产处理");
    expect(mounted.text()).toContain("自救剩余");
  });
});

describe("07B 终局与结算卡", () => {
  it("GAME_OVER 仍显示最后一轮结算卡，按钮文案为关闭", async () => {
    const before = viewFixture();
    before.round = 3;
    mounted = await mountDom(createElement(GameView, propsFor(before)));
    const after = { ...viewFixture(), round: 4, phase: "GAME_OVER" as const, winnerId: "p1",
      phaseInstanceId: "round4-over" };
    await mounted.update(createElement(GameView, propsFor(after)));
    expect(mounted.text()).toContain("第 3 轮结算");
    const buttons = Array.from(mounted.container.querySelectorAll("button"));
    expect(buttons.some(button => button.textContent === "关闭")).toBe(true);
  });

  it("终局卡显示胜者、本人金币/信用/破产说明，名单不含他人金币", async () => {
    const view = viewFixture();
    view.phase = "GAME_OVER";
    view.winnerId = "p2";
    view.me.cents = "3000";
    view.me.credit = "DEFAULTED";
    view.me.status = "BANKRUPT";
    view.finance.cents = "3000";
    const leaked = { ...view.publicPlayers[1]!, cents: "999999" } as unknown as WirePublicPlayer;
    view.publicPlayers = [view.publicPlayers[0]!, leaked];
    mounted = await mountDom(createElement(GameView, propsFor(view)));
    expect(mounted.text()).toContain("乙 获胜");
    expect(mounted.text()).toContain("你的最终金币：3,000 分");
    expect(mounted.text()).toContain("你的最终信用：永久失信");
    expect(mounted.text()).toContain("你已破产：私人债务已转坏账，出借人的应收被冻结");
    expect(mounted.text()).not.toContain("999,999 分");
    expect(mounted.text()).not.toContain("下注");
  });

  it("结算卡只渲染本人下注，他人 betCents 不进入 DOM，开奖只出现一次", async () => {
    const before = viewFixture();
    before.round = 3;
    mounted = await mountDom(createElement(GameView, propsFor(before)));
    const after = { ...viewFixture(), round: 4, phase: "GAME_OVER" as const, winnerId: "p2",
      phaseInstanceId: "round4-over" };
    const events = [
      gameEvent(5, "BET_SETTLED", {
        round: 3,
        drawResult: 1,
        players: [
          { playerId: "p1", betCents: "1000", guess: 1, leverage: 1, won: true,
            deltaCents: "1000", nextCents: "11000", overdraftCents: "0" },
          { playerId: "p2", betCents: "777777", guess: 0, leverage: 2, won: false,
            deltaCents: "-1555554", nextCents: "0", overdraftCents: "0" },
        ],
      }),
    ];
    await mounted.update(createElement(GameView, propsFor(after, events)));
    expect(mounted.text()).toContain("开奖：1");
    expect(mounted.text()).toContain("赢 +1,000 分");
    expect(mounted.text()).not.toContain("777,777 分");
    expect(mounted.text()).not.toContain("155,554 分");
    expect(mounted.text().match(/开奖/g) ?? []).toHaveLength(1);
  });
});

describe("07B 360px CSS 契约", () => {
  it("新块不设固定宽度并允许换行", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const css = readFileSync(fileURLToPath(new URL("../src/styles.css", import.meta.url)), "utf8");
    const rule = (selector: string): string => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = [...css.matchAll(new RegExp("(?:^|\\n)\\s*" + escaped + "\\s*\\{([^}]*)\\}", "gm"))].at(-1);
      expect(match).toBeDefined();
      return match![1]!.replace(/\s+/g, " ").trim();
    };
    for (const selector of [".bet-risk", ".bet-risk-line", ".final-row", ".final-row > *"]) {
      expect(rule(selector)).toContain("overflow-wrap: anywhere");
    }
    expect(rule(".bet-risk")).toContain("min-width: 0");
    expect(rule(".bet-risk")).not.toMatch(/(?:^|\s)width:/);
    expect(rule(".final-row")).toContain("minmax(0, 1fr)");
  });
});
