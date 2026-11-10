// A slow app must not make a slow video: long waits are cut, keeping how they start and end.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Demo } from '../scripts/lib/demo.ts';
import { PACES } from '../scripts/lib/pacing.ts';
import { Tts } from '../scripts/lib/tts.ts';
import type { Timeline } from '../scripts/lib/timeline.ts';
import type { PageSession } from '../scripts/lib/session.ts';
import { tempDir, openSession, serve, sleep, startChrome, type TestChrome, type TestServer } from './helpers.ts';

const PAGE = `<!doctype html><body style="margin:40px">
<button id="slow" style="width:200px;height:50px" onclick="fetch('/slow').then(()=>{out.textContent='done'})">slow</button>
<button id="quick" style="width:200px;height:50px" onclick="fetch('/quick').then(()=>{out.textContent='done'})">quick</button>
<div id="out"></div>`;

let chrome: TestChrome;
let server: TestServer;
let s: PageSession;

function newDemo() {
  const timeline: Timeline = { meta: {} as Timeline['meta'], durationMs: 0, events: [], cuts: [], narration: [], chapters: [] };
  process.env.TTS_PROVIDER = 'none';
  const demo = new Demo({
    mode: 'record', session: s, pace: PACES.brisk, lang: 'en', tts: new Tts(tempDir('tts')), capture: null, timeline,
    story: { key: 'T-1', title: 'Test', acceptance: [] } as never, footer: '', log: () => {},
  });
  return { demo, timeline };
}

before(async () => {
  chrome = await startChrome();
  server = await serve({
    '/': PAGE,
    '/slow': (_q, res) => void setTimeout(() => res.writeHead(200).end('ok'), 3500),
    '/quick': (_q, res) => void setTimeout(() => res.writeHead(200).end('ok'), 200),
  });
  s = await openSession(chrome, server.base);
});
after(async () => {
  await s?.close();
  server?.close();
  await chrome?.close();
});

test('a slow response is shortened, and the start and end of the wait stay in', async () => {
  await s.goto('/');
  const { demo, timeline } = newDemo();
  await demo.click('#slow');
  assert.equal(await s.eval(`out.textContent`), 'done');
  const cuts = timeline.cuts.filter((c) => c.reason === 'wait');
  assert.equal(cuts.length, 1);
  assert.ok(cuts[0].end - cuts[0].start > 1500, `cut ${cuts[0].end - cuts[0].start} ms`);
  const click = timeline.events.find((e) => e.type === 'click')!;
  assert.ok(cuts[0].start > click.t + 800, 'the viewer sees the wait begin');
});

test('a normal response is left alone', async () => {
  await s.goto('/');
  const { demo, timeline } = newDemo();
  await demo.click('#quick');
  assert.deepEqual(timeline.cuts.filter((c) => c.reason === 'wait'), []);
});

test('keepWait shows the whole wait, for a story about the wait itself', async () => {
  await s.goto('/');
  const { demo, timeline } = newDemo();
  await demo.click('#slow', { keepWait: true });
  assert.deepEqual(timeline.cuts.filter((c) => c.reason === 'wait'), []);
});

test('a long waitFor is shortened too', async () => {
  await s.goto('/');
  const { demo, timeline } = newDemo();
  await s.eval(`setTimeout(() => { out.innerHTML = '<b id=late>late</b>'; }, 3000)`);
  await demo.waitFor('#late');
  assert.equal(timeline.cuts.filter((c) => c.reason === 'wait').length, 1);
  await sleep(10);
});
