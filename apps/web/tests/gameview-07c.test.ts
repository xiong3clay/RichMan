import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GameView } from "../src/GameView";
import type { GameViewProps } from "../src/GameView";
import type { RichmanClient } from "../src/net/client";
import type { WirePrivateLoan, WireSnapshotView } from "../src/net/wire";
import { bankFixture, requestFixture, viewFixture } from "./view-fixtures";
import { mountDom } from "./dom-harness";

let mounted: Awaited<ReturnType<typeof mountDom>> | undefined;
afterEach(async () => {
  await mounted?.cleanup();
  mounted = undefined;
});

function clientSpies() {
  return {
    repayBank: vi.fn(() => "cmd-1"),
    repayPrivateLoan: vi.fn(() => "cmd-1"),
    collectPrivateLoan: vi.fn(() => "cmd-1"),
    decideBankDue: vi.fn(() => "cmd-1"),
    giveUpRescue: vi.fn(() => "cmd-1"),
    acceptPrivateLoan: vi.fn(() => "cmd-1"),
    submitBet: vi.fn(() => "cmd-1"),
    destroyRoom: vi.fn(() => true),
    hasJoined: true,
  };
}

function props(view: WireSnapshotView, client: ReturnType<typeof clientSpies>, hostId: string | null = null): GameViewProps {
  return {
    roomCode: "0042",
    hostId,
    view,
    status: "open",
    statusDetail: null,
    result: null,
    error: null,
    events: [],
    client: client as unknown as RichmanClient,
  };
}

function privateLoan(overrides: Partial<WirePrivateLoan> = {}): WirePrivateLoan {
  return {
    loanId: "p2p-1",
    requestId: "req-1",
    borrowerId: "p2",
    lenderId: "p1",
    principalCents: "1000",
    remainingCents: "1000",
    rateBps: 1000,
    issuedRound: 1,
    lastInterestRound: 1,
    status: "ACTIVE",
    ...overrides,
  };
}

function bankView(cents = "1000"): WireSnapshotView {
  const view = viewFixture();
  view.finance.cents = cents;
  view.me.cents = cents;
  view.finance.bankLoans = [{ ...bankFixture(), principalCents: "1000", remainingCents: "1000" }];
  return view;
}

function collectView(maxCents = "1000", cents = "1000"): WireSnapshotView {
  const view = viewFixture();
  view.finance.cents = cents;
  view.me.cents = cents;
  view.finance.privateLoans = [privateLoan()];
  view.finance.collectLimits = [{ loanId: "p2p-1", maxCents }];
  return view;
}

function inputValue(dom: Awaited<ReturnType<typeof mountDom>>, placeholder: string): string | undefined {
  return dom.container.querySelectorAll("input")
    .find(input => input.getAttribute("placeholder") === placeholder)?.value;
}

async function goToQ3(dom: Awaited<ReturnType<typeof mountDom>>): Promise<void> {
  await dom.click("跳过");
  await dom.click("不需要");
}

describe("07C 行动阶段返回链", () => {
  it("U1 Q4 无条件显示返回，点击回 Q3", async () => {
    mounted = await mountDom(createElement(GameView, props(bankView(), clientSpies())));
    await goToQ3(mounted);
    await mounted.click("跳过");
    expect(mounted.text()).toContain("结束行动？");
    await mounted.click("返回 Q3");
    expect(mounted.text()).toContain("是否还款或催收？");
  });

  it("T3 无债务 Q4 仍显示返回 Q3，并能回到 Q3", async () => {
    mounted = await mountDom(createElement(GameView, props(viewFixture(), clientSpies())));
    await goToQ3(mounted);
    await mounted.click("结束行动");
    expect(mounted.text()).toContain("结束行动？");
    await mounted.click("返回 Q3");
    expect(mounted.text()).toContain("是否还款或催收？");
    expect(mounted.text()).toContain("当前没有可还款或催收的贷款/合同。");
  });

  it("U2 Q2 有返回 Q1", async () => {
    mounted = await mountDom(createElement(GameView, props(viewFixture(), clientSpies())));
    await mounted.click("跳过");
    expect(mounted.text()).toContain("是否向银行借款？");
    await mounted.click("返回 Q1");
    expect(mounted.text()).toContain("是否向其他玩家借款？");
  });

  it("U3 空 Q3 显示说明 + 结束行动 + 返回 Q2", async () => {
    mounted = await mountDom(createElement(GameView, props(viewFixture(), clientSpies())));
    await goToQ3(mounted);
    expect(mounted.text()).toContain("当前没有可还款或催收的贷款/合同。");
    expect(mounted.text()).toContain("结束行动");
    await mounted.click("返回 Q2");
    expect(mounted.text()).toContain("是否向银行借款？");
  });
});

