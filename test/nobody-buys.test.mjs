/**
 * A bank run to a world with no buyer, and a shopping trip for an item no
 * counter stocks.
 *
 * Both were live on 2026-08-24 and both looked identical from outside: a
 * knight walking to town and back without fighting, which reads as bad
 * tactics rather than as two refusals repeating. The measured loop was a
 * bag of 227 rows ordering a bank run, six "will not buy ...; it has no
 * sell price" at Nerys's counter, then the walk out again; and, on the buy
 * side, "Nerys does not sell depths_plate" - the level 35 armour that is
 * priced in combat-gear.mjs and stocked by none of the world's three
 * counters.
 *
 * Both cures are learned from the refusals rather than hardcoded, so a
 * counter that starts buying or stocking is picked up without a code change.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KnightsRound, SWORD_GEAR, SWORD_ARMOR } from '../dist/harness/reflex.js';

const FIELD = 'millers-stair';
const QUIET = { damage: 0, died: false, aggressors: 0, landed: false };
// carriedNames: the pilgrimage caches AND the mail he is already wearing.
// Without the mail, the level 15 rung reads as an unowned upgrade and pulls
// the body to town on its own, which hides whatever the level 35 rung does.
// carriedNames: the pilgrimage caches AND the kit he is already wearing.
// Sir Qwen owns the greatblade and the mail; leaving either out makes its
// rung read as an unowned upgrade, which pulls the body to town on its own
// and hides whatever the level 35 armour rung is doing.
const DONE = ['cup helm', 'grips', 'boots', 'saltguard',
              'traveler mail', 'knight greatblade'];

const round = () => new KnightsRound({
  battleStyle: 'close_up',
  gearLadder: SWORD_GEAR,
  armorLadder: SWORD_ARMOR,
  shopRoom: 'the-valley-smithy',
  shopKeeper: 'Nerys'
});

/** One tick with a bag full enough to order a bank run. */
const tick = (it, scene, carrying) => it.next(
  scene, QUIET, { value: 600, total: 644 }, null,
  { room: scene, x: 2320, y: 2320, level: 35 },
  null, null, null, carrying, 2, DONE, 29695, 2, []
);

/** Tell the round a sale was refused for want of any buyer at all. */
const refuseSale = (it, item) =>
  it.completed({ action: 'sell', item, quantity: 1 },
    false, `Nerys will not buy ${item}; it has no sell price.`);

test('a full bag stops ordering bank runs once nothing will buy', () => {
  const it = round();
  tick(it, FIELD, 60);
  // A full bag heads home while a buyer might still exist.
  assert.equal(it.plan().leg, 'homebound');

  // Both refusals together, because both happen: the bag cannot be sold
  // AND the one armour rung left cannot be bought. Either alone still
  // leaves a reason to walk to town, which is why the shuttle survived
  // fixing only the selling half.
  const again = round();
  for (const item of ['stone_maul', 'bone_shard', 'buried_skull', 'blue_currants',
                      'cave_web', 'clay_canteen', 'branch', 'driftwood']) {
    refuseSale(again, item);
  }
  again.completed({ action: 'buy', item: 'depths_plate' },
    false, 'Nerys does not sell "depths_plate".');
  again.leg = 'outbound';
  tick(again, FIELD, 60);
  assert.notEqual(again.plan().leg, 'homebound',
    'a bag that cannot be banked still ordered the walk to town');
});

test('one real sale keeps the bank run alive', () => {
  // The learning has to retire itself the moment a counter starts buying,
  // or a world Kadajett fixes stays broken for us.
  const it = round();
  for (const item of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
    refuseSale(it, item);
  }
  it.completed({ action: 'sell', item: 'cave_web', quantity: 1 }, true, 'sold');
  it.leg = 'outbound';
  tick(it, FIELD, 60);
  assert.equal(it.plan().leg, 'homebound',
    'a world with a proven buyer stopped banking');
});

test('fewer refusals than one rest stop does not trip the learning', () => {
  // A stop offers about seven keys. Tripping well below that would let one
  // odd item, or an inventory race, cancel banking in a world that buys.
  const it = round();
  for (const item of ['a', 'b', 'c']) {
    refuseSale(it, item);
  }
  it.leg = 'outbound';
  tick(it, FIELD, 60);
  assert.equal(it.plan().leg, 'homebound');
});

test('an item no counter stocks stops pulling the body to town', () => {
  // affordableUpgrade() is what sends a body to market outside the cargo
  // schedule. A rung nobody stocks must not count as an upgrade, or the
  // purse stays rich, the rung stays unowned, and the trip repeats forever.
  const wanting = round();
  wanting.leg = 'outbound';
  tick(wanting, FIELD, 8);
  assert.equal(wanting.plan().leg, 'homebound',
    'an affordable, unowned rung did not pull the body to town, so this test proves nothing');

  const told = round();
  told.completed({ action: 'buy', item: 'depths_plate' },
    false, 'Nerys does not sell "depths_plate".');
  told.completed({ action: 'buy', item: 'sepulchral_vestment' },
    false, 'Nerys does not sell "sepulchral_vestment".');
  told.leg = 'outbound';
  tick(told, FIELD, 8);
  assert.notEqual(told.plan().leg, 'homebound',
    'kept walking to town for armour the world has said nobody stocks');
});

test('a counter that buys nothing is not stood at', () => {
  // The learning has to reach the restock leg too, not only the decision to
  // leave the field. Fixing one and not the other just moved the shuttle
  // indoors: restock, six refusals, resting, restock again.
  const it = round();
  for (const item of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
    refuseSale(it, item);
  }
  it.leg = 'restock';
  for (let beat = 0; beat < 20; beat += 1) {
    const step = it.next(
      'the-valley-smithy', QUIET, { value: 600, total: 644 }, null,
      { room: 'the-valley-smithy', x: 240, y: 330, level: 35 },
      null, null, null, 60, 2, DONE, 29695, 0,
      [{ key: 'cave_web', quantity: 4 }, { key: 'branch', quantity: 9 }]
    );
    assert.notEqual(step?.action, 'sell',
      'still offering stock to a counter that has said it buys nothing');
  }
});
