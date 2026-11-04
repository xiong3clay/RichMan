import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { GameView } from "../src/GameView";
import type { GameViewProps } from "../src/GameView";
import type { RichmanClient } from "../src/net/client";
import { mountDom } from "./dom-harness";
import { viewFixture } from "./view-fixtures";

type Props = GameViewProps & { hostId: string | null };
let dom: Awaited<ReturnType<typeof mountDom>> | undefined;
afterEach(async () => { await dom?.cleanup(); dom = undefined; });

function propsFor(phase: "BETTING" | "GAME_OVER" | "ACTION" = "BETTING") {
  const bets: unknown[][] = [];
  let rematches = 0;
  const view = viewFixture(); view.phase = phase;
  if (phase === "GAME_OVER") view.winnerId = "p1";
  const props: Props = { roomCode: "0042", hostId: "p1", view, status: "open", statusDetail: null,
    result: null, error: null, events: [], client: {
      hasJoined: true,
      submitBet: (...args: unknown[]) => { bets.push(args); return "zero-bet"; },
      rematch: () => { rematches += 1; return true; },
    } as unknown as RichmanClient };
  return { props, bets, rematches: () => rematches };
}

describe("05D A 放弃本轮下注", () => {
  it("只在未锁定的猜点步骤出现，确认后只提交一次0/0/1并按快照锁定", async () => {
    const { props, bets } = propsFor();
    dom = await mountDom(createElement(GameView, props));
    expect(dom.text()).toContain("放弃本轮下注");
    await dom.click("放弃本轮下注");
    expect(bets).toHaveLength(0);
    expect(dom.text()).toContain("放弃后本轮不押注，等待开奖");
    const confirm = dom.container.querySelectorAll("button").find(button => button.textContent.includes("确认放弃"))!;
    await dom.clickElement(confirm); await dom.clickElement(confirm);
    expect(bets).toEqual([["0", 0, 1, { roundId: 1, phaseInstanceId: "action-1" }]]);
    props.view = { ...props.view, version: 2, finance: { ...props.view.finance,
      myBet: { betCents: "0", guess: 0, leverage: 1 }, betsSubmitted: ["p1"] } };
    props.result = { type: "command_result", commandId: "zero-bet", gameId: props.view.gameId, gameVersion: 2, outcome: { ok: true } };
    await dom.update(createElement(GameView, props));
    expect(dom.text()).toContain("已放弃（0 注）"); expect(dom.text()).toContain("锁定后不可修改");
    expect(dom.text()).not.toContain("确认放弃");
    expect(dom.container.querySelectorAll("button").some(button => button.textContent === "放弃本轮下注")).toBe(false);
  });

  it("进入金额步骤后不显示放弃按钮，返回猜点可选；新锁注撤下旧确认", async () => {
    const { props, bets } = propsFor(); dom = await mountDom(createElement(GameView, props));
    await dom.click("猜 1"); expect(dom.text()).not.toContain("放弃本轮下注");
    await dom.click("返回"); await dom.click("放弃本轮下注");
    props.view = { ...props.view, finance: { ...props.view.finance, myBet: { betCents: "100", guess: 1, leverage: 1 } } };
    await dom.update(createElement(GameView, props));
    expect(dom.text()).not.toContain("确认放弃"); expect(bets).toHaveLength(0);
  });

  it("放弃命令失败显示code与原因，保留服务端未锁定事实并允许重试", async () => {
    const { props, bets } = propsFor(); dom = await mountDom(createElement(GameView, props));
    await dom.click("放弃本轮下注"); await dom.click("确认放弃");
    props.result = { type: "command_result", gameId: props.view.gameId, commandId: "zero-bet", gameVersion: 1,
      outcome: { ok: false, code: "PHASE_MISMATCH", message: "下注窗口已变化" } };
    await dom.update(createElement(GameView, props));
    expect(dom.text()).toContain("PHASE_MISMATCH：下注窗口已变化"); expect(props.view.finance.myBet).toBeNull();
    await dom.click("放弃本轮下注"); await dom.click("确认放弃"); expect(bets).toHaveLength(2);
  });
  it("放弃提交收到原始RATE_LIMITED error也解除pending并能重试", async () => {
    const { props, bets } = propsFor(); dom = await mountDom(createElement(GameView, props));
    await dom.click("放弃本轮下注"); await dom.click("确认放弃");
    props.error = { code: "RATE_LIMITED", message: "操作过于频繁，请稍后重试" };
    await dom.update(createElement(GameView, props)); expect(dom.text()).toContain("RATE_LIMITED：操作过于频繁");
    await dom.click("放弃本轮下注"); await dom.click("确认放弃"); expect(bets).toHaveLength(2);
  });

  it.each(["connecting", "closed", "replaced"] as const)("%s时不能发放弃下注", async status => {
    const { props, bets } = propsFor(); props.status = status;
    dom = await mountDom(createElement(GameView, props));
    expect(dom.container.querySelectorAll("button").some(button => button.textContent.includes("放弃本轮下注"))).toBe(false);
    expect(bets).toHaveLength(0);
  });

  it("放弃提交后断线，恢复快照仍未锁注时可以重新确认", async () => {
    const { props, bets } = propsFor(); dom = await mountDom(createElement(GameView, props));
    await dom.click("放弃本轮下注"); await dom.click("确认放弃");
    props.status = "closed"; await dom.update(createElement(GameView, props));
    props.status = "open"; await dom.update(createElement(GameView, props));
    await dom.click("放弃本轮下注"); await dom.click("确认放弃");
    expect(bets).toHaveLength(2);
  });

  it("跳过中间快照直接到下一BETTING实例，不保留上次放弃pending", async () => {
    const { props } = propsFor(); dom = await mountDom(createElement(GameView, props));
    await dom.click("放弃本轮下注"); await dom.click("确认放弃");
    props.view = { ...props.view, round: 2, phaseInstanceId: "next-betting" };
    await dom.update(createElement(GameView, props));
    expect(dom.text()).toContain("猜哪个点");
    expect(dom.container.querySelectorAll("button").some(button => button.textContent.includes("放弃本轮下注"))).toBe(true);
    expect(dom.text()).not.toContain("正在提交放弃");
  });
});

