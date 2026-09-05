/**
 * A LOCKED DOOR IS NOT A RETRY.
 *
 * Watched live, 2026-08-27, four minutes after the fishing trip shipped. Both
 * bodies, at full health, in a room with zero hostiles:
 *
 *   20:25:13 use_door millrace-approach -> the door did not open: That door
 *            is locked. It needs tansys_road_writ. Find the Carter's Tally
 *            in Miller's Stair. Deliver it to Tansy in the Valley grange.
 *   20:26:24 force_doors -> every visible door refused
 *   20:26:38 use_door millrace-approach -> ...That door is locked...
 *   20:27:28 force_doors -> every visible door refused
 *   20:27:42 use_door millrace-approach -> ...That door is locked...
 *
 * The destination was picked off the frontier LEVEL table, which says how
 * hard a room is and nothing at all about whether its road is open. Level is
 * not access. The trip had no way to learn the difference except by walking
 * into it, and no way to remember once it had.
 *
 * Two separate mistakes made it a loop rather than one wasted walk:
 *
 *  1. The trip retries for SEAM_WALK_BEATS - 400 beats, about forty-seven
 *     minutes - because every abandon reason it knew about was transient.
 *  2. "That door is locked" matches `did not open`, which arms the physical
 *     escalation ladder: unstick, force the doors, hand a turn to the model.
 *     Not one rung of that ladder can produce a quest item.
 *
 * So the rule: a refusal that names its price is permanent. Write it down,
 * stop asking, and go back to the grind.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KnightsRound } from '../dist/harness/reflex.js';

const STAIR = 'millers-stair';
const VALLEY = 'the-valley';
const CALM = { damage: 0, died: false, aggressors: 0, landed: false };
const TOOLED = ['chipped pickaxe', 'foraging knife', 'fishing rod', 'knight greatblade'];
const QWEN = ['fishing', 'mining', 'foraging', 'smelting', 'blacksmithing', 'cooking'];

/** The world's own words, copied from the log above. */
const LOCKED = 'the door did not open: That door is locked. It needs '
  + 'tansys_road_writ. Find the Carter\'s Tally in Miller\'s Stair.';
/** A door the body cannot REACH - the failure the ladder was built for. */
const BLOCKED = 'the door did not open: something may be in the way';

function knight() {
  return new KnightsRound({
    battleStyle: 'melee', skillLadder: [], professions: QWEN,
    // THE ROAD THIS FILE IS ABOUT. The trip's destination is a character
    // option now, and production sends it to the town pond. This file tests a
    // LOCKED DOOR on the road to the ford, so it names that road rather than
    // inheriting whichever one production currently prefers.
    healSpell: 'heal', foragingTrip: true, forageRoom: 'millrace-ford',
    shopRoom: 'the-valley-smithy', shopKeeper: 'Nerys'
  });
}

/**
 * The one door the world actually refused. Every other door in the world
 * opens normally - locking them all would bar the road to the body's own
 * hunting ground and prove nothing about this defect.
 */
const SHUT = 'millrace-approach';

/**
 * Drive beats, answering ONLY the shut door with `note`. Collects the
 * intents and any [seam]/[door] lines.
 */
function run(it, scene, n, note, ok = false) {
  const said = [];
  const acts = [];
  const real = console.log;
  console.log = (...parts) => {
    const line = parts.join(' ');
    if (line.startsWith('[seam]') || line.startsWith('[door]')) {
      said.push(line);
    }
  };
  try {
    for (let i = 0; i < n; i += 1) {
      const step = it.next(scene, CALM, { value: 836, total: 836 }, null,
        { room: scene, x: 400, y: 400, level: 46, mp: { value: 0, total: 200 } },
        null, null, null, 10, 0, TOOLED, 2168670, 0, []);
      acts.push(step);
      const atShut = 'use_door' === step.action && SHUT === step.place;
      it.completed(step, atShut ? ok : true, atShut ? note : 'ok');
    }
  } finally {
    console.log = real;
  }
  return { acts, said };
}

/** Every door this body asked for, in order. */
const doors = (acts) => acts.filter((a) => 'use_door' === a.action).map((a) => a.place);

