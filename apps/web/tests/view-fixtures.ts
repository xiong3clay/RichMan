import type { WireSnapshotView, WireLoanRequest, WireBankLoan } from "../src/net/wire";

export function viewFixture(): WireSnapshotView {
  return {
    schemaVersion: 1, gameId: "render-game", version: 1, round: 1, phase: "ACTION",
    phaseInstanceId: "action-1", eventSeq: 0, serverNow: "2026-11-04T00:00:00Z",
    deadlineAt: "2026-11-04T00:01:00Z", currentSeatId: 1, actedSeats: [], pendingDueLoanId: null, winnerId: null,
    me: { playerId: "p1", seatId: 1, nickname: "甲", cents: "10000", credit: "GOOD", status: "ALIVE", alive: true },
    publicPlayers: [
      { playerId: "p1", seatId: 1, nickname: "甲", credit: "GOOD", status: "ALIVE", alive: true, defaultedBankDebtCents: "0" },
      { playerId: "p2", seatId: 2, nickname: "乙", credit: "GOOD", status: "ALIVE", alive: true, defaultedBankDebtCents: "0" },
    ],
    finance: { cents: "10000", bankBorrowLimitCents: "5000",
      lenderLimits: [{ playerId: "p2", maxCents: "10000" }],
      bankLoans: [], bankDebtCents: "0", bankDefaultedDebtCents: "0",
      privateLoans: [], privateDebtCents: "0", receivableCents: "0", frozenCents: "0", badDebtCents: "0",
      pendingRequest: null, incomingRequests: [], myBet: null, betsSubmitted: [], aliveCount: 2 },
  };
}
export function bankFixture(): WireBankLoan {
  return { loanId: "bank-1", borrowerId: "p1", seatId: 1, principalCents: "1000", remainingCents: "1000",
    rateBps: 1000, issuedRound: 1, dueRound: 4, lastInterestRound: 1, status: "ACTIVE", origin: "NORMAL" };
}
export function requestFixture(): WireLoanRequest {
  return { requestId: "req-1", borrowerId: "p2", lenderId: "p1", principalCents: "500", rateBps: 1000,
    createdRound: 1, createdAtMs: 0, deadlineMs: Date.parse("2099-01-01T00:00:00.000Z"), status: "PENDING", borrowerCredit: "GOOD", borrowerDefaultedBankDebtCents: "0" };
}
