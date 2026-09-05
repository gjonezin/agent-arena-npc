/**
 * The foraging trip: one supervised body, and only from full health.
 *
 * Glenn, 2026-08-27: "a single supervised trip in each area with the
 * resources we need... may need to avoid oathstone for now unless we can
 * quickly grab the materials there before dying."
 *
 * THE FRONTIER TABLE DECIDES THE ROOM. `oathstone` is level 18 and
 * `sinkfoot-crossing` is 26, so Oathstone is the LOWER bar despite its
 * reputation in our logs - and it holds `oathstone_wild_carrots`, foraging 1,
 * the node the whole chain unlocks from. `millrace-ford` is level 10 and
 * safest, but its coal needs mining 5 and its other node is fishing, which
 * neither sheet carries. There is no gentler door.
 *
 * THE ARRIVAL TILE DECIDES THE BODY. Watched live on the supervised run:
 *
 *   16:55:33 walked into the Oathstone
 *   16:55:34 hp 10/836   Stoneclaw 59/895 at 0.1 tiles
 *   16:55:45 bounced out to the inn
 *
 * He set out at ten hit points and met a spawn tile before he could cast
 * anything. The old gate let him because he CARRIES A HEAL - true reasoning
 * for a shopping errand to a safe counter, false for a journey into contested
 * ground. That is what Glenn saw as "they keep going into Oathstone and just
 * dying": not the room being too hard, but bodies arriving at it already
 * spent. Go whole, or do not go.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KnightsRound } from '../dist/harness/reflex.js';

const FIELD = 'millers-stair';
const FORD = 'millrace-ford';
const CALM = { damage: 0, died: false, aggressors: 0, landed: false };
const FIGHT = { damage: 40, died: false, aggressors: 2, landed: true };
const TOOLED = ['chipped pickaxe', 'foraging knife', 'fishing rod', 'knight greatblade'];
const BARE = ['knight greatblade'];
const QWEN = ['fishing', 'mining', 'foraging', 'smelting', 'blacksmithing', 'cooking'];

function knight(professions = QWEN, extra = {}) {
  return new KnightsRound({
    battleStyle: 'melee', skillLadder: [], professions,
    // THE FORD, NAMED. Production fishes the town pond; this file is about the
    // journey to the ford, so it says so.
    healSpell: 'heal', foragingTrip: true, forageRoom: 'millrace-ford',
    shopRoom: 'the-valley-smithy', shopKeeper: 'Nerys', ...extra
  });
}

/** Drive some beats and collect both the intents and any [seam] lines. */
function run(it, carried, scene, hp = 836, danger = CALM, n = 6, note = 'done') {
  const said = [];
  const real = console.log;
  console.log = (...parts) => {
    const line = parts.join(' ');
    if (line.startsWith('[seam]')) {
      said.push(line);
    }
  };
  const acts = [];
  try {
    for (let i = 0; i < n; i += 1) {
      const step = it.next(scene, danger, { value: hp, total: 836 }, null,
        { room: scene, x: 400, y: 400, level: 46, mp: { value: 0, total: 200 } },
        null, null, null, 10, 0, carried, 2168670, 0, []);
      acts.push(step.action);
      it.completed(step, true, note);
    }
  } finally {
    console.log = real;
  }
  return { acts, said };
}

test('a whole, tooled forager sets out for the ford', () => {
  const { said } = run(knight(), TOOLED, FIELD);
  assert.ok(said.some((l) => /setting out for millrace-ford/.test(l)),
    `the trip announces where it is going - saw ${said.join(' | ') || 'nothing'}`);
});

test('standing at the ford, he gathers instead of travelling', () => {
  const { acts } = run(knight(), TOOLED, FORD);
  assert.ok(acts.includes('gather_nearby'),
    `on the ground itself the beat is the gather - saw ${acts.join(', ')}`);
});

test('GO WHOLE OR NOT AT ALL: a spent knight does not set out', () => {
  // The rule this replaced said a body that can heal itself is never too hurt
  // to travel. He set out at 10/836 and the room met him at the door.
  const { said } = run(knight(), TOOLED, FIELD, 84);
  assert.deepEqual(said, [],
    `a body at a tenth of its health stays home - saw ${said.join(' | ')}`);
});

