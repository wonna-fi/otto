// Browser sign-in prompts: answered for the app, never for anyone else, and without looping on a wrong password.
// The NTLM server below does the real three-step handshake on one connection and reads who signed in from Chrome's
// final message. It doesn't check the password hash: Node's crypto has no MD4 by default, so that part needs a real server.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { httpAuthFromEnv, PageSession, type HttpAuth } from '../scripts/lib/session.ts';
import { serve, sleep, startChrome, type TestChrome, type TestServer } from './helpers.ts';

const VIEW = { width: 1600, height: 900, dpr: 1 };
const PAGE = '<!doctype html><title>inside</title><h1 id="ok">signed in</h1>';

let chrome: TestChrome;

const open = (baseUrl: string, httpAuth: HttpAuth | null) => PageSession.open(chrome.cdp, { baseUrl, viewport: VIEW, overlaySource: '', httpAuth });

function basic(user: string, password: string, seen: { asked: number }) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const want = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
    if (req.headers.authorization === want) return void res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
    seen.asked++;
    res.writeHead(401, { 'www-authenticate': 'Basic realm="test"', 'content-type': 'text/html' }).end('denied');
  };
}

/** A minimal NTLM type 2 message with the flags and target info Chrome's NTLMv2 needs. */
function ntlmChallenge() {
  const name = Buffer.from('TEST', 'utf16le');
  const info = Buffer.concat([Buffer.from([2, 0, name.length, 0]), name, Buffer.from([0, 0, 0, 0])]);
  const head = Buffer.alloc(56);
  head.write('NTLMSSP\0', 0, 'latin1');
  head.writeUInt32LE(2, 8);
  head.writeUInt16LE(name.length, 12); head.writeUInt16LE(name.length, 14); head.writeUInt32LE(56, 16);
  head.writeUInt32LE((0x00000001 | 0x00000004 | 0x00000200 | 0x00008000 | 0x00080000 | 0x00800000 | 0x20000000 | 0x80000000) >>> 0, 20);
  Buffer.from('0123456789abcdef', 'hex').copy(head, 24);
  head.writeUInt16LE(info.length, 40); head.writeUInt16LE(info.length, 42); head.writeUInt32LE(56 + name.length, 44);
  return Buffer.concat([head, name, info]).toString('base64');
}

function ntlm(signedIn: { user?: string; domain?: string; steps: number[] }) {
  const authed = new WeakSet<object>();
  return (req: IncomingMessage, res: ServerResponse) => {
    if (authed.has(req.socket)) return void res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
    const header = req.headers.authorization;
    if (!header?.startsWith('NTLM ')) return void res.writeHead(401, { 'www-authenticate': 'NTLM', 'content-length': '0' }).end();
    const msg = Buffer.from(header.slice(5), 'base64');
    const type = msg.readUInt32LE(8);
    signedIn.steps.push(type);
    if (type === 1) return void res.writeHead(401, { 'www-authenticate': `NTLM ${ntlmChallenge()}`, 'content-length': '0' }).end();
    const field = (at: number) => msg.subarray(msg.readUInt32LE(at + 4), msg.readUInt32LE(at + 4) + msg.readUInt16LE(at)).toString('utf16le');
    signedIn.domain = field(28);
    signedIn.user = field(36);
    authed.add(req.socket);
    res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
  };
}

before(async () => { chrome = await startChrome(); });
after(async () => { await chrome?.close(); });

test('real NTLM handshake: Chrome signs in with the given user and domain', async () => {
  const who: { user?: string; domain?: string; steps: number[] } = { steps: [] };
  const server = await serve({ '/': ntlm(who) });
  const s = await open(server.base, { username: 'TESTDOM\\maija', password: 'pw' });
  await s.goto('/');
  assert.equal(await s.eval(`document.querySelector('#ok')?.textContent`), 'signed in');
  assert.deepEqual(who.steps, [1, 3]);
  assert.equal(who.user, 'maija');
  assert.equal(who.domain, 'TESTDOM');
  assert.deepEqual(s.signInProblems, []);
  await s.close();
  server.close();
});

test('Basic works, and pages and form posts still go through', async () => {
  const seen = { asked: 0 };
  let posted = '';
  const check = basic('u', 'p', seen);
  const server = await serve({
    '/': (req, res) => {
      if (req.headers.authorization) return void res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><form method="post" action="/save"><input name="v" value="42"><button id="b">go</button></form>`);
      check(req, res);
    },
    '/save': (req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => { posted = body; res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE); });
    },
  });
  const s = await open(server.base, { username: 'u', password: 'p' });
  await s.goto('/');
  const before = s.navCount;
  await s.eval(`document.querySelector('form').submit()`);
  await s.waitForNavigation(before);
  assert.equal(posted, 'v=42');
  await s.close();
  server.close();
});

test('a wrong password stops after a couple of tries and says what to check', async () => {
  const seen = { asked: 0 };
  const server = await serve({ '/': basic('u', 'right', seen) });
  const s = await open(server.base, { username: 'u', password: 'wrong' });
  await s.send('Page.navigate', { url: `${server.base}/` });
  await sleep(1500);
  assert.ok(seen.asked <= 4, `asked ${seen.asked} times`);
  assert.match(s.signInProblems.join(), /refused the sign-in \(basic\) for user u\. Check OTTO_HTTP_USER/i);
  assert.ok(!s.signInProblems.join().includes('wrong'), 'the password is not in the message');
  await s.close();
  server.close();
});

test('another site asking for a sign-in gets nothing', async () => {
  const leaked: string[] = [];
  const evil = await serve({ '/': (req, res) => {
    if (req.headers.authorization) leaked.push(req.headers.authorization);
    res.writeHead(401, { 'www-authenticate': 'Basic realm="other"' }).end('denied');
  } });
  const app = await serve({ '/': PAGE });
  const s = await open(app.base, { username: 'u', password: 'secret' });
  await s.goto('/');
  await s.send('Page.navigate', { url: `${evil.base}/` });
  await sleep(800);
  assert.deepEqual(leaked, []);
  assert.match(s.signInProblems.join(), /asked for a sign-in \(basic\), and it isn't the app or in OTTO_HTTP_ORIGINS/i);
  await s.close();
  app.close();
  evil.close();
});

test('OTTO_HTTP_ORIGINS lets a named extra site have the credentials', async () => {
  const seen = { asked: 0 };
  const other = await serve({ '/': basic('u', 'p', seen) });
  const app = await serve({ '/': PAGE });
  const s = await open(app.base, { username: 'u', password: 'p', origins: [other.base] });
  await s.goto(`${other.base}/`);
  assert.equal(await s.eval(`document.querySelector('#ok')?.textContent`), 'signed in');
  await s.close();
  app.close();
  other.close();
});

test('credentials come from the environment, and nothing is on without them', () => {
  assert.equal(httpAuthFromEnv({}), null);
  assert.equal(httpAuthFromEnv({ OTTO_HTTP_USER: 'u' }), null);
  assert.deepEqual(httpAuthFromEnv({ OTTO_HTTP_USER: 'D\\u', OTTO_HTTP_PASSWORD: 'p', OTTO_HTTP_ORIGINS: 'https://a, https://b' }), { username: 'D\\u', password: 'p', origins: ['https://a', 'https://b'] });
});
