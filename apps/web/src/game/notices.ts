/**
 * 服务端事件 → 玩家可见提示（纯函数）：只读事件、本人身份与已知的请求参与方，
 * 不计算金额、不访问 DOM。用于自动失信、借款请求失败/过期、解除危险等没有 command_result 的场景。
 */
import { formatCents } from "../net/wire";
import type { GamePhase, WireGameEvent, WireSnapshotView } from "../net/wire";

export interface KnownLoanRequest {
  borrowerId: string;
  lenderId: string;
  /** 记录请求所在阶段，避免处理后的快照已经跨阶段而误报行动消耗。 */
  phase?: GamePhase;
  phaseInstanceId?: string;
  /** 只有实际收到终态事件后才允许清理归属，不能因关闭快照先到而丢掉它。 */
  closedSeq?: number;
}

export interface EventNoticeContext {
  /** 当前快照阶段；TAX 自救中的请求结束不会消耗行动。 */
  phase: GamePhase;
  phaseInstanceId?: string;
  inDanger?: boolean;
  /** 当前金币（服务端快照原值），用于失信提示。 */
  currentCents: string;
}

export interface EventNotice {
  /** 事件 seq，用于去重与关闭。 */
  id: number;
  tone: "info" | "warn" | "danger";
  text: string;
}

const DEFAULT_REASON: Record<string, string> = {
  insufficient_funds: "余额不足",
  timeout: "到期超时未处理",
  refused: "你拒绝还款",
  bankrupt: "破产",
};

function text(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

export function requestConsequenceText(requestPhase: GamePhase, currentPhase: GamePhase, sameRescueWindow = true): string {
  if (requestPhase !== "TAX") return "本次行动已用掉";
  return currentPhase === "TAX" && sameRescueWindow ? "本次请求已结束，自救继续，仍可再次发起" : "该自救请求已结束";
}

function requestConsequence(known: KnownLoanRequest, context: EventNoticeContext): string {
  const sameWindow = (known.phaseInstanceId === undefined || context.phaseInstanceId === undefined ||
    known.phaseInstanceId === context.phaseInstanceId) && context.inDanger !== false;
  return requestConsequenceText(known.phase ?? context.phase, context.phase, sameWindow);
}

/** 实体标识用于合并同一请求的 CLOSED/EXPIRED；seq 用于区分新事件与回放。 */
export function noticeEntityKey(event: WireGameEvent): string {
  if (typeof event.payload["requestId"] === "string") return "request:" + event.payload["requestId"];
  if (typeof event.payload["loanId"] === "string") return "loan:" + event.payload["loanId"];
  return "event:" + event.seq;
}

function isPhase(value: unknown): value is GamePhase {
  return value === "INTEREST" || value === "BANK_DUE" || value === "ACTION" ||
    value === "BETTING" || value === "TAX" || value === "GAME_OVER";
}

/**
 * 只记服务端明确给过的参与方。请求可能在两次渲染之间创建并关闭，故也读取创建事件；
 * 返回的新记录由调用方保留，不能因为当前快照已移除请求就丢掉归属。
 */
export function rememberLoanRequests(
  knownRequests: Readonly<Record<string, KnownLoanRequest>>,
  events: readonly WireGameEvent[],
  snapshot?: WireSnapshotView,
): Record<string, KnownLoanRequest> {
  const remembered = { ...knownRequests };
  let eventPhase: GamePhase | undefined;
  let eventPhaseInstanceId: string | undefined;
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    if (event.type === "PHASE_CHANGED" && isPhase(event.payload["phase"])) {
      eventPhase = event.payload["phase"];
      eventPhaseInstanceId = typeof event.payload["phaseInstanceId"] === "string" ? event.payload["phaseInstanceId"] : undefined;
    }
    if (event.type === "LOAN_REQUEST_CLOSED" || event.type === "LOAN_REQUEST_EXPIRED" || event.type === "PRIVATE_LOAN_ACCEPTED") {
      const id = event.payload["requestId"];
      if (typeof id === "string" && remembered[id] !== undefined) {
        remembered[id] = { ...remembered[id], closedSeq: event.seq };
      }
    }
    if (event.type !== "LOAN_REQUESTED") continue;
    const { requestId, borrowerId, lenderId } = event.payload;
    if (typeof requestId !== "string" || requestId === "" ||
      typeof borrowerId !== "string" || borrowerId === "" ||
      typeof lenderId !== "string" || lenderId === "" || borrowerId === lenderId) continue;
    const phase = remembered[requestId]?.phase ?? eventPhase;
    const phaseInstanceId = remembered[requestId]?.phaseInstanceId ?? eventPhaseInstanceId;
    remembered[requestId] = { ...remembered[requestId], borrowerId, lenderId, ...(phase === undefined ? {} : { phase }),
      ...(phaseInstanceId === undefined ? {} : { phaseInstanceId }) };
  }
  if (snapshot !== undefined) {
    const pending = snapshot.finance.pendingRequest;
    const visibleRequests = pending === null ? snapshot.finance.incomingRequests : [pending, ...snapshot.finance.incomingRequests];
    for (const request of visibleRequests) {
      remembered[request.requestId] = {
        ...remembered[request.requestId],
        borrowerId: request.borrowerId,
        lenderId: request.lenderId,
        phase: remembered[request.requestId]?.phase ?? snapshot.phase,
        phaseInstanceId: remembered[request.requestId]?.phaseInstanceId ?? snapshot.phaseInstanceId,
      };
    }
  }
  return remembered;
}

