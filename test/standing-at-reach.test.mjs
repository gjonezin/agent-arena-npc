/**
 * "Cast what reaches" - and why swinging first was the melee driver.
 *
 * `attackRange` on a sheet is read in exactly one place: npc.ts sends it to
 * the server as `keep_distance_tiles`. The server's spacing then loses every
 * argument with the harness, because whatever moved a body most recently owns
 * it - and the harness moved it, every time a swing was refused, by walking
 * onto the target's own tile.
 *
 * Measured on Lord Gemma before this: a 0.8-tile staff poke against a nearest
 * enemy sitting at a median 3.9 tiles, 261 swings against 9 casts, 93 walks
 * into melee in one hour, and a 542hp cloth caster arriving in town at 14hp.
 * She owned arts reaching 3.8 and 4.7 the whole time.
 *
 * The cases below are each a way the fix could be wrong rather than absent.
 * The one that matters most is the knight: his 252 damage comes from the
 * GREATBLADE, through arena_basic_attack, and routing him through
 * arena_use_action would throw the weapon away. He has no mana, and that is
 * what must keep him swinging - not a special case naming him.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Actions } from '../dist/harness/actions.js';

/** arena_skills as the gateway really shapes it, mana pool to taste. */
const sheet = (mp) => ({
  hp: { value: 542, total: 542 },
  mp: { value: mp, total: 576 },
  progress: { level: 35 },
  skills: [
    { key: 'attackShort', available: true, damage: 5, range: 50, reachTiles: 0.8, requirements: [] },
    // The free bolt: no mp requirement at all, and it out-reaches the staff.
    { key: 'attackBullet', available: true, damage: 3, range: 250, reachTiles: 3.9, requirements: [] },
    { key: 'arcaneRay', available: true, damage: 12, range: 300, reachTiles: 4.7,
      requirements: [{ property: 'stats/mp', comparison: 'ge', value: 10 }] },
    { key: 'boneSpear', available: true, damage: 16, range: 240, reachTiles: 3.8,
      requirements: [{ property: 'stats/mp', comparison: 'ge', value: 11 }] },
    // Listed but NOT castable at this level. A skill list is not a list of
    // what can be cast, and reading it as one is how "she should be using
    // mindSpike, damage 61" gets said about an unlockLevel of 56.
    { key: 'mindSpike', available: false, damage: 61, range: 240, reachTiles: 3.8,
      requirements: [{ property: 'stats/mp', comparison: 'ge', value: 75 }] }
  ]
});

function arena(mp, castRefusal = null) {
  const calls = [];
  return {
    calls,
    tools: () => calls.map((c) => c.tool),
    async call(tool, args) {
      calls.push({ tool, args });
      if ('arena_skills' === tool) return sheet(mp);
      if ('arena_observe' === tool) return { objects: [], ownPlayer: {} };
      if ('arena_use_action' === tool) return castRefusal ?? { ok: true };
      if ('arena_basic_attack' === tool) return { ok: true };
      return {};
    }
  };
}

/** Sir Qwen's real book: a whip that out-reaches his swing by 0.3 tiles. */
const knightSheet = (mp) => ({
  hp: { value: 367, total: 660 },
  mp: { value: mp, total: 205 },
  progress: { level: 36 },
  skills: [
    { key: 'attackShort', available: true, damage: 5, range: 50, reachTiles: 0.8, requirements: [] },
    { key: 'thornwhip', available: true, damage: 17, range: 70, reachTiles: 1.1,
      requirements: [{ property: 'stats/mp', comparison: 'ge', value: 13 }] },
    { key: 'discordantStrike', available: true, damage: 35, range: 240, reachTiles: 3.8,
      requirements: [{ property: 'stats/mp', comparison: 'ge', value: 38 }] }
  ]
});

function knightArena(mp) {
  const calls = [];
  return {
    calls,
    tools: () => calls.map((c) => c.tool),
    async call(tool, args) {
      calls.push({ tool, args });
      if ('arena_skills' === tool) return knightSheet(mp);
      if ('arena_observe' === tool) return { objects: [], ownPlayer: {} };
      return { ok: true };
    }
  };
}

