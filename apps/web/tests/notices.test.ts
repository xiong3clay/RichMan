import { describe, expect, it } from "vitest";
import { deriveEventNotices, rememberLoanRequests } from "../src/game/notices.js";
import { commandSuccessText } from "../src/game/results.js";
import { createNoticeHistory, coverCommandNotices, dismissEventNotice, updateNoticeHistory } from "../src/game/notice-history.js";
import type { WireGameEvent, WireSnapshotView } from "../src/net/wire.js";

const ACTION = { phase: "ACTION" as const, currentCents: "3000" };
const KNOWN = { "req-1": { borrowerId: "p1", lenderId: "p2" } };

function event(seq: number, type: string, payload: Record<string, unknown>): WireGameEvent {
  return { seq, type, at: "2026-11-04T00:00:00.000Z", payload };
}

function closed(status: string): WireGameEvent[] {
  return [event(5, "LOAN_REQUEST_CLOSED", { requestId: "req-1", status })];
}

describe("05C T5：借款结果归属与双方通知", () => {
  it("FAILED 出借人看到自己的余额不足，并明确未转账", () => {
    const notice = deriveEventNotices(closed("FAILED"), "p2", KNOWN, ACTION)[0]!;
    expect(notice.text).toContain("你的余额不足");
    expect(notice.text).toContain("未成立，未转账");
    expect(notice.text).not.toContain("对方余额不足");
    expect(notice.text).not.toContain("操作成功");
  });

  it("FAILED 借款人看到出借人余额不足、未转账与行动已用掉", () => {
    const notice = deriveEventNotices(closed("FAILED"), "p1", KNOWN, ACTION)[0]!;
    expect(notice.text).toContain("对方余额不足");
    expect(notice.text).toContain("未转账");
    expect(notice.text).toContain("本次行动已用掉");
  });

  it("REFUSED 给出借人已拒绝提示", () => {
    const notice = deriveEventNotices(closed("REFUSED"), "p2", KNOWN, ACTION)[0]!;
    expect(notice?.text).toContain("你已拒绝");
    expect(notice?.text).toContain("未转账");
  });

  it.each(["p1", "p2"])("CANCELLED 给参与方 %s 明确取消且未转账", (viewerId) => {
    const notice = deriveEventNotices(closed("CANCELLED"), viewerId, KNOWN, ACTION)[0]!;
    expect(notice?.text).toContain("已取消");
    expect(notice?.text).toContain("未转账");
    if (viewerId === "p1") expect(notice?.text).toContain("本次行动已用掉");
  });

  it.each(["FAILED", "REFUSED", "CANCELLED"])("%s 不通知第三人或猜测未知请求身份", (status) => {
    expect(deriveEventNotices(closed(status), "p3", KNOWN, ACTION)).toEqual([]);
    expect(deriveEventNotices(closed(status), "p1", {}, ACTION)).toEqual([]);
    expect(deriveEventNotices([
      event(4, "LOAN_REQUESTED", { requestId: "req-1", borrowerId: "p1" }),
      ...closed(status),
    ], "p1", {}, ACTION)).toEqual([]);
  });

  it("合并快照已无请求，仍从历史 LOAN_REQUESTED 取得双方归属", () => {
    const events = [
      event(1, "PHASE_CHANGED", { phase: "ACTION" }),
      event(2, "LOAN_REQUESTED", { requestId: "req-1", borrowerId: "p1", lenderId: "p2" }),
      ...closed("FAILED"),
    ];
    expect(deriveEventNotices(events, "p1", {}, ACTION)[0]?.text).toContain("未成立");
    expect(deriveEventNotices(events, "p2", {}, ACTION)[0]?.text).toContain("未转账");
    expect(deriveEventNotices(events, "p3", {}, ACTION)).toEqual([]);
  });

  it("ACTION 请求结果到达时快照已 TAX，仍告知行动已用掉", () => {
    const events = [
      event(1, "PHASE_CHANGED", { phase: "ACTION" }),
      event(2, "LOAN_REQUESTED", { requestId: "req-1", borrowerId: "p1", lenderId: "p2" }),
      ...closed("REFUSED"),
      event(6, "PHASE_CHANGED", { phase: "TAX" }),
    ];
    expect(deriveEventNotices(events, "p1", {}, { ...ACTION, phase: "TAX" })[0]?.text)
      .toContain("本次行动已用掉");
  });

  it.each(["FAILED", "REFUSED", "CANCELLED", "EXPIRED"])("TAX %s 请求在后续 ACTION 快照中不再声称自救继续", (status) => {
    const events = [
      event(1, "PHASE_CHANGED", { phase: "TAX" }),
      event(2, "LOAN_REQUESTED", { requestId: "req-1", borrowerId: "p1", lenderId: "p2" }),
      status === "EXPIRED"
        ? event(5, "LOAN_REQUEST_EXPIRED", { requestId: "req-1" })
        : closed(status)[0]!,
      event(6, "PHASE_CHANGED", { phase: "ACTION" }),
    ];
    const notice = deriveEventNotices(events, "p1", {}, ACTION)[0]!;
    expect(notice?.text).toContain("自救请求已结束");
    expect(notice?.text).not.toContain("自救继续");
    expect(notice?.text).not.toContain("行动已用掉");
  });

  it("EXPIRED 通知双方，未知请求和第三人不显示", () => {
    const events = [event(5, "LOAN_REQUEST_EXPIRED", { requestId: "req-1" })];
    expect(deriveEventNotices(events, "p1", KNOWN, ACTION)[0]?.text).toContain("已过期");
    expect(deriveEventNotices(events, "p2", KNOWN, ACTION)[0]?.text).toContain("已过期");
    expect(deriveEventNotices(events, "p3", KNOWN, ACTION)).toEqual([]);
    expect(deriveEventNotices(events, "p1", {}, ACTION)).toEqual([]);
  });

  it("请求从快照消失且创建事件移出窗口后，已记忆归属仍能定向提示", () => {
    const known = rememberLoanRequests({}, [
      event(1, "PHASE_CHANGED", { phase: "TAX" }),
      event(2, "LOAN_REQUESTED", { requestId: "req-1", borrowerId: "p1", lenderId: "p2" }),
    ]);
    expect(deriveEventNotices(closed("CANCELLED"), "p1", known, ACTION)[0]?.text).toContain("自救请求已结束");
    expect(deriveEventNotices(closed("CANCELLED"), "p3", known, ACTION)).toEqual([]);
  });

  it("从本人待处理快照记忆双方和自救阶段，关闭后不丢失且不修改输入", () => {
    const view = viewWithLoan();
    view.phase = "TAX";
    view.finance.pendingRequest = {
      requestId: "req-1", borrowerId: "p1", lenderId: "p2", principalCents: "5000", rateBps: 1000,
      createdRound: 4, createdAtMs: 1000, deadlineMs: 5000, status: "PENDING",
      borrowerCredit: "GOOD", borrowerDefaultedBankDebtCents: "0",
    };
    const empty = {};
    const known = rememberLoanRequests(empty, [], view);
    expect(empty).toEqual({});
    view.finance.pendingRequest = null;
    view.phase = "ACTION";
    const after = rememberLoanRequests(known, [], view);
    expect(deriveEventNotices(closed("REFUSED"), "p1", after, ACTION)[0]?.text).toContain("自救请求已结束");
  });

  it.each(["p1", "p2"])("CLOSED(EXPIRED) 也向参与方 %s 说明过期而未转账", (viewerId) => {
    expect(deriveEventNotices(closed("EXPIRED"), viewerId, KNOWN, ACTION)[0]?.text).toContain("已过期，未转账");
  });
});

