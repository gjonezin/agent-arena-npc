/**
 * A WALK IN PROGRESS IS NOT AN EMPTY ROOM.
 *
 * Found by adversarial review, 2026-08-27, before it ever cost a charge -
 * only because the door to the ford was locked and no trip had yet reached
 * the code path.
 *
 * `gatherNearby` iterates candidates, sticks to one, and breaks out of the
 * loop when that one needs another beat to walk to. Both that break and the
 * genuinely-empty case then left by the same line:
 *
 *     return { ok: true, note: 'nothing of ours to gather within reach' };
 *
 * `KnightsRound.completed()` reads the note against
 * /nothing of ours|gave nothing|no charges/ to decide a gather came back DRY,
 * and four dry gathers end the trip. So a node that was FOUND, was in RANGE,
 * and merely sat several beats' walk away would report itself as four empty
 * rooms and retire the errand before the body ever arrived.
 *
 * It is the same shape as the Oathstone's four half-walks - a walk being
 * mistaken for a failure - one layer further out, and it would have produced
 * the identical symptom: `gather_nearby -> ok`, no `[trade]` line, zero
 * charges, and a trip that ended itself claiming the ground was bare.
 *
 * The distinction has to survive into the NOTE, because the note is the only
 * thing the round is given to judge by.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Actions } from '../dist/harness/actions.js';
import { KnightsRound } from '../dist/harness/reflex.js';

const TILE = 64;
const QWEN = ['mining', 'foraging', 'smelting', 'blacksmithing', 'cooking'];

/** The exact test `completed()` applies to decide a gather was dry. */
const DRY = /nothing of ours|gave nothing|no charges/i;

const node = (label, tiles, objectId = 77) => ({
  objectId,
  objectIndex: `node-${objectId}`,
  label,
  kind: 'npc',
  interactable: true,
  distanceFromSelf: tiles * TILE,
  tileX: 90,
  tileY: 171
});

function rig(replies) {
  const calls = [];
  const arena = {
    calls,
    async call(name, args) {
      calls.push({ name, args });
      return replies[name] ?? {};
    },
    chaseFromBattle() { return null; }
  };
  return { actions: new Actions(arena, 'test-agent', new Set(['craft', 'walk', 'fight'])), calls };
}

/** A node in range, far enough that the beat ends mid-walk. */
function walking() {
  const { actions, calls } = rig({
    arena_move_to: {},
    arena_check_path: { reachable: true, pathTurns: [[45, 10], [90, 171]] },
    // The body has NOT arrived - it still stands where it started.
    arena_observe: { position: { x: 45 * TILE, y: 10 * TILE } }
  });
  actions.notices([node('iron ore', 6)]);
  actions.standsAt({ x: 45 * TILE, y: 10 * TILE });
  return { actions, calls };
}

test('a beat spent walking to a node does not report an empty room', async () => {
  const { actions, calls } = walking();
  const said = await actions.gatherNearby(QWEN, 12, 2);
  assert.ok(calls.some((c) => 'arena_move_to' === c.name),
    'the beat really did set off walking');
  assert.ok(!DRY.test(said.note),
    `a walk must not read as dry - the note was "${said.note}"`);
});

test('CONTROL: a genuinely empty room still says so', async () => {
  const { actions } = rig({});
  actions.notices([]);
  const said = await actions.gatherNearby(QWEN, 12, 2);
  assert.ok(DRY.test(said.note),
    `nothing there is still nothing there - the note was "${said.note}"`);
});

test('CONTROL: a node of a trade we do not have is empty, not a walk', async () => {
  const { actions } = rig({});
  actions.notices([node('iron ore', 6)]);
  const said = await actions.gatherNearby(['tailoring'], 12, 2);
  assert.ok(DRY.test(said.note),
    `not our trade is not our walk - the note was "${said.note}"`);
});

test('AND the trip does not spend its budget while the body is still walking', () => {
  // `seamGathers` retires the trip at six visits however they went. Counting
  // approach beats would burn the whole allowance before the first charge.
  const round = new KnightsRound({
    battleStyle: 'melee', skillLadder: [], professions: QWEN,
    healSpell: 'heal', foragingTrip: true,
    shopRoom: 'the-valley-smithy', shopKeeper: 'Nerys'
  });
  round.seamRun = true;
  const said = [];
  const real = console.log;
  console.log = (...p) => { const l = p.join(' '); if (l.startsWith('[seam]')) said.push(l); };
  try {
    for (let i = 0; i < 10; i += 1) {
      round.completed({ action: 'gather_nearby' }, true, 'on the way to a node of ours');
    }
  } finally {
    console.log = real;
  }
  assert.deepEqual(said, [],
    `ten beats of walking must not end the trip - saw ${said.join(' | ')}`);
});

test('CONTROL: six genuinely dry visits DO end the trip', () => {
  const round = new KnightsRound({
    battleStyle: 'melee', skillLadder: [], professions: QWEN,
    healSpell: 'heal', foragingTrip: true,
    shopRoom: 'the-valley-smithy', shopKeeper: 'Nerys'
  });
  round.seamRun = true;
  const said = [];
  const real = console.log;
  console.log = (...p) => { const l = p.join(' '); if (l.startsWith('[seam]')) said.push(l); };
  try {
    for (let i = 0; i < 10; i += 1) {
      round.completed({ action: 'gather_nearby' }, true, 'nothing of ours to gather within reach');
    }
  } finally {
    console.log = real;
  }
  assert.ok(said.some((l) => /trip done/.test(l)),
    `an actually bare patch still ends it - saw ${said.join(' | ') || 'nothing'}`);
});