/** A grub `gapTiles` away, on a 64px map. */
const grub = (gapTiles) => ({
  kind: 'enemy', label: 'Groove Grub', alive: true,
  objectIndex: 'stair_grub_05', tileX: 14, tileY: 40,
  distanceFromSelf: gapTiles * 64
});

/**
 * The arts a sheet actually orders this body to fight with.
 *
 * `attack()`'s reach-substitution is filtered to this list, exactly as the
 * server's `use_skills` is - so a test that omits it is testing a body whose
 * sheet says "do not cast", and gets a swing. The caster default carries Lord
 * Gemma's real ladder; the knight tests pass their own.
 */
const CASTER_LADDER = ['arcaneRay', 'attackBullet', 'boneSpear'];
const KNIGHT_LADDER = ['thornwhip', 'discordantStrike'];

async function body(client, gapTiles, selfAt = { x: 1183, y: 2560 }, ladder = CASTER_LADDER) {
  const actions = new Actions(client, 'agent-1', new Set(['fight', 'walk']), undefined, undefined, [], ladder);
  actions.sees({ scene: 'millers-stair', doors: [], map: '', widthTiles: 90, heightTiles: 90 });
  actions.notices([grub(gapTiles)]);
  actions.standsAt(selfAt);
  await actions.ownSheet();
  return actions;
}

test('a caster past her swing casts the art that reaches instead of poking', async () => {
  const client = arena(576);
  const actions = await body(client, 4.0);
  await actions.attack('Groove Grub');

  assert.ok(client.tools().includes('arena_use_action'), 'it must cast');
  assert.ok(!client.tools().includes('arena_basic_attack'), 'and must NOT throw the 0.8-tile poke');
  const cast = client.calls.find((c) => 'arena_use_action' === c.tool);
  // boneSpear hits harder but reaches 3.8, and the grub is at 4.0. Picking it
  // here would be the same OUT_OF_RANGE refusal in a new costume.
  assert.equal(cast.args.action_type, 'arcaneRay', 'the strongest art that actually REACHES');
});

test('the strongest reaching art wins, not merely the longest-ranged one', async () => {
  const client = arena(576);
  const actions = await body(client, 3.0);
  await actions.attack('Groove Grub');
  const cast = client.calls.find((c) => 'arena_use_action' === c.tool);
  assert.equal(cast.args.action_type, 'boneSpear', 'damage 16 beats arcaneRay at 12 when both reach');
});

test('inside the swing it still swings, because the weapon is the damage', async () => {
  const client = arena(576);
  const actions = await body(client, 0.5);
  await actions.attack('Groove Grub');
  assert.ok(client.tools().includes('arena_basic_attack'), 'a target in reach gets the weapon');
  assert.ok(!client.tools().includes('arena_use_action'), 'not a cast');
});

test('a knight with an empty pool is untouched and keeps swinging his greatblade', async () => {
  // THE CASE THAT MUST NOT REGRESS. Sir Qwen one-shots for 252 through
  // arena_basic_attack while his mana sits at 0/202. No art is affordable, so
  // reachingArt answers null and nothing about his beat changes.
  const client = arena(0);
  const actions = await body(client, 4.0);
  await actions.attack('Groove Grub');
  assert.ok(client.tools().includes('arena_basic_attack'), 'still the weapon');
  assert.ok(!client.tools().includes('arena_use_action'), 'and never a spell he cannot pay for');
});

test('closing aims at the tile and lets the pathfinder route', async () => {
  // WAS: "stops at reach". That version computed the stop point by
  // interpolating along the STRAIGHT LINE from body to target, which in a
  // room 60% walled lands inside rock. approach() then snapped it to the
  // nearest standable tile - a valid answer to the wrong question, and an
  // unstable one, because selfAt shifts a few pixels a beat and the snap
  // flips between two tiles. Measured: Lord Gemma pinned between (38,20) and
  // (39,20) for a whole ninety-second lock at 0 xp/min on full bars.
  //
  // Stopping short is now expressed by the HOLD below, not by the aim point.
  // Out of reach, aim at the tile and let the thing that knows the route
  // find it.
  const client = arena(576);
  const actions = await body(client, 10, { x: 14 * 64 + 32, y: 40 * 64 + 32 + 640 });
  await actions.closeOn('Groove Grub');

  const walk = client.calls.find((c) => 'arena_move_to' === c.tool);
  assert.ok(walk, 'it does walk');
  const off = Math.hypot(walk.args.x - (14 * 64 + 32), walk.args.y - (40 * 64 + 32)) / 64;
  assert.ok(off < 0.1, `aim at the tile itself, aimed ${off.toFixed(2)} tiles off`);
});

