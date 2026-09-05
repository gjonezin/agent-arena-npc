/**
 * A body trading between two corners is wedged, however honestly it moves.
 *
 * Measured live 2026-08-27: Lord Gemma spent NINE MINUTES and 163 log lines
 * without a single copper, at 16 hp of 633, oscillating between two tiles
 * eight apart while the nearest hostile drifted from 9 tiles to 20. He could
 * not earn, could not reach anything, and could not even die - nothing came
 * close enough to kill him.
 *
 * He beat every detector on this side at once, and for the same reason: they
 * all key on a body that STOPS. The motion watchdog counts same-tile beats,
 * and he changed tile every beat or two. `goTo`'s honesty check asks whether
 * this walk moved him, and every individual walk genuinely did. Both answered
 * correctly and both missed it, because the failure is a 2-cycle and every
 * instrument was built for a 1-cycle.
 *
 * The gate matters as much as the detector. A ranged body legitimately HOLDS
 * position while it shoots, and holding is what keeps a cloth caster out of a
 * grub's teeth - so a standoff must never read as a trap. Nothing biting and
 * nothing landing is what separates them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KnightsRound } from '../dist/harness/reflex.js';

const FIELD = 'millers-stair';
const QUIET = { damage: 0, died: false, aggressors: 0, landed: false };
const FIGHT = { damage: 40, died: false, aggressors: 2, landed: true };

function round() {
  return new KnightsRound({ battleStyle: 'long_range', skillLadder: [], partner: 'Sir Qwen' });
}

/** Walk a body over a list of pixel spots and collect what the ladder said. */
function pace(it, spots, danger) {
  const said = [];
  const real = console.log;
  console.log = (...parts) => {
    const line = parts.join(' ');
    if (line.startsWith('[wedge]')) {
      said.push(line);
    }
  };
  const intents = [];
  try {
    for (const [x, y] of spots) {
      const step = it.next(FIELD, danger, { value: 300, total: 633 }, null,
        { room: FIELD, x, y, level: 42, mp: { value: 205, total: 205 } });
      intents.push(step.action);
      it.completed(step, true, 'walked');
    }
  } finally {
    console.log = real;
  }
  return { said, intents };
}

// Two spots eight tiles apart at 64px - the live pair, (83,42) and (83,34).
const A = [83 * 64, 42 * 64];
const B = [83 * 64, 34 * 64];
const twoCycle = [A, B, A, B, A, B, A, B, A, B];

test('trading between two tiles with nothing to fight is called a wedge', () => {
  const { said } = pace(round(), twoCycle, QUIET);
  assert.ok(said.length > 0,
    'a body that visits only two tiles over eight moves is not travelling');
  assert.match(said[0], /pacing/, `expected a pacing line, saw ${said[0]}`);
});

test('CONTROL: the same pacing while something is fighting back is left alone', () => {
  // This is the half that makes the test mean something. A ranged body holds
  // its ground and shoots; if the detector fired here it would break the
  // behaviour that keeps a caster alive.
  const { said } = pace(round(), twoCycle, FIGHT);
  assert.deepEqual(said, [],
    `a standoff is not a trap - saw ${said.join(' | ')}`);
});

test('CONTROL: a body actually going somewhere is left alone', () => {
  const travelling = [];
  for (let i = 0; i < 10; i += 1) {
    travelling.push([(40 + i * 3) * 64, 39 * 64]);
  }
  const { said } = pace(round(), travelling, QUIET);
  assert.deepEqual(said, [],
    `crossing the room is not pacing - saw ${said.join(' | ')}`);
});

