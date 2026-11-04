import { describe, expect, it } from "vitest";
import { confirmationIsCurrent } from "../src/game/confirmations";
import type { ConfirmAction } from "../src/game/confirmations";
import { bankFixture, requestFixture, viewFixture } from "./view-fixtures";

describe("M5：确认摘要必须绑定服务端仍在等待的同一待办", () => {
  const accept: ConfirmAction = { kind: "acceptLoan", request: requestFixture() };

  it.each(["ACTION", "TAX"] as const)("%s 仍收到同一 PENDING 请求时保留同意确认", (phase) => {
    const view = viewFixture();
    view.phase = phase;
    view.finance.incomingRequests = [requestFixture()];
    expect(confirmationIsCurrent(accept, view)).toBe(true);
  });

  it("借款人取消/超时后请求从同阶段快照消失，不再显示旧确认", () => {
    const view = viewFixture();
    expect(confirmationIsCurrent(accept, view)).toBe(false);
  });

  it("后续收到别的请求，不能继续确认旧请求", () => {
    const view = viewFixture();
    view.finance.incomingRequests = [{ ...requestFixture(), requestId: "req-other" }];
    expect(confirmationIsCurrent(accept, view)).toBe(false);
  });

  it.each(["CANCELLED", "EXPIRED", "FAILED", "REFUSED", "ACCEPTED"] as const)("同ID请求已 %s 时关闭同意确认", (status) => {
    const view = viewFixture();
    view.finance.incomingRequests = [{ ...requestFixture(), status }];
    expect(confirmationIsCurrent(accept, view)).toBe(false);
  });

  it("相同请求被投影到其他玩家或其他阶段，旧确认无效", () => {
    const view = viewFixture();
    view.finance.incomingRequests = [{ ...requestFixture(), lenderId: "p2" }];
    expect(confirmationIsCurrent(accept, view)).toBe(false);
    view.finance.incomingRequests = [requestFixture()];
    view.phase = "BETTING";
    expect(confirmationIsCurrent(accept, view)).toBe(false);
  });

  it.each(["bankRepay", "bankRefuse"] as const)("%s 只保留本人正在处理的 ACTIVE 到期贷款确认", (kind) => {
    const action: ConfirmAction = { kind, loanId: "bank-1", remaining: "1000" };
    const view = viewFixture();
    view.phase = "BANK_DUE";
    view.pendingDueLoanId = "bank-1";
    view.finance.bankLoans = [bankFixture()];
    expect(confirmationIsCurrent(action, view)).toBe(true);

    view.pendingDueLoanId = "bank-next";
    expect(confirmationIsCurrent(action, view)).toBe(false);
    view.pendingDueLoanId = "bank-1";
    view.finance.bankLoans[0]!.borrowerId = "p2";
    expect(confirmationIsCurrent(action, view)).toBe(false);
  });

  it.each(["REPAID", "DEFAULTED"] as const)("银行贷款已 %s 后，旧确认立即失效", (status) => {
    const view = viewFixture();
    view.phase = "BANK_DUE";
    view.pendingDueLoanId = "bank-1";
    view.finance.bankLoans = [{ ...bankFixture(), status }];
    expect(confirmationIsCurrent({ kind: "bankRepay", loanId: "bank-1", remaining: "1000" }, view)).toBe(false);
  });

  it("银行待办已清除、贷款不存在或阶段切换后不能确认旧贷款", () => {
    const action: ConfirmAction = { kind: "bankRefuse", loanId: "bank-1", remaining: "1000" };
    const view = viewFixture();
    view.phase = "BANK_DUE";
    view.finance.bankLoans = [bankFixture()];
    expect(confirmationIsCurrent(action, view)).toBe(false);
    view.pendingDueLoanId = "bank-1";
    view.finance.bankLoans = [];
    expect(confirmationIsCurrent(action, view)).toBe(false);
    view.finance.bankLoans = [bankFixture()];
    view.phase = "ACTION";
    expect(confirmationIsCurrent(action, view)).toBe(false);
  });

  it("放弃自救确认仅在本人存活且仍处于 TAX/DANGER 时有效", () => {
    const action: ConfirmAction = { kind: "giveUp" };
    const view = viewFixture();
    view.phase = "TAX";
    view.me.status = "DANGER";
    expect(confirmationIsCurrent(action, view)).toBe(true);
    view.me.status = "ALIVE";
    expect(confirmationIsCurrent(action, view)).toBe(false);
    view.me.status = "DANGER";
    view.me.alive = false;
    expect(confirmationIsCurrent(action, view)).toBe(false);
    view.me.alive = true;
    view.phase = "ACTION";
    expect(confirmationIsCurrent(action, view)).toBe(false);
  });
});
