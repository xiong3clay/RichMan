import { z } from "zod";
import { MAX_MONEY_CENTS, MAX_MONEY_DIGITS } from "./money.js";
import { RULES, SERVER_DEFAULTS } from "./rules.js";
import { PHASES, ROOM_STATE } from "./types.js";
import { ERROR_CODES } from "./errors.js";

export const PROTOCOL_VERSION = 1;

const moneyDigits = "0|[1-9][0-9]{0," + String(MAX_MONEY_DIGITS - 1) + "}";
export const MoneyStringSchema = z
  .string()
  .regex(new RegExp("^-?(" + moneyDigits + ")$"), "money string must be canonical decimal")
  .refine((s) => s !== "-0", "negative zero is not allowed")
  .refine((s) => Math.abs(Number(s)) <= MAX_MONEY_CENTS, "money string exceeds the maximum amount");

export const RoomCodeSchema = z.string().regex(/^[0-9]{4,8}$/);

export const GameCommandSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    gameId: z.string().min(1).max(64),
    commandId: z.string().min(1).max(128),
    type: z.string().min(1).max(64),
    payload: z.unknown(),
    expectedGameVersion: z.number().int().nonnegative().optional(),
    roundId: z.number().int().nonnegative().optional(),
    phaseInstanceId: z.string().min(1).max(64).optional(),
    requestId: z.string().min(1).max(64).optional(),
  })
  .strict();

export const SliceBetPayloadSchema = z
  .object({
    bet: MoneyStringSchema,
    guess: z.union([z.literal(0), z.literal(1)]),
    leverage: z.union([z.literal(1), z.literal(2)]),
  })
  .strict();

export const HealthResponseSchema = z
  .object({
    ok: z.literal(true),
    service: z.literal("richman"),
    version: z.string(),
    protocolVersion: z.number().int(),
    uptimeSec: z.number().nonnegative(),
    connections: z.number().int().nonnegative(),
    rooms: z.number().int().nonnegative(),
    serverNow: z.string(),
  })
  .strict();

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const PhaseSchema = z.enum(PHASES);

/* ------------------------------------------------------------------ *
 * 大厅协议（单元 04A）
 * 房间码走连接 URL（/ws?room=0042）；token 不进 URL，只在 joined 响应下发。
 * 04B 用消息体内的 sessionToken 恢复（resume 消息）。
 * ------------------------------------------------------------------ */

/** 昵称按 Unicode 码点计数，1～20 个码点（emoji 不按 UTF-16 双字节重复计）。 */
export const NicknameSchema = z
  .string()
  .refine((value) => [...value].length >= 1, { message: "昵称至少 1 个字符" })
  .refine((value) => [...value].length <= SERVER_DEFAULTS.nicknameMaxCodePoints, {
    message: "昵称最多 " + String(SERVER_DEFAULTS.nicknameMaxCodePoints) + " 个字符",
  });

export const LobbyJoinSchema = z
  .object({
    type: z.literal("join"),
    nickname: NicknameSchema,
    /** 已有会话可在消息体内带回 joined 下发的 token，回到原座位；04B 会独立成 resume 消息。 */
    sessionToken: z.string().min(16).optional(),
  })
  .strict();
export const LobbyReadySchema = z.object({ type: z.literal("ready"), ready: z.boolean() }).strict();
export const LobbyLeaveSchema = z.object({ type: z.literal("leave") }).strict();
export const LobbyStartSchema = z.object({ type: z.literal("start") }).strict();
export const RematchSchema = z.object({ type: z.literal("rematch") }).strict();
export const ResumeSchema = z.object({
  type: z.literal("resume"),
  roomCode: RoomCodeSchema,
  sessionToken: z.string().min(16).max(128).optional(),
  recoveryCode: z.string().min(16).max(128).optional(),
}).strict().refine(value => value.sessionToken !== undefined || value.recoveryCode !== undefined,
  { message: "需要sessionToken或recoveryCode" });

export const GAME_COMMAND_TYPES = [
  "BORROW_BANK", "REQUEST_PRIVATE_LOAN", "ACCEPT_PRIVATE_LOAN", "REFUSE_PRIVATE_LOAN",
  "CANCEL_PRIVATE_LOAN", "REPAY_BANK", "REPAY_PRIVATE", "COLLECT_PRIVATE", "END_ACTION",
  "BANK_DUE_DECISION", "SUBMIT_BET", "RESCUE_GIVE_UP",
] as const;

