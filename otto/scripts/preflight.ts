// Is this machine ready to record? Run it once in a new environment, and whenever something fails in a strange way.
//
//   node otto/scripts/preflight.ts [--port 9333] [--app <url of the app>]
//
// Every problem comes with the fix. Never prints keys or passwords. Exit code 1 if something must be fixed first.
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { connectBrowser } from './lib/cdp.ts';
import { loadEnv, toolkitDir } from './lib/env.ts';
import { httpAuthFromEnv, PageSession } from './lib/session.ts';
import { Tts } from './lib/tts.ts';
import { join } from 'node:path';

loadEnv();

const { values: o } = parseArgs({
  options: {
    port: { type: 'string', default: process.env.CDP_PORT ?? '9333' },
    app: { type: 'string', default: process.env.APP_URL },
  },
});

let failed = 0;
const report = (status: 'ok' | 'warn' | 'FAIL', name: string, detail: string, fix?: string) => {
  if (status === 'FAIL') failed++;
  console.log(`${status.padEnd(4)}  ${name}: ${detail}`);
  if (fix) console.log(`      fix: ${fix}`);
};

const CA_FIX = 'a firewall that inspects TLS re-signs traffic with the company certificate. Node needs NODE_EXTRA_CA_CERTS=/path/to/company-root.pem (in .env.local it is too late: export it before running node).';
const tlsProblem = (m: string) => /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|LEAF_SIGNATURE/i.test(m);
const causeOf = (e: unknown) => {
  const err = e as { cause?: { code?: string; message?: string }; message?: string };
  return err?.cause?.code ?? err?.cause?.message ?? err?.message ?? String(e);
};

// ---------- tools ----------
console.log('Tools');
const [major, minor] = process.versions.node.split('.').map(Number);
if (major > 22 || (major === 22 && minor >= 18)) report('ok', 'Node', process.versions.node);
else report('FAIL', 'Node', `${process.versions.node} is too old`, 'install Node 22.18 or newer: it runs the toolkit\'s TypeScript directly.');

for (const tool of ['ffmpeg', 'ffprobe']) {
  const r = spawnSync(tool, ['-version'], { encoding: 'utf8' });
  if (r.status === 0) report('ok', tool, r.stdout.split('\n')[0].split(' ').slice(0, 3).join(' '));
  else report('FAIL', tool, 'not found', 'sudo apt install ffmpeg');
}
const encoders = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout ?? '';
if (encoders && !/libx264/.test(encoders)) report('FAIL', 'H.264 encoder', 'this ffmpeg has no libx264', 'install a full ffmpeg build.');

// ---------- browser ----------
console.log('\nChrome');
const viewport = { width: 1600, height: 900, dpr: 1.2 };
let cdp: Awaited<ReturnType<typeof connectBrowser>> | null = null;
try {
  cdp = await connectBrowser(Number(o.port));
  const v = await cdp.send('Browser.getVersion');
  report('ok', `port ${o.port}`, v.product);
  if (/Headless/.test(v.userAgent)) console.log('      note: the user agent says HeadlessChrome. If a sign-in page or gateway refuses it, start Chrome with --user-agent="..." copied from a normal browser.');
} catch {
  report('FAIL', `port ${o.port}`, 'no Chrome with remote debugging there',
    `google-chrome --headless=new --remote-debugging-port=${o.port} --user-data-dir="$HOME/.cache/otto-chrome" --window-size=1600,1000 --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling --force-color-profile=srgb --disable-dev-shm-usage about:blank &`);
}

let session: PageSession | null = null;
if (cdp) {
  try {
    session = await PageSession.open(cdp, { baseUrl: o.app ?? 'http://localhost', viewport, overlaySource: '', mouseWaitMs: 8000 });
    report('ok', 'mouse input', 'clicks reach a new tab');
    for (const n of session.startupNotes) console.log(`      note: ${n}`);
  } catch (e) {
    report('FAIL', 'mouse input', (e as Error).message, 'restart Chrome. If it keeps happening, say so: the cause of this one is not known yet.');
  }
}
if (session) {
  const s = session;
  try {
    let frames = 0;
    const off = cdp!.on('Page.screencastFrame', (p, sid) => {
      if (sid !== s.sessionId) return;
      frames++;
      s.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
    });
    await s.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 320, maxHeight: 180 });
    await s.eval(`(() => { let n = 0; const tick = () => { document.body.style.background = (n++ % 2) ? '#fff' : '#eee'; if (n < 40) requestAnimationFrame(tick); }; tick(); return 1; })()`);
    await new Promise((r) => setTimeout(r, 1500));
    await s.send('Page.stopScreencast');
    off();
    if (frames) report('ok', 'screen capture', `${frames} frames in 1.5 s`);
    else report('FAIL', 'screen capture', 'no frames', 'the tab isn\'t painting. Use headless Chrome, or keep a headed window on screen and start it with --disable-backgrounding-occluded-windows --disable-renderer-backgrounding.');
  } catch (e) {
    report('FAIL', 'screen capture', (e as Error).message);
  }
}

