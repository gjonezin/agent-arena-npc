/**
 * The shrine recovery errand: a spent body that cannot mend itself walks to
 * Ossian's shrine for the free full restore - and only then.
 *
 * Why it exists: Lord Gemma has no heal spell, lifeTap costs him the blood
 * he is short of, and he dies about 1.3 times an hour for it. Ossian's
 * `heal` dialog is restoreConsumableStats - hp, mp and stamina to full,
 * free, gated only on proximity (agentArena's shrine.js, read from source;
 * NO body has ever entered the room, so none of the in-world behaviour is
 * verified - these tests pin the harness side only).
 *
 * What the errand must never be: a retreat. The standing order is fight to
 * the death and flee_below_hp_percent stays null on purpose, so the errand
 * fires only after the fighting has STOPPED (two calm ticks) and every
 * self-cure - potion, heal spell, draught, lifeTap, the inn's ale - is out
 * of reach. And it must never be a loop: a cooldown between trips, a
 * bounded ask budget at the shrine, and a run-scoped give-up when the
 * shrine does not deliver.
 *
 * Test discipline: every control here drives next() and asserts on the
 * intent that comes out - none recompute the trigger rule. One clause is
 * acknowledged as NOT independently killable at this seam: the errand's
 * own "no potion" condition is masked by the drink-where-you-stand block
 * (hp<45 with a potion returns use_item before the errand is reached), so
 * the potion control below pins the masking behaviour rather than the
 * clause.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KnightsRound } from '../dist/harness/reflex.js';

const TOWN = 'the-valley';
const STAIR = 'millers-stair';
const SHRINE = 'the-valley-shrine';
// Owned top-tier gear, so no bank-run or shopping wish interferes.
const KITTED = ['knight greatblade', 'depths plate'];

/** One tick. hp is out of 1000, mp out of 548; quiet unless said otherwise. */
const beat = (it, o = {}) =>
  it.next(
    o.scene ?? STAIR,
    { damage: o.damage ?? 0, died: o.died ?? false, aggressors: o.aggressors ?? 0, landed: false },
    { value: o.hp ?? 600, total: 1000 },
    null,
    { room: o.scene ?? STAIR, x: 320, y: 320, level: 35, mp: { value: o.mp ?? 200, total: 548 } },
    null, null, null, o.carrying ?? 0, o.potions ?? 0, KITTED, o.coins ?? 5000, o.draughts ?? 0, []
  );

/** True when the intent is any step of the shrine errand. */
const shrineish = (step) =>
  'shrine_bless' === step.action
  || ('use_door' === step.action && /shrine/i.test(String(step.place ?? '')));

/** Capture console.log lines around fn. */
const withLog = (fn) => {
  const lines = [];
  const real = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    fn();
  } finally {
    console.log = real;
  }
  return lines;
};

test('a bleeding body with no cures walks to the shrine and kneels', () => {
  const it = new KnightsRound({});
  // First calm tick: spent, but the streak is one - no errand yet.
  const warm = beat(it, { hp: 300 });
  assert.ok(!shrineish(warm), 'one calm tick is not "the fighting has stopped"');
  // Second calm tick: the errand fires, one door along the ordinary route.
  const out = beat(it, { hp: 300 });
  assert.equal(out.action, 'use_door');
  assert.equal(out.place, TOWN, 'from the stair the first hop is down into the valley');
  const door = beat(it, { hp: 300, scene: TOWN });
  assert.equal(door.action, 'use_door');
  assert.match(String(door.place ?? ''), /shrine/i, 'from the valley it asks for the shrine door');
  const kneel = beat(it, { hp: 300, scene: SHRINE });
  assert.equal(kneel.action, 'shrine_bless', 'standing in the shrine, it kneels');
});

test('a caster dry on mana with no draught, no blood to tap and no ale goes too', () => {
  const it = new KnightsRound({ spell: 'fireball', manaSpell: 'lifeTap' });
  // hp 50%: below lifeTap's 70% floor, above the bleeding line. 50 copper:
  // below the ale's 100. No draughts. Nothing left but the shrine.
  beat(it, { scene: TOWN, hp: 500, mp: 0, coins: 50 });
  const out = beat(it, { scene: TOWN, hp: 500, mp: 0, coins: 50 });
  assert.equal(out.action, 'use_door');
  assert.match(String(out.place ?? ''), /shrine/i);
});

