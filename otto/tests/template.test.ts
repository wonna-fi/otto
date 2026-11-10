// The sign-in template, run against a stand-in for Microsoft's sign-in page on its own host: same field names, a full
// reload per step. This tests the flow's logic. It can't show that the real page still looks like this, or that your
// tenant lets this machine in; that takes a first run against your tenant.
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { FastDriver } from '../scripts/lib/fast-driver.ts';
import type { PageSession } from '../scripts/lib/session.ts';
import { signInWithEntra, signInWithForm } from '../templates/ui-skill/scripts/login.ts';
import { uniqueName } from '../templates/ui-skill/scripts/test-data.ts';
import { openSession, serve, startChrome, type TestChrome, type TestServer } from './helpers.ts';

let chrome: TestChrome;
let app: TestServer;
let idp: TestServer;
let s: PageSession;
let ui: FastDriver;
let visited: string[] = [];
let picker = false;
let stayPage = true;

const html = (res: ServerResponse, body: string) => res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><body style="margin:40px">${body}`);
const body = (req: IncomingMessage) => new Promise<URLSearchParams>((r) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => r(new URLSearchParams(b))); });
const btn = (extra = '') => `<input type="submit" id="idSIButton9" value="Next" style="display:block;width:200px;height:40px" ${extra}>`;

before(async () => {
  chrome = await startChrome();
  app = await serve({
    '/': (req, res) => {
      if ((req.headers.cookie ?? '').includes('session=ok')) return html(res, '<div data-testid="current-user">Maija</div>');
      res.writeHead(302, { location: `${idp.base}/start` }).end();
    },
    '/done': (_q, res) => void res.writeHead(302, { location: '/', 'set-cookie': 'session=ok; Path=/' }).end(),
    '/form': (req, res) => {
      if ((req.headers.cookie ?? '').includes('session=ok')) return html(res, '<div data-testid="current-user">Maija</div>');
      html(res, `<form method="post" action="/form-post"><input id="u" name="u" style="display:block;width:300px;height:40px"><input id="p" type="password" name="p" style="display:block;width:300px;height:40px"><button id="go" style="width:200px;height:40px">Sign in</button></form>`);
    },
    '/form-post': async (req, res) => {
      const f = await body(req);
      if (f.get('p') === 'right') return void res.writeHead(302, { location: '/form', 'set-cookie': 'session=ok; Path=/' }).end();
      html(res, '<div role="alert">Wrong username or password</div>');
    },
  });
  idp = await serve({
    '/start': (_q, res) => {
      visited.push('start');
      if (picker) return html(res, `<div id="tilesHolder" style="width:400px;height:100px"><div id="otherTile" style="height:40px" onclick="location='/email'">Use another account</div></div>`);
      res.writeHead(302, { location: '/email' }).end();
    },
    '/email': (_q, res) => { visited.push('email'); html(res, `<form method="post" action="/email-post"><input name="loginfmt" style="display:block;width:300px;height:40px">${btn()}</form>`); },
    '/email-post': async (req, res) => {
      const f = await body(req);
      visited.push(`email=${f.get('loginfmt')}`);
      res.writeHead(302, { location: '/password' }).end();
    },
    '/password': (_q, res) => { visited.push('password'); html(res, `<form method="post" action="/password-post"><input name="passwd" type="password" style="display:block;width:300px;height:40px">${btn()}</form>`); },
    '/password-post': async (req, res) => {
      const f = await body(req);
      if (f.get('passwd') !== 'right') return html(res, `<div id="passwordError" style="width:300px;height:30px">Your account or password is incorrect.</div><input name="passwd" type="password" style="display:block;width:300px;height:40px">`);
      res.writeHead(302, { location: stayPage ? '/stay' : `${app.base}/done` }).end();
    },
    '/stay': (_q, res) => { visited.push('stay'); html(res, `<form method="post" action="/stay-post"><input type="checkbox" id="KmsiCheckboxField" style="width:20px;height:20px">${btn()}</form>`); },
    '/stay-post': (_q, res) => void res.writeHead(302, { location: `${app.base}/done` }).end(),
  });
  s = await openSession(chrome, app.base);
  ui = new FastDriver(s);
});
beforeEach(async () => {
  visited = [];
  picker = false;
  stayPage = true;
  await chrome.cdp.send('Network.clearBrowserCookies', {}, s.sessionId);
});
after(async () => {
  await s?.close();
  app?.close();
  idp?.close();
  await chrome?.close();
});

const ENTRA = { signedIn: '[data-testid=current-user]', user: 'maija@test.example', password: 'right', timeout: 15000 };

test('Entra: email, password, "stay signed in", back in the app', async () => {
  await signInWithEntra(ui, ENTRA);
  assert.equal(await ui.text('[data-testid=current-user]'), 'Maija');
  assert.deepEqual(visited, ['start', 'email', 'email=maija@test.example', 'password', 'stay']);
});

test('Entra: without the "stay signed in" page too', async () => {
  stayPage = false;
  await signInWithEntra(ui, ENTRA);
  assert.equal(await ui.text('[data-testid=current-user]'), 'Maija');
});

test('Entra: already signed in, so nothing is typed anywhere', async () => {
  await signInWithEntra(ui, ENTRA);
  visited = [];
  await signInWithEntra(ui, ENTRA);
  assert.deepEqual(visited, []);
});

test('Entra: from the account picker via "use another account"', async () => {
  picker = true;
  await signInWithEntra(ui, ENTRA);
  assert.equal(await ui.text('[data-testid=current-user]'), 'Maija');
});

test('Entra: a wrong password stops with the page\'s own message, without the password', async () => {
  await assert.rejects(signInWithEntra(ui, { ...ENTRA, password: 'wrong-pass' }), (e: Error) => {
    assert.match(e.message, /Entra refused the sign-in for maija@test\.example: Your account or password is incorrect/);
    assert.ok(!e.message.includes('wrong-pass'));
    return true;
  });
});

test('missing credentials say what to set', async () => {
  const saved = [process.env.APP_USER, process.env.APP_PASSWORD];
  delete process.env.APP_USER;
  delete process.env.APP_PASSWORD;
  await assert.rejects(signInWithEntra(ui, { signedIn: 'x' }), /Set APP_USER and APP_PASSWORD/);
  if (saved[0]) process.env.APP_USER = saved[0];
  if (saved[1]) process.env.APP_PASSWORD = saved[1];
});

const FORM = { start: '/form', signedIn: '[data-testid=current-user]', userField: '#u', passwordField: '#p', submit: '#go', user: 'maija', timeout: 8000 };

test('form: signs in, and the second time does nothing', async () => {
  await signInWithForm(ui, { ...FORM, password: 'right' });
  assert.equal(await ui.text('[data-testid=current-user]'), 'Maija');
  await signInWithForm(ui, { ...FORM, password: 'right' });
  assert.equal(await ui.text('[data-testid=current-user]'), 'Maija');
});

test('form: a refused sign-in says so', async () => {
  await assert.rejects(signInWithForm(ui, { ...FORM, password: 'bad' }), /Sign-in refused for maija: Wrong username or password/);
});

test('unique names are readable and differ', () => {
  assert.match(uniqueName('Maija', 1_700_000_000_000), /^Maija Test [0-9A-Z]{4}$/);
  assert.notEqual(uniqueName('Maija', 1_700_000_000_000), uniqueName('Maija', 1_700_000_100_000));
});
