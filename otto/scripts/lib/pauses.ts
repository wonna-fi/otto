// Long pauses inside a narration line make it sound slow, and a voice model now and then leaves one after a heading
// or between the names in a list. This shortens every quiet stretch inside a clip to at most maxMs, by cutting out
// its middle with a short crossfade. The words stay as they are, so the listening check still holds.
import { readFileSync, writeFileSync } from 'node:fs';

/** Quieter than this (RMS over 10 ms) counts as a pause. Speech sits far above it, room tone and silence below. */
const QUIET_DB = -45;
const FRAME_MS = 10;
const FADE_MS = 10;

type Wav = { rate: number; channels: number; samples: Int16Array; fmt: Buffer };

function readWav(buf: Buffer): Wav {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let off = 12;
  let fmt: Buffer | null = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = buf.subarray(off + 8, off + 8 + size);
    if (id === 'fmt ') fmt = Buffer.from(body);
    if (id === 'data') {
      if (!fmt) break;
      const format = fmt.readUInt16LE(0), channels = fmt.readUInt16LE(2), rate = fmt.readUInt32LE(4), bits = fmt.readUInt16LE(14);
      if (format !== 1 || bits !== 16) throw new Error('only 16-bit PCM WAV is supported');
      const samples = new Int16Array(body.length / 2);
      for (let i = 0; i < samples.length; i++) samples[i] = body.readInt16LE(i * 2);
      return { rate, channels, samples, fmt };
    }
    off += 8 + size + (size & 1);
  }
  throw new Error('WAV file without fmt or data');
}

function writeWav(w: Wav): Buffer {
  const data = Buffer.alloc(w.samples.length * 2);
  for (let i = 0; i < w.samples.length; i++) data.writeInt16LE(w.samples[i], i * 2);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0); head.writeUInt32LE(4 + 8 + w.fmt.length + 8 + data.length, 4); head.write('WAVE', 8);
  const fmtHead = Buffer.alloc(8); fmtHead.write('fmt ', 0); fmtHead.writeUInt32LE(w.fmt.length, 4);
  const dataHead = Buffer.alloc(8); dataHead.write('data', 0); dataHead.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, fmtHead, w.fmt, dataHead, data]);
}

/** Shorten pauses inside the samples (mono or interleaved) to maxMs. Pauses at the very start and end are left alone. */
export function capPauseSamples(samples: Int16Array, rate: number, channels: number, maxMs: number): { samples: Int16Array; removedMs: number } {
  const frame = Math.round((rate * FRAME_MS) / 1000) * channels;
  const frames = Math.floor(samples.length / frame);
  const quiet: boolean[] = [];
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = f * frame; i < (f + 1) * frame; i++) sum += (samples[i] / 32768) ** 2;
    quiet.push(10 * Math.log10(sum / frame + 1e-12) < QUIET_DB);
  }
  const firstLoud = quiet.indexOf(false);
  const lastLoud = quiet.lastIndexOf(false);
  if (firstLoud < 0) return { samples, removedMs: 0 };
  const maxFrames = Math.round(maxMs / FRAME_MS);
  // Cuts as [start, end) sample ranges, each the middle of a pause that runs longer than maxMs.
  const cuts: Array<[number, number]> = [];
  for (let f = firstLoud; f <= lastLoud; f++) {
    if (!quiet[f]) continue;
    let end = f;
    while (end <= lastLoud && quiet[end]) end++;
    const len = end - f;
    if (len > maxFrames) {
      const keepHead = Math.floor(maxFrames / 2);
      cuts.push([(f + keepHead) * frame, (end - (maxFrames - keepHead)) * frame]);
    }
    f = end;
  }
  if (!cuts.length) return { samples, removedMs: 0 };
  const fade = Math.round((rate * FADE_MS) / 1000) * channels;
  const parts: Int16Array[] = [];
  let pos = 0;
  for (const [a, b] of cuts) {
    parts.push(samples.subarray(pos, a));
    // Crossfade the last bit before the cut into the first bit after it, so the joint makes no click.
    const mix = new Int16Array(fade);
    for (let i = 0; i < fade; i++) {
      const t = i / fade;
      mix[i] = Math.round((samples[a + i] ?? 0) * (1 - t) + (samples[b + i] ?? 0) * t);
    }
    parts.push(mix);
    pos = b + fade;
  }
  parts.push(samples.subarray(pos));
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return { samples: out, removedMs: Math.round(((samples.length - out.length) / channels / rate) * 1000) };
}

/** Shorten the pauses inside a WAV file in place. Returns the new length and how much was taken out. */
export function capPauses(wavPath: string, maxMs: number): { durationMs: number; removedMs: number } {
  const wav = readWav(readFileSync(wavPath));
  const r = capPauseSamples(wav.samples, wav.rate, wav.channels, maxMs);
  if (r.removedMs > 0) writeFileSync(wavPath, writeWav({ ...wav, samples: r.samples }));
  return { durationMs: Math.round((r.samples.length / wav.channels / wav.rate) * 1000), removedMs: r.removedMs };
}