describe("05C T5：银行失信与危险解除只提示本人", () => {
  it.each([
    ["insufficient_funds", "余额不足"],
    ["timeout", "超时"],
    ["refused", "拒绝还款"],
    ["bankrupt", "破产"],
  ])("BANK_LOAN_DEFAULTED %s 保留原因、永久失信与快照金币", (reason, label) => {
    const events = [event(8, "BANK_LOAN_DEFAULTED", { borrowerId: "p1", reason, originalCents: "5000" })];
    const notice = deriveEventNotices(events, "p1", {}, ACTION)[0]!;
    expect(notice.text).toContain(label);
    expect(notice.text).toContain("永久失信");
    expect(notice.text).toContain("当前金币 3,000 分");
    expect(notice.tone).toBe("danger");
    expect(deriveEventNotices(events, "p2", {}, ACTION)).toEqual([]);
  });

  it("DANGER_RESCUED 使用本人服务端金额，忽略其他人的事件", () => {
    const events = [
      event(9, "DANGER_RESCUED", { playerId: "p2" }),
      event(10, "DANGER_RESCUED", { playerId: "p1", cents: "1500" }),
    ];
    expect(deriveEventNotices(events, "p1", {}, { phase: "TAX", currentCents: "1500" })).toEqual([
      { id: 10, tone: "info", text: "已解除危险，当前金币 1,500 分。" },
    ]);
    expect(deriveEventNotices(events, "p1", {}, ACTION)).toEqual([]);
  });
});

