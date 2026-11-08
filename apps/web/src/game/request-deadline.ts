import { calibrateServerClock } from "./clock";

/** 请求截止毫秒转 ISO；NaN/Infinity/非数字/超出 Date 范围返回 null。 */
export function requestDeadlineIso(deadlineMs: unknown): string | null {
  if (typeof deadlineMs !== "number" || !Number.isFinite(deadlineMs)) return null;
  const date = new Date(deadlineMs);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString();
}

/**
 * 以快照 serverNow 与本地 receivedAtMs 校准服务端时钟，判断请求是否已到截止。
 * 只用于客户端禁用按钮与文案，权威裁决仍在服务端；非法输入一律 false、不抛错。
 */
export function isRequestExpired(
  deadlineMs: number | null | undefined,
  serverNow: string,
  receivedAtMs: number,
  nowMs: number = Date.now(),
): boolean {
  if (typeof deadlineMs !== "number" || !Number.isFinite(deadlineMs)) return false;
  if (!Number.isFinite(receivedAtMs) || !Number.isFinite(nowMs)) return false;
  const clock = calibrateServerClock(null, serverNow, receivedAtMs);
  if (!Number.isFinite(clock.offsetMs)) return false;
  return deadlineMs <= nowMs + clock.offsetMs;
}