/** Wire amounts remain canonical decimal cents; the server decodes them for the frozen engine. */
export const ClientGameCommandSchema = GameCommandSchema.extend({
  type: z.enum(GAME_COMMAND_TYPES),
  payload: z.record(z.string(), z.unknown()),
}).superRefine((command, ctx) => {
  for (const field of ["amountCents", "principalCents", "betCents", "cents"]) {
    const value = command.payload[field];
    if (value !== undefined && !MoneyStringSchema.safeParse(value).success) {
      ctx.addIssue({ code: "custom", path: ["payload", field], message: "金额必须为规范整数字符串" });
    }
  }
});

export const ClientLobbyMessageSchema = z.discriminatedUnion("type", [
  LobbyJoinSchema,
  LobbyReadySchema,
  LobbyLeaveSchema,
  LobbyStartSchema,
  RematchSchema,
  ResumeSchema,
]);
export type ClientLobbyMessage = z.infer<typeof ClientLobbyMessageSchema>;

export const LOBBY_ERROR_CODES = [
  "INVALID_MESSAGE",
  "INVALID_STATE",
  "INVALID_NICKNAME",
  "ROOM_NOT_FOUND",
  "ROOM_FULL",
  "ALREADY_STARTED",
  "NOT_JOINED",
  "NOT_HOST",
  "NOT_ALL_READY",
  "NOT_ENOUGH_PLAYERS",
  "REPLACED",
  "UNAUTHORIZED",
  "RATE_LIMITED",
] as const;
export type LobbyErrorCode = (typeof LOBBY_ERROR_CODES)[number];

export const LobbyPlayerSchema = z
  .object({
    playerId: z.string().min(1).max(64),
    nickname: z.string(),
    seatId: z.number().int().min(1).max(RULES.playerMax),
    ready: z.boolean(),
    online: z.boolean(),
  })
  .strict();
export type LobbyPlayer = z.infer<typeof LobbyPlayerSchema>;

const ROOM_STATES = [
  ROOM_STATE.LOBBY,
  ROOM_STATE.PLAYING,
  ROOM_STATE.PAUSED,
  ROOM_STATE.ERROR_PAUSED,
  ROOM_STATE.ENDED,
] as const;
export const RoomStateSchema = z.enum(ROOM_STATES);

export const JoinedMessageSchema = z
  .object({
    type: z.literal("joined"),
    playerId: z.string().min(1).max(64),
    seatId: z.number().int().min(1).max(RULES.playerMax),
    sessionToken: z.string().min(16),
    roomCode: RoomCodeSchema,
    recoveryCode: z.string().min(16).optional(),
    connectionEpoch: z.number().int().positive().optional(),
  })
  .strict();

export const RoomMessageSchema = z
  .object({
    type: z.literal("room"),
    players: z.array(LobbyPlayerSchema),
    hostId: z.string().min(1).max(64).nullable(),
    state: RoomStateSchema,
  })
  .strict();

export const StartedMessageSchema = z
  .object({ type: z.literal("started"), gameId: z.string().min(1).max(64), roomCode: RoomCodeSchema.optional() })
  .strict();

export const PeerLeftMessageSchema = z
  .object({ type: z.literal("peer_left"), playerId: z.string().min(1).max(64) })
  .strict();

export const LobbyErrorSchema = z
  .object({ type: z.literal("error"), code: z.enum(LOBBY_ERROR_CODES), message: z.string() })
  .strict();

export const CommandResultMessageSchema = z.object({
  type: z.literal("command_result"),
  commandId: z.string(), gameId: z.string(), gameVersion: z.number().int().nonnegative(),
  outcome: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true) }).strict(),
    z.object({ ok: z.literal(false), code: z.enum(ERROR_CODES), message: z.string(),
      details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
    }).strict(),
  ]),
}).strict();

// PlayerView and event payloads are engine-owned; transport only wraps the filtered result.
export const SnapshotMessageSchema = z.object({ type: z.literal("snapshot"), view: z.unknown() }).strict();
export const EventsMessageSchema = z.object({ type: z.literal("events"), gameId: z.string(),
  gameVersion: z.number().int().nonnegative(), events: z.array(z.unknown()),
}).strict();

export const ServerLobbyMessageSchema = z.discriminatedUnion("type", [
  JoinedMessageSchema,
  RoomMessageSchema,
  StartedMessageSchema,
  PeerLeftMessageSchema,
  LobbyErrorSchema,
  CommandResultMessageSchema,
  SnapshotMessageSchema,
  EventsMessageSchema,
]);
export type ServerLobbyMessage = z.infer<typeof ServerLobbyMessageSchema>;
