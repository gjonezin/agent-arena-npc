/**
 * The shrine went dark because a type annotation was believed.
 *
 * Measured live 2026-08-31: Lord Gemma walked to Ossian twice at 30% and then
 * 9% health, stood at gap 0.00, and asked six times a trip. Every ask came
 * back `value.trim is not a function`; after the second empty trip the errand
 * ledger disabled shrine trips for the run, and he sat at 56/646 with no heal
 * in a room full of grubs.
 *
 * `matchOption` declared its options `Record<string, string>` and called
 * `.trim()` on the value. The gateway sent something else. Nothing checked,
 * because an annotation is not a check.
 *
 * The two silent cases matter as much as the throwing one. `offered.join()`
 * and `String(label)` would not have thrown at all - they would have shown
 * the model "[object Object]" and then sent that back as its answer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { optionText, readableOptions } from '../dist/harness/actions.js';

test('a string option is itself, untouched', () => {
  assert.equal(optionText('Kneel and be made whole'), 'Kneel and be made whole');
});

test('the shape that threw: a labelled object reads as its label', () => {
  assert.equal(optionText({ label: 'Kneel and be made whole' }), 'Kneel and be made whole');
  assert.equal(optionText({ text: 'Ask for a mend' }), 'Ask for a mend');
  assert.equal(optionText({ title: 'Kneel' }), 'Kneel');
});

test('an option we cannot read is dropped, never shown as [object Object]', () => {
  const said = optionText({ nothing: { useful: true } });
  assert.equal(said, null);
  assert.ok(!String(said).includes('[object'), 'the model must never be offered [object Object]');
});

test('readableOptions keeps what it can read and drops what it cannot', () => {
  const options = readableOptions({
    heal: { label: 'Kneel and be made whole' },
    riddle: 'Ask about the candle',
    broken: { some: 'shape' }
  });
  assert.deepEqual(options, { heal: 'Kneel and be made whole', riddle: 'Ask about the candle' });
});

test('THE REGRESSION: a non-string option must not throw', () => {
  // This is the exact failure, reduced: the old code did value.trim().
  assert.doesNotThrow(() => readableOptions({ heal: { label: 'Kneel' }, other: 42 }));
  const options = readableOptions({ heal: { label: 'Kneel' }, other: 42 });
  // And every surviving value must be a real string, because everything
  // downstream - join(), String(), trim() - still assumes one.
  for (const value of Object.values(options)) {
    assert.equal(typeof value, 'string');
  }
});

test('the healing option is still findable once normalised', () => {
  // takeBlessing looks for the `heal` key first, then any label that reads
  // like mending. Both must work on the normalised map.
  const options = readableOptions({ heal: { label: 'Kneel and be made whole' } });
  const entries = Object.entries(options);
  const byKey = entries.find(([key]) => 'heal' === key.trim().toLowerCase());
  assert.ok(byKey, 'the heal key survives normalisation');
  const HEALING = /heal|bless|kneel|restore|mend|renew|whole/i;
  assert.ok(entries.find(([, text]) => HEALING.test(String(text))), 'and so does the wording');
});

test('CONTROL: nothing offered stays nothing offered', () => {
  assert.deepEqual(readableOptions(null), {});
  assert.deepEqual(readableOptions(undefined), {});
  assert.deepEqual(readableOptions({}), {});
});

test('a numeric option is a string, not a dropped one', () => {
  assert.equal(optionText(0), '0');
  assert.equal(optionText(42), '42');
});
