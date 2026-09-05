/**
 * A shopping trip has to be justified by a level-up.
 *
 * A ladder only opens a new rung when the level rises, so a body that has
 * already stood at the counter at this level has nothing to go back for.
 * Going back anyway is how a town loop starts, and this one was measured:
 * Sir Qwen logged 251 restock legs, 251 resting legs and 82 smithy entries
 * against TWO trips to the field, across two hours and six minutes. He is
 * level 35, the top rung of both ladders is level 35, he wears the weapon,
 * and no counter in the world stocks the armour - so not one of those trips
 * could have ended in a purchase.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KnightsRound, SWORD_GEAR, SWORD_ARMOR } from '../dist/harness/reflex.js';

const FIELD = 'millers-stair';
const SHOP = 'the-valley-smithy';
const QUIET = { damage: 0, died: false, aggressors: 0, landed: false };
/** The pilgrimage caches; deliberately NOT the gear, so a rung is wanted. */
const CACHES = ['cup helm', 'grips', 'boots', 'saltguard'];

const round = () => new KnightsRound({
  battleStyle: 'close_up',
  gearLadder: SWORD_GEAR,
  armorLadder: SWORD_ARMOR,
  shopRoom: SHOP,
  shopKeeper: 'Nerys'
});

const tick = (it, scene, level, carried = CACHES) => it.next(
  scene, QUIET, { value: 600, total: 644 }, null,
  { room: scene, x: 2320, y: 2320, level, mp: { value: 200, total: 202 } },
  null, null, null, 8, 2, carried, 32103, 2, []
);

/** Run the round in the shop until it has counted its trip for this level. */
const shopOnce = (it, level) => {
  for (let beat = 0; beat < 30; beat += 1) {
    // Re-assert the leg each beat: the round is free to move itself on, and
    // what is being set up here is the arrival at the counter, not a path.
    it.leg = 'restock';
    tick(it, SHOP, level);
  }
};

test('a body that has not shopped at this level still goes', () => {
  const it = round();
  it.leg = 'outbound';
  tick(it, FIELD, 35);
  assert.equal(it.plan().leg, 'homebound',
    'an unowned rung did not pull the body to town at all');
});

test('a second trip at the same level is refused', () => {
  const it = round();
  shopOnce(it, 35);
  it.leg = 'outbound';
  tick(it, FIELD, 35);
  assert.notEqual(it.plan().leg, 'homebound',
    'went back to the counter at a level it had already shopped at');
});

test('a level-up opens the counter again', () => {
  // The gate must clear itself, or a rung added at a higher level is never
  // bought. Keyed on the level, not on a flag that needs resetting.
  const it = round();
  shopOnce(it, 35);
  it.leg = 'outbound';
  tick(it, FIELD, 36);
  assert.equal(it.plan().leg, 'homebound',
    'a level-up did not re-open the counter');
});

test('a body that has never read a level is still allowed its trip', () => {
  // null is the state the world leaves a body in when the sheet cannot be
  // read at all. Refusing the trip then would strand a genuinely
  // under-geared character at whatever it happened to be wearing.
  const it = round();
  it.leg = 'outbound';
  tick(it, FIELD, null);
  assert.equal(it.plan().leg, 'homebound');
});

test('a level once read is not forgotten when a tick omits it', () => {
  // levelNow is remembered across ticks, so a single reading that arrives
  // without a level must not re-open a counter the body has already visited.
  const it = round();
  shopOnce(it, 35);
  it.leg = 'outbound';
  tick(it, FIELD, null);
  assert.notEqual(it.plan().leg, 'homebound',
    'one blank reading re-opened a counter that was already visited');
});
