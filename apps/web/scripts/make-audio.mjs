/**
 * 08C 自制音频生成器：零依赖、确定性、可重复运行。
 * 输出 apps/web/public/audio/*.wav：22050Hz / 8-bit unsigned / 单声道 / 44 字节头。
 *
 * 用法：node apps/web/scripts/make-audio.mjs
 * 重跑必须字节与 sha256 完全一致（无随机数、无时间戳、无外部采样）。
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, "../public/audio");
const SAMPLE_RATE = 22050;
const ATTACK_SECONDS = 0.005;
const RELEASE_SECONDS = 0.030;
const MAX_AMPLITUDE = 100;

const C4 = 261.63;
const G4 = 392.0;
const A4 = 440.0;
const F4 = 349.23;
const C3 = 130.81;
const G3 = 196.0;
const A3 = 220.0;
const F3 = 174.61;

const CHORDS = [
  { melody: [C4, 329.63, 392.0, C4], bass: C3 },
  { melody: [G4, 493.88, 587.33, G4], bass: G3 },
  { melody: [A4, 523.25, 659.25, A4], bass: A3 },
  { melody: [F4, 440.0, 523.25, F4], bass: F3 },
];

/** 25% 或 50% 占空比方波；相位从 0 开始。 */
function square(time, frequency, duty) {
  const phase = (time * frequency) % 1;
  return phase < duty ? 1 : -1;
}

/** 5ms 起音 / 30ms 释放的线性包络，保证音头音尾回到 0（无直流）。 */
function envelope(index, length) {
  const attack = Math.max(1, Math.round(ATTACK_SECONDS * SAMPLE_RATE));
  const release = Math.max(1, Math.round(RELEASE_SECONDS * SAMPLE_RATE));
  const attackGain = Math.min(1, index / attack);
  const releaseGain = Math.min(1, (length - 1 - index) / release);
  return Math.max(0, Math.min(attackGain, releaseGain));
}

function addNote(buffer, startSample, lengthSamples, frequency, amplitude, duty = 0.25) {
  // 25% 方波均值 = 2*duty-1 = -0.5；逐样本减掉直流，避免整轨偏置。
  // 补偿后正向峰值变为 1.5 倍，调用方已同步下调振幅，峰值仍 ≤100。
  const dc = 2 * duty - 1;
  for (let index = 0; index < lengthSamples; index += 1) {
    const target = startSample + index;
    if (target >= buffer.length) break;
    const time = index / SAMPLE_RATE;
    buffer[target] += (square(time, frequency, duty) - dc) * amplitude * envelope(index, lengthSamples);
  }
}

/** 每拍短噪声脉冲：固定高频交替，不使用随机数。 */
function addShaker(buffer, startSample, lengthSamples, amplitude) {
  for (let index = 0; index < lengthSamples; index += 1) {
    const target = startSample + index;
    if (target >= buffer.length) break;
    const decay = 1 - index / lengthSamples;
    const sign = index % 2 === 0 ? 1 : -1;
    buffer[target] += sign * amplitude * decay;
  }
}

function renderBgm() {
  const seconds = 16;
  const length = Math.round(seconds * SAMPLE_RATE);
  const buffer = new Float64Array(length);
  const beatSamples = Math.round(0.5 * SAMPLE_RATE);
  const beatCount = Math.round(seconds / 0.5);
  for (let beat = 0; beat < beatCount; beat += 1) {
    const chord = CHORDS[Math.floor(beat / 4) % CHORDS.length];
    const beatInChord = beat % 4;
    const start = beat * beatSamples;
    addNote(buffer, start, beatSamples, chord.melody[beatInChord], 30, 0.25);
    addNote(buffer, start, beatSamples, chord.bass, 20, 0.5);
    addShaker(buffer, start, Math.round(0.030 * SAMPLE_RATE), 6);
  }
  // 起音 5ms 淡入 + 末音 50ms 淡出，保证循环两端都接近 0。
  const fadeInSamples = Math.round(0.005 * SAMPLE_RATE);
  for (let index = 0; index < fadeInSamples; index += 1) {
    buffer[index] *= index / fadeInSamples;
  }
  const fadeSamples = Math.round(0.050 * SAMPLE_RATE);
  for (let index = 0; index < fadeSamples; index += 1) {
    const target = length - fadeSamples + index;
    buffer[target] *= 1 - index / fadeSamples;
  }
  return { buffer, seconds };
}

