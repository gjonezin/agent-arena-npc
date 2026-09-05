/**
 * THE OFFER IS RATIONED, AND ONE BEAT IN EIGHT IS THE RATION.
 *
 * `GATHER_EVERY_N_BEATS` has been 16, then 0 (off), then 1, and is now 8.
 * Every one of those numbers was set for a reason and three of them were
 * wrong, so this file is about the CADENCE and nothing else.
 *
 * WHY IT WAS RAISED. Measured over every captured log, in `millers-stair`,
 * the room both bodies hunt in:
 *
 *   Lord Gemma  9,718 samples   within 12 tiles of an ore node: 27  (0.28%)
 *   Sir Qwen   11,242 samples   within 12 tiles of an ore node:  2  (0.02%)
 *
 * Nearest approach ever recorded is ONE tile - they have stood on the copper
 * ore. But an offer made on one beat in sixteen has to coincide with one of
 * those rare moments, and the product of the two is about two chances in ten
 * thousand. That is the whole explanation for a lifetime ledger reading
 * `0 of 30 offers found something`.
 *
 * WHY IT WAS NOT RAISED TO EVERY BEAT. It was, briefly, and it was a live
 * regression: both bodies stopped fighting. Fifteen consecutive decisions per
 * body on the running world, 13 of 15 `gather_nearby`, one attack in twenty
 * minutes. The argument for it was that the offer is FREE - `gatherNearby`
 * filters an observation already in hand and calls the world only when a node
 * is genuinely in range. True, and beside the point: the offer still CONSUMES
 * THE BEAT. The round returns it as this tick's intent, so the body does not
 * swing, walk or loot. Free of network is not free of time.
 *
 * WHY THIS FILE HAD TO BE TIGHTENED. Its assertion was `offers > 1` over
 * twelve beats. That passes at one in one, one in five and one in eight
 * alike - it could not tell a healthy cadence from the outage above, which is
 * the one thing it exists to tell. Both bounds are now asserted, and both
 * directions are proven by mutation: `GATHER_EVERY_N_BEATS` set to 1 and set
 * to 0 each fail this file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KnightsRound } from '../dist/harness/reflex.js';

const FIELD = 'millers-stair';
const CALM = { damage: 0, died: false, aggressors: 0, landed: false };
const FIGHT = { damage: 40, died: false, aggressors: 2, landed: true };
const KIT = ['chipped pickaxe', 'knight greatblade'];
/**
 * TRADES CHOSEN SO THAT NOTHING ELSE OUTRANKS THE OFFER, and both exclusions
 * are load-bearing:
 *
 *  - not `mining`, because `millers-stair` carries a mining seam in
 *    SEAMS_UNDERFOOT and a body that can work it now WALKS to it rather than
 *    standing still and offering. That is correct, and it would make this
 *    file measure the walk instead of the cadence.
 *  - not `foraging` or `fishing`, because TOOL_FOR maps them to a knife and a
 *    rod, the kit below carries neither, and the tool errand outranks every
 *    leg - the body leaves for the trading post and the beat under test never
 *    happens. Seen while writing this: twelve beats of `use_door`.
 *
 * Smelting, blacksmithing and cooking need no tool and have no seam here, so
 * what is left is the offer.
 */
const TRADES = ['smelting', 'blacksmithing', 'cooking'];

/**
 * FORTY BEATS, not twelve.
 *
 * Twelve was too short a window to measure a period of eight in: one offer or
 * two is the same reading whether the ration is one in five or one in
 * fifteen. Forty gives eight offers, which is enough to bound from both
 * sides and enough to see the gaps between them.
 */
const BEATS = 40;

function knight(professions = TRADES) {
  return new KnightsRound({
    battleStyle: 'melee', skillLadder: [], professions,
    healSpell: 'heal',
    shopRoom: 'the-valley-smithy', shopKeeper: 'Nerys'
  });
}

/** Drive hunting beats and collect the actions asked for. */
function hunt(it, danger = CALM, n = BEATS) {
  const acts = [];
  for (let i = 0; i < n; i += 1) {
    const step = it.next(FIELD, danger, { value: 836, total: 836 }, null,
      { room: FIELD, x: 400, y: 400, level: 46, mp: { value: 200, total: 200 } },
      null, null, null, 10, 0, KIT, 2168670, 0, []);
    acts.push(step.action);
    it.completed(step, true, 'nothing of ours to gather within reach');
  }
  return acts;
}

const count = (acts, action) => acts.filter((a) => action === a).length;

/** How many beats apart consecutive offers fall. */
function gaps(acts) {
  const out = [];
  let last = -1;
  acts.forEach((a, i) => {
    if ('gather_nearby' === a) {
      if (last >= 0) out.push(i - last);
      last = i;
    }
  });
  return out;
}

