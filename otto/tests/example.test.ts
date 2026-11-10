// The example app and its storyboard: a dry run of the whole flow, the way a new user would first try the toolkit.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { sleep, startChrome, tempDir, type TestChrome } from './helpers.ts';

const root = new URL('../../', import.meta.url).pathname;
let chrome: TestChrome;
let app: ChildProcess;
const PORT = '3291';

function record(env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  const out = tempDir('example');
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['otto/scripts/record.ts', 'examples/tasks-app/storyboard.ts', '--dry', '--port', String(chrome.port), '--out', out], {
      cwd: root, env: { ...process.env, TTS_PROVIDER: 'none', APP_URL: `http://localhost:${PORT}`, OTTO_CACHE_DIR: out, ...env },
    });
    let text = '';
    p.stdout!.on('data', (d) => (text += d));
    p.stderr!.on('data', (d) => (text += d));
    p.on('exit', (code) => resolve({ code: code ?? -1, out: text }));
  });
}

before(async () => {
  chrome = await startChrome();
  app = spawn(process.execPath, ['examples/tasks-app/server.ts'], { cwd: root, env: { ...process.env, PORT }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    if (await fetch(`http://localhost:${PORT}/login`).then((r) => r.ok).catch(() => false)) break;
    await sleep(100);
  }
});
after(async () => {
  app?.kill();
  await chrome?.close();
});

test('the example storyboard passes a dry run, with nothing to warn about', async () => {
  const r = await record();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /dry run OK/);
  assert.doesNotMatch(r.out, /no chapter for|without verify|never annotated|note: a click/);
  assert.doesNotMatch(r.out, /demo123/, 'the password is not in the log');
});

test('it can run again on the same data, because it creates its own', async () => {
  const r = await record();
  assert.equal(r.code, 0, r.out);
});