test('THE LOCK IS WRITTEN DOWN the first time the world names its price', () => {
  const it = knight();
  run(it, STAIR, 2, LOCKED);
  const { said } = run(it, VALLEY, 4, LOCKED);
  assert.ok(said.some((l) => /^\[door\] millrace-approach is barred/.test(l)),
    `the refusal is recorded by name - saw ${said.join(' | ') || 'nothing'}`);
});

test('AND THE DOOR IS NEVER ASKED AGAIN', () => {
  const it = knight();
  run(it, STAIR, 2, LOCKED);
  const { acts } = run(it, VALLEY, 12, LOCKED);
  const asked = doors(acts).filter((p) => 'millrace-approach' === p);
  assert.equal(asked.length, 1,
    `one refusal is enough; asked ${asked.length} times over twelve beats`);
});

test('THE TRIP ENDS ON THE LOCK, not forty-seven minutes later', () => {
  const it = knight();
  run(it, STAIR, 2, LOCKED);
  const { said } = run(it, VALLEY, 4, LOCKED);
  assert.ok(said.some((l) => /the road to millrace-ford is barred/.test(l)),
    `the trip says why it stopped - saw ${said.join(' | ') || 'nothing'}`);
});

test('AND IT DOES NOT SET OUT AGAIN from a room where the lock is out of sight', () => {
  // From the stair the next door is `the-valley`, which is NOT barred, so
  // the one-door-ahead check alone cannot stop the errand starting over.
  //
  // AN HOUR MUST PASS FOR THIS TO MEAN ANYTHING. `seamAt` is stamped on
  // every abandon and MINE_EVERY_MS holds the next trip for an hour, so
  // within that hour the trip stays home whether or not the road is
  // remembered - and an assertion written without this line passes with the
  // destination bar deleted. Proven by mutation: removing `seamBarred`
  // left this test green until the clock was wound forward.
  //
  // `private` is a compile-time word in TypeScript; the compiled field is an
  // ordinary property, which is the whole reason this seam exists at all.
  const it = knight();
  run(it, STAIR, 2, LOCKED);
  run(it, VALLEY, 4, LOCKED);
  it.seamAt = 0;
  const { said } = run(it, STAIR, 30, LOCKED);
  assert.ok(!said.some((l) => /setting out/.test(l)),
    `a shut road stays shut, an hour later too - saw ${said.join(' | ')}`);
});

test('CONTROL: with the road OPEN, that same hour-later beat does set out', () => {
  // Otherwise the test above passes because the trip is broken rather than
  // because the road is remembered.
  const it = knight();
  run(it, STAIR, 2, 'ok', true);
  run(it, VALLEY, 4, 'ok', true);
  it.seamAt = 0;
  it.seamRun = false;
  const { said } = run(it, STAIR, 30, 'ok', true);
  assert.ok(said.some((l) => /setting out/.test(l)),
    `an open road is walked - saw ${said.join(' | ') || 'nothing'}`);
});

test('CONTROL: a door that is merely BLOCKED is still retried', () => {
  // The whole escalation ladder exists for this case. Barring it would be a
  // far worse bug than the loop this fixes.
  const it = knight();
  run(it, STAIR, 2, BLOCKED);
  const { acts, said } = run(it, VALLEY, 12, BLOCKED);
  const asked = doors(acts).filter((p) => 'millrace-approach' === p);
  assert.ok(asked.length > 1,
    `a physical block is transient and must be retried - asked ${asked.length} times`);
  assert.ok(!said.some((l) => /barred/.test(l)),
    `and nothing is written down - saw ${said.join(' | ')}`);
});

test('CONTROL: a door that OPENS is not barred', () => {
  const it = knight();
  run(it, STAIR, 2, 'ok', true);
  const { said } = run(it, VALLEY, 6, 'ok', true);
  assert.ok(!said.some((l) => /barred/.test(l)),
    `success is not a refusal - saw ${said.join(' | ')}`);
});

