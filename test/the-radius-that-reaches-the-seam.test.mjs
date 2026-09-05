/**
 * THE RADIUS THAT REACHES THE SEAM.
 *
 * `GATHER_RADIUS_TILES` was raised from twelve to twenty on a measurement:
 * both bodies leave `millers-stair` from tile (89,157) on every town trip,
 * iron ore sits at (90,171) and copper at (91,174) - fourteen and seventeen
 * tiles out. Twelve reached neither, several times an hour, for the life of
 * the harness. Those two coordinates are not a guess: they are the only ones
 * the world has ever reported, 27,877 observations of each.
 *
 * NOTHING OBSERVED THAT NUMBER. Proven by mutation before this file existed:
 * setting the constant to 1, and setting it to 60, each left all 542 tests
 * green. Every gather test drove `Actions.gatherNearby` with a literal radius
 * of its own; not one asked what `npc.ts` passes. A constant no test can move
 * is a comment with a semicolon after it.
 *
 * So this file takes the number the beat really uses - `gatherRadiusFor`, the
 * single expression the call site in `npc.ts` evaluates - and feeds it into
 * the real `gatherNearby` at the real distances. It asserts no value. It
 * holds the radius between the two facts that set it:
 *
 *   FLOOR   the stair's seams, fourteen and seventeen tiles from the door
 *           the bodies use, are inside the beat and are set out for.
 *   CEILING an ordinary beat is not a whole-room sweep: a node forty tiles
 *           off is refused outright, and only the deliberate trip's `wide`
 *           radius reaches it.
 *
 * Anything under seventeen breaks the floor. Anything at or above sixty
 * collapses the ceiling into `GATHER_ROOM_TILES`, and the difference between
 * a beat and an errand is gone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Actions } from '../dist/harness/actions.js';
import { gatherRadiusFor } from '../dist/harness/npc.js';

/**
 * Miller's Stair, at its real size and its real tile scale. Both matter, and
 * the first draft of this file got both wrong.
 *
 * The radius is compared in PIXELS - `withinTiles * tilePx` against
 * `distanceFromSelf` - so a body left on the 32px default would be measuring
 * half the distance the constant was set from. And `approach()` clamps every
 * destination to the walkable grid, falling back to 145x145 when none is
 * supplied: on that fallback a walk to row 171 was quietly rewritten to row
 * 141, and the seam was unreachable however wide the radius.
 *
 * 192x176 is the world's own answer, straight off the `[grid]` line the
 * harness prints on entering the room.
 */
const STAIR = 'millers-stair';
const TILE = 64;
const WIDE_TILES = 192;
const HIGH_TILES = 176;

/** Sir Qwen's sheet. Mining is the trade the stair's seams answer to. */
const QWEN = ['mining', 'foraging', 'smelting', 'blacksmithing', 'cooking'];

/** The beat's radius, and the deliberate trip's - production's own choice. */
const BEAT = gatherRadiusFor({});
const TRIP = gatherRadiusFor({ wide: true });

const GAVE = { gathered: true, itemKey: 'iron_ore', quantity: 1,
               experience: 42, skillKey: 'mining' };

/** The door both bodies leave the stair by, on every town trip. */
const DOOR = { x: 89, y: 157 };

/** How far off the handed coordinate the engine actually sets the body down. */
const SLOP = 20;

/**
 * A body at that door whose legs work: every `arena_move_to` puts it where it
 * was sent, and every observation says so. The walk has to be ABLE to finish,
 * or these assertions would be measuring `goTo` instead of the radius -
 * which is exactly how the first draft of this file failed.
 */
function atTheDoor() {
  const calls = [];
  let stood = { x: DOOR.x * TILE + TILE / 2, y: DOOR.y * TILE + TILE / 2 };
  const arena = {
    async call(name, args) {
      calls.push({ name, args });
      if ('arena_gather' === name) return GAVE;
      if ('arena_check_path' === name) return { reachable: true };
      if ('arena_walkable_grid' === name) {
        return {
          sceneName: STAIR,
          sceneSize: { widthTiles: WIDE_TILES, heightTiles: HIGH_TILES },
          rows: new Array(HIGH_TILES).fill('.'.repeat(WIDE_TILES))
        };
      }
      if ('arena_move_to' === name) {
        // NOT ON THE EXACT PIXEL, because the engine never is: it walks the
        // body itself and lands it ON the tile, not on the coordinate it was
        // handed. Twenty pixels is well inside a 64px tile.
        //
        // This does NOT make the file sensitive to ARRIVAL_PIXELS, and it
        // was added believing it would - measured, and it does not:
        // `workNode` re-reads the node's own `distanceFromSelf` and swings
        // at anything within 1.5 tiles, so it never needs `goTo` to declare
        // an arrival. ARRIVAL_PIXELS 40 -> 1 still leaves this file green.
        // The slop stays because the fixture is honest with it and was
        // flattering without it, not because it buys coverage.
        stood = { x: args.x + SLOP, y: args.y - SLOP };
        return {};
      }
      if ('arena_observe' === name) return { position: stood };
      return {};
    },
    chaseFromBattle() { return null; }
  };
  const actions = new Actions(arena, 'test-agent', new Set(['craft', 'walk', 'fight']));
  actions.sees({ scene: STAIR });
  assert.equal(actions.tilePx, TILE,
    'the stair is a 64px map - if this ever fails, every distance below is a lie');
  actions.standsAt(stood);
  return { actions, calls, where: () => stood };
}

/**
 * Offer the beat until the seam is worked, or the beats run out.
 *
 * Several beats, because that is the shape of the thing: `gatherNearby`
 * answers "on the way to a node of ours" while the walk is unfinished, and
 * only gathers once the body has arrived. One beat would prove nothing about
 * a seam fourteen tiles away.
 */
