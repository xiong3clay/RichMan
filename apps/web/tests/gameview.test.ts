import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GameView } from "../src/GameView";
import type { GameViewProps } from "../src/GameView";
import type { RichmanClient, ConnectionStatus } from "../src/net/client";
import type { WireSnapshotView } from "../src/net/wire";
import { viewFixture, bankFixture, requestFixture } from "./view-fixtures";
import { mountDom } from "./dom-harness";

function render(view: WireSnapshotView, status: ConnectionStatus = "open", extra: Partial<GameViewProps> = {}): string {
  return renderToStaticMarkup(createElement(GameView, { roomCode: "0042", view,
    client: { hasJoined: true } as RichmanClient, status, statusDetail: null, result: null, error: null, events: [], ...extra }));
}
const phases = ["ACTION", "BETTING", "BANK_DUE", "TAX", "GAME_OVER"] as const;
function inPhase(phase: typeof phases[number]): WireSnapshotView {
  const v = viewFixture(); v.phase = phase;
  if (phase === "BANK_DUE") { v.finance.bankLoans = [bankFixture()]; v.pendingDueLoanId = "bank-1"; }
  if (phase === "TAX") { v.me.status = "DANGER"; v.finance.cents = "-500"; }
  return v;
}
describe("T4 单问题渲染", () => {
  it.each(phases)("%s只渲染一个向导和问题，没有05A常驻操作面板", phase => {
    const html = render(inPhase(phase));
    expect(html.match(/class="panel wizard"/g)).toHaveLength(1);
    expect(html.match(/class="question"/g)).toHaveLength(1);
    expect(html).not.toContain("active-panel");
    expect(html).not.toContain("金额不能超过现有金币");
  });
});
describe("T9 断线与替换", () => {
  it.each(["connecting", "closed", "replaced"] as const)("%s没有可提交操作", status => {
    for (const phase of phases) {
      const html = render(inPhase(phase), status);
      expect(html).not.toContain('class="choice ');
      expect(html).toContain(status === "replaced" ? "已在另一页面恢复" : "连接");
    }
  });
});
it("M3自动失信无需command_result也显示本人原因/永久失信/金币", () => {
  const v = viewFixture(); v.me.credit = "DEFAULTED";
  const html = render(v, "open", { events: [{ seq: 5, type: "BANK_LOAN_DEFAULTED", at: v.serverNow,
    payload: { borrowerId: "p1", reason: "insufficient_funds", originalCents: "1000" } }] });
  expect(html).toContain("永久"); expect(html).toContain("余额不足"); expect(html).toContain("10,000 分");
  expect(html).not.toContain("操作成功");
});
it("M4合并快照后请求已消失，仍从可见事件还原未成立通知", () => {
  const v = viewFixture();
  const html = render(v, "open", { events: [
    { seq: 5, type: "LOAN_REQUESTED", at: v.serverNow, payload: { requestId: "req-1", borrowerId: "p2", lenderId: "p1" } },
    { seq: 6, type: "LOAN_REQUEST_CLOSED", at: v.serverNow, payload: { requestId: "req-1", status: "FAILED" } },
  ] });
  expect(html).toContain("未成立"); expect(html).toContain("未转账"); expect(html).not.toContain("操作成功");
});
it("M6等待取消文案按ACTION/TAX分开", () => {
  const v = viewFixture(); const req = requestFixture(); req.borrowerId = "p1"; req.lenderId = "p2";
  v.finance.pendingRequest = req;
  expect(render(v)).toContain("取消会消耗本次行动，且不退还");
  v.phase = "TAX"; v.me.status = "DANGER";
  const html = render(v);
  expect(html).toContain("取消只关闭本次请求，自救继续，仍可再次发起");
  expect(html).not.toContain("取消会消耗本次行动");
});

