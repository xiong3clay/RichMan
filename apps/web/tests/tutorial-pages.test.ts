import { describe, expect, it } from "vitest";
import { RULES, TIMERS } from "@richman/shared";
import { TUTORIAL_PAGES } from "../src/tutorial/pages";
import { RULE_SECTIONS } from "../src/tutorial/rules";

const ALL_PAGES_TEXT = TUTORIAL_PAGES
  .map((page) => [page.title, ...page.paragraphs, ...(page.checklist ?? [])].join(""))
  .join("");
const ALL_RULES_TEXT = RULE_SECTIONS
  .map((section) => [section.title, ...section.paragraphs, ...section.bullets].join(""))
  .join("");

const PRIVATE_PAGE = TUTORIAL_PAGES.find((page) => page.id === "private")!;
const PRIVATE_RULES = RULE_SECTIONS.find((section) => section.id === "private-loan")!;
const PRIVATE_PAGE_TEXT = [PRIVATE_PAGE.title, ...PRIVATE_PAGE.paragraphs].join("");
const PRIVATE_RULES_TEXT = [PRIVATE_RULES.title, ...PRIVATE_RULES.paragraphs, ...PRIVATE_RULES.bullets].join("");

const GAMBLE_PAGE = TUTORIAL_PAGES.find((page) => page.id === "gamble")!;
const TAX_RULES = RULE_SECTIONS.find((section) => section.id === "tax-rescue")!;
const GAMBLE_TEXT = [GAMBLE_PAGE.title, ...GAMBLE_PAGE.paragraphs].join("");
const TAX_PARAGRAPHS = TAX_RULES.paragraphs.join("");
const TAX_BULLETS = TAX_RULES.bullets.join("");

const OLD_PAGE_PRIVATE =
  "同一个借款人同时最多 1 个待答复请求；同一出借人可以同时收到多人的请求。" +
  "出借人可随时催收（上限=对方当前金币），借款人可随时还。";
const OLD_RULES_PRIVATE =
  "同一借款人同时最多 1 个待答复请求；同一出借人可以同时收到多人的请求。" +
  "同意后立刻转账；每轮按约定利率计息；出借人可随时催收，上限为对方当前金币；借款人可随时还。";
const OLD_TAX_BULLET = "自救期间引擎只接受私人借款、催收、还款与放弃操作。";

function privateLoanContract(text: string) {
  return {
    cap: text.includes("剩余应收与对方当前金币的较小值")
      && !text.includes("上限=对方当前金币")
      && !text.includes("上限为对方当前金币"),
    round: text.includes("借出当轮不能催收") && !text.includes("随时催收"),
    window: text.includes("在自己的行动窗口或自救阶段可以还款") && !text.includes("随时还"),
    single: text.includes("同一时间只处理一个待答复请求")
      && !text.includes("同一出借人可以同时收到多人的请求"),
  };
}

function rescueContract(p4: string, r6Paragraphs: string, r6Bullets: string): boolean {
  return p4.includes("借款、催收或放弃")
    && r6Paragraphs.includes("紧急借款、催收、放弃")
    && r6Bullets.includes("同意、拒绝或取消")
    && r6Bullets.includes("不能新借银行贷款")
    && !p4.includes("还款")
    && !r6Paragraphs.includes("还款")
    && !r6Bullets.includes("还款")
    && !p4.includes("还款与放弃")
    && !r6Bullets.includes("还款与放弃");
}