test('a trip abandons itself if the road takes the body down', () => {
  const it = knight();
  run(it, TOOLED, FIELD, 836, CALM, 1);
  const { said } = run(it, TOOLED, 'the-valley', 200, CALM, 3);
  assert.ok(said.some((l) => /giving up/.test(l)),
    `spent on the road is a reason to turn back - saw ${said.join(' | ') || 'nothing'}`);
});

test('THE SWITCH IS PER BODY: a sheet without it never travels', () => {
  // Lord Gemma's shape: forages, carries the knife, and must stay home -
  // 633hp against 836, no heal spell, no potions.
  const homebody = new KnightsRound({
    battleStyle: 'long_range', skillLadder: [], professions: ['foraging', 'cooking'],
    shopRoom: 'the-valley-mage', shopKeeper: 'Wren'
  });
  const said = [];
  const real = console.log;
  console.log = (...parts) => {
    const line = parts.join(' ');
    if (line.startsWith('[seam]')) {
      said.push(line);
    }
  };
  try {
    for (let i = 0; i < 6; i += 1) {
      const step = homebody.next(FIELD, CALM, { value: 633, total: 633 }, null,
        { room: FIELD, x: 400, y: 400, level: 42, mp: { value: 200, total: 200 } },
        null, null, null, 10, 0, TOOLED, 1110000, 0, []);
      homebody.completed(step, true, 'done');
    }
  } finally {
    console.log = real;
  }
  assert.deepEqual(said, [],
    `no foragingTrip on the sheet means no journey - saw ${said.join(' | ')}`);
});

test('CONTROL: no knife, no trip - the tool run comes first', () => {
  const { said, acts } = run(knight(), BARE, FIELD);
  assert.deepEqual(said, [], `no tool, no journey - saw ${said.join(' | ')}`);
  assert.ok(!acts.includes('gather_nearby'));
});

test('CONTROL: a body with no foraging never goes', () => {
  const { said } = run(knight(['smelting', 'blacksmithing']), TOOLED, FIELD);
  assert.deepEqual(said, [], `the sheet decides - saw ${said.join(' | ')}`);
});

test('CONTROL: nothing interrupts a fight for a fish', () => {
  const { said } = run(knight(), TOOLED, FIELD, 836, FIGHT);
  assert.deepEqual(said, [],
    `a trip may not start while something is hitting him - saw ${said.join(' | ')}`);
});

test('attacked ON ARRIVAL, he fights instead of foraging', () => {
  const it = knight();
  run(it, TOOLED, FIELD, 836, CALM, 1);
  const { acts, said } = run(it, TOOLED, FORD, 836, FIGHT, 4);
  assert.ok(!acts.includes('gather_nearby'),
    `no stooping for a fish mid-fight - saw ${acts.join(', ')}`);
  assert.ok(!said.some((l) => /giving up/.test(l)),
    `and no abandoning the arrival - saw ${said.join(' | ')}`);
});

test('a dry patch ends the trip rather than parking him on it', () => {
  const it = knight();
  run(it, TOOLED, FORD, 836, CALM, 1);
  const { said } = run(it, TOOLED, FORD, 836, CALM, 3,
    'nothing of ours to gather within reach');
  assert.ok(said.some((l) => /trip done/.test(l)),
    `empty ground ends the errand - saw ${said.join(' | ') || 'nothing'}`);
});

test('ONCE AN HOUR: a finished trip does not immediately restart', () => {
  const it = knight();
  run(it, TOOLED, FORD, 836, CALM, 1);
  run(it, TOOLED, FORD, 836, CALM, 3, 'nothing of ours to gather within reach');
  const { said } = run(it, TOOLED, FIELD, 836, CALM, 6);
  assert.ok(!said.some((l) => /setting out/.test(l)),
    `the grind is the point; the trip is the exception - saw ${said.join(' | ')}`);
});

/**
 * THE POND AT HOME, AND THE GATE THAT NEVER OPENED.
 *
 * The trip went to `millrace-ford` from 2026-08-27, when it was the only
 * water the harness knew. `valley_spotted_fishing` now sits in town: fishing
 * level 1, 24 xp a charge, on a road these bodies already walk 133 times a
 * day. And the errand asked for 75% health in a world where nothing heals
 * these two - measured over one day in the stair, 2,235 observations at
 * 30-39%, 999 at 40-49%, none above. A gate that never opens is why this
 * errand fired zero times and why the lifetime profession ledger reads zero
 * charges.
 */
