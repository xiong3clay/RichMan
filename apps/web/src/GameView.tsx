import { useEffect, useRef, useState } from "react";
import type { ConnectionStatus, CommandOptions, RichmanClient } from "./net/client";
import { clearSession } from "./net/client";
import { Countdown } from "./Countdown";
import {
  creditLabel,
  formatCents,
  isNonNegativeCents,
  isPositiveCents,
  loanStatusLabel,
  phaseLabel,
  privateLoanStatusLabel,
  rateLabel,
  statusLabel,
} from "./net/wire";
import type { WireCommandResult, WireGameEvent, WireLoanRequest, WireSnapshotView } from "./net/wire";
import { deriveStep } from "./game/steps";
import type { ActionStage, DebtOption, GuidedStep, UiState } from "./game/steps";
import {
  INITIAL_UI_STATE,
  debtOptions,
  playerName,
  privateLenderOptions,
  bankBlockedReason,
  bankBorrowLimitOf,
  bankLimitText,
  lenderLimitOf,
  privateLimitText,
  uiAfterOutcome,
  withinLimit,
  BANK_LOAN_LIMIT_HINT,
} from "./game/steps";
import { deriveRoundSettlement, deriveSettlementBalance, hasInterestBearingDebt } from "./game/settlement";
import type { RoundSettlement } from "./game/settlement";
import { rememberLoanRequests } from "./game/notices";
import type { KnownLoanRequest } from "./game/notices";
import { createNoticeHistory, coverCommandNotices, dismissEventNotice, updateNoticeHistory } from "./game/notice-history";
import { commandSuccessText } from "./game/results";
import type { CommandKind, CommandSuccessContext } from "./game/results";
import { confirmationIsCurrent } from "./game/confirmations";
import type { ConfirmAction } from "./game/confirmations";

export interface GameViewProps {
  roomCode: string;
  hostId?: string | null;
  view: WireSnapshotView;
  client: RichmanClient;
  status: ConnectionStatus;
  statusDetail: string | null;
  result: WireCommandResult | null;
  /** 服务端推送的 error 消息（非 command_result），需在游戏内可见。 */
  error: { code: string; message: string } | null;
  /** 服务端过滤后的本人可见事件；只用于本轮结算卡。 */
  events: WireGameEvent[];
}

const CONN_LABELS: Record<ConnectionStatus, string> = {
  connecting: "重连中",
  open: "在线",
  closed: "离线",
  replaced: "已替换",
};

const MONEY_LIMIT_TEXT = formatCents("1000000000000");

function stageHeadline(view: WireSnapshotView): string {
  if (view.phase === "ACTION") {
    return view.currentSeatId === view.me.seatId ? "你的操作阶段" : "等待行动阶段";
  }
  if (view.phase === "BETTING") {
    return view.finance.myBet === null ? "你的下注阶段" : "你的下注阶段（已锁定）";
  }
  if (view.phase === "BANK_DUE") return "银行到期";
  if (view.phase === "TAX") return view.me.status === "DANGER" ? "危险自救" : "交税与自救";
  if (view.phase === "INTEREST") return "计息";
  return "对局结束";
}

