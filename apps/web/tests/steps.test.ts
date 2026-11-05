import { describe, expect, it } from "vitest";
import {
  BANK_LOAN_LIMIT_HINT,
  bankBlockedReason,
  bankLimitText,
  deriveStep,
  privateLimitText,
  withinLimit,
  debtOptions,
  INITIAL_UI_STATE,
  privateLenderOptions,
  uiAfterOutcome,
} from "../src/game/steps.js";
import type { UiState } from "../src/game/steps.js";
import { deriveRoundSettlement, deriveSettlementBalance, hasInterestBearingDebt } from "../src/game/settlement.js";
import { deriveEventNotices } from "../src/game/notices.js";
import type {
  WireBankLoan,
  WireFinance,
  WireGameEvent,
  WireLoanRequest,
  WireMe,
  WirePrivateLoan,
  WireSnapshotView,
} from "../src/net/wire.js";

const BASE_ME: WireMe = {
  playerId: "p1",
  seatId: 1,
  nickname: "甲",
  cents: "10000",
  credit: "GOOD",
  status: "ALIVE",
  alive: true,
};

const BASE_FINANCE: WireFinance = {
  cents: "10000",
  bankBorrowLimitCents: "5000",
  lenderLimits: [{ playerId: "p2", maxCents: "10000" }],
  bankLoans: [],
  bankDebtCents: "0",
  bankDefaultedDebtCents: "0",
  privateLoans: [],
  privateDebtCents: "0",
  receivableCents: "0",
  frozenCents: "0",
  badDebtCents: "0",
  pendingRequest: null,
  incomingRequests: [],
  myBet: null,
  betsSubmitted: [],
  aliveCount: 2,
};

const PUBLIC_PLAYERS = [
  { playerId: "p1", seatId: 1, nickname: "甲", credit: "GOOD" as const, status: "ALIVE" as const, alive: true, defaultedBankDebtCents: "0" },
  { playerId: "p2", seatId: 2, nickname: "乙", credit: "GOOD" as const, status: "ALIVE" as const, alive: true, defaultedBankDebtCents: "0" },
];

function makeView(input: {
  phase?: WireSnapshotView["phase"];
  round?: number;
  currentSeatId?: number | null;
  actedSeats?: number[];
  pendingDueLoanId?: string | null;
  winnerId?: string | null;
  me?: Partial<WireMe>;
  finance?: Partial<WireFinance>;
} = {}): WireSnapshotView {
  return {
    schemaVersion: 1,
    gameId: "g1",
    version: 10,
    round: input.round ?? 1,
    phase: input.phase ?? "ACTION",
    serverNow: "2026-11-03T00:00:00.000Z",
    deadlineAt: "2026-11-03T00:00:45.000Z",
    me: { ...BASE_ME, ...input.me },
    publicPlayers: PUBLIC_PLAYERS,
    winnerId: input.winnerId ?? null,
    finance: { ...BASE_FINANCE, ...input.finance },
    phaseInstanceId: "round1-action-1",
    eventSeq: 3,
    currentSeatId: input.currentSeatId === undefined ? 1 : input.currentSeatId,
    actedSeats: input.actedSeats ?? [],
    pendingDueLoanId: input.pendingDueLoanId ?? null,
  };
}

function loanRequest(overrides: Partial<WireLoanRequest> = {}): WireLoanRequest {
  return {
    requestId: "req-1",
    borrowerId: "p1",
    lenderId: "p2",
    principalCents: "5000",
    rateBps: 1000,
    createdRound: 1,
    createdAtMs: 1000,
    deadlineMs: 5000,
    status: "PENDING",
    borrowerCredit: "GOOD",
    borrowerDefaultedBankDebtCents: "0",
    ...overrides,
  };
}

function bankLoan(overrides: Partial<WireBankLoan> = {}): WireBankLoan {
  return {
    loanId: "bank-1",
    borrowerId: "p1",
    seatId: 1,
    principalCents: "5000",
    remainingCents: "5000",
    rateBps: 1000,
    issuedRound: 1,
    dueRound: 1,
    lastInterestRound: 1,
    status: "ACTIVE",
    origin: "NORMAL",
    ...overrides,
  };
}

