/**
 * A caster's top rung is never the melee art, whatever order the sheet is in.
 *
 * `attackShort` is on Lord Gemma's ladder deliberately, and for the SERVER's
 * benefit only: every projectile art he owns spawns its bullet about 35px
 * toward the target, so at contact the world refuses PROJECTILE_DEAD_ZONE and
 * a grub standing on him met a caster who could not fire anything at all.
 * Putting the melee art in `use_skills` gives the server's own rotation a
 * point-blank option. `worthCasting()` keeps the harness from ever casting it.
 *
 * Adversarial review, 2026-08-27: reflex's own `earned` pick had no such
 * exclusion. It did the right thing anyway, but only by array order - at
 * levels 1-13, before boneSpear unlocks, attackBullet(1) and attackShort(1)
 * TIE, and Node's stable sort simply kept whichever the sheet listed first.
 * That is a coincidence holding up a doctrine. This pins it as an invariant:
 * reverse the ladder and the answer must not change.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KnightsRound, CASTER_GEAR, CASTER_ARMOR } from '../dist/harness/reflex.js';
import { lordgemma } from '../dist/characters/lordgemma.js';

const FIELD = 'millers-stair';
const KITTED = ['cowl', 'gloves', 'slippers', 'crystal focus', 'sepulchral vestment'];

function castsAtLevel(ladder, level, hpValue) {
  const it = new KnightsRound({
    battleStyle: lordgemma.battleStyle,
    drainSpell: lordgemma.drainSpell,
    spell: lordgemma.spell,
    skillLadder: ladder,
    gearLadder: CASTER_GEAR,
    armorLadder: CASTER_ARMOR,
    shopRoom: 'the-valley-mage',
    shopKeeper: 'Mordant Quicklime'
  });
  const hostile = { damage: 40, died: false, aggressors: 2, landed: true };
  const seen = [];
  for (let i = 0; i < 20; i += 1) {
    const intent = it.next(
      FIELD, hostile, { value: hpValue, total: 633 }, null,
      { room: FIELD, x: 2320, y: 2320, level, mp: { value: 205, total: 205 } },
      null, null, null, [], 2, KITTED, 191118, 0, []
    );
    if ('use_skill' === intent.action) {
      seen.push(intent.skill);
    }
    it.completed(intent, true, 'cast');
  }
  return seen;
}

test('the melee art is on the sheet, because the server rotation needs it', () => {
  const keys = lordgemma.skillLadder.map((rung) => rung.skill);
  assert.ok(keys.includes('attackShort'),
    'removing it re-opens the dead zone the world itself described');
});

test('at a level where the rungs tie, the melee art never wins', () => {
  // Full hp, so drainSpell (armed under 75%) does not answer instead.
  for (const level of [1, 5, 13]) {
    const forward = castsAtLevel(lordgemma.skillLadder, level, 633);
    const reversed = castsAtLevel([...lordgemma.skillLadder].reverse(), level, 633);
    assert.ok(!forward.includes('attackShort'),
      `level ${level}, sheet order: saw ${forward.join(', ')}`);
    assert.ok(!reversed.includes('attackShort'),
      `level ${level}, REVERSED order - this is the coincidence: ${reversed.join(', ')}`);
    assert.deepEqual(new Set(forward), new Set(reversed),
      `level ${level}: the pick must not depend on where a rung sits in the array`);
  }
});

test('at his real level the highest reaching rung still wins', () => {
  const casts = castsAtLevel(lordgemma.skillLadder, 42, 633);
  assert.ok(casts.includes('boneSpear'),
    `level 42 must reach for the top rung, saw ${casts.join(', ') || 'nothing'}`);
  assert.ok(!casts.includes('attackShort'), 'and never the melee art');
});