describe("05D B 再来一局", () => {
  it("GAME_OVER房主对话框含胜者、本人最终余额与再来一局，重复点击只发一次", async () => {
    const { props, rematches } = propsFor("GAME_OVER"); dom = await mountDom(createElement(GameView, props));
    expect(dom.container.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(dom.text()).toContain("你赢了"); expect(dom.text()).toContain("你的最终金币：10,000 分");
    const button = dom.container.querySelectorAll("button").find(item => item.textContent.includes("再来一局"))!;
    await dom.clickElement(button); await dom.clickElement(button);
    expect(rematches()).toBe(1); expect(dom.text()).toContain("正在开始新一局…"); expect(button.disabled).toBe(true);
  });

  it("非房主只等待房主，不能发送rematch", async () => {
    const { props, rematches } = propsFor("GAME_OVER"); props.hostId = "p2";
    dom = await mountDom(createElement(GameView, props));
    expect(dom.container.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(dom.text()).toContain("等待房主开始新一局");
    expect(dom.container.querySelectorAll("button").some(button => button.textContent.includes("再来一局"))).toBe(false);
    expect(rematches()).toBe(0);
  });

  it("房主断线时结束对话框按钮禁用并给连接理由", async () => {
    const { props, rematches } = propsFor("GAME_OVER"); props.status = "closed";
    dom = await mountDom(createElement(GameView, props));
    const button = dom.container.querySelectorAll("button").find(item => item.textContent.includes("再来一局"))!;
    expect(button.disabled).toBe(true); await dom.clickElement(button); expect(rematches()).toBe(0);
    expect(dom.text()).toContain("连接");
  });

  it("rematch失败在对话框显示code和中文原因，解锁按钮重试", async () => {
    const { props, rematches } = propsFor("GAME_OVER"); dom = await mountDom(createElement(GameView, props));
    await dom.click("再来一局"); props.error = { code: "INVALID_STATE", message: "当前还未结束" };
    await dom.update(createElement(GameView, props));
    const dialog = dom.container.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("INVALID_STATE：当前还未结束");
    expect(dom.text().match(/INVALID_STATE/g)).toHaveLength(1);
    await dom.click("再来一局"); expect(rematches()).toBe(2);
  });

  it("gameId变化重建向导和通知，旧局步骤与已锁注不残留", async () => {
    const { props } = propsFor("ACTION");
    props.events = [{ seq: 9, type: "BANK_LOAN_DEFAULTED", at: props.view.serverNow,
      payload: { borrowerId: "p1", loanId: "old-loan", reason: "timeout" } }];
    dom = await mountDom(createElement(GameView, props)); await dom.click("跳过");
    expect(dom.text()).toContain("是否向银行借款"); expect(dom.text()).toContain("永久失信");
    props.view = { ...viewFixture(), gameId: "new-game" }; props.events = []; props.result = null; props.error = null;
    await dom.update(createElement(GameView, props));
    expect(dom.text()).toContain("是否向其他玩家借款"); expect(dom.text()).not.toContain("永久失信");
    expect(dom.text()).not.toContain("是否向银行借款");
    props.view = { ...props.view, phase: "BETTING", finance: { ...props.view.finance,
      myBet: { betCents: "0", guess: 0, leverage: 1 } } };
    await dom.update(createElement(GameView, props)); expect(dom.text()).toContain("已放弃（0 注）");
    props.view = { ...viewFixture(), gameId: "another-game", phase: "BETTING" };
    await dom.update(createElement(GameView, props));
    expect(dom.text()).toContain("猜哪个点"); expect(dom.text()).not.toContain("已放弃（0 注）");
  });

  it("新gameId不生成旧轮结算卡，并清除旧结束对话框与pending", async () => {
    const { props } = propsFor("ACTION"); props.view.round = 3;
    dom = await mountDom(createElement(GameView, props));
    props.view = { ...props.view, round: 4, phase: "GAME_OVER", winnerId: "p1" };
    await dom.update(createElement(GameView, props)); await dom.click("再来一局");
    props.view = { ...viewFixture(), gameId: "fresh-game" }; props.events = [];
    await dom.update(createElement(GameView, props));
    expect(dom.container.querySelectorAll('[role="dialog"]')).toHaveLength(0);
    expect(dom.text()).not.toContain("第 3 轮结算"); expect(dom.text()).not.toContain("正在开始新一局");
    expect(dom.text()).toContain("是否向其他玩家借款");
  });
  it("游戏结束时关闭原玩家抽屉，只保留可见的结束对话框", async () => {
    const { props } = propsFor("ACTION"); dom = await mountDom(createElement(GameView, props));
    await dom.click("查看其他玩家"); expect(dom.container.querySelectorAll('[role="dialog"]').length).toBe(1);
    props.view = { ...props.view, phase: "GAME_OVER", winnerId: "p1" };
    await dom.update(createElement(GameView, props));
    expect(dom.container.querySelectorAll('[role="dialog"]').length).toBe(1);
    expect(dom.container.querySelectorAll(".drawer").length).toBe(0);
    expect(dom.container.querySelector('[role="dialog"]')?.textContent).toContain("再来一局");
  });
});
