// Self-review of a rendered story video: keyframes + contact sheets to look at, and lint findings.
//
//   node otto/scripts/review.ts videos/PROJ-101
//
// Writes <dir>/review/: frame-NNN.jpg (960 px wide), sheet-NN.jpg (labelled 3x3 grids), review.md.
// Prints findings. Errors mean the video should not be shared yet.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fmtTime, mapTime, type Timeline, type TimelineEvent } from './lib/timeline.ts';
import { PACES, readingMs } from './lib/pacing.ts';
import { SLIP_IN_MS } from './lib/demo.ts';
import { checkHeard } from './lib/heard.ts';
import { looksFinnish } from './lib/storyboard.ts';

type Finding = { level: 'error' | 'warn'; at?: number; msg: string };
const FONT = ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'].find(existsSync);

const ACTIONS = new Set(['click', 'select', 'press', 'type']);
const FRAME_DELAY: Record<string, number> = { click: 200, select: 300, press: 300, type: 600, annotate: 1100, verify: 1100, chapter: 1000, card: 1800, dialog: 900, 'navigation-end': 300, hover: 400 };

function label(e: TimelineEvent): string {
  const sel = e.selector ? String(e.selector).replace(/\[data-testid=([^\]]+)\]/g, '$1') : '';
  switch (e.type) {
    case 'annotate': return `annotate ${e.title || sel}`;
    case 'verify': return `verify ${e.title}`;
    case 'chapter': return `chapter ${e.id}`;
    case 'card': return `${e.kind} card`;
    case 'dialog': return `${e.dialog} dialog`;
    case 'navigation-end': return `page ${e.url ?? ''}`;
    case 'type': return `type "${String(e.text ?? '').slice(0, 24)}"`;
    case 'select': return `select ${e.option}`;
    default: return `${e.type} ${sel}`;
  }
}

