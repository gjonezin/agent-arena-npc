/**
 * Destroying worthless material, and never anything else.
 *
 * The standing order is that top equipment is never dropped or destroyed.
 * The way that promise is kept here is that discardJunk() cannot NAME
 * anything but an explicit list of keys - not by judging what looks
 * unimportant, which is a rule that eventually meets an item it misreads.
 *
 * Why it exists at all, measured 2026-08-24: Lord Gemma's pack held 231
 * rows, 216 of them `branch`, which do not stack. `carrying` was 33,861 of
 * the 49,150 bytes an arena_observe reply may hold, against a real payload
 * of 353,661, so the gateway cut the reply mid-object and the last enemy
 * arrived with no tileX. That reached the round as "could not close".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Actions } from '../dist/harness/actions.js';

const PACK = [
  { key: 'branch', label: 'Tree branch' },
  { key: 'branch', label: 'Tree branch' },
  { key: 'cave_web', label: 'Cave Web' },
  { key: 'field_wheat', label: 'Field Wheat' },
  // Everything below must survive.
  { key: 'knight_greatblade', label: "Knight's Greatblade", equipment: true, equipped: true },
  { key: 'depths_plate', label: 'Depths Plate', equipment: true },
  { key: 'ember_focus', label: 'Ember Focus', equipment: true, equipped: true },
  { key: 'tarnished_key', label: 'Tarnished Key' },
  { key: 'garnet_drop', label: 'Garnet Drop' },
  { key: 'clay_canteen', label: 'Clay Canteen' },
  { key: 'blue_currants', label: 'Blue Currants' },
  { key: 'bone_shard', label: 'Bone Shard' },
  { key: 'buried_skull', label: 'Buried Skull' },
  { key: 'silk_shroud', label: 'Silk Shroud' },
  { key: 'coins', label: 'Coins', quantity: 9461 }
];

class FakeArena {
  constructor(items) {
    this.items = items;
    this.discarded = [];
  }

  async call(name, args) {
    if ('arena_inventory' === name) {
      return { items: this.items };
    }
    if ('arena_discard' === name) {
      this.discarded.push(args.item);
      return { discarded: true, item: args.item, quantity: 1 };
    }
    throw new Error(`unexpected call ${name}`);
  }

  danger() {
    return { damage: 0, died: false, aggressors: 0, landed: false };
  }
}

const sweep = async (items, limit = 20) => {
  const arena = new FakeArena(items);
  const actions = new Actions(arena, 'agent-1', 'Sir Qwen', undefined, undefined);
  const result = await actions.discardJunk(limit);
  return { arena, result };
};

test('it destroys the worthless material', async () => {
  const { arena } = await sweep(PACK);
  assert.deepEqual(arena.discarded.slice().sort(),
    ['branch', 'branch', 'cave_web', 'field_wheat']);
});

test('it cannot name equipment, worn or spare', async () => {
  const { arena } = await sweep(PACK);
  for (const key of ['knight_greatblade', 'depths_plate', 'ember_focus']) {
    assert.ok(!arena.discarded.includes(key), `${key} was named for destruction`);
  }
});

test('it cannot name a quest reward or a rare drop', async () => {
  // Every one of these is an authored rewardItemKey or rareItemKey in
  // frontier-progression.mjs, whatever it looks like sitting in a bag.
  const { arena } = await sweep(PACK);
  for (const key of ['tarnished_key', 'garnet_drop', 'clay_canteen',
                     'blue_currants', 'bone_shard', 'buried_skull', 'silk_shroud']) {
    assert.ok(!arena.discarded.includes(key), `${key} was named for destruction`);
  }
});

test('it never touches the purse', async () => {
  const { arena } = await sweep(PACK);
  assert.ok(!arena.discarded.includes('coins'));
});

test('a pack of nothing but treasure is left alone', async () => {
  const { arena, result } = await sweep(PACK.filter((row) => !['branch', 'cave_web', 'field_wheat'].includes(row.key)));
  assert.equal(arena.discarded.length, 0);
  assert.ok(result.ok);
});

test('the sweep is bounded, so one tick cannot become a stall', async () => {
  // 216 branches at one gateway call each is minutes of calls; the pack
  // refills from kills anyway, so this is a tap left open, not a one-off.
  const many = Array.from({ length: 200 }, () => ({ key: 'branch', label: 'Tree branch' }));
  const { arena } = await sweep(many, 20);
  assert.equal(arena.discarded.length, 20);
});

test('a pinned row count does not stop the sweep', () => {
  // This test replaces one that asserted the opposite, and the opposite was
  // wrong. arena_inventory is byte-capped: every reply is exactly 49,152
  // bytes and carries a PREFIX of the pack. Sir Qwen holds about 1,627 rows
  // and the reply shows 229, so destroying a row pulls a hidden row into the
  // visible window and the count cannot fall - it was measured RISING, 227
  // to 229, across a delete that certainly succeeded.
  //
  // Reading that as a failed delete switched off a cure that works.
  // Adversarial verification, 2026-08-24: 62 of 62 discards were real
  // removals, and a key holding two rows deleted exactly one of them.
  return (async () => {
    const visible = () => Array.from({ length: 30 }, () => ({ key: 'branch', label: 'Tree branch' }));
    const arena = new FakeArena(visible());
    arena.call = async function (name, args) {
      if ('arena_inventory' === name) {
        // The cap refills the window every time, exactly as the world does.
        this.items = visible();
        return { items: this.items };
      }
      if ('arena_discard' === name) {
        this.discarded.push(args.item);
        return { discarded: true, item: args.item, quantity: 1 };
      }
      throw new Error(`unexpected call ${name}`);
    };
    const actions = new Actions(arena, 'agent-1', 'Sir Qwen', undefined, undefined);

    const first = await actions.discardJunk(10);
    assert.equal(first.ok, true, 'a real sweep was reported as a failure');

    const asked = arena.discarded.length;
    const second = await actions.discardJunk(10);
    assert.equal(second.ok, true);
    assert.ok(arena.discarded.length > asked,
      'stopped sweeping because a capped reply pinned the row count');
  })();
});
