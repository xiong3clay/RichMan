import { formatCents } from "../net/wire";
import type { GamePhase, WireGameEvent, WireSnapshotView } from "../net/wire";
import { deriveEventNotices, requestConsequenceText } from "./notices";

export type CommandKind = "generic" | "giveUp" | "accept" | "refuse" | "bankDue" | "cancel";

export interface CommandSuccessContext {
  events?: readonly WireGameEvent[];
  afterEventSeq?: number;
  requestId?: string;
  loanId?: string;
  requestPhase?: GamePhase;
  requestPhaseInstanceId?: string;
}

/**
 * outcome.ok 只说明服务端接受提交；成立/还款等结论必须由对应 ID 的事件或本人贷款快照确认。
 * afterEventSeq 由发送命令时的快照记录，防止把旧命令的事件显示成这次结果。
 */
export function commandSuccessText(
  kind: CommandKind | undefined,
  view: WireSnapshotView,
  context: CommandSuccessContext = {},
): string {
  const events = (context.events ?? [])
    .filter((event) => event.seq > (context.afterEventSeq ?? -1))
    .sort((left, right) => right.seq - left.seq);
  const currentCents = formatCents(view.finance.cents);
  if (kind === "giveUp") return "已放弃自救，你已破产";
  if (kind === "accept") {
    if (context.requestId !== undefined) {
      const result = events.find((event) => event.payload["requestId"] === context.requestId &&
        (event.type === "PRIVATE_LOAN_ACCEPTED" || event.type === "LOAN_REQUEST_CLOSED" || event.type === "LOAN_REQUEST_EXPIRED"));
      if (result?.type === "LOAN_REQUEST_CLOSED") {
        if (result.payload["status"] === "FAILED") return "你的余额不足，本次借款未成立，未转账。";
        if (result.payload["status"] === "REFUSED") return "借款请求已被拒绝，未转账。";
        if (result.payload["status"] === "CANCELLED") return "借款请求已取消，未转账。";
        if (result.payload["status"] === "EXPIRED") return "借款请求已过期，未转账。";
      }
      if (result?.type === "LOAN_REQUEST_EXPIRED") return "借款请求已过期，未转账。";
      const contract = view.finance.privateLoans.find((loan) => loan.requestId === context.requestId &&
        loan.lenderId === view.me.playerId);
      if (result?.type === "PRIVATE_LOAN_ACCEPTED" || contract !== undefined) {
        return "借款已成立并转账，当前金币 " + currentCents + "。";
      }
    }
    return "已提交同意借款；转账结果以服务端通知为准";
  }
  if (kind === "refuse") return "你已拒绝借款请求，未转账。";
  if (kind === "bankDue") {
    if (context.loanId !== undefined) {
      const defaulted = events.find((event) => event.type === "BANK_LOAN_DEFAULTED" &&
        event.payload["loanId"] === context.loanId && event.payload["borrowerId"] === view.me.playerId);
      if (defaulted !== undefined) {
        return deriveEventNotices([defaulted], view.me.playerId, {}, {
          phase: view.phase, currentCents: view.finance.cents,
        })[0]!.text;
      }
      const loan = view.finance.bankLoans.find((item) => item.loanId === context.loanId &&
        item.borrowerId === view.me.playerId);
      if (loan?.status === "DEFAULTED") {
        return "银行贷款已失信；你已永久失信，本局信用不再恢复。当前金币 " + currentCents + "。";
      }
      if (loan?.status === "REPAID") return "银行到期贷款已还款，当前金币 " + currentCents + "。";
    }
    return "到期决策已提交，处理结果以服务端通知为准";
  }
  if (kind === "cancel") return "借款请求已取消，未转账，" +
    requestConsequenceText(context.requestPhase ?? view.phase, view.phase,
      view.me.status === "DANGER" && (context.requestPhaseInstanceId === undefined ||
        context.requestPhaseInstanceId === view.phaseInstanceId)) + "。";
  return "请求已提交，当前金币 " + currentCents;
}