function privateLoan(overrides: Partial<WirePrivateLoan> = {}): WirePrivateLoan {
  return {
    loanId: "p2p-1",
    requestId: "req-1",
    borrowerId: "p2",
    lenderId: "p1",
    principalCents: "5000",
    remainingCents: "5000",
    rateBps: 1000,
    issuedRound: 1,
    lastInterestRound: 1,
    status: "ACTIVE",
    ...overrides,
  };
}

function gameEvent(seq: number, type: string, payload: Record<string, unknown>): WireGameEvent {
  return { seq, type, at: "2026-11-03T00:00:00.000Z", payload };
}

function ui(overrides: Partial<UiState> = {}): UiState {
  return { ...INITIAL_UI_STATE, ...overrides };
}

describe("deriveStep：自己的行动回合", () => {
  it("轮到本人且尚无待处理请求时，从 Q1 私人借款开始", () => {
    const step = deriveStep(makeView({ phase: "ACTION", currentSeatId: 1 }), ui());
    expect(step).toEqual({ kind: "actionOwn", stage: "askPrivate", debtOptions: [] });
  });

  it("本地步骤推进到银行金额时，仍然只问银行金额", () => {
    const step = deriveStep(
      makeView({ phase: "ACTION", currentSeatId: 1 }),
      ui({ actionStage: "bankAmount" }),
    );
    expect(step.kind).toBe("actionOwn");
    if (step.kind === "actionOwn") expect(step.stage).toBe("bankAmount");
  });

  it("Q3 没有任何可还款/可催收项时自动跳到 Q4", () => {
    const step = deriveStep(
      makeView({ phase: "ACTION", currentSeatId: 1 }),
      ui({ actionStage: "askDebt" }),
    );
    expect(step.kind).toBe("actionOwn");
    if (step.kind === "actionOwn") expect(step.stage).toBe("endAction");
  });

  it("有未结清银行贷款时，Q3 列出“还银行”选项", () => {
    const view = makeView({
      phase: "ACTION",
      currentSeatId: 1,
      finance: { bankLoans: [bankLoan()], bankDebtCents: "5000" },
    });
    expect(debtOptions(view).map((option) => option.kind)).toEqual(["repayBank"]);
  });
});

describe("deriveStep：等待请求", () => {
  it("自己发出的请求等待答复时，只显示等待与取消", () => {
    const request = loanRequest();
    const step = deriveStep(
      makeView({ phase: "ACTION", currentSeatId: 1, finance: { pendingRequest: request } }),
      ui(),
    );
    expect(step.kind).toBe("requestBorrower");
    if (step.kind === "requestBorrower") expect(step.request.requestId).toBe("req-1");
  });

  it("收到别人请求时优先于自己的待处理请求（收到的是要回答的问题）", () => {
    const incoming = loanRequest({ requestId: "req-in", borrowerId: "p2", lenderId: "p1" });
    const step = deriveStep(
      makeView({
        phase: "ACTION",
        currentSeatId: 1,
        finance: { pendingRequest: loanRequest(), incomingRequests: [incoming] },
      }),
      ui(),
    );
    expect(step.kind).toBe("requestLender");
    if (step.kind === "requestLender") expect(step.request.requestId).toBe("req-in");
  });

  it("可借款对象排除自己和已破产玩家", () => {
    const view = makeView();
    view.publicPlayers.push({
      playerId: "p3",
      seatId: 3,
      nickname: "丙",
      credit: "GOOD",
      status: "BANKRUPT",
      alive: false,
      defaultedBankDebtCents: "0",
    });
    expect(privateLenderOptions(view).map((player) => player.playerId)).toEqual(["p2"]);
  });
});

describe("deriveStep：他人回合", () => {
  it("currentSeatId 指向别人时只显示等待", () => {
    const step = deriveStep(makeView({ phase: "ACTION", currentSeatId: 2 }), ui());
    expect(step.kind).toBe("actionWait");
    if (step.kind === "actionWait") {
      expect(step.seatId).toBe(2);
      expect(step.nickname).toBe("乙");
      expect(step.acted).toBe(false);
    }
  });

  it("自己已在本轮行动过时，即使 currentSeatId 仍是自己也不给操作", () => {
    const step = deriveStep(
      makeView({ phase: "ACTION", currentSeatId: 1, actedSeats: [1] }),
      ui(),
    );
    expect(step.kind).toBe("actionWait");
    if (step.kind === "actionWait") expect(step.acted).toBe(true);
  });
});

