/**
 * A STEP IS NOT A ROUTE.
 *
 * Measured 2026-09-04: both royals stood on tile (11,13) of `the-valley-inn`,
 * a room whose grid is 20x13 and whose last row is therefore 12. The body was
 * filed inside the room and was outside it. Every door answered "walked into
 * the door from every side and the room did not change", `force_doors`
 * answered "every visible door refused", and `unstick` answered "nudged and
 * did not move". All three were telling the truth: a door tests whether the
 * body stands on one of its entry tiles, and a body off the map is on none.
 *
 * A restart put the new session back on the same impossible row, so the
 * position is the world's and not ours (agentArena #716).
 *
 * `escapeWall` asks for each exit with `arena_move_to`, which ROUTES - and a
 * body off the map has no route to anywhere, so all 24 refuse identically.
 * `arena_move` asks for a heading and a duration instead of a destination.
 * These tests drive that last rung: the first proves it is reached and that
 * only FLOOR ends the rescue, the second proves a step that does not free the
 * body is reported as a failure rather than dressed up as one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Actions } from '../dist/harness/actions.js';

/**
 * `Actions` measures in 32px tiles until a scene tells it otherwise, so the
 * fixture does too. Written at 64 first, which put the body on tile (5,7) of
 * a five-wide room and produced a confident, meaningless pass on the negative
 * case. A pixel is not a tile, and neither is somebody else's pixel.
 */
const TILE = 32;
const HALF = TILE / 2;
/** Three rows, numbered 0 to 2. Row 3 does not exist - that is the point. */
const ROWS = ['.....', '.....', '.....'];
const OFF_MAP_TILE_Y = ROWS.length;

/**
 * A body standing one row below the map.
 *
 * `arena_move_to` THROWS here. That is NOT how the world usually refuses - a
 * refused route comes back as an ordinary reply carrying `arrived:false` and a
 * reason, and reaches the same place through the poll loop and the
 * "never moved" continue. The throw is used because it exhausts twenty-four
 * routed attempts without twenty-four poll delays. The last test in this file
 * uses the ordinary shape, on a room with a single exit, so the production
 * path is covered too.
 * `stepsFree` decides whether the directional step lands the body on floor.
 */
function rig({ stepsFree }) {
  const calls = [];
  let at = { x: 2 * TILE + HALF, y: OFF_MAP_TILE_Y * TILE + HALF };
  const arena = {
    calls,
    async call(name, args) {
      calls.push({ name, args });
      if ('arena_walkable_grid' === name) {
        return { sceneName: 'the-test-inn', sceneSize: { widthTiles: 5, heightTiles: 3 }, rows: ROWS };
      }
      if ('arena_move_to' === name) {
        throw new Error('no walking route from where you stand');
      }
      if ('arena_move' === name && stepsFree) {
        // One row up is row 2, which exists and is floor.
        at = { x: 2 * TILE + HALF, y: (OFF_MAP_TILE_Y - 1) * TILE + HALF };
      }
      if ('arena_observe' === name) {
        return { ownPlayer: { state: { x: at.x, y: at.y } }, position: at, scene: 'the-test-inn' };
      }
      return {};
    },
    chaseFromBattle() { return null; }
  };
  return { actions: new Actions(arena, 'test-agent', new Set(['walk'])), calls, where: () => at };
}

test('a body off the map is stepped back on when no route will take it', async () => {
  const { actions, calls, where } = rig({ stepsFree: true });
  const freed = await actions.escapeWall(2 * TILE + HALF, OFF_MAP_TILE_Y * TILE + HALF);

  assert.ok(calls.some((c) => 'arena_move' === c.name),
    'the routed exits all refused, so the directional step must have been tried');
  assert.equal(calls.find((c) => 'arena_move' === c.name)?.args?.direction, 'up',
    'the only floor is above the body, so the step must head up');
  assert.ok(freed.ok, `the body reached floor, so the rescue must say so - got: ${freed.note}`);
  assert.ok(/on solid ground/.test(freed.note), `and say it plainly - got: ${freed.note}`);
  assert.ok(where().y < OFF_MAP_TILE_Y * TILE, 'and the body must actually be on the map');
});

test('a step that does not reach floor is a failure, not a rescue', async () => {
  const { actions, calls } = rig({ stepsFree: false });
  const freed = await actions.escapeWall(2 * TILE + HALF, OFF_MAP_TILE_Y * TILE + HALF);

  assert.ok(calls.some((c) => 'arena_move' === c.name), 'the step must still be attempted');
  assert.equal(freed.ok, false, 'a body still off the map has not been rescued');
  assert.ok(/steps/.test(freed.note),
    `and the note must say the steps were tried and did not work - got: ${freed.note}`);
  // AND IT MUST NOT INVENT A MOVEMENT. `lastSeen` reports where a failed
  // rescue LEFT the body. Written without a guard, every failed push
  // overwrote it with the current position, so a body that had not moved a
  // pixel was reported as "shifted to 712,845 and stayed walled" - a
  // confident false sentence, in the one rung added because silence was
  // hiding the truth.
  assert.ok(!/shifted to/.test(freed.note),
    `a body that never moved must not be described as having shifted - got: ${freed.note}`);
});

/**
 * THE ORDINARY REFUSAL, not the throw.
 *
 * A one-tile room, so there is exactly one exit and the poll loop runs once
 * rather than twenty-four times. `arena_move_to` answers the way the gateway
 * actually answers - a normal reply, `arrived:false`, and a reason - and the
 * body does not move. The rung must still be reached, and what the world says
 * about the step must survive into the note.
 */
test('an ordinary refusal reaches the step, and the world is quoted', async () => {
  const calls = [];
  const at = { x: 0 * TILE + HALF, y: 1 * TILE + HALF };
  const arena = {
    calls,
    async call(name) {
      calls.push({ name });
      if ('arena_walkable_grid' === name) {
        return { sceneName: 'one-tile', sceneSize: { widthTiles: 1, heightTiles: 1 }, rows: ['.'] };
      }
      if ('arena_move_to' === name) {
        return { arrived: false, reason: 'NO_PATH' };
      }
      if ('arena_move' === name) {
        return { moved: false, reason: 'TARGET_OUT_OF_BOUNDS' };
      }
      if ('arena_observe' === name) {
        return { ownPlayer: { state: { x: at.x, y: at.y } }, position: at, scene: 'one-tile' };
      }
      return {};
    },
    chaseFromBattle() { return null; }
  };
  const actions = new Actions(arena, 'test-agent', new Set(['walk']));
  const freed = await actions.escapeWall(at.x, at.y);

  assert.ok(calls.some((c) => 'arena_move' === c.name),
    'a routed refusal that is not a throw must still reach the step');
  assert.equal(freed.ok, false, 'nothing freed the body, so nothing may claim it did');
  assert.ok(/TARGET_OUT_OF_BOUNDS/.test(freed.note),
    `what the world said is the point of this rung - got: ${freed.note}`);
});
