import type { WireGameEvent } from "../net/wire";
import { deriveEventNotices, noticeEntityKey } from "./notices";
import type { EventNoticeContext, KnownLoanRequest } from "./notices";
import type { CommandKind, CommandSuccessContext } from "./results";

const NOTICE_LIMIT = 4;
const RESCUED_TTL_MS = 2500;

interface NoticeRecord {
  /** 保存服务端语义，当前金币、阶段后果在展示时重新生成。 */
  event: WireGameEvent;
  receivedAt: number;
  phaseInstanceId: string | undefined;
}

export interface NoticeHistory {
  records: Map<string, NoticeRecord>;
  dismissed: Set<number>;
  /** WS 事件按 seq 有序；已处理的旧事件在缓冲回放时不会重新入队。 */
  seenThrough: number;
  covered: Map<string, number>;
  lastCoveredCommandId: string | null;
}

export function createNoticeHistory(): NoticeHistory {
  return { records: new Map(), dismissed: new Set(), seenThrough: -1, covered: new Map(), lastCoveredCommandId: null };
}

/** 仅覆盖成功回执对应实体在发送之后的通知，结果横幅关闭后也不再补弹同一通知。 */
export function coverCommandNotices(
  history: NoticeHistory,
  command: { commandId: string; kind: CommandKind } & CommandSuccessContext,
): void {
  if (history.lastCoveredCommandId === command.commandId) return;
  history.lastCoveredCommandId = command.commandId;
  const key = command.kind === "bankDue" && command.loanId !== undefined ? "loan:" + command.loanId
    : (command.kind === "accept" || command.kind === "refuse" || command.kind === "cancel") && command.requestId !== undefined
      ? "request:" + command.requestId : null;
  if (key !== null) history.covered.set(key, command.afterEventSeq ?? -1);
}

export function dismissEventNotice(history: NoticeHistory, id: number): void {
  history.dismissed.add(id);
  for (const [key, record] of history.records) {
    if (record.event.seq === id) history.records.delete(key);
  }
}

export function updateNoticeHistory(
  history: NoticeHistory,
  events: readonly WireGameEvent[],
  viewerId: string,
  knownRequests: Readonly<Record<string, KnownLoanRequest>>,
  context: EventNoticeContext,
  nowMs: number,
) {
  const eventIds = new Set(events.map(event => event.seq));
  for (const id of history.dismissed) {
    if (!eventIds.has(id)) history.dismissed.delete(id);
  }
  const ordered = [...events].sort((left, right) => left.seq - right.seq);
  for (const event of ordered) {
    if (event.seq <= history.seenThrough) continue;
    if (deriveEventNotices([event], viewerId, knownRequests, context).length === 0) continue;
    const key = noticeEntityKey(event);
    history.records.set(key, { event, receivedAt: nowMs, phaseInstanceId: context.phaseInstanceId });
  }
  for (const event of ordered) history.seenThrough = Math.max(history.seenThrough, event.seq);

  let nextExpiry: number | null = null;
  for (const [key, record] of history.records) {
    const coveredAfter = history.covered.get(key);
    if (coveredAfter !== undefined && record.event.seq > coveredAfter) {
      history.records.delete(key);
      history.covered.delete(key);
      continue;
    }
    if (record.event.type !== "DANGER_RESCUED") continue;
    const expiresAt = record.receivedAt + RESCUED_TTL_MS;
    if (context.phase !== "TAX" || record.phaseInstanceId !== context.phaseInstanceId || expiresAt <= nowMs) history.records.delete(key);
    else nextExpiry = nextExpiry === null ? expiresAt : Math.min(nextExpiry, expiresAt);
  }
  // 成立/还清没有事件通知，也已完成对应命令，避免覆盖表累积这些已结束实体。
  for (const event of ordered) {
    if (event.type !== "PRIVATE_LOAN_ACCEPTED" && event.type !== "BANK_LOAN_REPAID" && event.type !== "BANK_LOAN_SETTLED" &&
      event.type !== "LOAN_REQUEST_CLOSED" && event.type !== "LOAN_REQUEST_EXPIRED" &&
      event.type !== "BANK_LOAN_DEFAULTED") continue;
    const key = noticeEntityKey(event);
    const after = history.covered.get(key);
    if (after !== undefined && event.seq > after) history.covered.delete(key);
  }

  // 未关闭关键失败不设TTL。最多展示最近4条；关闭后仍可查看此前尚未关闭的关键失败。
  const notices = deriveEventNotices([...history.records.values()].map(record => record.event),
    viewerId, knownRequests, context).filter(item => !history.dismissed.has(item.id)).slice(-NOTICE_LIMIT);
  return { notices, nextExpiry };
}