it("同请求的EXPIRED与CLOSED双事件按requestId和seq只保留最新通知", () => {
  const notices = deriveEventNotices([
    event(5, "LOAN_REQUEST_EXPIRED", { requestId: "req-1" }),
    event(6, "LOAN_REQUEST_CLOSED", { requestId: "req-1", status: "EXPIRED" }),
  ], "p1", KNOWN, ACTION);
  expect(notices).toHaveLength(1); expect(notices[0]?.id).toBe(6);
});

it("成立与到期结清的真实终态事件回收覆盖记录，不生成额外通知", () => {
  const accepted = createNoticeHistory();
  coverCommandNotices(accepted, { commandId: "accept-1", kind: "accept", requestId: "req-1", afterEventSeq: 4 });
  expect(updateNoticeHistory(accepted, [event(5, "PRIVATE_LOAN_ACCEPTED", { requestId: "req-1" })],
    "p1", KNOWN, ACTION, 0).notices).toEqual([]);
  expect(accepted.covered.size).toBe(0);
  const settled = createNoticeHistory();
  coverCommandNotices(settled, { commandId: "due-1", kind: "bankDue", loanId: "bank-1", afterEventSeq: 4 });
  expect(updateNoticeHistory(settled, [event(5, "BANK_LOAN_SETTLED", { loanId: "bank-1" })],
    "p1", {}, ACTION, 0).notices).toEqual([]);
  expect(settled.covered.size).toBe(0);
});

it("已关闭id离开缓冲后清理dismissed Set，旧seq回放仍不重新入队", () => {
  const history = createNoticeHistory();
  const events = [event(5, "BANK_LOAN_DEFAULTED", { loanId: "bank-1", borrowerId: "p1", reason: "timeout" })];
  updateNoticeHistory(history, events, "p1", {}, ACTION, 0);
  dismissEventNotice(history, 5);
  expect(history.dismissed).toBeInstanceOf(Set); expect(history.records.size).toBe(0);
  updateNoticeHistory(history, [], "p1", {}, ACTION, 1);
  expect(history.dismissed.size).toBe(0);
  expect(updateNoticeHistory(history, events, "p1", {}, ACTION, 2).notices).toEqual([]);
});

function viewWithLoan(status: "ACTIVE" | "REPAID" | "DEFAULTED" = "ACTIVE"): WireSnapshotView {
  return {
    schemaVersion: 1, gameId: "g1", version: 10, round: 4, phase: "ACTION",
    serverNow: "2026-11-04T00:00:00.000Z", deadlineAt: null,
    me: { playerId: "p1", seatId: 1, nickname: "甲", cents: "3000", credit: "GOOD", status: "ALIVE", alive: true },
    publicPlayers: [], winnerId: null, phaseInstanceId: "round4-action1", eventSeq: 20,
    currentSeatId: 1, actedSeats: [], pendingDueLoanId: null,
    finance: {
      cents: "3000", bankLoans: [{
        loanId: "bank-1", borrowerId: "p1", seatId: 1, principalCents: "5000", remainingCents: "6655",
        rateBps: 1000, issuedRound: 1, dueRound: 4, lastInterestRound: 4, status, origin: "NORMAL",
      }], bankDebtCents: "6655", bankDefaultedDebtCents: "0", privateLoans: [], privateDebtCents: "0",
      receivableCents: "0", frozenCents: "0", badDebtCents: "0", pendingRequest: null,
      incomingRequests: [], myBet: null, betsSubmitted: [], aliveCount: 2,
    },
  };
}

