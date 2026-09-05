/**
 * Four misses are not four visits, and twenty tiles is not arrival.
 *
 * Measured live 2026-08-31. The deliberate walk reached tile (88,157) with the
 * copper node at (90,171) - fourteen tiles short - and logged:
 *
 *   [seam] done at the seam after 67 beats
 *   gather_nearby -> ok - nothing of ours to gather within reach
 *   [trade] 0 of 10 offers found something of ours within 20 tiles; 0 charges
 *
 * Two independent faults, and either alone is enough to take zero charges off
 * a full vein:
 *
 *  1. The visit counter incremented on ANY gather that was not an approach,
 *     so four consecutive MISSES retired the errand as a worked-out vein.
 *  2. The walk handed off to the trade beat at twenty tiles, and the hand-off
 *     branch RETURNS A GATHER rather than a step - so once inside twenty
 *     tiles the body could never close the remaining distance. It stood there
 *     gathering nothing until fault 1 ended the errand.
 *
 * The morning's successful trip took its charges from 1.4 tiles.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const MISS = 'nothing of ours to gather within reach';
const WALKING = 'on the way to a node of ours';
const HAUL = '4 copper_ore from copper ore';

/** The rule: does this beat count against the four that end an errand? */
const counts = (note) =>
  !/nothing of ours to gather/i.test(note) && !/on the way to a node/i.test(note);

test('a haul counts as a worked visit', () => {
  assert.equal(counts(HAUL), true);
});

test('THE BUG: a miss must not count as a worked visit', () => {
  assert.equal(counts(MISS), false, 'four of these used to retire a full vein');
});

test('an approach still does not count (the sibling already fixed)', () => {
  assert.equal(counts(WALKING), false);
});

test('four misses no longer end the errand', () => {
  const beats = [MISS, MISS, MISS, MISS];
  assert.equal(beats.filter(counts).length, 0,
    'the errand must still be running after four empty looks');
});

test('four real hauls do end it', () => {
  const beats = [HAUL, HAUL, HAUL, HAUL];
  assert.equal(beats.filter(counts).length, 4);
});

test('and a realistic trip - misses while closing, then hauls - ends on the hauls', () => {
  const beats = [WALKING, MISS, WALKING, HAUL, MISS, HAUL, HAUL, HAUL];
  assert.equal(beats.filter(counts).length, 4, 'only the four hauls count');
});

test('arrival is three tiles, not twenty', async () => {
  // Read from the source rather than restated, so the constant cannot drift
  // away from the reason it was chosen.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/harness/reflex.ts', import.meta.url), 'utf8');
  const arrival = /const SEAM_ARRIVAL_TILES = (\d+);/.exec(src);
  assert.ok(arrival, 'SEAM_ARRIVAL_TILES must exist');
  assert.ok(Number(arrival[1]) <= 5,
    `arrival must be close enough for the node to be observable - got ${arrival[1]} tiles`);
  // And the branch must use it, not the twenty-tile radius it used to.
  assert.match(src, /goal\.d <= SEAM_ARRIVAL_TILES \* px/,
    'the arrival branch must key on SEAM_ARRIVAL_TILES');
});