describe("deriveStep：下注", () => {
  it("未锁定时按本地步骤只问一个问题", () => {
    const step = deriveStep(makeView({ phase: "BETTING" }), ui({ betStage: "amount" }));
    expect(step).toEqual({ kind: "betting", stage: "amount" });
  });

  it("已锁定时只显示自己的锁定内容与提交人数，不可改", () => {
    const step = deriveStep(
      makeView({
        phase: "BETTING",
        finance: {
          myBet: { betCents: "2000", guess: 1, leverage: 2 },
          betsSubmitted: ["p1"],
          aliveCount: 2,
        },
        me: { credit: "DEFAULTED" },
      }),
      ui(),
    );
    expect(step.kind).toBe("betLocked");
    if (step.kind === "betLocked") {
      expect(step.bet.guess).toBe(1);
      expect(step.bet.leverage).toBe(2);
      expect(step.submitted).toBe(1);
      expect(step.alive).toBe(2);
    }
  });
});

describe("deriveStep：银行到期", () => {
  it("pendingDueLoanId 指向自己的贷款时显示还款/拒绝决策", () => {
    const step = deriveStep(
      makeView({
        phase: "BANK_DUE",
        pendingDueLoanId: "bank-1",
        finance: { bankLoans: [bankLoan()], bankDebtCents: "5000" },
      }),
      ui(),
    );
    expect(step.kind).toBe("bankDue");
    if (step.kind === "bankDue") {
      expect(step.loan.loanId).toBe("bank-1");
      expect(step.loan.remainingCents).toBe("5000");
    }
  });

  it("到期贷款不属于自己时显示明确等待文案，且不泄露任何 loanId", () => {
    const step = deriveStep(makeView({
      phase: "BANK_DUE",
      pendingDueLoanId: "other-player-secret-loan",
      finance: { bankLoans: [bankLoan()] },
    }), ui());
    expect(step).toEqual({
      kind: "waiting",
      title: "到期贷款处理中",
      detail: "正在处理其他玩家的到期贷款，处理完后会自动继续本轮。",
    });
    expect(JSON.stringify(step)).not.toContain("loanId");
    expect(JSON.stringify(step)).not.toContain("other-player-secret-loan");
    expect(JSON.stringify(step)).not.toContain("bank-1");
  });
});

describe("bankBlockedReason：银行普通贷款资格镜像 engine", () => {
  it("信用已失信时给失信原因", () => {
    const view = makeView({ me: { credit: "DEFAULTED" } });
    expect(bankBlockedReason(view)).toBe("你已失信，不能新增普通银行贷款");
  });

  it("金币为 0 时拒绝", () => {
    const view = makeView({ me: { cents: "0" }, finance: { cents: "0" } });
    expect(bankBlockedReason(view)).toBe("金币为 0，不能申请普通银行贷款");
  });

  it("以 finance.cents 判断零余额，不误用 me.cents", () => {
    expect(bankBlockedReason(makeView({ finance: { cents: "0" } })))
      .toBe("金币为 0，不能申请普通银行贷款");
    expect(bankBlockedReason(makeView({ me: { cents: "0" } }))).toBeNull();
  });

  it("负余额也不能申请普通银行贷款", () => {
    expect(bankBlockedReason(makeView({ finance: { cents: "-1" } })))
      .toBe("金币为负，不能申请普通银行贷款");
  });

  it("存在 DEFAULTED 贷款时给出失信欠款原因", () => {
    const view = makeView({
      finance: { bankLoans: [bankLoan({ loanId: "bank-defaulted", status: "DEFAULTED" })] },
    });
    expect(bankBlockedReason(view)).toBe("你有失信状态的银行贷款未结清，不能再次借款");
  });

  it("存在 ACTIVE 贷款时给出未结清原因", () => {
    const view = makeView({ finance: { bankLoans: [bankLoan()] } });
    expect(bankBlockedReason(view)).toBe("你有一笔未结清的银行贷款，不能再次借款");
  });

  it("未来新增 FROZEN 状态也按未结清拦截，不扩展当前 wire 协议", () => {
    const frozen = bankLoan();
    // 模拟未来服务端新增状态；当前协议和 WireBankLoan 的联合类型保持原样。
    Object.assign(frozen, { status: "FROZEN" });
    expect(bankBlockedReason(makeView({ finance: { bankLoans: [frozen] } })))
      .toBe("你有一笔未结清的银行贷款，不能再次借款");
  });

  it("信用良好、金币大于 0、无未结清贷款时允许申请", () => {
    const view = makeView({
      finance: { bankLoans: [bankLoan({ loanId: "bank-repaid", status: "REPAID" })] },
    });
    expect(bankBlockedReason(view)).toBeNull();
  });

  it("银行金额页共用 50% 规则提示，不推算精确额度", () => {
    expect(BANK_LOAN_LIMIT_HINT).toBe("普通贷款上限为当前金币的 50%，最终以服务端为准");
  });
});