test('CONTROL: it does not fire while something is still biting', () => {
  const it = new KnightsRound({});
  // Spent AND under attack: the beat belongs to the fight, twice over.
  const s1 = beat(it, { hp: 300, aggressors: 1 });
  assert.equal(s1.action, 'attack', 'the fight-back law keeps the beat');
  const s2 = beat(it, { hp: 300, aggressors: 1 });
  assert.ok(!shrineish(s2));
  // The swing just stopped: one calm tick is a lull, not an ending.
  const s3 = beat(it, { hp: 300 });
  assert.ok(!shrineish(s3), 'a single quiet read between swings does not start the walk');
  // Two calm ticks: now the fighting has stopped and the errand may go.
  const s4 = beat(it, { hp: 300 });
  assert.equal(s4.action, 'use_door', 'and only now does the errand fire');
});

test('CONTROL: an errand interrupted by an attacker fights, then resumes', () => {
  const it = new KnightsRound({});
  beat(it, { hp: 300 });
  assert.equal(beat(it, { hp: 300 }).action, 'use_door');
  // Mid-walk, something bites: the beat is a strike, not a step.
  const fight = beat(it, { hp: 300, aggressors: 1 });
  assert.equal(fight.action, 'attack');
  // Quiet again: the errand picks the walk back up.
  const resume = beat(it, { hp: 300 });
  assert.equal(resume.action, 'use_door');
});

test('CONTROL: a body that can heal itself does not go', () => {
  // A working heal spell mends where it stands.
  const healer = new KnightsRound({ healSpell: 'heal' });
  for (let i = 0; i < 4; i += 1) {
    const step = beat(healer, { scene: TOWN, hp: 300, mp: 100 });
    assert.ok(!shrineish(step), `beat ${i}: a healer at 30% mends, it does not march`);
  }
  // A carried potion drinks where it stands (this also documents why the
  // errand's own potion clause is belt-and-braces: this block returns
  // before the errand is ever consulted).
  const carrier = new KnightsRound({});
  for (let i = 0; i < 4; i += 1) {
    const step = beat(carrier, { scene: TOWN, hp: 300, potions: 2 });
    assert.equal(step.action, 'use_item', `beat ${i}: the bottle answers before the walk`);
  }
  // A carried draught refills a dry pool.
  const stocked = new KnightsRound({ spell: 'fireball' });
  for (let i = 0; i < 4; i += 1) {
    const step = beat(stocked, { scene: TOWN, hp: 500, mp: 0, coins: 50, draughts: 2 });
    assert.ok(!shrineish(step), `beat ${i}: a flask in the satchel beats a walk`);
  }
  // Enough blood to tap: lifeTap is the refill, not the shrine.
  const tapper = new KnightsRound({ spell: 'fireball', manaSpell: 'lifeTap' });
  for (let i = 0; i < 4; i += 1) {
    const step = beat(tapper, { scene: TOWN, hp: 800, mp: 0, coins: 50 });
    assert.ok(!shrineish(step), `beat ${i}: at 80% hp the tap can run`);
  }
  // The ale is reachable and affordable: the proven cure keeps the job.
  const rich = new KnightsRound({ spell: 'fireball' });
  for (let i = 0; i < 4; i += 1) {
    const step = beat(rich, { scene: TOWN, hp: 500, mp: 0, coins: 5000 });
    assert.ok(!shrineish(step), `beat ${i}: 100 copper at the cask outranks an unproven shrine`);
  }
});

test('CONTROL: a healthy body never goes at all', () => {
  const it = new KnightsRound({});
  for (let i = 0; i < 4; i += 1) {
    assert.ok(!shrineish(beat(it, { hp: 900, mp: 400 })));
  }
});

test('CONTROL: it does not loop - the asks are bounded and a cooldown follows', () => {
  const it = new KnightsRound({});
  beat(it, { hp: 300 });
  beat(it, { hp: 300 });
  // Standing at the shrine, still spent every beat (the blessing is not
  // landing): count the asks until the errand stops itself.
  let asks = 0;
  for (let i = 0; i < 20; i += 1) {
    const step = beat(it, { hp: 300, scene: SHRINE });
    if ('shrine_bless' === step.action) {
      asks += 1;
    }
  }
  assert.ok(asks > 0, 'it did ask');
  assert.ok(asks <= 6, `it stopped asking (asks: ${asks}) rather than parking the body`);
  // Still spent, but the trip is spent too: no re-fire inside the cooldown.
  for (let i = 0; i < 4; i += 1) {
    assert.ok(!shrineish(beat(it, { hp: 300, scene: TOWN })), 'the cooldown holds');
  }
});

test('CONTROL: two fruitless trips write the shrine off for the run', () => {
  const it = new KnightsRound({});
  const failOneTrip = () => {
    for (let i = 0; i < 20; i += 1) {
      beat(it, { hp: 300, scene: SHRINE });
    }
  };
  beat(it, { hp: 300, scene: SHRINE });
  beat(it, { hp: 300, scene: SHRINE });
  failOneTrip();
  // Force the cooldown open and fail a second trip.
  it.shrineLastTripAt = Date.now() - 11 * 60_000;
  assert.ok(shrineish(beat(it, { hp: 300, scene: SHRINE })), 'the second trip was allowed');
  failOneTrip();
  // Third trip: refused for the rest of the run, cooldown or no cooldown.
  it.shrineLastTripAt = Date.now() - 11 * 60_000;
  for (let i = 0; i < 4; i += 1) {
    assert.ok(!shrineish(beat(it, { hp: 300, scene: SHRINE })), 'the shrine is written off');
  }
});

