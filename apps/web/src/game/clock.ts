export interface ServerClock {
  serverNow: string;
  offsetMs: number;
}

export function calibrateServerClock(
  previous: ServerClock | null,
  serverNow: string,
  receivedAtMs: number,
): ServerClock {
  // A repeated timestamp is the same sample, not a new receipt of server time.
  // Recalculating it on a render/tick would keep pushing the deadline forward.
  if (previous?.serverNow === serverNow) return previous;
  return { serverNow, offsetMs: Date.parse(serverNow) - receivedAtMs };
}

export function countdownText(deadlineAt: string | null, clock: ServerClock, nowMs: number): string {
  if (deadlineAt === null) return "—";
  const remaining = Date.parse(deadlineAt) - (nowMs + clock.offsetMs);
  if (!Number.isFinite(remaining) || remaining <= 0) return "0:00";
  const seconds = Math.floor(remaining / 1000);
  return String(Math.floor(seconds / 60)) + ":" + String(seconds % 60).padStart(2, "0");
}