function gameProps(view = viewFixture()): GameViewProps {
  return { roomCode: "0042", view, status: "open", statusDetail: null, result: null, error: null, events: [],
    client: { hasJoined: true, acceptPrivateLoan: () => "command-1", refusePrivateLoan: () => "command-1",
      cancelPrivateLoan: () => "command-1", decideBankDue: () => "command-1" } as unknown as RichmanClient };
}
function gameEvent(seq: number, type: string, payload: Record<string, unknown>) {
  return { seq, type, payload, at: "2026-11-04T00:00:00Z" };
}
const okResult = { type: "command_result" as const, commandId: "command-1", gameId: "render-game",
  gameVersion: 2, outcome: { ok: true as const } };
let mounted: Awaited<ReturnType<typeof mountDom>> | undefined;
afterEach(async () => { await mounted?.cleanup(); mounted = undefined; vi.useRealTimers(); });

describe("F1 命令结果与事件通知只显示一次", () => {
  it("ACCEPT FAILED 先事件后回执，整页只有一次未转账，关闭后回放不复活", async () => {
    const props = gameProps(); props.view.eventSeq = 4; props.view.finance.incomingRequests = [requestFixture()];
    mounted = await mountDom(createElement(GameView, props));
    await mounted.click("同意借款"); await mounted.click("确认同意并立即转账");
    props.view = viewFixture(); props.view.eventSeq = 5;
    props.events = [gameEvent(5, "LOAN_REQUEST_CLOSED", { requestId: "req-1", status: "FAILED" })];
    await mounted.update(createElement(GameView, props));
    expect(mounted.text().match(/未转账/g)).toHaveLength(1);
    props.result = okResult;
    await mounted.update(createElement(GameView, props));
    expect(mounted.text().match(/未转账/g)).toHaveLength(1);
    expect(mounted.text()).toContain("你的余额不足");
    await mounted.click("关闭");
    await mounted.update(createElement(GameView, { ...props, events: [...props.events] }));
    expect(mounted.text()).not.toContain("未转账");
  });

  it("BANK_DUE 先回执后失信事件，整页只出现一次永久失信", async () => {
    const props = gameProps(inPhase("BANK_DUE")); props.view.eventSeq = 4;
    mounted = await mountDom(createElement(GameView, props));
    await mounted.click("拒绝还款"); await mounted.click("确认拒绝并失信");
    props.result = okResult;
    await mounted.update(createElement(GameView, props));
    props.view = viewFixture(); props.view.eventSeq = 5;
    props.view.finance.bankLoans = [{ ...bankFixture(), status: "DEFAULTED" }];
    props.events = [gameEvent(5, "BANK_LOAN_DEFAULTED", { loanId: "bank-1", borrowerId: "p1", reason: "refused" })];
    await mounted.update(createElement(GameView, props));
    expect(mounted.text().match(/你已永久失信/g)).toHaveLength(1);
  });

  it.each(["REFUSED", "CANCELLED"])("%s 的本人命令只保留一条未转账结果", async status => {
    const props = gameProps(); props.view.eventSeq = 4; const req = requestFixture();
    if (status === "REFUSED") props.view.finance.incomingRequests = [req];
    else { req.borrowerId = "p1"; req.lenderId = "p2"; props.view.finance.pendingRequest = req; }
    mounted = await mountDom(createElement(GameView, props));
    await mounted.click(status === "REFUSED" ? "拒绝" : "取消请求");
    props.view = viewFixture(); props.view.eventSeq = 5;
    props.result = okResult; props.events = [gameEvent(5, "LOAN_REQUEST_CLOSED", { requestId: "req-1", status })];
    await mounted.update(createElement(GameView, props));
    expect(mounted.text().match(/未转账/g)).toHaveLength(1);
    expect(mounted.container.querySelectorAll(".banner button")).toHaveLength(1);
  });

  it("前一条同意的回执晚于后一次发送，仍按原commandId去重且不吞其他请求", async () => {
    const props = gameProps(); props.view.eventSeq = 4; props.view.finance.incomingRequests = [requestFixture()];
    props.client = { ...props.client, refusePrivateLoan: () => "command-2" } as unknown as RichmanClient;
    mounted = await mountDom(createElement(GameView, props));
    await mounted.click("同意借款"); await mounted.click("确认同意并立即转账");
    const req2 = { ...requestFixture(), requestId: "req-2" };
    props.view = { ...viewFixture(), eventSeq: 4 }; props.view.finance.incomingRequests = [req2];
    await mounted.update(createElement(GameView, props)); await mounted.click("拒绝");
    props.view = viewFixture(); props.result = okResult;
    props.events = [
      gameEvent(5, "LOAN_REQUEST_CLOSED", { requestId: "req-1", status: "FAILED" }),
      gameEvent(6, "LOAN_REQUEST_CLOSED", { requestId: "req-2", status: "REFUSED" }),
    ];
    await mounted.update(createElement(GameView, props));
    expect(mounted.text()).toContain("你的余额不足");
    expect(mounted.text().match(/未转账/g)).toHaveLength(2);
    expect(mounted.container.querySelector(".game-sticky .banner")?.textContent).toContain("未成立");
    expect(mounted.container.querySelector(".notice-shelf .banner")?.textContent).toContain("未转账");
  });
});