describe("07C 全部还款 / 全部催收（只填不提交）", () => {
  it("U4 金币足够时全部还款填入全额；不足时禁用并给原因", async () => {
    const client = clientSpies();
    mounted = await mountDom(createElement(GameView, props(bankView("1000"), client)));
    await goToQ3(mounted);
    await mounted.click("还银行贷款 1,000 分");
    const all = Array.from(mounted.container.querySelectorAll("button"))
      .find(button => button.textContent.includes("全部还款（1,000 分）"));
    expect(all?.disabled).toBe(false);
    await mounted.click("全部还款（1,000 分）");
    expect(inputValue(mounted, "金额（分）")).toBe("1000");
    expect(client.repayBank).not.toHaveBeenCalled();

    await mounted.cleanup();
    mounted = await mountDom(createElement(GameView, props(bankView("500"), clientSpies())));
    await goToQ3(mounted);
    await mounted.click("还银行贷款 1,000 分");
    const disabled = Array.from(mounted.container.querySelectorAll("button"))
      .find(button => button.textContent.includes("全部还款（1,000 分）"));
    expect(disabled?.disabled).toBe(true);
    expect(mounted.text()).toContain("金币 500 分不足 1,000 分，不能一次还清");
  });

  it("U5 全部催收可用时填入全额；对方不足时禁用并给原因", async () => {
    const client = clientSpies();
    mounted = await mountDom(createElement(GameView, props(collectView("1000"), client)));
    await goToQ3(mounted);
    await mounted.click("向 乙 催收 1,000 分");
    await mounted.click("全部催收（1,000 分）");
    expect(inputValue(mounted, "金额（分）")).toBe("1000");
    expect(client.collectPrivateLoan).not.toHaveBeenCalled();

    await mounted.cleanup();
    mounted = await mountDom(createElement(GameView, props(collectView("300"), clientSpies())));
    await goToQ3(mounted);
    await mounted.click("向 乙 催收 1,000 分");
    const disabled = Array.from(mounted.container.querySelectorAll("button"))
      .find(button => button.textContent.includes("全部催收（1,000 分）"));
    expect(disabled?.disabled).toBe(true);
    expect(mounted.text()).toContain("对方当前仅有 300 分，无法一次收清");
  });

  it("T4 私人还款也能全部还款并填入全额，不提交", async () => {
    const view = viewFixture();
    view.finance.cents = "1000";
    view.me.cents = "1000";
    view.finance.privateLoans = [privateLoan({ borrowerId: "p1", lenderId: "p2" })];
    const client = clientSpies();
    mounted = await mountDom(createElement(GameView, props(view, client)));
    await goToQ3(mounted);
    await mounted.click("还 乙 1,000 分");
    await mounted.click("全部还款（1,000 分）");
    expect(inputValue(mounted, "金额（分）")).toBe("1000");
    expect(client.repayPrivateLoan).not.toHaveBeenCalled();
  });

  it("T5 旧快照缺 collectLimits 时回退文案，按钮可点且只填不提交", async () => {
    const view = collectView("1000");
    delete (view.finance as { collectLimits?: unknown }).collectLimits;
    const client = clientSpies();
    mounted = await mountDom(createElement(GameView, props(view, client)));
    await goToQ3(mounted);
    await mounted.click("向 乙 催收 1,000 分");
    expect(mounted.text()).toContain("旧快照无法判断上限，以服务端为准");
    await mounted.click("全部催收（1,000 分）");
    expect(inputValue(mounted, "金额（分）")).toBe("1000");
    expect(client.collectPrivateLoan).not.toHaveBeenCalled();
  });

  it("U6 危险自救催收金额卡也能全部催收并填入全额", async () => {
    const view = collectView("1000");
    view.phase = "TAX";
    view.me.status = "DANGER";
    view.finance.cents = "-500";
    view.me.cents = "-500";
    const client = clientSpies();
    mounted = await mountDom(createElement(GameView, props(view, client)));
    await mounted.click("催收");
    await mounted.click("乙 欠你 1,000 分");
    await mounted.click("全部催收（1,000 分）");
    expect(inputValue(mounted, "催收金额（分）")).toBe("1000");
    expect(client.collectPrivateLoan).not.toHaveBeenCalled();
  });
});