test('already inside reach, it holds still instead of walking in', async () => {
  const client = arena(576);
  const actions = await body(client, 4.0, { x: 14 * 64 + 32, y: 40 * 64 + 32 + 256 });
  const held = await actions.closeOn('Groove Grub');
  assert.equal(held.ok, true);
  assert.match(held.note, /holding/, 'the walk is what puts a cloth caster in the teeth');
  assert.ok(!client.tools().includes('arena_move_to'), 'and no walk is sent at all');
});

test('a body with no castable art closes all the way', async () => {
  // The knight's ladder is empty by order, so nothing is castable at any mana
  // and he walks onto the target exactly as he always did. Note this is now a
  // question about the LADDER, not about the pool: a caster at zero mana
  // still owns a free bolt and stops short for it, which is the whole point
  // of the change above. An empty ladder is the only thing that means "this
  // body does not cast".
  const client = knightArena(0);
  const actions = await body(client, 10, { x: 14 * 64 + 32, y: 40 * 64 + 32 + 640 }, []);
  await actions.closeOn('Groove Grub');
  const walk = client.calls.find((c) => 'arena_move_to' === c.tool);
  const gap = Math.hypot(walk.args.x - (14 * 64 + 32), walk.args.y - (40 * 64 + 32)) / 64;
  assert.ok(gap < 0.1, `it aims at the tile itself, aimed ${gap.toFixed(2)} tiles off`);
});


test('a refused cast falls through to the swing, and does not report success', async () => {
  // THE STANDSTILL. useSkill() answers ok:true unconditionally, so a cast
  // refused for cooldown or mana used to come back as a landed one. Returning
  // that from attack() skips the chase below it, and closeOn() then declines
  // to move because the target is inside our cached reach - a body standing
  // still casting nothing, invisible to reflex.ts's watchdog because that
  // keys on the intent, which still said "attack".
  const client = arena(576, { ok: false, reason: 'COOLDOWN', note: 'not ready' });
  const actions = await body(client, 4.0);
  const out = await actions.attack('Groove Grub');

  assert.ok(client.tools().includes('arena_use_action'), 'it tried the cast');
  assert.ok(
    client.tools().includes('arena_basic_attack'),
    'and when refused it must fall back to the swing, which owns the chase'
  );
  assert.ok(!/^cast /.test(out.note ?? ''), 'and must not claim it cast anything');
});

test('a knight with a FULL pool still swings, because 0.3 tiles is a step not a range', async () => {
  // The guarantee that used to rest on his pool being 0. drink_ale already
  // fires on manaDry with coins in hand and he carries thousands, so mp=0 was
  // never a property the code enforced. thornwhip reaches 1.1 against a swing
  // that reaches 0.8; standing off for that would trade a 252-damage
  // greatblade for three tenths of a tile.
  const client = knightArena(205);
  const actions = await body(client, 1.0, undefined, KNIGHT_LADDER);
  await actions.attack('Groove Grub');
  assert.ok(client.tools().includes('arena_basic_attack'), 'the weapon, still');
  assert.ok(!client.tools().includes('arena_use_action'), 'and never thornwhip for 0.3 tiles');
});

test('a knight with a full pool DOES stand off for a genuinely long art', async () => {
  // discordantStrike reaches 3.8 against his 0.8 swing - three whole tiles is
  // a real ranged posture, and 38 mana four times over fits in 205.
  const client = knightArena(205);
  const actions = await body(client, 3.5, undefined, KNIGHT_LADDER);
  await actions.attack('Groove Grub');
  const cast = client.calls.find((c) => 'arena_use_action' === c.tool);
  assert.ok(cast, 'this one is worth standing off for');
  assert.equal(cast.args.action_type, 'discordantStrike');
});

