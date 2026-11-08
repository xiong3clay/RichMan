import { createHash, randomInt } from "node:crypto";
import { applyCommand, type EngineState } from "@richman/game-core";
import { MoneyStringSchema, errorMessage, type CommandOutcome, type ErrorCode,
  type GameCommand, type TransitionResult } from "@richman/shared";

export interface CommandReply {
  type: "command_result";
  commandId: string;
  gameId: string;
  gameVersion: number;
  outcome: CommandOutcome;
}

export interface CommandResultRecord {
  payloadHash: string;
  reply: CommandReply;
}

export interface CommandResultStore {
  get(key: string): CommandResultRecord | undefined;
  set(key: string, record: CommandResultRecord): void;
  delete?(key: string): void;
}

interface ProcessorOptions {
  /** WS持久化提交接收第三参数，结果与状态同rename。缺省保留旧内存适配器的预暂存契约。 */
  atomicCommit?: boolean;
  queue: RoomCommandQueue;
  getState: (roomCode: string) => EngineState | null;
  commit: (roomCode: string, result: TransitionResult, command?: {key: string; record: CommandResultRecord}) => void | Promise<void>;
  isPaused?: (roomCode: string) => boolean;
  onInvariant?: (roomCode: string) => void;
  advance: (roomCode: string) => void | Promise<void>;
  now?: () => number;
  draw?: () => 0 | 1;
  store?: CommandResultStore;
}

export class RoomCommandQueue {
  private readonly tails = new Map<string, Promise<void>>();
  async drain(): Promise<void> { await Promise.all([...this.tails.values()]); }

  run<T>(roomCode: string, task: () => T | Promise<T>): Promise<T> {
    const result = (this.tails.get(roomCode) ?? Promise.resolve()).then(task);
    // The queue tail always resolves; a failed task rejects only its own caller.
    const tail = result.then(() => undefined, () => undefined);
    this.tails.set(roomCode, tail);
    void tail.then(() => {
      if (this.tails.get(roomCode) === tail) this.tails.delete(roomCode);
    });
    return result;
  }
}

export class GameCommandProcessor {
  private readonly store: CommandResultStore;
  private readonly now: () => number;
  private readonly draw: () => 0 | 1;

  constructor(private readonly options: ProcessorOptions) {
    this.store = options.store ?? new Map<string, CommandResultRecord>();
    this.now = options.now ?? Date.now;
    this.draw = options.draw ?? (() => randomInt(2) as 0 | 1);
  }

  execute(roomCode: string, playerId: string, command: GameCommand, authorize?: () => boolean): Promise<CommandReply> {
    // Capture the client envelope before waiting for another task in this room.
    const original = structuredClone(command);
    return this.options.queue.run(roomCode, async () => {
      if (authorize !== undefined && !authorize()) {
        return replyFor(original, this.options.getState(roomCode)?.version ?? 0, failure("REPLACED"));
      }
      let state = this.options.getState(roomCode);
      const payload = payloadOf(original);
      // Authentication happens before lookup or system advancement, including retries.
      if (state === null || !state.players.some((player) => player.playerId === playerId)
        || (payload.playerId !== undefined && payload.playerId !== playerId)
        || original.gameId !== state.gameId) {
        return replyFor(original, state?.version ?? 0, failure("UNAUTHORIZED"));
      }

      const key = JSON.stringify([original.gameId, playerId, original.commandId]);
      const payloadHash = createHash("sha256").update(canonicalJson(original)).digest("hex");
      const previous = this.store.get(key);
      if (previous !== undefined) {
        return previous.payloadHash === payloadHash
          ? structuredClone(previous.reply)
          : replyFor(original, state.version, failure("COMMAND_ID_REUSED"));
      }

      if (this.options.isPaused?.(roomCode)) return replyFor(original, state.version, failure('ERROR_PAUSED'));

      await this.options.advance(roomCode);
      state = this.options.getState(roomCode);
      // Resume can replace a connection while asynchronous advancement yields.
      if (authorize !== undefined && !authorize()) {
        return replyFor(original, state?.version ?? 0, failure("REPLACED"));
      }
      if (state === null || state.gameId !== original.gameId) {
        return replyFor(original, state?.version ?? 0, failure("UNAUTHORIZED"));
      }

      const engineCommand = toEngineCommand(original);
      const nowMs = this.now();
      const validation = validateCategory(state, playerId, engineCommand, nowMs);
      const result = validation === null
        ? applyCommand(state, engineCommand, { actorId: playerId, nowMs,
          drawResult: state.phase === "BETTING" ? this.draw() : 0 })
        : { state, events: [], outcome: validation, nextDeadlineAt: state.deadlineAt };
      const reply = replyFor(original, result.state.version, result.outcome);
      if (!result.outcome.ok && result.outcome.code === 'RULE_INVARIANT') this.options.onInvariant?.(roomCode);

      const record = { payloadHash, reply: structuredClone(reply) };
      if (this.options.atomicCommit && result.state.version === state.version) return reply;
      if (!this.options.atomicCommit) this.store.set(key, record);
      try {
        if (result.state.version !== state.version) await this.options.commit(roomCode, result, { key, record });
      } catch (error) { if (!this.options.atomicCommit) this.store.delete?.(key); throw error; }
      this.store.set(key, record);
      return reply;
    });
  }
}

