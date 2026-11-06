import { DEFAULTED_PLAYER_LEVERAGE, RULES, TIMERS } from "@richman/shared";

/** 教程里的所有数字都从这里派生，避免文案与规则实现漂移。 */
const START_COINS = RULES.startCents / 100;
const TAX_COINS = RULES.taxCents / 100;
const INTEREST_PERCENT = RULES.interestBps / 100;
const REQUEST_SECONDS = TIMERS.standard.requestSec;
const FAST_REQUEST_SECONDS = TIMERS.fast.requestSec;
const RESCUE_SECONDS = TIMERS.standard.rescueSec;

export interface TutorialPage {
  id: string;
  title: string;
  paragraphs: string[];
  checklist?: string[];
}

/**
 * 新手教程只讲主线，约 60 秒读完；细节放在规则页，避免两处大段重复。
 * 5 页分别对应：流程、银行与失信、玩家借贷、下注纳税自救、查账与隐私。
 */
export const TUTORIAL_PAGES: readonly TutorialPage[] = [
  {
    id: "basics",
    title: "一局怎么玩",
    paragraphs: [
      `${RULES.playerMin}～${RULES.playerMax} 人同房，每人开局 ${START_COINS} 金币；最后没破产的人获胜。`,
      `每轮依次：利息 → 银行到期 → 行动 → 全员下注 →（第 ${RULES.taxEveryRounds}/${RULES.taxEveryRounds * 2}/${RULES.taxEveryRounds * 3}…轮）税收 → 本轮结算。`,
      `超时会替你推进：行动超时=结束行动，下注超时按 0 注，银行到期/自救超时按对应默认处理。`,
    ],
    checklist: [`${RULES.playerMin}～${RULES.playerMax} 人同房`, `开局每人 ${START_COINS} 金币`, "最后没破产的人获胜"],
  },
  {
    id: "bank",
    title: "银行借钱与失信",
    paragraphs: [
      `普通贷款最多借“当前金币的 ${RULES.ordinaryLoanMaxPercent}%”，每轮利息 ${INTEREST_PERCENT}%，发放轮 N 之后第 N+${RULES.loanInterestRoundsBeforeDue} 轮计息完到期。`,
      "到期余额够：可以还，也可以选择不还；余额不足：直接失信，没有选择窗口。",
      `拒绝或超时：这笔银行贷款永久不能还、不再计息；不能再新增银行贷款；下注只能 ${DEFAULTED_PLAYER_LEVERAGE} 倍；但不会被淘汰。私人负债不影响银行贷款资格。`,
    ],
  },
  {
    id: "private",
    title: "玩家之间借钱",
    paragraphs: [
      `借款人自己填金额和利率（0～10000 基点，即 0%～100%），出借人 ${REQUEST_SECONDS} 秒内答复（快速模式 ${FAST_REQUEST_SECONDS} 秒）。`,
      "同一时间只处理一个待答复请求（由当前行动者发起）；同一个借款人同时最多 1 个待答复请求。同意后立刻转账；每轮按约定利率计息。",
      "出借人最多可收 = 剩余应收与对方当前金币的较小值；借出当轮不能催收，之后可在自己的行动窗口或自救阶段催收。借款人在自己的行动窗口或自救阶段可以还款。借款人破产→这笔应收记坏账；出借人破产→合同冻结，不能再还/催收。失信者也能借，但出借人一定会看到“失信风险 + 失信欠款”。",
    ],
  },
  {
    id: "gamble",
    title: "下注、纳税与自救",
    paragraphs: [
      "每轮全员下注：猜 0 或 1、金额 0～当前金币、杠杆 1 或 2 倍。提交即锁定，不能改；全员提交后立即开奖，不必等倒计时。",
      "赢=+注额×杠杆，输=-注额×杠杆；2 倍输且余额不够时，差额自动转“赌博透支贷款”，按银行规则计息。",
      `失信玩家只能 1 倍；0 注=放弃本轮下注。每 ${RULES.taxEveryRounds} 轮每人交 ${TAX_COINS} 金币税；余额不够进入“危险自救”（标准 ${RESCUE_SECONDS} 秒），只能向玩家借款、催收或放弃；自救期间不能新借银行贷款；放弃/超时=破产（私人债务转坏账、出借人应收冻结）。`,
    ],
  },
  {
    id: "debt",
    title: "查账与隐私",
    paragraphs: [
      "顶部固定轮次、阶段、倒计时；自身面板看金币、银行/透支/失信欠款、私人负债、可借额度、信用。",
      "“债务中心”随时可开、不消耗行动：银行贷款逐条，私人合同按可还/可催收/冻结坏账分类。",
      "只能看到别人的昵称/座位/存活/信用/失信欠款，看不到别人的贷款与赌注明细。看教程、查债务都不消耗行动；教程状态不影响座位与恢复码。",
    ],
  },
];