function renderSfx(seconds, segments) {
  const length = Math.round(seconds * SAMPLE_RATE);
  const buffer = new Float64Array(length);
  const totalBeats = segments.reduce((sum, segment) => sum + segment.weight, 0);
  let cursor = 0;
  for (const segment of segments) {
    const segmentSamples = Math.round(length * segment.weight / totalBeats);
    addNote(buffer, cursor, segmentSamples, segment.frequency, segment.amplitude ?? 70, segment.duty ?? 0.5);
    cursor += segmentSamples;
  }
  return { buffer, seconds };
}

function encodeWav(buffer) {
  const data = Buffer.alloc(buffer.length);
  for (let index = 0; index < buffer.length; index += 1) {
    const value = Math.round(buffer[index]);
    const clamped = Math.max(-MAX_AMPLITUDE, Math.min(MAX_AMPLITUDE, value));
    data[index] = 128 + clamped;
  }
  const header = Buffer.alloc(44);
  const dataLength = data.length;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataLength, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataLength, 40);
  return Buffer.concat([header, data]);
}

const FILES = [
  { name: "bgm-loop.wav", seconds: 16, render: renderBgm },
  {
    name: "sfx-tap.wav",
    seconds: 0.06,
    render: () => renderSfx(0.06, [{ frequency: 880, weight: 1 }]),
  },
  {
    name: "sfx-submit.wav",
    seconds: 0.14,
    render: () => renderSfx(0.14, [{ frequency: 660, weight: 1 }, { frequency: 880, weight: 1 }]),
  },
  {
    name: "sfx-win.wav",
    seconds: 0.60,
    render: () => renderSfx(0.60, [
      { frequency: 523, weight: 1 },
      { frequency: 659, weight: 1 },
      { frequency: 784, weight: 1 },
      { frequency: 1047, weight: 1 },
    ]),
  },
  {
    name: "sfx-lose.wav",
    seconds: 0.50,
    render: () => renderSfx(0.50, [
      { frequency: 784, weight: 1 },
      { frequency: 659, weight: 1 },
      { frequency: 523, weight: 1 },
    ]),
  },
  {
    name: "sfx-alert.wav",
    seconds: 0.45,
    render: () => renderSfx(0.45, [
      { frequency: 440, weight: 1 },
      { frequency: 330, weight: 1 },
      { frequency: 440, weight: 1 },
      { frequency: 330, weight: 1 },
    ]),
  },
];

function inspectPcm(wav) {
  let sum = 0;
  let peak = 0;
  for (let index = 44; index < wav.length; index += 1) {
    const value = wav[index] - 128;
    sum += value;
    peak = Math.max(peak, Math.abs(value));
  }
  const samples = wav.length - 44;
  return {
    mean: samples === 0 ? 0 : sum / samples,
    peak,
    first: wav[44] ?? 128,
    last: wav[wav.length - 1] ?? 128,
  };
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  for (const file of FILES) {
    const { buffer } = file.render();
    const wav = encodeWav(buffer);
    const stats = inspectPcm(wav);
    if (Math.abs(stats.mean) > 2 || stats.peak > 100
      || Math.abs(stats.first - 128) > 3 || Math.abs(stats.last - 128) > 3) {
      throw new Error(`${file.name} 音频硬指标失败：${JSON.stringify(stats)}`);
    }
    const target = path.join(OUT, file.name);
    fs.writeFileSync(target, wav);
    const sha256 = createHash("sha256").update(wav).digest("hex");
    console.log(
      `${file.name} duration=${file.seconds.toFixed(3)}s bytes=${wav.length}`
      + ` mean=${stats.mean.toFixed(3)} peak=${stats.peak} first=${stats.first} last=${stats.last}`
      + ` sha256=${sha256}`,
    );
  }
}

main();
