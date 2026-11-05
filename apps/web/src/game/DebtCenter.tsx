/**
 * 单元 07A 债务中心：只读展示 view.finance / publicPlayers，不发命令、不重算金额、不改引导顺序。
 * 金额一律用 formatCents；额度直接读服务端字段，缺字段时回退通用文案。
 */
import type { WireBankLoan, WireLoanRequest, WirePrivateLoan, WireSnapshotView } from "../net/wire";
import {
  creditLabel,
  formatCents,
  loanStatusLabel,
  privateLoanStatusLabel,
  rateLabel,
  statusLabel,
} from "../net/wire";
import { BANK_LOAN_LIMIT_HINT, bankBorrowLimitOf, playerName } from "./steps";

export interface DebtCenterProps {
  view: WireSnapshotView;
  onClose: () => void;
}

function originLabel(loan: WireBankLoan): string {
  return loan.origin === "OVERDRAFT" ? "透支贷款" : "普通贷款";
}

/** 私人合同分组；组内按发起轮升序。 */
function groupPrivateLoans(loans: readonly WirePrivateLoan[]) {
  const byIssue = (a: WirePrivateLoan, b: WirePrivateLoan) => a.issuedRound - b.issuedRound;
  return {
    active: loans.filter((loan) => loan.status === "ACTIVE").sort(byIssue),
    settled: loans.filter((loan) => loan.status === "REPAID").sort(byIssue),
    frozen: loans
      .filter((loan) => loan.status === "FROZEN" || loan.status === "BAD_DEBT")
      .sort(byIssue),
  };
}

function privateDirection(view: WireSnapshotView, loan: WirePrivateLoan): string {
  return loan.borrowerId === view.me.playerId
    ? "我欠 " + playerName(view, loan.lenderId)
    : playerName(view, loan.borrowerId) + " 欠我";
}

function waitSeconds(view: WireSnapshotView, request: WireLoanRequest): number {
  const deadline = Number(request.deadlineMs);
  const now = Date.parse(view.serverNow);
  if (!Number.isFinite(deadline) || !Number.isFinite(now)) return 0;
  return Math.max(0, Math.floor((deadline - now) / 1000));
}

function waitText(view: WireSnapshotView, request: WireLoanRequest): string {
  const seconds = waitSeconds(view, request);
  return seconds <= 0 ? "已超时，等待服务端关闭" : "等待剩余 " + String(seconds) + " 秒";
}

/** 创建请求时的失信风险：只读 request 自带的历史快照字段。 */
function isRiskyBorrower(request: WireLoanRequest): boolean {
  if (request.borrowerCredit !== "GOOD") return true;
  return request.borrowerDefaultedBankDebtCents !== "0";
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="debt-stat">
      <span className="stat-label">{label}</span>
      <span className="debt-stat-value">{value}</span>
    </div>
  );
}

function BankLoanRow({ loan, round }: { loan: WireBankLoan; round: number }) {
  const overdue = loan.status === "ACTIVE" && round > loan.dueRound;
  return (
    <div className="loan-row debt-row">
      <span className="debt-tag">{originLabel(loan)}</span>
      <span>本金 {formatCents(loan.principalCents)}</span>
      <span>剩余 {formatCents(loan.remainingCents)}</span>
      <span>利率 {rateLabel(loan.rateBps)}</span>
      <span>发放第 {loan.issuedRound} 轮</span>
      <span>到期第 {loan.dueRound} 轮</span>
      <span>计息到第 {loan.lastInterestRound} 轮</span>
      <span className="debt-tag">{loanStatusLabel(loan.status)}</span>
      {overdue ? <span className="debt-overdue">已逾期，将在到期阶段处理</span> : null}
    </div>
  );
}

function PrivateLoanRow({ view, loan }: { view: WireSnapshotView; loan: WirePrivateLoan }) {
  return (
    <div className="loan-row debt-row">
      <span className="debt-tag">{privateDirection(view, loan)}</span>
      <span>本金 {formatCents(loan.principalCents)}</span>
      <span>剩余 {formatCents(loan.remainingCents)}</span>
      <span>利率 {rateLabel(loan.rateBps)}</span>
      <span>发起第 {loan.issuedRound} 轮</span>
      <span>计息到第 {loan.lastInterestRound} 轮</span>
      <span className="debt-tag">{privateLoanStatusLabel(loan.status)}</span>
    </div>
  );
}

function PrivateGroup({
  title,
  loans,
  view,
}: {
  title: string;
  loans: readonly WirePrivateLoan[];
  view: WireSnapshotView;
}) {
  return (
    <div className="debt-group">
      <h4>{title}</h4>
      {loans.length === 0 ? (
        <p className="debt-empty">无</p>
      ) : (
        <div className="loan-list">
          {loans.map((loan) => (
            <PrivateLoanRow key={loan.loanId} view={view} loan={loan} />
          ))}
        </div>
      )}
    </div>
  );
}