const actionCommands = new Set([
  "BORROW_BANK", "REQUEST_PRIVATE_LOAN", "CANCEL_PRIVATE_LOAN", "REPAY_BANK",
  "REPAY_PRIVATE", "COLLECT_PRIVATE", "END_ACTION", "RESCUE_GIVE_UP",
]);

function validateCategory(state: EngineState, playerId: string, command: GameCommand, nowMs: number): CommandOutcome | null {
  if (actionCommands.has(command.type)) {
    if (!Number.isSafeInteger(command.expectedGameVersion) || command.expectedGameVersion !== state.version
      || (state.windowDeadlineMs !== null && nowMs >= state.windowDeadlineMs)) {
      return failure("VERSION_CONFLICT");
    }
    return null;
  }

  const payload = payloadOf(command);
  if (command.type === "SUBMIT_BET") {
    if (command.roundId !== state.round) return failure("INVALID_ACTION", "命令缺少当前轮次或轮次已结束");
    if (command.phaseInstanceId !== state.phaseInstanceId) return failure("VERSION_CONFLICT");
    delete command.expectedGameVersion;
    return null;
  }

  if (command.type === "ACCEPT_PRIVATE_LOAN" || command.type === "REFUSE_PRIVATE_LOAN") {
    if (payload.requestId !== undefined && command.requestId !== undefined && payload.requestId !== command.requestId) {
      return failure("INVALID_ACTION", "请求编号与命令信封不一致");
    }
    const requestId = payload.requestId ?? command.requestId;
    if (typeof requestId !== "string" || requestId.length === 0) return failure("INVALID_ACTION", "命令缺少 requestId");
    const request = state.requests.find((item) => item.requestId === requestId && item.status === "PENDING");
    if (request === undefined || request.createdRound !== state.round
      || (state.phase === "TAX" && state.pendingRequestId !== requestId)) {
      return failure("REQUEST_EXPIRED");
    }
    if (request.lenderId !== playerId) return failure("UNAUTHORIZED");
    if (state.phase !== "ACTION" && state.phase !== "TAX") return failure("INVALID_ACTION");
    if (nowMs >= request.deadlineMs) return failure("REQUEST_EXPIRED");
    command.payload = { ...payload, requestId };
    delete command.expectedGameVersion;
    return null;
  }

  if (command.type === "BANK_DUE_DECISION") {
    if (state.phase !== "BANK_DUE" || state.pendingDueLoanId === null) return failure("INVALID_ACTION");
    if (typeof payload.loanId !== "string" || payload.loanId !== state.pendingDueLoanId
      || (payload.pendingDueLoanId !== undefined && payload.pendingDueLoanId !== state.pendingDueLoanId)) {
      return failure("INVALID_ACTION", "命令未指向当前等待处理的到期贷款");
    }
    const loan = state.bankLoans.find((item) => item.loanId === state.pendingDueLoanId && item.status === "ACTIVE");
    if (loan === undefined) return failure("INVALID_ACTION");
    if (loan.borrowerId !== playerId) return failure("UNAUTHORIZED");
    if (state.windowDeadlineMs !== null && nowMs >= state.windowDeadlineMs) {
      return failure("REQUEST_EXPIRED", "本笔到期贷款的决策时间已截止");
    }
    delete command.expectedGameVersion;
  }
  return null;
}

function toEngineCommand(command: GameCommand): GameCommand {
  const copy = structuredClone(command);
  const payload = { ...payloadOf(copy) };
  // Hash the original wire envelope; convert only the engine's known money fields.
  for (const field of ["amountCents", "principalCents", "betCents", "cents"]) {
    const value = payload[field];
    if (typeof value === "string" && MoneyStringSchema.safeParse(value).success) payload[field] = Number(value);
  }
  copy.payload = payload;
  return copy;
}

function payloadOf(command: GameCommand): Record<string, unknown> {
  return command.payload !== null && typeof command.payload === "object" && !Array.isArray(command.payload)
    ? command.payload as Record<string, unknown> : {};
}

function failure(code: ErrorCode, message = errorMessage(code)): CommandOutcome {
  return { ok: false, code, message };
}

function replyFor(command: GameCommand, version: number, outcome: CommandOutcome): CommandReply {
  return { type: "command_result", commandId: command.commandId, gameId: command.gameId,
    gameVersion: version, outcome };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
  });
}
