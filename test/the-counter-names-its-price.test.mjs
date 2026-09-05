/**
 * A price the model can read, from either build.
 *
 * Two things are being held at once here.
 *
 * TODAY'S BUILD (d7856af2) sends `{itemKey, quantity, display}`, where
 * `display` is the gateway's own g/s/c string. Nothing about that may change:
 * the first test pins it.
 *
 * THE MERGED BUILD (c90f9e9a, not deployed at the time of writing) deleted
 * `describeAmount` and sends the raw wire object instead - `requiredQuantity`
 * on a price, `rewardQuantity` on a payout, and no `display` at all. The old
 * code read `cost.display ?? cost.quantity`, so on that build every price the
 * model is shown would have rendered "for undefined undefined". A template
 * string type-checks perfectly with `undefined` in it, which is why this
 * needs a test rather than the compiler.
 *
 * The third test is the one that would have caught the older bug: quantities
 * are COPPER and our ladders are coins, so 19000 copper is 190 coins, and it
 * had been printing "19000 coins" after every sale.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moneyText, formatCopper } from '../dist/harness/actions.js';

test('the build we are on: the gateway formatted it, so say what it said', () => {
  assert.equal(
    moneyText({ itemKey: 'coins', quantity: 19000, display: '1g 90s' }),
    '1g 90s'
  );
});

test('the build we are not on yet: no display, and the quantity moved', () => {
  // The exact shape from vendor/reldens-types exchange.d.ts on c90f9e9a.
  const price = { requiredItemKey: 'coins', requiredQuantity: 19000 };
  const said = moneyText(price);
  assert.equal(said, '1g 90s');
  assert.ok(!String(said).includes('undefined'), 'a price must never read "undefined"');
});

test('a payout carries its quantity under a third name again', () => {
  assert.equal(moneyText({ rewardItemKey: 'coins', rewardQuantity: 500 }), '5s');
});

test('copper is not coins: 19000 copper is 190 coins, not nineteen thousand', () => {
  // The 100x error that reached the model in every trade note.
  assert.equal(formatCopper(19000), '1g 90s');
  assert.notEqual(formatCopper(19000), '19000 coins');
});

test('the server\'s own arithmetic, at the boundaries', () => {
  // currency.js: COPPER_PER_SILVER 100, COPPER_PER_GOLD 10_000.
  assert.equal(formatCopper(0), '0c');
  assert.equal(formatCopper(1), '1c');
  assert.equal(formatCopper(100), '1s');
  assert.equal(formatCopper(10_000), '1g');
  assert.equal(formatCopper(10_101), '1g 1s 1c');
});

test('a counter that named no price says so, rather than inventing one', () => {
  assert.equal(moneyText(null), null);
  assert.equal(moneyText(undefined), null);
  // Present but with no quantity anywhere: still not a number we may print.
  assert.equal(moneyText({ itemKey: 'coins' }), null);
});

test('goods are not money: an item price keeps its own units', () => {
  assert.equal(moneyText({ itemKey: 'iron_ore', quantity: 3 }), '3 iron_ore');
});

test('CONTROL: a quantity of zero is a real price, not a missing one', () => {
  // `?? ` on a falsy 0 is how the "free" rung would have gone missing.
  assert.equal(moneyText({ itemKey: 'coins', quantity: 0 }), '0c');
});
