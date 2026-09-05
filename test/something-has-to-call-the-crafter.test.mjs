/**
 * SOMETHING HAS TO CALL THE CRAFTER.
 *
 * `Actions.craft()` and `recipesAt()` have been implemented and correct for
 * weeks with no caller anywhere in the round. Cooking therefore could not
 * move whatever the world shipped, and the world shipped plenty: a pond in
 * town at fishing level 1, a cook fire in the inn, and
 * `cook_smoked_spotted_fish` at cooking level 1 for one fish.
 *
 * These drive the beat that closes that gap, and the refusals it must not
 * dress up as success.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Actions } from '../dist/harness/actions.js';

const FIRE = {
  objectId: 91,
  objectIndex: 'obj-91',
  label: 'The Gilded Griffin Cook Fire',
  kind: 'npc',
  interactable: true,
  distanceFromSelf: 64,
  tileX: 4,
  tileY: 6
};

function rig({ pack = [], reply = { crafted: true, itemKey: 'smoked_spotted_fish', experience: 18 } } = {}) {
  const calls = [];
  const arena = {
    calls,
    async call(name, args) {
      calls.push({ name, args });
      if ('arena_inventory' === name) { return { items: pack }; }
      if ('arena_craft' === name) { return reply; }
      return {};
    },
    chaseFromBattle() { return null; }
  };
  const actions = new Actions(arena, 'test-agent', new Set(['craft', 'trade', 'walk']));
  actions.nearby = [FIRE];
  // `carried` is what sellableItems() reads, and production refills it from
  // every observation, so a test sets it directly rather than staging an
  // inventory round-trip the beat itself never makes.
  actions.carried = pack;
  return { actions, calls };
}

test('an empty pack costs no call to the world', async () => {
  const { actions, calls } = rig({ pack: [] });
  const said = await actions.cookHere();
  assert.equal(calls.filter((c) => 'arena_craft' === c.name).length, 0,
    'nothing to cook must not ask the world to cook it');
  assert.ok(/nothing to cook/.test(said.note ?? ''), `and must say so - got: ${said.note}`);
});

test('a fish and a fire in the room become cooking experience', async () => {
  const { actions, calls } = rig({ pack: [{ key: 'spotted_fish', quantity: 2, type: 'material' }] });
  const said = await actions.cookHere();
  const asked = calls.find((c) => 'arena_craft' === c.name);
  assert.ok(asked, `the crafter must actually be called - saw ${calls.map((c) => c.name).join(', ')}`);
  assert.equal(asked.args.object_id, FIRE.objectId, 'and at the fire that is in the room');
  assert.ok(said.ok, `a successful craft is a success - got: ${said.note}`);
});

test('no fire in the room is said plainly, not crafted at', async () => {
  const { actions, calls } = rig({ pack: [{ key: 'spotted_fish', quantity: 1, type: 'material' }] });
  actions.nearby = [];
  const said = await actions.cookHere();
  assert.equal(calls.filter((c) => 'arena_craft' === c.name).length, 0,
    'there is nothing to craft at');
  assert.ok(/no cook fire/.test(said.note ?? ''), `and it must say which - got: ${said.note}`);
});
