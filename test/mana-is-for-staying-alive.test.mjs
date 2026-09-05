/**
 * The knight's mana is for staying alive, not for damage.
 *
 * Measured 2026-08-25 from Sir Qwen's own battle.events: the greatblade lands
 * 252 to 512 a swing against mobs holding 150 and 160. He one-shots the room,
 * which is why his hp read 351/644 across 437 straight samples with an empty
 * aggressor list - nothing survives to hit back.
 *
 * Against that, thornwhip is base 17 and costs 13 mp, and it drained both
 * spenders: the server's `use_skills` rotation and `strike()`'s own cast. That
 * 13 mp is six heals (2 mp, +10 hp) or two conjured meals (6 mp, +14 hp). He
 * spent it on damage he did not need and sat at 44% hp with 1 mp - two short
 * of a heal he has known since level 5.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KnightsRound, SWORD_GEAR, SWORD_ARMOR } from '../dist/harness/reflex.js';
import { sirqwen } from '../dist/characters/sirqwen.js';

const FIELD = 'millers-stair';
const KITTED = ['cup helm', 'grips', 'boots', 'saltguard',
                'traveler mail', 'knight greatblade'];
const sheet = sirqwen;

test('his sheet carries no offensive art for the pool to be spent on', () => {
  assert.deepEqual(sheet.skillLadder, [], 'an empty ladder is the whole mechanism');
  assert.equal(sheet.healSpell, 'heal', 'healing is untouched');
  assert.equal(sheet.feastSpell, 'conjureFood', 'and so is the meal');
  assert.equal(sheet.healBelowPercent, 50, 'armed at fifty, by order');
});

test('a fighting beat resolves to the greatblade, never to a cast', () => {
  const it = new KnightsRound({
    battleStyle: sheet.battleStyle,
    healSpell: sheet.healSpell,
    feastSpell: sheet.feastSpell,
    skillLadder: sheet.skillLadder,
    gearLadder: SWORD_GEAR,
    armorLadder: SWORD_ARMOR,
    shopRoom: 'the-valley-smithy',
    shopKeeper: 'Nerys'
  });
  // Something is on him, at full mana - the case that used to spend it.
  const hostile = { damage: 40, died: false, aggressors: 2, landed: true };
  const casts = [];
  for (let i = 0; i < 20; i += 1) {
    const intent = it.next(
      FIELD, hostile, { value: 600, total: 660 }, null,
      { room: FIELD, x: 2320, y: 2320, level: 36, mp: { value: 205, total: 205 } },
      null, null, null, [], 2, KITTED, 191118, 0, []
    );
    if ('use_skill' === intent.action) {
      casts.push(intent.skill);
    }
    it.completed(intent, true, 'swung');
  }
  const offensive = casts.filter((s) => 'heal' !== s && 'conjureFood' !== s);
  assert.deepEqual(offensive, [], `the pool must go to healing only, saw ${offensive.join(', ')}`);
});
