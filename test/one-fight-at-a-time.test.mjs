/**
 * A fight the body did not pick, and is losing.
 *
 * Measured 2026-08-24: a single arena_basic_attack naming one scuttler
 * opened battles with two OTHERS, and the pile-on took 470 damage against
 * 364 dealt. A caster loses that exchange; a knight with 644 hp and a
 * greatblade wins it.
 *
 * So the rule reads the exchange, not the head count. Outnumbered alone must
 * not drop a fight that is going well - dropping one costs a melee body the
 * server's own chase, which is what carries a short reach into range.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KnightsRound, SWORD_GEAR, SWORD_ARMOR } from '../dist/harness/reflex.js';

const FIELD = 'millers-stair';
const KIT = ['cup helm', 'grips', 'boots', 'saltguard', 'traveler mail', 'knight greatblade'];

const round = () => new KnightsRound({
  battleStyle: 'close_up', gearLadder: SWORD_GEAR, armorLadder: SWORD_ARMOR
});

/**
 * One hunting beat: `aggressors` swinging, `damage` taken, `hp` of 644.
 *
 * Carrying NO potions, deliberately. A potion below 45% is the right first
 * answer to a low bar and the round reaches for it before anything else,
 * which would hide this rule entirely. Neither character carries one in
 * practice - the log reads "use_item food -> is carrying nothing that can
 * be used" every rest.
 */
const beat = (it, { aggressors, damage, hp }) => {
  it.leg = 'hunting';
  return it.next(
    FIELD,
    { damage, died: false, aggressors, landed: false },
    { value: hp, total: 644 },
    null,
    { room: FIELD, x: 2320, y: 2320, level: 35, mp: { value: 200, total: 202 } },
    null, null, null, 8, 0, KIT, 29695, 0, []
  );
};

test('outnumbered and losing walks away from every fight', () => {
  const it = round();
  assert.equal(beat(it, { aggressors: 3, damage: 40, hp: 200 }).action, 'disengage');
});

test('outnumbered and WINNING keeps the fight', () => {
  // The knight's case. Two on him, untouched bar: dropping this throws away
  // the chase that carries his reach into range.
  const it = round();
  assert.notEqual(beat(it, { aggressors: 3, damage: 0, hp: 644 }).action, 'disengage');
});

test('outnumbered, hurt earlier, but not taking damage now keeps the fight', () => {
  // A low bar alone is not a losing exchange - it is a bar that has not
  // healed. Only damage arriving now says the fight is going badly.
  const it = round();
  assert.notEqual(beat(it, { aggressors: 3, damage: 0, hp: 120 }).action, 'disengage');
});

test('one enemy never triggers it, however badly it is going', () => {
  // The whole point is fights the body did not pick. A single enemy is the
  // fight it chose, and the standing order is to see that one through.
  const it = round();
  assert.notEqual(beat(it, { aggressors: 1, damage: 90, hp: 60 }).action, 'disengage');
});

test('it does not thrash', () => {
  // Re-aggro on the next tick must not spend every beat disengaging. A body
  // that walks away and immediately walks away again is not fighting at all.
  const it = round();
  assert.equal(beat(it, { aggressors: 3, damage: 40, hp: 200 }).action, 'disengage');
  assert.notEqual(beat(it, { aggressors: 3, damage: 40, hp: 200 }).action, 'disengage');
});
