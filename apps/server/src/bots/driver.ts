import { randomUUID } from "node:crypto";
import { DEFAULT_BOT_PERSONALITY, PROTOCOL_VERSION } from "@richman/shared";
import type { GameCommand } from "@richman/shared";
import type { EngineState } from "@richman/game-core";
import type { RoomManager } from "../rooms/manager.js";
import { decideBotCommand } from "./policy.js";
import type { GameCommandDraft } from "./policy.js";

/** execute 只需要回执的 outcome；生产传入 GameCommandProcessor.execute。 */
export interface BotCommandReply {
  outcome: { ok: boolean; code?: string; message?: string };
}

export interface BotDriverOptions {
  manager: RoomManager;
  /** 必须指向与真人相同的命令入口（GameCommandProcessor.execute）。 */
  execute: (roomCode: string, botPlayerId: string, command: GameCommand) => Promise<BotCommandReply>;
  now?: () => number;
  rng?: () => number;
  /** 每次行动前的思考延迟；测试传 () => 0，生产默认 700–1500ms。 */
  delayMs?: () => number;
  /** VERSION_CONFLICT 重试的递增间隔；默认 150/300/600ms，最多 3 次。 */
  retryDelayMs?: (retry: number) => number;
  /** TAX 危险阶段的巡检间隔；默认 1000ms。 */
  rescuePollMs?: number;
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  onError?: (error: unknown, roomCode: string) => void;
  onWarn?: (message: string, roomCode: string) => void;
  onAction?: (roomCode: string, botPlayerId: string, command: GameCommand) => void;
}

interface DrivenRecord {
  gameId: string;
  round: number;
  keys: Set<string>;
}

interface ScheduleStamp {
  gameId: string;
  phaseInstanceId: string;
}

/** 这些命令要求 expectedGameVersion 精确等于当前版本，必须在真正执行前刷新。 */
const ACTION_COMMAND_TYPES = new Set([
  "BORROW_BANK", "REPAY_BANK", "REPAY_PRIVATE", "END_ACTION",
  "REQUEST_PRIVATE_LOAN", "COLLECT_PRIVATE", "RESCUE_GIVE_UP",
]);

const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [150, 300, 600] as const;
/** 可重试：版本冲突与暂停/瞬时状态；确定性非法命令不重试。 */
const RETRYABLE_CODES = new Set(["VERSION_CONFLICT", "ERROR_PAUSED"]);
const DIRTY_KEYS_LIMIT = 500;
const DEFAULT_RESCUE_POLL_MS = 1_000;

/**
 * AI 驱动层：每次提交后检查是否有 AI 该行动，延迟后通过标准命令队列提交。
 * 幂等键以 (gameId, phaseInstanceId, botPlayerId) 为基座；BANK_DUE 同一 phase 内
 * 可能有多笔到期贷款、ACTION 可能有多次请求答复，因此追加贷款/请求/座位区分。
 *
 * 可靠性约定：
 * - markDriven 只在命令真正成功提交（outcome.ok）后执行，失败不占坑；
 * - VERSION_CONFLICT 自动重试 3 次（150/300/600ms），超出后记 warn 并交给阶段超时；
 * - 定时器绑定调度时的 gameId + phaseInstanceId，换局/换阶段一律丢弃旧 draft；
 * - notify 按房间合并为最多一个待执行 tick；driven key 按轮清理并设上限；
 * - 任何异常只上报，不抛出，房间仍由既有超时推进兜底。
 */
export class BotDriver {
  private readonly manager: RoomManager;
  private readonly executeCommand: BotDriverOptions["execute"];
  private readonly now: () => number;
  private readonly rng: () => number;
  private readonly delayMs: () => number;
  private readonly retryDelayMs: (retry: number) => number;
  private readonly rescuePollMs: number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly onError: (error: unknown, roomCode: string) => void;
  private readonly onWarn: (message: string, roomCode: string) => void;
  private readonly onAction: (roomCode: string, botPlayerId: string, command: GameCommand) => void;
  private readonly driven = new Map<string, DrivenRecord>();
  /** 已排期/已投递、尚未得到成功回执的 key（room|key）。 */
  private readonly pending = new Set<string>();
  private readonly attempts = new Map<string, number>();
  private readonly timers = new Map<string, unknown>();
  private readonly rescueTimers = new Map<string, unknown>();
  private readonly tickQueued = new Set<string>();
  private readonly tickAgain = new Set<string>();
  private closed = false;

