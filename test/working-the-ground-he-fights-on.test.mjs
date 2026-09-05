/**
 * The trade beat works the ground the body already fights on.
 *
 * Glenn, 2026-08-27: "turn on a gathering and all skills grinding beat for
 * both, in addition to leaving some xp grinding still."
 *
 * Profession experience writes to its own ledger and never touches character
 * level, so every trade beat is taken from the grind. That is the whole
 * design constraint, and it is why this beat is rationed and short-ranged:
 * the round offers it one beat in eight (GATHER_EVERY_N_BEATS), and if no
 * allowed node is within the beat's radius the answer is "nothing of ours"
 * and the beat falls back into the fight. An earlier version of this idea
 * was killed in review precisely because it aimed at ore 190 tiles away
 * through the maze.
 *
 * IT DOES WALK, a few tiles, and the tests at the foot of this file exist
 * because it once did not - `workNode` resolved a seam as an enemy and
 * gathered nothing whenever the body was not already standing on it. The
 * radius those walks are held inside is `GATHER_RADIUS_TILES`, and it is
 * driven in test/the-radius-that-reaches-the-seam.test.mjs; the literals
 * below are this file's own fixtures, not production's number.
 *
 * The world makes it worth having anyway: `salt_vein_copper` and
 * `salt_vein_iron` sit in `millers-stair` (professions-catalogue.mjs), the
 * very room both royals hunt, at 25 and 42 experience a charge.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Actions } from '../dist/harness/actions.js';

const TILE = 64;
const QWEN = ['mining', 'foraging', 'smelting', 'blacksmithing', 'cooking'];
const GEMMA = ['foraging', 'jewelcrafting', 'tailoring', 'woodcraft', 'cooking'];

const node = (label, tiles, objectId = 77) => ({
  objectId,
  objectIndex: `node-${objectId}`,
  label,
  kind: 'npc',
  interactable: true,
  distanceFromSelf: tiles * TILE,
  tileX: 90,
  tileY: 171
});

function rig(replies) {
  const calls = [];
  const arena = {
    calls,
    async call(name, args) {
      calls.push({ name, args });
      return replies[name] ?? {};
    },
    chaseFromBattle() { return null; }
  };
  const actions = new Actions(arena, 'test-agent', new Set(['craft', 'walk', 'fight']));
  return { arena, actions, calls };
}

const GAVE = { gathered: true, itemKey: 'iron_ore', quantity: 1, experience: 42, skillKey: 'mining' };

test('a seam of ours underfoot is worked, and the charges are taken', async () => {
  const { actions, calls } = rig({ arena_gather: GAVE });
  actions.notices([node('iron ore', 0.5)]);
  const said = await actions.gatherNearby(QWEN, 12, 4);
  assert.ok(said.ok, said.note);
  const swings = calls.filter((c) => 'arena_gather' === c.name);
  assert.equal(swings.length, 4, 'every charge the beat is allowed');
  assert.equal(swings[0].args.object_id ?? swings[0].args.objectId, 77);
});

test('CONTROL: the same seam is left alone by a sheet without the trade', async () => {
  const { actions, calls } = rig({ arena_gather: GAVE });
  actions.notices([node('iron ore', 0.5)]);
  const said = await actions.gatherNearby(GEMMA, 12, 4);
  assert.match(said.note ?? '', /nothing of ours/,
    'a Magus has no mining, so the seam is not his to swing at');
  assert.equal(calls.filter((c) => 'arena_gather' === c.name).length, 0,
    'and nothing is sent - otherwise the allowlist is decoration');
});

test('CONTROL: a node across the room is not worth a beat', async () => {
  const { actions, calls } = rig({ arena_gather: GAVE });
  // The real pair fight around tile (45,10); the stair's seams sit at
  // (90,171). That is the distance this rule exists to refuse.
  actions.notices([node('iron ore', 150)]);
  const said = await actions.gatherNearby(QWEN, 12, 4);
  assert.match(said.note ?? '', /nothing of ours/, 'out of radius is out of scope');
  assert.equal(calls.filter((c) => 'arena_gather' === c.name).length, 0);
});

test('a node that stops giving ends the beat instead of spinning on it', async () => {
  const { actions, calls } = rig({ arena_gather: { gathered: false, reason: 'no charges left' } });
  actions.notices([node('copper ore', 0.5)]);
  const said = await actions.gatherNearby(QWEN, 12, 4);
  // A refused NODE is no longer a refused BEAT - the beat tries the next
  // candidate and only then reports nothing. What must not change is the
  // spinning: one refusal per node, because a seam with no charges will not
  // grow them mid-beat.
  assert.match(said.note ?? '', /nothing of ours/, said.note ?? '');
  assert.equal(calls.filter((c) => 'arena_gather' === c.name).length, 1,
    'one refusal is enough');
});

test('the label decides the trade, and a fight is never mistaken for a node', async () => {
  const { actions, calls } = rig({ arena_gather: GAVE });
  actions.notices([node('Hollow Caller', 0.5), node('Groove Grub', 1, 78)]);
  const said = await actions.gatherNearby(QWEN, 12, 4);
  assert.match(said.note ?? '', /nothing of ours/, 'monsters are not ore');
  assert.equal(calls.filter((c) => 'arena_gather' === c.name).length, 0);
});

/**
 * THE CASE THE FIRST VERSION OF THIS FILE MISSED.
 *
 * Every test above put the node half a tile away, inside the threshold, so
 * the walk branch never ran once - and the walk branch was broken. It called
 * closeOn(), which resolves its target with findNearby(name, 'enemy'); a seam
 * is kind 'npc', so it answered `there is no "iron ore" here` and the beat
 * gathered nothing whenever the body was not already standing on the seam.
 *
 * Green the whole time. A test that pins the easy path reads as coverage and
 * is worse than no test at all.
 */
