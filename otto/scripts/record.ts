// Record a story video from a storyboard.
//
//   node otto/scripts/record.ts videos/PROJ-101/storyboard.ts --dry      # fast check: selectors, flow, narration lines
//   node otto/scripts/record.ts videos/PROJ-101/storyboard.ts            # record + render + review
//
// Options: --lang fi|en (force narration language)  --pace calm|normal|brisk  --port 9333
//          --out <dir> (default: storyboard dir)  --fps 30  --no-render  --keep-tab
// Exit codes: 0 ok, 1 failed (message says which step), 2 recorded but review found errors.
import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { connectBrowser } from './lib/cdp.ts';
import { loadEnv, toolkitDir } from './lib/env.ts';
import { PageSession } from './lib/session.ts';
import { overlaySource } from './lib/overlay-source.ts';
import { FastDriver } from './lib/fast-driver.ts';
import { Demo } from './lib/demo.ts';
import { Capture } from './lib/capture.ts';
import { Tts, type Lang } from './lib/tts.ts';
import { PACES } from './lib/pacing.ts';
import { mergeCuts, type Timeline } from './lib/timeline.ts';
import { detectLanguage, pick, type StoryboardDef } from './lib/storyboard.ts';
import { render } from './render.ts';
import { review } from './review.ts';

loadEnv();

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    dry: { type: 'boolean', default: false },
    lang: { type: 'string' },
    pace: { type: 'string' },
    port: { type: 'string', default: process.env.CDP_PORT ?? '9333' },
    out: { type: 'string' },
    fps: { type: 'string', default: '30' },
    'no-render': { type: 'boolean', default: false },
    'keep-tab': { type: 'boolean', default: false },
  },
});

if (!positionals[0]) {
  console.error('usage: node record.ts <storyboard.ts> [--dry] [--lang fi|en] [--pace calm|normal|brisk] [--port N] [--out DIR]');
  process.exit(1);
}

const sbPath = resolve(positionals[0]);
const def: StoryboardDef = (await import(pathToFileURL(sbPath).href)).default;
if (!def?.scenes) throw new Error(`${sbPath} must default-export storyboard({...})`);

const lang: Lang = (o.lang as Lang) ?? (def.lang && def.lang !== 'auto' ? def.lang : detectLanguage(def.story));
const paceName = o.pace ?? def.pace ?? 'normal';
const pace = PACES[paceName];
if (!pace) throw new Error(`Unknown pace ${paceName}`);
const viewport = def.viewport ?? { width: 1600, height: 900, dpr: 1.2 };
const baseUrl = def.baseUrl ?? process.env.APP_URL ?? 'http://localhost:3000';
const outDir = resolve(o.out ?? dirname(sbPath));
const workDir = join(outDir, 'work');
mkdirSync(workDir, { recursive: true });
const fps = Number(o.fps);
const mode = o.dry ? 'dry' : 'record';

function git(args: string[], cwd: string) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}
const repoDir = def.repo ? resolve(dirname(sbPath), def.repo) : '';
const branch = repoDir ? git(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir) : '';
const sha = repoDir ? git(['rev-parse', '--short', 'HEAD'], repoDir) : '';
const today = new Date().toLocaleDateString(lang === 'fi' ? 'fi-FI' : 'en-GB');
const footer = [def.story.app, branch && `${branch}${sha ? ` @ ${sha}` : ''}`, today].filter(Boolean).join('  ·  ');

const log = (s: string) => console.log(s);
log(`otto ${mode}: ${def.story.key} "${pick(def.story.title, lang)}" lang=${lang} pace=${paceName} ${viewport.width}x${viewport.height}@${viewport.dpr}`);

const tts = new Tts(process.env.OTTO_CACHE_DIR ?? join(toolkitDir, '.cache'));
const timeline: Timeline = {
  meta: {
    key: def.story.key, title: pick(def.story.title, lang), lang, pace: paceName, viewport, fps, baseUrl, branch, sha,
    storyboard: sbPath, recordedAt: new Date().toISOString(), tts: { provider: tts.provider, model: tts.model, voice: tts.voiceFor(lang).voice },
    acceptance: def.story.acceptance.map((a) => ({ id: a.id, text: pick(a.text, lang) })), changedUi: def.story.changedUi ?? [],
  },
  durationMs: 0, events: [], cuts: [], narration: [], chapters: [],
};

const cdp = await connectBrowser(Number(o.port));
const overlayJs = overlaySource();
const session = await PageSession.open(cdp, { baseUrl, viewport, overlaySource: overlayJs, ignoreRequests: def.ignoreRequests });
for (const n of session.startupNotes) log(`  note: ${n}`);
let capture: Capture | null = null;
let exitCode = 0;
const inputNotes = () => [
  ...session.recoveredKeys.map((k) => `The key ${k.key} did not reach the page and was sent again`),
  ...session.fixedFields.map((f) => `Typing into ${f} left the wrong text in it, so the field was corrected from inside the page`),
];