  constructor(options: BotDriverOptions) {
    this.manager = options.manager;
    this.executeCommand = options.execute;
    this.now = options.now ?? (() => Date.now());
    this.rng = options.rng ?? Math.random;
    this.delayMs = options.delayMs ?? (() => 700 + Math.floor(Math.random() * 801));
    this.retryDelayMs = options.retryDelayMs
      ?? ((retry) => RETRY_DELAYS_MS[Math.min(retry, RETRY_DELAYS_MS.length - 1)]!);
    this.rescuePollMs = options.rescuePollMs ?? DEFAULT_RESCUE_POLL_MS;
    this.setTimer = options.setTimeout ?? ((callback, ms) => {
      const timer = setTimeout(callback, ms);
      timer.unref?.();
      return timer;
    });
    this.clearTimer = options.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.onError = options.onError ?? ((error, roomCode) => {
      console.error("AI 行动失败（房间 " + roomCode + "）：", error);
    });
    this.onWarn = options.onWarn ?? ((message, roomCode) => {
      console.warn("AI 降级（房间 " + roomCode + "）：", message);
    });
    this.onAction = options.onAction ?? (() => undefined);
  }

  /** 提交/阶段变化后调用；每房间最多合并一个待执行 tick，运行期间的 notify 合并为下一 tick。 */
  notify(roomCode: string): void {
    if (this.closed) return;
    if (this.tickQueued.has(roomCode)) {
      this.tickAgain.add(roomCode);
      return;
    }
    this.tickQueued.add(roomCode);
    const timerKey = roomCode + "|tick";
    const handle = this.setTimer(() => {
      this.timers.delete(timerKey);
      this.tickQueued.delete(roomCode);
      this.tick(roomCode);
      if (this.tickAgain.delete(roomCode)) this.notify(roomCode);
    }, 0);
    this.timers.set(timerKey, handle);
  }

  /** 房间销毁/换局时清理该房间全部待执行定时器、幂等记录与重试计数。 */
  cancelRoom(roomCode: string): void {
    const prefix = roomCode + "|";
    for (const [key, handle] of this.timers) {
      if (key.startsWith(prefix)) {
        this.clearTimer(handle);
        this.timers.delete(key);
      }
    }
    for (const key of [...this.pending]) if (key.startsWith(prefix)) this.pending.delete(key);
    for (const key of [...this.attempts.keys()]) if (key.startsWith(prefix)) this.attempts.delete(key);
    const rescue = this.rescueTimers.get(roomCode);
    if (rescue !== undefined) this.clearTimer(rescue);
    this.rescueTimers.delete(roomCode);
    this.tickQueued.delete(roomCode);
    this.tickAgain.delete(roomCode);
    this.driven.delete(roomCode);
  }

  close(): void {
    this.closed = true;
    for (const handle of this.timers.values()) this.clearTimer(handle);
    for (const handle of this.rescueTimers.values()) this.clearTimer(handle);
    this.timers.clear();
    this.rescueTimers.clear();
    this.pending.clear();
    this.attempts.clear();
    this.tickQueued.clear();
    this.tickAgain.clear();
    this.driven.clear();
  }

