/**
 * A tool for each gathering trade, bought once, and never at death's door.
 *
 * Glenn, 2026-08-27: "well have them get the tools they need once."
 *
 * The trade beat was scaffolding until this. Every gathering node in the
 * world declares a `toolFamily` and `toolPower >= 1`, and neither body owned
 * a tool - so a mining offer in Miller's Stair found its seam every time and
 * was refused TOOL_MISSING every time.
 *
 * The pickaxe cannot cost Sir Qwen his greatsword: `tool()` is built on
 * `material()`, so a tool is `type: 'material'` - carried, never equipped.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KnightsRound, CASTER_GEAR, CASTER_ARMOR } from '../dist/harness/reflex.js';

const FIELD = 'millers-stair';
const POST = 'the-valley-trading-post';
const CALM = { damage: 0, died: false, aggressors: 0, landed: false };

function body(professions, carried) {
  return { round: new KnightsRound({
    battleStyle: 'long_range', skillLadder: [], professions,
    gearLadder: CASTER_GEAR, armorLadder: CASTER_ARMOR,
    shopRoom: 'the-valley-mage', shopKeeper: 'Wren'
  }), carried };
}

function beats(it, carried, scene, hp, n = 8) {
  const seen = [];
  for (let i = 0; i < n; i += 1) {
    const step = it.next(scene, CALM, { value: hp, total: 633 }, null,
      { room: scene, x: 2320, y: 640, level: 42, mp: { value: 205, total: 205 } },
      null, null, null, 10, 0, carried, 1056589, 0, []);
    seen.push(step);
    // The note matters now. `walkToSomebody` answers ok while still walking -
    // "on the way to X" - and only "walked over to X" means the body is at
    // the counter. Buying on the first ok is what produced three live laps of
    // "You are too far away to trade with Toma", so the rig has to speak the
    // world's own two answers rather than a flat 'done'.
    it.completed(step, true,
      'walk' === step.action ? `walked over to ${step.place}` : 'done');
  }
  return seen;
}

const QWEN = ['mining', 'foraging', 'smelting', 'blacksmithing', 'cooking'];
const GEMMA = ['foraging', 'jewelcrafting', 'tailoring', 'woodcraft', 'cooking'];
const BARE = ['crystal focus', 'spidersilk robes'];

test('a knight with no pickaxe goes for one', () => {
  const { round } = body(QWEN, BARE);
  const buys = beats(round, BARE, POST, 633).filter((s) => 'buy' === s.action);
  assert.ok(buys.length > 0, 'standing at the counter, he must actually buy');
  assert.equal(buys[0].item, 'chipped_pickaxe', 'mining is first on his sheet');
});

test('a Magus asks for the knife, never the pickaxe - he does not mine', () => {
  const { round } = body(GEMMA, BARE);
  const buys = beats(round, BARE, POST, 633).filter((s) => 'buy' === s.action);
  assert.ok(buys.length > 0, 'he forages, so he needs the knife');
  assert.equal(buys[0].item, 'foraging_knife');
  assert.ok(!buys.some((b) => 'chipped_pickaxe' === b.item),
    'mining was taken off his sheet by order; the tool follows the sheet');
});

test('ONCE: a body already carrying its tools buys nothing and stays out', () => {
  const kitted = [...BARE, 'chipped pickaxe', 'foraging knife'];
  const { round } = body(QWEN, kitted);
  const steps = beats(round, kitted, FIELD, 633);
  assert.ok(!steps.some((s) => 'buy' === s.action), 'nothing left to buy');
  // NOT "he never leaves the field". He may still leave it for a gear rung -
  // the first version of this test asserted no door at all and failed on
  // exactly that, which the errand's own reason string named for me in one
  // line rather than leaving it to be guessed at. What must be true is
  // narrower: nowhere in the plan is he heading for the tool counter.
  assert.ok(!steps.some((s) => 'walk' === s.action && 'Toma' === s.target),
    `no crossing to the tool keeper - saw ${steps.map((s) => `${s.action}${s.target ? ' ' + s.target : ''}`).join(', ')}`);
  assert.notEqual(round.plan().dest, 'the-valley-trading-post',
    'and the trading post is not the destination');
});

test('NOT AT DEATH\'S DOOR: a dying body does not shop for a knife', () => {
  // The measured rule from tonight: a trip at 4 hp of 620 cost three times
  // what dying costs and healed nothing. The tool can wait for a whole body.
  const { round } = body(QWEN, BARE);
  const steps = beats(round, BARE, FIELD, 20);
  // NARROWED 2026-08-27, and the comment above says why in its last four
  // words: "and healed nothing". This banned every `use_door`, which reads as
  // "a dying body does not travel". That is not the rule the incident taught.
  // The rule is that a dying body does not travel somewhere that CANNOT MEND
  // IT. The shrine errand walks a helpless body to Ossian for a free full
  // restore - the one journey the empty-cabinet incident argues FOR - so this
  // names the shopping trip rather than the act of walking.
  assert.ok(!steps.some((s) => 'buy' === s.action),
    `a tool errand at 3% hp is the shopping trip we already retired`
    + ` - saw ${steps.map((s) => s.action).join(', ')}`);
  assert.notEqual(round.plan().dest, 'the-valley-trading-post',
    'and the tool counter is not where a dying body is headed');
});

test('a counter that will not sell it is not asked twice', () => {
  const { round } = body(QWEN, BARE);
  round.completed({ action: 'buy', item: 'chipped_pickaxe', quantity: 1 },
    false, 'Toma does not sell "chipped_pickaxe"');
  const buys = beats(round, BARE, POST, 633).filter((s) => 'buy' === s.action);
  assert.ok(!buys.some((b) => 'chipped_pickaxe' === b.item),
    'a refusal is remembered, as it is for the sepulchral vestment');
});

/**
 * The two defects the maiden run found, pinned so they cannot come back.
 *
 * 05:02:37  walk Toma -> there is no "undefined" here
 * 05:03:01  buy foraging_knife -> You are too far away to trade with Toma
 * 05:03:01  [leg] homebound: restock outside town or the shop room
 *
 * (A) The walk carried `target`; every working shop walk in this file uses
 *     `place`. The Intent fields are per-action and nothing types them, so
 *     the only defence is copying the call that works.
 * (B) The restock guard read the trading post as foreign ground - Lord
 *     Gemma's shopRoom is the mage's shop - and marched him out of the room
 *     the errand had just walked him across the world to reach. That is the
 *     smithy bounce documented ten lines above that guard, one room over.
 */