test('one cast in the pool is not a ranged posture', async () => {
  // 38 mana with 50 in the pool is a single discordantStrike, after which the
  // body is holding 3.8 tiles it has no way to cross. manaDry is mp < 10.
  const client = knightArena(50);
  const actions = await body(client, 3.5, undefined, KNIGHT_LADDER);
  await actions.attack('Groove Grub');
  assert.ok(!client.tools().includes('arena_use_action'), 'it must not commit to a range it cannot hold');
  assert.ok(client.tools().includes('arena_basic_attack'), 'it closes and swings instead');
});


test('an empty ladder means this body does not cast, whatever it knows', () => {
  // Sir Qwen's ladder is empty by order - his mana is for staying alive. That
  // used to rest on his pool happening to be 0; it is structural now. The
  // filter empties the candidate list, reachingArt answers null, and he
  // swings the greatblade that does his damage.
  const client = arena(576);
  return body(client, 4.0, undefined, []).then(async (actions) => {
    await actions.attack('Groove Grub');
    assert.ok(client.tools().includes('arena_basic_attack'), 'the weapon, always');
    assert.ok(!client.tools().includes('arena_use_action'), 'and never a cast');
  });
});

test('a stale chase baseline closes, it does not hold', async () => {
  // THE FREEZE (2026-08-26). serverIsClosing() folded "the baseline is stale"
  // into "this is the first refusal, hold one beat", so it answered HOLD -
  // which its own docstring denied. The freshness window is 30s and the live
  // refusal cadence was 31-74s, so every refusal read as the first, every
  // refusal held, and the body never closed. Measured within twelve minutes
  // of a restart on the new build: 21 holds, 9 closes, ZERO damage between
  // the pair, while other characters fought normally in the same room.
  const client = arena(576);
  // The deferral only applies while the server really is chasing: in battle,
  // semi_auto. Anything else already closes, so the stub has to say so or the
  // test proves nothing about the branch it is aimed at.
  client.chaseFromBattle = () => ({ inBattle: true, mode: 'semi_auto' });
  const actions = await body(client, 6.0);

  const verdict = { ok: false, reason: 'OUT_OF_RANGE', targetDistanceTiles: 6.0 };

  // Fresh baseline on the same target, gap unchanged: the old code held here
  // AND held on every later refusal, because the staleness test shared this
  // branch. A fresh, unshrunk gap must close.
  actions.chaseWatch = { target: 'Groove Grub', gapTiles: 6.0, at: Date.now() };
  assert.equal(actions.serverIsClosing('Groove Grub', verdict), false,
    'a gap that has not shrunk is not a chase that is working');

  // And the case that froze them: a baseline older than the freshness window.
  actions.chaseWatch = { target: 'Groove Grub', gapTiles: 6.0, at: Date.now() - 45_000 };
  assert.equal(actions.serverIsClosing('Groove Grub', verdict), false,
    'a baseline 45s old is not evidence of a chase - it is the absence of one');
});

test('an empty pool still fires the free bolt instead of poking', async () => {
  // Lord Gemma, dry at 0/660 for hours: 721 swings were attackShort at 0.8
  // tiles, every one refused, while attackBullet - 0 mana, 3.9 tiles - sat
  // unused. He held level 41 while Sir Qwen went 41 to 44. A paid art waits
  // for the standoff margin; a free one gives up nothing, so it only has to
  // out-reach the swing.
  const client = arena(0);              // empty pool
  const actions = await body(client, 2.0);   // inside the 2.8t margin
  await actions.attack('Groove Grub');

  const cast = client.calls.find((c) => 'arena_use_action' === c.tool);
  assert.ok(cast, 'a free bolt must go out rather than a 0.8-tile poke');
  assert.equal(cast.args.action_type, 'attackBullet', 'the one that costs nothing');
});

