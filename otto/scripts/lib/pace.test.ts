// node --test otto/scripts/lib/pace.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Tts } from './tts.ts';

const make = (env: Record<string, string | undefined> = {}) => {
  for (const k of ['TTS_SPEED', 'TTS_SPEED_EN', 'TTS_SPEED_FI']) delete process.env[k];
  Object.assign(process.env, { TTS_PROVIDER: 'none' }, env);
  return new Tts(mkdtempSync(join(tmpdir(), 'otto-pace-')));
};
const LINE = 'Acceptance criterion 1. A new task can be given the priority Low, Normal or High.';

test('English reads at the normal rate and Finnish a little slower, unless set', () => {
  assert.equal(make().speedFor('en'), 1);
  assert.equal(make().speedFor('fi'), 0.92);
  assert.equal(make({ TTS_SPEED: '0.9' }).speedFor('en'), 0.9);
  assert.equal(make({ TTS_SPEED: '0.9', TTS_SPEED_FI: '1.05' }).speedFor('fi'), 1.05);
});

test('a take that drags is slow; a normal one is not', () => {
  const t = make();
  assert.ok(t.slow(LINE, 8900, 'en'), 'the slow take from the sample video');
  assert.ok(!t.slow(LINE, 6400, 'en'), 'a normal take of the same line');
});

test('short headings are never judged, since they are always read slowly', () => {
  assert.ok(!make().slow('Acceptance criterion 2.', 2200, 'en'));
});

test('the limit follows the speed: a calmer setting allows a calmer take', () => {
  assert.ok(make({ TTS_SPEED_EN: '1.0' }).slow(LINE, 7800, 'en'));
  assert.ok(!make({ TTS_SPEED_EN: '0.8' }).slow(LINE, 7800, 'en'));
});
