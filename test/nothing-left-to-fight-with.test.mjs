/**
 * A body with nothing left is not grinding, it is standing there.
 *
 * Measured 2026-08-25, both royals at once: Lord Gemma on 9 mana of 646 -
 * below `manaDry`, so not one of his arts could fire, and his whole kit is
 * arts - and at 63% hp, under lifeTap's 70% floor, so he could not convert
 * either. Sir Qwen on 130 hp of 724 with 1 mana against a heal costing 2.
 * Between them 514,000 copper and a cask that refills a pool for 100.
 *
 * The cure existed and was unreachable: `drink_ale` lives in the `resting`
 * leg, and they logged ZERO resting rounds in 900, because the field lock
 * forces `homebound` back to `hunting` until the next level.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KnightsRound, SWORD_GEAR, SWORD_ARMOR } from '../dist/harness/reflex.js';

const FIELD = 'millers-stair';
const KITTED = ['cup helm', 'grips', 'boots', 'saltguard',
                'traveler mail', 'knight greatblade'];
const QUIET = { damage: 0, died: false, aggressors: 0, landed: false };
const UNDER_ATTACK = { damage: 40, died: false, aggressors: 2, landed: true };

const round = () => new KnightsRound({
  battleStyle: 'close_up', gearLadder: SWORD_GEAR, armorLadder: SWORD_ARMOR,
  shopRoom: 'the-valley-smithy', shopKeeper: 'Nerys'
});

/** A tick with the pool and the bar set where the caller wants them. */
const tick = (it, danger, hp, mp) => it.next(
  FIELD, danger, hp, null,
  { room: FIELD, x: 2320, y: 2320, level: 40, mp },
  null, null, null, [], 2, KITTED, 191118, 0, []
);

test('while the cask cannot be reached, a dry body keeps hunting', () => {
  // RECOVERY_TRIPS_WORK is false and this test is what holds it there.
  //
  // The errand fires correctly and walks both royals to the inn - which the
  // `resting` leg had not managed in 900 rounds - and then fails in the last
  // four tiles to the cask at (8,2): eight approach tiles, every one "still
  // short", while arena_check_path answered PATH_FOUND for tiles the body
  // then would not walk to (upstream #505/#539, open). Measured while it was
  // on: both bodies parked in the inn at tile (11,5) with ZERO attack
  // verdicts, having stopped hunting to queue for a drink they cannot buy.
  //
  // Empty pools are bad. Not fighting at all is worse. The walk is not free,
  // so a cure that cannot be reached must not be attempted.
  const it = round();
  const intents = [];
  for (let i = 0; i < 6; i += 1) {
    const step = tick(it, QUIET, { value: 600, total: 724 }, { value: 1, total: 217 });
    intents.push(step.action);
    it.completed(step, true, 'ok');
  }
  assert.ok(!intents.includes('drink_ale'),
    `no trips while the last four tiles are broken, got: ${intents.join(', ')}`);
});

test('it will not break off a fight to do it', () => {
  // The standing order is "no running away though, fight to the death". The
  // recovery errand is not a retreat and must never read as one: while
  // anything is still swinging, the fight finishes first.
  const it = round();
  const intents = [];
  for (let i = 0; i < 6; i += 1) {
    const step = tick(it, UNDER_ATTACK, { value: 120, total: 724 }, { value: 1, total: 217 });
    intents.push(step.action);
    it.completed(step, true, 'ok');
  }
  assert.ok(!intents.includes('drink_ale'),
    `it must fight first, got: ${intents.join(', ')}`);
});

test('a full body on a full pool stays and hunts', () => {
  const it = round();
  const intents = [];
  for (let i = 0; i < 6; i += 1) {
    const step = tick(it, QUIET, { value: 700, total: 724 }, { value: 200, total: 217 });
    intents.push(step.action);
    it.completed(step, true, 'ok');
  }
  assert.ok(!intents.includes('drink_ale'),
    `nothing is wrong with it, got: ${intents.join(', ')}`);
});

