/**
 * A dry mana pool is worth a walk to the inn.
 *
 * Measured 2026-08-24 and the reason this exists: eleven of Sir Qwen's
 * twenty logged events in half a minute were `skill_cast_failed` on
 * thornwhip, whose condition is stats/mp >= 13 against a pool holding 0.
 * Lord Gemma is worse - a Magus whose whole ladder is arts, meleeing at the
 * 0.8 tiles her staff reaches because manaDry sends strike() past every
 * cast. Barnaby's cask restores mp to base_value for 100 copper, and both
 * carry thousands.
 *
 * The distinction this file is really guarding is between a trip that buys
 * something and a trip that does not: the same round was, on the same day,
 * walking to town to sell a bag nobody would buy. Being willing to walk is
 * not the bug; walking for nothing is.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KnightsRound, SWORD_GEAR, SWORD_ARMOR } from '../dist/harness/reflex.js';

const TOWN = 'the-valley';
const INN = 'the-valley-inn';
const QUIET = { damage: 0, died: false, aggressors: 0, landed: false };
const KITTED = ['cup helm', 'grips', 'boots', 'saltguard',
                'traveler mail', 'knight greatblade'];

const round = () => new KnightsRound({
  battleStyle: 'close_up',
  gearLadder: SWORD_GEAR,
  armorLadder: SWORD_ARMOR,
  shopRoom: 'the-valley-smithy',
  shopKeeper: 'Nerys'
});

/**
 * One tick resting in `scene`, with `mp` in the pool and `coins` in hand.
 *
 * Carrying NO draughts, deliberately. A bottle in the pack is the right
 * answer to a dry pool and the round reaches for it first, which is correct
 * and would hide everything this file is about.
 */
const rest = (it, scene, mp, coins = 9461) => {
  it.leg = 'resting';
  return it.next(
    scene, QUIET, { value: 600, total: 644 }, null,
    { room: scene, x: 2320, y: 2320, level: 35, mp: { value: mp, total: 548 } },
    null, null, null, 8, 2, KITTED, coins, 0, []
  );
};

test('a dry pool in town heads for the inn', () => {
  const it = round();
  const step = rest(it, TOWN, 0);
  assert.equal(step.action, 'use_door');
  assert.match(String(step.place ?? ''), /inn/i);
});

test('standing in the inn with a dry pool, it drinks', () => {
  const it = round();
  assert.equal(rest(it, INN, 0).action, 'drink_ale');
});

test('a full pool does not go drinking', () => {
  const it = round();
  assert.notEqual(rest(it, TOWN, 548).action, 'use_door');
  const inn = round();
  assert.notEqual(rest(inn, INN, 548).action, 'drink_ale');
});

test('an empty purse does not walk to a counter it cannot pay', () => {
  // The cask answers NOT_ENOUGH_COINS below the price, so the walk would be
  // wasted in exactly the way the sell trips were.
  const it = round();
  assert.notEqual(rest(it, TOWN, 0, 99).action, 'use_door');
});

test('it drinks once per rest, not in a loop', () => {
  // Without this a refusal - or a reading that lags a tick behind the
  // gulp - puts the body back at the cask for ever.
  const it = round();
  assert.equal(rest(it, INN, 0).action, 'drink_ale');
  assert.notEqual(rest(it, INN, 0).action, 'drink_ale');
});

test('having drunk, it leaves the inn rather than resting in it', () => {
  const it = round();
  rest(it, INN, 0);
  rest(it, INN, 0);
  assert.notEqual(it.plan().leg, 'resting');
});
