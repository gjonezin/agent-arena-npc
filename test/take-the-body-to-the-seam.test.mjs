/**
 * TAKE THE BODY TO THE SEAM. The third attempt, and the first built on the
 * movement that works.
 *
 * Glenn, 2026-08-27: "I see fishing rods and other tools and no progress with
 * skills." The lifetime profession ledger was ZERO charges, and the reason was
 * never the tools. Measured across every captured log in `millers-stair`:
 *
 *   Lord Gemma  9,718 samples   within 12 tiles of ore  0.28%
 *   Sir Qwen   11,242 samples   within 12 tiles of ore  0.02%
 *
 * Ore at tile (90,171); the pair fight between (13,43) and (60,55). Offering
 * the trade beat more often cannot fix a body that is never near a node, and
 * measurably did not.
 *
 * The two earlier attempts aimed ONE long `arena_move_to` at the ore and it
 * stalled: `go_to 5792,10976 -> did not move from tile 85,25`, five times.
 * This one hops - 400px a beat, the same clamp the bay march uses, which
 * demonstrably crosses this room and put both bodies on tile (89,157).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KnightsRound } from '../dist/harness/reflex.js';

const STAIR = 'millers-stair';
const CALM = { damage: 0, died: false, aggressors: 0, landed: false };
const FIGHT = { damage: 40, died: false, aggressors: 2, landed: true };
const KIT = ['chipped pickaxe', 'knight greatblade'];
/** The iron ore's own pixel centre - tile (90,171) at 64px. */
const ORE = { x: 5792, y: 10976 };

function knight(professions = ['mining', 'smelting', 'cooking']) {
  return new KnightsRound({
    battleStyle: 'melee', skillLadder: [], professions,
    healSpell: 'heal',
    shopRoom: 'the-valley-smithy', shopKeeper: 'Nerys'
  });
}

/** Drive beats from a given pixel position and collect the intents. */
function walk(it, at, n = 6, danger = CALM, hp = 836) {
  const acts = [];
  const said = [];
  const real = console.log;
  console.log = (...p) => { const l = p.join(' '); if (l.startsWith('[seam]')) said.push(l); };
  try {
    for (let i = 0; i < n; i += 1) {
      const step = it.next(STAIR, danger, { value: hp, total: 836 }, null,
        { room: STAIR, x: at.x, y: at.y, level: 46, mp: { value: 200, total: 200 } },
        null, null, null, 10, 0, KIT, 2168670, 0, []);
      acts.push(step);
      it.completed(step, true, 'ok - on the way');
    }
  } finally {
    console.log = real;
  }
  return { acts, said };
}

// BOTH ARE WALKING BEATS. `route_to` replaced `go_to` here on 2026-09-02:
// the errand now hands the whole distance to the grid search rather than
// clamping a straight line 400px at a time (see reflex's seam block). These
// tests care that the beat is SPENT WALKING, not which primitive carries it.
const hops = (acts) => acts.filter((a) => 'go_to' === a.action || 'route_to' === a.action);

