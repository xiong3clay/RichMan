import type { GameEvent } from "@richman/shared";
import { AUDIO_MANIFEST } from "./manifest";

export type SfxName = "tap" | "submit" | "win" | "lose" | "alert";

export interface AudioState {
  muted: boolean;
  bgmVolume: number;
  sfxVolume: number;
}

export interface AudioStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface AudioController {
  readonly state: AudioState;
  readonly unavailable: boolean;
  readonly activeSfxCount: number;
  getState(): AudioState;
  isUnavailable(): boolean;
  isUnlocked(): boolean;
  subscribe(listener: () => void): () => void;
  unlock(): void;
  setMuted(muted: boolean): void;
  setBgmVolume(volume: number): void;
  setSfxVolume(volume: number): void;
  playSfx(name: SfxName): boolean;
  dispose(): void;
}

export interface AudioControllerOptions {
  storage?: AudioStorage;
  createAudio?: (src: string) => HTMLAudioElement | null;
  now?: () => number;
}

export const AUDIO_STATE_KEY = "richman.audio.v1";
const MAX_ACTIVE_SFX = 3;
const DEFAULT_STATE: AudioState = { muted: false, bgmVolume: 0.5, sfxVolume: 0.7 };

function roundVolume(value: number): number {
  const clamped = Math.max(0, Math.min(1, value));
  return Math.round(clamped * 100) / 100;
}

function defaultStorage(): AudioStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function defaultCreateAudio(src: string): HTMLAudioElement | null {
  try {
    if (typeof globalThis.Audio !== "function") return null;
    return new globalThis.Audio(src);
  } catch {
    return null;
  }
}

function loadState(storage: AudioStorage | null): { state: AudioState; invalid: boolean } {
  if (storage === null) return { state: { ...DEFAULT_STATE }, invalid: false };
  try {
    const raw = storage.getItem(AUDIO_STATE_KEY);
    if (raw === null) return { state: { ...DEFAULT_STATE }, invalid: false };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return { state: { ...DEFAULT_STATE }, invalid: true };
    const record = parsed as Record<string, unknown>;
    if (
      typeof record["muted"] !== "boolean"
      || typeof record["bgmVolume"] !== "number"
      || typeof record["sfxVolume"] !== "number"
    ) {
      return { state: { ...DEFAULT_STATE }, invalid: true };
    }
    const bgmVolume = record["bgmVolume"];
    const sfxVolume = record["sfxVolume"];
    if (
      !Number.isFinite(bgmVolume) || bgmVolume < 0 || bgmVolume > 1
      || !Number.isFinite(sfxVolume) || sfxVolume < 0 || sfxVolume > 1
    ) {
      return { state: { ...DEFAULT_STATE }, invalid: true };
    }
    return {
      state: {
        muted: record["muted"],
        bgmVolume: roundVolume(bgmVolume),
        sfxVolume: roundVolume(sfxVolume),
      },
      invalid: false,
    };
  } catch {
    return { state: { ...DEFAULT_STATE }, invalid: true };
  }
}

/** 可注入存储/Audio/clock 的播放控制器；失败一律降级，不抛给游戏。 */
export function createAudioController(options: AudioControllerOptions = {}): AudioController {
  const storage = options.storage ?? defaultStorage();
  const createAudio = options.createAudio ?? defaultCreateAudio;
  const now = options.now ?? (() => Date.now());
  const loaded = loadState(storage);
  let current = loaded.state;
  let unavailable = false;
  let unlocked = false;
  let disposed = false;
  let bgm: HTMLAudioElement | null = null;
  const active: HTMLAudioElement[] = [];
  const lastByName = new Map<SfxName, number>();
  const listeners = new Set<() => void>();

  function emit(): void {
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* 订阅者异常不能影响音频 */ }
    }
  }

  function persist(): void {
    try {
      storage?.setItem(AUDIO_STATE_KEY, JSON.stringify(current));
    } catch { /* 隐私模式/配额满：只影响持久化，不影响游戏 */ }
  }

  if (loaded.invalid) persist();

  function markUnavailable(): void {
    if (unavailable) return;
    unavailable = true;
    emit();
  }

  function safePlay(audio: HTMLAudioElement, onFailure?: () => void): boolean {
    try {
      const result = audio.play();
      if (result !== undefined && typeof result.then === "function") {
        result.catch(() => {
          onFailure?.();
          markUnavailable();
        });
      }
      return true;
    } catch {
      onFailure?.();
      markUnavailable();
      return false;
    }
  }

  function update(patch: Partial<AudioState>): void {
    current = { ...current, ...patch };
    persist();
    emit();
  }

  function removeEnded(audio: HTMLAudioElement): void {
    const index = active.indexOf(audio);
    if (index >= 0) active.splice(index, 1);
  }

  return {
    get state(): AudioState { return { ...current }; },
    get unavailable(): boolean { return unavailable; },
    get activeSfxCount(): number { return active.length; },
    getState(): AudioState { return { ...current }; },
    isUnavailable(): boolean { return unavailable; },
    isUnlocked(): boolean { return unlocked; },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    unlock(): void {
      if (unlocked || disposed) return;
      unlocked = true;
      try {
        const created = createAudio(AUDIO_MANIFEST.bgm);
        if (created === null) {
          markUnavailable();
          return;
        }
        bgm = created;
        bgm.loop = true;
        bgm.volume = current.bgmVolume;
        if (!current.muted) safePlay(bgm);
      } catch {
        markUnavailable();
      }
    },
    setMuted(muted: boolean): void {
      if (disposed) return;
      update({ muted });
      if (bgm === null) return;
      try {
        if (muted) bgm.pause();
        else safePlay(bgm);
      } catch {
        markUnavailable();
      }
    },
    setBgmVolume(volume: number): void {
      if (disposed) return;
      const next = roundVolume(volume);
      update({ bgmVolume: next });
      if (bgm === null) return;
      try { bgm.volume = next; } catch { markUnavailable(); }
    },
    setSfxVolume(volume: number): void {
      if (disposed) return;
      update({ sfxVolume: roundVolume(volume) });
    },
    playSfx(name: SfxName): boolean {
      if (disposed || unlocked === false || unavailable || current.muted || current.sfxVolume === 0) return false;
      const stamp = now();
      if (lastByName.get(name) === stamp) return false;
      lastByName.set(name, stamp);
      let audio: HTMLAudioElement | null = null;
      try {
        audio = createAudio(AUDIO_MANIFEST.sfx[name]);
      } catch {
        markUnavailable();
        return false;
      }
      if (audio === null) {
        markUnavailable();
        return false;
      }
      if (active.length >= MAX_ACTIVE_SFX) {
        const oldest = active.shift();
        try { oldest?.pause(); } catch { /* 已结束/不可暂停 */ }
      }
      try {
        audio.volume = current.sfxVolume;
        audio.onended = () => removeEnded(audio!);
      } catch {
        markUnavailable();
        return false;
      }
      active.push(audio);
      const started = safePlay(audio, () => removeEnded(audio));
      if (!started) {
        removeEnded(audio);
        return false;
      }
      return true;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (bgm !== null) {
        try { bgm.pause(); } catch { /* ignore */ }
        bgm = null;
      }
      for (const audio of active) {
        try { audio.pause(); } catch { /* ignore */ }
      }
      active.length = 0;
      listeners.clear();
    },
  };
}