test('a caster with no other refill taps his own blood for mana', () => {
  // Measured 2026-08-26: at 0 mana Lord Gemma fires attackBullet for 60 a
  // hit; with mana it is boneSpear for ~320. Five times the damage from the
  // same tile. The default 70% floor was written when a dry pool could be
  // refilled at the cask - it cannot (#573 upstream), and a Magus has no
  // heal and no feast spell at any level, so 70 meant he never tapped at all.
  const it = new KnightsRound({
    battleStyle: 'long_range',
    manaSpell: 'lifeTap',
    tapAboveHpPercent: 35,
    gearLadder: SWORD_GEAR, armorLadder: SWORD_ARMOR,
    shopRoom: 'the-valley-mage', shopKeeper: 'Wren'
  });
  const taps = [];
  for (let i = 0; i < 8; i += 1) {
    // Dry pool, hp at 64% - comfortably above the new floor, far below the old.
    const step = it.next(
      FIELD, QUIET, { value: 400, total: 620 }, null,
      { room: FIELD, x: 2320, y: 2320, level: 41, mp: { value: 0, total: 660 } },
      null, null, null, [], 2, KITTED, 300000, 0, []
    );
    if ('use_skill' === step.action && 'lifeTap' === step.skill) taps.push(step);
    it.completed(step, true, 'ok');
  }
  assert.ok(taps.length > 0, 'at 64% hp and 0 mana he must buy mana with blood');
});

test('and stops paying once the floor is reached', () => {
  const it = new KnightsRound({
    battleStyle: 'long_range',
    manaSpell: 'lifeTap',
    tapAboveHpPercent: 35,
    gearLadder: SWORD_GEAR, armorLadder: SWORD_ARMOR,
    shopRoom: 'the-valley-mage', shopKeeper: 'Wren'
  });
  const taps = [];
  for (let i = 0; i < 8; i += 1) {
    // 20% hp: below the floor. A body must not tap itself into the ground.
    const step = it.next(
      FIELD, QUIET, { value: 124, total: 620 }, null,
      { room: FIELD, x: 2320, y: 2320, level: 41, mp: { value: 0, total: 660 } },
      null, null, null, [], 2, KITTED, 300000, 0, []
    );
    if ('use_skill' === step.action && 'lifeTap' === step.skill) taps.push(step);
    it.completed(step, true, 'ok');
  }
  assert.equal(taps.length, 0, 'below the floor he keeps what blood is left');
});

test('a dying body with no medicine stays and fights instead of shopping', () => {
  // MEASURED LINE BY LINE, 2026-08-27: Lord Gemma at 4 hp of 620 left the
  // stair, crossed the valley, walked THROUGH the inn past Barnaby's cask,
  // stood in the mage's shop, rested four ticks, and walked back into the
  // maze still at 4/620. Two and a half minutes, nothing healed, returned to
  // the fight one hit from death - and it recurs on every dip.
  //
  // Nothing in town could have helped: the drink gate needs potions he does
  // not carry, feastSpell and healSpell are not in a Magus's class path at
  // any level, and the ale is gated on manaDry rather than hp. Death is his
  // only full restore and it is free, so the errand was strictly worse than
  // standing his ground: the same death plus a three-minute detour.
  const it = new KnightsRound({
    battleStyle: 'long_range',
    manaSpell: 'lifeTap',
    gearLadder: SWORD_GEAR, armorLadder: SWORD_ARMOR,
    shopRoom: 'the-valley-mage', shopKeeper: 'Wren'
  });
  const legs = [];
  for (let i = 0; i < 10; i += 1) {
    // 4 of 620 hp, a full bag worth banking, no potions, no heal, no feast.
    const step = it.next(
      FIELD, QUIET, { value: 4, total: 620 }, null,
      { room: FIELD, x: 2320, y: 2320, level: 41, mp: { value: 300, total: 660 } },
      null, null, null,
      Array.from({ length: 60 }, (_, n) => ({ key: `junk_${n}`, label: 'junk', quantity: 1 })),
      0, KITTED, 500000, 0, []
    );
    legs.push(it.plan().leg);
    it.completed(step, true, 'ok');
  }
  assert.ok(!legs.includes('homebound') && !legs.includes('outbound'),
    `it must not walk to town to heal nothing, went: ${[...new Set(legs)].join(', ')}`);
});