async function offer(rig, seam, radius, beats = 8) {
  const notes = [];
  for (let i = 0; i < beats; i += 1) {
    const stood = rig.where();
    rig.actions.standsAt(stood);
    rig.actions.notices([{
      ...seam,
      distanceFromSelf: Math.hypot(
        seam.tileX * TILE + TILE / 2 - stood.x,
        seam.tileY * TILE + TILE / 2 - stood.y
      )
    }]);
    const said = await rig.actions.gatherNearby(QWEN, radius, 2);
    notes.push(said.note ?? '');
    if (rig.calls.some((c) => 'arena_gather' === c.name)) {
      return { worked: true, beats: i + 1, notes };
    }
  }
  return { worked: false, beats, notes };
}

const seam = (label, tileX, tileY, objectId) => ({
  objectId, objectIndex: `node-${objectId}`, label,
  kind: 'npc', interactable: true, tileX, tileY
});

/** The world's own coordinates, out of millers-stair. */
const IRON = seam('iron ore', 90, 171, 77);
const COPPER = seam('copper ore', 91, 174, 78);
/** Nothing sits here. It is the far side of the room, and that is the point. */
const ACROSS = seam('iron ore', 60, 130, 79);

const tilesOff = (node) => Math.round(Math.hypot(
  node.tileX - DOOR.x, node.tileY - DOOR.y));

const walks = (rig) => rig.calls.filter((c) => 'arena_move_to' === c.name).length;

test('FLOOR: the iron at (90,171) is inside the beat, and is worked', async () => {
  const rig = atTheDoor();
  const got = await offer(rig, IRON, BEAT);
  assert.ok(got.worked,
    `a radius of ${BEAT} must reach the iron ${tilesOff(IRON)} tiles from the door`
    + ` - the beat said ${got.notes.join(' | ')}`);
});

test('FLOOR: and the copper at (91,174) - the far one - is set out for', async () => {
  // Seventeen tiles is the distance that has to be paid for, and this is the
  // seam the pair have never once worked.
  //
  // SET OUT FOR, not worked, and the difference is a defect this test found
  // rather than a softening of the assertion - see the todo below. What the
  // radius decides is whether the seam is a candidate at all: at twenty it
  // is taken up and walked toward, and at anything under seventeen the beat
  // answers "nothing of ours" and never lifts a foot. That is the whole
  // behaviour under test here, and both halves are asserted.
  const rig = atTheDoor();
  const got = await offer(rig, COPPER, BEAT);
  assert.ok(got.notes.every((n) => !/nothing of ours/.test(n)),
    `a radius of ${BEAT} must take up the copper ${tilesOff(COPPER)} tiles off`
    + ` - the beat said ${got.notes.join(' | ')}`);
  assert.ok(walks(rig) > 0,
    'and must actually set out for it - a candidate nothing walks to is not in reach');
});

test('THE COPPER SEAM CANNOT BE STOOD ON, and the radius is not why',

  async () => {
    // FOUND BY WRITING THE TEST ABOVE, and it is a live defect.
    //
    // `approach()` keeps a body off the rim of the room by a margin of three
    // tiles. The stair is 192x176, so the last row a walk may be sent to is
    // 172. The copper seam is at row 174. Every walk toward it is rewritten
    // to (91,172) - measured, six beats running, always the same tile - and
    // `workNode` needs to be within 1.5 tiles to swing. Two is not within
    // 1.5, so the beat answers "on the way to a node of ours" for ever and
    // the charge is never taken.
    //
    // That is one of the two seams the radius was raised to twenty FOR. The
    // iron at row 171 is fine; the copper is unreachable by construction and
    // has been for the life of the harness, which is a better explanation of
    // "they have never worked this seam" than the radius ever was.
    //
    // The fix belongs in actions.ts and is not this file's to make. When it
    // The clamp landed (actions.ts, the rim-margin block), so this is an
    // ordinary passing test now: the copper seam at row 174 is aimed at
    // where it actually is, not two tiles short of it.
    const rig = atTheDoor();
    const got = await offer(rig, COPPER, BEAT);
    assert.ok(got.worked,
      `the copper must be reachable - the beat said ${got.notes.join(' | ')}`);
  });

test('CEILING: a seam across the room is NOT an ordinary beat', async () => {
  // An ordinary beat stoops for what is underfoot. If it swept the room
  // there would be no difference between a beat and the deliberate trip,
  // and the trip's own radius would be decoration.
  const rig = atTheDoor();
  const got = await offer(rig, ACROSS, BEAT);
  assert.ok(!got.worked,
    `a radius of ${BEAT} must not sweep to a node ${tilesOff(ACROSS)} tiles away`);
  assert.ok(got.notes.every((n) => /nothing of ours/.test(n)),
    `and must say so plainly - saw ${got.notes.join(' | ')}`);
  assert.equal(walks(rig), 0,
    'no walk is started either - out of radius is out of scope');
});

test('CONTROL: the deliberate trip DOES reach that same far seam', async () => {
  // Without this the ceiling above would pass just as well if the beat were
  // broken outright, which is the failure it exists to exclude.
  const rig = atTheDoor();
  const got = await offer(rig, ACROSS, TRIP);
  assert.ok(got.worked,
    `the trip's radius of ${TRIP} sweeps the room it travelled to`
    + ` - the beat said ${got.notes.join(' | ')}`);
});

test('CONTROL: the beat radius is strictly narrower than the trip radius', () => {
  // Said as a consequence of the two above rather than in place of them: it
  // is what makes `wide` mean anything at the call site in npc.ts.
  assert.ok(BEAT < TRIP,
    `an ordinary beat (${BEAT}) must be narrower than a room sweep (${TRIP})`);
});