test('a seam a few tiles off is WALKED to, then worked', async () => {
  const { actions, calls } = rig({
    arena_gather: GAVE,
    arena_move_to: {},
    arena_check_path: { reachable: true, pathTurns: [[45, 10], [90, 171]] },
    arena_observe: { position: { x: 90 * TILE + TILE / 2, y: 171 * TILE + TILE / 2 } }
  });
  actions.notices([node('iron ore', 6)]);
  actions.standsAt({ x: 45 * TILE, y: 10 * TILE });
  const said = await actions.gatherNearby(QWEN, 12, 2);
  const walks = calls.filter((c) => 'arena_move_to' === c.name);
  // The bug this pins produced ZERO walks, so the count is the assertion
  // that matters. The exact pixel is not: goTo legs a long journey rather
  // than jumping to the far end, so pinning the destination would be
  // pinning goTo's internals instead of this beat's behaviour.
  assert.ok(walks.length > 0,
    `the beat must walk the last few tiles - saw ${calls.map((c) => c.name).join(', ')}`);
  const startGap = Math.hypot(90 * TILE - 45 * TILE, 171 * TILE - 10 * TILE);
  const walkGap = Math.hypot(90 * TILE - walks[0].args.x, 171 * TILE - walks[0].args.y);
  assert.ok(walkGap < startGap,
    `and head TOWARD the seam - stood ${Math.round(startGap)} away, walked to ${Math.round(walkGap)} away`);
  assert.ok(said.ok, said.note);
});

test('a seam with no tile of its own is refused, not walked at NaN', async () => {
  const { actions, calls } = rig({ arena_gather: GAVE, arena_move_to: {} });
  const rootless = node('iron ore', 6);
  delete rootless.tileX;
  actions.notices([rootless]);
  actions.standsAt({ x: 45 * TILE, y: 10 * TILE });
  const said = await actions.gatherNearby(QWEN, 12, 2);
  // The point of this test is the WALK, not the verdict: a node with no tile
  // of its own must never produce a walk to (NaN, y), which is how the whole
  // night started.
  assert.match(said.note ?? '', /nothing of ours/, said.note ?? '');
  assert.equal(calls.filter((c) => 'arena_move_to' === c.name).length, 0,
    'nothing is sent - a walk to (NaN, y) is how tonight started');
});

/**
 * THE FOUR NODES THAT WERE INVISIBLE.
 *
 * Verbatim from the Oathstone, with a tooled body standing twenty-three tiles
 * away reporting "nothing of ours to gather":
 *
 *   objects 4: pot garlic@(14,18) - hot pepper@(9,18)
 *              plant fibre@(4,17) - wild carrot@(4,18)
 *
 * `isResourceNode` screened for ore, seam, vein, bush, thicket, shoal,
 * outcrop - written when mining was the only trade - and runs BEFORE
 * `skillForNode` decides which trade owns a node. So every foraging node in
 * the world was rejected before the trade check was reached.
 */
