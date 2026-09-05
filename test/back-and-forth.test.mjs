/**
 * Two drivers on one body make it glitch back and forth.
 *
 * Watched live 2026-08-24: consecutive positions from one character's log
 * reversed outright - a stretch north undone straight back south, an
 * eastward walk retraced west - and interleaving our commands with the
 * server's battle payload showed eleven of our movement calls against
 * three payloads reporting inBattle. The gateway's rule is that whatever
 * moved a body most recently owns it, and under semi_auto the server
 * chases the target itself; attack() answered every refused OUT_OF_RANGE
 * with closeOn(), so our arena_move_to cancelled the chase mid-stride, the
 * body stayed out of range, the next swing was refused, and we moved
 * again. That loop is the jitter.
 *
 * The cure must not trust the chase on its word - a stalled chase leaves a
 * body standing and swinging at nothing, which is the failure the
 * closeOn() call was written to prevent (and which the widened condition
 * of 2026-08-21 made worse, not better). Movement is suppressed only
 * while the gap measured across successive refusals is demonstrably
 * shrinking, and resumes the moment it is not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Actions } from '../dist/harness/actions.js';

class FakeArena {
  constructor(replies = [], chase = null) {
    this.replies = [...replies];
    this.calls = [];
    this.chase = chase;
  }

  async call(name, args) {
    this.calls.push({ name, args });
    if (this.replies.length === 0) {
      throw new Error(`FakeArena: no reply queued for ${name}`);
    }
    return this.replies.shift();
  }

  chaseFromBattle() {
    return this.chase;
  }
}

// Tiles included: closeOn() refuses a target the world gave no tile, and
// these tests are about whether the walk is ISSUED, not whether it lands.
const WOLF = {
  objectId: null,
  objectIndex: 'enemies7',
  label: 'a wolf',
  kind: 'enemy',
  interactable: false,
  distanceFromSelf: 300,
  tileX: 12,
  tileY: 9
};

/** The verdict shape the gateway really refuses with, distance included. */
const refusal = (tiles) => ({
  ok: false,
  reason: 'OUT_OF_RANGE',
  targetDistanceTiles: tiles,
  reachTiles: 0.8,
  note: `the target is about ${tiles} tiles away and attackShort reaches about 0.8`
});

const CHASING = { inBattle: true, mode: 'semi_auto' };

const fighter = (arena) => {
  const actions = new Actions(arena, 'agent-1', new Set(['fight']));
  actions.notices([WOLF]);
  return actions;
};

/** Everything the arena was asked for besides the swings themselves. */
const movement = (arena) => arena.calls.filter((c) => 'arena_basic_attack' !== c.name);

test('a refused swing while the server is chasing and the gap is shrinking issues no movement', async () => {
  const arena = new FakeArena([refusal(6.0), refusal(4.5)], CHASING);
  const actions = fighter(arena);
  const first = await actions.attack('a wolf');
  const second = await actions.attack('a wolf');
  assert.equal(first.ok, true, 'holding still is not a failed beat');
  assert.equal(second.ok, true);
  assert.deepEqual(
    movement(arena),
    [],
    'while the chase is measurably closing, nothing of ours may re-own the body'
  );
});

test('successive refusals with no shrink hand the walk back to us', async () => {
  const arena = new FakeArena([refusal(5.0), refusal(5.0)], CHASING);
  const actions = fighter(arena);
  await actions.attack('a wolf');
  assert.deepEqual(movement(arena), [], 'the first refusal only takes the baseline');
  await actions.attack('a wolf');
  assert.ok(
    arena.calls.some((c) => 'arena_move_to' === c.name),
    'a stalled chase must not be deferred to - we close, or the body swings at nothing'
  );
});

test('a refused swing with no battle in progress closes exactly as it does today', async () => {
  const arena = new FakeArena([refusal(4.6)], null);
  const actions = fighter(arena);
  await actions.attack('a wolf');
  assert.ok(
    arena.calls.some((c) => 'arena_move_to' === c.name),
    'no chase to defer to: the pre-existing close-on-refusal behavior stands'
  );
});

test('a mode where the server does not chase is not deferred to', async () => {
  // Standing still on the strength of a flag that promises no chase would
  // park the body out of range for as long as the flag stayed up.
  const arena = new FakeArena([refusal(4.6)], { inBattle: true, mode: 'manual' });
  const actions = fighter(arena);
  await actions.attack('a wolf');
  assert.ok(arena.calls.some((c) => 'arena_move_to' === c.name));
});

test('a verdict that carries no distance is not taken as a working chase', async () => {
  // "Demonstrably" means measured. A refusal without a gap cannot show the
  // chase shrinking anything, so it does not get the benefit.
  const arena = new FakeArena([{ ok: false, reason: 'OUT_OF_RANGE' }], CHASING);
  const actions = fighter(arena);
  await actions.attack('a wolf');
  assert.ok(arena.calls.some((c) => 'arena_move_to' === c.name));
});

test('the battle ending mid-watch releases the walk on the next refusal', async () => {
  // The payload nulling its battle is how a finished fight reads; a watch
  // left over from it must not keep suppressing movement.
  const arena = new FakeArena([refusal(6.0), refusal(5.0), refusal(4.0)], CHASING);
  const actions = fighter(arena);
  await actions.attack('a wolf');
  await actions.attack('a wolf');
  assert.deepEqual(movement(arena), [], 'chasing and shrinking: held');
  arena.chase = null;
  await actions.attack('a wolf');
  assert.ok(
    arena.calls.some((c) => 'arena_move_to' === c.name),
    'no battle any more, so the refusal closes as it always did'
  );
});
