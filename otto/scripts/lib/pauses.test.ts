// node --test otto/scripts/lib/pauses.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capPauseSamples, capPauses } from './pauses.ts';

const RATE = 48000;
const tone = (ms: number) => Int16Array.from({ length: (RATE * ms) / 1000 }, (_, i) => Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / RATE)));
const quiet = (ms: number) => new Int16Array((RATE * ms) / 1000);
const join16 = (...parts: Int16Array[]) => { const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const ms = (a: Int16Array) => Math.round((a.length / RATE) * 1000);

test('a long pause between words is shortened to the limit', () => {
  const r = capPauseSamples(join16(tone(500), quiet(1200), tone(500)), RATE, 1, 400);
  assert.equal(ms(r.samples), 1400);
  assert.equal(r.removedMs, 800);
});

test('short pauses, and quiet at the start and end, are left alone', () => {
  const input = join16(quiet(300), tone(400), quiet(350), tone(400), quiet(600));
  const r = capPauseSamples(input, RATE, 1, 400);
  assert.equal(r.removedMs, 0);
  assert.equal(r.samples, input);
});

test('every long pause is shortened, and the speech itself is kept whole', () => {
  const r = capPauseSamples(join16(tone(300), quiet(900), tone(300), quiet(700), tone(300)), RATE, 1, 400);
  assert.equal(ms(r.samples), 300 * 3 + 400 * 2);
  const loud = r.samples.filter((s) => Math.abs(s) > 1000).length;
  assert.ok(loud > tone(900).filter((s) => Math.abs(s) > 1000).length * 0.98, 'no speech was cut');
});

test('a WAV file is rewritten in place with the right header', () => {
  const dir = mkdtempSync(join(tmpdir(), 'otto-pauses-'));
  const path = join(dir, 'clip.wav');
  const samples = join16(tone(400), quiet(1000), tone(400));
  const data = Buffer.from(samples.buffer);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVEfmt ', 8); head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(RATE, 24); head.writeUInt32LE(RATE * 2, 28);
  head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write('data', 36); head.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([head, data]));
  const r = capPauses(path, 400);
  assert.equal(r.durationMs, 1200);
  const out = readFileSync(path);
  assert.equal(out.readUInt32LE(40), (RATE * 1200 * 2) / 1000, 'data chunk size');
  assert.equal(out.readUInt32LE(4), out.length - 8, 'RIFF size');
});
