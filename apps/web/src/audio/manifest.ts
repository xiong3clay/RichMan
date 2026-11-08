/**
 * 音频清单。
 *
 * BGM：3 首外部曲目，来自 incompetech.com（Kevin MacLeod），CC BY 4.0，
 * 轮播顺序固定；版权与署名见同目录 CREDITS.txt，替换时必须同步更新这里与 CREDITS。
 * SFX：全部由 apps/web/scripts/make-audio.mjs 合成，无第三方采样。
 * 修改任何一个 SFX WAV 后，必须同步更新 AUDIO_SHA256；audio.test.ts 会逐文件核对。
 */
const BASE = import.meta.env.BASE_URL.endsWith("/") ? import.meta.env.BASE_URL : import.meta.env.BASE_URL + "/";

export type AudioFileName =
  | "sfx-tap.wav"
  | "sfx-submit.wav"
  | "sfx-win.wav"
  | "sfx-lose.wav"
  | "sfx-alert.wav";

export type BgmTrack = {
  readonly file: string;
  readonly title: string;
  readonly author: string;
  readonly license: string;
  readonly sourceUrl: string;
};

/** 轮播顺序：轻快滑稽 → 鬼畜循环 → 轻松俏皮。 */
export const BGM_TRACKS: readonly BgmTrack[] = [
  {
    file: "bgm-funny-1.mp3",
    title: "Fluffing a Duck",
    author: "Kevin MacLeod",
    license: "CC BY 4.0",
    sourceUrl: "https://incompetech.com/music/royalty-free/mp3-royaltyfree/Fluffing%20a%20Duck.mp3",
  },
  {
    file: "bgm-funny-2.mp3",
    title: "Monkeys Spinning Monkeys",
    author: "Kevin MacLeod",
    license: "CC BY 4.0",
    sourceUrl: "https://incompetech.com/music/royalty-free/mp3-royaltyfree/Monkeys%20Spinning%20Monkeys.mp3",
  },
  {
    file: "bgm-funny-3.mp3",
    title: "Silly Fun",
    author: "Kevin MacLeod",
    license: "CC BY 4.0",
    sourceUrl: "https://incompetech.com/music/royalty-free/mp3-royaltyfree/Silly%20Fun.mp3",
  },
];

export const AUDIO_MANIFEST = {
  bgmTracks: BGM_TRACKS.map((track) => BASE + "audio/" + track.file),
  sfx: {
    tap: BASE + "audio/sfx-tap.wav",
    submit: BASE + "audio/sfx-submit.wav",
    win: BASE + "audio/sfx-win.wav",
    lose: BASE + "audio/sfx-lose.wav",
    alert: BASE + "audio/sfx-alert.wav",
  },
} as const;

export const AUDIO_FILES: readonly AudioFileName[] = [
  "sfx-tap.wav",
  "sfx-submit.wav",
  "sfx-win.wav",
  "sfx-lose.wav",
  "sfx-alert.wav",
];

/** make-audio.mjs 的确定性输出；改素材必须同时改这里。 */
export const AUDIO_SHA256: Record<AudioFileName, string> = {
  "sfx-tap.wav": "a543ab4ae558027b9a81b3421ac83cb24510d3aa4d062295a68887da884ad533",
  "sfx-submit.wav": "b4f5c8e7b50c8d5056c48b543867f9d85f16ac169dba84209285659fd3f2cbe1",
  "sfx-win.wav": "43745cf2f4d9fb9a712869a7fefa11d60130b3a1a6aa8bc25e951c2912a773f4",
  "sfx-lose.wav": "4a893e88b176d019ae9073fbb9897ace01b317b9e97a57af6cbacdf83128427c",
  "sfx-alert.wav": "b932037c836bab543354f5478e4f3d1fb3679068ae3b74c9567eda9e3d0a2d7d",
};

export const AUDIO_BYTES: Record<AudioFileName, number> = {
  "sfx-tap.wav": 1367,
  "sfx-submit.wav": 3131,
  "sfx-win.wav": 13274,
  "sfx-lose.wav": 11069,
  "sfx-alert.wav": 9967,
};