test('sub-tile drift on one spot is ONE tile, and one tile is a wedge', () => {
  // This test used to assert that jitter produced NO wedge line, on the
  // premise that a stuck body was the motion watchdog's business. The very
  // next stall disproved that premise: Sir Qwen sat on tile (87,33) for 89
  // log lines without a copper and `stationarySince` never climbed, because
  // it only counts a beat as stationary when the PREVIOUS order was
  // movement - and his beats alternate approach / attack / pick_up.
  //
  // So the window records every beat now and one repeated bucket is a wedge
  // like any other. What survives from the original test, and still matters,
  // is the ARITHMETIC: a few pixels of drift must resolve to ONE tile, or
  // the cardinality test would read jitter as pacing between two.
  const jitter = [];
  for (let i = 0; i < 10; i += 1) {
    jitter.push([83 * 64 + (i % 3), 42 * 64 + (i % 2)]);
  }
  const { said } = pace(round(), jitter, QUIET);
  assert.ok(said.length > 0, 'a body going nowhere with nothing to fight is wedged');
  const named = said[0].match(/pacing ([^ ]+)/)?.[1] ?? '';
  assert.ok(!named.includes('<->'),
    `drift within one tile must name ONE bucket, not a pair - saw ${said[0]}`);
});

test('CONTROL: a fight in two spots does not trip once the fight ends', () => {
  // The residue an adversarial review found: the window never aged, so moves
  // recorded DURING a fight - and the server's own spacing bounces a caster
  // between two spots, which is exactly a two-bucket signature - outlived the
  // fight, and the first quiet beat after the landed window expired tripped
  // on stale combat-era history. Fighting clears the memory now.
  const it = round();
  pace(it, [A, B, A, B, A, B, A, B, A, B], FIGHT);
  const { said } = pace(it, [A, B], QUIET);
  assert.deepEqual(said, [],
    `a won fight must not leave a pacing trip primed - saw ${said.join(' | ')}`);
});

test('the trip enters the cure ladder at the bottom, not the top', () => {
  // Written first as `stationarySince = 8`, and described in the handoff as
  // running "unstick, then reconnect, then leave the room" - which was false.
  // The rungs key on EXACT equality, so 8 skipped unstick and jiggle and
  // opened with a model call. A few pixels of nudge changes the origin the
  // route is recomputed from, which is the likeliest thing to break a
  // two-corner tie, so it must be tried FIRST.
  const it = round();
  const { intents } = pace(it, [...twoCycle, A, B, A, B, A, B], QUIET);
  const first = intents.indexOf('unstick');
  assert.ok(first >= 0,
    `the cheap cure has to actually run - saw ${intents.join(', ')}`);
  assert.ok(!intents.slice(0, first).includes('think_free'),
    `and must not be preceded by a model call - saw ${intents.join(', ')}`);
});

test('the live firing of 2026-08-27 names ONE tile, not two halves of one', () => {
  // Verbatim from the maiden firing:
  //   [wedge] pacing 175,126 <-> 175,127 for 8 moves with nothing to fight
  //
  // The catch was CORRECT - he was genuinely stuck on tile (87,63), the
  // unstick freed him eleven tiles, and hunting resumed in forty seconds.
  // The DESCRIPTION was wrong: 175,126 and 175,127 are 32px buckets, and
  // Miller's Stair is a 64px room, so those are two halves of a single tile.
  // Bucketing finer than the room's own grid turns a stuck body into a
  // phantom pacer, and turns real sub-tile drift into a boundary straddle.
  //
  // The earlier drift test missed this by jittering two pixels; a real body
  // moves thirty.
  const straddle = [];
  for (let i = 0; i < 10; i += 1) {
    // Either side of the 32px line at y = 4064, both inside tile (87,63).
    straddle.push([87 * 64 + 56, 4050 + (i % 2) * 35]);
  }
  const { said } = pace(round(), straddle, QUIET);
  assert.ok(said.length > 0, 'a body going nowhere with nothing to fight is still wedged');
  assert.ok(!said[0].includes('<->'),
    `drift inside one tile must report ONE bucket - saw ${said[0]}`);
});

