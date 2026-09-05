/**
 * The world had a crafting system and this harness never asked for it.
 *
 * The gateway offers 57 tools. We were handing characters 27. `arena_gather`,
 * `arena_craft`, `arena_recipes` and `arena_merchant_catalog` were simply
 * never wired - so both royals sat at level 1 with 0 experience across all
 * nine professions while the world put a recipe in the `gameplayHint` of
 * every single reply it sent us:
 *
 *   "At Nerys's Anvil, use 2 Copper Bar to make 1 bronze sword.
 *    Requires Blacksmithing level 1. Use recipe key make_bronze_sword."
 *
 * That is not a missing feature, it is a missing question. These tests are
 * what notices if the wiring is ever quietly removed again.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS_BY_CAPABILITY } from '../dist/harness/agentic.js';
import { CAPABILITIES } from '../dist/harness/actions.js';
import { lordgemma } from '../dist/characters/lordgemma.js';
import { sirqwen } from '../dist/characters/sirqwen.js';

test('the craft capability hands over the four profession tools', () => {
  const forCraft = TOOLS_BY_CAPABILITY.craft ?? [];
  for (const tool of ['arena_recipes', 'arena_gather', 'arena_craft', 'arena_merchant_catalog']) {
    assert.ok(forCraft.includes(tool), `craft must hand over ${tool}`);
  }
});

test('crafting is its own permission, not folded into trade', () => {
  // Trading spends coin and can lose gear; crafting spends MATERIALS. A
  // character allowed to sell junk is not automatically allowed to melt down
  // what it is carrying. arena_craft is one transaction and a refusal leaves
  // the satchel unchanged - but that is the world's promise about failure,
  // not a reason to hand the tool to everyone who may haggle.
  const forTrade = TOOLS_BY_CAPABILITY.trade ?? [];
  assert.ok(!forTrade.includes('arena_craft'), 'craft must not ride in on trade');
  assert.ok(!forTrade.includes('arena_gather'), 'gather must not ride in on trade');
});

test('craft is a real capability, and both royals hold it', () => {
  assert.ok(CAPABILITIES.includes('craft'), 'the harness must know the permission exists');
  assert.ok(lordgemma.capabilities.includes('craft'), 'Lord Gemma crafts');
  assert.ok(sirqwen.capabilities.includes('craft'), 'Sir Qwen crafts');
});

test('the gathering tool is carried, never wielded', () => {
  // The knight must never unequip the greatblade (standing order). The world
  // "selects the strongest matching tool in the satchel", so a pickaxe rides
  // alongside it and the weapon slot is untouched - which is the only reason
  // mining is safe for him at all. The discard allowlist is the second lock:
  // four keys, none of them gear, so the code cannot name his blade.
  assert.ok(!(TOOLS_BY_CAPABILITY.craft ?? []).includes('arena_equip'),
    'crafting must not come with the power to change what is worn');
  assert.ok(!(TOOLS_BY_CAPABILITY.craft ?? []).includes('arena_unequip'),
    'and especially not to take it off');
});

test('the reply shapes are the world\'s words, not ours', async () => {
  // Four methods shipped parsing field names I invented from tool
  // DESCRIPTIONS rather than from a reply. Two of them were wrong, and both
  // failed silently in the worst direction: `meetsGate` (really `canMake`)
  // made every recipe read as out of reach for ever, and `items`/`catalog`
  // (really `offers`) reported every counter in the world as empty stock
  // while answering ok. Checked against the world's own publicRecipe() and
  // profession-rules.js this time.
  const { Actions } = await import('../dist/harness/actions.js');
  const calls = [];
  const arena = {
    async call(tool) {
      calls.push(tool);
      if ('arena_recipes' === tool) {
        return { listed: true, recipes: [
          { key: 'make_bronze_sword', skillKey: 'blacksmithing', requiredLevel: 1, canMake: true, inputs: [] },
          { key: 'make_gold_sword', skillKey: 'blacksmithing', requiredLevel: 60, canMake: false, inputs: [] }
        ] };
      }
      if ('arena_gather' === tool) {
        return { gathered: true, itemKey: 'copper_ore', quantity: 2,
                 experience: 25, skillKey: 'mining', node: { charges: 7 } };
      }
      if ('arena_merchant_catalog' === tool) {
        return { offers: [{ key: 'chipped_pickaxe' }, { key: 'foraging_knife' }], totalOffers: 2 };
      }
      return {};
    }
  };
  const it = new Actions(arena, 'agent-1', new Set(['craft', 'trade']));

  const recipes = await it.recipesAt(9);
  assert.match(recipes.note, /1 makeable/, 'canMake must be read, not meetsGate');

  const got = await it.gather(210, 'copper ore');
  assert.match(got.note, /2 copper_ore/, 'itemKey and quantity are the real fields');

  const shop = await it.merchantCatalog(38);
  assert.match(shop.note, /2 lines/, 'offers is the real field, not items or catalog');
});

test('an unrecognised reply fails loudly instead of reporting an empty world', async () => {
  // Coercing a shape we do not know to [] is how a working tool becomes "the
  // shop is empty" and nobody finds out for a week.
  const { Actions } = await import('../dist/harness/actions.js');
  const arena = { async call() { return { somethingElse: true }; } };
  const it = new Actions(arena, 'agent-1', new Set(['craft', 'trade']));
  assert.equal((await it.merchantCatalog(38)).ok, false, 'a strange catalog reply is not an empty shop');
  assert.equal((await it.recipesAt(9)).ok, false, 'a strange recipe reply is not zero recipes');
});

test('a seam of ore is not somebody to talk to', async () => {
  // The world has exactly two object kinds, 'npc' and 'enemy', so an iron
  // seam and a gate warden arrive identically labelled. Harmless while
  // nothing gathered; now that a node is a thing we work, it must not also be
  // offered to the model as a conversation partner.
  const { Actions } = await import('../dist/harness/actions.js');
  const it = new Actions({ async call() { return {}; } }, 'agent-1',
    new Set(['craft', 'talk_to_folk']));
  it.notices([
    { kind: 'npc', label: 'Halden, Gate Warden', objectId: 143, alive: true },
    { kind: 'npc', label: 'iron ore', objectId: 243, alive: true },
    { kind: 'npc', label: 'copper ore', objectId: 210, alive: true }
  ]);
  const offered = it.describe('millers-stair');
  assert.match(offered, /Halden/, 'a warden is a person');
  assert.ok(!/iron ore|copper ore/.test(offered),
    'the crown does not attempt small talk with a rock');
});

test('both royals carry their trades, and only Sir Qwen mines', async () => {
  const { lordgemma } = await import('../dist/characters/lordgemma.js');
  const { sirqwen } = await import('../dist/characters/sirqwen.js');
  assert.ok(sirqwen.professions.includes('mining'), 'the ore line is his');
  assert.ok(!lordgemma.professions.includes('mining'),
    'mining yields ore and nothing else - it is not the Magus line');
  for (const both of ['cooking', 'foraging']) {
    assert.ok(sirqwen.professions.includes(both) && lordgemma.professions.includes(both),
      `${both} belongs to both`);
  }
});

test('a caster keeps something it can swing at point-blank', async () => {
  // Every projectile art spawns its bullet ~35px toward the target and aims
  // from there, so a target closer than that is BEHIND the spawn point and
  // the shot passes over it - the world says so in its own refusal:
  //
  //   "attackBullet's bullet spawns about 35px toward the target and aims
  //    from there, so a target this close is behind the spawn point"
  //
  // arcaneRay, attackBullet, boneSpear and drainLife all carry it. A rotation
  // made only of those leaves a caster with NOTHING that fires when a grub is
  // standing on him - six PROJECTILE_DEAD_ZONE refusals on the record. The
  // 50px staff covers exactly that band, so it belongs in the rotation even
  // though the harness never chooses to cast it.
  const { lordgemma } = await import('../dist/characters/lordgemma.js');
  const rungs = lordgemma.skillLadder.map((r) => r.skill);
  assert.ok(rungs.includes('attackShort'),
    'the rotation needs one thing that works inside the projectile dead zone');

  // And it must NOT become something the harness casts: arena_basic_attack
  // swings the equipped weapon, and routing that through arena_use_action
  // throws the weapon away - the whole reason reachingArt excludes it.
  const { Actions } = await import('../dist/harness/actions.js');
  assert.equal(Actions.circuitous(1, null), false, 'sanity: helper reachable');
});