/**
 * THE REFUSALS THAT MUST NOT BAR A DOOR.
 *
 * The pattern read `/that door is locked|it needs \w|requires? \w/i` until an
 * adversarial review, 2026-08-27. The note it is handed is NOT limited to the
 * world's refusal prose: `perform()` catches every transport, gateway and
 * validation error and passes the raw message straight through. Each of the
 * strings below is a real one, and each BARRED A DOOR FOR THE LIFE OF THE
 * PROCESS under the old pattern.
 *
 * A bar is permanent and silent. A false one is the worst failure this file
 * can produce - the body simply stops using a road and never says why - so
 * these are worth more than the rule they guard.
 *
 * The only negative control this file had was "something may be in the way",
 * a string that appears in no log at all. It could not have caught any of
 * this.
 */
const TRANSIENT = [
  ['a gateway asking for a moment',
   'the door did not open: The gateway requires a moment; try again.'],
  ['a door still swinging',
   'the door did not open: it needs to finish moving first'],
  ['a session not up yet',
   'the door did not open: Server requires initialization'],
  ['a rate limit',
   'the door did not open: rate limited; requires backoff'],
  // Not hypothetical: this appears fifty times over in the logs as world
  // `gameplayHint` text, and it has nothing to do with the door at all.
  ['a crafting hint riding along on the failure',
   'the door did not open: Requires Blacksmithing level 20.'],
  // THE OTHER TWO REFUSALS THE WORLD ACTUALLY SENDS. Counted over every
  // captured log, `use_door` has failed with exactly three distinct
  // sentences: the writ lock (43), and these (41 and 21). Both are
  // transient by construction - one is a race with another movement call,
  // the other is a door that did not take on this pass - and barring either
  // would cost the body a road it uses every hour.
  ['a movement call that got there first',
   'the door did not open: Another movement call took the body before this'
     + ' door was reached, so the transition did not happen'],
  ['a door walked at from every side',
   'the door did not open: Walked into the door from every side and the'
     + ' room did not change'],
  // THE SUBSTRING TRAP. `blocked` ends in `locked`, so a pattern loosened to
  // /locked/i - the obvious "simplification" of the rule this file guards -
  // bars on it. `blocked` is the world's own word: `on blocked tile` appears
  // throughout the observation feed. This exact sentence is not quoted from
  // a log, and it is here because the trap is one edit away, not because it
  // has happened yet.
  ['a way that is merely blocked',
   'the door did not open: the way is blocked']
];

for (const [what, note] of TRANSIENT) {
  test(`CONTROL: ${what} does not bar the door`, () => {
    const it = knight();
    run(it, STAIR, 2, note);
    const { acts, said } = run(it, VALLEY, 12, note);
    assert.ok(!said.some((l) => /barred/.test(l)),
      `nothing is written down for a transient refusal - saw ${said.join(' | ')}`);
    const asked = doors(acts).filter((p) => SHUT === p);
    assert.ok(asked.length > 1,
      `and the door is asked again - asked ${asked.length} times over twelve beats`);
  });
}

test('POSITIVE CONTROL: the genuine writ sentence still bars, in the same rig', () => {
  // Paired deliberately with the five above. Without it, deleting the bar
  // outright would turn every one of them green - the exact shape of a
  // negative-control suite that proves nothing.
  const it = knight();
  run(it, STAIR, 2, LOCKED);
  const { acts, said } = run(it, VALLEY, 12, LOCKED);
  assert.ok(said.some((l) => /^\[door\] millrace-approach is barred/.test(l)),
    `the writ sentence is a lock and is recorded - saw ${said.join(' | ') || 'nothing'}`);
  assert.equal(doors(acts).filter((p) => SHUT === p).length, 1,
    'and asked exactly once');
});

test('POSITIVE CONTROL: the world says it in one sentence, and case is not the test', () => {
  // The gateway has emitted this both mid-sentence and lower-cased. The
  // pattern is case-insensitive on purpose, and that is worth pinning: a
  // stricter one would silently stop barring and the loop would come back.
  const it = knight();
  const shouted = 'the door did not open: THAT DOOR IS LOCKED. It needs tansys_road_writ.';
  run(it, STAIR, 2, shouted);
  const { said } = run(it, VALLEY, 4, shouted);
  assert.ok(said.some((l) => /barred/.test(l)),
    `a lock is a lock however it is punctuated - saw ${said.join(' | ') || 'nothing'}`);
});