describe("F2 通知生命周期", () => {
  it("历史超过四条时仅显示最近四条关键失败", async () => {
    const props = gameProps(); props.events = Array.from({ length: 7 }, (_, i) =>
      gameEvent(i + 1, "BANK_LOAN_DEFAULTED", { loanId: "bank-" + i, borrowerId: "p1", reason: "reason-" + i }));
    mounted = await mountDom(createElement(GameView, props));
    expect(mounted.text().match(/你已永久失信/g)).toHaveLength(4);
    expect(mounted.text()).not.toContain("reason-2"); expect(mounted.text()).toContain("reason-3");
    expect(mounted.text()).toContain("reason-6");
  });
  it("关键失信在事件移出缓冲后仍保留，当前金币随快照更新", async () => {
    const props = gameProps(); props.events = [gameEvent(1, "BANK_LOAN_DEFAULTED", {
      loanId: "bank-1", borrowerId: "p1", reason: "timeout" })];
    mounted = await mountDom(createElement(GameView, props));
    expect(mounted.text()).toContain("当前金币 10,000 分");
    props.events = []; props.view = viewFixture(); props.view.finance.cents = "7654";
    await mounted.update(createElement(GameView, props));
    expect(mounted.text()).toContain("当前金币 7,654 分"); expect(mounted.text()).not.toContain("当前金币 10,000 分");
  });
  it("恢复后的请求先收到关闭快照、后收到事件时仍保留参与方归属", async () => {
    const props = gameProps(); const req = requestFixture(); req.borrowerId = "p1"; req.lenderId = "p2";
    props.view.finance.pendingRequest = req;
    mounted = await mountDom(createElement(GameView, props));
    props.view = { ...viewFixture(), eventSeq: 9 };
    await mounted.update(createElement(GameView, props));
    props.events = [gameEvent(8, "LOAN_REQUEST_CLOSED", { requestId: "req-1", status: "REFUSED" })];
    await mounted.update(createElement(GameView, props));
    expect(mounted.text()).toContain("借款请求被拒绝，未转账");
  });
  it("关闭通知后即使缓冲清空再回放，同一事件不重新弹出", async () => {
    const props = gameProps(); const events = [gameEvent(8, "BANK_LOAN_DEFAULTED", {
      loanId: "bank-1", borrowerId: "p1", reason: "timeout" })]; props.events = events;
    mounted = await mountDom(createElement(GameView, props)); await mounted.click("关闭");
    await mounted.update(createElement(GameView, { ...props, events: [] }));
    await mounted.update(createElement(GameView, { ...props, events }));
    expect(mounted.text()).not.toContain("你已永久失信");
  });
  it("DANGER_RESCUED 最多显示2.5秒，快照变更不重置TTL", async () => {
    vi.useFakeTimers(); const props = gameProps(); props.view.phase = "TAX";
    props.events = [gameEvent(8, "DANGER_RESCUED", { playerId: "p1", cents: "1500" })];
    props.view.finance.cents = "1500";
    mounted = await mountDom(createElement(GameView, props)); expect(mounted.text()).toContain("已解除危险");
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    props.view = { ...props.view, finance: { ...props.view.finance, cents: "1800" } };
    await mounted.update(createElement(GameView, props));
    expect(mounted.text()).toContain("当前金币 1,800 分");
    await act(async () => { await vi.advanceTimersByTimeAsync(501); });
    expect(mounted.text()).not.toContain("已解除危险");
  });
  it("离开TAX立即移除危险解除toast，重回TAX也不回放", async () => {
    const props = gameProps(); props.view.phase = "TAX";
    props.events = [gameEvent(8, "DANGER_RESCUED", { playerId: "p1", cents: "1500" })];
    mounted = await mountDom(createElement(GameView, props)); expect(mounted.text()).toContain("已解除危险");
    props.view = viewFixture(); await mounted.update(createElement(GameView, props));
    expect(mounted.text()).not.toContain("已解除危险");
    props.view = { ...props.view, phase: "TAX" }; await mounted.update(createElement(GameView, props));
    expect(mounted.text()).not.toContain("已解除危险");
  });
  it("合并快照直接跨到新TAX实例时，旧危险解除toast立即失效", async () => {
    const props = gameProps(); props.view.phase = "TAX"; props.view.phaseInstanceId = "tax-old";
    props.events = [gameEvent(8, "DANGER_RESCUED", { playerId: "p1", cents: "1500" })];
    mounted = await mountDom(createElement(GameView, props)); expect(mounted.text()).toContain("已解除危险");
    props.view = { ...props.view, phaseInstanceId: "tax-new" };
    await mounted.update(createElement(GameView, props));
    expect(mounted.text()).not.toContain("已解除危险");
  });
  it("TAX请求拒绝的通知跨阶段后不再声称自救继续", async () => {
    const props = gameProps(); props.view.phase = "TAX"; props.view.phaseInstanceId = "tax-old"; props.view.me.status = "DANGER";
    const req = requestFixture(); req.borrowerId = "p1"; req.lenderId = "p2"; props.view.finance.pendingRequest = req;
    mounted = await mountDom(createElement(GameView, props));
    props.view = { ...props.view, finance: { ...props.view.finance, pendingRequest: null } };
    props.events = [gameEvent(8, "LOAN_REQUEST_CLOSED", { requestId: "req-1", status: "REFUSED" })];
    await mounted.update(createElement(GameView, props)); expect(mounted.text()).toContain("自救继续");
    props.view = viewFixture(); props.events = []; await mounted.update(createElement(GameView, props));
    expect(mounted.text()).toContain("被拒绝"); expect(mounted.text()).not.toContain("自救继续");
    expect(mounted.text()).not.toContain("本次行动已用掉");
    props.view = { ...viewFixture(), phase: "TAX", phaseInstanceId: "tax-new" }; props.view.me.status = "DANGER";
    await mounted.update(createElement(GameView, props));
    expect(mounted.text()).toContain("被拒绝"); expect(mounted.text()).not.toContain("自救继续");
  });
  it.each(["FAILED", "REFUSED"])("关键%s通知超过toast时限仍保留直到手动关闭", async status => {
    vi.useFakeTimers(); const props = gameProps(); props.view.deadlineAt = null;
    props.events = [gameEvent(1, "LOAN_REQUESTED", { requestId: "req-1", borrowerId: "p1", lenderId: "p2" }),
      gameEvent(2, "LOAN_REQUEST_CLOSED", { requestId: "req-1", status })];
    mounted = await mountDom(createElement(GameView, props));
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(mounted.text()).toContain("未转账"); await mounted.click("关闭");
    expect(mounted.text()).not.toContain("未转账");
  });
});