describe("deriveStep：危险自救", () => {
  it("TAX 阶段本人危险时进入自救视图", () => {
    const step = deriveStep(
      makeView({ phase: "TAX", me: { status: "DANGER", cents: "-500" } }),
      ui({ dangerStage: "ask" }),
    );
    expect(step).toEqual({ kind: "danger", stage: "ask" });
  });

  it("别人危险时只等待自救，不提供操作", () => {
    const view = makeView({ phase: "TAX" });
    view.publicPlayers[1]!.status = "DANGER";
    const step = deriveStep(view, ui());
    expect(step.kind).toBe("waiting");
    if (step.kind === "waiting") expect(step.title).toContain("乙");
  });
});

describe("deriveStep：游戏结束", () => {
  it("GAME_OVER 显示胜者，不再显示任何操作", () => {
    const step = deriveStep(
      makeView({ phase: "GAME_OVER", winnerId: "p2", currentSeatId: null }),
      ui(),
    );
    expect(step).toEqual({ kind: "gameOver", winnerId: "p2", winnerName: "乙" });
  });
});

describe("deriveRoundSettlement：本轮结算卡", () => {
  it("只取本轮事件：税、下注结果与自己的余额", () => {
    const events: WireGameEvent[] = [
      {
        seq: 1,
        type: "TAX_CHARGED",
        at: "2026-11-03T00:00:00.000Z",
        payload: { seatId: 1, playerId: "p1", amountCents: "2000", centsAfter: "8000" },
      },
      {
        seq: 2,
        type: "BET_SETTLED",
        at: "2026-11-03T00:00:01.000Z",
        payload: {
          round: 3,
          drawResult: 1,
          players: [
            { playerId: "p1", betCents: "1000", guess: 1, leverage: 2, won: true, deltaCents: "2000", nextCents: "10000" },
          ],
        },
      },
      { seq: 3, type: "ROUND_STARTED", at: "2026-11-03T00:00:02.000Z", payload: { round: 4 } },
    ];
    const settlement = deriveRoundSettlement(events, 3, "p1");
    expect(settlement.round).toBe(3);
    expect(settlement.hasData).toBe(true);
    expect(settlement.lines).toHaveLength(2);
    expect(settlement.lines[0]!.value).toContain("2,000 分");
    expect(settlement.lines[1]!.value).toContain("猜 1");
    expect(settlement.lines[1]!.tone).toBe("good");
  });

  it("其他回合的税单不会混进本轮", () => {
    const events: WireGameEvent[] = [
      { seq: 1, type: "TAX_CHARGED", at: "x", payload: { playerId: "p1", amountCents: "2000", centsAfter: "8000" } },
      { seq: 2, type: "ROUND_STARTED", at: "y", payload: { round: 4 } },
    ];
    const settlement = deriveRoundSettlement(events, 4, "p1");
    expect(settlement.hasData).toBe(false);
  });

  it("利息行只对本人有 ACTIVE 债务的观看者显示", () => {
    const interest = gameEvent(1, "INTEREST_ACCRUED", { round: 3 });
    const withoutDebt = deriveRoundSettlement([interest], 3, "p1", { hasOutstandingLoans: false });
    expect(withoutDebt.lines.some((line) => line.label === "利息")).toBe(false);
    expect(withoutDebt.hasData).toBe(false);

    const withDebt = deriveRoundSettlement([interest], 3, "p1", { hasOutstandingLoans: true });
    expect(withDebt.lines.some((line) => line.label === "利息")).toBe(true);
    expect(withDebt.lines[0]?.value).toBe("本轮有贷款计息，具体以本人债务记录为准");
  });

  it("hasInterestBearingDebt 只按快照字段过滤，不做金额计算", () => {
    expect(hasInterestBearingDebt(makeView())).toBe(false);
    expect(
      hasInterestBearingDebt(makeView({ finance: { bankLoans: [bankLoan({ status: "REPAID" })] } })),
    ).toBe(false);
    expect(
      hasInterestBearingDebt(makeView({ finance: { bankLoans: [bankLoan({ status: "DEFAULTED" })] } })),
    ).toBe(false);
    expect(hasInterestBearingDebt(makeView({ finance: { bankLoans: [bankLoan()] } }))).toBe(true);
    // 私人合同列表也含本人出借的债权，不能将它当成本人借入的债务。
    expect(hasInterestBearingDebt(makeView({ finance: { privateLoans: [privateLoan()] } }))).toBe(false);
    expect(
      hasInterestBearingDebt(makeView({ finance: { privateLoans: [privateLoan({ borrowerId: "p1", lenderId: "p2" })] } })),
    ).toBe(true);
    expect(
      hasInterestBearingDebt(makeView({ finance: {
        privateLoans: [privateLoan({ borrowerId: "p1", lenderId: "p2", status: "REPAID" })],
      } })),
    ).toBe(false);
  });

  it("ACTIVE 债务按本人借款人身份过滤，本人出借的债权不算", () => {
    expect(hasInterestBearingDebt(makeView({ finance: {
      privateLoans: [privateLoan({ borrowerId: "p1", lenderId: "p2", status: "ACTIVE" })],
    } }))).toBe(true);
    expect(hasInterestBearingDebt(makeView({ finance: {
      privateLoans: [privateLoan({ borrowerId: "p2", lenderId: "p1", status: "ACTIVE" })],
    } }))).toBe(false);
    expect(hasInterestBearingDebt(makeView({ finance: {
      bankLoans: [bankLoan({ borrowerId: "p2" })],
    } }))).toBe(false);
  });

  it.each(["FROZEN", "BAD_DEBT"] as const)("私人 %s 本人借入债务不标记计息", (status) => {
    expect(hasInterestBearingDebt(makeView({ finance: {
      privateLoans: [privateLoan({ borrowerId: "p1", lenderId: "p2", status })],
    } }))).toBe(false);
  });

  it("只有 DEFAULTED 债务时，全局 INTEREST_ACCRUED 不显示本人利息行", () => {
    const view = makeView({
      round: 3,
      me: { credit: "DEFAULTED" },
      finance: {
        bankLoans: [bankLoan({ status: "DEFAULTED" })],
        bankDefaultedDebtCents: "5000",
      },
    });
    const settlement = deriveRoundSettlement(
      [gameEvent(1, "INTEREST_ACCRUED", { round: 3 })],
      3,
      view.me.playerId,
      { hasOutstandingLoans: hasInterestBearingDebt(view) },
    );
    expect(settlement.lines).toEqual([]);
    expect(settlement.hasData).toBe(false);
  });

  it("结算后余额按事件推导：税优先用 centsAfter", () => {
    const events: WireGameEvent[] = [
      gameEvent(1, "TAX_CHARGED", { playerId: "p1", amountCents: "2000", centsAfter: "8000" }),
      gameEvent(2, "BET_SETTLED", {
        round: 3,
        players: [
          { playerId: "p1", betCents: "1000", guess: 1, leverage: 2, won: true, deltaCents: "2000", nextCents: "10000" },
        ],
      }),
    ];
    expect(deriveRoundSettlement(events, 3, "p1").balanceAfterEvent).toBe("8000");
  });

  it("只有本人下注结算时使用 nextCents", () => {
    const events: WireGameEvent[] = [
      gameEvent(1, "BET_SETTLED", {
        round: 3,
        players: [
          { playerId: "p1", betCents: "1000", guess: 0, leverage: 1, won: false, deltaCents: "1000", nextCents: "9000" },
        ],
      }),
    ];
    expect(deriveRoundSettlement(events, 3, "p1").balanceAfterEvent).toBe("9000");
  });

  it("本轮没有任何结算事件时 balanceAfterEvent 为 null", () => {
    const card = deriveRoundSettlement([], 3, "p1");
    expect(card.hasData).toBe(false);
    expect(card.balanceAfterEvent).toBeNull();
  });

  it("按 seq 归属轮次，合并快照中的下一轮税单不能覆盖本轮税后余额", () => {
    const card = deriveRoundSettlement([
      gameEvent(1, "ROUND_STARTED", { round: 3 }),
      gameEvent(4, "TAX_CHARGED", { playerId: "p1", amountCents: "2000", centsAfter: "8000" }),
      gameEvent(6, "TAX_CHARGED", { playerId: "p1", amountCents: "2000", centsAfter: "5000" }),
      gameEvent(3, "BET_SETTLED", {
        round: 3, players: [{ playerId: "p1", nextCents: "10000", won: true }],
      }),
      gameEvent(5, "ROUND_STARTED", { round: 4 }),
    ], 3, "p1");
    expect(card.balanceAfterEvent).toBe("8000");
    expect(card.lines.find((line) => line.label === "税")?.value).toContain("8,000 分");
    expect(card.lines.some((line) => line.value.includes("5,000 分"))).toBe(false);
  });

  it("缺少本轮开始标记时也排除已知上一轮的无 round 税单", () => {
    const card = deriveRoundSettlement([
      gameEvent(1, "ROUND_STARTED", { round: 2 }),
      gameEvent(2, "TAX_CHARGED", { playerId: "p1", amountCents: "2000", centsAfter: "8000" }),
      gameEvent(3, "ROUND_STARTED", { round: 4 }),
    ], 3, "p1");
    expect(card.lines).toEqual([]);
    expect(card.balanceAfterEvent).toBeNull();
  });

  it("没有本人税单时用本人下注事件，其他玩家税单不影响本人余额", () => {
    const card = deriveRoundSettlement([
      gameEvent(1, "ROUND_STARTED", { round: 3 }),
      gameEvent(2, "BET_SETTLED", { round: 3, players: [
        { playerId: "p1", nextCents: "11000", won: true },
        { playerId: "p2", nextCents: "9000", won: false },
      ] }),
      gameEvent(3, "TAX_CHARGED", { playerId: "p2", amountCents: "2000", centsAfter: "7000" }),
      gameEvent(4, "ROUND_STARTED", { round: 4 }),
    ], 3, "p1");
    expect(card.balanceAfterEvent).toBe("11000");
    expect(card.lines.some((line) => line.label === "税")).toBe(false);
  });

  it("合并快照已受下一轮催收改变时仍用上一轮服务端结算事件", () => {
    const mergedSnapshot = makeView({ round: 4, finance: { cents: "3000" } });
    const card = deriveRoundSettlement([
      gameEvent(1, "ROUND_STARTED", { round: 3 }),
      gameEvent(2, "BET_SETTLED", { round: 3, players: [
        { playerId: "p1", nextCents: "10000", won: true },
      ] }),
      gameEvent(3, "TAX_CHARGED", { playerId: "p1", amountCents: "2000", centsAfter: "8000" }),
      gameEvent(4, "ROUND_STARTED", { round: 4 }),
      gameEvent(5, "PRIVATE_LOAN_COLLECTED", { borrowerId: "p1", centsAfter: "3000" }),
    ], 3, mergedSnapshot.me.playerId);
    expect(deriveSettlementBalance("9000", card)).toBe("8000");
    expect(deriveSettlementBalance("9000", card)).not.toBe(mergedSnapshot.finance.cents);
  });

  it("没有本人余额事件时保持 before，不采用下一轮快照余额", () => {
    const card = deriveRoundSettlement([
      gameEvent(1, "INTEREST_ACCRUED", { round: 3 }),
      gameEvent(2, "ROUND_STARTED", { round: 4 }),
      gameEvent(3, "BET_SETTLED", { round: 4, players: [{ playerId: "p1", nextCents: "100" }] }),
    ], 3, "p1", { hasOutstandingLoans: false });
    expect(deriveSettlementBalance("9000", card)).toBe("9000");
  });
});