describe("05C M3/M4：command_result ok 只表示命令已提交", () => {
  it("ACCEPT ok 且服务端 FAILED 时明确未成立未转账", () => {
    const text = commandSuccessText("accept", viewWithLoan(), {
      requestId: "req-1", afterEventSeq: 4, events: closed("FAILED"),
    });
    expect(text).toContain("你的余额不足");
    expect(text).toContain("未成立，未转账");
    expect(text).not.toContain("操作成功");
  });

  it("ACCEPT 只有匹配请求的服务端成立事件才写已成立并转账", () => {
    const text = commandSuccessText("accept", viewWithLoan(), {
      requestId: "req-1", afterEventSeq: 4,
      events: [event(5, "PRIVATE_LOAN_ACCEPTED", { requestId: "req-1", loanId: "p2p-1", principalCents: "5000" })],
    });
    expect(text).toContain("借款已成立并转账");
  });

  it("ACCEPT 没有证据或只有历史/他人请求事件时不报已转账", () => {
    const view = viewWithLoan();
    for (const context of [
      {},
      { requestId: "req-1", events: [event(1, "PRIVATE_LOAN_ACCEPTED", { requestId: "req-1" })], afterEventSeq: 4 },
      { requestId: "req-1", events: [event(5, "PRIVATE_LOAN_ACCEPTED", { requestId: "req-other" })], afterEventSeq: 4 },
    ]) {
      const text = commandSuccessText("accept", view, context);
      expect(text).toContain("已提交");
      expect(text).not.toContain("已成立");
      expect(text).not.toContain("已转账");
    }
  });

  it("BANK_DUE ok 配本人失信事件时说明失信原因与当前金币", () => {
    const text = commandSuccessText("bankDue", viewWithLoan(), {
      loanId: "bank-1", afterEventSeq: 4,
      events: [event(5, "BANK_LOAN_DEFAULTED", { loanId: "bank-1", borrowerId: "p1", reason: "insufficient_funds" })],
    });
    expect(text).toContain("余额不足");
    expect(text).toContain("永久失信");
    expect(text).toContain("当前金币 3,000 分");
    expect(text).not.toContain("已还款");
  });

  it("BANK_DUE 无事件但本人贷款快照 DEFAULTED 时仍提示永久失信", () => {
    const text = commandSuccessText("bankDue", viewWithLoan("DEFAULTED"), { loanId: "bank-1" });
    expect(text).toContain("永久失信");
    expect(text).not.toContain("已还款");
  });

  it("BANK_DUE 本人贷款 REPAID 才显示已还款", () => {
    expect(commandSuccessText("bankDue", viewWithLoan("REPAID"), { loanId: "bank-1" })).toContain("已还款");
  });

  it("BANK_DUE 当前仍 ACTIVE 或事件属于别人时只显示决策已提交", () => {
    const text = commandSuccessText("bankDue", viewWithLoan(), {
      loanId: "bank-1", afterEventSeq: 4,
      events: [event(5, "BANK_LOAN_DEFAULTED", { loanId: "bank-1", borrowerId: "p2", reason: "timeout" })],
    });
    expect(text).toContain("决策已提交");
    expect(text).not.toContain("已还款");
    expect(text).not.toContain("已失信");
  });

  it("BANK_DUE 不把另笔已失信贷款或历史失信事件套给当前贷款", () => {
    const view = viewWithLoan();
    view.finance.bankLoans.push({ ...view.finance.bankLoans[0]!, loanId: "old-bank", status: "DEFAULTED" });
    const text = commandSuccessText("bankDue", view, {
      loanId: "bank-1", afterEventSeq: 4,
      events: [
        event(3, "BANK_LOAN_DEFAULTED", { loanId: "bank-1", borrowerId: "p1", reason: "timeout" }),
        event(5, "BANK_LOAN_DEFAULTED", { loanId: "old-bank", borrowerId: "p1", reason: "timeout" }),
      ],
    });
    expect(text).toContain("决策已提交");
    expect(text).not.toContain("已失信");
  });

  it("RESCUE_GIVE_UP ok 明确已放弃且破产，普通 ok 只写提交", () => {
    expect(commandSuccessText("giveUp", viewWithLoan())).toContain("已放弃自救，你已破产");
    const text = commandSuccessText("generic", viewWithLoan());
    expect(text).toContain("请求已提交");
    expect(text).not.toContain("操作成功");
  });
});