/**
 * THE WALK IS BACK ON, AND IT PAID. These tests hold the switch rather than
 * the mechanism, and the switch has now been settled by measurement.
 *
 * 2026-08-31, live: with SEAM_WALK_ON true, Sir Qwen walked 162 tiles to the
 * copper seam over 129 beats, arrived at tile (91,173), and took charges -
 *
 *   [craft] copper ore gave 1 x copper_ore (+25 mining xp, 5 charge(s) left)
 *   [trade] copper ore at 1.4t - 4 of 4 charges taken
 *   [craft] gather copper ore refused: NODE_EMPTY
 *
 * Seven charges, seven copper ore, the node worked empty. The FIRST profession
 * charges this harness has ever recorded.
 *
 * WHY IT FAILED BEFORE, and this is the part worth keeping: the walk was never
 * the problem. `approach()` clamped every walk to a 3-tile rim margin, so on a
 * 192x176 map maxY was 172 - and the copper seam sits on row 174. Every walk to
 * it was silently rewritten two tiles short of a node that needs 1.5 tiles to
 * swing. The ledger below was real, and it was measuring a broken world. Fixing
 * the margin invalidated the verdict without anyone re-running it.
 *
 * The old reasoning is kept underneath, because being wrong for a good reason
 * is worth reading twice.
 *
 * (superseded) THE WALK IS SWITCHED OFF, and these three tests hold the switch
 * rather than the mechanism.
 *
 * It worked. Live, first run: it announced itself, hopped, and closed 142
 * tiles to 105 in thirty beats, moving a median 186px per `go_to` with not
 * one refusal. The mechanism is sound and the tests below it still stand.
 *
 * It was switched off on its LEDGER, not its correctness. While it walked,
 * Sir Qwen earned nothing for twenty-one minutes against a clean rate of 3.4
 * to 4.3 kills a minute, and it re-arms every twenty minutes - a standing tax
 * on the only number the grind is measured in, paid for zero charges.
 *
 * What replaced it is cheaper, and "cheaper" is the honest word - the first
 * draft of this paragraph said the replacement costs NOTHING, and that
 * argument went on to produce a live outage of its own when the offer was
 * raised to every beat and both bodies stopped fighting. An offer makes no
 * network call when nothing is in range, but it still spends the beat.
 *
 * The replacement: the bodies LEAVE this room from tile (89,157), fourteen
 * tiles from the iron ore, several times an hour. The offer that would have
 * caught that was gated to the `hunting` leg. It is not any more, it is
 * rationed to one beat in eight, and the body no longer has to be taken
 * anywhere.
 *
 * TURN THIS BACK ON when passing-by has been given a fair run and has not
 * produced a charge either. Set SEAM_WALK_ON, and these three assertions
 * invert back to the behaviour they were written for.
 */
test('THE DELIBERATE WALK IS ON: a miner in the stair sets off for the seam', () => {
  const { said, acts } = walk(knight(), { x: 1803, y: 2739 }, 8);
  assert.ok(said.some((l) => /setting off for the/.test(l)),
    `the errand announces itself while the switch is on - saw ${said.join(' | ')}`);
  assert.ok(hops(acts).length > 0,
    `and it hops - saw ${acts.map((a) => a.action).join(', ')}`);
});

test('AND THE ERRAND OWNS THE BEAT while it is walking', () => {
  // With the switch on, the errand spends the beat getting there. The
  // passing-by offer is not gone - the next test holds it - but it is no
  // longer what carries a body across a room to a seam it cannot see.
  const { acts } = walk(knight(), { x: 1803, y: 2739 }, 8);
  assert.ok(hops(acts).length > 0,
    `the walk spends the beat - saw ${acts.map((a) => a.action).join(', ')}`);
});

test('STANDING AT THE SEAM, the beat is a gather', () => {
  // Standing near ore is what matters, not how the body came to be standing
  // there. This is the assertion that did NOT need inverting, which is the
  // sign it was testing the mechanism and not the switch.
  const { acts } = walk(knight(), { x: ORE.x + 64 * 3, y: ORE.y });
  assert.ok(acts.some((a) => 'gather_nearby' === a.action),
    `arrival is a gather - saw ${acts.map((a) => a.action).join(', ')}`);
});

test('CONTROL: a sheet without the trade never sets off', () => {
  const { said, acts } = walk(knight(['tailoring', 'cooking']), { x: 1803, y: 2739 });
  assert.deepEqual(said, [], `the sheet decides - saw ${said.join(' | ')}`);
  assert.equal(hops(acts).length, 0, 'and no walk is taken');
});

test('CONTROL: nothing walks to a seam while something is biting', () => {
  const { said } = walk(knight(), { x: 1803, y: 2739 }, 6, FIGHT);
  assert.deepEqual(said, [],
    `a fight outranks the errand - saw ${said.join(' | ')}`);
});

test('CONTROL: a spent body does not set off across the room', () => {
  // Same rule as the cross-room trip: go whole, or do not go. The seam sits
  // in the deep south of a field holding thirty hostiles.
  const { said } = walk(knight(), { x: 1803, y: 2739 }, 6, CALM, 84);
  assert.deepEqual(said, [],
    `a body at a tenth of its health stays and fights - saw ${said.join(' | ')}`);
});