it("50%提示实际出现在本人面板、银行问题和银行金额页，禁借时本人面板显示原因", async () => {
  const props = gameProps(); mounted = await mountDom(createElement(GameView, props));
  const hint = "普通贷款上限为当前金币的 50%，最终以服务端为准";
  expect(mounted.text()).toContain(hint); await mounted.click("跳过");
  expect(mounted.text().split(hint)).toHaveLength(3); await mounted.click("是，输入金额");
  expect(mounted.text()).toContain("向银行借多少？"); expect(mounted.text().split(hint)).toHaveLength(3);
  props.view = viewFixture(); props.view.me.credit = "DEFAULTED";
  await mounted.update(createElement(GameView, props));
  expect(mounted.container.querySelector(".self-panel")?.textContent).toContain("你已失信，不能新增普通银行贷款");
  expect(mounted.container.querySelector(".self-panel")?.textContent).not.toContain(hint);
});

it("F3 到期结果横幅与失信事件都在顶部吸顶区，兜底文案不指向上方", async () => {
  const props = gameProps(inPhase("BANK_DUE")); props.view.eventSeq = 4;
  mounted = await mountDom(createElement(GameView, props));
  await mounted.click("拒绝还款"); await mounted.click("确认拒绝并失信");
  props.result = okResult;
  props.events = [gameEvent(5, "BANK_LOAN_DEFAULTED", { loanId: "another-bank", borrowerId: "p1", reason: "timeout" })];
  await mounted.update(createElement(GameView, props));
  const resultBanner = mounted.container.querySelector(".game-sticky .banner");
  const shelfBanners = mounted.container.querySelectorAll(".notice-shelf .banner");
  expect(shelfBanners).toHaveLength(1);
  expect(resultBanner?.textContent).toContain("到期决策已提交");
  expect(shelfBanners[0]?.textContent).toContain("到期超时未处理");
  expect(resultBanner?.textContent).not.toContain("上方");
  expect(mounted.container.querySelector(".stage .banner")).toBeNull();
});
it("status=open但hasJoined=false时五阶段操作区均无提交按钮", () => {
  for (const phase of phases) {
    const html = render(inPhase(phase), "open", { client: { hasJoined: false } as RichmanClient });
    expect(html).not.toContain('class="choice '); expect(html).toContain("连接恢复后才能继续操作");
  }
});

