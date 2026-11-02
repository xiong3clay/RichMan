import { randomInt } from "node:crypto";
import { advanceSystem } from "@richman/game-core";
import type { EngineState } from "@richman/game-core";
import type { TransitionResult } from "@richman/shared";
import type { RoomCommandQueue } from "./command-queue.js";

interface SchedulerOptions {
  queue: RoomCommandQueue;
  getState: (roomCode: string) => EngineState | null;
  commit: (roomCode: string, result: TransitionResult) => void | Promise<void>;
  now?: () => number;
  draw?: () => 0 | 1;
  onError?: (error: unknown, roomCode: string) => void;
}

interface ScheduledWakeup {
  epoch: number;
  gameId: string;
  phaseInstanceId: string;
  deadlineAt: string | null;
  timer: ReturnType<typeof setTimeout>;
}

/** Timers only wake the room queue; the immutable engine owns all rules. */
export class RoomScheduler {
  private readonly wakeups = new Map<string, ScheduledWakeup>();
  private readonly now: () => number;
  private readonly draw: () => 0 | 1;
  private epoch = 0;
  private closed = false;

  constructor(private readonly options: SchedulerOptions) {
    this.now = options.now ?? (() => Date.now());
    this.draw = options.draw ?? (() => randomInt(2) as 0 | 1);
  }

  schedule(roomCode: string): void {
    if (this.closed) return;
    const state = this.options.getState(roomCode);
    const current = this.wakeups.get(roomCode);
    if (state === null || state.phase === "GAME_OVER") {
      this.cancel(roomCode);
      return;
    }
    if (current && current.gameId === state.gameId
      && current.phaseInstanceId === state.phaseInstanceId && current.deadlineAt === state.deadlineAt) return;

    this.cancel(roomCode);
    const epoch = ++this.epoch;
    const deadlineMs = this.deadlineMs(state);
    const timer = setTimeout(() => {
      void this.options.queue.run(roomCode, async () => {
        // Check after waiting for earlier player commands, not before enqueueing.
        const latest = this.options.getState(roomCode);
        if (this.closed || this.wakeups.get(roomCode)?.epoch !== epoch || latest === null
          || latest.gameId !== state.gameId || latest.phaseInstanceId !== state.phaseInstanceId
          || latest.deadlineAt !== state.deadlineAt) return;

        this.cancel(roomCode);
        await this.advanceDue(roomCode);
        // Also works when commit does not reschedule. Repeated scheduling of the
        // same target is a no-op when a host's commit already armed its timer.
        const next = this.options.getState(roomCode);
        if (next && (next.version !== latest.version || next.deadlineAt !== null)) this.schedule(roomCode);
      }).catch((error: unknown) => {
        if (this.options.onError) this.options.onError(error, roomCode);
        else console.error("Room scheduler failed; automatic advancement stopped.");
      });
    }, Math.max(0, (deadlineMs ?? this.now()) - this.now()));
    timer.unref?.();
    this.wakeups.set(roomCode, {
      epoch,
      gameId: state.gameId,
      phaseInstanceId: state.phaseInstanceId,
      deadlineAt: state.deadlineAt,
      timer,
    });
  }

  /** Caller already owns the room queue; enqueueing here would deadlock. */
  async advanceDue(roomCode: string): Promise<void> {
    while (!this.closed) {
      const state = this.options.getState(roomCode);
      if (state === null || state.phase === "GAME_OVER") return;
      const deadlineMs = this.deadlineMs(state);
      const nowMs = this.now();
      if (deadlineMs !== null && deadlineMs > nowMs) return;

      const result = advanceSystem(state, {
        actorId: "SYSTEM",
        // Preserve the original timeline when the event loop wakes up late.
        // The engine creates the next deadline relative to its injected time.
        nowMs: deadlineMs ?? nowMs,
        drawResult: state.phase === "BETTING" ? this.draw() : 0,
      });
      if (!result.outcome.ok) throw new Error(result.outcome.message);
      if (result.state.version === state.version) return;
      await this.options.commit(roomCode, result);
    }
  }

  close(): void {
    this.closed = true;
    for (const roomCode of this.wakeups.keys()) this.cancel(roomCode);
  }

  private cancel(roomCode: string): void {
    const wakeup = this.wakeups.get(roomCode);
    if (wakeup) clearTimeout(wakeup.timer);
    this.wakeups.delete(roomCode);
  }

  private deadlineMs(state: EngineState): number | null {
    if (state.deadlineAt === null) return null;
    const ms = Date.parse(state.deadlineAt);
    if (!Number.isFinite(ms)) throw new Error("Room deadlineAt is invalid.");
    return ms;
  }
}
