// The preflight must find real problems, say how to fix them, and never print a secret.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { serve, startChrome, type TestChrome } from './helpers.ts';

const script = new URL('../scripts/preflight.ts', import.meta.url).pathname;
let chrome: TestChrome;

function run(args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    // A cwd without .env.local, and no inherited keys: the test decides what is configured.
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(OPENAI|AZURE|TTS_|OTTO_|APP_URL|CDP_PORT)/.test(k)));
    const p = spawn(process.execPath, [script, ...args], { env: { ...clean, TTS_PROVIDER: 'none', ...env }, cwd: '/tmp' });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('exit', (code) => resolve({ code: code ?? -1, out }));
  });
}

before(async () => { chrome = await startChrome(); });
after(async () => { await chrome?.close(); });

test('all good: exit 0, and a missing voice is only a warning', async () => {
  const app = await serve({ '/': '<!doctype html><body style="font-family:sans-serif">hello' });
  const r = await run(['--port', String(chrome.port), '--app', app.base]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /ok\s+mouse input/);
  assert.match(r.out, /ok\s+screen capture/);
  assert.match(r.out, /warn\s+narration: no voice configured/);
  assert.match(r.out, /Ready to record/);
  app.close();
});

test('no Chrome: exit 1, and the fix is a command to run', async () => {
  const r = await run(['--port', '1']);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /FAIL\s+port 1: no Chrome/);
  assert.match(r.out, /fix: google-chrome --headless=new --remote-debugging-port=1 /);
});

test('an NTLM app without credentials fails and says what to set', async () => {
  const app = await serve({ '/': (_q, res) => void res.writeHead(401, { 'www-authenticate': 'NTLM' }).end() });
  const r = await run(['--port', String(chrome.port), '--app', app.base]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /FAIL\s+browser sign-in: the app asks for NTLM, and no credentials are set/);
  assert.match(r.out, /OTTO_HTTP_USER/);
  app.close();
});

test('a font the machine lacks is pointed out', async () => {
  const app = await serve({ '/': '<!doctype html><body style="font-family:\'Font That Does Not Exist\',serif">hello' });
  const r = await run(['--port', String(chrome.port), '--app', app.base]);
  assert.match(r.out, /warn\s+fonts: the page asks for Font That Does Not Exist, but Chrome draws it with/);
  app.close();
});

test('secrets stay out of the output, even when connecting fails', async () => {
  const app = await serve({ '/': (_q, res) => void res.writeHead(401, { 'www-authenticate': 'Basic realm="x"' }).end() });
  const r = await run(['--port', String(chrome.port), '--app', app.base], {
    TTS_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-should-not-appear', OPENAI_BASE_URL: 'http://127.0.0.1:1/v1',
    OTTO_HTTP_USER: 'someone', OTTO_HTTP_PASSWORD: 'password-should-not-appear',
  });
  assert.ok(!r.out.includes('sk-should-not-appear'), r.out);
  assert.ok(!r.out.includes('password-should-not-appear'), r.out);
  assert.match(r.out, /FAIL\s+narration/);
  app.close();
});