it("F4 只有DEFAULTED债务和全局计息事件时，跨轮结算卡不渲染利息行", async () => {
  const props = gameProps(); props.view.round = 3;
  props.view.finance.bankLoans = [{ ...bankFixture(), status: "DEFAULTED" }];
  mounted = await mountDom(createElement(GameView, props));
  props.view = { ...props.view, round: 4, phaseInstanceId: "round4-action" };
  props.events = [gameEvent(1, "INTEREST_ACCRUED", { round: 3 }), gameEvent(2, "ROUND_STARTED", { round: 4 })];
  await mounted.update(createElement(GameView, props));
  expect(mounted.text()).toContain("第 3 轮");
  expect(mounted.text()).not.toContain("本轮有贷款计息");
  expect(mounted.container.querySelectorAll(".overlay-card")).toHaveLength(1);
  expect(mounted.text()).toContain("本轮没有利息、税或下注结算事件");
});

const failResult = { type: "command_result" as const, commandId: "command-1", gameId: "render-game",
  gameVersion: 2, outcome: { ok: false as const, code: "INVALID_AMOUNT", message: "金额超过可借上限" } };

/** 直接子节点的 class 序列，用于断言操作区确实在 .self-panel 之后。 */
function directChildClasses(element: NonNullable<ReturnType<Awaited<ReturnType<typeof mountDom>>["container"]["querySelector"]>>): string[] {
  const nodes = (element as unknown as { childNodes: Array<{ className?: string }> }).childNodes;
  return Array.from(nodes, node => node.className ?? "");
}

async function goToBankAmount(dom: Awaited<ReturnType<typeof mountDom>>): Promise<void> {
  await dom.click("跳过");
  await dom.click("是，输入金额");
}

