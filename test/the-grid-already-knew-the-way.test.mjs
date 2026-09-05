/**
 * The room's own collision grid is a map, so stop guessing at the route.
 *
 * The seam walk steered by geometry - clamp the vector to the seam, `go_to`
 * it - and spent an afternoon failing in four distinct ways, each measured
 * live on 2026-09-02:
 *
 *   straight only          "no progress in 12 beats, the road does not go through"
 *   sidestep, alternating  tile(28,39)/(28,45)/(28,39)  - paced on the spot
 *   sidestep, held 4 beats tile 28 -> 54, then 137 tiles -> 166  - overshot
 *   sidestep, blended      159 tiles -> 167, 11 beats without progress
 *
 * Every one of those was a heuristic standing in for a fact the harness
 * ALREADY HOLDS: `arena_walkable_grid` returns the whole scene, run-length
 * encoded, cached per room in `this.grid` - and `escapeWall`'s own comment
 * records flood-filling it to find "a single connected region of 13,547
 * tiles". If a route exists, the grid knows it.
 *
 * `routeThrough` is that search, kept pure so it can be tested without a
 * world: rows of glyphs in, a list of tiles out. '.' is floor and 'D' is a
 * door (both standable, matching `standable()`); everything else is wall.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeThrough, clearLine } from '../dist/harness/actions.js';

/** A room drawn as text, so the shape of each case is readable. */
function room(...rows) {
  return { rows, w: rows[0].length, h: rows.length };
}

test('a straight line is enough when nothing is in the way', () => {
  const g = room(
    '.....',
    '.....',
    '.....'
  );
  const path = routeThrough(g, { x: 0, y: 1 }, { x: 4, y: 1 });
  assert.ok(path, 'an open room must produce a route');
  assert.deepEqual(path.at(-1), { x: 4, y: 1 }, 'and it must end at the goal');
});

test('a wall across the road is walked around, not into', () => {
  // The straight line from (0,2) to (4,2) runs into the '#' at (2,2).
  const g = room(
    '.....',
    '.....',
    '..#..',
    '.....'
  );
  const path = routeThrough(g, { x: 0, y: 2 }, { x: 4, y: 2 });
  assert.ok(path, 'a route exists round a one-tile wall');
  assert.deepEqual(path.at(-1), { x: 4, y: 2 });
  assert.ok(!path.some((t) => 2 === t.x && 2 === t.y), 'and it never steps on the wall');
});

test('the long way round is found when the short way is sealed', () => {
  // A barrier with a single gap at the bottom. Geometry cannot solve this;
  // it is the shape that beat every version of the sidestep.
  const g = room(
    '..#..',
    '..#..',
    '..#..',
    '..#..',
    '.....'
  );
  const path = routeThrough(g, { x: 0, y: 0 }, { x: 4, y: 0 });
  assert.ok(path, 'the gap at the bottom is a road');
  assert.deepEqual(path.at(-1), { x: 4, y: 0 });
  assert.ok(path.some((t) => 4 === t.y), 'the route must dip to the gap to get through');
});

test('a door counts as floor, because standable() says so', () => {
  const g = room(
    '..#..',
    '..D..',
    '..#..'
  );
  const path = routeThrough(g, { x: 0, y: 1 }, { x: 4, y: 1 });
  assert.ok(path, "a 'D' tile is walkable - see standable()");
});

test('a goal walled off returns the closest reachable tile, not nothing', () => {
  // THE POINT OF THIS ONE: the seam walk aims at a clamped intermediate
  // point that may itself be solid. Answering null there would put us back
  // to standing still, which is the bug this whole file exists to end.
  const g = room(
    '...#.',
    '...#.',
    '...#.'
  );
  const path = routeThrough(g, { x: 0, y: 1 }, { x: 4, y: 1 });
  assert.ok(path && path.length, 'an unreachable goal still yields a best effort');
  assert.ok(path.at(-1).x <= 2, 'it walks as near the goal as the room allows');
});

test('standing on the goal is not a journey', () => {
  const g = room('...', '...', '...');
  const path = routeThrough(g, { x: 1, y: 1 }, { x: 1, y: 1 });
  assert.deepEqual(path, [], 'no steps are needed to stay put');
});