describe("07C 六个确认卡都有返回且不发送命令", () => {
  it("abandonBet 返回不发送", async () => {
    const view = viewFixture(); view.phase = "BETTING";
    const client = clientSpies();
    mounted = await mountDom(createElement(GameView, props(view, client)));
    await mounted.click("放弃本轮下注");
    await mounted.click("返回");
    expect(mounted.text()).toContain("猜哪个点？");
    expect(client.submitBet).not.toHaveBeenCalled();
  });

  it("giveUp 返回不发送", async () => {
    const view = viewFixture(); view.phase = "TAX"; view.me.status = "DANGER"; view.finance.cents = "-500";
    const client = clientSpies();
    mounted = await mountDom(createElement(GameView, props(view, client)));
    await mounted.click("放弃自救");
    await mounted.click("返回");
    expect(mounted.text()).toContain("金币为负，需要自救");
    expect(client.giveUpRescue).not.toHaveBeenCalled();
  });

  it("acceptLoan 返回不发送", async () => {
    const view = viewFixture(); view.finance.incomingRequests = [requestFixture()];
    const client = clientSpies();
    mounted = await mountDom(createElement(GameView, props(view, client)));
    await mounted.click("同意借款");
    await mounted.click("返回");
    expect(mounted.text()).toContain("想向你借款");
    expect(client.acceptPrivateLoan).not.toHaveBeenCalled();
  });

  it("bankRepay 返回不发送", async () => {
    const view = viewFixture(); view.phase = "BANK_DUE"; view.finance.bankLoans = [bankFixture()];
    view.pendingDueLoanId = "bank-1";
    const client = clientSpies();
    mounted = await mountDom(createElement(GameView, props(view, client)));
    await mounted.clickAt("还款", 0);
    await mounted.click("返回");
    expect(mounted.text()).toContain("有一笔银行贷款已到期");
    expect(client.decideBankDue).not.toHaveBeenCalled();
  });

  it("bankRefuse 返回不发送", async () => {
    const view = viewFixture(); view.phase = "BANK_DUE"; view.finance.bankLoans = [bankFixture()];
    view.pendingDueLoanId = "bank-1";
    const client = clientSpies();
    mounted = await mountDom(createElement(GameView, props(view, client)));
    await mounted.click("拒绝还款");
    await mounted.click("返回");
    expect(mounted.text()).toContain("有一笔银行贷款已到期");
    expect(client.decideBankDue).not.toHaveBeenCalled();
  });
});

describe("07C 第二轮 M2：暂停时旧确认卡必须让位", () => {
  async function openThenPause(
    view: WireSnapshotView,
    open: () => Promise<void>,
    confirmText: string,
    pausedText = "等待继续对局",
  ) {
    const client = clientSpies();
    mounted = await mountDom(createElement(GameView, props(view, client, "p1")));
    await open();
    expect(mounted.text()).toContain(confirmText);
    await mounted.update(createElement(GameView, {
      ...props(view, client, "p1"), paused: true,
    }));
    expect(mounted.text()).toContain(pausedText);
    expect(mounted.text()).not.toContain(confirmText);
    return client;
  }

  it("M2-bankRepay：暂停后确认还款卡消失且不发命令", async () => {
    const view = viewFixture(); view.phase = "BANK_DUE";
    view.finance.bankLoans = [bankFixture()]; view.pendingDueLoanId = "bank-1";
    const client = await openThenPause(
      view,
      async () => { await mounted!.clickAt("还款", 0); },
      "确认还款？",
    );
    expect(client.decideBankDue).not.toHaveBeenCalled();
  });

  it("M2-giveUp：暂停后放弃自救确认卡消失且不发命令", async () => {
    const view = viewFixture(); view.phase = "TAX";
    view.me.status = "DANGER"; view.finance.cents = "-500"; view.me.cents = "-500";
    const client = await openThenPause(
      view,
      async () => { await mounted!.click("放弃自救"); },
      "确认放弃自救？",
    );
    expect(client.giveUpRescue).not.toHaveBeenCalled();
  });

  it("M2-abandonBet：暂停后放弃下注确认卡消失且不发命令", async () => {
    const view = viewFixture(); view.phase = "BETTING";
    const client = await openThenPause(
      view,
      async () => { await mounted!.click("放弃本轮下注"); },
      "放弃本轮下注？",
    );
    expect(client.submitBet).not.toHaveBeenCalled();
  });

  it("M2-acceptLoan：暂停后同意借款确认卡消失且不发命令", async () => {
    const view = viewFixture();
    view.finance.incomingRequests = [requestFixture()];
    const client = await openThenPause(
      view,
      async () => { await mounted!.click("同意借款"); },
      "确认同意借款？",
    );
    expect(client.acceptPrivateLoan).not.toHaveBeenCalled();
  });
});