describe("05E 移动端提示可见性", () => {
  it("R1 借款失败结果横幅在 .game-sticky 吸顶区内，滚动到操作卡后仍可见", async () => {
    const props = gameProps();
    props.client = { ...props.client, borrowBank: () => "command-1" } as unknown as RichmanClient;
    mounted = await mountDom(createElement(GameView, props));
    await goToBankAmount(mounted);
    await mounted.input("借款金额（分）", "13000");
    await mounted.click("确认借款");
    props.result = failResult;
    await mounted.update(createElement(GameView, props));

    const sticky = mounted.container.querySelector(".game-sticky");
    const stickyBanner = sticky?.querySelector(".banner");
    expect(stickyBanner?.textContent).toContain("INVALID_AMOUNT");
    expect(stickyBanner?.textContent).toContain("金额超过可借上限");
    // header 之后紧跟结果横幅，保证吸顶区把错误显示在折叠线以上
    const stickyChildren = directChildClasses(sticky!);
    expect(stickyChildren.indexOf("game-top")).toBeLessThan(stickyChildren.indexOf("banner fail"));

    const game = mounted.container.querySelector(".game");
    expect(game).not.toBeNull();
    const classes = directChildClasses(game!);
    expect(classes.indexOf("game-sticky")).toBeLessThan(classes.indexOf("panel self-panel"));
    expect(classes.indexOf("stage")).toBeGreaterThan(classes.indexOf("panel self-panel"));
    expect(mounted.container.querySelector(".stage .banner")).toBeNull();
  });

  it("R1 本地校验失败 notice 同样进入吸顶区可见", async () => {
    mounted = await mountDom(createElement(GameView, gameProps()));
    await goToBankAmount(mounted);
    await mounted.input("借款金额（分）", "0");
    await mounted.click("确认借款");
    expect(mounted.container.querySelector(".game-sticky .banner")?.textContent).toContain("借款金额必须是大于 0");
    expect(mounted.container.querySelector(".stage .banner")).toBeNull();
  });

  it("R2 事件提示在 .notice-shelf 常驻，跨阶段保留，关闭后消失", async () => {
    const props = gameProps();
    props.events = [
      gameEvent(5, "LOAN_REQUESTED", { requestId: "req-1", borrowerId: "p1", lenderId: "p2" }),
      gameEvent(6, "LOAN_REQUEST_CLOSED", { requestId: "req-1", status: "REFUSED" }),
    ];
    mounted = await mountDom(createElement(GameView, props));
    expect(mounted.container.querySelector(".notice-shelf .banner")?.textContent).toContain("被拒绝");

    props.view = { ...viewFixture(), phase: "BETTING", phaseInstanceId: "round1-bet-1" };
    await mounted.update(createElement(GameView, props));
    expect(mounted.container.querySelector(".notice-shelf .banner")?.textContent).toContain("被拒绝");

    await mounted.click("关闭");
    expect(mounted.container.querySelector(".notice-shelf")).toBeNull();
  });

  it("R2 无事件提示时不渲染 .notice-shelf 占位", async () => {
    mounted = await mountDom(createElement(GameView, gameProps()));
    expect(mounted.container.querySelector(".notice-shelf")).toBeNull();
  });

  it("R2 header、结果横幅与通知架同处 .game-sticky，顺序为 header→横幅→通知架", async () => {
    const props = gameProps();
    props.view.eventSeq = 4;
    props.events = [
      gameEvent(5, "LOAN_REQUESTED", { requestId: "req-1", borrowerId: "p1", lenderId: "p2" }),
      gameEvent(6, "LOAN_REQUEST_CLOSED", { requestId: "req-1", status: "REFUSED" }),
    ];
    mounted = await mountDom(createElement(GameView, props));
    expect(mounted.container.querySelector(".notice-shelf")).not.toBeNull();
    await goToBankAmount(mounted);
    await mounted.input("借款金额（分）", "0");
    await mounted.click("确认借款");
    const sticky = mounted.container.querySelector(".game-sticky");
    expect(sticky).not.toBeNull();
    expect(sticky?.querySelector(".game-top")).not.toBeNull();
    const classes = directChildClasses(sticky!);
    expect(classes.indexOf("game-top")).toBeGreaterThanOrEqual(0);
    expect(classes.indexOf("game-top")).toBeLessThan(classes.indexOf("banner fail"));
    expect(classes.indexOf("banner fail")).toBeLessThan(classes.indexOf("notice-shelf"));
    expect(mounted.container.querySelector(".stage .banner")).toBeNull();
  });
});
