/**
 * 引导式界面的“当前该问哪一步”：只读服务端快照与本地纯 UI 状态，不访问 DOM、时钟或网络。
 * 规则判定仍由服务端权威决定；这里只决定“先问什么、什么时候显示等待”。
 */
import type {
  WireLoanRequest,
  WirePrivateLoan,
  WirePublicPlayer,
  WireSnapshotView,
} from "../net/wire";
import { formatCents, isNonNegativeCents, isPositiveCents } from "../net/wire";

/** 快照未提供可借额度时的兜底规则提示（旧服务器/旧快照兼容），不在客户端计算额度。 */
export const BANK_LOAN_LIMIT_HINT = "普通贷款上限为当前金币的 50%，最终以服务端为准";

/** 服务端下发的本人银行可借额度；字段缺失或非法时返回 null，由调用方回退通用文案。 */
export function bankBorrowLimitOf(view: WireSnapshotView): string | null {
  const value = view.finance.bankBorrowLimitCents as string | undefined;
  return typeof value === "string" && isNonNegativeCents(value) ? value : null;
}

/** 服务端下发的某出借人可借上限；字段缺失时返回 null，由调用方回退通用文案。 */
export function lenderLimitOf(view: WireSnapshotView, playerId: string): string | null {
  const limits = view.finance.lenderLimits as
    | readonly { playerId: string; maxCents: string }[]
    | undefined;
  if (!Array.isArray(limits)) return null;
  const found = limits.find((entry) => entry.playerId === playerId);
  if (found === undefined || typeof found.maxCents !== "string") return null;
  return isNonNegativeCents(found.maxCents) ? found.maxCents : null;
}

/** 银行额度文案：可借给具体数字；不可借保留原因并显示 0 分；缺字段回退旧通用文案。 */
export function bankLimitText(view: WireSnapshotView): string {
  const blocked = bankBlockedReason(view);
  if (blocked !== null) return blocked + "（可借 0 分）";
  const limit = bankBorrowLimitOf(view);
  if (limit === null) return BANK_LOAN_LIMIT_HINT;
  if (limit === "0") return "可借 0 分（当前金币不足以产生贷款额度）";
  return "最多可借 " + formatCents(limit) + "（当前金币的 50%，向下取整）";
}

/** 私人额度文案：只读服务端上限；缺字段回退旧通用文案。 */
export function privateLimitText(view: WireSnapshotView, lenderId: string): string {
  const limit = lenderLimitOf(view, lenderId);
  if (limit === null) return "金额上限以服务端为准";
  return "最多可借 " + formatCents(limit) + "（受对方可用资金与你余额上限限制）";
}

/** 只接受规范十进制整数分（无符号、无小数点、无指数、无前导零）；其他写法交给原有表单校验。 */
export const CANONICAL_CENTS = /^(0|[1-9]\d*)$/;

/** 整数分字符串比较；空值或非法输入交给原有表单校验，不在这里判超限。 */
export function withinLimit(value: string, limit: string | null): boolean {
  if (limit === null) return true;
  const text = value.trim();
  if (!CANONICAL_CENTS.test(text)) return true;
  const parsed = Number(text);
  const max = Number(limit);
  if (!Number.isSafeInteger(parsed) || !Number.isSafeInteger(max)) return true;
  return parsed <= max;
}

/** 服务端下发的“该笔私人合同最多可收回”上限；旧快照缺字段或非法时返回 null。 */
export function collectLimitOf(view: WireSnapshotView, loanId: string): string | null {
  const limits = view.finance.collectLimits as
    | readonly { loanId: string; maxCents: string }[]
    | undefined;
  if (!Array.isArray(limits)) return null;
  // S2：畸形元素（null/数字/缺 loanId）不能抛错，统一按“字段非法”返回 null。
  const found = limits.find(
    (entry): entry is { loanId: string; maxCents: string } =>
      entry !== null &&
      typeof entry === "object" &&
      typeof (entry as { loanId?: unknown }).loanId === "string" &&
      (entry as { loanId: string }).loanId === loanId,
  );
  if (found === undefined || typeof found.maxCents !== "string") return null;
  return isNonNegativeCents(found.maxCents) ? found.maxCents : null;
}

/** 规范十进制整数分比较；调用方负责先校验格式，全程不做浮点换算。 */
export function compareCentsText(left: string, right: string): number {
  const leftNegative = left.startsWith("-");
  const rightNegative = right.startsWith("-");
  if (leftNegative !== rightNegative) return leftNegative ? -1 : 1;
  const leftAbs = leftNegative ? left.slice(1) : left;
  const rightAbs = rightNegative ? right.slice(1) : right;
  const sign = leftNegative ? -1 : 1;
  if (leftAbs.length !== rightAbs.length) {
    return sign * (leftAbs.length < rightAbs.length ? -1 : 1);
  }
  if (leftAbs === rightAbs) return 0;
  return sign * (leftAbs < rightAbs ? -1 : 1);
}