// ---------- voice ----------
console.log('\nVoice');
const tts = new Tts(join(toolkitDir, '.cache'));
if (tts.provider === 'none') {
  report('warn', 'narration', 'no voice configured, so videos will be silent with estimated timing', `set OPENAI_API_KEY, or AZURE_TTS_ENDPOINT, AZURE_TTS_DEPLOYMENT and AZURE_TTS_KEY, in ${join(toolkitDir, '.env.local')}`);
} else {
  const where = `${tts.provider}, ${tts.model}, voices fi=${tts.voiceFor('fi').voice} en=${tts.voiceFor('en').voice}`;
  try {
    await tts.checkConnection();
    report('ok', 'narration', where);
  } catch (e) {
    const m = (e as Error).message;
    report('FAIL', 'narration', `${where}: ${m}`, tlsProblem(m) ? CA_FIX : 'check the endpoint, deployment name and key. Node ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY=1 is set.');
  }
  if (!tts.asrModel) {
    report('warn', 'listening check', tts.provider === 'azure' ? 'off: no transcription deployment' : 'off', tts.provider === 'azure' ? 'set AZURE_ASR_DEPLOYMENT to a gpt-transcribe or whisper deployment. Without it a wrong number in the voice goes unnoticed.' : undefined);
  } else {
    try {
      await tts.checkTranscription();
      report('ok', 'listening check', `${tts.asrModel}, prompt: ${tts.asrPrompt}`);
      if (/4o/i.test(tts.asrModel)) console.log('      note: gpt-transcribe hears Finnish better. With this model a number\'s case often can\'t be checked, and good lines fail now and then, which costs retakes (references/porting.md).');
      else if (tts.provider === 'azure') console.log('      note: if this deployment is gpt-4o-transcribe or whisper under another name, set TTS_ASR_PROMPT=short.');
    } catch (e) {
      const m = causeOf(e);
      report('FAIL', 'listening check', m, tlsProblem(m) ? CA_FIX : `check that ${tts.asrModel} is available to this key${tts.provider === 'azure' ? ', and AZURE_ASR_DEPLOYMENT and AZURE_ASR_API_VERSION' : ''}.`);
    }
  }
}

// ---------- the app ----------
if (o.app) {
  console.log('\nApp');
  const auth = httpAuthFromEnv();
  try {
    const res = await fetch(o.app, { redirect: 'manual' });
    const schemes = (res.headers.get('www-authenticate') ?? '').split(',').map((x) => x.trim().split(' ')[0]).filter((x) => /^(NTLM|Negotiate|Basic|Digest)$/i.test(x));
    if (res.status === 401 && schemes.length) {
      const list = schemes.join(', ');
      if (auth) report('ok', 'browser sign-in', `the app asks for ${list}; credentials are set for user ${auth.username}`);
      else report('FAIL', 'browser sign-in', `the app asks for ${list}, and no credentials are set`, 'set OTTO_HTTP_USER (DOMAIN\\user for NTLM) and OTTO_HTTP_PASSWORD in .env.local. Linux Chrome has no Windows sign-in to fall back on.');
    } else {
      report('ok', 'reachable from Node', `HTTP ${res.status}`);
    }
  } catch (e) {
    const m = causeOf(e);
    if (tlsProblem(m)) report('warn', 'reachable from Node', m, CA_FIX);
    else report('warn', 'reachable from Node', m, 'only setup scripts that use fetch need this, but it usually means Chrome can\'t reach the app either.');
  }
  if (session) {
    try {
      await session.goto(o.app);
      report('ok', 'opens in Chrome', await session.eval<string>('location.href'));
      for (const p of session.signInProblems) report('FAIL', 'browser sign-in', p);
      const family = await session.eval<string>(`getComputedStyle(document.body).fontFamily`);
      const wanted = family.split(',')[0].trim().replace(/^["']|["']$/g, '');
      await session.send('DOM.enable');
      await session.send('CSS.enable');
      const { root } = await session.send('DOM.getDocument');
      const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'body' });
      const { fonts } = await session.send('CSS.getPlatformFontsForNode', { nodeId });
      const used = (fonts as Array<{ familyName: string }>).map((f) => f.familyName);
      if (!used.length || /^(system-ui|sans-serif|serif|monospace|-apple-system|inherit)$/i.test(wanted)) report('ok', 'fonts', `the page uses ${used.join(', ') || wanted}`);
      else if (used.some((u) => u.toLowerCase() === wanted.toLowerCase())) report('ok', 'fonts', `${wanted} is available`);
      else report('warn', 'fonts', `the page asks for ${wanted}, but Chrome draws it with ${used.join(', ')}. The app will look different in the video than for its users.`, `install ${wanted} on this machine, or a metric-compatible font (sudo apt install fontconfig fonts-liberation fonts-noto).`);
    } catch (e) {
      const m = (e as Error).message;
      const fix = /CERT/i.test(m)
        ? 'Chrome needs the company root certificate: certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n company-root -i /path/to/company-root.crt (package libnss3-tools), then restart Chrome.'
        : /NAME_NOT_RESOLVED|CONNECTION|TIMED_OUT|ADDRESS_UNREACHABLE/i.test(m)
          ? 'this machine can\'t reach the app. In WSL, check DNS and VPN access; try networkingMode=mirrored in .wslconfig.'
          : undefined;
      report('FAIL', 'opens in Chrome', m, fix);
    }
  }
}

await session?.close().catch(() => {});
cdp?.close();
console.log(failed ? `\n${failed} problem(s) to fix before recording.` : '\nReady to record.');
process.exit(failed ? 1 : 0);