try {
  if (def.reset) {
    log('reset');
    await def.reset();
  }
  if (def.setup) {
    log('setup (off camera)');
    await def.setup(new FastDriver(session));
    await session.settle(300, 8000);
  }

  if (mode === 'dry') {
    const demo = new Demo({ mode, session, pace, lang, tts, capture: null, timeline, story: def.story, footer, log });
    const t = Date.now();
    log('scenes (dry)');
    await def.scenes(demo);
    writeFileSync(join(workDir, 'narration.json'), JSON.stringify({ lang, lines: demo.lines }, null, 2));
    writeFileSync(join(workDir, 'dry-timeline.json'), JSON.stringify(timeline, null, 2));
    const speech = demo.lines.reduce((s, l) => s + Tts.estimateMs(l.text, l.lang), 0);
    const anns = timeline.events.filter((e) => e.type === 'annotate');
    const missingUi = (def.story.changedUi ?? []).filter((sel) => !anns.some((e) => ((e.covers as string[]) ?? []).includes(sel) || String(e.selector).includes(sel)));
    const chapters = new Set(timeline.chapters.map((c) => c.id));
    const missingAc = def.story.acceptance.filter((a) => !chapters.has(a.id)).map((a) => a.id);
    const unverified = timeline.chapters.filter((c) => !timeline.events.some((e) => e.type === 'verify' && e.chapter === c.id)).map((c) => c.id);
    log(`\ndry run OK in ${((Date.now() - t) / 1000).toFixed(1)}s: ${timeline.events.length} events, ${demo.lines.length} narration lines (~${Math.round(speech / 1000)}s of speech), ${chapters.size} chapters`);
    if (missingAc.length) log(`  ! no chapter for: ${missingAc.join(', ')}`);
    if (unverified.length) log(`  ! chapters without verify(): ${unverified.join(', ')}`);
    if (missingUi.length) log(`  ! changed UI never annotated: ${missingUi.join(', ')}`);
    for (const n of session.clickNotes()) log(`  note: ${n}`);
    for (const n of inputNotes()) log(`  note: ${n}`);
    if (tts.provider === 'none') log('  note: TTS_PROVIDER=none (no OPENAI_API_KEY / AZURE_TTS_*): the real run will be silent with estimated timing');
  } else {
    // Prefetch narration from the last dry run so recording never waits on the TTS API.
    const narr = join(workDir, 'narration.json');
    if (existsSync(narr) && tts.provider !== 'none') {
      const { lines } = JSON.parse(readFileSync(narr, 'utf8'));
      const n = await tts.prefetch(lines.filter((l: { lang: string }) => l.lang === lang));
      if (n) log(`synthesized or checked ${n} narration lines (${tts.provider}, listening check: ${tts.asrModel ?? 'off'})`);
    }
    capture = new Capture(session, { fps, width: Math.round(viewport.width * viewport.dpr), height: Math.round(viewport.height * viewport.dpr) });
    await capture.start(join(workDir, 'capture.mp4'));
    const demo = new Demo({ mode, session, pace, lang, tts, capture, timeline, story: def.story, footer, log });
    log('scenes (recording)');
    await demo.begin();
    await def.scenes(demo);
    await demo.end();
    const { durationMs, frames } = await capture.stop();
    capture = null;
    timeline.durationMs = durationMs;
    timeline.cuts = mergeCuts(timeline.cuts);
    for (const n of tts.asrNotes) log(`  note: ${n}`);
    (timeline.meta as any).warnings = [...demo.warnings, ...session.startupNotes, ...tts.asrNotes, ...inputNotes(), ...session.clickNotes()];
    writeFileSync(join(workDir, 'timeline.json'), JSON.stringify(timeline, null, 2));
    const cut = timeline.cuts.reduce((s, c) => s + c.end - c.start, 0);
    log(`\nrecorded ${(durationMs / 1000).toFixed(1)}s (${frames} frames), ${(cut / 1000).toFixed(1)}s cut, ${tts.calls} TTS calls, ${tts.asrCalls} listening checks (${tts.asrModel ?? 'off'})`);
    for (const m of tts.mismatches) log(`  ! voice still said something else after retries: heard "${m.transcript.slice(0, 80)}" for "${m.text.slice(0, 80)}"`);
    for (const t of tts.slowLines) log(`  ! every take of this line came out slow, so the best one was kept: "${t.slice(0, 80)}"`);
    if (!o['no-render']) {
      await render(outDir, { log });
      const r = await review(outDir, { log });
      if (r.errors) exitCode = 2;
    }
  }
} catch (e) {
  exitCode = 1;
  console.error(`\nerror: ${(e as Error).message}`);
  for (const p of session.signInProblems) console.error(`browser sign-in: ${p}`);
  try {
    await session.send('Page.captureScreenshot', { format: 'png' }).then(({ data }) => {
      writeFileSync(join(workDir, 'failure.png'), Buffer.from(data, 'base64'));
      console.error(`screenshot of the failure: ${join(workDir, 'failure.png')}`);
    });
  } catch {}
  if (capture) await capture.stop().catch(() => {});
} finally {
  if (!o['keep-tab']) await session.close();
  cdp.close();
}
process.exit(exitCode);