/** 全部还款可用：本人金币 >= 该笔剩余全额；负金币一律不可用。 */
export function canRepayAll(view: WireSnapshotView, option: DebtOption): boolean {
  if (!isNonNegativeCents(view.finance.cents) || !isPositiveCents(option.remainingCents)) {
    return false;
  }
  return compareCentsText(view.finance.cents, option.remainingCents) >= 0;
}

/** 全部催收可用：服务端可收上限 >= 剩余全额；null 表示旧快照无法判断，按服务端为准允许点击。 */
export function canCollectAll(view: WireSnapshotView, option: DebtOption): boolean | null {
  const limit = collectLimitOf(view, option.loanId);
  if (limit === null) return null;
  if (!isPositiveCents(option.remainingCents)) return false;
  return compareCentsText(limit, option.remainingCents) >= 0;
}

export type ActionStage =
  | "askPrivate"
  | "privateLender"
  | "privateAmount"
  | "askBank"
  | "bankAmount"
  | "askDebt"
  | "debtAmount"
  | "endAction";

export type BetStage = "guess" | "amount" | "leverage" | "confirm";

export type DangerStage = "ask" | "privateLender" | "privateAmount" | "collect" | "collectAmount";

export interface UiState {
  actionStage: ActionStage;
  betStage: BetStage;
  dangerStage: DangerStage;
}

export const INITIAL_UI_STATE: UiState = {
  actionStage: "askPrivate",
  betStage: "guess",
  dangerStage: "ask",
};

export interface DebtOption {
  kind: "repayBank" | "repayPrivate" | "collectPrivate";
  loanId: string;
  /** 剩余应还/应收金额（千分位展示在视图层完成）。 */
  remainingCents: string;
  rateBps: number;
  /** 银行贷款的到期轮；私人合同为 null。 */
  dueRound: number | null;
  /** 对手方（借款人/出借人），用于展示“还给谁/向谁收”。 */
  counterpartyId: string;
}

export type GuidedStep =
  | { kind: "gameOver"; winnerId: string | null; winnerName: string | null }
  | { kind: "bankDue"; loan: WireSnapshotView["finance"]["bankLoans"][number] }
  | { kind: "danger"; stage: DangerStage }
  | { kind: "requestBorrower"; request: WireLoanRequest }
  | { kind: "requestLender"; request: WireLoanRequest; pendingCount: number }
  | { kind: "actionOwn"; stage: ActionStage; debtOptions: DebtOption[] }
  | { kind: "actionWait"; seatId: number | null; nickname: string | null; acted: boolean }
  | { kind: "betting"; stage: BetStage }
  | {
      kind: "betLocked";
      bet: { betCents: string; guess: 0 | 1; leverage: 1 | 2 };
      submitted: number;
      alive: number;
    }
  | { kind: "waiting"; title: string; detail: string };

export function playerName(view: WireSnapshotView, playerId: string): string {
  const found = view.publicPlayers.find((player) => player.playerId === playerId);
  return found?.nickname ?? playerId;
}

/** 可操作的负债/债权：只列 ACTIVE；07C 起没有可操作项时停留 askDebt，可返回 Q2。 */
export function debtOptions(view: WireSnapshotView): DebtOption[] {
  const me = view.me.playerId;
  const options: DebtOption[] = [];
  for (const loan of view.finance.bankLoans) {
    if (loan.status !== "ACTIVE") continue;
    options.push({
      kind: "repayBank",
      loanId: loan.loanId,
      remainingCents: loan.remainingCents,
      rateBps: loan.rateBps,
      dueRound: loan.dueRound,
      counterpartyId: "bank",
    });
  }
  for (const loan of view.finance.privateLoans) {
    if (loan.status !== "ACTIVE") continue;
    if (loan.borrowerId === me) {
      options.push({
        kind: "repayPrivate",
        loanId: loan.loanId,
        remainingCents: loan.remainingCents,
        rateBps: loan.rateBps,
        dueRound: null,
        counterpartyId: loan.lenderId,
      });
    } else if (loan.lenderId === me) {
      options.push({
        kind: "collectPrivate",
        loanId: loan.loanId,
        remainingCents: loan.remainingCents,
        rateBps: loan.rateBps,
        dueRound: null,
        counterpartyId: loan.borrowerId,
      });
    }
  }
  return options;
}

/** 可借款对象：存活的其他人（破产者不可借入）。 */
export function privateLenderOptions(view: WireSnapshotView): WirePublicPlayer[] {
  return view.publicPlayers.filter((player) => player.alive && player.playerId !== view.me.playerId);
}

/**
 * 银行普通贷款资格镜像 engine/bank.ts 的快照前置条件：
 * 信用 GOOD、金币 > 0、本人没有任何 status !== "REPAID" 的银行贷款。
 * 快照的 bankBorrowLimitCents 已给出上限（近余额上限时可能小于 50%）；最终金额仍由服务端裁决。
 */
