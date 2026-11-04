import { PROTOCOL_VERSION } from "@richman/shared";
import { isSessionError } from "./wire";
import type {
  GamePhase,
  JoinedInfo,
  WireCommandResult,
  WireGameEvent,
  WireRoom,
  WireSnapshotView,
} from "./wire";

const STORAGE_KEY = "richman.session.v1";

export type ConnectionStatus = "connecting" | "open" | "closed" | "replaced";

export interface StoredSession {
  roomCode: string;
  nickname: string;
  playerId: string;
  seatId: number;
  sessionToken: string;
}

export interface ClientHandlers {
  onStatus: (status: ConnectionStatus, detail?: string) => void;
  onJoined: (info: JoinedInfo) => void;
  onRoom: (room: WireRoom) => void;
  onStarted: (gameId: string) => void;
  onSnapshot: (view: WireSnapshotView) => void;
  /** 服务端过滤后的本人可见事件；用于本轮结算卡，不参与规则判定。 */
  onEvents?: (events: WireGameEvent[]) => void;
  onCommandResult: (result: WireCommandResult) => void;
  onServerError: (error: { code: string; message: string }) => void;
}

export function loadSession(): StoredSession | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (
      typeof parsed.roomCode !== "string" ||
      typeof parsed.nickname !== "string" ||
      typeof parsed.playerId !== "string" ||
      typeof parsed.seatId !== "number" ||
      typeof parsed.sessionToken !== "string"
    ) {
      return null;
    }
    return {
      roomCode: parsed.roomCode,
      nickname: parsed.nickname,
      playerId: parsed.playerId,
      seatId: parsed.seatId,
      sessionToken: parsed.sessionToken,
    };
  } catch {
    return null;
  }
}

export function saveSession(session: StoredSession): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // 隐私模式下 sessionStorage 可能不可用；不影响本页对局。
  }
}

export function clearSession(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // 忽略。
  }
}

function createCommandId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "cmd-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

export interface CommandOptions {
  expectedGameVersion?: number;
  roundId?: number;
  phaseInstanceId?: string;
}

/**
 * 大厅/对局网络层：
 * - 连接 /ws?room=<码>，token 只从 joined/resume 消息体走，不进 URL；
 * - 断线后指数退避重连，并发送 resume；
 * - snapshot 只升不降（同 gameId 下 version 小于当前值直接丢弃）；
 * - 收到 REPLACED 停止重连。
 */
export class RichmanClient {
  private socket: WebSocket | null = null;
  private readonly roomCode: string;
  private readonly nickname: string;
  private session: StoredSession | null;
  private readonly handlers: ClientHandlers;
  private latest: WireSnapshotView | null = null;
  private lastVersion = -1;
  private attempts = 0;
  private retryTimer: number | null = null;
  private disposed = false;
  private replaced = false;
  /** 仅在收到 joined 后为 true；每次重连都要等新 joined 才重新置 true。 */
  private joined = false;

  constructor(
    roomCode: string,
    nickname: string,
    handlers: ClientHandlers,
    session: StoredSession | null = null,
  ) {
    this.roomCode = roomCode;
    this.nickname = nickname;
    this.handlers = handlers;
    this.session = session;
  }

  connect(): void {
    this.openSocket();
  }

  dispose(): void {
    this.disposed = true;
    this.joined = false;
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (socket !== null && socket.readyState <= WebSocket.OPEN) {
      socket.close();
    }
  }

  get isReplaced(): boolean {
    return this.replaced;
  }

  /** 当前连接是否已重新拿到身份；重连后由 joined 消息重新置 true。 */
  get hasJoined(): boolean {
    return this.joined;
  }

  get currentView(): WireSnapshotView | null {
    return this.latest;
  }

  sendLobby(message: Record<string, unknown>): boolean {
    return this.rawSend(message);
  }

  /** 组命令信封；version/roundId/phaseInstanceId 全部来自服务端 snapshot。 */
  sendCommand(type: string, payload: Record<string, unknown>, options: CommandOptions = {}): string | null {
    const view = this.latest;
    if (view === null) return null;
    const commandId = createCommandId();
    const envelope: Record<string, unknown> = {
      protocolVersion: PROTOCOL_VERSION,
      gameId: view.gameId,
      commandId,
      type,
      payload,
    };
    if (options.expectedGameVersion !== undefined) envelope.expectedGameVersion = options.expectedGameVersion;
    if (options.roundId !== undefined) envelope.roundId = options.roundId;
    if (options.phaseInstanceId !== undefined) envelope.phaseInstanceId = options.phaseInstanceId;
    return this.rawSend(envelope) ? commandId : null;
  }

  /* ---- 05C 引导式界面用到的命令；字段严格沿用服务端 handler 契约 ---- */

  borrowBank(amountCents: string, options: CommandOptions = {}): string | null {
    return this.sendCommand("BORROW_BANK", { amountCents }, options);
  }

  requestPrivateLoan(
    lenderId: string,
    principalCents: string,
    rateBps: number,
    options: CommandOptions = {},
  ): string | null {
    return this.sendCommand("REQUEST_PRIVATE_LOAN", { lenderId, principalCents, rateBps }, options);
  }

  acceptPrivateLoan(requestId: string, options: CommandOptions = {}): string | null {
    return this.sendCommand("ACCEPT_PRIVATE_LOAN", { requestId }, options);
  }

  refusePrivateLoan(requestId: string, options: CommandOptions = {}): string | null {
    return this.sendCommand("REFUSE_PRIVATE_LOAN", { requestId }, options);
  }

  cancelPrivateLoan(requestId: string, options: CommandOptions = {}): string | null {
    return this.sendCommand("CANCEL_PRIVATE_LOAN", { requestId }, options);
  }

