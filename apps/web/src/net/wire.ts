/**
 * Web 只消费服务端 view 的 wire 形状：金额一律十进制字符串，前端不做任何金额运算。
 * 这里不 import game-core 的引擎类型，避免把“内部 number 分”误当成可展示金额。
 */

export interface WireLobbyPlayer {
  playerId: string;
  nickname: string;
  seatId: number;
  ready: boolean;
  online: boolean;
}

export interface WireRoom {
  type: "room";
  players: WireLobbyPlayer[];
  hostId: string | null;
  state: "LOBBY" | "PLAYING" | "PAUSED" | "ERROR_PAUSED" | "ENDED";
}

export interface WireBankLoan {
  loanId: string;
  borrowerId: string;
  seatId: number;
  principalCents: string;
  remainingCents: string;
  rateBps: number;
  issuedRound: number;
  dueRound: number;
  lastInterestRound: number;
  status: "ACTIVE" | "REPAID" | "DEFAULTED";
  origin: "NORMAL" | "OVERDRAFT";
}

export interface WireMe {
  playerId: string;
  seatId: number;
  nickname: string;
  cents: string;
  credit: "GOOD" | "DEFAULTED";
  status: "ALIVE" | "DANGER" | "BANKRUPT";
  alive: boolean;
}

export interface WirePublicPlayer {
  playerId: string;
  seatId: number;
  nickname: string;
  credit: "GOOD" | "DEFAULTED";
  status: "ALIVE" | "DANGER" | "BANKRUPT";
  alive: boolean;
  defaultedBankDebtCents: string;
}

export interface WireFinance {
  cents: string;
  bankLoans: WireBankLoan[];
  bankDebtCents: string;
  bankDefaultedDebtCents: string;
  privateDebtCents: string;
  receivableCents: string;
  frozenCents: string;
  badDebtCents: string;
  pendingRequest: unknown | null;
  incomingRequests: unknown[];
  myBet: { betCents: string; guess: 0 | 1; leverage: 1 | 2 } | null;
  betsSubmitted: string[];
  aliveCount: number;
}

export type GamePhase = "INTEREST" | "BANK_DUE" | "ACTION" | "BETTING" | "TAX" | "GAME_OVER";

export interface WireSnapshotView {
  schemaVersion: number;
  gameId: string;
  version: number;
  round: number;
  phase: GamePhase;
  serverNow: string;
  deadlineAt: string | null;
  me: WireMe;
  publicPlayers: WirePublicPlayer[];
  winnerId: string | null;
  finance: WireFinance;
  phaseInstanceId: string;
  eventSeq: number;
  currentSeatId: number | null;
  actedSeats: number[];
  pendingDueLoanId: string | null;
}

export interface WireCommandResult {
  type: "command_result";
  commandId: string;
  gameId: string;
  gameVersion: number;
  outcome:
    | { ok: true }
    | { ok: false; code: string; message: string; details?: Record<string, string | number | boolean | null> };
}

export interface JoinedInfo {
  roomCode: string;
  playerId: string;
  seatId: number;
  sessionToken: string;
  recoveryCode?: string;
}

/* ------------------------------------------------------------------ */
/* 纯展示映射（不改金额、不解析服务端逻辑）                             */
/* ------------------------------------------------------------------ */

const PHASE_LABELS: Record<GamePhase, string> = {
  INTEREST: "计息",
  BANK_DUE: "到期贷款",
  ACTION: "行动",
  BETTING: "下注",
  TAX: "交税",
  GAME_OVER: "本局结束",
};

export function phaseLabel(phase: GamePhase): string {
  return PHASE_LABELS[phase];
}

const CREDIT_LABELS: Record<WireMe["credit"], string> = { GOOD: "良好", DEFAULTED: "失信" };
const STATUS_LABELS: Record<WireMe["status"], string> = { ALIVE: "正常", DANGER: "危险", BANKRUPT: "破产" };
const LOAN_LABELS: Record<WireBankLoan["status"], string> = {
  ACTIVE: "未结清",
  REPAID: "已还清",
  DEFAULTED: "失信",
};

export function creditLabel(credit: WireMe["credit"]): string {
  return CREDIT_LABELS[credit];
}
export function statusLabel(status: WireMe["status"]): string {
  return STATUS_LABELS[status];
}
export function loanStatusLabel(status: WireBankLoan["status"]): string {
  return LOAN_LABELS[status];
}

/** 服务端已给中文 message；这里只补齐大厅错误码的前缀，方便玩家定位。 */
const LOBBY_ERROR_LABELS: Record<string, string> = {
  ROOM_NOT_FOUND: "房间码不存在",
  ROOM_FULL: "房间已满",
  ALREADY_STARTED: "对局已开始，不能新加入",
  NOT_HOST: "只有房主可以开始游戏",
  NOT_ALL_READY: "还有玩家未准备",
  NOT_ENOUGH_PLAYERS: "至少需要 2 名玩家",
  INVALID_NICKNAME: "昵称需要 1～20 个字符",
  NOT_JOINED: "尚未加入房间",
  UNAUTHORIZED: "身份凭证无效，请重新加入",
  REPLACED: "已在另一页面恢复",
  RATE_LIMITED: "操作过于频繁，请稍后重试",
};

export function lobbyErrorText(code: string, message: string): string {
  const label = LOBBY_ERROR_LABELS[code];
  return label === undefined ? message : label + "（" + message + "）";
}

/** resume/join 阶段身份失效的错误码；调用方据此清本地会话并回入口。 */
export function isSessionError(code: string): boolean {
  return code === "UNAUTHORIZED" || code === "ROOM_NOT_FOUND";
}

/** 会话失效的入口提示：服务端为内存房间，重启后原房间码与 token 都不再生效。 */
export function serverErrorText(code: string, message: string): string {
  if (code === "ROOM_NOT_FOUND") return "房间已不存在（服务重启会丢内存房间）";
  if (code === "UNAUTHORIZED") return "身份凭证失效，请重新加入（" + message + "）";
  return lobbyErrorText(code, message);
}

/** 与服务端 MoneyStringSchema 一致的整数分上限：10^12 分（13 位数字）。 */
const MAX_MONEY_CENTS_TEXT = "1000000000000";

/**
 * 规范十进制整数字符串：无前导零、拒绝 -0、绝对值不超过 10^12 分。
 * 纯字符串比较，不把金额转成浮点数。
 */
export function isCanonicalCents(value: string): boolean {
  const match = /^(-?)(0|[1-9][0-9]*)$/.exec(value);
  if (match === null) return false;
  const negative = match[1] === "-";
  const digits = match[2]!;
  if (negative && digits === "0") return false;
  if (digits.length !== MAX_MONEY_CENTS_TEXT.length) {
    return digits.length < MAX_MONEY_CENTS_TEXT.length;
  }
  return digits <= MAX_MONEY_CENTS_TEXT;
}

/** 借银行/还贷款要求大于 0 分的整数。 */
export function isPositiveCents(value: string): boolean {
  return isCanonicalCents(value) && !value.startsWith("-") && value !== "0";
}

/** 下注允许 0 分，但不接受负数。 */
export function isNonNegativeCents(value: string): boolean {
  return isCanonicalCents(value) && !value.startsWith("-");
}

/** 纯字符串分组展示，不做任何数值转换。 */
export function formatCents(value: string): string {
  const negative = value.startsWith("-");
  const digits = negative ? value.slice(1) : value;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (negative ? "-" : "") + grouped + " 分";
}
