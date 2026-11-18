/** 单人练习 AI 的整局固定人格。只影响「选哪条合法命令、参数取多少」，不改变规则。 */
export const BOT_PERSONALITIES = [
  "AGGRESSIVE",
  "CONSERVATIVE",
  "PASSIVE",
  "GENIUS",
  "FOOL",
] as const;

export type BotPersonality = (typeof BOT_PERSONALITIES)[number];

/** 旧存档没有 botPersonality 时的默认值。 */
export const DEFAULT_BOT_PERSONALITY: BotPersonality = "PASSIVE";

export function isBotPersonality(value: unknown): value is BotPersonality {
  return typeof value === "string" && (BOT_PERSONALITIES as readonly string[]).includes(value);
}

/** UI 展示用中文标签；只做展示，不参与规则。 */
export const BOT_PERSONALITY_LABELS: Record<BotPersonality, string> = {
  AGGRESSIVE: "激进",
  CONSERVATIVE: "保守",
  PASSIVE: "消极",
  GENIUS: "高智商",
  FOOL: "傻子",
};