/**
 * The jiggle hops are [96,0], [-96,64], [0,-96], [-64,-64] - none exceeds 96px
 * on an axis. A march is clamped to 400px toward a bay. So the ONLY honest way
 * to tell them apart in a test is the size of the step, which the first
 * version of this test did not do: it asserted `go_to` appeared at all, and
 * the jiggles alone satisfied that. Review mutated the entire bay march out
 * and the test still passed 8/8.
 */
function stepsFrom(it, at, danger, beats) {
  const moves = [];
  const real = console.log;
  console.log = () => {};
  try {
    for (let i = 0; i < beats; i += 1) {
      const spot = at(i);
      const step = it.next(FIELD, danger(i), { value: 300, total: 633 }, null,
        { room: FIELD, x: spot[0], y: spot[1], level: 42, mp: { value: 205, total: 205 } });
      if ('go_to' === step.action) {
        const [tx, ty] = String(step.target).split(',').map(Number);
        moves.push(Math.max(Math.abs(tx - spot[0]), Math.abs(ty - spot[1])));
      }
      it.completed(step, true, 'walked');
    }
  } finally { console.log = real; }
  return moves;
}

const TWO_SPOTS = (i) => (i % 2 ? [83 * 64, 42 * 64] : [83 * 64, 34 * 64]);
const NEVER_LANDS = () => QUIET;
// One landed hit between episodes - the live shape, and what starved the rung.
const LANDS_SOMETIMES = (i) => (0 === i % 9 ? FIGHT : QUIET);

test('a stuck body eventually MARCHES, not just jiggles', () => {
  const moves = stepsFrom(round(), TWO_SPOTS, NEVER_LANDS, 40);
  assert.ok(moves.some((d) => d > 96),
    `a jiggle is at most 96px on an axis; a march is 400 - saw ${moves.join(', ') || 'no walks'}`);
});

test('AND it still marches when the body lands hits in between', () => {
  // The starvation, review S1: clearing `paceTrips` on any non-quiet beat
  // meant a single landed hit reset the ladder for ever. Driven: no landed
  // hits gave 3 marches in 11 firings; ONE landed hit gave 0. "Earning while
  // pacing" is by definition a body that lands hits between episodes, so the
  // rung could never fire on the ground it was written for.
  const moves = stepsFrom(round(), TWO_SPOTS, LANDS_SOMETIMES, 60);
  assert.ok(moves.some((d) => d > 96),
    `a body that earns between pacing episodes must still escalate`
    + ` - saw ${moves.join(', ') || 'no walks'}`);
});

test('CONTROL: a body going somewhere never escalates at all', () => {
  const travelling = (i) => [(40 + i * 3) * 64, 39 * 64];
  const moves = stepsFrom(round(), travelling, NEVER_LANDS, 40);
  assert.deepEqual(moves, [],
    `crossing the room is not pacing - saw ${moves.join(', ')}`);
});

test('the march does not pay a model call to get there', () => {
  // Review S4: the rung set `stationarySince = 8`, and the next check reads
  // `>= 8` in the SAME beat - so it took the hard-wedge branch, spent a
  // `think_free`, and armed a reconnect ladder before reaching the march a
  // beat later. The borrowed-counter mistake, twice in one file.
  const acts = [];
  const it = round();
  const real = console.log;
  console.log = () => {};
  try {
    for (let i = 0; i < 40; i += 1) {
      const spot = TWO_SPOTS(i);
      const step = it.next(FIELD, QUIET, { value: 300, total: 633 }, null,
        { room: FIELD, x: spot[0], y: spot[1], level: 42, mp: { value: 205, total: 205 } });
      acts.push(step.action);
      it.completed(step, true, 'walked');
    }
  } finally { console.log = real; }
  assert.ok(!acts.includes('think_free'),
    `pacing must not cost a model turn - saw ${acts.join(', ')}`);
  assert.ok(!acts.includes('reconnect'),
    `nor drop the session - saw ${acts.join(', ')}`);
});