function parseRateBps(text: string): number | null {
  if (!/^(0|[1-9][0-9]*)$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= 0 && value <= 10_000 ? value : null;
}

/** 仅比较整数分字符串大小，用于提示“余额可能不足”，不做金额运算。 */
function centsLessThan(left: string, right: string): boolean {
  const leftNegative = left.startsWith("-");
  const rightNegative = right.startsWith("-");
  if (leftNegative !== rightNegative) return leftNegative;
  const leftAbs = leftNegative ? left.slice(1) : left;
  const rightAbs = rightNegative ? right.slice(1) : right;
  if (leftAbs.length !== rightAbs.length) {
    return leftNegative ? leftAbs.length > rightAbs.length : leftAbs.length < rightAbs.length;
  }
  return leftNegative ? leftAbs > rightAbs : leftAbs < rightAbs;
}

interface ChoiceProps {
  label: string;
  hint?: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: "primary" | "ghost" | "danger";
}

function Choice({ label, hint, onClick, disabled = false, tone = "primary" }: ChoiceProps) {
  return (
    <button
      type="button"
      className={"choice " + tone}
      onClick={onClick}
      disabled={disabled}
    >
      <span className="choice-label">{label}</span>
      {hint !== undefined ? <span className="choice-hint">{hint}</span> : null}
    </button>
  );
}

export function GameView(props: GameViewProps) {
  // 新gameId代表全新对局；卸载所有局内state/ref/timer，避免旧通知和结算混进新局。
  return <GameSessionView key={props.view.gameId} {...props} />;
}

function GameSessionView({ roomCode, hostId = null, view, client, status, statusDetail, result, error, events }: GameViewProps) {
  const [ui, setUi] = useState<UiState>(INITIAL_UI_STATE);
  const [amount, setAmount] = useState("");
  const [rateText, setRateText] = useState("1000");
  const [lenderId, setLenderId] = useState<string | null>(null);
  const [debtLoanId, setDebtLoanId] = useState<string | null>(null);
  const [guess, setGuess] = useState<0 | 1>(0);
  const [leverage, setLeverage] = useState<1 | 2>(1);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [dismissedResult, setDismissedResult] = useState<string | null>(null);
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const [phaseToast, setPhaseToast] = useState<string | null>(null);
  const [settlement, setSettlement] = useState<{ round: number; before: string } | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [abandonPending, setAbandonPending] = useState(false);
  const abandonCommandRef = useRef<{ commandId: string; phaseInstanceId: string } | null>(null);
  const [rematchPending, setRematchPending] = useState(false);
  const rematchPendingRef = useRef(false);
  const [, refreshNotices] = useState(0);

  const prevRoundRef = useRef(view.round);
  const prevCentsRef = useRef(view.finance.cents);
  const prevPhaseRef = useRef(view.phase);
  const prevPendingRef = useRef(view.finance.pendingRequest?.requestId ?? null);
  type SentCommand = { commandId: string; kind: CommandKind } & CommandSuccessContext;
  const pendingCommandsRef = useRef(new Map<string, SentCommand>());
  const resultCommandRef = useRef<SentCommand | null>(null);
  /** 记录曾出现在快照里的请求参与方；过期事件只有 requestId，需要它来定向提示。 */
  const knownRequestsRef = useRef<Record<string, KnownLoanRequest>>({});
  const noticeHistoryRef = useRef(createNoticeHistory());
  const snapshotClockRef = useRef({ serverNow: view.serverNow, receivedAtMs: Date.now() });
  if (snapshotClockRef.current.serverNow !== view.serverNow) {
    snapshotClockRef.current = { serverNow: view.serverNow, receivedAtMs: Date.now() };
  }
  const countdownProps = { serverNow: view.serverNow, receivedAtMs: snapshotClockRef.current.receivedAtMs };

  const finance = view.finance;
  const canSubmit = status === "open" && client.hasJoined;
  const step = deriveStep(view, ui);
  const currentConfirmation = confirmAction !== null && confirmationIsCurrent(confirmAction, view) ? confirmAction : null;
  const blockedBank = bankBlockedReason(view);
  const selfOptions = debtOptions(view);

  if (result !== null && resultCommandRef.current?.commandId !== result.commandId) {
    resultCommandRef.current = pendingCommandsRef.current.get(result.commandId) ?? null;
    pendingCommandsRef.current.delete(result.commandId);
  }
  const resultCommand = result !== null && resultCommandRef.current?.commandId === result.commandId
    ? resultCommandRef.current : null;
  if (result?.outcome.ok && resultCommand !== null) {
    coverCommandNotices(noticeHistoryRef.current, resultCommand);
    // 结果横幅也保留语义事件；事件滚出缓冲后仍可更新当前金币，且不会退回“已提交”。
    resultCommand.events = [...new Map([...(resultCommand.events ?? []), ...events]
      .filter(event => event.seq > (resultCommand.afterEventSeq ?? -1) &&
        ((resultCommand.requestId !== undefined && event.payload["requestId"] === resultCommand.requestId) ||
          (resultCommand.loanId !== undefined && event.payload["loanId"] === resultCommand.loanId)))
      .map(event => [event.seq, event])).values()];
  }
  knownRequestsRef.current = rememberLoanRequests(knownRequestsRef.current, events, view);
  const { notices: eventNotices, nextExpiry } = updateNoticeHistory(noticeHistoryRef.current, events,
    view.me.playerId, knownRequestsRef.current, { phase: view.phase, phaseInstanceId: view.phaseInstanceId,
      inDanger: view.me.status === "DANGER", currentCents: finance.cents }, Date.now());
  // 只保留当前请求、缓冲事件及未关闭通知需要的请求归属。
  const referencedRequests = new Set([
    ...events, ...[...noticeHistoryRef.current.records.values()].map(record => record.event),
  ].map(event => event.payload["requestId"]).filter((id): id is string => typeof id === "string"));
  for (const request of finance.incomingRequests) referencedRequests.add(request.requestId);
  if (finance.pendingRequest !== null) referencedRequests.add(finance.pendingRequest.requestId);
  knownRequestsRef.current = Object.fromEntries(Object.entries(knownRequestsRef.current)
    .filter(([id, known]) => known.closedSeq === undefined || referencedRequests.has(id)));

  useEffect(() => {
    if (nextExpiry === null) return;
    const timer = globalThis.setTimeout(() => refreshNotices(tick => tick + 1), Math.max(0, nextExpiry - Date.now()));
    return () => globalThis.clearTimeout(timer);
  }, [nextExpiry]);

  /** 结算卡只做事件推导与快照过滤；利息行仅对本人有未结清贷款的观看者显示。 */
  const settlementCard =
    settlement === null
      ? null
      : deriveRoundSettlement(events, settlement.round, view.me.playerId, {
          hasOutstandingLoans: hasInterestBearingDebt(view),
        });

  /** 阶段切换时把引导步骤归零，避免上一阶段的输入残留。 */
  useEffect(() => {
    setUi(INITIAL_UI_STATE);
    setAmount("");
    setLenderId(null);
    setDebtLoanId(null);
    setNotice(null);
  }, [view.phaseInstanceId]);

  useEffect(() => {
    setConfirmAction(current => current !== null && !confirmationIsCurrent(current, view) ? null : current);
  }, [view]);

  useEffect(() => {
    if (!canSubmit || view.phase !== "BETTING" || finance.myBet !== null ||
      (abandonCommandRef.current !== null && abandonCommandRef.current.phaseInstanceId !== view.phaseInstanceId) ||
      (result?.commandId === abandonCommandRef.current?.commandId && result !== null && !result.outcome.ok)) {
      abandonCommandRef.current = null;
      setAbandonPending(false);
      setConfirmAction(current => current?.kind === "abandonBet" ? null : current);
    }
  }, [canSubmit, view.phase, view.phaseInstanceId, finance.myBet, result]);

  useEffect(() => {
    if (error !== null || !canSubmit) {
      rematchPendingRef.current = false;
      setRematchPending(false);
    }
    if (error !== null) {
      abandonCommandRef.current = null;
      setAbandonPending(false);
      setConfirmAction(current => current?.kind === "abandonBet" ? null : current);
    }
  }, [error, canSubmit]);

  /** 提交成功：行动/自救/下注都进入“等待或锁定”，本地步骤回到 Q1；失败则停留原问题。 */
  useEffect(() => {
    if (result === null) return;
    setConfirmAction(null);
    setUi((current) => uiAfterOutcome(current, result.outcome.ok));
    if (result.outcome.ok !== true) return;
    setAmount("");
    setLenderId(null);
    setDebtLoanId(null);
    setNotice(null);
  }, [result]);

  /** 自己的待处理请求结束后（对方同意/拒绝/过期），回到自救或下一步。 */
  const pendingRequestId = finance.pendingRequest?.requestId ?? null;
  useEffect(() => {
    if (prevPendingRef.current !== null && pendingRequestId === null) {
      setUi(INITIAL_UI_STATE);
      setAmount("");
      setNotice(null);
      setConfirmAction(null);
    }
    prevPendingRef.current = pendingRequestId;
  }, [pendingRequestId]);

  /** 轮次变化：弹出本轮结算卡，并短暂提示进入新阶段。 */
  useEffect(() => {
    if (view.round === prevRoundRef.current) {
      prevCentsRef.current = finance.cents;
      return;
    }
    const completed = prevRoundRef.current;
    const before = prevCentsRef.current;
    prevRoundRef.current = view.round;
    prevCentsRef.current = finance.cents;
    setSettlement({ round: completed, before });
    setPhaseToast("第 " + String(view.round) + " 轮开始");
  }, [view.round, finance.cents]);

  useEffect(() => {
    if (view.phase === prevPhaseRef.current) return;
    prevPhaseRef.current = view.phase;
    setConfirmAction(null);
    if (view.phase === "GAME_OVER") setDrawerOpen(false);
    if (view.phase !== "GAME_OVER") setPhaseToast("进入「" + phaseLabel(view.phase) + "」阶段");
  }, [view.phase]);

  useEffect(() => {
    if (phaseToast === null) return;
    const timer = window.setTimeout(() => setPhaseToast(null), 2200);
    return () => window.clearTimeout(timer);
  }, [phaseToast]);

  const send = (run: () => string | null, kind: CommandKind = "generic", context: CommandSuccessContext = {}): string | null => {
    if (status !== "open" || !client.hasJoined) {
      setNotice("连接未就绪，当前不能提交；恢复连接后请重新确认");
      return null;
    }
    const commandId = run();
    if (commandId === null) {
      setNotice("连接未就绪或快照尚未到达，命令未发送");
      return null;
    }
    pendingCommandsRef.current.set(commandId, { commandId, kind, ...context, afterEventSeq: view.eventSeq });
    setNotice(null);
    return commandId;
  };

  const versionOptions: CommandOptions = { expectedGameVersion: view.version };

  const setActionStage = (stage: ActionStage) => {
    setUi((current) => ({ ...current, actionStage: stage }));
    setNotice(null);
  };

  const privateLenders = privateLenderOptions(view);
  const chosenLender = privateLenders.find((player) => player.playerId === lenderId) ?? null;
  const chosenDebt = selfOptions.find((option) => option.loanId === debtLoanId) ?? null;
  const collectOptions = selfOptions.filter((option) => option.kind === "collectPrivate");

  const rateValue = parseRateBps(rateText);
  const amountValid = isPositiveCents(amount);
  const bankLimit = bankBorrowLimitOf(view);
  const chosenLenderLimit =
    chosenLender === null ? null : lenderLimitOf(view, chosenLender.playerId);
  const bankOverLimit = bankLimit !== null && !withinLimit(amount, bankLimit);
  const privateOverLimit = chosenLenderLimit !== null && !withinLimit(amount, chosenLenderLimit);
  /** 额度为 0 时“是，输入金额”是死路：进去后任何金额都会被禁用，故直接禁用并给出原因。 */
  const bankUnavailable = blockedBank !== null || bankLimit === "0";

  function submitPrivateRequest(): void {
    if (lenderId === null || chosenLender === null) {
      setNotice("请先选择出借人");
      return;
    }
    if (!amountValid) {
      setNotice("借款金额必须是大于 0 且不超过 " + MONEY_LIMIT_TEXT + " 的整数");
      return;
    }
    if (rateValue === null) {
      setNotice("利率必须是 0～10000 的整数基点（1000 基点 = 10%）");
      return;
    }
    send(() => client.requestPrivateLoan(lenderId, amount, rateValue, versionOptions));
  }

  function submitDebt(): void {
    if (chosenDebt === null) {
      setNotice("没有可操作的贷款或合同");
      return;
    }
    if (!amountValid) {
      setNotice("还款/催收金额必须是大于 0 且不超过 " + MONEY_LIMIT_TEXT + " 的整数");
      return;
    }
    if (chosenDebt.kind === "repayBank") {
      send(() => client.repayBank(chosenDebt.loanId, amount, versionOptions));
      return;
    }
    if (chosenDebt.kind === "repayPrivate") {
      send(() => client.repayPrivateLoan(chosenDebt.loanId, amount, versionOptions));
      return;
    }
    send(() => client.collectPrivateLoan(chosenDebt.loanId, amount, versionOptions));
  }

  function submitBet(): void {
    if (!isNonNegativeCents(amount)) {
      setNotice("下注金额必须是不超过 " + MONEY_LIMIT_TEXT + " 的非负整数");
      return;
    }
    send(() =>
      client.submitBet(amount, guess, leverage, {
        roundId: view.round,
        phaseInstanceId: view.phaseInstanceId,
      }),
    );
  }

  const resultVisible = result !== null && dismissedResult !== result.commandId;
  const resultKind = resultCommand?.kind;
  const errorVisible = error !== null && dismissedError !== error.code + "|" + error.message;

  /** 高风险动作的第二步：显示关键后果，确认后立即发送；不是层层弹窗。 */
  function renderConfirm(current: ConfirmAction) {
    if (current.kind === "abandonBet") {
      return (
        <section className="panel wizard">
          <p className="eyebrow">下注 · 放弃确认</p>
          <h2 className="question">放弃本轮下注？</h2>
          <p className="step-hint">放弃后本轮不押注，等待开奖</p>
          <div className="choice-grid">
            <Choice label={abandonPending ? "正在提交放弃…" : "确认放弃"} tone="ghost" disabled={abandonPending}
              onClick={() => {
                if (abandonCommandRef.current !== null) return;
                const commandId = send(() => client.submitBet("0", 0, 1, {
                  roundId: view.round, phaseInstanceId: view.phaseInstanceId,
                }));
                if (commandId !== null) {
                  abandonCommandRef.current = { commandId, phaseInstanceId: view.phaseInstanceId };
                  setAbandonPending(true);
                }
              }} />
            <Choice label="返回" tone="ghost" disabled={abandonPending} onClick={() => setConfirmAction(null)} />
          </div>
        </section>
      );
    }
    if (current.kind === "giveUp") {
      return (
        <section className="panel wizard">
          <p className="eyebrow">危险自救 · 第 2 步确认</p>
          <h2 className="question">确认放弃自救？</h2>
          <p className="step-hint">
            当前金币 {formatCents(finance.cents)} · 自救剩余{" "}
            <Countdown deadlineAt={view.deadlineAt} {...countdownProps} />
          </p>
          <p className="step-hint danger-text">
            确认后立即破产结算，无法撤销；银行贷款转为失信欠款，私人合同转为坏账或冻结。
          </p>
          <div className="choice-grid">
            <Choice
              label="确认放弃并立即破产"
              tone="danger"
              onClick={() => {
                setConfirmAction(null);
                send(() => client.giveUpRescue(versionOptions), "giveUp");
              }}
            />
            <Choice label="返回" tone="ghost" onClick={() => setConfirmAction(null)} />
          </div>
        </section>
      );
    }

    if (current.kind === "acceptLoan") {
      const request = current.request;
      const shortOnCash = centsLessThan(finance.cents, request.principalCents);
      return (
        <section className="panel wizard">
          <p className="eyebrow">收到借款请求 · 第 2 步确认</p>
          <h2 className="question">确认同意借款？</h2>
          <p className="step-hint">
            出借人：{view.me.nickname}（你） · 借款人：{playerName(view, request.borrowerId)}
          </p>
          <p className="step-hint">
            金额 {formatCents(request.principalCents)} · 利率 {rateLabel(request.rateBps)}
          </p>
          <p className="step-hint">
            对方信用 {creditLabel(request.borrowerCredit)} · 失信银行欠款{" "}
            {formatCents(request.borrowerDefaultedBankDebtCents)}
          </p>
          <p className="step-hint danger-text">
            确认后立即从你的金币转出 {formatCents(request.principalCents)} 并生成对方的私人借条，无法撤销。
          </p>
          {shortOnCash ? (
            <p className="step-hint danger-text">
              你的金币 {formatCents(finance.cents)} 少于出借金额；确认后请求会以“未成立”关闭，不会转账。
            </p>
          ) : null}
          <div className="choice-grid">
            <Choice
              label="确认同意并立即转账"
              onClick={() => {
                setConfirmAction(null);
                send(() => client.acceptPrivateLoan(request.requestId, versionOptions), "accept", { requestId: request.requestId });
              }}
            />
            <Choice label="返回" tone="ghost" onClick={() => setConfirmAction(null)} />
          </div>
        </section>
      );
    }

    const repay = current.kind === "bankRepay";
    const shortOnCash = repay && centsLessThan(finance.cents, current.remaining);
    return (
      <section className="panel wizard">
        <p className="eyebrow">银行到期 · 第 2 步确认</p>
        <h2 className="question">{repay ? "确认还款？" : "确认拒绝还款？"}</h2>
        <p className="step-hint">
          应还 {formatCents(current.remaining)} · 当前金币 {formatCents(finance.cents)}
        </p>
        {repay ? (
          shortOnCash ? (
            <p className="step-hint danger-text">
              余额不足：确认后服务端会按“余额不足”判失信，欠款保留且本局信用不再恢复。
            </p>
          ) : (
            <p className="step-hint">确认后立即从金币扣除应还金额；服务端仍会最终裁决。</p>
          )
        ) : (
          <p className="step-hint danger-text">
            拒绝还款会立即记为失信：失信欠款保留、本局信用不再恢复，并影响后续借款。
          </p>
        )}
        <div className="choice-grid">
          <Choice
            label={repay ? (shortOnCash ? "仍要还款" : "确认还款") : "确认拒绝并失信"}
            tone={repay ? "primary" : "danger"}
            onClick={() => {
              setConfirmAction(null);
              send(
                () => client.decideBankDue(current.loanId, repay ? "REPAY" : "REFUSE", versionOptions),
                "bankDue",
                { loanId: current.loanId },
              );
            }}
          />
          <Choice label="返回" tone="ghost" onClick={() => setConfirmAction(null)} />
        </div>
      </section>
    );
  }

  function renderStep(current: GuidedStep) {
    if (current.kind === "gameOver") {
      return (
        <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="game-over-title">
        <div className="overlay-card">
        <section className="panel wizard">
          <p className="eyebrow">对局结束</p>
          <h2 className="question" id="game-over-title">
            {current.winnerId === null
              ? "本局没有胜者"
              : current.winnerId === view.me.playerId
                ? "你赢了"
                : current.winnerName === null
                  ? "胜者未知"
                  : current.winnerName + " 获胜"}
          </h2>
          <p className="step-hint">你的最终金币：{formatCents(finance.cents)}</p>
          {hostId === view.me.playerId ? (
            <button type="button" className="primary wide" disabled={!canSubmit || rematchPending}
              onClick={() => {
                if (!canSubmit || rematchPendingRef.current) return;
                rematchPendingRef.current = true;
                setRematchPending(true);
                setNotice(null);
                if (!client.rematch()) {
                  rematchPendingRef.current = false;
                  setRematchPending(false);
                  setNotice("连接未就绪，新一局请求未发送，请恢复连接后重试");
                }
              }}>
              {rematchPending ? "正在开始新一局…" : "再来一局"}
            </button>
          ) : <p className="step-hint">等待房主开始新一局</p>}
          {!canSubmit ? <p className="step-hint">连接恢复后才能继续操作；当前不能开始新一局。</p> : null}
          {!rematchPending && error !== null ? <p className="reason" role="alert">{error.code}：{error.message}</p> : null}
          {notice !== null ? <p className="reason" role="alert">{notice}</p> : null}
        </section>
        </div>
        </div>
      );
    }

    if (current.kind === "bankDue") {
      return (
        <section className="panel wizard">
          <p className="eyebrow">银行到期</p>
          <h2 className="question">有一笔银行贷款已到期</h2>
          <p className="step-hint">
            应还 {formatCents(current.loan.remainingCents)}，当前金币 {formatCents(finance.cents)}
            {current.loan.origin === "OVERDRAFT" ? "（透支贷款）" : ""}
            ，第 {current.loan.dueRound} 轮到期。
          </p>
          <p className="step-hint danger-text">
            拒绝还款会立即记为失信：失信欠款保留、本局信用不再恢复，并影响后续借款。
          </p>
          <div className="choice-grid">
            <Choice
              label="还款"
              hint={formatCents(current.loan.remainingCents) + "；确认后扣款，余额不足会判失信"}
              onClick={() =>
                setConfirmAction({
                  kind: "bankRepay",
                  loanId: current.loan.loanId,
                  remaining: current.loan.remainingCents,
                })
              }
            />
            <Choice
              label="拒绝还款"
              hint="确认后立即转为失信欠款"
              tone="danger"
              onClick={() =>
                setConfirmAction({
                  kind: "bankRefuse",
                  loanId: current.loan.loanId,
                  remaining: current.loan.remainingCents,
                })
              }
            />
          </div>
        </section>
      );
    }

    if (current.kind === "requestBorrower") {
      const cancelHint =
        view.phase === "TAX"
          ? "取消只关闭本次请求，自救继续，仍可再次发起"
          : "取消会消耗本次行动，且不退还";
      return (
        <section className="panel wizard">
          <p className="eyebrow">等待答复</p>
          <h2 className="question">等待 {playerName(view, current.request.lenderId)} 确认</h2>
          <p className="step-hint">
            借款 {formatCents(current.request.principalCents)} · 利率 {rateLabel(current.request.rateBps)}
          </p>
          <p className="step-hint">
            请求截止：<Countdown deadlineAt={view.deadlineAt} {...countdownProps} />
          </p>
          <p className="step-hint">{cancelHint}。</p>
          <div className="choice-grid">
            <Choice
              label="取消请求"
              hint={cancelHint}
              tone="ghost"
              onClick={() =>
                send(() => client.cancelPrivateLoan(current.request.requestId, versionOptions), "cancel",
                  { requestId: current.request.requestId, requestPhase: view.phase, requestPhaseInstanceId: view.phaseInstanceId })
              }
            />
          </div>
        </section>
      );
    }

    if (current.kind === "requestLender") {
      const request = current.request;
      return (
        <section className="panel wizard">
          <p className="eyebrow">收到借款请求</p>
          <h2 className="question">{playerName(view, request.borrowerId)} 想向你借款</h2>
          <p className="step-hint">
            金额 {formatCents(request.principalCents)} · 利率 {rateLabel(request.rateBps)} · 信用{" "}
            {creditLabel(request.borrowerCredit)}
          </p>
          <p className="step-hint">
            失信银行欠款：{formatCents(request.borrowerDefaultedBankDebtCents)}；同意/拒绝都不消耗你的行动。
          </p>
          <div className="choice-grid">
            <Choice
              label="同意借款"
              hint="下一步确认金额、利率与对方信用"
              onClick={() => setConfirmAction({ kind: "acceptLoan", request })}
            />
            <Choice
              label="拒绝"
              hint="请求关闭，不转账"
              tone="ghost"
              onClick={() =>
                send(() => client.refusePrivateLoan(request.requestId, versionOptions), "refuse", { requestId: request.requestId })
              }
            />
          </div>
        </section>
      );
    }

    if (current.kind === "actionWait") {
      return (
        <section className="panel wizard">
          <p className="eyebrow">等待</p>
          <h2 className="question">
            {current.acted
              ? "你已完成本轮行动"
              : current.nickname === null
                ? "等待其他玩家行动"
                : "等待 " + current.nickname + " 行动"}
          </h2>
          <p className="step-hint">
            {current.acted
              ? "本轮不再给你新的问题；阶段推进后会自动出现下一步。"
              : current.seatId === null
                ? "本轮行动即将结束。"
                : "其他玩家完成后会依次轮到你。"}
          </p>
        </section>
      );
    }

    if (current.kind === "betting") {
      if (current.stage === "guess") {
        return (
          <section className="panel wizard">
            <p className="eyebrow">下注 · 第 1 问</p>
            <h2 className="question">猜哪个点？</h2>
            <div className="choice-grid two">
              <Choice
                label="猜 0"
                onClick={() => {
                  setGuess(0);
                  setUi((state) => ({ ...state, betStage: "amount" }));
                }}
              />
              <Choice
                label="猜 1"
                onClick={() => {
                  setGuess(1);
                  setUi((state) => ({ ...state, betStage: "amount" }));
                }}
              />
            </div>
            <div className="choice-grid">
              <Choice label="放弃本轮下注" tone="ghost" onClick={() => setConfirmAction({ kind: "abandonBet",
                round: view.round, phaseInstanceId: view.phaseInstanceId })} />
            </div>
          </section>
        );
      }
      if (current.stage === "amount") {
        return (
          <section className="panel wizard">
            <p className="eyebrow">下注 · 第 2 问</p>
            <h2 className="question">下注多少？</h2>
            <p className="step-hint">
              可押 0～当前金币 {formatCents(finance.cents)}；输入 0 表示本轮不押。
              {view.me.credit === "DEFAULTED" ? " 失信玩家只能押 1 倍。" : ""}
            </p>
            <input
              className="input amount-input"
              inputMode="numeric"
              placeholder="下注金额（分）"
              value={amount}
              onChange={(event) => setAmount(event.target.value.trim())}
            />
            <div className="choice-grid">
              <Choice
                label="下一步"
                hint={"猜 " + String(guess)}
                onClick={() => {
                  if (!isNonNegativeCents(amount)) {
                    setNotice("下注金额必须是不超过 " + MONEY_LIMIT_TEXT + " 的非负整数");
                    return;
                  }
                  setNotice(null);
                  setUi((state) => ({ ...state, betStage: "leverage" }));
                }}
              />
              <Choice
                label="返回"
                tone="ghost"
                onClick={() => setUi((state) => ({ ...state, betStage: "guess" }))}
              />
            </div>
          </section>
        );
      }
      if (current.stage === "leverage") {
        const defaulted = view.me.credit === "DEFAULTED";
        return (
          <section className="panel wizard">
            <p className="eyebrow">下注 · 第 3 问</p>
            <h2 className="question">用几倍杠杆？</h2>
            <div className="choice-grid two">
              <Choice
                label="1 倍"
                onClick={() => {
                  setLeverage(1);
                  setUi((state) => ({ ...state, betStage: "confirm" }));
                }}
              />
              <Choice
                label="2 倍"
                hint={defaulted ? "失信玩家不可选" : "输赢翻倍"}
                disabled={defaulted}
                onClick={() => {
                  setLeverage(2);
                  setUi((state) => ({ ...state, betStage: "confirm" }));
                }}
              />
            </div>
            <div className="choice-grid">
              <Choice
                label="返回"
                tone="ghost"
                onClick={() => setUi((state) => ({ ...state, betStage: "amount" }))}
              />
            </div>
          </section>
        );
      }
      return (
        <section className="panel wizard">
          <p className="eyebrow">下注 · 第 4 问</p>
          <h2 className="question">确认锁定？</h2>
          <p className="step-hint">
            猜 {String(guess)} · 押 {isNonNegativeCents(amount) ? formatCents(amount) : "（未填写）"} · {String(leverage)} 倍
          </p>
          <p className="step-hint">锁定后不可修改；开奖前别人看不到你的金额、猜测与杠杆。</p>
          <div className="choice-grid">
            <Choice
              label="锁定下注"
              onClick={() => {
                submitBet();
                setUi((state) => ({ ...state, betStage: "confirm" }));
              }}
            />
            <Choice
              label="返回修改"
              tone="ghost"
              onClick={() => setUi((state) => ({ ...state, betStage: "leverage" }))}
            />
          </div>
        </section>
      );
    }

    if (current.kind === "betLocked") {
      const others = view.publicPlayers.filter(
        (player) => player.alive && player.playerId !== view.me.playerId,
      );
      return (
        <section className="panel wizard">
          <p className="eyebrow">已锁定</p>
          <h2 className="question">已锁定，等待其他玩家</h2>
          <p className="step-hint">
            {current.bet.betCents === "0" ? "已放弃（0 注）" :
              "你押了 " + formatCents(current.bet.betCents) + "，猜 " + String(current.bet.guess) + "，" + String(current.bet.leverage) + " 倍。"}
          </p>
          <p className="step-hint">
            已提交 {String(current.submitted)} / {String(current.alive)} 人。锁定后不可修改。
          </p>
          <div className="loan-list">
            {others.map((player) => (
              <div className="loan-row" key={player.playerId}>
                <span>{player.nickname}</span>
                <span>{finance.betsSubmitted.includes(player.playerId) ? "已提交" : "未提交"}</span>
              </div>
            ))}
          </div>
        </section>
      );
    }

    if (current.kind === "danger") {
      if (current.stage === "ask") {
        return (
          <section className="panel wizard">
            <p className="eyebrow">危险自救</p>
            <h2 className="question">金币为负，需要自救</h2>
            <p className="step-hint">
              当前金币 {formatCents(finance.cents)} · 自救剩余 <Countdown deadlineAt={view.deadlineAt} {...countdownProps} />
            </p>
            <p className="step-hint">补到 0 以上即解除危险；放弃或超时会被破产结算。</p>
            <div className="choice-grid">
              <Choice
                label="紧急借款"
                hint="向其他玩家发起请求"
                onClick={() => setUi((state) => ({ ...state, dangerStage: "privateLender" }))}
              />
              {collectOptions.length > 0 ? (
                <Choice
                  label="催收"
                  hint="收回别人欠你的私人借款"
                  onClick={() => setUi((state) => ({ ...state, dangerStage: "collect" }))}
                />
              ) : null}
              <Choice
                label="放弃自救"
                hint="下一步确认后立即破产"
                tone="danger"
                onClick={() => setConfirmAction({ kind: "giveUp" })}
              />
            </div>
          </section>
        );
      }
      if (current.stage === "privateLender") {
        return (
          <section className="panel wizard">
            <p className="eyebrow">紧急借款 · 选择出借人</p>
            <h2 className="question">向谁借款？</h2>
            <div className="choice-grid">
              {privateLenders.map((player) => (
                <Choice
                  key={player.playerId}
                  label={player.nickname + "（座位 " + String(player.seatId) + "）"}
                  hint={"信用 " + creditLabel(player.credit) + " · 失信欠款 " + formatCents(player.defaultedBankDebtCents)}
                  onClick={() => {
                    setLenderId(player.playerId);
                    setUi((state) => ({ ...state, dangerStage: "privateAmount" }));
                  }}
                />
              ))}
            </div>
            <div className="choice-grid">
              <Choice
                label="返回"
                tone="ghost"
                onClick={() => setUi((state) => ({ ...state, dangerStage: "ask" }))}
              />
            </div>
          </section>
        );
      }
      if (current.stage === "privateAmount") {
        return (
          <section className="panel wizard">
            <p className="eyebrow">紧急借款 · 金额与利率</p>
            <h2 className="question">
              向 {chosenLender === null ? "出借人" : chosenLender.nickname} 借多少？
            </h2>
            <input
              className="input amount-input"
              inputMode="numeric"
              placeholder="借款金额（分）"
              value={amount}
              onChange={(event) => setAmount(event.target.value.trim())}
            />
            <input
              className="input"
              inputMode="numeric"
              placeholder="利率（基点，1000 = 10%）"
              value={rateText}
              onChange={(event) => setRateText(event.target.value.trim())}
            />
            <div className="choice-grid">
              <Choice label="发起请求" onClick={submitPrivateRequest} />
              <Choice
                label="返回"
                tone="ghost"
                onClick={() => setUi((state) => ({ ...state, dangerStage: "privateLender" }))}
              />
            </div>
          </section>
        );
      }
      if (current.stage === "collect") {
        return (
          <section className="panel wizard">
            <p className="eyebrow">催收</p>
            <h2 className="question">催收哪一笔？</h2>
            <div className="choice-grid">
              {collectOptions.map((option) => (
                <Choice
                  key={option.loanId}
                  label={playerName(view, option.counterpartyId) + " 欠你 " + formatCents(option.remainingCents)}
                  hint={"利率 " + rateLabel(option.rateBps) + "；实际可收以服务端为准"}
                  onClick={() => {
                    setDebtLoanId(option.loanId);
                    setUi((state) => ({ ...state, dangerStage: "collectAmount" }));
                  }}
                />
              ))}
            </div>
            <div className="choice-grid">
              <Choice
                label="返回"
                tone="ghost"
                onClick={() => setUi((state) => ({ ...state, dangerStage: "ask" }))}
              />
            </div>
          </section>
        );
      }
      return (
        <section className="panel wizard">
          <p className="eyebrow">催收 · 金额</p>
          <h2 className="question">催收多少？</h2>
          <p className="step-hint">
            {chosenDebt === null
              ? "请选择要催收的合同"
              : playerName(view, chosenDebt.counterpartyId) + " 剩余 " + formatCents(chosenDebt.remainingCents)}
          </p>
          <p className="step-hint">催收上限为“剩余欠款”与对方当前金币中的较小值，最终以服务端为准。</p>
          <input
            className="input amount-input"
            inputMode="numeric"
            placeholder="催收金额（分）"
            value={amount}
            onChange={(event) => setAmount(event.target.value.trim())}
          />
          <div className="choice-grid">
            <Choice
              label="确认催收"
              disabled={chosenDebt === null}
              onClick={() => {
                if (chosenDebt === null) {
                  setNotice("请先选择要催收的合同");
                  return;
                }
                if (!amountValid) {
                  setNotice("催收金额必须是大于 0 且不超过 " + MONEY_LIMIT_TEXT + " 的整数");
                  return;
                }
                send(() => client.collectPrivateLoan(chosenDebt.loanId, amount, versionOptions));
              }}
            />
            <Choice
              label="返回"
              tone="ghost"
              onClick={() => setUi((state) => ({ ...state, dangerStage: "collect" }))}
            />
          </div>
        </section>
      );
    }

    if (current.kind === "actionOwn") {
      const stage = current.stage;
      const debtList = current.debtOptions;

      if (stage === "askPrivate") {
        return (
          <section className="panel wizard">
            <p className="eyebrow">行动 · 第 1 问</p>
            <h2 className="question">是否向其他玩家借款？</h2>
            <p className="step-hint">
              跳过不消耗行动；提交成功后行动立即用掉，并进入等待。
            </p>
            <div className="choice-grid">
              <Choice
                label="是，查看可借玩家"
                hint={privateLenders.length === 0 ? "当前没有存活的其他玩家" : "共 " + String(privateLenders.length) + " 人"}
                disabled={privateLenders.length === 0}
                onClick={() => {
                  if (privateLenders.length === 0) {
                    setNotice("当前没有可借款的存活玩家");
                    return;
                  }
                  setActionStage("privateLender");
                }}
              />
              <Choice label="跳过" hint="进入 Q2" tone="ghost" onClick={() => setActionStage("askBank")} />
            </div>
          </section>
        );
      }

      if (stage === "privateLender") {
        return (
          <section className="panel wizard">
            <p className="eyebrow">行动 · Q1 选择出借人</p>
            <h2 className="question">向谁借款？</h2>
            <div className="choice-grid">
              {privateLenders.map((player) => {
                const limit = lenderLimitOf(view, player.playerId);
                const hint =
                  "信用 " + creditLabel(player.credit) +
                  " · 失信欠款 " + formatCents(player.defaultedBankDebtCents) +
                  (limit === null
                    ? ""
                    : limit === "0"
                      ? " · 暂无可借额度"
                      : " · 最多可借 " + formatCents(limit));
                return (
                  <Choice
                    key={player.playerId}
                    label={player.nickname + "（座位 " + String(player.seatId) + "）"}
                    hint={hint}
                    disabled={limit === "0"}
                    onClick={() => {
                      setLenderId(player.playerId);
                      setActionStage("privateAmount");
                    }}
                  />
                );
              })}
            </div>
            <div className="choice-grid">
              <Choice label="取消（跳过 Q1）" tone="ghost" onClick={() => setActionStage("askBank")} />
            </div>
          </section>
        );
      }

      if (stage === "privateAmount") {
        return (
          <section className="panel wizard">
            <p className="eyebrow">行动 · Q1 金额与利率</p>
            <h2 className="question">
              向 {chosenLender === null ? "出借人" : chosenLender.nickname} 借多少？
            </h2>
            <p className="step-hint">
              {privateLimitText(view, chosenLender?.playerId ?? "")}；利率 0～10000 基点，本局标准利率为 10%（1000 基点）。
            </p>
            <input
              className="input amount-input"
              inputMode="numeric"
              placeholder="借款金额（分）"
              value={amount}
              onChange={(event) => setAmount(event.target.value.trim())}
            />
            {privateOverLimit ? (
              <p className="step-hint danger-text">最多可借 {formatCents(chosenLenderLimit!)}</p>
            ) : null}
            <input
              className="input"
              inputMode="numeric"
              placeholder="利率（基点，1000 = 10%）"
              value={rateText}
              onChange={(event) => setRateText(event.target.value.trim())}
            />
            <div className="choice-grid">
              <Choice
                label="提交借款请求"
                disabled={privateOverLimit || chosenLender === null}
                onClick={submitPrivateRequest}
              />
              <Choice label="返回" tone="ghost" onClick={() => setActionStage("privateLender")} />
            </div>
          </section>
        );
      }

      if (stage === "askBank") {
        return (
          <section className="panel wizard">
            <p className="eyebrow">行动 · 第 2 问</p>
            <h2 className="question">是否向银行借款？</h2>
            <p className="step-hint">
              当前金币 {formatCents(finance.cents)}；{bankLimitText(view)}。
            </p>
            {blockedBank !== null ? (
              <p className="step-hint danger-text">{blockedBank}</p>
            ) : bankLimit === "0" ? (
              <p className="step-hint danger-text">当前金币不足以产生可借额度，暂不能向银行借款</p>
            ) : null}
            <div className="choice-grid">
              <Choice
                label="是，输入金额"
                disabled={bankUnavailable}
                onClick={() => setActionStage("bankAmount")}
              />
              <Choice label="不需要" hint="进入 Q3" tone="ghost" onClick={() => setActionStage("askDebt")} />
            </div>
          </section>
        );
      }

      if (stage === "bankAmount") {
        return (
          <section className="panel wizard">
            <p className="eyebrow">行动 · Q2 银行金额</p>
            <h2 className="question">向银行借多少？</h2>
            <p className="step-hint">
              当前金币 {formatCents(finance.cents)}；{bankLimitText(view)}。
            </p>
            <input
              className="input amount-input"
              inputMode="numeric"
              placeholder="借款金额（分）"
              value={amount}
              onChange={(event) => setAmount(event.target.value.trim())}
            />
            {bankOverLimit ? (
              <p className="step-hint danger-text">最多可借 {formatCents(bankLimit!)}</p>
            ) : null}
            <div className="choice-grid">
              <Choice
                label="确认借款"
                disabled={bankUnavailable || bankOverLimit}
                onClick={() => {
                  if (!amountValid) {
                    setNotice("借款金额必须是大于 0 且不超过 " + MONEY_LIMIT_TEXT + " 的整数");
                    return;
                  }
                  send(() => client.borrowBank(amount, versionOptions));
                }}
              />
              <Choice label="返回" tone="ghost" onClick={() => setActionStage("askBank")} />
            </div>
          </section>
        );
      }

      if (stage === "askDebt") {
        return (
          <section className="panel wizard">
            <p className="eyebrow">行动 · 第 3 问</p>
            <h2 className="question">是否还款或催收？</h2>
            <div className="choice-grid">
              {debtList.map((option) => (
                <Choice
                  key={option.kind + ":" + option.loanId}
                  label={debtOptionLabel(view, option)}
                  hint={debtOptionHint(option)}
                  onClick={() => {
                    setDebtLoanId(option.loanId);
                    setActionStage("debtAmount");
                  }}
                />
              ))}
            </div>
            <div className="choice-grid">
              <Choice label="跳过" hint="进入 Q4" tone="ghost" onClick={() => setActionStage("endAction")} />
            </div>
          </section>
        );
      }

      if (stage === "debtAmount") {
        return (
          <section className="panel wizard">
            <p className="eyebrow">行动 · Q3 金额</p>
            <h2 className="question">
              {chosenDebt === null ? "选择一笔贷款或合同" : debtOptionLabel(view, chosenDebt) + "：还/收多少？"}
            </h2>
            {chosenDebt !== null ? <p className="step-hint">{debtOptionHint(chosenDebt)}</p> : null}
            <input
              className="input amount-input"
              inputMode="numeric"
              placeholder="金额（分）"
              value={amount}
              onChange={(event) => setAmount(event.target.value.trim())}
            />
            <div className="choice-grid">
              <Choice
                label={chosenDebt !== null && chosenDebt.kind === "collectPrivate" ? "确认催收" : "确认还款"}
                disabled={chosenDebt === null}
                onClick={submitDebt}
              />
              <Choice label="返回" tone="ghost" onClick={() => setActionStage("askDebt")} />
            </div>
          </section>
        );
      }

      return (
        <section className="panel wizard">
          <p className="eyebrow">行动 · 第 4 问</p>
          <h2 className="question">结束行动？</h2>
          <p className="step-hint">确认后本轮行动用掉，等待其他玩家完成行动。</p>
          <div className="choice-grid">
            <Choice
              label="确认结束行动"
              onClick={() => send(() => client.endAction(versionOptions))}
            />
            {debtList.length > 0 ? (
              <Choice label="返回 Q3" tone="ghost" onClick={() => setActionStage("askDebt")} />
            ) : null}
          </div>
        </section>
      );
    }

    return (
      <section className="panel wizard">
        <p className="eyebrow">等待</p>
        <h2 className="question">{current.title}</h2>
        <p className="step-hint">{current.detail}</p>
      </section>
    );
  }

  if (status === "replaced") {
    return <section className="panel replaced">
      <h1>已在另一页面恢复</h1>
      <p>当前页面已停止操作；请在接管页面继续，或主动返回恢复入口。</p>
      <button type="button" className="primary" onClick={() => { clearSession(); window.location.reload(); }}>返回恢复入口</button>
    </section>;
  }

  /**
   * 命令结果/服务端 error/本地校验提示放在顶部吸顶区，滚动到操作卡后仍然可见。
   * 同一时刻只渲染一条（优先级：本地校验 > 服务端错误 > 命令结果）：多条横幅会占掉
   * 45vh 吸顶预算，把事件通知架挤到接近 0 高（复核 05E should-fix 1）。
   */
  const feedbackBanner = (() => {
    if (notice !== null && step.kind !== "gameOver") {
      return (
        <div className="banner fail" role="alert">
          <span>{notice}</span>
          <button type="button" className="link" aria-label="关闭校验提示" onClick={() => setNotice(null)}>
            关闭
          </button>
        </div>
      );
    }
    if (errorVisible && error !== null && step.kind !== "gameOver") {
      return (
        <div className="banner fail" role="alert">
          <span>
            {error.code}：{error.message}
          </span>
          <button
            type="button"
            className="link"
            aria-label="关闭错误提示"
            onClick={() => setDismissedError(error.code + "|" + error.message)}
          >
            关闭
          </button>
        </div>
      );
    }
    if (resultVisible && result !== null) {
      const tone = result.outcome.ok
        ? resultKind === "accept" || resultKind === "bankDue" || resultKind === "giveUp"
          ? "info"
          : "ok"
        : "fail";
      return (
        <div className={"banner " + tone} role={tone === "fail" ? "alert" : "status"}>
          <span>
            {result.outcome.ok
              ? commandSuccessText(resultKind, view, { ...resultCommand, events: [...(resultCommand?.events ?? []), ...events] })
              : result.outcome.code + "：" + result.outcome.message}
          </span>
          <button
            type="button"
            className="link"
            aria-label="关闭结果提示"
            onClick={() => setDismissedResult(result.commandId)}
          >
            关闭
          </button>
        </div>
      );
    }
    return null;
  })();

  return (
    <div className="game">
      <div className="game-sticky">
        <header className="game-top">
          <div>
            <p className="eyebrow">房间 {roomCode}</p>
            <p className="top-line">
              第 {view.round} 轮 · {stageHeadline(view)}
              <span className="top-sep">·</span>
              剩余 <Countdown deadlineAt={view.deadlineAt} {...countdownProps} />
            </p>
          </div>
          <div className={"conn " + status} title={statusDetail ?? undefined}>
            <span className={"dot " + status} />
            {CONN_LABELS[status]}
          </div>
        </header>
        {feedbackBanner}
        {eventNotices.length > 0 ? (
          <div className="notice-shelf" role="log" aria-label="事件通知">
            {eventNotices.slice(0, 4).map((item) => (
              <div className={"banner " + item.tone} key={item.id}>
                <span>{item.text}</span>
                <button
                  type="button"
                  className="link"
                  aria-label={"关闭通知：" + item.text.slice(0, 16)}
                  onClick={() => {
                    dismissEventNotice(noticeHistoryRef.current, item.id);
                    refreshNotices(tick => tick + 1);
                  }}
                >
                  关闭
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {phaseToast !== null ? <div className="phase-toast">{phaseToast}</div> : null}

      <section className="panel self-panel">
        <div className="self-head">
          <div>
            <p className="eyebrow">我</p>
            <p className="self-name">
              {view.me.nickname} · 座位 {view.me.seatId}
            </p>
          </div>
          <button type="button" className="topbar-btn" onClick={() => setDrawerOpen(true)}>
            查看其他玩家（不消耗行动）
          </button>
        </div>
        <div className="stats">
          <div className="stat">
            <span className="stat-label">金币</span>
            <span className="stat-value">{formatCents(finance.cents)}</span>
          </div>
          <div className="stat">
            <span className="stat-label">总负债</span>
            <span className="stat-value">
              银行 {formatCents(finance.bankDebtCents)} · 私人 {formatCents(finance.privateDebtCents)}
            </span>
          </div>
          <div className="stat">
            <span className="stat-label">失信银行欠款</span>
            <span className="stat-value">{formatCents(finance.bankDefaultedDebtCents)}</span>
          </div>
          <div className="stat">
            <span className="stat-label">冻结 / 坏账</span>
            <span className="stat-value">
              {formatCents(finance.frozenCents)} / {formatCents(finance.badDebtCents)}
            </span>
          </div>
          <div className="stat">
            <span className="stat-label">可借额度</span>
            <span className="stat-value small">
              {blockedBank !== null
                ? blockedBank + "（可借 0 分）"
                : bankLimit === null
                  ? BANK_LOAN_LIMIT_HINT
                  : formatCents(bankLimit)}
            </span>
          </div>
          <div className="stat">
            <span className="stat-label">信用 / 状态</span>
            <span className="stat-value small">
              {creditLabel(view.me.credit)} / {statusLabel(view.me.status)}
            </span>
          </div>
        </div>
      </section>

      <section className="stage">
        {step.kind === "gameOver" ? renderStep(step) : !canSubmit ? <section className="panel wizard">
          <p className="eyebrow">连接未就绪</p><h2 className="question">连接恢复后才能继续操作</h2>
          <p className="step-hint">当前仅显示最后一次快照；重连后以服务端最新状态重新确认。</p>
        </section> : currentConfirmation !== null ? renderConfirm(currentConfirmation) : abandonPending && step.kind === "betting" ?
          <section className="panel wizard"><p className="eyebrow">下注</p><h2 className="question">正在提交放弃…</h2>
            <p className="step-hint">等待服务端确认锁定。</p></section> : renderStep(step)}
      </section>

      {finance.privateLoans.length > 0 ? (
        <section className="panel">
          <h2>我的私人合同</h2>
          <div className="loan-list">
            {finance.privateLoans.map((loan) => (
              <div className="loan-row" key={loan.loanId}>
                <span>
                  {loan.borrowerId === view.me.playerId
                    ? "我欠 " + playerName(view, loan.lenderId)
                    : playerName(view, loan.borrowerId) + " 欠我"}
                </span>
                <span>剩余 {formatCents(loan.remainingCents)}</span>
                <span>利率 {rateLabel(loan.rateBps)}</span>
                <span>{privateLoanStatusLabel(loan.status)}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {finance.bankLoans.length > 0 ? (
        <section className="panel">
          <h2>我的银行贷款</h2>
          <div className="loan-list">
            {finance.bankLoans.map((loan) => (
              <div className="loan-row" key={loan.loanId}>
                <span>{loan.origin === "OVERDRAFT" ? "透支贷款" : "普通贷款"}</span>
                <span>剩余 {formatCents(loan.remainingCents)}</span>
                <span>第 {loan.dueRound} 轮到期</span>
                <span>{loanStatusLabel(loan.status)}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {drawerOpen && step.kind !== "gameOver" ? (
        <div className="overlay" role="dialog" aria-modal="true" onClick={() => setDrawerOpen(false)}>
          <aside className="drawer" onClick={(event) => event.stopPropagation()}>
            <div className="drawer-head">
              <h2>其他玩家</h2>
              <button type="button" className="link" onClick={() => setDrawerOpen(false)}>
                关闭
              </button>
            </div>
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
                  <span className="player-defaulted-debt">{formatCents(player.defaultedBankDebtCents)}</span>
                </div>
              ))}
            </div>
            <p className="hint">查询不消耗行动，也不会打断当前引导步骤。</p>
          </aside>
        </div>
      ) : null}

      {settlement !== null && settlementCard !== null && step.kind !== "gameOver" ? (
        <div className="overlay" role="dialog" aria-modal="true">
          <div className="overlay-card">
            <p className="eyebrow">第 {settlement.round} 轮结算</p>
            <h2>本轮结束</h2>
            <SettlementBody card={settlementCard} />
            <div className="settle-balance">
              <span className="stat-label">余额变化</span>
              <span>
                {formatCents(settlement.before)} <span className="arrow">→</span>{" "}
                {formatCents(deriveSettlementBalance(settlement.before, settlementCard))}
              </span>
            </div>
            <button type="button" className="primary wide" onClick={() => setSettlement(null)}>
              继续
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function debtOptionLabel(view: WireSnapshotView, option: DebtOption): string {
  if (option.kind === "repayBank") {
    return "还银行贷款 " + formatCents(option.remainingCents);
  }
  if (option.kind === "repayPrivate") {
    return "还 " + playerName(view, option.counterpartyId) + " " + formatCents(option.remainingCents);
  }
  return "向 " + playerName(view, option.counterpartyId) + " 催收 " + formatCents(option.remainingCents);
}

function debtOptionHint(option: DebtOption): string {
  const base = "利率 " + rateLabel(option.rateBps);
  if (option.kind === "repayBank") {
    return base + " · 第 " + String(option.dueRound ?? 0) + " 轮到期";
  }
  if (option.kind === "repayPrivate") return base + " · 私人合同";
  return base + " · 实际可收以服务端为准";
}

function SettlementBody({ card }: { card: RoundSettlement }) {
  if (!card.hasData) {
    return <p className="step-hint">本轮没有利息、税或下注结算事件。</p>;
  }
  return (
    <div className="settle-lines">
      {card.lines.map((line) => (
        <div className={"settle-line " + line.tone} key={line.label}>
          <span className="stat-label">{line.label}</span>
          <span>{line.value}</span>
        </div>
      ))}
    </div>
  );
}
