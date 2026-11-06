import { describe, expect, it } from "vitest";
import {
  canCollectAll,
  canRepayAll,
  collectLimitOf,
  compareCentsText,
  deriveStep,
  INITIAL_UI_STATE,
} from "../src/game/steps.js";
import type { DebtOption, UiState } from "../src/game/steps.js";
import type { WireFinance, WireSnapshotView } from "../src/net/wire.js";
import { viewFixture } from "./view-fixtures.js";

function view(finance: Partial<WireFinance> = {}): WireSnapshotView {
  const base = viewFixture();
  return { ...base, finance: { ...base.finance, ...finance } };
}

function option(overrides: Partial<DebtOption> = {}): DebtOption {
  return {
    kind: "repayBank",
    loanId: "bank-1",
    remainingCents: "1000",
    rateBps: 1000,
    dueRound: 4,
    counterpartyId: "bank",
    ...overrides,
  };
}

function ui(overrides: Partial<UiState> = {}): UiState {
  return { ...INITIAL_UI_STATE, ...overrides };
}

describe("07C 全部还款 / 全部催收可用性", () => {
  it("S1 canRepayAll：金币=剩余可用、少 1 分不可用、负金币不可用", () => {
    const repay = option({ remainingCents: "1000" });
    expect(canRepayAll(view({ cents: "1000" }), repay)).toBe(true);
    expect(canRepayAll(view({ cents: "999" }), repay)).toBe(false);
    expect(canRepayAll(view({ cents: "-1000" }), repay)).toBe(false);
  });

  it("S2 canCollectAll：上限=剩余可用、少 1 分不可用、缺字段返回 null", () => {
    const collect = option({ kind: "collectPrivate", loanId: "p2p-1", remainingCents: "1000", counterpartyId: "p2" });
    expect(canCollectAll(view({ collectLimits: [{ loanId: "p2p-1", maxCents: "1000" }] }), collect)).toBe(true);
    expect(canCollectAll(view({ collectLimits: [{ loanId: "p2p-1", maxCents: "999" }] }), collect)).toBe(false);

    const legacy = view();
    delete (legacy.finance as Partial<WireFinance>).collectLimits;
    expect(canCollectAll(legacy, collect)).toBeNull();
  });

  it("collectLimitOf 对缺字段/非法值返回 null，旧快照不崩", () => {
    const legacy = view();
    delete (legacy.finance as Partial<WireFinance>).collectLimits;
    expect(collectLimitOf(legacy, "p2p-1")).toBeNull();
    expect(collectLimitOf(view({ collectLimits: [{ loanId: "p2p-1", maxCents: "-1" }] }), "p2p-1")).toBeNull();
    expect(collectLimitOf(view({ collectLimits: [{ loanId: "p2p-1", maxCents: "300" }] }), "p2p-1")).toBe("300");
  });

  it("S-N collectLimits 非数组（字符串/对象/null/undefined）返回 null 且不抛", () => {
    const broken = (limits: unknown): WireSnapshotView => ({
      ...view(),
      finance: { ...view().finance, collectLimits: limits as never },
    });
    expect(collectLimitOf(broken("x"), "p2p-1")).toBeNull();
    expect(collectLimitOf(broken({ loanId: "p2p-1" }), "p2p-1")).toBeNull();
    expect(collectLimitOf(broken(null), "p2p-1")).toBeNull();
    expect(collectLimitOf(broken(undefined), "p2p-1")).toBeNull();
  });

  it("S2 collectLimits 数组含 null/数字/缺字段元素时不抛错并返回 null", () => {
    const broken = (limits: unknown): WireSnapshotView => ({
      ...view(),
      finance: { ...view().finance, collectLimits: limits as never },
    });
    expect(collectLimitOf(broken([null]), "p2p-1")).toBeNull();
    expect(collectLimitOf(broken([42]), "p2p-1")).toBeNull();
    expect(collectLimitOf(broken([{ loanId: 1 }]), "p2p-1")).toBeNull();
    expect(collectLimitOf(broken([{ loanId: "p2p-1", maxCents: null }]), "p2p-1")).toBeNull();
    expect(collectLimitOf(
      broken([null, { loanId: "p2p-1", maxCents: "300" }, 42]),
      "p2p-1",
    )).toBe("300");
  });

  it("compareCentsText 只做十进制字符串比较", () => {
    expect(compareCentsText("1000", "999")).toBe(1);
    expect(compareCentsText("0", "0")).toBe(0);
    expect(compareCentsText("-1", "0")).toBe(-1);
    expect(compareCentsText("-1000", "-999")).toBe(-1);
  });
});

describe("07C 空 Q3 不自动跳过", () => {
  it("S3 无债务时 askDebt 停留原步骤，endAction 仍可进入", () => {
    const empty = view({ bankLoans: [], privateLoans: [] });
    const step = deriveStep(empty, ui({ actionStage: "askDebt" }));
    expect(step.kind).toBe("actionOwn");
    if (step.kind === "actionOwn") {
      expect(step.stage).toBe("askDebt");
      expect(step.debtOptions).toEqual([]);
    }
    const end = deriveStep(empty, ui({ actionStage: "endAction" }));
    expect(end.kind).toBe("actionOwn");
    if (end.kind === "actionOwn") expect(end.stage).toBe("endAction");
  });
});
