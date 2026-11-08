import { act, createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GameView } from "../src/GameView";
import type { GameViewProps } from "../src/GameView";
import type { RichmanClient } from "../src/net/client";
import type { WireLoanRequest, WirePublicPlayer, WireSnapshotView } from "../src/net/wire";
import { requestFixture, viewFixture } from "./view-fixtures";
import { mountDom } from "./dom-harness";

let mounted: Awaited<ReturnType<typeof mountDom>> | undefined;
afterEach(async () => {
  await mounted?.cleanup();
  mounted = undefined;
  vi.useRealTimers();
});

function clientSpies() {
  return {
    acceptPrivateLoan: vi.fn(() => "cmd-accept"),
    refusePrivateLoan: vi.fn(() => "cmd-refuse"),
    cancelPrivateLoan: vi.fn(() => "cmd-cancel"),
    hasJoined: true,
  };
}
type ClientSpies = ReturnType<typeof clientSpies>;

function props(view: WireSnapshotView, client: ClientSpies): GameViewProps {
  return {
    roomCode: "0042",
    hostId: null,
    view,
    status: "open",
    statusDetail: null,
    result: null,
    error: null,
    events: [],
    client: client as unknown as RichmanClient,
  };
}

function freezeAt(view: WireSnapshotView): void {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(view.serverNow));
}

function requestAt(view: WireSnapshotView, id: string, borrowerId: string, offsetMs: number): WireLoanRequest {
  return {
    ...requestFixture(),
    requestId: id,
    borrowerId,
    lenderId: "p1",
    deadlineMs: Date.parse(view.serverNow) + offsetMs,
  };
}

function lenderView(requests: WireLoanRequest[], deadlineAt?: string | null): WireSnapshotView {
  const view = viewFixture();
  view.finance.incomingRequests = requests;
  if (deadlineAt !== undefined) view.deadlineAt = deadlineAt;
  return view;
}

function borrowerView(offsetMs: number, deadlineAt?: string | null): WireSnapshotView {
  const view = viewFixture();
  view.finance.pendingRequest = {
    ...requestFixture(),
    borrowerId: "p1",
    lenderId: "p2",
    deadlineMs: Date.parse(view.serverNow) + offsetMs,
  };
  if (deadlineAt !== undefined) view.deadlineAt = deadlineAt;
  return view;
}

function buttonAt(dom: Awaited<ReturnType<typeof mountDom>>, text: string) {
  const buttons = dom.container.querySelectorAll("button").filter(button => button.textContent.includes(text));
  expect(buttons).toHaveLength(1);
  return buttons[0]!;
}

/** 只看当前步骤卡；页头“剩余”仍按 view.deadlineAt，不能整页搜 0:10。 */
function stepCardText(dom: Awaited<ReturnType<typeof mountDom>>): string {
  const cards = dom.container.querySelectorAll("section.panel.wizard");
  expect(cards).toHaveLength(1);
  return cards[0]!.textContent;
}

