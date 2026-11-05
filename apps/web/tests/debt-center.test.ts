/**
 * 单元 07A 债务中心：纯展示断言 + 打开抽屉不影响引导步骤的回归断言。
 * 所有金额/状态来自 viewFixture 的快照字段，组件不重算。
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { GameView } from "../src/GameView";
import type { GameViewProps } from "../src/GameView";
import { DebtCenter } from "../src/game/DebtCenter";
import type { RichmanClient } from "../src/net/client";
import type {
  WireFinance,
  WirePrivateLoan,
  WirePublicPlayer,
  WireSnapshotView,
} from "../src/net/wire";
import { bankFixture, requestFixture, viewFixture } from "./view-fixtures";
import { mountDom } from "./dom-harness";

let mounted: Awaited<ReturnType<typeof mountDom>> | undefined;
afterEach(async () => {
  await mounted?.cleanup();
  mounted = undefined;
});

function debtView(
  finance: Partial<WireFinance> = {},
  overrides: Partial<WireSnapshotView> = {},
): WireSnapshotView {
  const base = viewFixture();
  return { ...base, ...overrides, finance: { ...base.finance, ...finance } };
}

function privateLoan(overrides: Partial<WirePrivateLoan> = {}): WirePrivateLoan {
  return {
    loanId: "p2p-1",
    requestId: "req-1",
    borrowerId: "p1",
    lenderId: "p2",
    principalCents: "5000",
    remainingCents: "5000",
    rateBps: 1000,
    issuedRound: 1,
    lastInterestRound: 1,
    status: "ACTIVE",
    ...overrides,
  };
}

function renderDebt(view: WireSnapshotView): string {
  return renderToStaticMarkup(createElement(DebtCenter, { view, onClose: () => {} }));
}

function bankProps(): GameViewProps {
  return {
    roomCode: "0042",
    view: viewFixture(),
    client: { hasJoined: true } as RichmanClient,
    status: "open",
    statusDetail: null,
    result: null,
    error: null,
    events: [],
  };
}

describe("07A 债务中心：银行贷款明细", () => {
  it("逐条渲染本金/剩余/利率/发放轮/到期轮/计息轮/状态（ACTIVE + REPAID）", () => {
    const html = renderDebt(
      debtView({
        bankLoans: [
          {
            ...bankFixture(),
            loanId: "bank-active",
            principalCents: "1000",
            remainingCents: "1100",
            rateBps: 1000,
            issuedRound: 2,
            dueRound: 5,
            lastInterestRound: 3,
            status: "ACTIVE",
          },
          {
            ...bankFixture(),
            loanId: "bank-repaid",
            principalCents: "2000",
            remainingCents: "0",
            rateBps: 2000,
            issuedRound: 1,
            dueRound: 2,
            lastInterestRound: 2,
            status: "REPAID",
          },
        ],
      }),
    );
    for (const text of [
      "普通贷款",
      "本金 1,000 分",
      "剩余 1,100 分",
      "利率 10%",
      "发放第 2 轮",
      "到期第 5 轮",
      "计息到第 3 轮",
      "未结清",
      "本金 2,000 分",
      "剩余 0 分",
      "利率 20%",
      "已还清",
    ]) {
      expect(html).toContain(text);
    }
  });

  it("ACTIVE 且 round>dueRound 显示逾期红字，REPAID 不显示", () => {
    const active = renderDebt(
      debtView(
        { bankLoans: [{ ...bankFixture(), dueRound: 2, status: "ACTIVE" }] },
        { round: 5 },
      ),
    );
    expect(active).toContain("已逾期，将在到期阶段处理");

    const repaid = renderDebt(
      debtView(
        { bankLoans: [{ ...bankFixture(), dueRound: 2, status: "REPAID" }] },
        { round: 5 },
      ),
    );
    expect(repaid).not.toContain("已逾期，将在到期阶段处理");
  });
});

describe("07A 债务中心：私人合同双角色与分组", () => {
  it("我欠 X 与 Y 欠我均显示本金/剩余/利率/发起轮", () => {
    const html = renderDebt(
      debtView({
        privateLoans: [
          privateLoan({
            loanId: "owe",
            borrowerId: "p1",
            lenderId: "p2",
            principalCents: "5000",
            remainingCents: "4000",
            rateBps: 1000,
            issuedRound: 2,
          }),
          privateLoan({
            loanId: "receivable",
            borrowerId: "p2",
            lenderId: "p1",
            principalCents: "3000",
            remainingCents: "2500",
            rateBps: 2000,
            issuedRound: 1,
          }),
        ],
        privateDebtCents: "4000",
        receivableCents: "2500",
      }),
    );
    for (const text of [
      "我欠 乙",
      "本金 5,000 分",
      "剩余 4,000 分",
      "利率 10%",
      "发起第 2 轮",
      "乙 欠我",
      "本金 3,000 分",
      "剩余 2,500 分",
      "利率 20%",
      "发起第 1 轮",
    ]) {
      expect(html).toContain(text);
    }
  });

  it("ACTIVE→进行中、REPAID→已结清、FROZEN/BAD_DEBT→冻结或坏账", () => {
    const html = renderDebt(
      debtView({
        privateLoans: [
          privateLoan({ loanId: "a", remainingCents: "111", status: "ACTIVE" }),
          privateLoan({ loanId: "r", remainingCents: "222", status: "REPAID" }),
          privateLoan({ loanId: "f", remainingCents: "333", status: "FROZEN" }),
          privateLoan({ loanId: "b", remainingCents: "444", status: "BAD_DEBT" }),
        ],
      }),
    );
    const activeIndex = html.indexOf("进行中");
    const settledIndex = html.indexOf("已结清");
    const frozenIndex = html.indexOf("冻结或坏账");
    expect(activeIndex).toBeGreaterThan(-1);
    expect(settledIndex).toBeGreaterThan(activeIndex);
    expect(frozenIndex).toBeGreaterThan(settledIndex);

    for (const [amount, lower, upper] of [
      ["剩余 111 分", activeIndex, settledIndex],
      ["剩余 222 分", settledIndex, frozenIndex],
      ["剩余 333 分", frozenIndex, html.length],
      ["剩余 444 分", frozenIndex, html.length],
    ] as const) {
      const index = html.indexOf(amount);
      expect(index).toBeGreaterThan(lower);
      expect(index).toBeLessThan(upper);
    }
  });
});

describe("07A 债务中心：请求区", () => {
  it("pendingRequest 显示对手与等待秒数，无 pending 显示空态", () => {
    const serverNow = "2026-11-05T00:00:00.000Z";
    const pending = {
      ...requestFixture(),
      borrowerId: "p1",
      lenderId: "p2",
      deadlineMs: Date.parse(serverNow) + 45_000,
    };
    const html = renderDebt(
      debtView({ pendingRequest: pending, incomingRequests: [] }, { serverNow }),
    );
    expect(html).toContain("等待 乙 答复");
    expect(html).toContain("等待剩余 45 秒");
    expect(html).toContain("同一借款人同时只能有一个等待中的请求");

    const expired = renderDebt(
      debtView(
        { pendingRequest: { ...pending, deadlineMs: Date.parse(serverNow) - 1000 }, incomingRequests: [] },
        { serverNow },
      ),
    );
    expect(expired).toContain("已超时，等待服务端关闭");

    const none = renderDebt(
      debtView({ pendingRequest: null, incomingRequests: [] }, { serverNow }),
    );
    expect(none).toContain("没有等待答复的请求");
  });

  it("失信借款人出现风险行并含失信欠款；正常借款人不出现风险行", () => {
    const serverNow = "2026-11-05T00:00:00.000Z";
    const risky = {
      ...requestFixture(),
      borrowerId: "p2",
      lenderId: "p1",
      borrowerCredit: "DEFAULTED" as const,
      borrowerDefaultedBankDebtCents: "5000",
      deadlineMs: Date.parse(serverNow) + 30_000,
    };
    const html = renderDebt(debtView({ incomingRequests: [risky] }, { serverNow }));
    expect(html).toContain("对方创建请求时已失信，出借有风险");
    expect(html).toContain("创建时信用 失信");
    expect(html).toContain("5,000 分");

    const normal = {
      ...risky,
      borrowerCredit: "GOOD" as const,
      borrowerDefaultedBankDebtCents: "0",
    };
    const safe = renderDebt(debtView({ incomingRequests: [normal] }, { serverNow }));
    expect(safe).not.toContain("出借有风险");
  });
});

describe("07A 债务中心：公开信息与空态", () => {
  it("他人表不含对方金币、私人金额或下注信息", () => {
    const leaked = {
      ...viewFixture().publicPlayers[1]!,
      cents: "777777",
      privateDebtCents: "888888",
      betCents: "999999",
    } as unknown as WirePublicPlayer;
    const html = renderDebt(
      debtView({}, { publicPlayers: [viewFixture().publicPlayers[0]!, leaked] }),
    );
    expect(html).toContain("失信欠款");
    expect(html).toContain("乙");
    expect(html).not.toContain("777,777 分");
    expect(html).not.toContain("888,888 分");
    expect(html).not.toContain("999,999 分");
    expect(html).not.toContain("下注");
  });

  it("无合同只显示空态，不渲染 .loan-row", () => {
    const html = renderDebt(debtView({ bankLoans: [], privateLoans: [] }));
    expect(html).toContain("当前无银行贷款");
    expect(html).toContain("当前无私人合同");
    expect(html.match(/class="loan-row/g) ?? []).toHaveLength(0);
  });
});

describe("07A 债务中心：打开不影响当前步骤", () => {
  it("打开/关闭抽屉时步骤卡标题不变", async () => {
    const props = bankProps();
    mounted = await mountDom(createElement(GameView, props));
    const question = mounted.container.querySelector(".question")?.textContent;
    expect(question).toBe("是否向其他玩家借款？");

    await mounted.click("债务中心（不消耗行动）");
    expect(mounted.container.querySelector(".debt-drawer")).not.toBeNull();
    expect(mounted.container.querySelector(".question")?.textContent).toBe(question);

    await mounted.click("关闭");
    expect(mounted.container.querySelector(".debt-drawer")).toBeNull();
    expect(mounted.container.querySelector(".question")?.textContent).toBe(question);
  });
});