export async function review(dir: string, opts: { log?: (s: string) => void } = {}) {
  const log = opts.log ?? console.log;
  const tl: Timeline = JSON.parse(readFileSync(join(dir, 'work', 'timeline.json'), 'utf8'));
  const summary = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
  const video = join(dir, 'video.mp4');
  const at = (t: number) => mapTime(t, tl.cuts);
  const fps = Number(tl.meta.fps ?? 30);
  const findings: Finding[] = [];
  const add = (level: Finding['level'], msg: string, t?: number) => findings.push({ level, msg, at: t });

  // --- pacing: user actions too close together (output time) ---
  const actions = tl.events.filter((e) => ACTIONS.has(e.type) && !(e.type === 'click' && e.select));
  for (let i = 1; i < actions.length; i++) {
    const gap = at(actions[i].t) - at(actions[i - 1].t);
    if (gap < 650 && !(actions[i].type === 'type' && actions[i - 1].type === 'click')) add('warn', `Actions ${gap} ms apart: ${label(actions[i - 1])} -> ${label(actions[i])}`, at(actions[i].t));
  }

  // --- narration: overlap, too fast, language ---
  const narr = tl.narration.map((n) => ({ ...n, s: at(n.t) }));
  for (let i = 1; i < narr.length; i++) {
    const overlap = narr[i - 1].s + narr[i - 1].durationMs - narr[i].s;
    if (overlap > 60) add('error', `Narration overlaps by ${overlap} ms: "${narr[i].text.slice(0, 50)}"`, narr[i].s);
  }
  for (const n of narr) {
    if (n.wav && n.durationMs > 0 && n.text.length > 40 && n.text.length / (n.durationMs / 1000) > 20) add('warn', `Narration very fast (${(n.text.length / (n.durationMs / 1000)).toFixed(0)} chars/s): "${n.text.slice(0, 50)}"`, n.s);
    // The voice model's own transcript only echoes its input, so only an independent transcription counts.
    if (n.wav && n.heardOk === false) add('error', `Voice said something else: heard "${String(n.heard).slice(0, 80)}" for "${String(n.spoken ?? n.text).slice(0, 80)}" (${(n.heardProblems ?? []).join('; ')})`, n.s);
    if (n.wav && n.heardOk && (n.heardMatch ?? 1) < 0.9) add('warn', `Listen to this line: the transcriber heard some words differently (${Math.round((n.heardMatch ?? 0) * 100)}%): "${String(n.heard).slice(0, 80)}"`, n.s);
    if (n.wav && n.heardOk == null) add('warn', `Narration not checked by listening (no transcription model): "${n.text.slice(0, 50)}"`, n.s);
    if (n.text.length > 220) add('warn', `Narration line is long (${n.text.length} chars), the caption gets crowded: "${n.text.slice(0, 50)}…"`, n.s);
  }
  // Digits carry no case, so for these lines the check only confirmed the value. A wrong case would pass unnoticed.
  if (tl.meta.lang === 'fi') {
    const unchecked = narr.filter((n) => n.wav && n.heardOk && n.heard && checkHeard(n.spoken ?? n.text, n.heard, 'fi').caseUnchecked.length);
    if (unchecked.length) add('warn', `The case of a number couldn't be checked in ${unchecked.length} line(s), because the transcriber wrote digits. Listen to: ${unchecked.map((n) => `"${n.text.slice(0, 45)}"`).join(', ')}`, unchecked[0].s);
  }
  const fiLike = narr.filter((n) => looksFinnish(n.text, tl.meta.lang)).length;
  if (narr.length && tl.meta.lang === 'en' && fiLike / narr.length > 0.4) add('error', 'Narration looks Finnish but the video language is en');
  if (narr.length && tl.meta.lang === 'fi' && fiLike / narr.length < 0.4) add('error', 'Narration does not look Finnish but the video language is fi');
  if (!narr.some((n) => n.wav)) add('warn', 'Video has no narration audio (TTS provider none?)');

  // --- annotations: geometry problems reported by the overlay ---
  for (const e of tl.events.filter((x) => x.type === 'annotate')) {
    const info = (e.info ?? {}) as Record<string, any>;
    const name = e.title || e.selector;
    if (info.targetVisible === false) add('error', `Annotated element not on screen: ${name}`, at(e.t));
    if (info.offscreen) add('error', `Callout goes off screen: ${name}`, at(e.t));
    if (info.coversTarget) add('warn', `Callout covers its own element: ${name}`, at(e.t));
    if (info.clamped) add('warn', `Callout had no free side and was squeezed in: ${name}`, at(e.t));
  }

  // --- coverage: acceptance criteria and changed UI ---
  const acs = (tl.meta.acceptance as Array<{ id: string }>) ?? [];
  for (const ac of acs) {
    const ch = tl.chapters.find((c) => c.id === ac.id);
    if (!ch) add('error', `No chapter for ${ac.id}`);
    else if (!ch.verified) add('warn', `${ac.id} has no verify() callout`);
  }
  const anns = tl.events.filter((e) => e.type === 'annotate');
  for (const sel of (tl.meta.changedUi as string[]) ?? []) {
    // Counts when an annotation showed that element (same element, inside or around it).
    if (!anns.some((e) => ((e.covers as string[]) ?? []).includes(sel) || String(e.selector).includes(sel))) add('error', `Changed UI never annotated: ${sel}`);
  }

  // --- every slip stays long enough to read ---
  const pace = PACES[String(tl.meta.pace ?? 'normal')] ?? PACES.normal;
  for (const e of tl.events.filter((x) => x.type === 'annotate' && (x.title || x.text))) {
    const words = `${e.title ?? ''} ${e.text ?? ''}`.trim();
    // A slip leaves when it's removed, when a card covers it, or when a page load wipes it.
    const off = tl.events.find((x) => x.t > e.t && ((x.type === 'annotation-off' && (x.id == null || x.id === e.id)) || x.type === 'card' || x.type === 'navigation-start'));
    const shown = at(off ? off.t : tl.durationMs) - at(e.t) - SLIP_IN_MS;
    const need = readingMs(pace, words);
    if (shown < need * 0.7) add('error', `Slip too short to read: "${words.slice(0, 50)}" is readable for ${(shown / 1000).toFixed(1)} s and needs ${(need / 1000).toFixed(1)} s`, at(e.t));
    else if (shown < need) add('warn', `Slip on the short side: "${words.slice(0, 50)}" is readable for ${(shown / 1000).toFixed(1)} s, reading time ${(need / 1000).toFixed(1)} s`, at(e.t));
  }

  // --- dead air: long stretches with nothing happening ---
  // Activity intervals: narration while it plays, actions and callouts briefly, cards while shown.
  const spans: Array<[number, number]> = narr.map((n) => [n.s, n.s + n.durationMs]);
  for (const e of tl.events) {
    if (['hold', 'cursor'].includes(e.type)) continue;
    const s0 = at(e.t);
    spans.push([s0, s0 + (e.type === 'annotate' || e.type === 'verify' || e.type === 'card' ? 2500 : 600)]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  let reach = spans.length ? spans[0][1] : 0;
  for (const [a0, a1] of spans) {
    if (a0 - reach > 5000) add('warn', `${((a0 - reach) / 1000).toFixed(1)} s with nothing happening`, reach);
    reach = Math.max(reach, a1);
  }

  // --- page loads must be cut ---
  for (const e of tl.events.filter((x) => x.type === 'navigation-start')) {
    if (!tl.cuts.some((c) => c.reason.includes('load') && c.start >= e.t - 50 && c.start <= e.t + 1200)) add('warn', 'Page load not cut (may show blank or loading frames)', at(e.t));
  }
  for (const w of ((tl.meta as any).warnings ?? []) as string[]) add('warn', w);

  // --- size ---
  const mb = statSync(video).size / 1e6;
  const minutes = summary.durationMs / 60000;
  if (mb / Math.max(minutes, 0.5) > 9) add('warn', `Large file: ${mb.toFixed(1)} MB for ${fmtTime(summary.durationMs)}`);

  // --- keyframes ---
  const rdir = join(dir, 'review');
  if (existsSync(rdir)) rmSync(rdir, { recursive: true });
  mkdirSync(rdir, { recursive: true });
  const shots = tl.events
    .filter((e) => FRAME_DELAY[e.type] != null && !(e.type === 'click' && e.select))
    .map((e) => ({ e, t: Math.min(summary.durationMs - 100, at(e.t) + FRAME_DELAY[e.type]) }))
    .filter((s, i, arr) => i === 0 || s.t - arr[i - 1].t > 250);
  if (shots.length) {
    const frames = shots.map((s) => Math.round((s.t / 1000) * fps));
    const expr = frames.map((f) => `eq(n\\,${f})`).join('+');
    const draw = FONT
      ? `,drawtext=fontfile=${FONT}:text='%{eif\\:n+1\\:d}':x=12:y=10:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=6`
      : '';
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', video, '-vf', `select='${expr}',scale=960:-2${draw}`, '-fps_mode', 'vfr', '-q:v', '4', join(rdir, 'frame-%03d.jpg')], { encoding: 'utf8' });
    if (r.status !== 0) add('warn', `Keyframe extraction failed: ${r.stderr?.slice(-200)}`);
    const n = readdirSync(rdir).filter((f) => f.startsWith('frame-')).length;
    if (n) spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', join(rdir, 'frame-%03d.jpg'), '-vf', 'scale=640:-2,tile=3x3:padding=6:color=white', join(rdir, 'sheet-%02d.jpg')]);
  }

  const errors = findings.filter((f) => f.level === 'error').length;
  const warns = findings.length - errors;
  const md = [
    `# Review: ${tl.meta.key} ${tl.meta.title}`,
    '',
    `Video ${fmtTime(summary.durationMs)}, ${mb.toFixed(1)} MB, language ${tl.meta.lang}, ${narr.length} narration lines, ${tl.chapters.length} chapters. ${errors} errors, ${warns} warnings.`,
    '',
    '## Findings',
    '',
    ...(findings.length ? findings.map((f) => `- **${f.level}**${f.at != null ? ` @${fmtTime(f.at)}` : ''}: ${f.msg}`) : ['- none']),
    '',
    '## Keyframes',
    '',
    '| # | time | event |',
    '|---|---|---|',
    ...shots.map((s, i) => `| ${i + 1} | ${fmtTime(s.t)} | ${label(s.e).replace(/\|/g, '/')} |`),
    '',
    'Frames: `review/frame-NNN.jpg`, contact sheets: `review/sheet-NN.jpg` (frame number in the corner).',
  ];
  writeFileSync(join(rdir, 'review.md'), md.join('\n'));
  log(`review: ${errors} errors, ${warns} warnings -> ${join(rdir, 'review.md')}`);
  for (const f of findings) log(`  ${f.level === 'error' ? 'E' : 'w'} ${f.at != null ? fmtTime(f.at).padStart(5) : '     '} ${f.msg}`);
  return { errors, warnings: warns, findings };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: node review.ts <video dir>');
    process.exit(1);
  }
  review(resolve(dir)).then((r) => process.exit(r.errors ? 2 : 0)).catch((e) => {
    console.error(`error: ${e.message}`);
    process.exit(1);
  });
}