export function bankBlockedReason(view: WireSnapshotView): string | null {
  if (view.me.credit !== "GOOD") {
    return "你已失信，不能新增普通银行贷款";
  }
  if (!isPositiveCents(view.finance.cents)) {
    if (view.finance.cents === "0") return "金币为 0，不能申请普通银行贷款";
    if (view.finance.cents.startsWith("-")) return "金币为负，不能申请普通银行贷款";
    return "金币数据无效，暂不能申请普通银行贷款";
  }
  const blockingLoan = view.finance.bankLoans.find((loan) => loan.status !== "REPAID");
  if (blockingLoan !== undefined) {
    if (blockingLoan.status === "DEFAULTED") {
      return "你有失信状态的银行贷款未结清，不能再次借款";
    }
    return "你有一笔未结清的银行贷款，不能再次借款";
  }
  return null;
}

/** 命令失败时不推进本地引导步骤；成功时才回到 Q1/猜点。纯函数，便于测试“停留原问题”。 */
export function uiAfterOutcome(ui: UiState, ok: boolean): UiState {
  return ok ? INITIAL_UI_STATE : ui;
}

function findLoanInView(view: WireSnapshotView, loanId: string): WirePrivateLoan | null {
  return view.finance.privateLoans.find((loan) => loan.loanId === loanId) ?? null;
}

export function activePrivacyLoanFor(view: WireSnapshotView, option: DebtOption): WirePrivateLoan | null {
  return findLoanInView(view, option.loanId);
}

/**
 * 全页唯一入口：把“快照 + 本地已点到的步骤”翻译成当前唯一要展示的问题。
 * 优先级：结束 > 收到的借款请求 > 自己发出的请求 > 阶段专属视图 > 通用等待。
 */
export function deriveStep(view: WireSnapshotView, ui: UiState): GuidedStep {
  const me = view.me;

  if (view.phase === "GAME_OVER" || view.winnerId !== null) {
    const winner =
      view.winnerId === null
        ? null
        : view.publicPlayers.find((player) => player.playerId === view.winnerId) ?? null;
    return {
      kind: "gameOver",
      winnerId: view.winnerId,
      winnerName: winner?.nickname ?? null,
    };
  }

  // 收到请求是“需要我回答的问题”，优先于自己发出的等待；两者都不消耗行动。
  if (view.finance.incomingRequests.length > 0) {
    const request = view.finance.incomingRequests[0];
    if (request !== undefined) {
      return {
        kind: "requestLender",
        request,
        pendingCount: view.finance.incomingRequests.length,
      };
    }
  }
  if (view.finance.pendingRequest !== null) {
    return { kind: "requestBorrower", request: view.finance.pendingRequest };
  }

  if (view.phase === "ACTION") {
    const currentNickname =
      view.currentSeatId === null
        ? null
        : view.publicPlayers.find((player) => player.seatId === view.currentSeatId)?.nickname ?? null;
    const mine = view.currentSeatId === me.seatId && me.alive;
    const acted = view.actedSeats.includes(me.seatId);
    if (!mine || acted) {
      return { kind: "actionWait", seatId: view.currentSeatId, nickname: currentNickname, acted };
    }
    const options = debtOptions(view);
    // 07C：空 Q3 不再自动跳到 endAction，保留“结束行动/返回 Q2”让玩家可回退一步。
    return { kind: "actionOwn", stage: ui.actionStage, debtOptions: options };
  }

  if (view.phase === "BANK_DUE") {
    if (view.pendingDueLoanId !== null) {
      const loan = view.finance.bankLoans.find((item) => item.loanId === view.pendingDueLoanId);
      if (loan !== undefined) return { kind: "bankDue", loan };
    }
    return {
      kind: "waiting",
      title: "到期贷款处理中",
      detail: "正在处理其他玩家的到期贷款，处理完后会自动继续本轮。",
    };
  }

  if (view.phase === "TAX") {
    if (me.status === "DANGER" && me.alive) {
      return { kind: "danger", stage: ui.dangerStage };
    }
    const danger = view.publicPlayers.find((player) => player.status === "DANGER" && player.alive);
    if (danger !== undefined) {
      return {
        kind: "waiting",
        title: "等待 " + danger.nickname + " 自救",
        detail: "对方金币为负，正在借款、催收或放弃自救；税费结算暂停。",
      };
    }
    return {
      kind: "waiting",
      title: "本轮税费结算中",
      detail: "每 3 轮扣税一次，结算完成后自动进入下一轮。",
    };
  }

  if (view.phase === "BETTING") {
    if (view.finance.myBet !== null) {
      return {
        kind: "betLocked",
        bet: view.finance.myBet,
        submitted: view.finance.betsSubmitted.length,
        alive: view.finance.aliveCount,
      };
    }
    if (!me.alive) {
      return {
        kind: "waiting",
        title: "已破产，等待下注结束",
        detail: "破产玩家不参与本轮下注。",
      };
    }
    return { kind: "betting", stage: ui.betStage };
  }

  return {
    kind: "waiting",
    title: "计息中",
    detail: "正在结算本轮贷款利息，随后进入行动阶段。",
  };
}