  private tick(roomCode: string): void {
    if (this.closed) return;
    const room = this.manager.getRoom(roomCode);
    if (room === null || room.state !== "PLAYING" || room.paused) return;
    if (this.manager.isNoHumanOnline(roomCode)) return;
    const state = this.manager.getGame(roomCode);
    if (state === null || state.phase === "GAME_OVER") return;
    this.cleanupForRound(roomCode, state);
    const nowMs = this.now();

    for (const player of room.players) {
      if (player.isBot !== true) continue;
      let draft: GameCommandDraft | null;
      try {
        draft = decideBotCommand(state, player.playerId, nowMs, this.rng,
          player.botPersonality ?? DEFAULT_BOT_PERSONALITY);
      } catch (error) {
        this.onError(error, roomCode);
        continue;
      }
      if (draft === null) continue;
      const key = this.keyOf(state, player.playerId, draft, nowMs);
      if (this.hasDriven(roomCode, state.gameId, key)) continue;
      const roomKey = roomCode + "|" + key;
      if (this.pending.has(roomKey)) continue;
      this.pending.add(roomKey);

      const stamp: ScheduleStamp = { gameId: state.gameId, phaseInstanceId: state.phaseInstanceId };
      const delay = Math.max(0, Math.floor(this.delayMs()));
      const timer = this.setTimer(() => {
        this.timers.delete(roomKey);
        if (this.closed) {
          this.pending.delete(roomKey);
          return;
        }
        if (!this.fire(roomCode, player.playerId, draft!, stamp, key)) this.pending.delete(roomKey);
      }, delay);
      this.timers.set(roomKey, timer);
    }

    this.scheduleRescuePoll(roomCode, state, room);
  }

  /**
   * 延迟结束后的真正提交。第一步校验调度时的 gameId/phaseInstanceId；
   * 换局、换阶段、座位/请求/到期贷款已变化一律丢弃，绝不让旧 draft 跨局生效。
   */
  private fire(
    roomCode: string,
    botPlayerId: string,
    draft: GameCommandDraft,
    stamp: ScheduleStamp,
    key: string,
  ): boolean {
    if (this.closed) return false;
    const room = this.manager.getRoom(roomCode);
    if (room === null || room.state !== "PLAYING" || room.paused) return false;
    if (this.manager.isNoHumanOnline(roomCode)) return false;
    const state = this.manager.getGame(roomCode);
    if (state === null || state.phase === "GAME_OVER") return false;
    if (state.gameId !== stamp.gameId || state.phaseInstanceId !== stamp.phaseInstanceId) return false;
    const bot = room.players.find((player) => player.playerId === botPlayerId);
    if (bot === undefined || bot.isBot !== true) return false;
    if (!stillCurrent(state, bot.seatId, botPlayerId, draft, stamp, this.now())) return false;

    const command: GameCommand = {
      protocolVersion: PROTOCOL_VERSION,
      gameId: stamp.gameId,
      commandId: "bot-" + randomUUID(),
      ...draft,
      ...(ACTION_COMMAND_TYPES.has(draft.type) ? { expectedGameVersion: state.version } : {}),
    };
    try {
      this.onAction(roomCode, botPlayerId, command);
    } catch (error) {
      this.onError(error, roomCode);
    }
    void this.submit(roomCode, botPlayerId, command, key, state.round);
    return true;
  }

  /** 等待回执：成功才 markDriven；VERSION_CONFLICT 有限重试；其余记 warn 后放弃本 key。 */
  private async submit(
    roomCode: string,
    botPlayerId: string,
    command: GameCommand,
    key: string,
    round: number,
  ): Promise<void> {
    const roomKey = roomCode + "|" + key;
    try {
      const reply = await this.executeCommand(roomCode, botPlayerId, command);
      if (reply.outcome.ok) {
        this.markDriven(roomCode, command.gameId, round, key);
        this.attempts.delete(roomKey);
        return;
      }
      const retry = this.attempts.get(roomKey) ?? 0;
      if (RETRYABLE_CODES.has(String(reply.outcome.code)) && retry < MAX_RETRIES) {
        this.attempts.set(roomKey, retry + 1);
        const retryKey = roomCode + "|retry|" + roomKey + "|" + String(retry);
        const handle = this.setTimer(() => {
          this.timers.delete(retryKey);
          this.tick(roomCode);
        }, Math.max(0, this.retryDelayMs(retry)));
        this.timers.set(retryKey, handle);
        return;
      }
      this.markDriven(roomCode, command.gameId, round, key);
      this.onWarn("命令 " + command.type + " 未成功（" + String(reply.outcome.code ?? "UNKNOWN")
        + "），放弃本次行动，等待阶段超时", roomCode);
    } catch (error) {
      // 抛错通常意味着存档/队列异常，不重试；阶段超时兜底。
      this.markDriven(roomCode, command.gameId, round, key);
      this.onError(error, roomCode);
    } finally {
      this.pending.delete(roomKey);
    }
  }

