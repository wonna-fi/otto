// Chrome sometimes gives a tab with no mouse input. Nobody can bring that on at will, so here the mouse events of
// chosen tabs are thrown away on their way to Chrome, which looks the same from the toolkit's side.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Cdp } from '../scripts/lib/cdp.ts';
import { PageSession } from '../scripts/lib/session.ts';
import { serve, startChrome, type TestChrome, type TestServer } from './helpers.ts';

const VIEW = { width: 1600, height: 900, dpr: 1 };
const COUNTER = `(() => { let d = 0; addEventListener('mousedown', () => d++, true); Object.defineProperty(window, '__ottoDowns', { get: () => d }); })();`;

let chrome: TestChrome;
let server: TestServer;

/** A CDP connection on which the mouse works only if alive() says so. */
function flakyCdp(alive: (sessionId: string, nth: number) => boolean) {
  const seen = new Map<string, number>();
  const cdp: Cdp & { tabs: () => number } = {
    send: (method, params, sid) => {
      if (method === 'Input.dispatchMouseEvent' && sid) {
        if (!seen.has(sid)) seen.set(sid, seen.size + 1);
        if (!alive(sid, seen.get(sid)!)) return Promise.resolve({} as never);
      }
      return chrome.cdp.send(method, params, sid);
    },
    on: (m, h) => chrome.cdp.on(m, h),
    close: () => {},
    tabs: () => seen.size,
  };
  return cdp;
}

const pageTargets = async () => (await chrome.cdp.send('Target.getTargets')).targetInfos.filter((t: { type: string }) => t.type === 'page').length;
/** Chrome can list a tab for a moment after closing it, so give the count up to 2 s to settle. */
async function settledTargets(want: number) {
  let n = await pageTargets();
  for (let i = 0; i < 20 && n !== want; i++) { await new Promise((r) => setTimeout(r, 100)); n = await pageTargets(); }
  return n;
}

before(async () => {
  chrome = await startChrome();
  server = await serve({ '/': `<!doctype html><body style="margin:0"><button id="b" style="position:absolute;left:100px;top:100px;width:200px;height:60px" onclick="window.hit=(window.hit||0)+1">b</button>` });
});
after(async () => {
  server?.close();
  await chrome?.close();
});

test('a healthy tab is used as is, with no notes', async () => {
  const cdp = flakyCdp(() => true);
  const s = await PageSession.open(cdp, { baseUrl: server.base, viewport: VIEW, overlaySource: COUNTER });
  assert.equal(cdp.tabs(), 1);
  assert.deepEqual(s.startupNotes, []);
  await s.close();
});

test('a tab without a mouse is replaced, closed and reported, and the next one really clicks', async () => {
  const before = await pageTargets();
  const cdp = flakyCdp((_sid, nth) => nth > 1);
  const s = await PageSession.open(cdp, { baseUrl: server.base, viewport: VIEW, overlaySource: COUNTER });
  assert.equal(cdp.tabs(), 2);
  assert.match(s.startupNotes.join(), /did not reach 1 new tab.*stayed dead, so it belongs to the tab/);
  assert.equal(await settledTargets(before + 1), before + 1, 'the dead tab was closed');
  await s.goto('/');
  await s.click(200, 130);
  assert.equal(await s.eval('window.hit'), 1);
  assert.deepEqual(s.recoveredClicks, [], `the new tab clicked for real: ${JSON.stringify(s.recoveredClicks)}`);
  await s.close();
});

test('a problem that passes with time is told apart from one that belongs to the tab', async () => {
  let healed = false;
  const cdp = flakyCdp((_sid, nth) => { if (nth > 2) healed = true; return healed; });
  const s = await PageSession.open(cdp, { baseUrl: server.base, viewport: VIEW, overlaySource: COUNTER });
  assert.match(s.startupNotes.join(), /started working too, so it was the moment/);
  await s.close();
});

test('gives up with a clear instruction, leaving no tabs behind', async () => {
  const before = await pageTargets();
  const cdp = flakyCdp(() => false);
  await assert.rejects(PageSession.open(cdp, { baseUrl: server.base, viewport: VIEW, overlaySource: COUNTER, mouseWaitMs: 1000 }), /not delivering mouse input.*Restart Chrome/);
  assert.equal(await settledTargets(before), before, 'no tabs left behind');
});

test('if the mouse dies later, the click is delivered from inside the page and reported', async () => {
  let dead = false;
  const cdp = flakyCdp(() => !dead);
  const s = await PageSession.open(cdp, { baseUrl: server.base, viewport: VIEW, overlaySource: COUNTER });
  await s.goto('/');
  dead = true;
  await s.click(200, 130);
  assert.equal(await s.eval('window.hit'), 1);
  assert.ok(s.recoveredClicks.some((c) => c.state === 'delivered from inside the page'));
  await s.close();
});

test('each troubled click gets one line in the notes, with its time', async () => {
  let dead = false;
  const cdp = flakyCdp(() => !dead);
  const s = await PageSession.open(cdp, { baseUrl: server.base, viewport: VIEW, overlaySource: COUNTER });
  await s.goto('/');
  dead = true;
  await s.click(200, 130);
  await s.click(200, 130);
  const notes = s.clickNotes();
  assert.equal(notes.length, 2, notes.join('\n'));
  assert.match(notes[0], /A click at 200,130 never reached the page, so it was delivered from inside the page at \d\d:\d\d:\d\d/);
  await s.close();
});
