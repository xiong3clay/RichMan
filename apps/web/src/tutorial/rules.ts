import { DEFAULTED_PLAYER_LEVERAGE, RULES, TIMERS } from "@richman/shared";

const START_COINS = RULES.startCents / 100;
const TAX_COINS = RULES.taxCents / 100;
const INTEREST_PERCENT = RULES.interestBps / 100;
const REQUEST_SECONDS = TIMERS.standard.requestSec;
const FAST_REQUEST_SECONDS = TIMERS.fast.requestSec;
const RESCUE_SECONDS = TIMERS.standard.rescueSec;

export interface RuleSection {
  id: string;
  title: string;
  paragraphs: string[];
  bullets: string[];
}

/** 规则页 8 节，顺序固定；教程只讲主线，细节集中在这里。 */
export const RULE_SECTIONS: readonly RuleSection[] = [
  {
    id: "flow",
    title: "目标与流程",
    paragraphs: [
      `${RULES.playerMin}～${RULES.playerMax} 人同房，每人开局 ${START_COINS} 金币；最后没破产的人获胜。`,
      `每轮顺序：利息 → 银行到期 → 行动 → 全员下注 →（第 ${RULES.taxEveryRounds}/${RULES.taxEveryRounds * 2}/${RULES.taxEveryRounds * 3}…轮）税收 → 本轮结算。`,
    ],
    bullets: [
      "行动超时=结束行动；下注超时按 0 注；银行到期/自救超时按对应默认处理。",
      "金币内部以“分”记账，1 金币=100 分；界面按金币换算显示。",
    ],
  },
  {
    id: "bank-loan",
    title: "银行普通贷款",
    paragraphs: [
      `普通贷款最多借“当前金币的 ${RULES.ordinaryLoanMaxPercent}%”，每轮利息 ${INTEREST_PERCENT}%，发放轮 N 之后第 N+${RULES.loanInterestRoundsBeforeDue} 轮计息完到期。`,
      "到期余额足够：可以还，也可以选择不还；余额不足：直接失信，没有选择窗口。",
      "拒绝或超时=永久失信：这笔贷款不能再还、不再计息；不能再新增银行贷款；下注只能 1 倍；但不会被淘汰。",
    ],
    bullets: [
      "私人负债不影响普通银行贷款资格。",
      "失信欠款仍会在自身面板与债务中心显示，但不可偿还。",
    ],
  },
  {
    id: "overdraft",
    title: "赌博透支贷款",
    paragraphs: [
      "2 倍下注输且余额不足时，差额自动转为赌博透支贷款。",
      "透支贷款按银行规则计息，到期余额不足同样直接失信。",
      "失信欠款不可偿还、不再计息，与普通贷款分开展示。",
    ],
    bullets: [
      "透支贷款不会因为下一次赢钱而自动消失；仍按到期规则处理。",
    ],
  },
  {
    id: "private-loan",
    title: "私人借贷",
    paragraphs: [
      `利率 0～10000 基点（0%～100%），出借人 ${REQUEST_SECONDS} 秒内答复（快速模式 ${FAST_REQUEST_SECONDS} 秒）。`,
      "同一时间只处理一个待答复请求（由当前行动者发起）；同一个借款人同时最多 1 个待答复请求。",
      "同意后立刻转账；每轮按约定利率计息；出借人最多可收 = 剩余应收与对方当前金币的较小值；借出当轮不能催收，之后可在自己的行动窗口或自救阶段催收；借款人在自己的行动窗口或自救阶段可以还款。",
    ],
    bullets: [
      "借款人破产：这笔应收记坏账。出借人破产：合同冻结，不能再还或催收。",
      "失信者也能借，但出借人一定会看到“失信风险 + 失信欠款”。",
    ],
  },
  {
    id: "betting",
    title: "下注",
    paragraphs: [
      "每轮全员下注：猜 0 或 1、金额 0～当前金币、杠杆 1 或 2 倍。",
      "提交即锁定，不能改；全员提交后立即开奖，不必等倒计时。",
      "赢=+注额×杠杆，输=-注额×杠杆；开奖前看不到别人的金额、猜测与杠杆。",
    ],
    bullets: [
      "超时未提交按 0 注处理；0 注=放弃本轮下注。",
      `失信玩家只能 ${DEFAULTED_PLAYER_LEVERAGE} 倍杠杆。`,
    ],
  },
  {
    id: "tax-rescue",
    title: "税收与危险自救",
    paragraphs: [
      `每 ${RULES.taxEveryRounds} 轮每人交 ${TAX_COINS} 金币税。`,
      `余额不够进入“危险自救”（标准 ${RESCUE_SECONDS} 秒），界面上提供紧急借款、催收、放弃；自救期间不能新借银行贷款。`,
      "放弃或超时=破产：金币归 0、永久退出本局、私人债务转坏账、出借人应收冻结。",
    ],
    bullets: [
      "自救期间可发起紧急借款、催收、放弃；若有人正等你答复借款请求，仍可同意、拒绝或取消；不能新借银行贷款。",
    ],
  },
  {
    id: "credit",
    title: "信用与失信",
    paragraphs: [
      "失信是永久状态：银行贷款不能再还、不再计息，不能新增银行贷款。",
      "失信玩家不会被淘汰，仍可行动；下注只能 1 倍。",
      "失信者仍可向私人借钱，但出借人一定会看到失信风险与失信欠款金额。",
    ],
    bullets: [
      "失信欠款金额会在自身面板、他人公开信息与债务中心显示。",
    ],
  },
  {
    id: "privacy",
    title: "隐私与查询",
    paragraphs: [
      "自己可见：金币、银行/透支/失信欠款、私人负债、可借额度、信用与状态。",
      "他人可见：昵称、座位、存活、信用、失信欠款；看不到别人的贷款与赌注明细。",
      "“债务中心”随时可开、不消耗行动：银行贷款逐条，私人合同按可还/可催收/冻结坏账分类。",
    ],
    bullets: [
      "查看教程与查询债务都不消耗行动，也不影响座位与恢复码。",
    ],
  },
];