const OATH = [
  { objectId: 21, objectIndex: 'n21', label: 'wild carrot', kind: 'npc',
    interactable: true, distanceFromSelf: 0.4 * TILE, tileX: 4, tileY: 18 },
  { objectId: 22, objectIndex: 'n22', label: 'plant fibre', kind: 'npc',
    interactable: true, distanceFromSelf: 0.5 * TILE, tileX: 4, tileY: 17 },
  { objectId: 23, objectIndex: 'n23', label: 'hot pepper', kind: 'npc',
    interactable: true, distanceFromSelf: 0.6 * TILE, tileX: 9, tileY: 18 },
  { objectId: 24, objectIndex: 'n24', label: 'pot garlic', kind: 'npc',
    interactable: true, distanceFromSelf: 0.7 * TILE, tileX: 14, tileY: 18 }
];

test("the Oathstone's real nodes are recognised as ours", async () => {
  const { actions, calls } = rig({
    arena_gather: { gathered: true, itemKey: 'wild_carrot', quantity: 1,
                    experience: 18, skillKey: 'foraging' },
    arena_move_to: {},
    arena_check_path: { reachable: true },
    arena_observe: { position: { x: 4 * TILE, y: 18 * TILE } }
  });
  actions.notices(OATH);
  actions.standsAt({ x: 19 * TILE, y: 1 * TILE });
  const said = await actions.gatherNearby(GEMMA, 60, 2);
  assert.ok(said.ok, `a Magus forages, and these are forage - ${said.note}`);
  assert.ok(calls.some((c) => 'arena_gather' === c.name),
    `something must actually be gathered - saw ${calls.map((c) => c.name).join(', ')}`);
});

test('CONTROL: a monster with a plant-ish name is not forage', () => {
  // `wild`, `bramble` and `hedge` were on the word list and are modifiers,
  // not things - "Wild Boar" would have been claimed and gathered at.
  const { actions } = rig({});
  actions.notices([{ objectId: 9, objectIndex: 'e9', label: 'Wild Boar',
    kind: 'enemy', interactable: false, distanceFromSelf: 3 * TILE,
    tileX: 5, tileY: 5 }]);
  return actions.gatherNearby(GEMMA, 60, 2).then((said) => {
    assert.match(said.note ?? '', /nothing of ours/,
      'a boar is not a carrot however wild it is');
  });
});

test('a node that refuses is set aside, not walked at again', async () => {
  // The first per-gather line ever printed, four times, identically:
  //
  //   [trade] pot garlic at 17.7t - 0 of 4 charges taken
  //           (Object 256 is not in the current scene, the-valley-inn.)
  //
  // He was standing IN the Oathstone and the gateway still placed his session
  // in the inn he had left a minute before - a scene desync. What made it
  // repeat for ever was ours: nothing remembered the refusal, so every offer
  // walked at the same phantom again.
  const { actions, calls } = rig({
    arena_gather: { gathered: false, reason: 'Object 256 is not in the current scene' }
  });
  actions.notices([node('pot garlic', 0.5, 256)]);
  const first = await actions.gatherNearby(GEMMA, 60, 4);
  assert.match(first.note ?? '', /nothing of ours/,
    'with nothing else to try, the beat reports empty');
  const tried = calls.filter((c) => 'arena_gather' === c.name).length;
  assert.ok(tried > 0, 'it did try the phantom once');

  const again = await actions.gatherNearby(GEMMA, 60, 4);
  assert.match(again.note ?? '', /nothing of ours/,
    'the second offer must not see it at all');
  assert.equal(calls.filter((c) => 'arena_gather' === c.name).length, tried,
    `and must send nothing further - a refused node is set aside`);
});

test('CONTROL: a node that PAYS is never set aside', async () => {
  const { actions, calls } = rig({
    arena_gather: { gathered: true, itemKey: 'wild_carrot', quantity: 1,
                    experience: 18, skillKey: 'foraging' }
  });
  actions.notices([node('wild carrot', 0.5, 300)]);
  await actions.gatherNearby(GEMMA, 60, 2);
  const after = calls.filter((c) => 'arena_gather' === c.name).length;
  const again = await actions.gatherNearby(GEMMA, 60, 2);
  assert.ok(again.ok, 'good ground stays good');
  assert.ok(calls.filter((c) => 'arena_gather' === c.name).length > after,
    'a paying node must still be worked on the next offer');
});