export function deriveEventNotices(
  events: readonly WireGameEvent[],
  viewerId: string,
  knownRequests: Readonly<Record<string, KnownLoanRequest>>,
  context: EventNoticeContext,
): EventNotice[] {
  const notices: EventNotice[] = [];
  const remembered = rememberLoanRequests(knownRequests, events);

  const latest = new Map<string, WireGameEvent>();
  for (const event of events) {
    if (event.type !== "BANK_LOAN_DEFAULTED" && event.type !== "LOAN_REQUEST_CLOSED" &&
      event.type !== "LOAN_REQUEST_EXPIRED" && event.type !== "DANGER_RESCUED") continue;
    const key = noticeEntityKey(event);
    if ((latest.get(key)?.seq ?? -1) < event.seq) latest.set(key, event);
  }
  for (const event of [...latest.values()].sort((left, right) => left.seq - right.seq)) {
    const payload = event.payload;

    if (event.type === "BANK_LOAN_DEFAULTED") {
      if (payload["borrowerId"] !== viewerId) continue;
      const reason = text(payload["reason"]);
      const original = text(payload["originalCents"]);
      const reasonText = reason === null ? "未说明" : DEFAULT_REASON[reason] ?? reason;
      notices.push({
        id: event.seq,
        tone: "danger",
        text:
          "银行贷款已失信（原因：" +
          reasonText +
          "）：" +
          (original === null ? "剩余欠款" : "剩余 " + formatCents(original)) +
          " 已记为失信欠款；你已永久失信，本局信用不再恢复。当前金币 " +
          formatCents(context.currentCents) +
          "。",
      });
      continue;
    }

    if (event.type === "LOAN_REQUEST_CLOSED" && payload["status"] !== "EXPIRED") {
      const requestId = text(payload["requestId"]);
      const status = text(payload["status"]);
      if (requestId === null || status === null) continue;
      const known = remembered[requestId];
      if (known === undefined) continue;
      const actionResult = requestConsequence(known, context);
      if (status === "FAILED") {
        if (known.lenderId === viewerId) {
          notices.push({
            id: event.seq,
            tone: "warn",
            text: "你的余额不足，本次借款未成立，未转账。",
          });
        } else if (known.borrowerId === viewerId) {
          notices.push({
            id: event.seq,
            tone: "warn",
            text: "借款请求未成立（对方余额不足），未转账，" + actionResult + "。",
          });
        }
        continue;
      }
      if (status === "REFUSED") {
        if (known.borrowerId === viewerId) {
          notices.push({ id: event.seq, tone: "warn", text: "借款请求被拒绝，未转账，" + actionResult + "。" });
        } else if (known.lenderId === viewerId) {
          notices.push({ id: event.seq, tone: "info", text: "你已拒绝对方的借款请求，未转账。" });
        }
      }
      if (status === "CANCELLED") {
        if (known.borrowerId === viewerId) {
          notices.push({ id: event.seq, tone: "info", text: "借款请求已取消，未转账，" + actionResult + "。" });
        } else if (known.lenderId === viewerId) {
          notices.push({ id: event.seq, tone: "info", text: "对方的借款请求已取消，未转账。" });
        }
      }
      continue;
    }

    if (event.type === "LOAN_REQUEST_EXPIRED" ||
      (event.type === "LOAN_REQUEST_CLOSED" && payload["status"] === "EXPIRED")) {
      const requestId = text(payload["requestId"]);
      if (requestId === null) continue;
      const known = remembered[requestId];
      if (known === undefined) continue;
      if (known.borrowerId === viewerId) {
        notices.push({
          id: event.seq,
          tone: "warn",
          text: "借款请求已过期，未转账，" + requestConsequence(known, context) + "。",
        });
      } else if (known.lenderId === viewerId) {
        notices.push({ id: event.seq, tone: "info", text: "对方的借款请求已过期，未转账。" });
      }
      continue;
    }

    if (event.type === "DANGER_RESCUED") {
      if (payload["playerId"] !== viewerId || context.phase !== "TAX") continue;
      notices.push({
        id: event.seq,
        tone: "info",
        text: "已解除危险，当前金币 " + formatCents(context.currentCents) + "。",
      });
    }
  }

  return notices;
}