test('the trip goes to the pond in town when the sheet does not name a road', () => {
  const homeWater = new KnightsRound({
    battleStyle: 'melee', skillLadder: [], professions: QWEN,
    healSpell: 'heal', foragingTrip: true,
    shopRoom: 'the-valley-smithy', shopKeeper: 'Nerys'
  });
  const { said } = run(homeWater, TOOLED, FIELD);
  assert.ok(said.some((l) => /setting out for the-valley to fish/.test(l)),
    `an unnamed road is the town pond - saw ${said.join(' | ') || 'nothing'}`);
});

test('a knight at half health now sets out, because half is all he ever has', () => {
  // 418 of 836 is 50%: under the old 75% gate, over the new floor.
  const { said } = run(knight(), TOOLED, FIELD, 418);
  assert.ok(said.some((l) => /setting out for/.test(l)),
    `50% must be enough to fish, or the errand never runs - saw ${said.join(' | ') || 'nothing'}`);
});

test('CONTROL: below the abort floor he still stays home', () => {
  // 334 of 836 is 39.9%, under the floor the walk aborts at anyway.
  const { said } = run(knight(), TOOLED, FIELD, 334);
  assert.deepEqual(said, [],
    `the floor still holds, or lowering the gate would be recklessness - saw ${said.join(' | ')}`);
});

/**
 * A FISHING TRIP MUST NOT RETIRE A MINING WALK.
 *
 * `completed()` counts a gather against both `seamWalkGathers` and
 * `seamGathers` when both flags are set, and the trip block sits above the
 * walk block and returns every beat while the trip is live. So four fish
 * taken in town would log "done at the seam" and retire a walk that never
 * reached ore.
 *
 * This was unreachable while the 75% gate meant the errand fired zero times.
 * Opening that gate is what makes it live, which is why the guard and the
 * gate ship together.
 */
test('the fishing trip does not set out on top of a mining walk', () => {
  // The trip block runs before the walk block and returns every beat while it
  // is live, so with the trip switched on from the first beat the walk never
  // starts and this proves nothing. The switch is read from the options
  // object every beat, so the walk is given its head first and the trip is
  // opened afterwards - which is the real sequence: the walk begins while the
  // trip is on its hourly cooldown, and the trip re-arms underneath it.
  const opts = {
    battleStyle: 'melee', skillLadder: [], professions: QWEN,
    healSpell: 'heal', foragingTrip: false, forageRoom: 'millrace-ford',
    shopRoom: 'the-valley-smithy', shopKeeper: 'Nerys'
  };
  const it = new KnightsRound(opts);
  const said = [];
  const real = console.log;
  console.log = (...parts) => {
    const line = parts.join(' ');
    if (line.startsWith('[seam]')) {
      said.push(line);
    }
  };
  const beat = () => {
    const step = it.next(FIELD, CALM, { value: 700, total: 836 }, null,
      { room: FIELD, x: 400, y: 400, level: 46, mp: { value: 0, total: 200 } },
      null, null, null, 10, 0, TOOLED, 2168670, 0, []);
    it.completed(step, true, 'done');
  };
  try {
    for (let i = 0; i < 6; i += 1) { beat(); }
    opts.foragingTrip = true;
    for (let i = 0; i < 10; i += 1) { beat(); }
  } finally {
    console.log = real;
  }

  // POSITIVE CONTROL. Without a walk under way there is nothing to protect,
  // and the assertion below would pass over an empty run.
  assert.ok(said.some((l) => /setting off for the mining seam/.test(l)),
    `the walk must actually start, or this test proves nothing - saw ${said.join(' | ') || 'nothing'}`);
  assert.ok(!said.some((l) => /setting out for .* to fish/.test(l)),
    `a walk was under way and the trip started anyway - saw ${said.join(' | ')}`);
  assert.ok(!said.some((l) => /done at the seam/.test(l)),
    `a walk that never reached ore must not retire as done - saw ${said.join(' | ')}`);
});
