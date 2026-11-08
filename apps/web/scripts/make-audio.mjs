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
