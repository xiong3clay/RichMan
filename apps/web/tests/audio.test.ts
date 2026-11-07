import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GameEvent } from "@richman/shared";
import { GameView } from "../src/GameView";
import type { GameViewProps } from "../src/GameView";
import { LobbyView } from "../src/LobbyView";
import { AudioPanel } from "../src/audio/AudioPanel";
import {
  AUDIO_STATE_KEY,
  collectNewSfx,
  createAudioController,
  deriveSfxEvents,
} from "../src/audio/audio";
import { AUDIO_BYTES, AUDIO_FILES, AUDIO_SHA256 } from "../src/audio/manifest";
import type { RichmanClient } from "../src/net/client";
import type { JoinedInfo, WireRoom, WireSnapshotView } from "../src/net/wire";
import { mountDom } from "./dom-harness";
import { viewFixture } from "./view-fixtures";

const AUDIO_DIR = fileURLToPath(new URL("../public/audio/", import.meta.url));
const APP_SOURCE = readFileSync(fileURLToPath(new URL("../src/App.tsx", import.meta.url)), "utf8");

let mounted: Awaited<ReturnType<typeof mountDom>> | undefined;
afterEach(async () => {
  await mounted?.cleanup();
  mounted = undefined;
});

function readWav(name: string): Buffer {
  return readFileSync(AUDIO_DIR + name);
}

function wavInfo(name: string) {
  const buffer = readWav(name);
  return {
    buffer,
    riff: buffer.toString("ascii", 0, 4),
    wave: buffer.toString("ascii", 8, 12),
    fmt: buffer.toString("ascii", 12, 16),
    dataTag: buffer.toString("ascii", 36, 40),
    format: buffer.readUInt16LE(20),
    channels: buffer.readUInt16LE(22),
    sampleRate: buffer.readUInt32LE(24),
    bits: buffer.readUInt16LE(34),
    dataLength: buffer.readUInt32LE(40),
  };
}

class FakeAudio {
  loop = false;
  volume = 1;
  paused = false;
  playCalls = 0;
  pauseCalls = 0;
  onended: (() => void) | null = null;
  rejectPlay = false;
  constructor(readonly src: string) {}
  play(): Promise<void> {
    this.playCalls += 1;
    return this.rejectPlay ? Promise.reject(new Error("blocked")) : Promise.resolve();
  }
  pause(): void {
    this.pauseCalls += 1;
    this.paused = true;
  }
  ended(): void {
    this.onended?.();
  }
}

function fakeAudioFactory() {
  const audios: FakeAudio[] = [];
  return {
    audios,
    createAudio: (src: string): HTMLAudioElement => {
      const audio = new FakeAudio(src);
      audios.push(audio);
      return audio as unknown as HTMLAudioElement;
    },
  };
}

function memoryStorage(initial: string | null = null) {
  let value = initial;
  const writes: string[] = [];
  return {
    get value(): string | null { return value; },
    writes,
    getItem: (): string | null => value,
    setItem: (_key: string, next: string): void => {
      value = next;
      writes.push(next);
    },
  };
}

function event(seq: number, type: string, payload: Record<string, unknown>): GameEvent {
  return { seq, type, at: "2026-11-07T00:00:00.000Z", payload };
}

const joined: JoinedInfo = { roomCode: "0042", playerId: "p1", seatId: 1, sessionToken: "token" };
const room: WireRoom = {
  type: "room",
  state: "LOBBY",
  hostId: "p1",
  paused: false,
  players: [
    { playerId: "p1", nickname: "甲", seatId: 1, ready: false, online: true },
    { playerId: "p2", nickname: "乙", seatId: 2, ready: false, online: true },
  ],
};

function fakeClient() {
  return {
    hasJoined: true,
    sendLobby: vi.fn(),
    submitBet: vi.fn(),
    endAction: vi.fn(),
    borrowBank: vi.fn(),
  };
}

function gameProps(client: ReturnType<typeof fakeClient>, view: WireSnapshotView, onOpenAudio: () => void): GameViewProps {
  return {
    roomCode: "0042",
    hostId: null,
    view,
    status: "open",
    statusDetail: null,
    result: null,
    error: null,
    events: [],
    client: client as unknown as RichmanClient,
    onOpenAudio,
  };
}