  /** TAX 危险阶段：只要危险玩家是 AI，就每秒巡检一次，避免 2 秒请求间隔内无人唤醒。 */
  private scheduleRescuePoll(
    roomCode: string,
    state: EngineState,
    room: NonNullable<ReturnType<RoomManager["getRoom"]>>,
  ): void {
    if (state.phase !== "TAX" || state.dangerSeatId === null) return;
    if (this.rescueTimers.has(roomCode)) return;
    const danger = room.players.find((player) => player.seatId === state.dangerSeatId);
    if (danger === undefined || danger.isBot !== true) return;
    const timer = this.setTimer(() => {
      this.rescueTimers.delete(roomCode);
      this.tick(roomCode);
    }, Math.max(50, this.rescuePollMs));
    this.rescueTimers.set(roomCode, timer);
  }

  private keyOf(state: EngineState, botPlayerId: string, draft: GameCommandDraft, nowMs: number): string {
    const parts = [state.gameId, state.phaseInstanceId, botPlayerId, draft.type];
    if (draft.type === "ACCEPT_PRIVATE_LOAN" || draft.type === "REFUSE_PRIVATE_LOAN") {
      parts.push(String(draft.requestId ?? ""));
    } else if (draft.type === "BANK_DUE_DECISION") {
      parts.push(String(draft.payload["loanId"] ?? ""));
    } else if (draft.type === "COLLECT_PRIVATE") {
      parts.push(String(draft.payload["loanId"] ?? ""));
    } else if (draft.type === "REQUEST_PRIVATE_LOAN") {
      // TAX 允许每 2 秒重新请求；ACTION 一次行动只能发一个请求。
      parts.push(state.phase === "TAX"
        ? "rescue:" + String(Math.floor(nowMs / 1_000))
        : "seat:" + String(state.currentSeatId));
    } else if (draft.type === "BORROW_BANK" || draft.type === "REPAY_BANK"
      || draft.type === "REPAY_PRIVATE" || draft.type === "END_ACTION"
      || draft.type === "RESCUE_GIVE_UP") {
      parts.push("seat:" + String(state.currentSeatId ?? state.dangerSeatId ?? ""));
    }
    return parts.join("|");
  }

  private hasDriven(roomCode: string, gameId: string, key: string): boolean {
    const record = this.driven.get(roomCode);
    return record !== undefined && record.gameId === gameId && record.keys.has(key);
  }

  private markDriven(roomCode: string, gameId: string, round: number, key: string): void {
    const record = this.driven.get(roomCode);
    if (record === undefined || record.gameId !== gameId) {
      this.driven.set(roomCode, { gameId, round, keys: new Set([key]) });
      return;
    }
    if (record.round !== round) {
      record.round = round;
      record.keys.clear();
    }
    if (record.keys.size >= DIRTY_KEYS_LIMIT) {
      // 按插入顺序淘汰最旧 key，保留本轮最近成功的幂等记录；不要一次清空整轮。
      const oldest = record.keys.values().next().value;
      if (oldest !== undefined) record.keys.delete(oldest);
      this.onWarn("幂等 key 超过上限，按 LRU 淘汰最旧记录", roomCode);
    }
    record.keys.add(key);
  }

