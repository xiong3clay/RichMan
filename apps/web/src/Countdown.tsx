import { useEffect, useRef, useState } from "react";
import { calibrateServerClock, countdownText } from "./game/clock";
import type { ServerClock } from "./game/clock";

export interface CountdownProps {
  deadlineAt: string | null;
  serverNow: string;
  /** Local receipt time for this snapshot; omit to sample on first render. */
  receivedAtMs?: number;
}

export function Countdown({ deadlineAt, serverNow, receivedAtMs }: CountdownProps) {
  const clock = useRef<ServerClock | null>(null);
  const [, refresh] = useState(0);
  const nowMs = Date.now();
  clock.current = calibrateServerClock(clock.current, serverNow, receivedAtMs ?? nowMs);

  useEffect(() => {
    if (deadlineAt === null) return;
    const timer = globalThis.setInterval(() => refresh((tick) => tick + 1), 250);
    return () => globalThis.clearInterval(timer);
  }, [deadlineAt]);

  return <span className="countdown">{countdownText(deadlineAt, clock.current, nowMs)}</span>;
}