test('a body mended on the road ends the errand and the cooldown holds', () => {
  const it = new KnightsRound({});
  beat(it, { hp: 300 });
  beat(it, { hp: 300 });
  assert.equal(beat(it, { hp: 300, scene: SHRINE }).action, 'shrine_bless');
  // The bars read whole: the errand is over and the ordinary legs walk out.
  const leave = beat(it, { hp: 1000, mp: 548, scene: SHRINE });
  assert.equal(leave.action, 'use_door', 'whole means leave, not linger');
  assert.equal(leave.place, TOWN);
  // Spent again minutes later: the cooldown refuses a second trip.
  assert.ok(!shrineish(beat(it, { hp: 300, scene: TOWN })), 'no second trip inside the cooldown');
});

test('a shrine that is not what the source promised is given up loudly, for the run', () => {
  const it = new KnightsRound({});
  beat(it, { hp: 300 });
  beat(it, { hp: 300 });
  const lines = withLog(() =>
    it.completed(
      { action: 'shrine_bless' },
      false,
      'nothing Ossian offers reads as healing (offered: "Ask about the candles")'
    )
  );
  assert.ok(
    lines.some((line) => line.startsWith('[shrine]') && /no more shrine errands/.test(line)),
    'the give-up is written down under its own prefix'
  );
  // Even with the cooldown forced open, it never fires again.
  it.shrineLastTripAt = 0;
  for (let i = 0; i < 4; i += 1) {
    assert.ok(!shrineish(beat(it, { hp: 300, scene: TOWN })));
  }
});

test('a death is not a shrine trip - the respawn is already whole', () => {
  // IN TOWN, deliberately: from the stair the errand's first hop is
  // use_door "the-valley", the same door every ordinary leg asks for, so a
  // stair-staged version of this test cannot see the errand fire at all -
  // measured: the died-guard mutation survived it. In town the shrine step
  // is the unmistakable "the shrine" door.
  const it = new KnightsRound({});
  // Warm the calm streak first, so only the died flag stands between the
  // spent reading and the errand.
  beat(it, { scene: TOWN, hp: 300 });
  beat(it, { scene: TOWN, hp: 900 });
  const step = beat(it, { scene: TOWN, hp: 0, died: true, damage: 99 });
  assert.ok(!shrineish(step), 'the death branch owns this beat');
  // And the tick after a death starts the calm streak over.
  assert.ok(
    !shrineish(beat(it, { scene: TOWN, hp: 300 })),
    'one tick after a death is not two calm ticks'
  );
});

test('the errand says what it is doing under its own [shrine] prefix', () => {
  const it = new KnightsRound({});
  beat(it, { hp: 300 });
  const lines = withLog(() => beat(it, { hp: 300 }));
  assert.ok(
    lines.some((line) => line.startsWith('[shrine]') && /no potion|no working heal/.test(line)),
    `the firing reason is in the log (got: ${JSON.stringify(lines)})`
  );
});

test('a death writes a [death] line with the scene and the bar', () => {
  // Deaths were fully handled and never logged - an evening of "no deaths
  // this run" was measuring the absence of a line that is never written.
  const it = new KnightsRound({});
  const died = { damage: 99, died: true, aggressors: 0, landed: false };
  const lines = withLog(() =>
    it.next(STAIR, died, { value: 0, total: 628 }, null,
      { room: STAIR, x: 320, y: 320, level: 35, mp: { value: 0, total: 548 } },
      null, null, null, 0, 0, KITTED, 0, 0, [])
  );
  const deathLines = lines.filter((line) => line.startsWith('[death]'));
  assert.equal(deathLines.length, 1, `one death, one line (got: ${JSON.stringify(lines)})`);
  assert.match(deathLines[0], /millers-stair/, 'the line names the scene');
  assert.match(deathLines[0], /0\/628/, 'the line carries the bar');
  // The feed keeps reporting the death for a while: still one line.
  const again = withLog(() =>
    it.next(STAIR, died, { value: 0, total: 628 }, null,
      { room: STAIR, x: 320, y: 320, level: 35, mp: { value: 0, total: 548 } },
      null, null, null, 0, 0, KITTED, 0, 0, [])
  );
  assert.equal(again.filter((line) => line.startsWith('[death]')).length, 0,
    'the latch keeps one death from logging twice');
});
