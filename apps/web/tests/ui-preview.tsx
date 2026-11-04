// Dev-only UI fixture. No requests or game commands are sent to a real server.
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { GameView } from "../src/GameView";
import type { RichmanClient, ConnectionStatus } from "../src/net/client";
import type { WireSnapshotView } from "../src/net/wire";
import { viewFixture, requestFixture, bankFixture } from "./view-fixtures";
import "../src/styles.css";

function fixture(scenario: string): WireSnapshotView {
  const v = viewFixture();
  v.serverNow = new Date().toISOString(); v.deadlineAt = new Date(Date.now() + 60000).toISOString();
  v.publicPlayers[1]!.nickname = "长昵称玩家ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  v.publicPlayers[1]!.defaultedBankDebtCents = "1000000000000";
  if (scenario === "lender") {
    const request = requestFixture(); request.borrowerCredit = "DEFAULTED"; request.borrowerDefaultedBankDebtCents = "5000";
    v.finance.incomingRequests = [request];
  }
  if (scenario === "danger") { v.phase = "TAX"; v.me.status = "DANGER"; v.me.cents = "-500"; v.finance.cents = "-500"; }
  if (scenario === "bank") {
    v.phase = "BANK_DUE"; const loan = bankFixture(); loan.remainingCents = "15000";
    v.finance.bankLoans = [loan]; v.pendingDueLoanId = loan.loanId;
  }
  return v;
}
function Preview() {
  const [view, setView] = useState(() => fixture("action"));
  const [status, setStatus] = useState<ConnectionStatus>("open");
  const [sent, setSent] = useState<string[]>([]);
  const client = useMemo(() => {
    const record = (kind: string, ...args: unknown[]): string => {
      setSent(history => [...history, JSON.stringify({ kind, args })]); return "preview-command";
    };
    return { hasJoined: true,
      acceptPrivateLoan: (...args: unknown[]) => record("ACCEPT_PRIVATE_LOAN", ...args),
      giveUpRescue: (...args: unknown[]) => record("RESCUE_GIVE_UP", ...args),
      decideBankDue: (...args: unknown[]) => record("BANK_DUE_DECISION", ...args),
    } as unknown as RichmanClient;
  }, []);
  return <div className="app">
    <p>仅UI测试夹具，不连接服务器</p>
    <label>场景<select aria-label="场景" onChange={event => { setView(fixture(event.target.value)); setSent([]); }}>
      <option value="action">行动</option><option value="lender">收到借款</option><option value="danger">危险自救</option><option value="bank">银行到期</option>
    </select></label>
    <label>连接<select aria-label="连接" onChange={event => setStatus(event.target.value as ConnectionStatus)}>
      <option value="open">在线</option><option value="closed">离线</option><option value="replaced">被替换</option>
    </select></label>
    <button onClick={() => setView(current => ({ ...current, version: current.version + 1,
      finance: { ...current.finance, incomingRequests: [] }, currentSeatId: 2 }))}>模拟请求撤回</button>
    <p data-testid="sent-count">已提交次数：{sent.length}</p>
    <pre data-testid="sent-commands">{sent.join("\n")}</pre>
    <GameView roomCode="0042" view={view} client={client} status={status} statusDetail={null} result={null} error={null} events={[]} />
  </div>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