  /** 换轮时清空上一轮的 key 与重试计数；同轮不同阶段靠 phaseInstanceId 区分。 */
  private cleanupForRound(roomCode: string, state: EngineState): void {
    const record = this.driven.get(roomCode);
    if (record !== undefined && (record.gameId !== state.gameId || record.round !== state.round)) {
      record.gameId = state.gameId;
      record.round = state.round;
      record.keys.clear();
      const prefix = roomCode + "|";
      for (const key of [...this.attempts.keys()]) if (key.startsWith(prefix)) this.attempts.delete(key);
    }
  }
}

/** 延迟期间的保险：命令指向的 game/阶段/座位/请求/贷款必须仍然存在。 */
function stillCurrent(
  state: EngineState,
  botSeatId: number,
  botPlayerId: string,
  draft: GameCommandDraft,
  stamp: ScheduleStamp,
  nowMs: number,
): boolean {
  if (state.gameId !== stamp.gameId || state.phaseInstanceId !== stamp.phaseInstanceId) return false;
  const beforeDeadline = state.windowDeadlineMs === null || nowMs < state.windowDeadlineMs;
  switch (draft.type) {
    case "BORROW_BANK":
    case "REPAY_BANK":
    case "REPAY_PRIVATE":
    case "END_ACTION":
      return state.phase === "ACTION" && state.currentSeatId === botSeatId && beforeDeadline;
    case "REQUEST_PRIVATE_LOAN": {
      if (state.requests.some((request) => request.borrowerId === botPlayerId && request.status === "PENDING")) return false;
      if (state.phase === "ACTION") {
        return state.currentSeatId === botSeatId && beforeDeadline;
      }
      if (state.phase !== "TAX" || state.dangerSeatId !== botSeatId || state.pendingRequestId !== null) return false;
      if (!beforeDeadline) return false;
      let latest = 0;
      for (const request of state.requests) {
        if (request.borrowerId === botPlayerId && request.createdAtMs > latest) latest = request.createdAtMs;
      }
      return latest === 0 || nowMs - latest >= 2_000;
    }
    case "COLLECT_PRIVATE": {
      if (state.phase !== "TAX" || state.dangerSeatId !== botSeatId || state.pendingRequestId !== null) return false;
      if (!beforeDeadline) return false;
      const loanId = draft.payload["loanId"];
      if (typeof loanId !== "string") return false;
      const loan = state.privateLoans.find((item) => item.loanId === loanId && item.status === "ACTIVE");
      if (loan === undefined || loan.lenderId !== botPlayerId) return false;
      const borrower = state.players.find((player) => player.playerId === loan.borrowerId);
      const cents = draft.payload["cents"];
      return borrower !== undefined && typeof cents === "number" && Number.isSafeInteger(cents)
        && cents > 0 && cents <= Math.min(loan.remainingCents, Math.max(0, borrower.cents));
    }
    case "RESCUE_GIVE_UP":
      return state.phase === "TAX" && state.dangerSeatId === botSeatId
        && state.pendingRequestId === null && beforeDeadline;
    case "BANK_DUE_DECISION": {
      const loanId = draft.payload["loanId"];
      return state.phase === "BANK_DUE" && typeof loanId === "string"
        && state.pendingDueLoanId === loanId && beforeDeadline;
    }
    case "SUBMIT_BET":
      return state.phase === "BETTING" && state.round === draft.roundId && beforeDeadline;
    case "ACCEPT_PRIVATE_LOAN":
    case "REFUSE_PRIVATE_LOAN": {
      const requestId = typeof draft.requestId === "string" ? draft.requestId : draft.payload["requestId"];
      if (typeof requestId !== "string") return false;
      const request = state.requests.find((item) => item.requestId === requestId && item.status === "PENDING");
      if (request === undefined || request.lenderId !== botPlayerId
        || request.createdRound !== state.round || nowMs >= request.deadlineMs) return false;
      return state.phase === "ACTION" || (state.phase === "TAX" && state.pendingRequestId === requestId);
    }
    default:
      return false;
  }
}
