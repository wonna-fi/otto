// node --test otto/scripts/lib/heard.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkHeard, fiNumber } from './heard.ts';

test('Finnish numerals in any case', () => {
  assert.equal(fiNumber('kolmeenkymmeneenviiteen'), 35);
  assert.equal(fiNumber('viidentoista'), 15);
  assert.equal(fiNumber('kahdenkymmenen'), 20);
  assert.equal(fiNumber('satakahdeksankymmentä'), 180);
  assert.equal(fiNumber('yhdeksänsataa'), 900);
  assert.equal(fiNumber('tuhannen'), 1000);
  assert.equal(fiNumber('vaiheessa'), null);
  assert.equal(fiNumber('määrä'), null);
});

test('the right case passes, also when the transcriber splits the numeral', () => {
  assert.ok(checkHeard('Tavarat pakataan kolmeenkymmeneenviiteen laatikkoon.', 'Tavarat pakataan kolmeenkymmeneen viiteen laatikkoon.', 'fi').ok);
});

test('a numeral read in the wrong case fails', () => {
  assert.ok(!checkHeard('Kahdeksantoista tuhannen ruuvin lähetys lähtee huomenna.', 'Kahdeksantoista tuhatta ruuvin lähetys lähtee huomenna.', 'fi').ok);
  assert.ok(!checkHeard('Tavarat pakataan kolmeenkymmeneenviiteen laatikkoon.', 'Tavarat pakataan, kolmekymmentäviisi laatikkoon.', 'fi').ok);
});

test('digits from the transcriber are compared by value', () => {
  assert.ok(checkHeard('Varastoon tulee kuudentoista tuhannen ruuvin lähetys.', 'Varastoon tulee 16 000 ruuvin lähetys.', 'fi').ok);
  assert.ok(!checkHeard('Varastoon tulee kuudentoista tuhannen ruuvin lähetys.', 'Varastoon tulee 60 000 ruuvin lähetys.', 'fi').ok);
});

test('one misheard ordinary word is tolerated, numbers are not', () => {
  assert.ok(checkHeard('Tavarat pakataan kolmeenkymmeneenviiteen laatikkoon.', 'Tavarat pakatan kolmeenkymmeneen viiteen laatikkoon.', 'fi').ok);
  assert.ok(!checkHeard('Pack 13 boxes on pallet 30.', 'Pack thirty boxes on pallet thirty.', 'en').ok);
  assert.ok(checkHeard('This is order 1001. Pack 13 boxes on pallet 30.', 'This is order one thousand one. Pack thirteen boxes on pallet thirty.', 'en').ok);
});

test('English UI names in Finnish narration must be heard as written', () => {
  const line = 'Vientitilaukseen tulee Customs-vaihe.';
  assert.ok(checkHeard(line, 'Vientitilaukseen tulee Customs-vaihe.', 'fi').ok);
  assert.ok(!checkHeard(line, 'Vientitilaukseen tulee kustomsivaihe.', 'fi').ok);
});

test('words that only start like Finnish numerals are not numbers; runs stop at punctuation', () => {
  for (const w of ['yhteenveto', 'yhteensä', 'yhteys', 'satama']) assert.equal(fiNumber(w), null, w);
  for (const [w, v] of [['tuhannella', 1000], ['tuhansia', 1000], ['kymmenellä', 10], ['satoja', 100], ['miljoonaa', 1e6], ['kuutta', 6]] as const) assert.equal(fiNumber(w), v, w);
  const r = checkHeard('Hyväksymiskriteeri kolme. Yhteenveto näyttää tullaustiedot.', 'Hyväksymiskriteeri 3. Yhteenveto näyttää tullaustiedot.', 'fi');
  assert.ok(r.ok, r.problems.join('; '));
});

test('a code with a number is heard as a word and a number, in words or digits', () => {
  assert.ok(checkHeard('TASK-7. Tasks now have a priority.', 'Task seven. Tasks now have a priority.', 'en').ok);
  assert.ok(checkHeard('TASK-7. Tasks now have a priority.', 'Task 7. Tasks now have a priority.', 'en').ok);
  assert.ok(checkHeard('TASK-7. Tasks now have a priority.', 'TASK-7. Tasks now have a priority.', 'en').ok);
  assert.ok(!checkHeard('TASK-7. Tasks now have a priority.', 'Task eight. Tasks now have a priority.', 'en').ok, 'the wrong number still fails');
});

test('a transcriber may write a code without its hyphen', () => {
  assert.ok(checkHeard('AB-101. Tasks now have a priority.', 'AB101. Tasks now have a priority.', 'en').ok);
  assert.ok(!checkHeard('AB-101. Tasks now have a priority.', 'AB102. Tasks now have a priority.', 'en').ok);
});

test('a number said digit by digit counts as that number', () => {
  assert.ok(checkHeard('AB-101. Tasks now have a priority.', 'AB one oh one. Tasks now have a priority.', 'en').ok);
  assert.ok(checkHeard('AB-102. Tasks now have a priority.', 'AB One O Two. Tasks now have a priority.', 'en').ok);
  assert.ok(!checkHeard('AB-101. Tasks now have a priority.', 'AB one oh two. Tasks now have a priority.', 'en').ok);
  assert.ok(checkHeard('Maija has twenty three tasks.', 'Maija has 23 tasks.', 'en').ok, 'ordinary numbers still add up');
});

test('Finnish numbers heard as digits are reported, because their case was not checked', () => {
  const line = 'Tavarat pakataan kolmeenkymmeneenviiteen laatikkoon.';
  const digits = checkHeard(line, 'Tavarat pakataan 35 laatikkoon.', 'fi');
  assert.ok(digits.ok, 'the value is right, so it passes');
  assert.equal(digits.caseUnchecked.length, 1);
  assert.deepEqual(checkHeard(line, 'Tavarat pakataan kolmeenkymmeneenviiteen laatikkoon.', 'fi').caseUnchecked, []);
});