describe("deriveEventNotices：事件→持久提示", () => {
  const ACTION_CONTEXT = { phase: "ACTION" as const, currentCents: "3000" };
  const KNOWN = { "req-1": { borrowerId: "p1", lenderId: "p2" } };

  it("BANK_LOAN_DEFAULTED 只对借款人显示原因、永久失信与当前金币", () => {
    const events = [
      gameEvent(11, "BANK_LOAN_DEFAULTED", {
        loanId: "bank-1",
        borrowerId: "p1",
        originalCents: "5000",
        reason: "insufficient_funds",
      }),
    ];
    const notices = deriveEventNotices(events, "p1", {}, ACTION_CONTEXT);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.text).toContain("余额不足");
    expect(notices[0]!.text).toContain("5,000 分");
    expect(notices[0]!.text).toContain("永久");
    expect(notices[0]!.text).toContain("3,000 分");

    expect(deriveEventNotices(events, "p2", {}, ACTION_CONTEXT)).toEqual([]);
  });

  it("LOAN_REQUEST_CLOSED(FAILED) 对出借人显示未成立且未转账", () => {
    const events = [gameEvent(12, "LOAN_REQUEST_CLOSED", { requestId: "req-1", status: "FAILED" })];
    const notices = deriveEventNotices(events, "p2", KNOWN, ACTION_CONTEXT);
    expect(notices[0]!.text).toBe("你的余额不足，本次借款未成立，未转账。");
  });

  it("LOAN_REQUEST_CLOSED(FAILED/REFUSED) 对借款人显示明确原因与行动已用掉", () => {
    const failed = [gameEvent(13, "LOAN_REQUEST_CLOSED", { requestId: "req-1", status: "FAILED" })];
    expect(deriveEventNotices(failed, "p1", KNOWN, ACTION_CONTEXT)[0]!.text).toContain("未成立");
    expect(deriveEventNotices(failed, "p1", KNOWN, ACTION_CONTEXT)[0]!.text).toContain("本次行动已用掉");

    const refused = [gameEvent(14, "LOAN_REQUEST_CLOSED", { requestId: "req-1", status: "REFUSED" })];
    expect(deriveEventNotices(refused, "p1", KNOWN, ACTION_CONTEXT)[0]!.text).toContain("被拒绝");
    expect(deriveEventNotices(refused, "p1", KNOWN, ACTION_CONTEXT)[0]!.text).toContain("本次行动已用掉");
  });

  it("LOAN_REQUEST_EXPIRED 对借款人显示已过期与行动已用掉", () => {
    const events = [gameEvent(15, "LOAN_REQUEST_EXPIRED", { requestId: "req-1" })];
    const notices = deriveEventNotices(events, "p1", KNOWN, ACTION_CONTEXT);
    expect(notices[0]!.text).toContain("已过期");
    expect(notices[0]!.text).toContain("本次行动已用掉");
  });

  it("TAX 自救阶段请求结束不写“行动已用掉”", () => {
    const events = [gameEvent(16, "LOAN_REQUEST_CLOSED", { requestId: "req-1", status: "REFUSED" })];
    const notices = deriveEventNotices(events, "p1", KNOWN, { phase: "TAX", currentCents: "-500" });
    expect(notices[0]!.text).toContain("自救继续");
    expect(notices[0]!.text).not.toContain("行动已用掉");
  });

  it("DANGER_RESCUED 仅 TAX 对本人显示已解除危险与快照当前金币", () => {
    const events = [gameEvent(17, "DANGER_RESCUED", { seatId: 1, playerId: "p1", cents: "500" })];
    const taxContext = { phase: "TAX" as const, currentCents: "1500" };
    const notices = deriveEventNotices(events, "p1", {}, taxContext);
    expect(notices[0]!.text).toBe("已解除危险，当前金币 1,500 分。");
    expect(deriveEventNotices(events, "p2", {}, taxContext)).toEqual([]);
    expect(deriveEventNotices(events, "p1", {}, ACTION_CONTEXT)).toEqual([]);
  });
});