export function DebtCenter({ view, onClose }: DebtCenterProps) {
  const finance = view.finance;
  const groups = groupPrivateLoans(finance.privateLoans);
  const bankLimit = bankBorrowLimitOf(view);
  const pending = finance.pendingRequest;

  return (
    <div
      className="overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="debt-center-title"
      onClick={onClose}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <aside className="debt-drawer" onClick={(event) => event.stopPropagation()}>
        <div className="debt-head">
          <h2 id="debt-center-title">债务中心</h2>
          <button
            type="button"
            className="link debt-close"
            aria-label="关闭债务中心"
            onClick={onClose}
          >
            关闭
          </button>
        </div>

        <section className="debt-section" aria-labelledby="debt-summary-title">
          <h3 id="debt-summary-title">摘要</h3>
          <div className="debt-summary">
            <Stat label="金币" value={formatCents(finance.cents)} />
            <Stat
              label="总负债"
              value={
                "银行 " + formatCents(finance.bankDebtCents) +
                " · 私人 " + formatCents(finance.privateDebtCents)
              }
            />
            <Stat label="失信银行欠款" value={formatCents(finance.bankDefaultedDebtCents)} />
            <Stat label="应收" value={formatCents(finance.receivableCents)} />
            <Stat label="冻结" value={formatCents(finance.frozenCents)} />
            <Stat label="坏账" value={formatCents(finance.badDebtCents)} />
            <Stat
              label="可借额度"
              value={bankLimit === null ? BANK_LOAN_LIMIT_HINT : formatCents(bankLimit)}
            />
          </div>
        </section>

        <section className="debt-section" aria-labelledby="debt-bank-title">
          <h3 id="debt-bank-title">银行贷款</h3>
          {finance.bankLoans.length === 0 ? (
            <p className="debt-empty">当前无银行贷款</p>
          ) : (
            <div className="loan-list">
              {finance.bankLoans.map((loan) => (
                <BankLoanRow key={loan.loanId} loan={loan} round={view.round} />
              ))}
            </div>
          )}
        </section>

        <section className="debt-section" aria-labelledby="debt-private-title">
          <h3 id="debt-private-title">私人合同</h3>
          {finance.privateLoans.length === 0 ? (
            <p className="debt-empty">当前无私人合同</p>
          ) : (
            <>
              <PrivateGroup title="进行中" loans={groups.active} view={view} />
              <PrivateGroup title="已结清" loans={groups.settled} view={view} />
              <PrivateGroup title="冻结或坏账" loans={groups.frozen} view={view} />
            </>
          )}
        </section>

        <section className="debt-section" aria-labelledby="debt-request-title">
          <h3 id="debt-request-title">借款请求</h3>
          {pending === null ? (
            <p className="debt-empty">没有等待答复的请求</p>
          ) : (
            <div className="debt-request">
              <p className="debt-line">
                等待 {playerName(view, pending.lenderId)} 答复 · 金额{" "}
                {formatCents(pending.principalCents)} · 利率 {rateLabel(pending.rateBps)}
              </p>
              <p className="debt-line">{waitText(view, pending)}</p>
              <p className="debt-note">同一借款人同时只能有一个等待中的请求。</p>
            </div>
          )}

          {finance.incomingRequests.map((request) => (
            <div className="debt-request" key={request.requestId}>
              <p className="debt-line">
                {playerName(view, request.borrowerId)} 想借 {formatCents(request.principalCents)} ·
                利率 {rateLabel(request.rateBps)}
              </p>
              <p className="debt-line">
                创建时信用 {creditLabel(request.borrowerCredit)} · 失信欠款{" "}
                {formatCents(request.borrowerDefaultedBankDebtCents)} · {waitText(view, request)}
              </p>
              {isRiskyBorrower(request) ? (
                <p className="debt-risk">对方创建请求时已失信，出借有风险</p>
              ) : null}
            </div>
          ))}
        </section>

        <section className="debt-section" aria-labelledby="debt-players-title">
          <h3 id="debt-players-title">其他玩家</h3>
          <div className="player-table">
            <div className="player-row player-head">
              <span>座位</span>
              <span>昵称</span>
              <span>状态</span>
              <span>信用</span>
              <span className="player-defaulted-debt">失信欠款</span>
            </div>
            {view.publicPlayers.map((player) => (
              <div
                className={"player-row" + (player.seatId === view.currentSeatId ? " current" : "")}
                key={player.playerId}
              >
                <span>#{player.seatId}</span>
                <span>
                  {player.nickname}
                  {player.playerId === view.me.playerId ? <span className="tag me">我</span> : null}
                  {!player.alive ? <span className="tag">出局</span> : null}
                </span>
                <span>{statusLabel(player.status)}</span>
                <span>{creditLabel(player.credit)}</span>
                <span className="player-defaulted-debt">
                  {formatCents(player.defaultedBankDebtCents)}
                </span>
              </div>
            ))}
          </div>
        </section>

        <p className="hint">查询不消耗行动，也不会打断当前引导步骤。</p>
      </aside>
    </div>
  );
}
