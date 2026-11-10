// The listening check's transcription call: the right prompt for the model, protection against a prompt that comes
// back as the transcript, and the Azure request shape. Runs against a stand-in server, without any real service.
import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Tts } from '../scripts/lib/tts.ts';
import { serve, tempDir, type TestServer } from './helpers.ts';

type Call = { url: string; headers: IncomingMessage['headers']; prompt: string | null; model: string | null };
let server: TestServer;
let calls: Call[] = [];
let answer: (c: Call) => { status?: number; text?: string } = () => ({ text: 'ok' });

const field = (body: string, name: string) => body.match(new RegExp(`name="${name}"\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--`))?.[1] ?? null;
function endpoint(req: IncomingMessage, res: ServerResponse) {
  const chunks: Buffer[] = [];
  req.on('data', (d) => chunks.push(d));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const call: Call = { url: req.url ?? '', headers: req.headers, prompt: field(body, 'prompt'), model: field(body, 'model') };
    calls.push(call);
    const a = answer(call);
    res.writeHead(a.status ?? 200, { 'content-type': 'application/json' }).end(JSON.stringify({ text: a.text ?? '' }));
  });
}

const ENV = ['TTS_PROVIDER', 'TTS_ASR', 'TTS_ASR_MODEL', 'TTS_ASR_PROMPT', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'AZURE_TTS_ENDPOINT', 'AZURE_TTS_KEY', 'AZURE_TTS_KEY_HEADER', 'AZURE_ASR_DEPLOYMENT', 'AZURE_ASR_ENDPOINT', 'AZURE_ASR_KEY', 'AZURE_ASR_API_VERSION'];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
function tts(env: Record<string, string>) {
  for (const k of ENV) delete process.env[k];
  Object.assign(process.env, { TTS_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test-key-not-real', OPENAI_BASE_URL: `${server.base}/v1` }, env);
  return new Tts(tempDir('asr'));
}
function clip() {
  const p = join(tempDir('asr-clip'), 'clip.wav');
  writeFileSync(p, Buffer.alloc(100));
  return p;
}

before(async () => {
  server = await serve({ '/v1/audio/transcriptions': endpoint, '/openai/deployments/my-listener/audio/transcriptions': endpoint });
});
afterEach(() => { calls = []; answer = () => ({ text: 'ok' }); });
after(() => {
  server?.close();
  for (const k of ENV) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; }
});

test('the prompt follows the model, and can be set', () => {
  assert.equal(tts({ TTS_ASR_MODEL: 'gpt-transcribe' }).asrPrompt, 'guided');
  assert.equal(tts({ TTS_ASR_MODEL: 'gpt-4o-transcribe' }).asrPrompt, 'short');
  assert.equal(tts({ TTS_ASR_MODEL: 'gpt-4o-mini-transcribe' }).asrPrompt, 'short');
  assert.equal(tts({ TTS_ASR_MODEL: 'whisper-1' }).asrPrompt, 'short');
  assert.equal(tts({ TTS_ASR_MODEL: 'gpt-4o-transcribe', TTS_ASR_PROMPT: 'none' }).asrPrompt, 'none');
  assert.throws(() => tts({ TTS_ASR_PROMPT: 'loud' }), /TTS_ASR_PROMPT must be guided, short or none/);
});

test('each mode sends what it should', async () => {
  await tts({ TTS_ASR_MODEL: 'gpt-transcribe' }).transcribe(clip(), 'fi', 'x');
  assert.match(calls[0].prompt!, /kahdentoista tuhannen/i);
  calls = [];
  await tts({ TTS_ASR_MODEL: 'gpt-4o-transcribe' }).transcribe(clip(), 'fi', 'x');
  assert.equal(calls[0].prompt, 'Luvut kirjoitetaan sanoina.');
  assert.equal(calls[0].model, 'gpt-4o-transcribe');
  calls = [];
  await tts({ TTS_ASR_PROMPT: 'none' }).transcribe(clip(), 'en', 'x');
  assert.equal(calls[0].prompt, null);
});

test('a prompt that comes back as the transcript: listens again the safe way, and stays that way', async () => {
  answer = (c) => (c.prompt?.includes('twelve thousand') ? { text: 'A shipment of twelve thousand screws leaves today.' } : { text: 'Saving is blocked.' });
  const t = tts({ TTS_ASR_MODEL: 'some-azure-name' });
  assert.equal(t.asrPrompt, 'guided');
  assert.equal(await t.transcribe(clip(), 'en', 'Saving is blocked.'), 'Saving is blocked.');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].prompt, 'Numbers are written as words.');
  assert.equal(t.asrPrompt, 'short');
  assert.match(t.asrNotes.join(), /repeated the listening check's example sentence.*TTS_ASR_PROMPT=short/);
  calls = [];
  await t.transcribe(clip(), 'en', 'Saving is blocked.');
  assert.equal(calls.length, 1, 'no more wasted calls');
});

test('a line that really says those words is not mistaken for an echo', async () => {
  const line = 'A shipment of twelve thousand screws leaves today.';
  answer = () => ({ text: line });
  const t = tts({ TTS_ASR_MODEL: 'gpt-transcribe' });
  assert.equal(await t.transcribe(clip(), 'en', line), line);
  assert.equal(calls.length, 1);
  assert.equal(t.asrPrompt, 'guided');
});

test('Azure: the deployment in the path, the API version, and its own key header', async () => {
  const t = tts({ TTS_PROVIDER: 'azure', AZURE_TTS_ENDPOINT: server.base, AZURE_TTS_KEY: 'azure-key-not-real', AZURE_ASR_DEPLOYMENT: 'my-listener', AZURE_ASR_API_VERSION: '2099-01-01' });
  await t.transcribe(clip(), 'fi', 'x');
  assert.equal(calls[0].url, '/openai/deployments/my-listener/audio/transcriptions?api-version=2099-01-01');
  assert.equal(calls[0].headers['api-key'], 'azure-key-not-real');
  assert.equal(calls[0].headers.authorization, undefined);
});

test('the preflight check really calls the service, and an error names no key', async () => {
  const t = tts({ TTS_ASR_MODEL: 'gpt-4o-transcribe' });
  await t.checkTranscription();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].prompt, null, 'silence with a prompt could come back as anything');
  answer = () => ({ status: 404, text: 'no such deployment' });
  await assert.rejects(t.checkTranscription(), (e: Error) => {
    assert.match(e.message, /transcription 404/);
    assert.ok(!e.message.includes('sk-test-key-not-real'));
    return true;
  });
});
