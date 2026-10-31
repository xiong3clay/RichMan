import { z } from "zod";
import { MAX_MONEY_DIGITS } from "./money.js";
import { PHASES } from "./types.js";

export const PROTOCOL_VERSION = 1;

const moneyDigits = "0|[1-9][0-9]{0," + String(MAX_MONEY_DIGITS - 1) + "}";
export const MoneyStringSchema = z
  .string()
  .regex(new RegExp("^-?(" + moneyDigits + ")$"), "money string must be canonical decimal")
  .refine((s) => s !== "-0", "negative zero is not allowed");

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
