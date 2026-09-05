/**
 * A body that is dying with nothing to drink or cast does not leave the field.
 *
 * The measured pair, same night, same character (2026-08-27):
 *
 *   death in place  01:15  last earning beat -> hunting again in 2m20s,
 *                          full hp AND mana, no detour and no coin
 *   the errand      01:43  stopped earning at 3 hp of 633, reached town at
 *                          01:44:33, bought nothing, rested nothing, was
 *                          back in the field at 01:46:18 STILL at 3, fought
 *                          on for a minute and died anyway. Six to seven
 *                          minutes not earning.
 *
 * Three times the cost for the same death. The first guard sat on the two
 * triggers someone had named and a third walked around it, so the rule now
 * sits at the chokepoint every road to town passes through and asks about
 * the OUTCOME instead: is this body leaving a FIGHT to heal NOTHING.
 *
 * The second test here is the positive control, and it is the half that
 * makes the first one mean anything: a healthy body on the same inputs must
 * still be allowed to go. Without it, a guard that simply never let anyone
 * leave would pass just as well.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KnightsRound, CASTER_GEAR, CASTER_ARMOR } from '../dist/harness/reflex.js';

const FIELD = 'millers-stair';
const KITTED = ['cowl', 'gloves', 'crystal focus', 'sepulchral vestment'];

// A Magus: no heal spell, no conjured meal, and below the potion drawer's
// price all night. This is exactly the empty medicine cabinet the trip in
// the log walked two and a half minutes to stand in front of.
function magus() {
  return new KnightsRound({
    battleStyle: 'long_range',
    drainSpell: 'drainLife',
    skillLadder: [{ level: 0, skill: 'arcaneRay' }, { level: 1, skill: 'attackBullet' }],
    gearLadder: CASTER_GEAR,
    armorLadder: CASTER_ARMOR,
    shopRoom: 'the-valley-mage',
    shopKeeper: 'Wren',
    partner: 'Sir Qwen'
  });
}

// Quiet field, full bag, real coin - everything a bank run wants. The only
// thing that changes between the two tests is the health bar.
function walk(round, hpValue) {
  const calm = { damage: 0, died: false, aggressors: 0, landed: false };
  const legs = [];
  // The field lock holds a body until it has actually gained a level, so the
  // first level establishes the toll and the second pays it.
  for (const level of [42, 42, 43, 43, 43, 43, 43, 43]) {
    round.next(
      FIELD, calm, { value: hpValue, total: 633 }, null,
      { room: FIELD, x: 2320, y: 640, level, mp: { value: 205, total: 205 } },
      null, null, null, 60, 0, KITTED, 968880, 0,
      [{ key: 'grub_hide', quantity: 60 }]
    );
    legs.push(round.plan().leg);
  }
  return legs;
}

test('at half of one percent, with no medicine, he stays and fights', () => {
  const legs = walk(magus(), 3);
  assert.ok(!legs.includes('homebound'),
    `no road to town may open at 3 hp of 633 - saw ${legs.join(' -> ')}`);
  assert.ok(!legs.includes('restock') && !legs.includes('resting'),
    `and none of the legs that follow one - saw ${legs.join(' -> ')}`);
});

test('POSITIVE CONTROL: the same body at full health is still allowed to go', () => {
  const legs = walk(magus(), 633);
  assert.ok(legs.includes('homebound'),
    `a guard that never lets anyone leave would pass the test above for free`
    + ` - saw ${legs.join(' -> ')}`);
});
