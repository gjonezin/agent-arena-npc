/**
 * The field lock, and the two blocks that used to fight it.
 *
 * The rule is the user's: stay in the field and fight until you gain a
 * level. Every errand before that walks the body to the town door on the
 * western boundary and back, which is the whole of the edge-drift a
 * spectator sees as stuttering.
 *
 * The lock is implemented by forcing a travelling leg back to `hunting`.
 * That is safe only while nothing else writes the leg in the same tick, and
 * two things did: the hunting leg's own bank run sets `homebound` and
 * recurses, and its futile-strike bail sets `outbound` and recurses. Each
 * re-enters the lock, is forced back to `hunting`, and arrives at the same
 * write again with no counter moved and nothing returned. That is not a
 * slow loop, it is unbounded recursion - a RangeError, which the runner
 * catches as a reconnect, so the body never acts, never levels, and the
 * lock never lifts. A fifteen-second reconnect storm only a human can end.
 *
 * It was nearly unreachable while the lock latched once per process and was
 * spent on the first level-up. Re-arming that latch is what made it live on
 * every forest visit, and a room that drops branches fills a bag in minutes.
 * These tests hold that door shut.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { KnightsRound, SWORD_GEAR, SWORD_ARMOR } from '../dist/harness/reflex.js';

const FIELD = 'reldens-bots-forest';
const TOWN = 'reldens-town';
/** Nothing hitting us and nothing landed - the quiet the lock needs to be
 *  reached at all, since retaliation returns before the leg switch. */
const QUIET = { damage: 0, died: false, aggressors: 0, landed: false };
/** Every pilgrimage cache already owned. Without this the lock never
 *  engages: an unclaimed chest is an explicit exemption from it, which is
 *  also why this crash stayed hidden - it only goes live once the
 *  pilgrimage finishes. */
const PILGRIMAGE_DONE = ['cup helm', 'grips', 'boots', 'saltguard'];

const round = () => new KnightsRound({
  battleStyle: 'close_up',
  gearLadder: SWORD_GEAR,
  armorLadder: SWORD_ARMOR
});

const tick = (it, scene, level, carrying, coins = 0) => it.next(
  scene,
  QUIET,
  { value: 600, total: 628 },
  null,
  { room: scene, x: 2320, y: 2320, level },
  null,
  null,
  null,
  carrying,
  2,
  PILGRIMAGE_DONE,
  coins,
  2,
  []
);

/** Arrive, level up, step out to town, come back - the sequence that arms
 *  the lock afresh on the return. */
const lockedInTheFieldAgain = (it) => {
  tick(it, FIELD, 34, 5);
  tick(it, FIELD, 35, 5);
  tick(it, TOWN, 35, 5);
};

/** Working the ground rather than leaving it.
 *  Asserted on the LEG, not the action: the lock is a statement about which
 *  leg owns the tick, while the action is whatever beat the hunting cycle
 *  happened to land on. An earlier version of this checked the action and
 *  would have passed against a broken lock any tick that happened to
 *  return a strike - which is most of them. */
const stayedToWork = (it, step, why) => {
  assert.equal(it.plan().leg, 'hunting', `${why} - leg should still be hunting`);
  assert.notEqual(step.action, 'use_door', `${why} - and it must not have travelled`);
};

test('a full bag does not send a field-locked body to the bank - it keeps working', () => {
  // The crash case. A locked body with cargo over the bank threshold used
  // to set homebound, recurse into the lock, be forced back to hunting,
  // and set homebound again, for ever. Reaching any intent at all is the
  // assertion; the old code reached a RangeError instead.
  const it = round();
  lockedInTheFieldAgain(it);
  stayedToWork(it, tick(it, FIELD, 35, 60), 'a full bag must not break the lock');
});

test('an affordable upgrade does not send a field-locked body to market either', () => {
  // The same write, reached by the other trigger: a purse deep enough that
  // affordableUpgrade() wants a shopping trip.
  const it = round();
  lockedInTheFieldAgain(it);
  stayedToWork(it, tick(it, FIELD, 35, 5, 300_000), 'money is not a reason to break the lock');
});

