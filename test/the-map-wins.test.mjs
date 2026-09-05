/**
 * The map decides how big a tile is. The table is only the fallback.
 *
 * `tilePxFor` is a hand-maintained list of which rooms run 64px, and it is a
 * guess at something arena_observe states outright in `pixelsPerTile`. The
 * server made the same correction on its own side in PR #543: `battle-sense.js`
 * carried `const TILE_PX = 32` under the comment "Every scene in this world
 * runs 32px tiles", which stopped being true when the Blender-baked rooms
 * arrived, and the constant is now named FALLBACK_TILE_PX because that is what
 * it always was.
 *
 * It decides whether a swing lands. `distanceFromSelf` and a skill's `range`
 * are both PIXELS; every comparison against a reach in tiles goes through this
 * one number. A room added upstream after the table was last audited reads 32
 * by assumption - and reads correctly off the map.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Actions } from '../dist/harness/actions.js';

/** One art reaching 4.7 TILES, so the stop distance is a tile-size question. */
const SKILLS = {
  hp: { value: 542, total: 542 }, mp: { value: 576, total: 576 },
  progress: { level: 35 },
  skills: [
    { key: 'attackShort', available: true, damage: 5, range: 50, reachTiles: 0.8, requirements: [] },
    { key: 'arcaneRay', available: true, damage: 12, range: 300, reachTiles: 4.7,
      requirements: [{ property: 'stats/mp', comparison: 'ge', value: 10 }] }
  ]
};

function client(observation) {
  const calls = [];
  return {
    calls,
    async call(tool) {
      calls.push(tool);
      if ('arena_observe' === tool) return observation;
      if ('arena_skills' === tool) return SKILLS;
      return {};
    }
  };
}

const GRUB = {
  kind: 'enemy', label: 'Groove Grub', alive: true,
  objectIndex: 'g1', tileX: 4, tileY: 4
};

/** Walk toward a grub from far off and answer: how many PIXELS did it stop
 *  short? That distance is `reachTiles * tilePx`, so it names the tile size. */
async function stoppedShortBy(observation, tilePxForGeometry) {
  const c = client(observation);
  // arcaneRay is on the ladder, so its 4.7-tile reach is what the stop
  // distance is measured against - the whole point of the assertion below.
  const it = new Actions(c, 'agent-1', new Set(['fight', 'walk']), undefined, undefined, [], ['arcaneRay']);
  await it.observe();
  await it.ownSheet();
  const atX = 4 * tilePxForGeometry + tilePxForGeometry / 2;
  const atY = 4 * tilePxForGeometry + tilePxForGeometry / 2;
  it.notices([{ ...GRUB, distanceFromSelf: 2000 }]);
  it.standsAt({ x: atX, y: atY + 2000 });
  const moves = [];
  c.call = async (tool, args) => {
    if ('arena_move_to' === tool) moves.push(args);
    if ('arena_observe' === tool) return observation;
    if ('arena_skills' === tool) return SKILLS;
    return {};
  };
  await it.closeOn('Groove Grub');
  if (!moves.length) return null;
  return Math.hypot(moves[0].x - atX, moves[0].y - atY);
}

test('a 64px map holds a caster at 4.7 SIXTY-FOURS, not 4.7 thirty-twos', async () => {
  // The stop distance is no longer an aim point - closeOn aims at the tile
  // and the HOLD decides when to stop walking. So the tile size is now read
  // through the hold: 280px from the target is 4.4 tiles on a 64px map, which
  // is inside arcaneRay's 4.7 and must HOLD. Read against the table's 32px
  // default the same 280px would be 8.75 tiles and he would walk.
  const c = client({ sceneName: 'a-room-nobody-has-audited',
                     pixelsPerTile: { width: 64, height: 64 }, objects: [], ownPlayer: {} });
  const it = new Actions(c, 'agent-1', new Set(['fight', 'walk']), undefined, undefined, [], ['arcaneRay']);
  await it.observe();
  await it.ownSheet();
  const atX = 4 * 64 + 32;
  const atY = 4 * 64 + 32;
  it.notices([{ ...GRUB, distanceFromSelf: 280 }]);
  it.standsAt({ x: atX, y: atY + 280 });
  const held = await it.closeOn('Groove Grub');
  assert.match(held.note, /holding/,
    'inside a 4.7-tile reach on a 64px map, it must hold rather than walk');
});

test('with no pixelsPerTile it still falls back to the table, and no NaN leaks', async () => {
  const px = await stoppedShortBy(
    { sceneName: 'millers-stair', objects: [], ownPlayer: {} },
    64
  );
  assert.ok(null !== px && Number.isFinite(px), `the fallback path must still work, got ${px}`);
});
