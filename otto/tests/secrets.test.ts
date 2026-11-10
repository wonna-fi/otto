// Passwords typed on camera must not end up in the step log, failure messages or timeline.json.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Demo } from '../scripts/lib/demo.ts';
import { PACES } from '../scripts/lib/pacing.ts';
import { Tts } from '../scripts/lib/tts.ts';
import type { Timeline } from '../scripts/lib/timeline.ts';
import type { PageSession } from '../scripts/lib/session.ts';
import { tempDir, openSession, serve, startChrome, type TestChrome, type TestServer } from './helpers.ts';

const SECRET = 'hunter2-do-not-log';
const PAGE = `<!doctype html><body style="margin:40px">
<input id="user" name="username" style="display:block;margin:20px;width:300px;height:40px">
<input id="pw" type="password" style="display:block;margin:20px;width:300px;height:40px">
<input id="api" name="api_token" style="display:block;margin:20px;width:300px;height:40px">`;

let chrome: TestChrome;
let server: TestServer;
let s: PageSession;

function newDemo(mode: 'dry' | 'record') {
  const timeline: Timeline = { meta: {} as Timeline['meta'], durationMs: 0, events: [], cuts: [], narration: [], chapters: [] };
  const logged: string[] = [];
  process.env.TTS_PROVIDER = 'none';
  const demo = new Demo({
    mode, session: s, pace: PACES.brisk, lang: 'en', tts: new Tts(tempDir('tts')), capture: null, timeline,
    story: { key: 'T-1', title: 'Test', acceptance: [] } as never, footer: '', log: (l) => logged.push(l),
  });
  return { demo, timeline, logged };
}

before(async () => {
  chrome = await startChrome();
  server = await serve({ '/': PAGE });
  s = await openSession(chrome, server.base);
});
after(async () => {
  await s?.close();
  server?.close();
  await chrome?.close();
});

for (const mode of ['record', 'dry'] as const) {
  test(`${mode}: a password field's value stays out of the log and the timeline, and still gets typed`, async () => {
    await s.goto('/');
    const { demo, timeline, logged } = newDemo(mode);
    await demo.fill('#pw', SECRET);
    assert.equal(await s.eval(`document.querySelector('#pw').value`), SECRET);
    assert.ok(!logged.join('\n').includes(SECRET), 'not in the step log');
    assert.ok(!JSON.stringify(timeline).includes(SECRET), 'not in the timeline');
    assert.match(logged.join('\n'), /fill #pw = \(hidden\)/);
  });
}

test('a token-named text field is hidden too', async () => {
  await s.goto('/');
  const { demo, logged } = newDemo('record');
  await demo.fill('#api', SECRET);
  assert.ok(!logged.join('\n').includes(SECRET));
});

test('type() into a focused password field is hidden', async () => {
  await s.goto('/');
  const { demo, timeline, logged } = newDemo('record');
  await s.eval(`document.querySelector('#pw').focus()`);
  await demo.type(SECRET);
  assert.ok(!logged.join('\n').includes(SECRET));
  assert.ok(!JSON.stringify(timeline).includes(SECRET));
});

test('ordinary fields still show their value, which helps debugging', async () => {
  await s.goto('/');
  const { demo, timeline, logged } = newDemo('record');
  await demo.fill('#user', 'maija');
  assert.match(logged.join('\n'), /fill #user = "maija"/);
  assert.ok(JSON.stringify(timeline).includes('maija'));
});

test('a failing step does not print the value', async () => {
  await s.goto('/');
  const { demo } = newDemo('dry');
  await assert.rejects(demo.fill('#missing-field', SECRET), (e: Error) => !e.message.includes(SECRET));
});