/**
 * 调用方去重：同一 seq 只取一次。使用 Set 而非固定 50 窗口，
 * 保证不会因为 300 条事件窗口滚动而重播旧音效。
 */
export function collectNewSfx(
  derived: Array<{ seq: number; name: SfxName }>,
  played: Set<number>,
): Array<{ seq: number; name: SfxName }> {
  const result: Array<{ seq: number; name: SfxName }> = [];
  for (const item of derived) {
    if (played.has(item.seq)) continue;
    played.add(item.seq);
    result.push(item);
  }
  return result;
}

function payloadOf(event: GameEvent): Record<string, unknown> {
  return typeof event.payload === "object" && event.payload !== null
    ? event.payload as Record<string, unknown>
    : {};
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * 事件→音效纯函数；只判断本人相关事件。调用方用 collectNewSfx + Set 按 seq 去重
 * （覆盖整个事件窗口，不是固定 50 个）。
 * LOAN_REQUEST_CLOSED/EXPIRED 不带借款人时，从同一批 LOAN_REQUESTED 建立 requestId 映射。
 */
export function deriveSfxEvents(
  events: GameEvent[],
  ownPlayerId: string,
): Array<{ seq: number; name: SfxName }> {
  const result: Array<{ seq: number; name: SfxName }> = [];
  const requestBorrowers = new Map<string, string>();

  for (const event of events) {
    const payload = payloadOf(event);

    if (event.type === "LOAN_REQUESTED") {
      const requestId = asString(payload["requestId"]);
      const borrowerId = asString(payload["borrowerId"]);
      if (requestId !== null && borrowerId !== null) requestBorrowers.set(requestId, borrowerId);
    }

    if (event.type === "BET_SETTLED") {
      const players = Array.isArray(payload["players"]) ? payload["players"] : [];
      const own = players.find((player) => {
        if (typeof player !== "object" || player === null) return false;
        return (player as Record<string, unknown>)["playerId"] === ownPlayerId;
      }) as Record<string, unknown> | undefined;
      if (own !== undefined) {
        const delta = asNumber(own["deltaCents"]);
        if (delta !== null && delta > 0) result.push({ seq: event.seq, name: "win" });
        else if (delta !== null && delta < 0) result.push({ seq: event.seq, name: "lose" });
      }
    } else if (event.type === "BANK_LOAN_DEFAULTED") {
      if (asString(payload["borrowerId"]) === ownPlayerId) result.push({ seq: event.seq, name: "alert" });
    } else if (event.type === "DANGER_RESCUED") {
      if (asString(payload["playerId"]) === ownPlayerId) result.push({ seq: event.seq, name: "win" });
    } else if (event.type === "LOAN_REQUEST_CLOSED" || event.type === "LOAN_REQUEST_EXPIRED") {
      const requestId = asString(payload["requestId"]);
      const borrowerId = asString(payload["borrowerId"])
        ?? (requestId === null ? null : requestBorrowers.get(requestId) ?? null);
      const status = asString(payload["status"]) ?? (event.type === "LOAN_REQUEST_EXPIRED" ? "EXPIRED" : null);
      if (borrowerId === ownPlayerId && (status === "REFUSED" || status === "EXPIRED")) {
        result.push({ seq: event.seq, name: "lose" });
      }
    } else if (event.type === "ROUND_SETTLED") {
      result.push({ seq: event.seq, name: "submit" });
    } else if (event.type === "GAME_OVER") {
      if (asString(payload["winnerId"]) === ownPlayerId) result.push({ seq: event.seq, name: "win" });
      else result.push({ seq: event.seq, name: "lose" });
    }
  }

  return result;
}