test('a hunting body with trades on its sheet offers the trades', () => {
  const acts = hunt(knight());
  assert.ok(acts.includes('gather_nearby'),
    `the offer is made while hunting - saw ${acts.join(', ')}`);
});

test('THE FLOOR: the offer is made often enough to ever coincide with a node', () => {
  // At one in sixteen the ledger read `0 of 30 offers found something` over
  // the harness's whole life, because the bodies are within reach of a node
  // about 0.3% of the time and a rare offer rarely lands on one of those
  // beats. At least one beat in ten has to carry the offer for the feature
  // to be worth its code at all.
  const acts = hunt(knight());
  const offers = count(acts, 'gather_nearby');
  assert.ok(offers >= BEATS / 10,
    `at least one beat in ten must offer - saw ${offers} in ${BEATS}`);
});

test('THE CEILING: and rarely enough that the body still fights', () => {
  // THE ASSERTION THE OUTAGE WOULD HAVE TRIPPED. With the period at 1 the
  // round returned `gather_nearby` on 13 of 15 consecutive decisions and
  // both bodies stopped swinging. A ration that spends more than one beat in
  // four on an offer is not a ration.
  const acts = hunt(knight());
  const offers = count(acts, 'gather_nearby');
  assert.ok(offers <= BEATS / 4,
    `at most one beat in four may offer - saw ${offers} in ${BEATS}`
    + ` (${acts.join(', ')})`);
});

test('AND the offers are spaced, never taken two beats running', () => {
  // The count alone can be satisfied by a burst followed by silence, which
  // is not what a period means and not what the grind can absorb. This is
  // the shape assertion beside the size one.
  const acts = hunt(knight());
  const spacing = gaps(acts);
  assert.ok(spacing.length > 0, `there must be offers to space - saw ${acts.join(', ')}`);
  assert.ok(Math.min(...spacing) >= 3,
    `no two offers within three beats - gaps were ${spacing.join(',')}`);
});

test('AND the body swings at least as often as it stoops', () => {
  // The plainest statement of what the regression cost, and the one a reader
  // can check against the world: one attack in twenty minutes.
  const acts = hunt(knight());
  assert.ok(count(acts, 'attack') >= count(acts, 'gather_nearby'),
    `fighting is the grind - ${count(acts, 'attack')} attacks against`
    + ` ${count(acts, 'gather_nearby')} offers in ${BEATS} beats`);
});

test('CONTROL: a sheet with no trades never offers', () => {
  const acts = hunt(knight([]));
  assert.ok(!acts.includes('gather_nearby'),
    `no trades, no offer - saw ${acts.join(', ')}`);
});

test('CONTROL: nothing is gathered while something is biting', () => {
  // The standing order is fight to the death. The universal fight-back rule
  // sits above this beat, and a body being hit must never stoop for an ore.
  const acts = hunt(knight(), FIGHT);
  assert.ok(!acts.includes('gather_nearby'),
    `a fight outranks a seam - saw ${acts.join(', ')}`);
});

/**
 * WHERE THE OFFER IS MADE, which was the other thing nothing watched.
 *
 * The guard reads `FIELDS.includes(scene)`. Found by mutation: deleting that
 * clause outright left the whole suite green. FIELDS is one room - the stair
 * - and a beat spent asking a shop counter for ore is a beat the body spends
 * standing in a doorway doing nothing while a purchase or a sale waits.
 */
const SHOP = 'the-valley-smithy';

/** The same beats, somewhere that is not a field. */
function indoors(it, n = BEATS) {
  const acts = [];
  for (let i = 0; i < n; i += 1) {
    const step = it.next(SHOP, CALM, { value: 836, total: 836 }, null,
      { room: SHOP, x: 400, y: 400, level: 46, mp: { value: 200, total: 200 } },
      null, null, null, 10, 0, KIT, 2168670, 0, []);
    acts.push(step.action);
    it.completed(step, true, 'ok');
  }
  return acts;
}

test('THE OFFER IS A FIELD BEAT: no ore is asked for at a shop counter', () => {
  const acts = indoors(knight());
  assert.ok(!acts.includes('gather_nearby'),
    `a smithy has no seams - saw ${acts.join(', ')}`);
});

test('CONTROL: the same body, same beats, DOES offer out in the field', () => {
  // Without this the test above passes just as well if the offer is dead,
  // which is the state it was in twice already.
  const acts = hunt(knight());
  assert.ok(acts.includes('gather_nearby'),
    `the field is where the offer belongs - saw ${acts.join(', ')}`);
});
