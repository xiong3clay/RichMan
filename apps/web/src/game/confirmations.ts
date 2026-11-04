import type { WireLoanRequest, WireSnapshotView } from "../net/wire";

export type ConfirmAction =
  | { kind: "giveUp" }
  | { kind: "abandonBet"; round: number; phaseInstanceId: string }
  | { kind: "acceptLoan"; request: WireLoanRequest }
  | { kind: "bankRepay"; loanId: string; remaining: string }
  | { kind: "bankRefuse"; loanId: string; remaining: string };

/** 仅绑定当前服务端待办；待办消失时立即撤下旧确认，不重做借款/还款规则判定。 */
export function confirmationIsCurrent(action: ConfirmAction, view: WireSnapshotView): boolean {
  if (action.kind === "abandonBet") {
    return view.phase === "BETTING" && view.round === action.round && view.phaseInstanceId === action.phaseInstanceId &&
      view.me.alive && view.finance.myBet === null;
  }
  if (action.kind === "giveUp") {
    return view.phase === "TAX" && view.me.status === "DANGER" && view.me.alive;
  }
  if (action.kind === "acceptLoan") {
    return (view.phase === "ACTION" || view.phase === "TAX") &&
      view.finance.incomingRequests.some((request) => request.requestId === action.request.requestId &&
        request.status === "PENDING" && request.lenderId === view.me.playerId);
  }
  return view.phase === "BANK_DUE" && view.pendingDueLoanId === action.loanId &&
    view.finance.bankLoans.some((loan) => loan.loanId === action.loanId &&
      loan.borrowerId === view.me.playerId && loan.status === "ACTIVE");
}
