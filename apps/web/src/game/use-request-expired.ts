import { useEffect, useState } from "react";
import { isRequestExpired } from "./request-deadline";

/**
 * 每 250ms 重算当前请求是否过期；serverNow/deadlineMs/receivedAtMs 变化时重新校准。
 * 仅决定客户端是否禁用按钮与显示“已截止”，不删除请求、不代替服务端收口。
 */
export function useRequestExpired(
  deadlineMs: number | null,
  serverNow: string,
  receivedAtMs: number,
): boolean {
  const [, refresh] = useState(0);
  useEffect(() => {
    if (deadlineMs === null || !Number.isFinite(deadlineMs)) return;
    const timer = globalThis.setInterval(() => refresh(tick => tick + 1), 250);
    return () => globalThis.clearInterval(timer);
  }, [deadlineMs, serverNow, receivedAtMs]);
  return isRequestExpired(deadlineMs, serverNow, receivedAtMs, Date.now());
}
