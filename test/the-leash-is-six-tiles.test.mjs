/**
 * THE LEASH IS SIX TILES, AND NOTHING WAS WATCHING IT.
 *
 * `LEASH_TILES` decides which enemy a body is allowed to PICK. Found by
 * mutation, 2026-08-27: setting it from 6 to 20 - the exact regression it was
 * changed to fix - left all 542 tests green. It is the default argument of
 * `chooseTarget`, `huntNearestTo` and `huntCandidates`, and every test in the
 * suite passed its own leash explicitly, so the number itself was observed by
 * nothing.
 *
 * WHY SIX. The change was a unit correction, not a policy one. Every leash in
 * actions.ts was tuned when a tile was 32 pixels everywhere, so "12 tiles"
 * meant 384 pixels of ground. The valley and the stair are 64px maps, and
 * once distances were measured correctly the same 12 quietly became twice the
 * reach it had always been.
 *
 * That is not a harmless generosity in a maze. Sir Qwen held marks at 13, 18
 * and 19.8 tiles on Miller's Stair, and neither his own walk nor the server's
 * chase ever arrived - the enemy was reachable, just far enough away through
 * enough corridors that something else always interrupted first. At the old
 * effective range he had been killing steadily.
 *
 * So this file drives the DEFAULT - `chooseTarget()` with no argument, which
 * is how the round calls it - across that boundary, using the distances the
 * log actually recorded.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Actions } from '../dist/harness/actions.js';

/** Miller's Stair: 64px tiles, 192x176. See the `[grid]` line the harness prints. */
const STAIR = 'millers-stair';
const TILE = 64;
const WIDE_TILES = 192;
const HIGH_TILES = 176;

/** Where the body stands. Well clear of the six-tile rim rule in chooseTarget. */
const ME = { tileX: 60, tileY: 60 };

/**
 * An enemy `tiles` away, on a tile of its own.
 *
 * Both the distance and the tile matter: the leash reads `distanceFromSelf`,
 * and the rim rule reads the tile, so a mark placed carelessly near the
 * boundary would be refused for a reason that has nothing to do with the
 * leash under test.
 */
const mark = (label, tiles, objectIndex) => ({
  objectId: 500 + tiles,
  objectIndex,
  label,
  kind: 'enemy',
  alive: true,
  hp: 150,
  interactable: true,
  distanceFromSelf: tiles * TILE,
  tileX: ME.tileX + tiles,
  tileY: ME.tileY
});

/** A body on the stair, with nothing hitting it unless `hitters` says so. */
function onTheStair(hitters = []) {
  const arena = {
    async call(name) {
      if ('arena_walkable_grid' === name) {
        return {
          sceneName: STAIR,
          sceneSize: { widthTiles: WIDE_TILES, heightTiles: HIGH_TILES },
          rows: new Array(HIGH_TILES).fill('.'.repeat(WIDE_TILES))
        };
      }
      return {};
    },
    aggressorIndexes() { return hitters; },
    chaseFromBattle() { return null; }
  };
  const actions = new Actions(arena, 'test-agent', new Set(['fight', 'walk']));
  actions.sees({ scene: STAIR });
  assert.equal(actions.tilePx, TILE,
    'the stair is a 64px map - the unit error above is the whole story here');
  actions.standsAt({ x: ME.tileX * TILE + TILE / 2, y: ME.tileY * TILE + TILE / 2 });
  return actions;
}

test('a mark five tiles off is picked', () => {
  const actions = onTheStair();
  actions.notices([mark('Groove Grub', 5, 'e5')]);
  const chosen = actions.chooseTarget();
  assert.ok(chosen, 'five tiles is a fight, not an expedition');
  assert.equal(chosen.label, 'Groove Grub');
});

test('THE LEASH: a mark thirteen tiles off is NOT picked', () => {
  // Thirteen is not hypothetical. It is one of the marks Sir Qwen held on
  // this exact map while arriving at none of them.
  const actions = onTheStair();
  actions.notices([mark('Hollow Caller', 13, 'e13')]);
  assert.equal(actions.chooseTarget(), null,
    'a mark that cannot be reached before something interrupts is not a mark');
});

test('AND NEITHER IS ONE AT NINETEEN', () => {
  // The furthest he ever held: 19.8 tiles.
  const actions = onTheStair();
  actions.notices([mark('Hollow Caller', 19, 'e19')]);
  assert.equal(actions.chooseTarget(), null,
    'nineteen tiles through a maze is not a fight anyone finishes');
});

test('AND NEITHER IS ONE AT TEN, which is where the unit error actually lived', () => {
  // THE ASSERTION THAT PINS THE CORRECTION ITSELF. Thirteen and nineteen are
  // refused by twelve as well as by six, so they cannot tell the corrected
  // number from the one it replaced - proven by mutation: 6 -> 12 left this
  // file green until this test existed.
  //
  // Ten is inside the old reach and outside the new one, and it is a real
  // distance: the observation feed carries marks at 9.1, 10.5, 10.6, 10.8
  // and 11.5 tiles on this map, over and over. Those are the fights that
  // were being picked and never finished.
  const actions = onTheStair();
  actions.notices([mark('Groove Grub', 10, 'e10')]);
  assert.equal(actions.chooseTarget(), null,
    'ten tiles is 640px on a 64px map - the reach the old twelve really meant'
    + ' was 384px, and this is the difference');
});

test('AND THE NEAR ONE IS TAKEN OVER THE FAR ONE when both are in the feed', () => {
  // The shape that actually occurs: the room is full, and the question is
  // which of them the body names.
  const actions = onTheStair();
  actions.notices([mark('Hollow Caller', 13, 'e13'), mark('Groove Grub', 4, 'e4')]);
  const chosen = actions.chooseTarget();
  assert.ok(chosen, 'there is a fight to be had here');
  assert.equal(chosen.label, 'Groove Grub',
    'the one in reach, not the one across the room');
});

test('CONTROL: the leash never stops a body FINISHING a fight it did not pick', () => {
  // The standing order, and the reason the leash is a picking rule rather
  // than a fighting one: the moment something attacks this character it is
  // the target until it is dead - no leash, no rim rule, no scoring. Without
  // this control, shrinking the leash to nothing would look like an
  // improvement instead of a body standing still being chewed on.
  const actions = onTheStair(['e13']);
  actions.notices([mark('Hollow Caller', 13, 'e13')]);
  const chosen = actions.chooseTarget();
  assert.ok(chosen, 'something that is hitting us is answered wherever it stands');
  assert.equal(chosen.label, 'Hollow Caller');
  assert.match(chosen.why, /hit us/, chosen.why);
});

test('CONTROL: an empty room is null, not a far mark by default', () => {
  const actions = onTheStair();
  actions.notices([]);
  assert.equal(actions.chooseTarget(), null, 'nothing to fight is nothing to fight');
});
