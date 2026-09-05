/**
 * The frontier: four roads out of the valley, three stops each.
 *
 * These are the rules that stop a body marching at a door that is not there.
 * The world opened the frontier on 2026-08-22 and the harness met it knowing
 * one room of one path; worse, its level gate had been dead so long that a
 * zone sealed off months ago was still listed as open. Every case below is
 * checked against upstream's own authored table, so a world that moves a
 * room or a level breaks a test rather than a character.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fieldsFor, frontierOpenTo, frontierPathTo, nextDoorToward as doorFor } from '../dist/harness/reflex.js';

const TOWN = 'the-valley';
const STAIR = 'millers-stair';

/** Upstream's recommended levels, deploy/world/frontier-progression.mjs. */
const STOPS = [
  ['millrace-ford', 10], ['oathstone', 18], ['sinkfoot-crossing', 26],
  ['widows-watch', 35], ['reed-camp', 45], ['bleaching-flats', 55],
  ['grey-reeds', 65], ['salt-vein', 75], ['driftwood-landing', 85],
  ['caravan-rest', 92], ['last-farm', 100]
];

test('an unknown level opens the stair and nothing else', () => {
  // This is the honest answer, not a degraded one: the stair is the one
  // room reachable at level 1, so a body that cannot read its level loses
  // nothing by grinding there.
  assert.deepEqual(fieldsFor(null), [STAIR]);
});

test('each stop opens for travel at its own level and not before', () => {
  for (const [room, level] of STOPS) {
    if ('widows-watch' === room) {
      continue;
    }
    assert.ok(!frontierOpenTo(level - 1).includes(room), `${room} opened early`);
    assert.ok(frontierOpenTo(level).includes(room), `${room} did not open at ${level}`);
  }
});

test('the hunting rotation stays on the stair, whatever the level', () => {
  // topFields() hunts the two HIGHEST rooms in fieldsFor(), so anything
  // added here does not widen the rotation, it replaces it. The stair is
  // recommended level 1 and holds 150hp enemies; the frontier's third stop
  // holds 1344hp ones. Being allowed into a room is not a reason to grind
  // it - see the note in fieldsFor().
  for (const level of [null, 1, 26, 35, 100, 999]) {
    assert.deepEqual(fieldsFor(level), [STAIR], `level ${level} left the stair`);
  }
});

test("Widow's Watch never opens, however high the level", () => {
  // The one authored quest gate in the world: the door wants a roadmender's
  // mark. Offering it would send a body to be refused.
  for (const level of [35, 50, 100, 999]) {
    assert.ok(!frontierOpenTo(level).includes('widows-watch'));
    assert.ok(!fieldsFor(level).includes('widows-watch'));
  }
});

test('nothing offered, to hunt or to travel, is unreachable from the valley', () => {
  // The grassland sat in the hunting list for months behind a level gate
  // that could never fire, on the far side of a road sealed in 54dc0823.
  // Restoring the level read would have armed it; 999 was a sentinel for
  // "never" that a level of 999 defeats, so closed zones now say Infinity.
  const reachable = new Set([STAIR, ...STOPS.map(([room]) => room)]);
  for (const level of [1, 20, 26, 35, 60, 100, 999]) {
    for (const room of [...fieldsFor(level), ...frontierOpenTo(level)]) {
      assert.ok(reachable.has(room), `${room} is not reachable from the valley`);
    }
  }
  assert.ok(!fieldsFor(999).includes('arena-grassland'));
});

test('a path is staged room by room, valley-side first', () => {
  assert.deepEqual(frontierPathTo('millrace-ford'), ['millrace-approach', 'millrace-ford']);
  assert.deepEqual(frontierPathTo('last-farm'),
    ['sinkfoot-crossing', 'grey-reeds', 'last-farm']);
  assert.deepEqual(frontierPathTo('salt-vein'), [STAIR, 'widows-watch', 'salt-vein']);
  assert.deepEqual(frontierPathTo('the-valley'), []);
});

test('the door out of the valley is the head of that room\'s own path', () => {
  assert.equal(doorFor(TOWN, 'oathstone'), 'oathstone');
  assert.equal(doorFor(TOWN, 'caravan-rest'), 'oathstone');
  assert.equal(doorFor(TOWN, 'millrace-ford'), 'millrace-approach');
  assert.equal(doorFor(TOWN, 'last-farm'), 'sinkfoot-crossing');
  assert.equal(doorFor(TOWN, 'salt-vein'), STAIR);
});

test('a body out on the frontier walks onward or back, never sideways', () => {
  // Further along the same path is the onward door; anything on another
  // path is reached by walking home first, because no door joins two paths.
  assert.equal(doorFor('oathstone', 'caravan-rest'), 'bleaching-flats');
  assert.equal(doorFor('bleaching-flats', 'caravan-rest'), 'caravan-rest');
  assert.equal(doorFor('bleaching-flats', 'oathstone'), 'oathstone');
  assert.equal(doorFor('grey-reeds', 'millrace-ford'), 'sinkfoot-crossing');
  assert.equal(doorFor('reed-camp', TOWN), 'millrace-ford');
});

test('every frontier room can find its way home', () => {
  // Walking the back doors from any stop has to terminate at the valley.
  for (const [room] of STOPS) {
    let at = room;
    const seen = new Set();
    for (let hop = 0; hop < 10 && at !== TOWN; hop += 1) {
      assert.ok(!seen.has(at), `${room} loops at ${at}`);
      seen.add(at);
      at = doorFor(at, TOWN);
    }
    assert.equal(at, TOWN, `${room} never reaches the valley`);
  }
});
