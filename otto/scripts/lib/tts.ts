// Narration TTS with a disk cache.
//
// Default: the Realtime API with gpt-realtime-2.1-mini (the 4o TTS models are being deprecated). Each line gets
// a one-off session that is told to speak the text word for word; the model's own audio transcript is
// compared with the text and the line is retried when they differ, because a conversational model can
// rephrase or add filler. TTS_API=speech switches to the classic /audio/speech endpoint instead.
//
//   TTS_PROVIDER=openai  wss://api.openai.com/v1/realtime?model=<TTS_MODEL>        header Authorization: Bearer OPENAI_API_KEY
//   TTS_PROVIDER=azure   AZURE_TTS_WS_URL, or {AZURE_TTS_ENDPOINT}/openai/v1/realtime?model={AZURE_TTS_DEPLOYMENT}
//                        header `api-key: AZURE_TTS_KEY` (AZURE_TTS_KEY_HEADER for API gateways)
//   TTS_PROVIDER=none    no audio; durations estimated from word count (dry runs, no key)
// Default provider: openai when OPENAI_API_KEY is set, else azure when AZURE_TTS_ENDPOINT or AZURE_TTS_WS_URL is set, else none.
// Clips are stored as 48 kHz mono 16-bit WAV under <cache>/tts/<sha>.wav with a JSON sidecar.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { checkHeard } from './heard.ts';
import { capPauses } from './pauses.ts';

export type Lang = 'fi' | 'en';
/** heard*: the independent listening check (a transcription model listens to the clip and compares it with the text). */
export type Clip = {
  wav: string | null; durationMs: number; cached: boolean; transcript?: string; match?: number;
  heard?: string; heardMatch?: number; heardOk?: boolean; heardProblems?: string[];
};

const DEFAULT_VOICE: Record<Lang, { voice: string; instructions: string }> = {
  en: {
    voice: 'marin',
    instructions:
      'You are a text-to-speech voice, not an assistant. Speak the text in the user message aloud exactly as written, word for word, in English, and nothing else: ' +
      'no greeting, no answer, no comment, no added or skipped words. Voice: a friendly, calm colleague narrating a short screen recording of a software feature, clear and unhurried.',
  },
  fi: {
    voice: 'ash', // picked by listening to all ten voices reading Finnish
    instructions:
      'Olet puhesyntetisaattori, et avustaja. Lue käyttäjän viestin teksti ääneen täsmälleen sellaisenaan, sana sanalta, suomeksi, äläkä sano mitään muuta: ' +
      'ei tervehdystä, ei vastausta, ei kommentteja, ei lisättyjä tai pois jätettyjä sanoja. Ääni: ystävällinen ja rauhallinen kollega, joka kertoo lyhyen ohjelmistoesittelyn näyttötallenteen. ' +
      'Puhu selkeää, luontevaa suomea syntyperäisen suomenpuhujan ääntämyksellä ja painotuksella. ' +
      'Tekstissä voi olla käyttöliittymän englanninkielisiä nimiä (esimerkiksi Next, Send order): lausu ne englanniksi sellaisinaan.',
  },
};