  repayBank(loanId: string, cents: string, options: CommandOptions = {}): string | null {
    return this.sendCommand("REPAY_BANK", { loanId, cents }, options);
  }

  repayPrivateLoan(loanId: string, cents: string, options: CommandOptions = {}): string | null {
    return this.sendCommand("REPAY_PRIVATE", { loanId, cents }, options);
  }

  collectPrivateLoan(loanId: string, cents: string, options: CommandOptions = {}): string | null {
    return this.sendCommand("COLLECT_PRIVATE", { loanId, cents }, options);
  }

  endAction(options: CommandOptions = {}): string | null {
    return this.sendCommand("END_ACTION", {}, options);
  }

  decideBankDue(loanId: string, decision: "REPAY" | "REFUSE", options: CommandOptions = {}): string | null {
    return this.sendCommand("BANK_DUE_DECISION", { loanId, decision }, options);
  }

  giveUpRescue(options: CommandOptions = {}): string | null {
    return this.sendCommand("RESCUE_GIVE_UP", {}, options);
  }

  submitBet(
    betCents: string,
    guess: 0 | 1,
    leverage: 1 | 2,
    options: CommandOptions = {},
  ): string | null {
    return this.sendCommand("SUBMIT_BET", { betCents, guess, leverage }, options);
  }

  private rawSend(message: Record<string, unknown>): boolean {
    const socket = this.socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  private openSocket(): void {
    if (this.disposed || this.replaced) return;
    // 新连接尚未拿到身份；只有新的 joined 消息才能恢复“已加入”状态。
    this.joined = false;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = protocol + "//" + window.location.host + "/ws?room=" + encodeURIComponent(this.roomCode);
    this.handlers.onStatus("connecting");
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.onopen = () => {
      this.attempts = 0;
      this.handlers.onStatus("open");
      // 04B 的重连协议：token 只在消息体里带，URL 永远只有房间码。
      const token = this.session?.sessionToken;
      if (token !== undefined) {
        socket.send(JSON.stringify({ type: "resume", roomCode: this.roomCode, sessionToken: token }));
      } else {
        socket.send(JSON.stringify({ type: "join", nickname: this.nickname }));
      }
    };

    socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data === "string") this.handleRaw(event.data);
    };

    socket.onclose = () => {
      if (this.socket === socket) this.socket = null;
      if (this.disposed || this.replaced) return;
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      // 浏览器随后会触发 close；重连只在 close 里安排。
    };
  }

  private scheduleReconnect(): void {
    const delayMs = Math.min(15000, 1000 * 2 ** Math.min(this.attempts, 4));
    this.attempts += 1;
    this.handlers.onStatus("closed", "连接断开，" + String(Math.round(delayMs / 1000)) + " 秒后重连");
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.openSocket();
    }, delayMs);
  }

  private handleRaw(raw: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = message["type"];
    if (typeof type !== "string") return;

    if (type === "joined") {
      const joined: JoinedInfo = {
        roomCode: String(message["roomCode"]),
        playerId: String(message["playerId"]),
        seatId: Number(message["seatId"]),
        sessionToken: String(message["sessionToken"]),
        recoveryCode: typeof message["recoveryCode"] === "string" ? message["recoveryCode"] : undefined,
      };
      this.session = {
        roomCode: joined.roomCode,
        nickname: this.nickname,
        playerId: joined.playerId,
        seatId: joined.seatId,
        sessionToken: joined.sessionToken,
      };
      this.joined = true;
      saveSession(this.session);
      this.handlers.onJoined(joined);
      return;
    }

    if (type === "room") {
      this.handlers.onRoom(message as unknown as WireRoom);
      return;
    }

    if (type === "started") {
      this.lastVersion = -1;
      this.latest = null;
      this.handlers.onStarted(String(message["gameId"]));
      return;
    }

    if (type === "snapshot") {
      this.acceptSnapshot(message["view"] as WireSnapshotView | undefined);
      return;
    }

    if (type === "events") {
      const list = message["events"];
      if (Array.isArray(list)) this.handlers.onEvents?.(list as WireGameEvent[]);
      return;
    }

    if (type === "command_result") {
      this.handlers.onCommandResult(message as unknown as WireCommandResult);
      return;
    }

    if (type === "error") {
      const code = String(message["code"]);
      const text = typeof message["message"] === "string" ? message["message"] : code;
      if (code === "REPLACED") {
        this.replaced = true;
        if (this.retryTimer !== null) {
          window.clearTimeout(this.retryTimer);
          this.retryTimer = null;
        }
        this.handlers.onStatus("replaced", text);
      } else if (isSessionError(code) && !this.joined) {
        // resume/join 被拒：本地 token 已无效，停止重连并清掉会话，避免无限重试。
        this.abandonSession();
      }
      this.handlers.onServerError({ code, message: text });
    }
  }

  /** 身份已不可恢复：清会话、停重连、关掉当前连接，由上层回入口展示错误。 */
  private abandonSession(): void {
    clearSession();
    this.session = null;
    this.disposed = true;
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (socket !== null && socket.readyState <= WebSocket.OPEN) socket.close();
  }

  private acceptSnapshot(view: WireSnapshotView | undefined): void {
    if (view === undefined || typeof view.version !== "number") return;
    if (view.gameId !== this.latest?.gameId) {
      this.lastVersion = -1;
    }
    if (view.version < this.lastVersion) return;
    this.lastVersion = view.version;
    this.latest = view;
    this.handlers.onSnapshot(view);
  }
}

/** 供 UI 判断阶段是否属于“对局进行中”的辅助函数，避免在组件里散落字符串。 */
export function isPlayingPhase(phase: GamePhase): boolean {
  return phase !== "GAME_OVER";
}
