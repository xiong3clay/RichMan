import { useEffect, useState } from "react";
import type { WireCommandResult, WireSnapshotView } from "./net/wire";
import {
  creditLabel,
  formatCents,
  isNonNegativeCents,
  isPositiveCents,
  loanStatusLabel,
  phaseLabel,
  statusLabel,
} from "./net/wire";
import type { CommandOptions, RichmanClient } from "./net/client";

export interface GameViewProps {
  roomCode: string;
  view: WireSnapshotView;
  client: RichmanClient;
  result: WireCommandResult | null;
  /** 服务端推送的 error 消息（非 command_result），需在游戏内可见。 */
  error: { code: string; message: string } | null;
}

function Countdown({ deadlineAt }: { deadlineAt: string | null }) {
  const [text, setText] = useState("—");

  useEffect(() => {
    if (deadlineAt === null) {
      setText("—");
      return;
    }
    const target = Date.parse(deadlineAt);
    const tick = () => {
      const remaining = target - Date.now();
      if (!Number.isFinite(remaining) || remaining <= 0) {
        setText("0:00");
        return;
      }
      const totalSeconds = Math.floor(remaining / 1000);
      setText(String(Math.floor(totalSeconds / 60)) + ":" + String(totalSeconds % 60).padStart(2, "0"));
    };
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [deadlineAt]);

  return <span className="countdown">{text}</span>;
}

const MONEY_LIMIT_TEXT = formatCents("1000000000000");

/** 金额只做“规范整数分且不超过上限”的本地提示；真正校验与扣款全部由服务端完成。 */
export function GameView({ roomCode, view, client, result, error }: GameViewProps) {
  const [borrowInput, setBorrowInput] = useState("");
  const [repayInput, setRepayInput] = useState("");
  const [betInput, setBetInput] = useState("0");
  const [guess, setGuess] = useState<0 | 1>(0);
  const [leverage, setLeverage] = useState<1 | 2>(1);
  const [notice, setNotice] = useState<string | null>(null);

  const finance = view.finance;
  const currentSeatId = view.currentSeatId;
  const currentActor =
    currentSeatId === null
      ? null
      : view.publicPlayers.find((player) => player.seatId === currentSeatId) ?? null;

  let actionReason: string | null = null;
  if (view.phase !== "ACTION") {
    actionReason = "当前阶段是「" + phaseLabel(view.phase) + "」，不能执行行动";
  } else if (currentSeatId !== view.me.seatId) {
    actionReason = "还没轮到你，当前行动者是 " + (currentActor?.nickname ?? "其他玩家");
  } else if (finance.pendingRequest !== null) {
    actionReason = "正在等待出借人答复，暂不能继续行动";
  } else if (!view.me.alive) {
    actionReason = "已破产，不能行动";
  }

  let betReason: string | null = null;
  if (view.phase !== "BETTING") {
    betReason = "当前阶段是「" + phaseLabel(view.phase) + "」，只有下注阶段可以下注";
  } else if (finance.myBet !== null) {
    betReason = "本轮下注已锁定，不能修改";
  } else if (!view.me.alive) {
    betReason = "已破产，不能下注";
  }

  const actionBlocked = actionReason !== null;
  const betBlocked = betReason !== null;

  const send = (type: string, payload: Record<string, unknown>, options: CommandOptions) => {
    const commandId = client.sendCommand(type, payload, options);
    if (commandId === null) {
      setNotice("连接未就绪或快照尚未到达，命令未发送");
      return;
    }
    setNotice(null);
  };

  const borrow = () => {
    if (!isPositiveCents(borrowInput)) {
      setNotice("借款金额必须是大于 0 且不超过 " + MONEY_LIMIT_TEXT + " 的整数");
      return;
    }
    send("BORROW_BANK", { amountCents: borrowInput }, { expectedGameVersion: view.version });
  };

  const repay = (loanId: string) => {
    if (!isPositiveCents(repayInput)) {
      setNotice("还款金额必须是大于 0 且不超过 " + MONEY_LIMIT_TEXT + " 的整数");
      return;
    }
    send("REPAY_BANK", { loanId, cents: repayInput }, { expectedGameVersion: view.version });
  };

  const endAction = () => {
    send("END_ACTION", {}, { expectedGameVersion: view.version });
  };

  const submitBet = () => {
    if (!isNonNegativeCents(betInput)) {
      setNotice("下注金额必须是不超过 " + MONEY_LIMIT_TEXT + " 的非负整数");
      return;
    }
    send(
      "SUBMIT_BET",
      { betCents: betInput, guess, leverage },
      { roundId: view.round, phaseInstanceId: view.phaseInstanceId },
    );
  };

  return (
    <div className="game">
      <header className="game-top">
        <div className="game-title">
          <p className="eyebrow">房间码</p>
          <h1 className="room-code small">{roomCode}</h1>
        </div>
        <div className="game-meta">
          <span>第 {view.round} 轮</span>
          <span>阶段：{phaseLabel(view.phase)}</span>
          <span>
            当前行动者：{currentActor === null ? "无（等待阶段推进）" : currentActor.nickname}
          </span>
          <span>
            倒计时：<Countdown deadlineAt={view.deadlineAt} />
          </span>
        </div>
      </header>

      {result !== null ? (
        <div className={result.outcome.ok ? "banner ok" : "banner fail"}>
          {result.outcome.ok
            ? "操作成功（状态版本 " + String(result.gameVersion) + "）"
            : result.outcome.code + "：" + result.outcome.message}
        </div>
      ) : null}
      {error !== null ? (
        <div className="banner fail">
          {error.code}：{error.message}
        </div>
      ) : null}
      {notice !== null ? <div className="banner fail">{notice}</div> : null}

      <section className="panel">
        <h2>我的资产</h2>
        <div className="stats">
          <div className="stat">
            <span className="stat-label">金币</span>
            <span className="stat-value">{formatCents(finance.cents)}</span>
          </div>
          <div className="stat">
            <span className="stat-label">信用</span>
            <span className="stat-value">{creditLabel(view.me.credit)}</span>
          </div>
          <div className="stat">
            <span className="stat-label">失信银行欠款</span>
            <span className="stat-value">{formatCents(finance.bankDefaultedDebtCents)}</span>
          </div>
          <div className="stat">
            <span className="stat-label">总负债</span>
            <span className="stat-value">
              银行 {formatCents(finance.bankDebtCents)} · 私人 {formatCents(finance.privateDebtCents)}
            </span>
          </div>
        </div>
      </section>

      <section className="panel">
        <h2>玩家</h2>
        <div className="player-table">
          <div className="player-row player-head">
            <span>座位</span>
            <span>昵称</span>
            <span>信用</span>
            <span>状态</span>
            <span>失信欠款</span>
          </div>
          {view.publicPlayers.map((player) => (
            <div
              className={"player-row" + (player.seatId === currentSeatId ? " current" : "")}
              key={player.playerId}
            >
              <span>#{player.seatId}</span>
              <span>
                {player.nickname}
                {player.playerId === view.me.playerId ? <span className="tag me">我</span> : null}
                {!player.alive ? <span className="tag">出局</span> : null}
              </span>
              <span>{creditLabel(player.credit)}</span>
              <span>{statusLabel(player.status)}</span>
              <span>{formatCents(player.defaultedBankDebtCents)}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>我的行动</h2>
        {view.pendingDueLoanId !== null ? (
          <p className="reason">
            你有一笔到期贷款等待决策；05 最小版本未提供决策按钮，超时后会按“拒绝还款”自动结算。
          </p>
        ) : null}
        <div className="row">
          <input
            className="input"
            inputMode="numeric"
            placeholder="借款金额（分）"
            value={borrowInput}
            onChange={(event) => setBorrowInput(event.target.value.trim())}
            disabled={actionBlocked}
          />
          <button type="button" className="primary" onClick={borrow} disabled={actionBlocked}>
            借银行
          </button>
          <button type="button" className="primary" onClick={endAction} disabled={actionBlocked}>
            结束行动
          </button>
        </div>
        <p className="hint">金额单位为分：1 金币 = 100 分，输入十进制整数。</p>
        {actionReason !== null ? <p className="reason">{actionReason}</p> : null}
      </section>

      <section className="panel">
        <h2>银行贷款</h2>
        {finance.bankLoans.length === 0 ? (
          <p className="hint">暂无银行贷款。</p>
        ) : (
          <>
            <div className="row">
              <input
                className="input"
                inputMode="numeric"
                placeholder="还款金额（分）"
                value={repayInput}
                onChange={(event) => setRepayInput(event.target.value.trim())}
                disabled={actionBlocked}
              />
              <span className="hint">填好金额后点某一笔贷款右侧的“还这笔”。</span>
            </div>
            <div className="loan-list">
              {finance.bankLoans.map((loan) => (
                <div className="loan-row" key={loan.loanId}>
                  <span className="mono">{loan.loanId}</span>
                  <span>剩余 {formatCents(loan.remainingCents)}</span>
                  <span>第 {loan.dueRound} 轮到期</span>
                  <span>{loanStatusLabel(loan.status)}</span>
                  <button
                    type="button"
                    className="primary"
                    onClick={() => repay(loan.loanId)}
                    disabled={actionBlocked || loan.status !== "ACTIVE"}
                  >
                    还这笔
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </section>

      <section className={"panel" + (view.phase === "BETTING" ? " active-panel" : "")}>
        <h2>下注</h2>
        <div className="row">
          <input
            className="input"
            inputMode="numeric"
            placeholder="下注金额（分）"
            value={betInput}
            onChange={(event) => setBetInput(event.target.value.trim())}
            disabled={betBlocked}
          />
          <select
            className="input"
            value={guess}
            onChange={(event) => setGuess(event.target.value === "1" ? 1 : 0)}
            disabled={betBlocked}
          >
            <option value="0">猜 0</option>
            <option value="1">猜 1</option>
          </select>
          <select
            className="input"
            value={leverage}
            onChange={(event) => setLeverage(event.target.value === "2" ? 2 : 1)}
            disabled={betBlocked}
          >
            <option value="1">杠杆 1 倍</option>
            <option value="2">杠杆 2 倍</option>
          </select>
          <button type="button" className="primary" onClick={submitBet} disabled={betBlocked}>
            提交下注
          </button>
        </div>
        <p className="hint">
          已提交下注：{finance.betsSubmitted.length} / {finance.aliveCount}
          {finance.myBet !== null
            ? "；我已锁定 " +
              formatCents(finance.myBet.betCents) +
              "，猜 " +
              String(finance.myBet.guess) +
              "，杠杆 " +
              String(finance.myBet.leverage) +
              " 倍"
            : ""}
        </p>
        {betReason !== null ? <p className="reason">{betReason}</p> : null}
      </section>

      {view.phase === "GAME_OVER" ? (
        <section className="panel">
          <h2>对局结束</h2>
          <p>
            胜者：
            {view.winnerId === null
              ? "无"
              : view.publicPlayers.find((player) => player.playerId === view.winnerId)?.nickname ?? view.winnerId}
          </p>
        </section>
      ) : null}
    </div>
  );
}
