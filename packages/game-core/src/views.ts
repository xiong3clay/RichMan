import type { Cents, GameState, PlayerId, PlayerView } from "@richman/shared";
import type { BankLoan } from "./bank.js";
import { defaultedBankDebtCents } from "./bank.js";
import type { LoanRequest, PrivateLoan } from "./private-loans.js";
import {
  badDebtCents,
  frozenCents,
  privateDebtCents,
  receivableCents,
} from "./private-loans.js";

/** 一条已锁定的下注；未开奖前只出现在本人视图里。 */
export interface BetLockView {
  betCents: Cents;
  guess: 0 | 1;
  leverage: 1 | 2;
}

/** 引擎在 shared PlayerView 之上追加的私有财务与下注字段。 */
interface ViewExtras {
  bankLoans?: BankLoan[];
  privateLoans?: PrivateLoan[];
  requests?: LoanRequest[];
  bets?: Record<PlayerId, BetLockView>;
  winnerId?: PlayerId | null;
}

export interface PublicPlayerView {
  playerId: PlayerId;
  seatId: number;
  nickname: string;
  credit: GameState["players"][number]["credit"];
  status: GameState["players"][number]["status"];
  alive: boolean;
  /** 失信银行欠款是公开信息，金额不随还款变化。 */
  defaultedBankDebtCents: Cents;
}

export interface PlayerFinanceView {
  cents: Cents;
  /** 本人银行贷款（含失信与已结清记录）。 */
  bankLoans: BankLoan[];
  bankDebtCents: Cents;
  bankDefaultedDebtCents: Cents;
  /** 只包含本人作为借款人或出借人的私人合同，第三人不出现。 */
  privateLoans: PrivateLoan[];
  privateDebtCents: Cents;
  receivableCents: Cents;
  frozenCents: Cents;
  badDebtCents: Cents;
  /** 本人发起、仍在等待答复的请求。 */
  pendingRequest: LoanRequest | null;
  /** 别人向本人发起的待处理请求。 */
  incomingRequests: LoanRequest[];
  /** 本人已锁定的下注；未开奖前只有本人可见。 */
  myBet: BetLockView | null;
  /** 已提交下注的玩家名单与存活人数（不含金额、猜测、杠杆）。 */
  betsSubmitted: PlayerId[];
  aliveCount: number;
}

export interface RichPlayerView extends PlayerView {
  publicPlayers: PublicPlayerView[];
  finance: PlayerFinanceView;
  winnerId: PlayerId | null;
}

/**
 * 按人出视图：本人看完整财务；公开列表只给信用、状态与失信欠款。
 * 他人的私人合同与未开奖下注一律不出现在该视图中。
 */
export function getPlayerView(
  state: GameState,
  viewerId: PlayerId,
  now: Date,
  deadlineAt: string | null = state.deadlineAt,
): RichPlayerView {
  const extras = state as GameState & ViewExtras;
  const me = state.players.find((player) => player.playerId === viewerId);
  if (!me) throw new Error("unknown player: " + viewerId);

  const bankLoans = extras.bankLoans ?? [];
  const privateLoans = extras.privateLoans ?? [];
  const requests = extras.requests ?? [];
  const bets = extras.bets ?? {};

  const myBankLoans = bankLoans.filter((loan) => loan.borrowerId === viewerId);
  const myPrivateLoans = privateLoans.filter(
    (loan) => loan.borrowerId === viewerId || loan.lenderId === viewerId,
  );

  const publicPlayers: PublicPlayerView[] = state.players.map((player) => ({
    playerId: player.playerId,
    seatId: player.seatId,
    nickname: player.nickname,
    credit: player.credit,
    status: player.status,
    alive: player.alive,
    defaultedBankDebtCents: defaultedBankDebtCents(
      bankLoans.filter((loan) => loan.borrowerId === player.playerId),
    ),
  }));

  const submitted = Object.keys(bets).filter((playerId) =>
    state.players.some((player) => player.playerId === playerId && player.alive),
  );

  return {
    gameId: state.gameId,
    version: state.version,
    round: state.round,
    phase: state.phase,
    serverNow: now.toISOString(),
    deadlineAt,
    me,
    publicPlayers,
    winnerId: extras.winnerId ?? null,
    finance: {
      cents: me.cents,
      bankLoans: myBankLoans,
      bankDebtCents: myBankLoans
        .filter((loan) => loan.status !== "REPAID")
        .reduce((total, loan) => total + loan.remainingCents, 0),
      bankDefaultedDebtCents: defaultedBankDebtCents(myBankLoans),
      privateLoans: myPrivateLoans,
      privateDebtCents: privateDebtCents(myPrivateLoans, viewerId),
      receivableCents: receivableCents(myPrivateLoans, viewerId),
      frozenCents: frozenCents(myPrivateLoans),
      badDebtCents: badDebtCents(myPrivateLoans),
      pendingRequest:
        requests.find((request) => request.borrowerId === viewerId && request.status === "PENDING") ??
        null,
      incomingRequests: requests.filter(
        (request) => request.lenderId === viewerId && request.status === "PENDING",
      ),
      myBet: bets[viewerId] ?? null,
      betsSubmitted: submitted,
      aliveCount: state.players.filter((player) => player.alive).length,
    },
  };
}
