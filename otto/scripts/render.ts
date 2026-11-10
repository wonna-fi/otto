// Render the final video from a recording: cut page loads and TTS waits, mix the narration at its
// (cut-adjusted) times, encode H.264/AAC with chapters.
//
//   node otto/scripts/render.ts videos/PROJ-101
//
// Reads <dir>/work/{capture.mp4,timeline.json}. Writes <dir>/video.mp4, captions.vtt, chapters.vtt,
// chapters.md, poster.jpg and summary.json.
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fmtTime, keepSegments, mapTime, type Timeline } from './lib/timeline.ts';

const RATE = 48000;

function ffmpeg(args: string[]) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr?.slice(-800)}`);
  return r;
}

/** Read the PCM samples of a 16-bit mono WAV (walks the RIFF chunks to find "data"). */
function readWav(path: string): Int16Array {
  const buf = readFileSync(path);
  let p = 12;
  while (p + 8 <= buf.length) {
    const id = buf.toString('ascii', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    if (id === 'data') {
      const end = Math.min(buf.length, p + 8 + (size === 0xffffffff ? buf.length : size));
      const bytes = buf.subarray(p + 8, end);
      return new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + (bytes.length & ~1)));
    }
    p += 8 + size + (size & 1);
  }
  throw new Error(`No data chunk in ${path}`);
}

function writeWav(path: string, samples: Int16Array) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + samples.length * 2, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(samples.length * 2, 40);
  writeFileSync(path, Buffer.concat([header, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)]));
}

const vttTime = (ms: number) => {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3600000), m = Math.floor((t % 3600000) / 60000), s = Math.floor((t % 60000) / 1000), x = t % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(x).padStart(3, '0')}`;
};

export type RenderResult = { video: string; durationMs: number; sizeBytes: number; chapters: Array<{ title: string; start: number }> };

export async function render(dir: string, opts: { log?: (s: string) => void; crf?: number } = {}): Promise<RenderResult> {
  const log = opts.log ?? console.log;
  const work = join(dir, 'work');
  const tl: Timeline = JSON.parse(readFileSync(join(work, 'timeline.json'), 'utf8'));
  const capture = join(work, 'capture.mp4');
  if (!existsSync(capture)) throw new Error(`Missing ${capture}`);
  const fps = Number(tl.meta.fps ?? 30);
  const cuts = tl.cuts;
  const keep = keepSegments(cuts, tl.durationMs);
  const outMs = keep.reduce((s, k) => s + k.end - k.start, 0);
  const at = (t: number) => mapTime(t, cuts);

  // Narration track, mixed in Node: every clip is 48 kHz mono s16.
  const mix = new Int32Array(Math.ceil((outMs / 1000) * RATE) + RATE);
  for (const n of tl.narration) {
    if (!n.wav || !existsSync(n.wav)) continue;
    const pcm = readWav(n.wav);
    const start = Math.round((at(n.t) / 1000) * RATE);
    for (let i = 0; i < pcm.length && start + i < mix.length; i++) mix[start + i] += pcm[i];
  }
  const pcm = new Int16Array(mix.length);
  for (let i = 0; i < mix.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, mix[i]));
  writeWav(join(work, 'narration.wav'), pcm);

  // Chapters: intro, one per acceptance criterion, summary.
  const titleCard = tl.events.find((e) => e.type === 'card' && e.kind === 'title');
  const outro = tl.events.find((e) => e.type === 'card' && e.kind === 'outro');
  const lang = String(tl.meta.lang ?? 'en');
  const chapters: Array<{ title: string; start: number }> = [{ title: lang === 'fi' ? 'Johdanto' : 'Introduction', start: 0 }];
  for (const c of tl.chapters) chapters.push({ title: `${c.id}: ${c.title}`, start: at(c.t) });
  if (outro) chapters.push({ title: lang === 'fi' ? 'Yhteenveto' : 'Summary', start: at(outro.t) });
  const meta = [';FFMETADATA1', `title=${tl.meta.key} ${String(tl.meta.title).replace(/[=;#\\\n]/g, ' ')}`];
  chapters.forEach((c, i) => {
    const end = i + 1 < chapters.length ? chapters[i + 1].start : outMs;
    meta.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${Math.round(c.start)}`, `END=${Math.round(end)}`, `title=${c.title.replace(/[=;#\\\n]/g, ' ')}`);
  });
  writeFileSync(join(work, 'chapters.ffmeta'), meta.join('\n') + '\n');

  // Video: keep the segments outside cuts, re-time to a continuous stream.
  const sel = keep.map((k) => `between(t,${(k.start / 1000).toFixed(3)},${(k.end / 1000 - 0.5 / fps).toFixed(3)})`).join('+');
  writeFileSync(join(work, 'video-filter.txt'), `select='${sel}',setpts=N/FRAME_RATE/TB`);
  const video = join(dir, 'video.mp4');
  log(`render: ${keep.length} segments, ${(outMs / 1000).toFixed(1)}s, ${tl.narration.length} narration clips`);
  ffmpeg([
    '-i', capture, '-i', join(work, 'narration.wav'), '-i', join(work, 'chapters.ffmeta'),
    '-filter_script:v', join(work, 'video-filter.txt'),
    '-af', `loudnorm=I=-16:TP=-1.5:LRA=11,apad,atrim=0:${(outMs / 1000).toFixed(3)}`,
    '-map', '0:v', '-map', '1:a', '-map_metadata', '2', '-map_chapters', '2',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', String(opts.crf ?? 22), '-pix_fmt', 'yuv420p', '-r', String(fps),
    '-c:a', 'aac', '-b:a', '128k', '-ar', String(RATE), '-movflags', '+faststart', '-shortest', video,
  ]);

  // Sidecars
  const vtt = ['WEBVTT', ''];
  tl.narration.forEach((n, i) => {
    const s = at(n.t);
    const next = tl.narration[i + 1] ? at(tl.narration[i + 1].t) : Infinity;
    vtt.push(`${i + 1}`, `${vttTime(s)} --> ${vttTime(Math.min(s + n.durationMs + 300, next - 10))}`, n.text, '');
  });
  writeFileSync(join(dir, 'captions.vtt'), vtt.join('\n'));
  const cvtt = ['WEBVTT', ''];
  chapters.forEach((c, i) => cvtt.push(`${i + 1}`, `${vttTime(c.start)} --> ${vttTime(i + 1 < chapters.length ? chapters[i + 1].start : outMs)}`, c.title, ''));
  writeFileSync(join(dir, 'chapters.vtt'), cvtt.join('\n'));
  writeFileSync(join(dir, 'chapters.md'), chapters.map((c) => `- ${fmtTime(c.start)} ${c.title}`).join('\n') + '\n');

  const posterAt = titleCard ? at(titleCard.t) + 1600 : 1000;
  ffmpeg(['-ss', (posterAt / 1000).toFixed(2), '-i', video, '-frames:v', '1', '-q:v', '3', join(dir, 'poster.jpg')]);

  const sizeBytes = statSync(video).size;
  const result: RenderResult = { video: resolve(video), durationMs: outMs, sizeBytes, chapters };
  writeFileSync(join(dir, 'summary.json'), JSON.stringify({ ...result, key: tl.meta.key, title: tl.meta.title, lang, recordedMs: tl.durationMs, cuts: cuts.length }, null, 2));
  log(`video: ${video} (${fmtTime(outMs)}, ${(sizeBytes / 1e6).toFixed(1)} MB)`);
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: node render.ts <video dir>');
    process.exit(1);
  }
  render(resolve(dir)).catch((e) => {
    console.error(`error: ${e.message}`);
    process.exit(1);
  });
}
