/**
 * A sweep has to end even when it is working.
 *
 * `lootMisses` ends a sweep when the floor is BARE. Nothing ended one when the
 * floor was endless, and Miller's Stair is endless: every grub drops coin, so
 * every stoop succeeded, the miss counter never reached three, and the leg
 * never came back.
 *
 * Measured on Sir Qwen across a four-hour log: 1,904 rounds in `looting`
 * against 5 in `hunting`, and not one in `resting` - which is the only place
 * the cask that refills his mana is reachable from. He sat at 44% hp with 1 mp
 * and 191,118 copper, two mana short of a heal he has known since level 5, and
 * earned 29.0 xp/min against Lord Gemma's 56.8 for the same three hours.
 *
 * Stooping earns coin and no experience. The coin was never in question.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KnightsRound, SWORD_GEAR, SWORD_ARMOR } from '../dist/harness/reflex.js';

const FIELD = 'millers-stair';
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

const tick = (it) => it.next(
  FIELD, QUIET, { value: 600, total: 644 }, null,
  { room: FIELD, x: 2320, y: 2320, level: 35 },
  null, null, null, [], 2, KITTED, 191118, 0, []
);

/**
 * Put the body in a sweep.
 *
 * Set directly, the way this suite reaches `noteDanger` and the other
 * privates: the compiled JS has no notion of them, and driving the whole leg
 * machine here would test the travel legs rather than the sweep. The route in
 * from combat is real and unchanged - "too far to hit" past eight advances
 * sets exactly this (reflex.ts, case 'attack') - and it is 97% of Sir Qwen's
 * swings, which is how he got in.
 */
function intoTheSweep(it) {
  it.leg = 'looting';
  it.lootMisses = 0;
  it.lootRun = 0;
}

test('a floor that always pays still hands the body back to hunting', () => {
  const it = round();
  intoTheSweep(it);

  const legs = [];
  for (let i = 0; i < 40; i += 1) {
    const intent = tick(it);
    legs.push(intent.action);
    // Every stoop SUCCEEDS - that is the whole condition being tested.
    it.completed(intent, true, 'picked up 3 coins');
  }

  assert.ok(
    legs.some((a) => 'pick_up' !== a),
    'forty successful stoops in a row is the bug: the sweep must end on its own'
  );
  const stoops = legs.filter((a) => 'pick_up' === a).length;
  assert.ok(stoops < 40, `it must stop stooping eventually, took ${stoops}/40`);
});

test('the sweep is still long enough to clear what a fight drops', () => {
  // The cure must not become the disease. The pickups ARE the income - a
  // measured ~975 coins/minute of coin drops off their own kills - and an
  // earlier read of this same behaviour nearly had the sweep cut entirely.
  const it = round();
  intoTheSweep(it);

  let stoops = 0;
  for (let i = 0; i < 8; i += 1) {
    const intent = tick(it);
    if ('pick_up' === intent.action) {
      stoops += 1;
    }
    it.completed(intent, true, 'picked up 3 coins');
  }
  assert.ok(stoops >= 5, `a sweep this short would cost them income, got ${stoops}`);
});