const norm = (s: string) => s.toLowerCase().normalize('NFC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean);

/** Word-level similarity 0..1 (1 - edit distance / longer length). */
export function similarity(a: string, b: string) {
  const x = norm(a), y = norm(b);
  if (!x.length && !y.length) return 1;
  const d: number[] = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= y.length; j++) {
      const tmp = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (x[i - 1] === y[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return 1 - d[y.length] / Math.max(x.length, y.length);
}

/**
 * What the listening check tells the transcriber. A prompt must not name words from the line: a named word gets
 * spelled as named whatever the voice said (a Finnicized English label came back spelled in English).
 *  - guided: an example sentence with inflected number words. gpt-transcribe then writes numbers as words more often
 *    than an instruction gets it to, so their case can be checked.
 *  - short: an instruction only. gpt-4o-transcribe treats a guided prompt as something said: on short clips it repeated
 *    the sentence or translated the line, and once accepted a wrong number.
 */
const ASR_PROMPTS = {
  guided: {
    fi: 'Kahdentoista tuhannen ruuvin lähetys lähtee tänään, ja tavarat pakataan kolmeensataanviiteenkymmeneen laatikkoon. Luvut kirjoitetaan sanoina.',
    en: 'A shipment of twelve thousand screws leaves today, packed in three hundred and fifty boxes. Numbers are written as words.',
  },
  short: { fi: 'Luvut kirjoitetaan sanoina.', en: 'Numbers are written as words.' },
};
export type AsrPrompt = keyof typeof ASR_PROMPTS | 'none';

function asrPromptFor(model: string | null): AsrPrompt {
  const set = process.env.TTS_ASR_PROMPT;
  if (set === 'guided' || set === 'short' || set === 'none') return set;
  if (set) throw new Error(`TTS_ASR_PROMPT must be guided, short or none, not "${set}"`);
  return /4o|whisper/i.test(model ?? '') ? 'short' : 'guided';
}

const wordsOf = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ');
/** Did the transcriber hand back part of its prompt? Four words in a row that the line itself doesn't have. */
function echoesPrompt(heard: string, prompt: string, text: string) {
  const line = ` ${wordsOf(text).join(' ')} `;
  const said = ` ${wordsOf(heard).join(' ')} `;
  const p = wordsOf(prompt);
  for (let i = 0; i + 4 <= p.length; i++) {
    const run = ` ${p.slice(i, i + 4).join(' ')} `;
    if (said.includes(run) && !line.includes(run)) return true;
  }
  return false;
}

/** Speaking rate per language. Finnish reads clearer a little below the model's normal rate; English at it. */
const DEFAULT_SPEED: Record<Lang, number> = { en: 1.0, fi: 0.92 };
/** Pauses inside a line longer than this are shortened (see pauses.ts). */
export const PAUSE_CAP_MS = 400;
/**
 * A take this slow (letters per second at speed 1.0, scaled by the speed in use) is tried again, like one with wrong
 * words. About three quarters of these voices' normal rate: English runs near 11, Finnish near 13. Lines of fewer than
 * six words are not judged, because a short heading such as "Acceptance criterion 2." is always read slowly.
 */
const PACE_FLOOR: Record<Lang, number> = { en: 8.5, fi: 9.5 };

export class Tts {
  readonly provider: 'openai' | 'azure' | 'none';
  readonly api: 'realtime' | 'speech';
  readonly model: string;
  /** Transcription model for the listening check, or null when it is off / not configured. */
  readonly asrModel: string | null;
  /** What the transcriber is told. Can change during a run, if a guided prompt turns out wrong for the model. */
  asrPrompt: AsrPrompt;
  /** Things about the listening check worth telling the user. */
  readonly asrNotes: string[] = [];
  private dir: string;
  calls = 0;
  asrCalls = 0;
  /** Lines whose spoken transcript still differed from the text after retries. */
  mismatches: Array<{ text: string; transcript: string; match: number }> = [];
  /** Lines where every take came out slower than PACE_FLOOR, so the best slow one was kept. */
  slowLines: string[] = [];

  constructor(cacheDir: string) {
    const p = process.env.TTS_PROVIDER as Tts['provider'] | undefined;
    this.provider = p ?? (process.env.OPENAI_API_KEY ? 'openai' : process.env.AZURE_TTS_ENDPOINT || process.env.AZURE_TTS_WS_URL ? 'azure' : 'none');
    this.api = process.env.TTS_API === 'speech' ? 'speech' : 'realtime';
    this.model = process.env.TTS_MODEL ?? (this.api === 'realtime' ? 'gpt-realtime-2.1-mini' : 'tts-1-hd');
    // Listening check: on by default with OpenAI; on Azure it needs its own transcription deployment.
    const asrOff = process.env.TTS_ASR === 'off' || this.provider === 'none' || (this.provider === 'azure' && !process.env.AZURE_ASR_DEPLOYMENT);
    this.asrModel = asrOff ? null : process.env.TTS_ASR_MODEL ?? (this.provider === 'azure' ? process.env.AZURE_ASR_DEPLOYMENT! : 'gpt-transcribe');
    this.asrPrompt = asrPromptFor(this.asrModel);
    this.dir = join(cacheDir, 'tts');
    mkdirSync(this.dir, { recursive: true });
  }

  static MAX_TAKES = 3;
  /** A take is kept without trying again when the transcriber heard it right (numbers exact, words at least 90 %) and it isn't too slow. */
  goodTake(c: Clip, text: string, lang: Lang) { return !!c.heardOk && (c.heardMatch ?? 0) >= 0.9 && !this.slow(text, c.durationMs, lang); }

  /** Speaking rate: TTS_SPEED_EN / TTS_SPEED_FI, else TTS_SPEED, else the language default. */
  speedFor(lang: Lang) {
    return Number(process.env[`TTS_SPEED_${lang.toUpperCase()}`] ?? process.env.TTS_SPEED ?? DEFAULT_SPEED[lang]);
  }

  /** Is this take clearly slower than the voice's normal pace? */
  slow(text: string, durationMs: number, lang: Lang) {
    if (text.trim().split(/\s+/).length < 6 || !durationMs) return false;
    const letters = (text.match(/\p{L}|\d/gu) ?? []).length;
    return letters / (durationMs / 1000) < PACE_FLOOR[lang] * this.speedFor(lang);
  }

  voiceFor(lang: Lang) {
    const d = DEFAULT_VOICE[lang];
    return {
      voice: process.env[`TTS_VOICE_${lang.toUpperCase()}`] ?? process.env.TTS_VOICE ?? d.voice,
      instructions: process.env[`TTS_INSTRUCTIONS_${lang.toUpperCase()}`] ?? d.instructions,
    };
  }

  /** Rough speaking time, used when there is no audio (provider none, dry runs). */
  static estimateMs(text: string, lang: Lang) {
    const words = text.trim().split(/\s+/).length;
    return Math.round(600 + words * (lang === 'fi' ? 430 : 360));
  }

  key(text: string, lang: Lang) {
    const v = this.voiceFor(lang);
    return createHash('sha256').update([this.provider, this.api, this.model, v.voice, v.instructions, String(this.speedFor(lang)), text].join('\u0000')).digest('hex').slice(0, 24);
  }

  cached(text: string, lang: Lang): Clip | null {
    if (this.provider === 'none') return { wav: null, durationMs: Tts.estimateMs(text, lang), cached: true };
    const base = join(this.dir, this.key(text, lang));
    if (existsSync(`${base}.wav`) && existsSync(`${base}.json`)) {
      const m = this.capStoredPauses(base);
      if (this.asrModel && m.heardChecked !== this.asrModel) return null; // not checked yet: synthesize() checks it
      // Re-run the check on the stored transcript, so changes to the check apply without new API calls.
      const h = this.asrModel && m.heard != null ? checkHeard(text, m.heard, lang) : null;
      const c: Clip = { wav: `${base}.wav`, durationMs: m.durationMs, cached: true, transcript: m.transcript, match: m.match, heard: m.heard,
        heardMatch: h?.score ?? m.heardMatch, heardOk: h?.ok ?? m.heardOk, heardProblems: h?.problems ?? m.heardProblems };
      if (this.asrModel && !this.goodTake(c, text, lang) && (m.takes ?? 1) < Tts.MAX_TAKES) return null; // synthesize() tries again
      return c;
    }
    return null;
  }

  private auth(): { url: string; headers: Record<string, string> } {
    if (this.provider === 'openai') {
      const key = process.env.OPENAI_API_KEY;
      if (!key) throw new Error('TTS_PROVIDER=openai needs OPENAI_API_KEY (put it in otto/.env.local)');
      const base = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
      const url = this.api === 'realtime' ? `${base.replace(/^http/, 'ws')}/realtime?model=${encodeURIComponent(this.model)}` : `${base}/audio/speech`;
      return { url, headers: { authorization: `Bearer ${key}` } };
    }
    const key = process.env.AZURE_TTS_KEY;
    const endpoint = process.env.AZURE_TTS_ENDPOINT?.replace(/\/$/, '');
    const deployment = process.env.AZURE_TTS_DEPLOYMENT ?? this.model;
    if (!key || (!endpoint && !process.env.AZURE_TTS_WS_URL)) throw new Error('TTS_PROVIDER=azure needs AZURE_TTS_KEY and AZURE_TTS_ENDPOINT (+ AZURE_TTS_DEPLOYMENT) or AZURE_TTS_WS_URL');
    const url = this.api === 'realtime'
      ? process.env.AZURE_TTS_WS_URL ?? `${endpoint!.replace(/^http/, 'ws')}/openai/v1/realtime?model=${encodeURIComponent(deployment)}`
      : `${endpoint}/openai/deployments/${deployment}/audio/speech?api-version=${process.env.AZURE_TTS_API_VERSION ?? '2025-03-01-preview'}`;
    return { url, headers: { [process.env.AZURE_TTS_KEY_HEADER ?? 'api-key']: key } };
  }

  /** Can the voice service be reached with these credentials? Opens a session and closes it; nothing is synthesized. */
  checkConnection(timeoutMs = 15000): Promise<void> {
    if (this.provider === 'none' || this.api !== 'realtime') return Promise.resolve();
    const { url, headers } = this.auth();
    const ws = new WebSocket(url, { headers } as any);
    return new Promise<void>((resolve, reject) => {
      const done = (err?: Error) => { clearTimeout(timer); try { ws.close(); } catch {} if (err) reject(err); else resolve(); };
      const timer = setTimeout(() => done(new Error(`no answer from ${new URL(url).host} in ${timeoutMs / 1000} s`)), timeoutMs);
      ws.addEventListener('error', (e: any) => {
        const cause = e?.error?.cause ?? e?.error;
        done(new Error(cause?.code ?? cause?.message ?? e?.message ?? `could not connect to ${new URL(url).host}`));
      });
      ws.addEventListener('message', (ev) => {
        const m = JSON.parse(String(ev.data));
        if (m.type === 'session.created') done();
        else if (m.type === 'error') done(new Error(m.error?.message ?? 'the service refused the session'));
      });
    });
  }

  /** What a separate transcription model hears in the clip (numbers asked as words, to expose their case). */
  async transcribe(wavPath: string, lang: Lang, text = ''): Promise<string> {
    if (!this.asrModel) throw new Error('listening check is off');
    const heard = await this.postTranscription(wavPath, lang, this.asrPrompt === 'none' ? null : ASR_PROMPTS[this.asrPrompt][lang]);
    // A deployment name doesn't tell which model is behind it, so the prompt can be wrong for it. Then the transcript
    // is the prompt and says nothing about the voice: listen again the safe way, instead of paying for a new take.
    if (this.asrPrompt === 'guided' && echoesPrompt(heard, ASR_PROMPTS.guided[lang], text)) {
      this.asrPrompt = 'short';
      this.asrNotes.push(`${this.asrModel} repeated the listening check's example sentence instead of transcribing, so the check switched to a short instruction. Set TTS_ASR_PROMPT=short to skip this.`);
      return this.transcribe(wavPath, lang, text);
    }
    return heard;
  }

  /** Does the transcription model answer? Half a second of silence finds a wrong deployment name, API version or key. */
  async checkTranscription(): Promise<void> {
    if (!this.asrModel) return;
    const samples = 8000;
    const wav = Buffer.alloc(44 + samples * 2);
    wav.write('RIFF', 0); wav.writeUInt32LE(36 + samples * 2, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
    const path = join(this.dir, 'preflight-silence.wav');
    writeFileSync(path, wav);
    try { await this.postTranscription(path, 'en', null); } finally { rmSync(path, { force: true }); }
  }

  private async postTranscription(wavPath: string, lang: Lang, prompt: string | null): Promise<string> {
    const form = new FormData();
    form.append('file', new Blob([readFileSync(wavPath)], { type: 'audio/wav' }), 'clip.wav');
    form.append('model', this.asrModel!);
    form.append('language', lang);
    if (prompt) form.append('prompt', prompt);
    let url: string;
    const headers: Record<string, string> = {};
    if (this.provider === 'openai') {
      url = `${process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'}/audio/transcriptions`;
      headers.authorization = `Bearer ${process.env.OPENAI_API_KEY}`;
    } else {
      const endpoint = (process.env.AZURE_ASR_ENDPOINT ?? process.env.AZURE_TTS_ENDPOINT ?? '').replace(/\/$/, '');
      url = `${endpoint}/openai/deployments/${process.env.AZURE_ASR_DEPLOYMENT}/audio/transcriptions?api-version=${process.env.AZURE_ASR_API_VERSION ?? '2025-03-01-preview'}`;
      headers[process.env.AZURE_TTS_KEY_HEADER ?? 'api-key'] = process.env.AZURE_ASR_KEY ?? process.env.AZURE_TTS_KEY ?? '';
    }
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(url, { method: 'POST', headers, body: form });
      if (res.ok) { this.asrCalls++; return String((await res.json()).text ?? '').trim(); }
      if (attempt >= 3 || (res.status < 500 && res.status !== 429)) throw new Error(`transcription ${res.status}: ${(await res.text()).slice(0, 200)}`);
      await new Promise((r) => setTimeout(r, 800 * attempt));
    }
  }

  /** 24 kHz mono s16le -> 48 kHz WAV; trim leading/trailing silence, short fades so clips never click, long pauses shortened. */
  private toWav(pcmPath: string, wavPath: string) {
    const ff = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', pcmPath,
      '-af', 'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.05,areverse,silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.08,afade=t=in:d=0.03,areverse,afade=t=in:d=0.02',
      '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', wavPath]);
    if (ff.status !== 0) throw new Error(`ffmpeg TTS conversion failed: ${ff.stderr}`);
    return capPauses(wavPath, PAUSE_CAP_MS).durationMs;
  }

  /** One realtime session: send the text, collect PCM16 audio and the model's transcript of what it said. */
  private realtimeOnce(text: string, lang: Lang, strict: boolean): Promise<{ pcm: Buffer; transcript: string }> {
    const { url, headers } = this.auth();
    const { voice, instructions } = this.voiceFor(lang);
    // Node's WebSocket (undici) accepts headers as a non-standard init option.
    const ws = new WebSocket(url, { headers } as any);
    const chunks: Buffer[] = [];
    let transcript = '';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ws.close(); reject(new Error('realtime TTS timed out after 60 s')); }, 60000);
      const fail = (msg: string) => { clearTimeout(timer); try { ws.close(); } catch {} reject(new Error(`realtime TTS: ${msg}`)); };
      const send = (o: unknown) => ws.send(JSON.stringify(o));
      ws.addEventListener('error', (e: any) => fail(e?.message ?? 'connection error'));
      ws.addEventListener('message', (ev) => {
        const m = JSON.parse(String(ev.data));
        switch (m.type) {
          case 'session.created':
            send({
              type: 'session.update',
              session: {
                type: 'realtime',
                output_modalities: ['audio'],
                instructions: strict ? `${instructions}\nIMPORTANT: your previous attempt changed the wording. Say only the exact text, nothing more.` : instructions,
                audio: { output: { format: { type: 'audio/pcm', rate: 24000 }, voice, speed: this.speedFor(lang) } },
              },
            });
            send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
            send({ type: 'response.create', response: { output_modalities: ['audio'] } });
            break;
          case 'response.output_audio.delta':
          case 'response.audio.delta':
            chunks.push(Buffer.from(m.delta, 'base64'));
            break;
          case 'response.output_audio_transcript.done':
          case 'response.audio_transcript.done':
            transcript = m.transcript ?? transcript;
            break;
          case 'response.done': {
            clearTimeout(timer);
            ws.close();
            const status = m.response?.status;
            if (status && status !== 'completed') return reject(new Error(`realtime TTS response ${status}: ${JSON.stringify(m.response?.status_details ?? {}).slice(0, 200)}`));
            resolve({ pcm: Buffer.concat(chunks), transcript });
            break;
          }
          case 'error':
            fail(`${m.error?.code ?? ''} ${m.error?.message ?? JSON.stringify(m).slice(0, 200)}`);
            break;
        }
      });
    });
  }

  private async speechOnce(text: string, lang: Lang): Promise<{ pcm: Buffer; transcript: string }> {
    const { url, headers } = this.auth();
    const { voice, instructions } = this.voiceFor(lang);
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, voice, input: text, instructions, response_format: 'pcm', speed: this.speedFor(lang) }),
    });
    if (!res.ok) throw new Error(`TTS ${this.provider} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return { pcm: Buffer.from(await res.arrayBuffer()), transcript: text };
  }

  /** A clip stored before pauses were shortened gets the same treatment now; its words don't change, so no new check. */
  private capStoredPauses(base: string) {
    const m = JSON.parse(readFileSync(`${base}.json`, 'utf8'));
    if (m.pausesCappedMs !== PAUSE_CAP_MS) {
      m.durationMs = capPauses(`${base}.wav`, PAUSE_CAP_MS).durationMs;
      m.pausesCappedMs = PAUSE_CAP_MS;
      writeFileSync(`${base}.json`, JSON.stringify(m, null, 2));
    }
    return m;
  }

  async synthesize(text: string, lang: Lang): Promise<Clip> {
    const hit = this.cached(text, lang);
    if (hit) return hit;
    const base = join(this.dir, this.key(text, lang));
    const { voice } = this.voiceFor(lang);
    const save = (c: Clip, extra: Record<string, unknown> = {}) => {
      writeFileSync(`${base}.json`, JSON.stringify({
        durationMs: c.durationMs, text, transcript: c.transcript, match: c.match != null ? Number(c.match.toFixed(3)) : undefined,
        heard: c.heard, heardMatch: c.heardMatch != null ? Number(c.heardMatch.toFixed(3)) : undefined, heardOk: c.heardOk, heardProblems: c.heardProblems,
        heardChecked: this.asrModel ?? undefined, lang, provider: this.provider, api: this.api, model: this.model, voice,
        speed: this.speedFor(lang), pausesCappedMs: PAUSE_CAP_MS, slow: this.slow(text, c.durationMs, lang) || undefined, ...extra,
      }, null, 2));
      return c;
    };
    const listen = async (wav: string) => {
      if (!this.asrModel) return {};
      const heard = await this.transcribe(wav, lang, text);
      const r = checkHeard(text, heard, lang);
      return { heard, heardMatch: r.score, heardOk: r.ok, heardProblems: r.problems };
    };

    // Right words first, then not too slow, then how close the words are.
    const rank = (c: Clip) => (c.heardOk ? 2 : 0) + (c.heardMatch ?? c.match ?? 0) - (this.slow(text, c.durationMs, lang) ? 1 : 0);
    let best: Clip | null = null;
    let takes = 0;
    // An existing clip (made before the check, or a take that wasn't good enough): it competes with the new takes.
    if (this.asrModel && existsSync(`${base}.wav`) && existsSync(`${base}.json`)) {
      const m = this.capStoredPauses(base);
      takes = m.takes ?? 1;
      const h = m.heardChecked === this.asrModel && m.heard != null
        ? (({ ok, score, problems }) => ({ heard: m.heard, heardMatch: score, heardOk: ok, heardProblems: problems }))(checkHeard(text, m.heard, lang))
        : await listen(`${base}.wav`);
      copyFileSync(`${base}.wav`, `${base}.try0.wav`);
      best = { wav: `${base}.try0.wav`, durationMs: m.durationMs, cached: true, transcript: m.transcript, match: m.match, ...h };
      if (this.goodTake(best, text, lang)) { renameSync(best.wav!, `${base}.wav`); return save({ ...best, wav: `${base}.wav` }, { takes }); }
    }

    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= Tts.MAX_TAKES; attempt++) {
      try {
        const r = this.api === 'realtime' ? await this.realtimeOnce(text, lang, attempt > 1) : await this.speechOnce(text, lang);
        this.calls++;
        if (!r.pcm.length) throw new Error('no audio returned');
        const tryBase = `${base}.try${attempt}`;
        writeFileSync(`${tryBase}.pcm`, r.pcm);
        const durationMs = this.toWav(`${tryBase}.pcm`, `${tryBase}.wav`);
        const match = r.transcript ? similarity(text, r.transcript) : 0.5;
        const clip: Clip = { wav: `${tryBase}.wav`, durationMs, cached: false, transcript: r.transcript, match, ...(await listen(`${tryBase}.wav`)) };
        takes++;
        if (!best || rank(clip) > rank(best)) best = clip;
        if (this.asrModel ? this.goodTake(clip, text, lang) : match >= 0.92 && !this.slow(text, durationMs, lang)) break;
      } catch (e) {
        lastErr = e as Error;
        await new Promise((res) => setTimeout(res, 700 * attempt));
      }
    }
    if (!best) throw lastErr ?? new Error('TTS failed');
    if (best.heardOk === false || (!this.asrModel && (best.match ?? 0) < 0.92)) {
      this.mismatches.push({ text, transcript: best.heard ?? best.transcript ?? '', match: best.heardMatch ?? best.match ?? 0 });
    }
    if (this.slow(text, best.durationMs, lang)) this.slowLines.push(text);
    // Keep the chosen attempt as the clip; drop the others.
    renameSync(best.wav!, `${base}.wav`);
    for (let n = 0; n <= Tts.MAX_TAKES; n++) for (const ext of ['pcm', 'wav']) rmSync(`${base}.try${n}.${ext}`, { force: true });
    return save({ ...best, wav: `${base}.wav` }, { takes });
  }

  /** Synthesize many lines with limited parallelism (prefetch before recording). */
  async prefetch(lines: Array<{ text: string; lang: Lang }>, parallel = 4) {
    const seen = new Set<string>();
    const todo = lines.filter((l) => !this.cached(l.text, l.lang) && !seen.has(l.text) && seen.add(l.text));
    let i = 0;
    const worker = async () => {
      while (i < todo.length) {
        const l = todo[i++];
        await this.synthesize(l.text, l.lang);
      }
    };
    await Promise.all(Array.from({ length: Math.min(parallel, todo.length) }, worker));
    return todo.length;
  }
}
