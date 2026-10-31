export const ERROR_CODES = [
  "UNAUTHORIZED",
  "REPLACED",
  "NOT_YOUR_TURN",
  "INVALID_AMOUNT",
  "INSUFFICIENT_FUNDS",
  "VERSION_CONFLICT",
  "REQUEST_EXPIRED",
  "ALREADY_LOCKED",
  "ROOM_PAUSED",
  "GAME_OVER",
  "COMMAND_ID_REUSED",
  "STORAGE_FAILURE",
  "INVALID_ACTION",
  "RULE_INVARIANT",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  UNAUTHORIZED: "你没有权限执行这个操作",
  REPLACED: "这个座位已在另一个页面恢复",
  NOT_YOUR_TURN: "还没轮到你",
  INVALID_AMOUNT: "金额不合法",
  INSUFFICIENT_FUNDS: "金币不足",
  VERSION_CONFLICT: "状态已变化，请确认后重试",
  REQUEST_EXPIRED: "请求已过期",
  ALREADY_LOCKED: "本阶段已提交，不能修改",
  ROOM_PAUSED: "房间已暂停",
  GAME_OVER: "本局已结束",
  COMMAND_ID_REUSED: "命令编号被用于不同内容",
  STORAGE_FAILURE: "存档失败，房间已暂停",
  INVALID_ACTION: "当前阶段不允许这个操作",
  RULE_INVARIANT: "规则不变量被破坏，已暂停房间",
};

export function errorMessage(code: ErrorCode): string {
  return ERROR_MESSAGES[code] ?? code;
}
