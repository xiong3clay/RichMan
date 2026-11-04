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
import { isPositiveCents } from "../net/wire";

/** 快照未提供可借额度；各个银行借款问题共用规则提示，不在客户端计算额度。 */
export const BANK_LOAN_LIMIT_HINT = "普通贷款上限为当前金币的 50%，最终以服务端为准";

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
  | { kind: "requestLender"; request: WireLoanRequest }
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

/** 可操作的负债/债权：只列 ACTIVE；没有可操作项时 Q3 自动跳到 Q4。 */
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
 * 快照没有 borrowableCents，50% 上限只能提示，最终金额由服务端裁决。
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
    if (request !== undefined) return { kind: "requestLender", request };
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
    const stage: ActionStage =
      ui.actionStage === "askDebt" && options.length === 0 ? "endAction" : ui.actionStage;
    return { kind: "actionOwn", stage, debtOptions: options };
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
