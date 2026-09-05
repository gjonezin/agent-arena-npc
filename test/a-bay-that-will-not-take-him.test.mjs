/**
 * An authored waypoint that refuses a body is set aside, like any target.
 *
 * A target that cannot be reached is shunned and the body moves on. A BAY -
 * one of the stair's thirty respawn-patch anchors, "the WALKABLE tile
 * closest to its patch's centroid" - was retried for ever, because nothing
 * on this side ever wrote down that a march at it failed.
 *
 * Measured 2026-08-27: the caller pocket's anchor took three did-not-move
 * failures in one night from the eastern approach, against one "on the way"
 * from a different approach hours earlier - and "on the way" only certifies
 * that the first leg moved, never that the body arrived. Walkable is not the
 * same as reachable-from-here, which is the same gap that let a Hollow
 * Caller 5.7 tiles away and 55 on foot pass a `reachable: true` screen.
 *
 * This is only writable at all because `goTo` stopped answering ok for a
 * walk that made no progress. Before that fix every one of these marches
 * reported success and there was nothing to count.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KnightsRound } from '../dist/harness/reflex.js';

const FIELD = 'millers-stair';
const AT = { room: FIELD, x: 3000, y: 640, level: 42, mp: { value: 205, total: 205 } };
const CALM = { damage: 0, died: false, aggressors: 0, landed: false };

function round() {
  return new KnightsRound({ battleStyle: 'long_range', skillLadder: [], partner: 'Sir Qwen' });
}

/** Play out one march: arm the advance, take the go_to, report how it went. */
function march(it, ok, note) {
  // "no enemy within the leash" is what arms the advance - the spot is
  // played out, go somewhere else in the room.
  it.completed({ action: 'attack', target: '__nearest__' }, false, 'no enemy within the leash');
  let step = it.next(FIELD, CALM, { value: 633, total: 633 }, null, AT);
  // Anything that is not the march itself is passed through untouched.
  while ('go_to' !== step.action) {
    it.completed(step, true, 'done');
    step = it.next(FIELD, CALM, { value: 633, total: 633 }, null, AT);
  }
  it.completed(step, ok, note);
  return step.target;
}

test('three refused marches set the bay aside and the body aims elsewhere', () => {
  const it = round();
  const first = march(it, false, 'did not move from tile 47,10');
  march(it, false, 'did not move from tile 47,10');
  march(it, false, 'did not move from tile 45,10');
  const after = march(it, true, 'walked');
  assert.notEqual(after, first,
    `a bay that refused three marches must not be the fourth one too (${first})`);
});

test('POSITIVE CONTROL: a bay that takes him is not set aside', () => {
  const it = round();
  const first = march(it, true, 'walked');
  march(it, true, 'walked');
  march(it, true, 'walked');
  const after = march(it, true, 'walked');
  assert.equal(after, first,
    `a working bay must stay the target, or the test above proves only that`
    + ` the march wanders on its own (${first} -> ${after})`);
});
