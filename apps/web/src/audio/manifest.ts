/**
 * 08C 音频清单。
 *
 * 素材来源声明：全部由 apps/web/scripts/make-audio.mjs 合成，
 * 无第三方采样；随项目仓库分发（与源码同一许可证）。
 * 修改任何一个 WAV 后，必须同步更新 AUDIO_SHA256；audio.test.ts 会逐文件核对。
 */
const BASE = import.meta.env.BASE_URL.endsWith("/") ? import.meta.env.BASE_URL : import.meta.env.BASE_URL + "/";

export type AudioFileName =
  | "bgm-loop.wav"
  | "sfx-tap.wav"
  | "sfx-submit.wav"
  | "sfx-win.wav"
  | "sfx-lose.wav"
  | "sfx-alert.wav";

export const AUDIO_MANIFEST = {
  bgm: BASE + "audio/bgm-loop.wav",
  sfx: {
    tap: BASE + "audio/sfx-tap.wav",
    submit: BASE + "audio/sfx-submit.wav",
    win: BASE + "audio/sfx-win.wav",
    lose: BASE + "audio/sfx-lose.wav",
    alert: BASE + "audio/sfx-alert.wav",
  },
} as const;

export const AUDIO_FILES: readonly AudioFileName[] = [
  "bgm-loop.wav",
  "sfx-tap.wav",
  "sfx-submit.wav",
  "sfx-win.wav",
  "sfx-lose.wav",
  "sfx-alert.wav",
];

/** make-audio.mjs 的确定性输出；改素材必须同时改这里。 */
export const AUDIO_SHA256: Record<AudioFileName, string> = {
  "bgm-loop.wav": "811811013ae823036b41be3d5996c712fbd4e6bf5011b7db5952d19bc02bf3ac",
  "sfx-tap.wav": "a543ab4ae558027b9a81b3421ac83cb24510d3aa4d062295a68887da884ad533",
  "sfx-submit.wav": "b4f5c8e7b50c8d5056c48b543867f9d85f16ac169dba84209285659fd3f2cbe1",
  "sfx-win.wav": "43745cf2f4d9fb9a712869a7fefa11d60130b3a1a6aa8bc25e951c2912a773f4",
  "sfx-lose.wav": "4a893e88b176d019ae9073fbb9897ace01b317b9e97a57af6cbacdf83128427c",
  "sfx-alert.wav": "b932037c836bab543354f5478e4f3d1fb3679068ae3b74c9567eda9e3d0a2d7d",
};

export const AUDIO_BYTES: Record<AudioFileName, number> = {
  "bgm-loop.wav": 352844,
  "sfx-tap.wav": 1367,
  "sfx-submit.wav": 3131,
  "sfx-win.wav": 13274,
  "sfx-lose.wav": 11069,
  "sfx-alert.wav": 9967,
};
