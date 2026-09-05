/**
 * A mage's costume does not make it cast.
 *
 * Worth setting down because everyone assumed otherwise, including me, right
 * up until it was checked against the client. Every class-path spritesheet in
 * this world produces exactly four animations and all four are walking. There
 * is no attack frame on any of them. Swings and casts come from a separate set
 * of effects keyed by SKILL, so a mage in mage robes swinging the default
 * attack looks identical to a swordsman doing it.
 *
 * The skills are real rows: attackBullet, attackShort, fireball, heal, granted
 * per class path. Warlocks and sorcerers have fireball. A swordsman genuinely
 * does not. So a character can only use what it actually has, and asking for
 * anything else should be a plain no rather than a silent nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Actions, IntentSchema } from '../dist/harness/actions.js';

const ASHLING = {
  label: 'Ashling',
  kind: 'enemy',
  objectIndex: 'arena-volcano-respawn-area_14_0',
  tileX: 10,
  tileY: 10
};

function arenaSeeing(objects) {
  const calls = [];
  return {
    calls,
    async call(tool, args) {
      calls.push({ tool, args });
      if (tool === 'arena_observe') {
        return { scene: 'arena-volcano', objects, ownPlayer: { state: { x: 0, y: 0 } } };
      }
      return {};
    }
  };
}

const mageWith = (arena, skills) =>
  new Actions(arena, 'agent-1', new Set(['fight']), undefined, undefined, skills);

test('a mage casting fireball sends the skill, not the default swing', async () => {
  const arena = arenaSeeing([ASHLING]);
  const actions = mageWith(arena, ['attackBullet', 'fireball', 'heal']);
  actions.notices([ASHLING]);
  const result = await actions.useSkill('fireball', 'Ashling');

  assert.equal(result.ok, true);
  assert.match(result.note, /used fireball on Ashling/);
  const sent = arena.calls.find((call) => call.tool === 'arena_use_action');
  assert.ok(sent, 'it goes out as a named action, which is what plays a cast');
  assert.equal(sent.args.action_type, 'fireball');
  assert.equal(
    sent.args.target_object_index,
    ASHLING.objectIndex,
    'targeted by objectIndex, same as a basic attack'
  );
  assert.ok(
    !arena.calls.some((call) => call.tool === 'arena_basic_attack'),
    'and never falls back to the generic swing'
  );
});

test('an unlisted skill is attempted, because the roster lags the class', async () => {
  // REVERSED ON PURPOSE (2026-08-16). This used to assert the harness refused
  // a skill missing from the session's roster. The source stopped doing that
  // deliberately - see the note in actions.ts useSkill(): a Magus login still
  // reports the old warlock three, so the roster is not authoritative, and
  // refusing on it meant "every character reported having no skills of its
  // own and use_skill could never fire" (npc.ts). The game server is the only
  // thing that actually knows, and it rejects an impossible skill itself.
  // So the harness sends it and lets the world answer.
  const arena = arenaSeeing([ASHLING]);
  const actions = mageWith(arena, ['attackShort', 'heal']);
  actions.notices([ASHLING]);
  const result = await actions.useSkill('fireball', 'Ashling');

  assert.equal(result.ok, true, 'an unlisted skill is tried, not refused out of hand');
  assert.match(result.note, /fireball/, 'and the note names what was cast');
  assert.ok(
    arena.calls.some((call) => 'arena_use_action' === call.tool),
    'the request actually reaches the world, which is the only authority on it'
  );
});

test('a skill with no name given is refused before it reaches the world', async () => {
  // The refusal that IS still real. The old companion to this test asserted
  // "no skills of its own" for an empty roster, which the source no longer
  // says - and that test never called notices(), so it was really exercising
  // the nobody-here branch by accident. A nameless skill is the honest case:
  // there is nothing to send, so nothing is sent.
  const arena = arenaSeeing([ASHLING]);
  const actions = mageWith(arena, []);
  actions.notices([ASHLING]);
  const result = await actions.useSkill(undefined, 'Ashling');

  assert.equal(result.ok, false);
  assert.ok(
    !arena.calls.some((call) => 'arena_use_action' === call.tool),
    'and nothing was asked of the world'
  );
});

test('casting at nothing that is here is a no rather than a swing at air', async () => {
  const arena = arenaSeeing([]);
  const actions = mageWith(arena, ['fireball']);
  actions.notices([]);
  const result = await actions.useSkill('fireball', 'Ashling');
  assert.equal(result.ok, false);
  assert.match(result.note, /there is no "Ashling" here/);
});

test('somebody who does not fight cannot cast either', async () => {
  const actions = new Actions(arenaSeeing([ASHLING]), 'agent-1', new Set(['speak']), undefined, undefined, [
    'fireball'
  ]);
  const result = await actions.useSkill('fireball', 'Ashling');
  assert.equal(result.ok, false);
  assert.match(result.note, /does not fight/);
});

test('the intent carries a skill, and "cast" is read as meaning one', () => {
  const parsed = IntentSchema.safeParse({ action: 'cast', skill: 'fireball', target: 'Ashling' });
  assert.equal(parsed.success, true);
  assert.equal(parsed.data.action, 'use_skill', 'a near miss is read rather than thrown away');
  assert.equal(parsed.data.skill, 'fireball');
});