test('the first leg of a route is a straight run, so a walk can take it', () => {
  // MEASURED LIVE 2026-09-02. The waypoint was "the tile six steps along the
  // path", and the walk to it is a STRAIGHT line - so whenever the path
  // turned inside those six steps, the body was sent through the very wall
  // the route was going around. It showed up as a short re-route repeating
  // itself:
  //
  //   [route] 41,24 -> 47,24: the grid goes via 47,24 (6 tiles of road)
  //
  // A 4-connected path's leading run in one direction is walkable in a
  // straight line by construction. That is what a waypoint has to be.
  const g = room(
    '..........',
    '.####.....',
    '..........',
    '..........'
  );
  const path = routeThrough(g, { x: 0, y: 1 }, { x: 9, y: 1 });
  assert.ok(path, 'a route exists round the block');
  // Whatever the route does later, its opening leg must be axis-aligned and
  // contiguous from the start tile.
  const first = path[0];
  assert.ok(
    (Math.abs(first.x - 0) + Math.abs(first.y - 1)) === 1,
    `the first step must be adjacent to the body, got ${JSON.stringify(first)}`
  );
  let dx = path[0].x - 0;
  let dy = path[0].y - 1;
  let run = 1;
  while (run < path.length
    && path[run].x - path[run - 1].x === dx
    && path[run].y - path[run - 1].y === dy) {
    run += 1;
  }
  assert.ok(run >= 1, 'there is always at least one straight step to take');
});

test('a tile the world refuses is routed around, not retried for ever', () => {
  // THE UPSTREAM LIE, AND THE CLIENT-SIDE ANSWER. Measured 2026-09-02: Sir
  // Qwen walked happily from tile (5,19) to (41,24) and then could not leave
  // it. The grid showed a clear six-tile straight road east to (47,24);
  // `arena_move_to` moved him zero pixels, every beat:
  //
  //   [route] 41,24 -> 47,24: the grid goes via 47,24 (6 tiles of road)
  //   route_to 5792,10976 -> did not move from tile 41,24
  //
  // That is the reachability lie the harness already documents against PRs
  // #505/#539/#545, and `unstick()`'s own note records that a nudge does not
  // cure it. What we CAN do is believe the body over the grid: a step the
  // world refused is marked shut, and the next search goes another way.
  const g = room(
    '.....',
    '.....',
    '.....'
  );
  const open = routeThrough(g, { x: 0, y: 1 }, { x: 4, y: 1 });
  assert.equal(open[0].x, 1, 'with nothing shut, the first step is east');
  assert.equal(open[0].y, 1);

  // Now the world has refused (1,1). The route must not offer it again.
  const around = routeThrough(g, { x: 0, y: 1 }, { x: 4, y: 1 }, new Set(['1,1']));
  assert.ok(around && around.length, 'a refused tile must not end the journey');
  assert.ok(!around.some((t) => 1 === t.x && 1 === t.y),
    `the route must avoid the refused tile - got ${JSON.stringify(around)}`);
  assert.deepEqual(around.at(-1), { x: 4, y: 1 }, 'and it still reaches the goal');
});

test('a clear straight line is seen as clear, and a blocked one is not', () => {
  // WHY THIS EXISTS. A 4-connected route to anywhere diagonal is a staircase:
  // right, down, right, down. Its longest straight run is ONE TILE, so a
  // waypoint rule of "the leading straight run" walks a body one tile a beat.
  // Measured live 2026-09-02, that is exactly what happened - 199 tiles to go
  // and single-tile beats:
  //
  //   [route] 28,42 -> 90,171: the grid goes via 29,42 (199 tiles of road)
  //   [route] 29,42 -> 90,171: the grid goes via 29,41 (198 tiles of road)
  //
  // But the world's own walk is a straight line and does not care about the
  // staircase - it only cares whether the line is clear. So cut the corner:
  // take the furthest tile on the route whose straight line is unobstructed.
  const open = room(
    '.....',
    '.....',
    '.....',
    '.....',
    '.....'
  );
  assert.equal(clearLine(open, { x: 0, y: 0 }, { x: 4, y: 4 }), true,
    'an empty room has line of sight corner to corner');

  const split = room(
    '..#..',
    '..#..',
    '..#..',
    '..#..',
    '.....'
  );
  assert.equal(clearLine(split, { x: 0, y: 0 }, { x: 4, y: 0 }), false,
    'a barrier across the line must be seen');
  assert.equal(clearLine(split, { x: 0, y: 4 }, { x: 4, y: 4 }), true,
    'and the open row below it must not be');
});

test('a refused tile also blocks the line through it', () => {
  const g = room('.....', '.....', '.....');
  assert.equal(clearLine(g, { x: 0, y: 1 }, { x: 4, y: 1 }), true);
  assert.equal(clearLine(g, { x: 0, y: 1 }, { x: 4, y: 1 }, new Set(['2,1'])), false,
    'a tile the world refused is not somewhere to walk through either');
});

test('the search is bounded, so a big room cannot hang a beat', () => {
  // Miller's Stair is 192x176 = 33,792 tiles. A beat that stalls on a search
  // is a beat the body spends standing still, which is the thing being fixed.
  const rows = Array.from({ length: 176 }, () => '.'.repeat(192));
  const g = { rows, w: 192, h: 176 };
  const began = Date.now();
  const path = routeThrough(g, { x: 1, y: 1 }, { x: 190, y: 174 });
  const took = Date.now() - began;
  assert.ok(path, 'the real room size must still route');
  assert.ok(took < 250, `a route took ${took}ms - too slow to run on a beat`);
});