test('a phantom in front of a real node does not block it', () => {
  // THE THING THAT WAS ACTUALLY STOPPING EVERY CHARGE. gatherNearby sorted
  // by distance and took `[0]`, giving up if it refused. Measured with Lord
  // Gemma standing IN the Oathstone: the gateway leaked another room's
  // profession objects into his observation at 16-21 tiles while the real
  // carrot and fibre sat at ~22 - so a phantom sorted FIRST on every beat,
  // failed, and the beat ended. The real node was never once reached.
  const phantom = { objectId: 256, objectIndex: 'p256', label: 'pot garlic',
    kind: 'npc', interactable: true, distanceFromSelf: 0.4 * TILE,
    tileX: 14, tileY: 18 };
  const real = { objectId: 300, objectIndex: 'n300', label: 'wild carrot',
    kind: 'npc', interactable: true, distanceFromSelf: 0.5 * TILE,
    tileX: 4, tileY: 18 };
  const calls = [];
  const arena = {
    async call(name, args) {
      calls.push({ name, args });
      if ('arena_gather' === name) {
        return 256 === args.object_id
          ? { gathered: false, reason: 'Object 256 is not in the current scene' }
          : { gathered: true, itemKey: 'wild_carrot', quantity: 1,
              experience: 18, skillKey: 'foraging' };
      }
      if ('arena_check_path' === name) return { reachable: true };
      if ('arena_observe' === name) return { position: { x: 4 * TILE, y: 18 * TILE } };
      return {};
    },
    chaseFromBattle() { return null; }
  };
  const actions = new Actions(arena, 'test-agent', new Set(['craft', 'walk', 'fight']));
  actions.notices([phantom, real]);
  actions.standsAt({ x: 19 * TILE, y: 1 * TILE });
  return actions.gatherNearby(GEMMA, 60, 2).then((said) => {
    assert.ok(said.ok, `the real carrot must be reached - ${said.note}`);
    assert.match(said.note ?? '', /wild carrot/,
      `and it must be the one that paid - ${said.note}`);
  });
});

test('a walk in progress is finished, not abandoned for the next node', async () => {
  // THIS IS WHY THE OATHSTONE KEPT COMING BACK DRY. Iterating candidates was
  // right - a phantom used to block the real node behind it - but abandoning
  // the approach every beat was not. The nodes there sit 17-22 tiles out, a
  // walk takes several beats, and each beat the loop walked one leg toward
  // the nearest, got "on the way", then tried the NEXT candidate and walked
  // toward that one instead. Four nodes, four half-walks, no arrivals, and
  // `gather_nearby -> ok` with no `[trade]` line at all.
  const far = (id, label, tiles) => ({ objectId: id, objectIndex: 'n' + id,
    label, kind: 'npc', interactable: true, distanceFromSelf: tiles * 32,
    tileX: 4, tileY: 18 });
  const calls = [];
  const arena = {
    async call(name, args) {
      calls.push({ name, args });
      if ('arena_check_path' === name) return { reachable: true };
      // Never arrives: every observation puts him back where he started, so
      // goTo answers "on the way" every time - the live shape exactly.
      if ('arena_observe' === name) return { position: { x: 19 * 32, y: 1 * 32 } };
      return {};
    },
    chaseFromBattle() { return null; }
  };
  const actions = new Actions(arena, 'test-agent', new Set(['craft', 'walk', 'fight']));
  actions.notices([far(1, 'wild carrot', 17), far(2, 'plant fibre', 19),
                   far(3, 'pot garlic', 21), far(4, 'hot pepper', 22)]);
  actions.standsAt({ x: 19 * 32, y: 1 * 32 });
  await actions.gatherNearby(GEMMA, 60, 2);
  const walks = calls.filter((c) => 'arena_move_to' === c.name);
  assert.equal(walks.length, 1,
    `one walk per beat, toward ONE node - saw ${walks.length}`);

  // The next beat must continue toward the SAME node, not restart elsewhere.
  const before = walks[0].args;
  await actions.gatherNearby(GEMMA, 60, 2);
  const next = calls.filter((c) => 'arena_move_to' === c.name)[1];
  assert.ok(next, 'it keeps walking');
  assert.deepEqual({ x: next.args.x, y: next.args.y }, { x: before.x, y: before.y },
    'and toward the same place it was already heading');
});
