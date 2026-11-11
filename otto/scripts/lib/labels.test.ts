// node --test otto/scripts/lib/labels.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LABELS, labelsFor, looksFinnish, type Story } from './storyboard.ts';

const story: Story = { key: 'GUIDE', title: 'Running an event', acceptance: [{ id: '1', text: 'Get the code' }] };

test('a story has the default words, and a guide can say steps instead of acceptance criteria', () => {
  assert.equal(labelsFor(story, 'en').criterion, 'Acceptance criterion');
  const guide = labelsFor({ ...story, labels: { criterion: 'Step', verified: 'Covered', changes: 'You need' } }, 'en');
  assert.deepEqual([guide.criterion, guide.verified, guide.changes], ['Step', 'Covered', 'You need']);
  assert.equal(guide.of, LABELS.en.of, 'what it leaves out stays as it was');
  // Per language, like every other text in a story.
  const both = { ...story, labels: { criterion: { en: 'Step', fi: 'Vaihe' } } };
  assert.equal(labelsFor(both, 'fi').criterion, 'Vaihe');
  assert.equal(labelsFor(both, 'fi').verified, LABELS.fi.verified);
});

test('English narration that says "on" doesn\'t look Finnish, and Finnish narration still does', () => {
  for (const line of ['Click on Suggest.', 'The factory is on.', 'It goes on where it stopped.']) assert.ok(!looksFinnish(line, 'en'), line);
  for (const line of ['Tämä on uusi kenttä.', 'Paina Tallenna ja odota.']) assert.ok(looksFinnish(line, 'en'), line);
  assert.ok(looksFinnish('Kenttä on pakollinen', 'fi'));
  assert.ok(looksFinnish('Se on valmis', 'fi'), 'against Finnish, "on" still counts');
});