describe("uiAfterOutcome：失败不消耗行动，停留原问题", () => {
  it("BORROW_BANK 超额失败后停留在银行金额问题", () => {
    const state = ui({ actionStage: "bankAmount" });
    const view = makeView({ phase: "ACTION", currentSeatId: 1 });
    const after = uiAfterOutcome(state, false);
    expect(after).toEqual(state);
    const step = deriveStep(view, after);
    expect(step.kind).toBe("actionOwn");
    if (step.kind === "actionOwn") expect(step.stage).toBe("bankAmount");
  });

  it("REPAY 超过金币失败后停留在还款金额问题", () => {
    const state = ui({ actionStage: "debtAmount" });
    const view = makeView({
      phase: "ACTION",
      currentSeatId: 1,
      finance: { bankLoans: [bankLoan()], bankDebtCents: "5000" },
    });
    const step = deriveStep(view, uiAfterOutcome(state, false));
    expect(step.kind).toBe("actionOwn");
    if (step.kind === "actionOwn") expect(step.stage).toBe("debtAmount");
  });

  it("只有成功才回到初始问题", () => {
    expect(uiAfterOutcome(ui({ actionStage: "endAction", dangerStage: "collect" }), true)).toEqual(
      INITIAL_UI_STATE,
    );
  });
});