test('the walk to the keeper names the keeper', () => {
  const { round } = body(QWEN, BARE);
  const walk = beats(round, BARE, POST, 633).find((s) => 'walk' === s.action);
  assert.ok(walk, 'he has to cross to the counter before he can trade');
  assert.equal(walk.place, 'Toma',
    `the keeper's name must ride the field the executor reads`
    + ` - saw ${JSON.stringify(walk)}`);
  assert.notEqual(walk.place, undefined);
});

test('the tool counter is not foreign ground while a tool is wanted', () => {
  const { round } = body(QWEN, BARE);
  const said = [];
  const real = console.log;
  console.log = (...p) => {
    const line = p.join(' ');
    if (line.startsWith('[leg] homebound')) {
      said.push(line);
    }
  };
  try {
    beats(round, BARE, POST, 633, 10);
  } finally {
    console.log = real;
  }
  assert.deepEqual(said, [],
    `standing at the counter he walked across the world for, nothing may`
    + ` march him out - saw ${said.join(' | ')}`);
});

test('a walk still in progress does NOT open the purchase', () => {
  // Three live laps were lost to this: the buy fired from the doorway on a
  // walk that had answered ok mid-stride, and the world refused it for
  // distance every time.
  const { round } = body(QWEN, BARE);
  const seen = [];
  for (let i = 0; i < 8; i += 1) {
    const step = round.next(POST, CALM, { value: 633, total: 633 }, null,
      { room: POST, x: 544, y: 352, level: 42, mp: { value: 205, total: 205 } },
      null, null, null, 10, 0, BARE, 1056589, 0, []);
    seen.push(step);
    round.completed(step, true,
      'walk' === step.action ? `on the way to ${step.place}` : 'done');
  }
  assert.ok(!seen.some((s) => 'buy' === s.action),
    `nothing may be bought from the doorway - saw ${seen.map((s) => s.action).join(', ')}`);
  assert.ok(seen.some((s) => 'walk' === s.action), 'and he keeps walking');
});

test('a knight who can heal himself still runs the errand at low hp', () => {
  // The deadlock this pins, found live before it cost a night: Sir Qwen
  // one-shots the room, so nothing survives to hit him back and nothing kills
  // him - he sat between 4% and 12% of 836 for HOURS, stable, never dying and
  // never healing. An hp-only "above half to shop" rule means he never buys
  // the pickaxe, so he never mines, ever.
  //
  // Hurt is not the same as doomed. The rule is "do not walk to town when the
  // walk cannot end in medicine", and he carries `heal`.
  const round = new KnightsRound({
    battleStyle: 'melee', skillLadder: [], professions: QWEN,
    healSpell: 'heal', healBelowPercent: 50,
    gearLadder: CASTER_GEAR, armorLadder: CASTER_ARMOR,
    shopRoom: 'the-valley-smithy', shopKeeper: 'Nerys'
  });
  const seen = [];
  for (let i = 0; i < 6; i += 1) {
    const step = round.next(POST, CALM, { value: 36, total: 836 }, null,
      // MANA DRY, which is why he is at 4% in the first place. With a pool
      // he would spend every beat mending himself and the errand would
      // rightly wait; live he cannot, so he neither heals nor dies, and an
      // hp-only gate would strand him below the shopping line for ever.
      { room: POST, x: 544, y: 352, level: 46, mp: { value: 0, total: 200 } },
      null, null, null, 10, 0, BARE, 2163798, 0, []);
    seen.push(step);
    round.completed(step, true,
      'walk' === step.action ? `walked over to ${step.place}` : 'done');
  }
  assert.ok(seen.some((s) => 'buy' === s.action),
    `a body that can mend itself is not too hurt for a 40-copper errand`
    + ` - saw ${seen.map((s) => s.action).join(', ')}`);
});