test('the lock re-arms on every arrival, not once per process', () => {
  // It used to record the level once and never again, so after the first
  // level-up the rule was silently off for the rest of the run - and its
  // own docstring said otherwise.
  const it = round();
  lockedInTheFieldAgain(it);
  stayedToWork(it, tick(it, FIELD, 35, 60), 'pinned again at the level it arrived on');

  // Gaining a level here must release it, or the pin is permanent - which
  // is the failure the re-arm could have introduced. Allowed a few beats
  // rather than exactly one: the futile-strike bail can take the first
  // tick after the lock lifts, so pinning this to a single beat would be
  // testing the beat cycle rather than the lock.
  let left = null;
  for (let beat = 0; beat < 5 && !left; beat += 1) {
    const step = tick(it, FIELD, 36, 60);
    if ('use_door' === step.action) {
      left = step;
    }
  }
  assert.ok(left, 'a level gained since arriving lifts the lock and the held bank run finally goes');
});

test('the lock lets go once the body is out of the field', () => {
  // The clear lives in next() rather than in mayLeaveField(), because that
  // helper only ever runs while already standing in the field - any
  // have-I-left test asked there is answered "no" by construction.
  const it = round();
  tick(it, FIELD, 34, 5);
  const away = tick(it, TOWN, 34, 5);
  assert.ok(away, 'a tick spent elsewhere is served normally');
  // Back at the same level: armed again, so still pinned rather than
  // carrying a spent latch that would wave every errand through.
  stayedToWork(it, tick(it, FIELD, 34, 60), 'the toll is owed again on the next visit');
});

test('a follower pinned in the forest while the leader works elsewhere does not run away with itself', () => {
  // The third instance of the same fight, and the one still live when it
  // was found: the lock forces 'hunting', the top-field check sees the
  // forest is not the leader's room and answers 'outbound', the lock
  // forces it back. A follower's top fields ARE the leader's room alone,
  // so this needs no unusual world state - just a leader working the
  // grassland. Its trigger is a leader RESTART, which leaves a stale
  // destination behind and is exactly what a staggered deploy does.
  const her = new KnightsRound({
    battleStyle: 'long_range',
    gearLadder: SWORD_GEAR,
    partner: 'Sir Qwen',
    role: 'follower'
  });
  const leaderWorkingTheGrassland = { leg: 'hunting', dest: 'arena-grassland', scene: 'arena-grassland' };
  her.next(FIELD, QUIET, { value: 400, total: 500 }, null,
    { room: FIELD, x: 2320, y: 2320, level: 34 }, leaderWorkingTheGrassland,
    null, null, 5, 2, PILGRIMAGE_DONE, 0, 2, []);
  // Rally now stale - the leader restarted and publishes nothing.
  const step = her.next(FIELD, QUIET, { value: 400, total: 500 }, null,
    { room: FIELD, x: 2320, y: 2320, level: 34 }, null,
    null, null, 60, 2, PILGRIMAGE_DONE, 0, 2, []);
  assert.ok(step && step.action, 'reached an intent rather than a RangeError');
  assert.notEqual(step.action, 'use_door', 'a locked follower has nowhere to go and should work where it stands');
});

test('dying outside town is one death, not a leg-rewriting loop', () => {
  // `died` stays true while the feed reports it, and the death branch sits
  // above the leg switch - so every re-entry used to rewrite the leg to
  // 'resting', which out of town answers 'homebound' and recurses straight
  // back into it. Quiet in practice only because the world usually carries
  // the body home before the harness reads the death; the gateway sets its
  // flag synchronously while the room follow is async, and a read inside
  // that window is a guaranteed reconnect storm. Predates this batch.
  // NO POTIONS AND NO DRAUGHTS, and that is the whole test. With any in
  // the bag the round drinks one on a zeroed health bar and returns before
  // the death branch is ever reached - so an earlier version of this test
  // passed just as happily against the bug it was written to catch.
  const it = round();
  const justDied = { damage: 99, died: true, aggressors: 0, landed: false };
  const step = it.next(FIELD, justDied, { value: 0, total: 628 }, null,
    { room: FIELD, x: 2320, y: 2320, level: 34 }, null,
    null, null, 5, 0, PILGRIMAGE_DONE, 0, 0, []);
  // Not asserting on "it did not throw": the depth guard now catches this
  // runaway too, so that passes with the latch removed and proves nothing.
  // THE LEG IS THE PRIMARY SIGNAL - a runaway leaves it at homebound,
  // rewritten on every re-entry, while a handled death settles at looting.
  // That assertion stands on its own if the guard's escape action ever
  // changes. The 'wait' check below is corroboration, not the test.
  assert.equal(it.plan().leg, 'looting', 'the leg settled rather than being rewritten every re-entry');
  assert.notEqual(step.action, 'wait', 'and it never fell through to the runaway guard');
});
