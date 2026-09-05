/**
 * Each road to town says which road it is - driven, not read.
 *
 * Six sites set `leg = 'homebound'`. Until 2026-08-27 not one of them said
 * so, and three sessions argued about which had fired instead of reading it.
 * They route through `goHome(why)` now and log `[leg] homebound: <reason>`.
 *
 * Then two of the reasons turned out to be TRANSPOSED - the field guard wore
 * the inn's label and the inn guard wore the field's - and a reviewer had
 * staked a falsifiable prediction on the exact string. A correct hypothesis
 * printed as a failure. That is the moment these strings stopped being log
 * decoration and became an interface.
 *
 * Both reviewers made the same point about the fix: "verified by reading the
 * condition beside each" is the author checking his own claim, which is two
 * sets of eyes and zero machines. So this file DRIVES each guard and asserts
 * the string that actually comes out. A transposition fails it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KnightsRound, CASTER_GEAR, CASTER_ARMOR } from '../dist/harness/reflex.js';

const FIELD = 'millers-stair';
const TOWN = 'the-valley';
const INN = 'the-valley-inn';
const REAL = ['ash longbow', 'crystal focus', 'spidersilk robes', 'wide blade'];
const LORE = { nothingBuys: true, unstocked: ['sepulchral_vestment'], shoppedAtLevel: 42 };

function magus(lore) {
  const r = new KnightsRound({
    battleStyle: 'long_range', drainSpell: 'drainLife',
    skillLadder: [{ level: 0, skill: 'arcaneRay' }],
    gearLadder: CASTER_GEAR, armorLadder: CASTER_ARMOR,
    shopRoom: 'the-valley-mage', shopKeeper: 'Wren', partner: 'Sir Qwen'
  });
  if (lore) r.remember({ ...lore, unstocked: [...lore.unstocked] });
  return r;
}

/** Run a body through some beats and collect every reason it printed. */
function reasons(round, beats) {
  const said = [];
  const real = console.log;
  console.log = (...parts) => {
    const line = parts.join(' ');
    const hit = /^\[leg\] homebound: (.+)$/.exec(line);
    if (hit) {
      said.push(hit[1]);
    }
  };
  try {
    for (const beat of beats) {
      const step = round.next(
        beat.scene, beat.danger ?? { damage: 0, died: false, aggressors: 0, landed: false },
        { value: beat.hp ?? 633, total: 633 }, null,
        { room: beat.scene, x: 2320, y: 640, level: 42, mp: { value: 205, total: 205 } },
        null, null, null, beat.carrying ?? 60, 0, REAL, 987725, 0,
        [{ key: 'grub_hide', quantity: 60 }]
      );
      round.completed(step, true, 'done');
    }
  } finally {
    console.log = real;
  }
  return said;
}

const field = (over) => ({ scene: FIELD, ...over });

test('the errand names WHICH errand - a full bag', () => {
  // No lore: nothing is known to be unstocked and no level has been shopped,
  // so a bag of sixty is a bank run and says so.
  const said = reasons(magus(null), [field({}), field({}), field({})]);
  assert.ok(said.includes('errand - a full bag to bank'),
    `expected the full-bag reason, saw ${said.join(' | ') || 'nothing'}`);
});

test('a dead body standing in the FIELD says it is resting outside town', () => {
  // The fourth door, found 2026-08-27: the death branch trips on the feed's
  // `died` flag, sets leg='resting' while the body is still in the field,
  // and the resting scene-guard walks it home. This is the exact string a
  // reviewer predicted, and the one the transposition broke.
  const died = { damage: 40, died: true, aggressors: 0, landed: false };
  const said = reasons(magus(LORE), [field({ danger: died }), field({}), field({})]);
  assert.ok(said.includes('resting outside town - walking back'),
    `the field guard must name the FIELD, saw ${said.join(' | ') || 'nothing'}`);
  assert.ok(!said.includes('left the inn after the cask'),
    'and must not wear the inn guard\'s label - that is the transposition');
});

test('a body standing IN THE INN says it is leaving the inn', () => {
  const died = { damage: 40, died: true, aggressors: 0, landed: false };
  const said = reasons(magus(LORE), [
    { scene: INN, danger: died }, { scene: INN }, { scene: INN }
  ]);
  assert.ok(said.includes('left the inn after the cask'),
    `the inn guard must name the INN, saw ${said.join(' | ') || 'nothing'}`);
  assert.ok(!said.includes('resting outside town - walking back'),
    'and must not wear the field guard\'s label');
});

test('the two labels are never the same string', () => {
  // The cheapest possible guard against the class: whatever the wording, the
  // field and the inn must not answer identically, or a tracer reading the
  // log cannot tell which door opened - which is the whole point of the line.
  const died = { damage: 40, died: true, aggressors: 0, landed: false };
  const inField = reasons(magus(LORE), [field({ danger: died }), field({}), field({})]);
  const inInn = reasons(magus(LORE), [{ scene: INN, danger: died }, { scene: INN }, { scene: INN }]);
  assert.notDeepEqual(inField, inInn,
    `two different doors printed the same reason: ${inField.join(' | ')}`);
});

test('a guard that refuses prints no reason at all', () => {
  // The chokepoint answers before the log line, so a refused walk must leave
  // the ledger silent - otherwise the log claims a trip that never happened.
  const died = { damage: 40, died: true, aggressors: 0, landed: false };
  const said = reasons(magus(LORE), [
    field({ danger: died, hp: 3 }), field({ hp: 3 }), field({ hp: 3 })
  ]);
  assert.deepEqual(said, [],
    `a body too hurt to travel must log no departure, saw ${said.join(' | ')}`);
});