describe("07C 房主销毁房间入口与确认", () => {
  it("U8 非房主看不到入口；房主可见；返回关闭且不发送", async () => {
    const guest = clientSpies();
    mounted = await mountDom(createElement(GameView, props(viewFixture(), guest, "p2")));
    expect(mounted.text()).not.toContain("销毁房间");

    await mounted.cleanup();
    const host = clientSpies();
    mounted = await mountDom(createElement(GameView, props(viewFixture(), host, "p1")));
    expect(mounted.text()).toContain("销毁房间");
    await mounted.click("销毁房间");
    expect(mounted.text()).toContain("销毁房间及数据？");
    expect(mounted.text()).toContain("房间内所有玩家会被移出，服务器上的存档将删除，无法恢复。");
    await mounted.click("返回");
    expect(mounted.text()).not.toContain("销毁房间及数据？");
    expect(host.destroyRoom).not.toHaveBeenCalled();
  });

  it("确认销毁会调用销毁入口", async () => {
    const client = clientSpies();
    const onDestroyRoom = vi.fn(() => true);
    const base = props(viewFixture(), client, "p1");
    mounted = await mountDom(createElement(GameView, { ...base, onDestroyRoom }));
    await mounted.click("销毁房间");
    await mounted.click("确认销毁（不可恢复）");
    expect(onDestroyRoom).toHaveBeenCalledTimes(1);
    expect(client.destroyRoom).not.toHaveBeenCalled();
  });

  it("S-F GAME_OVER 卡内第二入口也能打开确认卡，返回不发送", async () => {
    const view = viewFixture();
    view.phase = "GAME_OVER";
    view.winnerId = "p1";
    const onDestroyRoom = vi.fn(() => false);
    mounted = await mountDom(createElement(GameView, {
      ...props(view, clientSpies(), "p1"), onDestroyRoom,
    }));
    await mounted.click("销毁房间及数据");
    expect(mounted.text()).toContain("销毁房间及数据？");
    await mounted.click("返回");
    expect(mounted.text()).not.toContain("销毁房间及数据？");
    expect(onDestroyRoom).not.toHaveBeenCalled();
  });

  it("M1 GAME_OVER 下房主入口仍能打开确认卡，返回不发送", async () => {
    const view = viewFixture();
    view.phase = "GAME_OVER";
    view.winnerId = "p1";
    const onDestroyRoom = vi.fn(() => false);
    mounted = await mountDom(createElement(GameView, {
      ...props(view, clientSpies(), "p1"), onDestroyRoom,
    }));
    await mounted.clickAt("销毁房间", 0);
    expect(mounted.text()).toContain("销毁房间及数据？");
    await mounted.click("返回");
    expect(mounted.text()).not.toContain("销毁房间及数据？");
    expect(onDestroyRoom).not.toHaveBeenCalled();
  });

  it("M1 paused 下房主入口仍能打开确认卡，返回不发送", async () => {
    const onDestroyRoom = vi.fn(() => false);
    mounted = await mountDom(createElement(GameView, {
      ...props(viewFixture(), clientSpies(), "p1"), paused: true, onDestroyRoom,
    }));
    await mounted.click("销毁房间");
    expect(mounted.text()).toContain("销毁房间及数据？");
    await mounted.click("返回");
    expect(mounted.text()).toContain("等待继续对局");
    expect(onDestroyRoom).not.toHaveBeenCalled();
  });

  it("T8 非房主在 GAME_OVER / paused 下都看不到入口", async () => {
    const over = viewFixture(); over.phase = "GAME_OVER"; over.winnerId = "p1";
    mounted = await mountDom(createElement(GameView, props(over, clientSpies(), "p2")));
    expect(mounted.text()).not.toContain("销毁房间");

    await mounted.cleanup();
    mounted = await mountDom(createElement(GameView, {
      ...props(viewFixture(), clientSpies(), "p2"), paused: true,
    }));
    expect(mounted.text()).not.toContain("销毁房间");
  });

  it("S1 本地发送失败时确认关闭并显示未发送提示；成功则无提示", async () => {
    const onDestroyRoom = vi.fn(() => false);
    mounted = await mountDom(createElement(GameView, {
      ...props(viewFixture(), clientSpies(), "p1"), onDestroyRoom,
    }));
    await mounted.click("销毁房间");
    await mounted.click("确认销毁（不可恢复）");
    expect(mounted.text()).toContain("连接未就绪，销毁请求未发送");
    expect(mounted.text()).not.toContain("销毁房间及数据？");

    await mounted.cleanup();
    const ok = vi.fn(() => true);
    mounted = await mountDom(createElement(GameView, {
      ...props(viewFixture(), clientSpies(), "p1"), onDestroyRoom: ok,
    }));
    await mounted.click("销毁房间");
    await mounted.click("确认销毁（不可恢复）");
    expect(mounted.text()).not.toContain("连接未就绪，销毁请求未发送");
  });
});