describe("05F 借款额度文案与比较", () => {
  it("bankLimitText 可借时给具体数字", () => {
    expect(bankLimitText(makeView())).toBe(
      "最多可借 5,000 分（当前金币的 50%，向下取整）",
    );
  });

  it("bankLimitText 不可借时保留原因并显示 0 分", () => {
    expect(bankLimitText(makeView({ me: { credit: "DEFAULTED" } }))).toBe(
      "你已失信，不能新增普通银行贷款（可借 0 分）",
    );
  });

  it("bankLimitText 缺字段时回退旧通用文案", () => {
    const legacy = makeView();
    delete (legacy.finance as Partial<WireFinance>).bankBorrowLimitCents;
    expect(bankLimitText(legacy)).toBe(BANK_LOAN_LIMIT_HINT);
  });

  it("bankLimitText 缺字段且不可借时同样给出原因与 0 分", () => {
    const legacy = makeView({ me: { credit: "DEFAULTED" } });
    delete (legacy.finance as Partial<WireFinance>).bankBorrowLimitCents;
    expect(bankLimitText(legacy)).toBe("你已失信，不能新增普通银行贷款（可借 0 分）");
  });

  it("bankLimitText 额度为 0（金币只有 1 分）时说明原因", () => {
    expect(bankLimitText(makeView({ finance: { bankBorrowLimitCents: "0" } }))).toBe(
      "可借 0 分（当前金币不足以产生贷款额度）",
    );
  });

  it("privateLimitText 读取服务端 lenderLimits 并展示数字", () => {
    expect(privateLimitText(makeView(), "p2")).toBe(
      "最多可借 10,000 分（受对方可用资金与你余额上限限制）",
    );
    const view = makeView({ finance: { lenderLimits: [{ playerId: "p2", maxCents: "1234" }] } });
    expect(privateLimitText(view, "p2")).toContain("1,234 分");
  });

  it("privateLimitText 缺字段时回退旧通用文案", () => {
    const legacy = makeView();
    delete (legacy.finance as Partial<WireFinance>).lenderLimits;
    expect(privateLimitText(legacy, "p2")).toBe("金额上限以服务端为准");
  });

  it("withinLimit 只在合法整数分超过上限时判否", () => {
    expect(withinLimit("", "5000")).toBe(true);
    expect(withinLimit("0", "0")).toBe(true);
    expect(withinLimit("abc", "5000")).toBe(true);
    expect(withinLimit("5000", "5000")).toBe(true);
    expect(withinLimit("5001", "5000")).toBe(false);
    expect(withinLimit("9999999999999", "5000")).toBe(false);
    expect(withinLimit("1e4", "5000")).toBe(true);
    expect(withinLimit("0x1389", "5000")).toBe(true);
    expect(withinLimit("+5001", "5000")).toBe(true);
    expect(withinLimit("5001.0", "5000")).toBe(true);
    expect(withinLimit("5001", null)).toBe(true);
  });
});