describe("08C 音频", () => {
  it("A1 6 个 WAV 皆为 22050Hz / 8-bit / 单声道 / 标准头，时长与大小合规", () => {
    expect(AUDIO_FILES).toHaveLength(6);
    const expected: Record<string, number> = {
      "bgm-loop.wav": 16,
      "sfx-tap.wav": 0.06,
      "sfx-submit.wav": 0.14,
      "sfx-win.wav": 0.6,
      "sfx-lose.wav": 0.5,
      "sfx-alert.wav": 0.45,
    };
    for (const name of AUDIO_FILES) {
      const info = wavInfo(name);
      expect(info.riff).toBe("RIFF");
      expect(info.wave).toBe("WAVE");
      expect(info.fmt).toBe("fmt ");
      expect(info.dataTag).toBe("data");
      expect(info.format).toBe(1);
      expect(info.channels).toBe(1);
      expect(info.sampleRate).toBe(22050);
      expect(info.bits).toBe(8);
      expect(info.dataLength).toBe(info.buffer.length - 44);
      expect(info.dataLength / info.sampleRate).toBeCloseTo(expected[name]!, 2);
      expect(info.buffer.length).toBe(AUDIO_BYTES[name]);
      if (name === "bgm-loop.wav") expect(info.buffer.length).toBeLessThanOrEqual(420000);
      else expect(info.buffer.length).toBeLessThanOrEqual(40960);
    }
  });

  it("A1 8-bit 峰值不超过 ±100；BGM 首尾接近中值", () => {
    for (const name of AUDIO_FILES) {
      const buffer = readWav(name);
      let sum = 0;
      for (let index = 44; index < buffer.length; index += 1) {
        const value = buffer.readUInt8(index) - 128;
        sum += value;
        expect(Math.abs(value)).toBeLessThanOrEqual(100);
      }
      // N1/M2：不能只查峰值；整轨均值必须 ≤2。
      expect(Math.abs(sum / (buffer.length - 44))).toBeLessThanOrEqual(2);
    }
    const bgm = readWav("bgm-loop.wav");
    expect(Math.abs(bgm.readUInt8(44) - 128)).toBeLessThanOrEqual(3);
    expect(Math.abs(bgm.readUInt8(bgm.length - 1) - 128)).toBeLessThanOrEqual(3);
  });

  it("A2 文件 sha256 与 manifest 记录一致", () => {
    for (const name of AUDIO_FILES) {
      const digest = createHash("sha256").update(readWav(name)).digest("hex");
      expect(digest).toBe(AUDIO_SHA256[name]);
    }
  });

  it("B1 默认状态、持久化恢复、损坏 JSON 回默认并覆盖", () => {
    const storage = memoryStorage();
    const controller = createAudioController({ storage, createAudio: () => null });
    expect(controller.getState()).toEqual({ muted: false, bgmVolume: 0.5, sfxVolume: 0.7 });
    controller.setMuted(true);
    controller.setBgmVolume(0.25);
    controller.setSfxVolume(0.9);
    const restored = createAudioController({ storage, createAudio: () => null });
    expect(restored.getState()).toEqual({ muted: true, bgmVolume: 0.25, sfxVolume: 0.9 });

    const corrupt = memoryStorage("{");
    const fallback = createAudioController({ storage: corrupt, createAudio: () => null });
    expect(fallback.getState()).toEqual({ muted: false, bgmVolume: 0.5, sfxVolume: 0.7 });
    expect(corrupt.value).toBe(JSON.stringify({ muted: false, bgmVolume: 0.5, sfxVolume: 0.7 }));
    expect(corrupt.writes.length).toBeGreaterThan(0);
  });

  it("B1 越界持久值回默认", () => {
    const storage = memoryStorage(JSON.stringify({ muted: false, bgmVolume: 2, sfxVolume: 0.7 }));
    const controller = createAudioController({ storage, createAudio: () => null });
    expect(controller.getState()).toEqual({ muted: false, bgmVolume: 0.5, sfxVolume: 0.7 });
    expect(storage.value).toBe(JSON.stringify({ muted: false, bgmVolume: 0.5, sfxVolume: 0.7 }));
  });

  it("B2 音量 clamp -1→0、2→1、0.333→0.33", () => {
    const storage = memoryStorage();
    const controller = createAudioController({ storage, createAudio: () => null });
    controller.setBgmVolume(-1);
    expect(controller.getState().bgmVolume).toBe(0);
    controller.setBgmVolume(2);
    expect(controller.getState().bgmVolume).toBe(1);
    controller.setBgmVolume(0.333);
    expect(controller.getState().bgmVolume).toBe(0.33);
    controller.setSfxVolume(0.335);
    expect(controller.getState().sfxVolume).toBe(0.34);
  });

  it("B3 unlock 前不创建 Audio；unlock 只创建 BGM 一次并 play", () => {
    const fake = fakeAudioFactory();
    const controller = createAudioController({ storage: memoryStorage(), createAudio: fake.createAudio });
    expect(controller.playSfx("tap")).toBe(false);
    expect(fake.audios).toHaveLength(0);
    expect(controller.isUnlocked()).toBe(false);
    controller.unlock();
    expect(fake.audios).toHaveLength(1);
    expect(fake.audios[0]!.loop).toBe(true);
    expect(fake.audios[0]!.volume).toBe(0.5);
    expect(fake.audios[0]!.playCalls).toBe(1);
    controller.unlock();
    expect(fake.audios).toHaveLength(1);
    expect(fake.audios[0]!.playCalls).toBe(1);
    expect(controller.isUnlocked()).toBe(true);
  });

  it("B4 静音时 playSfx 返回 false 且不创建；取消静音 resume BGM", () => {
    const fake = fakeAudioFactory();
    const controller = createAudioController({ storage: memoryStorage(), createAudio: fake.createAudio });
    controller.unlock();
    controller.setMuted(true);
    expect(fake.audios[0]!.pauseCalls).toBe(1);
    expect(controller.playSfx("tap")).toBe(false);
    expect(fake.audios).toHaveLength(1);
    controller.setMuted(false);
    expect(fake.audios[0]!.playCalls).toBe(2);
  });

  it("S1 持久化 muted=true 时 unlock 不播 BGM，取消静音后恢复", () => {
    const fake = fakeAudioFactory();
    const controller = createAudioController({ storage: memoryStorage(), createAudio: fake.createAudio });
    controller.setMuted(true);
    controller.unlock();
    expect(fake.audios).toHaveLength(1);
    expect(fake.audios[0]!.loop).toBe(true);
    expect(fake.audios[0]!.playCalls).toBe(0);
    controller.setMuted(false);
    expect(fake.audios[0]!.playCalls).toBe(1);
  });

  it("N4 createAudio 抛异常 → unavailable 且不抛", () => {
    const controller = createAudioController({
      storage: memoryStorage(),
      createAudio: (): HTMLAudioElement => { throw new Error("no audio"); },
    });
    expect(() => controller.unlock()).not.toThrow();
    expect(controller.isUnavailable()).toBe(true);
    expect(controller.playSfx("tap")).toBe(false);
  });

  it("B5 play() reject 不抛且置 unavailable", async () => {
    const audios: FakeAudio[] = [];
    const rejectingFactory = (src: string): HTMLAudioElement => {
      const audio = new FakeAudio(src);
      audio.rejectPlay = true;
      audios.push(audio);
      return audio as unknown as HTMLAudioElement;
    };
    const controller = createAudioController({ storage: memoryStorage(), createAudio: rejectingFactory });
    expect(() => controller.unlock()).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.isUnavailable()).toBe(true);
    expect(audios).toHaveLength(1);
  });

  it("S2 SFX play reject 后 active 清理，后续 playSfx 返回 false", async () => {
    const audios: FakeAudio[] = [];
    const factory = (src: string): HTMLAudioElement => {
      const audio = new FakeAudio(src);
      if (src.includes("sfx-")) audio.rejectPlay = true;
      audios.push(audio);
      return audio as unknown as HTMLAudioElement;
    };
    const controller = createAudioController({ storage: memoryStorage(), createAudio: factory });
    controller.unlock();
    expect(controller.playSfx("tap")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.isUnavailable()).toBe(true);
    expect(controller.activeSfxCount).toBe(0);
    expect(controller.playSfx("submit")).toBe(false);
    expect(audios).toHaveLength(2);
  });

  it("B6 同一 now 毫秒同名只播一次；第 4 个同时音效丢弃最旧", () => {
    let clock = 1000;
    const fake = fakeAudioFactory();
    const controller = createAudioController({
      storage: memoryStorage(),
      createAudio: fake.createAudio,
      now: () => clock,
    });
    controller.unlock();
    expect(controller.playSfx("tap")).toBe(true);
    expect(controller.playSfx("tap")).toBe(false);
    expect(fake.audios).toHaveLength(2);
    clock += 1;
    expect(controller.playSfx("submit")).toBe(true);
    clock += 1;
    expect(controller.playSfx("win")).toBe(true);
    clock += 1;
    expect(controller.playSfx("lose")).toBe(true);
    expect(fake.audios).toHaveLength(5);
    expect(fake.audios[1]!.pauseCalls).toBe(1);
    expect(fake.audios[4]!.pauseCalls).toBe(0);
  });

  it("B7 dispose 停止 BGM，之后 playSfx 不再创建", () => {
    const fake = fakeAudioFactory();
    const controller = createAudioController({ storage: memoryStorage(), createAudio: fake.createAudio });
    controller.unlock();
    expect(fake.audios[0]!.playCalls).toBe(1);
    controller.dispose();
    expect(fake.audios[0]!.pauseCalls).toBeGreaterThanOrEqual(1);
    expect(controller.playSfx("tap")).toBe(false);
    expect(fake.audios).toHaveLength(1);
  });

  it("C1 BET_SETTLED 本人赢/输/0 三态，他人不播", () => {
    const win = deriveSfxEvents([event(1, "BET_SETTLED", {
      players: [{ playerId: "me", deltaCents: "100" }, { playerId: "other", deltaCents: "-100" }],
    })], "me");
    expect(win).toEqual([{ seq: 1, name: "win" }]);

    const lose = deriveSfxEvents([event(2, "BET_SETTLED", {
      players: [{ playerId: "me", deltaCents: "-100" }],
    })], "me");
    expect(lose).toEqual([{ seq: 2, name: "lose" }]);

    const zero = deriveSfxEvents([event(3, "BET_SETTLED", {
      players: [{ playerId: "me", deltaCents: 0 }],
    })], "me");
    expect(zero).toEqual([]);

    const other = deriveSfxEvents([event(4, "BET_SETTLED", {
      players: [{ playerId: "other", deltaCents: "100" }],
    })], "me");
    expect(other).toEqual([]);
  });

  it("C2 BANK_LOAN_DEFAULTED 本人 alert，非本人不播", () => {
    expect(deriveSfxEvents([event(5, "BANK_LOAN_DEFAULTED", { borrowerId: "me" })], "me"))
      .toEqual([{ seq: 5, name: "alert" }]);
    expect(deriveSfxEvents([event(6, "BANK_LOAN_DEFAULTED", { borrowerId: "other" })], "me"))
      .toEqual([]);
  });

  it("C2 借款被拒/过期只对本人 lose，需从 LOAN_REQUESTED 映射借款人", () => {
    const refused = deriveSfxEvents([
      event(7, "LOAN_REQUESTED", { requestId: "r1", borrowerId: "me", lenderId: "other" }),
      event(8, "LOAN_REQUEST_CLOSED", { requestId: "r1", status: "REFUSED" }),
    ], "me");
    expect(refused).toEqual([{ seq: 8, name: "lose" }]);

    const expired = deriveSfxEvents([
      event(9, "LOAN_REQUESTED", { requestId: "r2", borrowerId: "me", lenderId: "other" }),
      event(10, "LOAN_REQUEST_EXPIRED", { requestId: "r2" }),
    ], "me");
    expect(expired).toEqual([{ seq: 10, name: "lose" }]);

    const otherBorrower = deriveSfxEvents([
      event(11, "LOAN_REQUESTED", { requestId: "r3", borrowerId: "other", lenderId: "me" }),
      event(12, "LOAN_REQUEST_CLOSED", { requestId: "r3", status: "REFUSED" }),
    ], "me");
    expect(otherBorrower).toEqual([]);
  });

  it("C2 其余事件：自救/回合/结算/游戏结束", () => {
    expect(deriveSfxEvents([event(13, "DANGER_RESCUED", { playerId: "me" })], "me"))
      .toEqual([{ seq: 13, name: "win" }]);
    expect(deriveSfxEvents([event(14, "ROUND_SETTLED", {})], "me"))
      .toEqual([{ seq: 14, name: "submit" }]);
    expect(deriveSfxEvents([event(15, "GAME_OVER", { winnerId: "me" })], "me"))
      .toEqual([{ seq: 15, name: "win" }]);
    expect(deriveSfxEvents([event(16, "GAME_OVER", { winnerId: "other" })], "me"))
      .toEqual([{ seq: 16, name: "lose" }]);
  });

  it("C3 同 seq 只取一次，重复调用返回空", () => {
    const derived = [
      { seq: 20, name: "win" as const },
      { seq: 20, name: "win" as const },
      { seq: 21, name: "lose" as const },
    ];
    const played = new Set<number>();
    expect(collectNewSfx(derived, played)).toEqual([
      { seq: 20, name: "win" },
      { seq: 21, name: "lose" },
    ]);
    expect(collectNewSfx(derived, played)).toEqual([]);
  });

  it("M3 连续 400 批事件不重播；300 条窗口滚动后旧 seq 不重播；新局清空后可重播", () => {
    const played = new Set<number>();
    const events: GameEvent[] = [];
    let plays = 0;
    for (let seq = 1; seq <= 400; seq += 1) {
      events.push(event(seq, "BET_SETTLED", { players: [{ playerId: "me", deltaCents: "1" }] }));
      plays += collectNewSfx(deriveSfxEvents(events.slice(-300), "me"), played).length;
    }
    expect(plays).toBe(400);
    expect(collectNewSfx(deriveSfxEvents(events.slice(-300), "me"), played)).toEqual([]);

    played.clear();
    expect(collectNewSfx(deriveSfxEvents([
      event(1, "BET_SETTLED", { players: [{ playerId: "me", deltaCents: "1" }] }),
    ], "me"), played)).toEqual([{ seq: 1, name: "win" }]);
  });

  it("S3 REQUESTED 与 CLOSED 分两批、300 窗口内仍播 lose", () => {
    const played = new Set<number>();
    const requested = event(10, "LOAN_REQUESTED", { requestId: "r1", borrowerId: "me", lenderId: "other" });
    expect(collectNewSfx(deriveSfxEvents([requested], "me"), played)).toEqual([]);
    const filler = Array.from({ length: 280 }, (_, index) => event(
      11 + index,
      "BET_SETTLED",
      { players: [{ playerId: "other", deltaCents: "1" }] },
    ));
    const closed = event(291, "LOAN_REQUEST_CLOSED", { requestId: "r1", status: "REFUSED" });
    const batch = [requested, ...filler, closed].slice(-300);
    expect(collectNewSfx(deriveSfxEvents(batch, "me"), played)).toEqual([{ seq: 291, name: "lose" }]);
  });

  it("S3 超过 300 条窗口时 REQUESTED 被淘汰，映射丢失（已记录边界）", () => {
    const requested = event(1, "LOAN_REQUESTED", { requestId: "r1", borrowerId: "me", lenderId: "other" });
    const filler = Array.from({ length: 300 }, (_, index) => event(
      2 + index,
      "BET_SETTLED",
      { players: [{ playerId: "other", deltaCents: "1" }] },
    ));
    const closed = event(302, "LOAN_REQUEST_CLOSED", { requestId: "r1", status: "REFUSED" });
    const batch = [requested, ...filler, closed].slice(-300);
    expect(deriveSfxEvents(batch, "me")).toEqual([]);
  });

  it("S3 GAME_OVER winnerId=null → lose；ROUND_SETTLED dormant，不把 ROUND_STARTED 当结算", () => {
    expect(deriveSfxEvents([event(30, "GAME_OVER", { winnerId: null })], "me"))
      .toEqual([{ seq: 30, name: "lose" }]);
    expect(deriveSfxEvents([event(31, "ROUND_SETTLED", {})], "me"))
      .toEqual([{ seq: 31, name: "submit" }]);
    // 引擎当前只有 ROUND_STARTED，没有 ROUND_SETTLED；这里明确不得误当结算。
    expect(deriveSfxEvents([event(32, "ROUND_STARTED", {})], "me")).toEqual([]);
  });

  it("D1 面板三控件可见，关闭按钮与 Esc 都调用 onClose", async () => {
    const fake = fakeAudioFactory();
    const controller = createAudioController({ storage: memoryStorage(), createAudio: fake.createAudio });
    const onClose = vi.fn();
    mounted = await mountDom(createElement(AudioPanel, { controller, onClose }));
    expect(mounted.container.querySelectorAll(".audio-panel")).toHaveLength(1);
    expect(mounted.container.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
    expect(mounted.container.querySelectorAll('input[type="range"]')).toHaveLength(2);
    expect(mounted.text()).toContain("首次点击页面后开始播放");
    await mounted.click("关闭声音设置");
    expect(onClose).toHaveBeenCalledTimes(1);

    const panel = mounted.container.querySelector(".audio-panel")!;
    await act(async () => {
      panel.dispatchEvent({
        type: "keydown",
        key: "Escape",
        bubbles: true,
        preventDefault(): void {},
        stopPropagation(): void {},
      } as never);
    });
    expect(onClose).toHaveBeenCalledTimes(2);

    const overlay = mounted.container.querySelector(".audio-overlay");
    expect(overlay).not.toBeNull();
    await mounted.clickElement(overlay!);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("D1 对局顶栏有声音按钮并调用入口", async () => {
    const onOpenAudio = vi.fn();
    const client = fakeClient();
    mounted = await mountDom(createElement(GameView, gameProps(client, viewFixture(), onOpenAudio)));
    const buttons = mounted.container.querySelectorAll('button[aria-label="声音设置"]');
    expect(buttons).toHaveLength(1);
    await mounted.clickElement(buttons[0]!);
    expect(onOpenAudio).toHaveBeenCalledTimes(1);
  });

  it("D1 大厅入口有声音按钮并调用入口", async () => {
    const onOpenAudio = vi.fn();
    mounted = await mountDom(createElement(LobbyView, {
      room, joined, error: null, onReady: vi.fn(), onStart: vi.fn(), onOpenAudio,
    }));
    const buttons = mounted.container.querySelectorAll('button[aria-label="声音设置"]');
    expect(buttons).toHaveLength(1);
    await mounted.clickElement(buttons[0]!);
    expect(onOpenAudio).toHaveBeenCalledTimes(1);
  });

  it("D2 unavailable 文案与两个滑杆禁用", async () => {
    const controller = createAudioController({ storage: memoryStorage(), createAudio: () => null });
    controller.unlock();
    expect(controller.isUnavailable()).toBe(true);
    mounted = await mountDom(createElement(AudioPanel, { controller, onClose: vi.fn() }));
    expect(mounted.text()).toContain("当前设备无法播放声音，不影响游戏");
    const ranges = mounted.container.querySelectorAll('input[type="range"]');
    expect(ranges).toHaveLength(2);
    expect(ranges.every((range) => range.disabled)).toBe(true);
  });

  it("D3 入口页/对局/大厅都接入了 AudioButton，且 App 不自动播放", () => {
    expect(APP_SOURCE).toContain("<AudioButton");
    expect(APP_SOURCE).toContain("onOpenAudio");
    expect(APP_SOURCE).toContain("<AudioPanel");
    expect(APP_SOURCE).toContain('window.addEventListener("pointerdown"');
    expect(APP_SOURCE).toContain('window.addEventListener("keydown"');
    expect(APP_SOURCE).toContain('window.addEventListener("pagehide"');
    expect(APP_SOURCE).toContain("collectNewSfx");
    expect(APP_SOURCE).toContain("useRef<Set<number>>(new Set())");
    expect(APP_SOURCE).toContain("playedSfxSeqRef.current.clear()");
    expect(APP_SOURCE).not.toContain("audio.dispose(), [audio]");
    expect(APP_SOURCE).not.toContain("audio.unlock();\n  }, [])");
  });
});
