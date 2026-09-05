/**
 * The seam walk asks for a ROAD, not a straight line at the seam.
 *
 * This file used to pin a geometric detour - sidesteps, held sides, blended
 * headings - and every version of that failed against a real wall. The record
 * is kept because it is the argument for what replaced it, all measured live
 * on 2026-09-02 in Miller's Stair:
 *
 *   straight only          "no progress in 12 beats, the road does not go through"
 *   sidestep, alternating  tile(28,39)/(28,45)/(28,39) - paced on the spot
 *   sidestep, held 4 beats tile 28 -> 54, then 137 -> 166 tiles - overshot
 *   sidestep, blended      159 -> 167 tiles, 11 beats without progress
 *
 * All four were guesses standing in for a fact already in memory: the room's
 * collision grid, which `arena_walkable_grid` returns whole and the harness
 * caches per room. The search over it is tested in
 * `the-grid-already-knew-the-way.test.mjs`; what THIS file holds is that the
 * errand actually asks for it - that it emits `route_to` aimed at the seam
 * itself, rather than a clamped point 400px away that no router ever sees.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KnightsRound } from '../dist/harness/reflex.js';

const FIELD = 'millers-stair';
const CALM = { damage: 0, died: false, aggressors: 0, landed: false };
const TOOLED = ['chipped pickaxe', 'foraging knife', 'fishing rod', 'knight greatblade'];
// Sir Qwen's sheet WITHOUT fishing: the forage trip to millrace-ford is
// checked before the seam block and would win every beat here. In the live
// world the same fall-through happens for real, because the ford's road
// self-barred on a locked door ("needs tansys_road_writ").
const MINER = ['mining', 'foraging', 'smelting', 'blacksmithing', 'cooking'];
// SEAMS_UNDERFOOT['millers-stair'] - the two mining nodes, in pixels.
const SEAMS = [{ x: 5792, y: 10976 }, { x: 5856, y: 11168 }];

function knight() {
  return new KnightsRound({
    battleStyle: 'melee', skillLadder: [], professions: MINER,
    healSpell: 'heal', foragingTrip: true,
    shopRoom: 'the-valley-smithy', shopKeeper: 'Nerys'
  });
}

/** Beats from a body that never moves - what a wall looks like from here. */
function againstAWall(beats = 40) {
  const it = knight();
  const at = { room: FIELD, x: 400, y: 400, level: 46, mp: { value: 0, total: 200 } };
  const acts = [];
  const said = [];
  const real = console.log;
  console.log = (...parts) => {
    const line = parts.join(' ');
    if (line.startsWith('[seam]')) {
      said.push(line);
    }
  };
  try {
    for (let i = 0; i < beats; i += 1) {
      const step = it.next(FIELD, CALM, { value: 836, total: 836 }, null, at,
        null, null, null, 10, 0, TOOLED, 2168670, 0, []);
      acts.push(step);
      it.completed(step, true, 'ok - got there');
    }
  } finally {
    console.log = real;
  }
  return { acts, said };
}

test('the errand does set out, so this file is testing the real walk', () => {
  const { said, acts } = againstAWall(12);
  assert.ok(said.some((l) => /setting off for the mining seam/.test(l)),
    `the seam walk must actually start or the rest proves nothing - [seam] said:`
    + ` ${JSON.stringify(said)}`);
  assert.ok(acts.length > 0, 'and it must produce beats');
});

test('it asks for a road, not a straight line', () => {
  const { acts } = againstAWall();
  const walking = acts.filter((a) => 'route_to' === a.action || 'go_to' === a.action);
  assert.ok(walking.length > 0, 'the errand must spend beats walking');
  assert.ok(walking.some((a) => 'route_to' === a.action),
    'a walk across a 192x176 room has to go through the grid search, or it is'
    + ' the same straight line that failed four times'
    + ` - saw ${walking.map((a) => a.action).join(', ')}`);
});

test('and it aims at the seam itself, not a clamped point near it', () => {
  // THIS IS THE WHOLE POINT. The old code walked to `ownLoc + clamp(400)`,
  // so any router downstream only ever saw a destination a few tiles away -
  // never the wall, never the room. Handing over the true coordinates is what
  // lets the search find the way round.
  const { acts } = againstAWall();
  const routed = acts.filter((a) => 'route_to' === a.action);
  assert.ok(routed.length > 0, 'need a routed beat to judge');
  for (const step of routed) {
    const [x, y] = String(step.target).split(',').map(Number);
    assert.ok(SEAMS.some((s) => s.x === x && s.y === y),
      `route_to must carry a seam's own coordinates, got ${step.target}`);
  }
});

test('the stall guard still ends a walk that is truly boxed in', () => {
  // Routing must not become a way to walk for ever: a body that cannot move
  // at all still has to give the beat back.
  const { said } = againstAWall(60);
  assert.ok(said.some((l) => /gave up the walk/.test(l)),
    `a boxed-in walk must still end - [seam] said:\n${said.join('\n')}`);
});