describe("08A 教程与规则内容契约", () => {
  it("T1 教程恰好 5 页，id 唯一，标题与正文非空", () => {
    expect(TUTORIAL_PAGES).toHaveLength(5);
    expect(new Set(TUTORIAL_PAGES.map((page) => page.id)).size).toBe(5);
    for (const page of TUTORIAL_PAGES) {
      expect(page.title.length).toBeGreaterThan(0);
      expect(page.paragraphs.length).toBeGreaterThan(0);
      expect(page.paragraphs.every((paragraph) => paragraph.length > 0)).toBe(true);
    }
  });

  it("T1 全部正文总字数不超过 1200", () => {
    expect(ALL_PAGES_TEXT.length).toBeLessThanOrEqual(1200);
  });

  it("T2 主线关键词全部出现", () => {
    for (const keyword of ["失信", "50%", "10%", "45 秒", "透支", "0 注", "债务中心", "冻结", "坏账"]) {
      expect(ALL_PAGES_TEXT).toContain(keyword);
    }
  });

  it("教程数字与 RULES/TIMERS 一致", () => {
    expect(ALL_PAGES_TEXT).toContain(`${RULES.playerMin}～${RULES.playerMax} 人同房`);
    expect(ALL_PAGES_TEXT).toContain(`开局 ${RULES.startCents / 100} 金币`);
    expect(ALL_PAGES_TEXT).toContain(`当前金币的 ${RULES.ordinaryLoanMaxPercent}%`);
    expect(ALL_PAGES_TEXT).toContain(`每轮利息 ${RULES.interestBps / 100}%`);
    expect(ALL_PAGES_TEXT).toContain(`第 N+${RULES.loanInterestRoundsBeforeDue} 轮`);
    expect(ALL_PAGES_TEXT).toContain(`出借人 ${TIMERS.standard.requestSec} 秒内答复`);
    expect(ALL_PAGES_TEXT).toContain(`快速模式 ${TIMERS.fast.requestSec} 秒`);
    expect(ALL_PAGES_TEXT).toContain(`每 ${RULES.taxEveryRounds} 轮每人交 ${RULES.taxCents / 100} 金币税`);
    expect(ALL_PAGES_TEXT).toContain(`标准 ${TIMERS.standard.rescueSec} 秒`);
  });

  it("规则页固定 8 节且顺序与标题不变", () => {
    expect(RULE_SECTIONS.map((section) => section.title)).toEqual([
      "目标与流程",
      "银行普通贷款",
      "赌博透支贷款",
      "私人借贷",
      "下注",
      "税收与危险自救",
      "信用与失信",
      "隐私与查询",
    ]);
    for (const section of RULE_SECTIONS) {
      expect(section.paragraphs.length).toBeGreaterThan(0);
      expect(section.bullets.length).toBeGreaterThan(0);
    }
  });

  it("S2-M1 催收上限：剩余应收与对方当前金币的较小值，不是对方金币", () => {
    for (const text of [PRIVATE_PAGE_TEXT, PRIVATE_RULES_TEXT]) {
      expect(text).toContain("剩余应收与对方当前金币的较小值");
      expect(text).not.toContain("上限=对方当前金币");
      expect(text).not.toContain("上限为对方当前金币");
    }
  });

  it("S2-M1 借出当轮不能催收，之后才可在行动窗口或自救阶段催收", () => {
    for (const text of [PRIVATE_PAGE_TEXT, PRIVATE_RULES_TEXT]) {
      expect(text).toContain("借出当轮不能催收");
      expect(text).toContain("在自己的行动窗口或自救阶段");
      expect(text).not.toContain("随时催收");
      expect(text).not.toContain("随时还");
    }
  });

  it("S2-M1 借款人在自己的行动窗口或自救阶段可以还款", () => {
    for (const text of [PRIVATE_PAGE_TEXT, PRIVATE_RULES_TEXT]) {
      expect(text).toContain("在自己的行动窗口或自救阶段可以还款");
    }
  });

  it("S2-M2 同一时间只处理一个待答复请求，不承诺出借人多请求", () => {
    for (const text of [PRIVATE_PAGE_TEXT, PRIVATE_RULES_TEXT]) {
      expect(text).toContain("同一时间只处理一个待答复请求");
      expect(text).not.toContain("同一出借人可以同时收到多人的请求");
      expect(text).not.toContain("同时收到多人的请求");
    }
  });

  it("S2-M3 自救操作集合与界面一致：紧急借款、催收、放弃", () => {
    expect(GAMBLE_TEXT).toContain("只能向玩家借款、催收或放弃");
    expect(TAX_PARAGRAPHS).toContain("紧急借款、催收、放弃");
    expect(TAX_BULLETS).toContain("同意、拒绝或取消");
    expect(TAX_BULLETS).toContain("不能新借银行贷款");
    expect(GAMBLE_TEXT).not.toContain("还款");
    expect(TAX_PARAGRAPHS).not.toContain("还款");
    expect(TAX_BULLETS).not.toContain("还款");
    expect(ALL_PAGES_TEXT + ALL_RULES_TEXT).not.toContain("还款与放弃");
  });

  it("S2 反向探针：把私人借贷/自救文案改回旧版，上述检查会变红", () => {
    expect(privateLoanContract(OLD_PAGE_PRIVATE)).toEqual({
      cap: false,
      round: false,
      window: false,
      single: false,
    });
    expect(privateLoanContract(OLD_RULES_PRIVATE)).toEqual({
      cap: false,
      round: false,
      window: false,
      single: false,
    });
    expect(rescueContract("只能向玩家借款、催收或放弃", "只能向玩家借款、催收或放弃", OLD_TAX_BULLET)).toBe(false);
    expect(privateLoanContract(PRIVATE_PAGE_TEXT)).toEqual({
      cap: true,
      round: true,
      window: true,
      single: true,
    });
    expect(privateLoanContract(PRIVATE_RULES_TEXT)).toEqual({
      cap: true,
      round: true,
      window: true,
      single: true,
    });
    expect(rescueContract(GAMBLE_TEXT, TAX_PARAGRAPHS, TAX_BULLETS)).toBe(true);
  });
});