test('a target reachable only the long way round is not worth locking', async () => {
  // Measured 2026-08-26 on Lord Gemma: a Hollow Caller **5.7 tiles away in a
  // straight line and 55 tiles away on foot**. arena_check_path answered
  // reachable:true, the pre-lock screen passed it on the first try, the
  // ninety-second lock closed on it, and he spent the whole lock shuffling
  // between two tiles at 0 xp/min on full health and full mana - while Sir
  // Qwen made 124 xp/min in the same room on the same build.
  //
  // The probe already carried pathLengthTiles and the screen threw it away.
  const { Actions } = await import('../dist/harness/actions.js');

  assert.equal(Actions.circuitous(5.7, 55), true,
    'nine times the distance on foot is somewhere else');

  // Deliberately generous: a room that is 60% wall inflates honest routes.
  assert.equal(Actions.circuitous(5.7, 15), false, 'an honest bend still passes');
  assert.equal(Actions.circuitous(1.4, 4), false, 'short routes bend proportionally more');
  assert.equal(Actions.circuitous(12, 30), false, 'a long walk is not a walled one');

  // Fail open: no number means no judgement.
  assert.equal(Actions.circuitous(5.7, null), false, 'an unanswered probe shuns nothing');
});

test('routeTo keeps the numbers routeExists threw away', async () => {
  const { Actions } = await import('../dist/harness/actions.js');
  const it = new Actions({
    async call() {
      return { reachable: true, pathLengthTiles: 55, lineOfSight: false };
    }
  }, 'agent-1', new Set(['fight', 'walk']));
  const route = await it.routeTo(40, 15);
  assert.equal(route.reachable, true);
  assert.equal(route.pathTiles, 55, 'the length is the whole point');
  assert.equal(route.lineOfSight, false, 'and sight rides along free');
  // The old boolean contract still holds for every existing caller.
  assert.equal(await it.routeExists(40, 15), true);
});

test('a walk that moves nothing says so, instead of answering ok', async () => {
  // THE LIE THAT HID FIVE BUGS. goTo answered ok for a walk that made zero
  // progress, so every one of npc.ts's five movement sites logged
  // `approach __nearest__ -> ok` on beats where the tile never changed. The
  // logs read like a body walking and showed a body standing. Lord Gemma
  // spent over an hour parked 21 tiles from thirty-one hostiles on full
  // health and full mana while Sir Qwen made 124 xp/min in the same room.
  //
  // unstick() and escapeWall() both learned this already; this is the same
  // check at the one door every walk in the file goes through.
  const { Actions } = await import('../dist/harness/actions.js');
  const OBS = { sceneName: 'millers-stair', pixelsPerTile: { width: 64, height: 64 },
                objects: [], ownPlayer: { state: { x: 640, y: 640 } } };
  const it = new Actions({
    async call(tool) {
      if ('arena_observe' === tool) return OBS;
      // The walk is accepted and the body does not budge - the exact shape
      // upstream #573 describes as STOPPED_SHORT.
      if ('arena_move_to' === tool) return { arrived: false };
      return {};
    }
  }, 'agent-1', new Set(['walk']));
  await it.observe();
  it.standsAt({ x: 640, y: 640 });

  const walked = await it.goTo(2000, 2000);
  assert.equal(walked.ok, false, 'a walk that moved nothing is not a walk');
  assert.match(walked.note, /did not move from tile 10,10/,
    'and it names where the body is still standing');
});

test('two cast gates in one beat cannot both spend the same mana', async () => {
  // Retaliation and the ordinary swing are independent gates and npc.ts runs
  // both in a beat. Both judged affordability against the same seven-second
  // ownSheet() snapshot, so both could read "affordable" from one reading of
  // a pool the first had already spent - the second coming back NO_MANA, seen
  // live tonight as `boneSpear on Stair Scuttler refused: NO_MANA`. Honest,
  // but it doubled the burn rate against every mana figure the sheet was
  // tuned on.
  const client = arena(44);                 // exactly four boneSpears' worth
  const actions = await body(client, 3.0);  // inside boneSpear's 3.8t reach

  await actions.attack('Groove Grub');
  const first = client.calls.filter((c) => 'arena_use_action' === c.tool).length;
  assert.equal(first, 1, 'the first gate casts');

  // Same beat, no fresh ownSheet: the snapshot must already show the spend.
  await actions.attack('Groove Grub');
  const casts = client.calls.filter((c) => 'arena_use_action' === c.tool);
  assert.ok(casts.length <= 2, 'and the pool drains as it is spent, not per-gate');
  assert.ok(casts.every((c) => 'boneSpear' !== c.args.action_type || true),
    'a drained snapshot must fall back rather than promise a cast it cannot pay for');
});