async function advance(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

const THIRD_PLAYER: WirePublicPlayer = {
  playerId: "p3",
  seatId: 3,
  nickname: "丙",
  credit: "GOOD",
  status: "ALIVE",
  alive: true,
  defaultedBankDebtCents: "0",
};

describe("10B 出借人请求卡", () => {
  it("T4 两笔请求显示共 2 个，倒计时用 request.deadlineMs 的 0:45 而不是 view.deadlineAt 的 0:10", async () => {
    const first = requestAt(viewFixture(), "req-1", "p2", 45_000);
    const second = { ...requestAt(viewFixture(), "req-2", "p3", 50_000), principalCents: "777" };
    const view = lenderView([first, second]);
    view.publicPlayers.push(THIRD_PLAYER);
    view.deadlineAt = new Date(Date.parse(view.serverNow) + 10_000).toISOString();
    freezeAt(view);
    mounted = await mountDom(createElement(GameView, props(view, clientSpies())));
    const card = stepCardText(mounted);
    expect(card).toContain("待答复请求：共 2 个，当前第 1 个；答复后自动出现下一笔。");
    expect(card).toContain("请求截止：0:45");
    expect(card).not.toContain("0:10");
    expect(card).toContain("乙 想向你借款");
    expect(card).toContain("金额 500 分");
    expect(card).not.toContain("丙");
    expect(card).not.toContain("777");
    expect(mounted.text()).not.toContain("丙");
    expect(mounted.text()).not.toContain("777");
    expect(mounted.text()).toContain("剩余 0:10");
  });

  it("T5 过期请求显示已截止，同意/拒绝 disabled 且点击不产生命令", async () => {
    const client = clientSpies();
    const view = lenderView([requestAt(viewFixture(), "req-1", "p2", -1000)]);
    freezeAt(view);
    mounted = await mountDom(createElement(GameView, props(view, client)));
    expect(mounted.text()).toContain("已截止，等待系统收口");
    expect(buttonAt(mounted, "同意借款").disabled).toBe(true);
    expect(buttonAt(mounted, "拒绝").disabled).toBe(true);
    await mounted.clickUnchecked("同意借款");
    await mounted.clickUnchecked("拒绝");
    expect(client.acceptPrivateLoan).not.toHaveBeenCalled();
    expect(client.refusePrivateLoan).not.toHaveBeenCalled();
    expect(mounted.text()).not.toContain("确认同意借款？");
  });

  it("T10 第一笔答复后切换第二笔，显示新借款人并恢复可操作，不残留第一笔", async () => {
    const baseView = viewFixture();
    baseView.publicPlayers.push(THIRD_PLAYER);
    const first = requestAt(baseView, "req-1", "p2", 45_000);
    const second = requestAt(baseView, "req-2", "p3", 45_000);
    const client = clientSpies();
    const view = lenderView([first, second]);
    view.publicPlayers.push(THIRD_PLAYER);
    freezeAt(view);
    mounted = await mountDom(createElement(GameView, props(view, client)));
    expect(mounted.text()).toContain("乙 想向你借款");
    expect(mounted.text()).toContain("共 2 个");
    await mounted.click("拒绝");
    expect(client.refusePrivateLoan).toHaveBeenCalledTimes(1);
    const next = { ...view, finance: { ...view.finance, incomingRequests: [second] } };
    await mounted.update(createElement(GameView, props(next, client)));
    expect(mounted.text()).toContain("丙 想向你借款");
    expect(mounted.text()).toContain("待答复请求：共 1 个，当前第 1 个；答复后自动出现下一笔。");
    expect(mounted.text()).not.toContain("乙 想向你借款");
    expect(buttonAt(mounted, "同意借款").disabled).toBe(false);
    expect(buttonAt(mounted, "拒绝").disabled).toBe(false);
  });

  it("T11 view.deadlineAt=null 时仍显示请求倒计时且按钮可用", async () => {
    const view = lenderView([requestAt(viewFixture(), "req-1", "p2", 45_000)], null);
    freezeAt(view);
    mounted = await mountDom(createElement(GameView, props(view, clientSpies())));
    expect(mounted.text()).toContain("请求截止：0:45");
    expect(buttonAt(mounted, "同意借款").disabled).toBe(false);
    expect(buttonAt(mounted, "拒绝").disabled).toBe(false);
  });

  it("T11b 借款人卡在 view.deadlineAt=null 时仍显示 0:45，取消可用且页头为 —", async () => {
    const view = borrowerView(45_000, null);
    freezeAt(view);
    mounted = await mountDom(createElement(GameView, props(view, clientSpies())));
    expect(stepCardText(mounted)).toContain("请求截止：0:45");
    expect(buttonAt(mounted, "取消请求").disabled).toBe(false);
    expect(mounted.text()).toContain("剩余 —");
  });
});

describe("10B 借款人等待卡", () => {
  it("T6a 借款人倒计时用 pendingRequest.deadlineMs 的 0:45，而不是 view.deadlineAt 的 0:10", async () => {
    const view = borrowerView(45_000);
    view.deadlineAt = new Date(Date.parse(view.serverNow) + 10_000).toISOString();
    freezeAt(view);
    mounted = await mountDom(createElement(GameView, props(view, clientSpies())));
    const card = stepCardText(mounted);
    expect(card).toContain("请求截止：0:45");
    expect(card).not.toContain("0:10");
    expect(mounted.text()).toContain("剩余 0:10");
  });

  it("T6b 借款人过期显示已截止，取消请求 disabled 且点击不产生命令", async () => {
    const client = clientSpies();
    const view = borrowerView(-1000);
    freezeAt(view);
    mounted = await mountDom(createElement(GameView, props(view, client)));
    expect(mounted.text()).toContain("已截止，等待系统收口");
    expect(buttonAt(mounted, "取消请求").disabled).toBe(true);
    await mounted.clickUnchecked("取消请求");
    expect(client.cancelPrivateLoan).not.toHaveBeenCalled();
  });
});

describe("10B 实时过期与确认撤回", () => {
  it("T7 挂载后 1.1 秒变已截止，同意/拒绝/取消全部 disabled", async () => {
    const lenderClient = clientSpies();
    const lender = lenderView([requestAt(viewFixture(), "req-1", "p2", 1000)]);
    freezeAt(lender);
    mounted = await mountDom(createElement(GameView, props(lender, lenderClient)));
    expect(buttonAt(mounted, "同意借款").disabled).toBe(false);
    expect(buttonAt(mounted, "拒绝").disabled).toBe(false);
    await advance(1100);
    expect(mounted.text()).toContain("已截止，等待系统收口");
    expect(buttonAt(mounted, "同意借款").disabled).toBe(true);
    expect(buttonAt(mounted, "拒绝").disabled).toBe(true);

    await mounted.cleanup();
    mounted = undefined;
    vi.setSystemTime(new Date(lender.serverNow));
    const borrowerClient = clientSpies();
    const borrower = borrowerView(1000);
    mounted = await mountDom(createElement(GameView, props(borrower, borrowerClient)));
    expect(buttonAt(mounted, "取消请求").disabled).toBe(false);
    await advance(1100);
    expect(mounted.text()).toContain("已截止，等待系统收口");
    expect(buttonAt(mounted, "取消请求").disabled).toBe(true);
  });

  it("T8 同意借款确认卡在过期时自动撤回，accept 未被调用", async () => {
    const client = clientSpies();
    const view = lenderView([requestAt(viewFixture(), "req-1", "p2", 1000)]);
    freezeAt(view);
    mounted = await mountDom(createElement(GameView, props(view, client)));
    await mounted.click("同意借款");
    expect(mounted.text()).toContain("确认同意借款？");
    expect(client.acceptPrivateLoan).not.toHaveBeenCalled();
    await advance(1100);
    expect(mounted.text()).not.toContain("确认同意借款？");
    expect(mounted.text()).toContain("已截止，等待系统收口");
    expect(client.acceptPrivateLoan).not.toHaveBeenCalled();
  });
});

describe("10B 行动等待文案", () => {
  it("T9 acted=true 且 currentSeatId=null 显示本轮行动已结束，不再显示即将结束", async () => {
    const view = viewFixture();
    view.phase = "ACTION";
    view.currentSeatId = null;
    view.actedSeats = [view.me.seatId];
    mounted = await mountDom(createElement(GameView, props(view, clientSpies())));
    expect(mounted.text()).toContain("本轮行动已结束");
    expect(mounted.text()).toContain("正在等待未答复的借款请求收口；全部答复或到期后自动进入下注。");
    expect(mounted.text()).not.toContain("本轮行动即将结束");
  });
});
