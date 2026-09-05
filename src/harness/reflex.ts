/**
 * The knight's round as a reflex: a state machine, not a model.
 *
 * A 32B model was spending ninety GPU-seconds a minute deciding to do what
 * this file does in zero. The round is a clock - out, slay, loot, home,
 * sell, stock, heal, rest - and clocks do not need minds. The mind stays
 * for what needs one: answering people and duels.
 *
 * Everything acts through the same executor the model uses, so refusals
 * come back as notes and the round reacts: a wrong item name tries the
 * next likely one, a "too far away to trade" walks closer, a crowd or a
 * dropping health bar (read from the public watch feed - the agent API
 * hides it) turns the trip around with the engine's own flee style.
 *
 * A round with a partner name follows first and hunts second: whatever
 * room the partner stands in is where this character belongs.
 */

import { Intent } from './actions.js';
import { tilePxFor } from './world.js';

/**
 * MELEE ARTS ARE NOT A CASTER'S TOP RUNG (2026-08-27).
 *
 * `attackShort` sits on Lord Gemma's ladder for exactly one reason: the
 * SERVER's own rotation needs a point-blank option, because every projectile
 * art spawns its bullet ~35px toward the target and refuses PROJECTILE_DEAD
 * _ZONE at contact. `worthCasting()` in actions.ts already excludes it by
 * name so the harness never casts it itself.
 *
 * This pick had no such exclusion, and adversarial review traced why it had
 * not bitten: pure array order. At levels 1-13, before boneSpear unlocks,
 * the survivors are arcaneRay(0), attackBullet(1), attackShort(1) - and the
 * two level-1 rungs TIE. Node's sort is stable, so attackBullet wins only
 * because it happens to sit earlier in the sheet array. Alphabetise that
 * array, or slot a rung between them, and a caster's every fighting beat
 * silently becomes a 0.8-tile melee reattempt instead of the free bolt this
 * mechanism exists to guarantee.
 *
 * One function, two callers, so there is no third copy to drift.
 */
const MELEE_ARTS = ['attackShort'];

function earnedRung(
  ladder: Array<{ level: number; skill: string }> | undefined,
  level: number
): { level: number; skill: string } | undefined {
  return (ladder ?? [])
    .filter((rung) => level >= rung.level && !MELEE_ARTS.includes(rung.skill))
    .sort((a, b) => b.level - a.level)[0];
}


type Leg = 'outbound' | 'hunting' | 'looting' | 'homebound' | 'restock' | 'resting';

// THE WORLD MOVED UNDER US (2026-08-16). Upstream commit 71bfef6 retired the
// nine Reldens demo rooms and replaced them with the valley and its six
// interiors; 54dc082 then sealed the valley's road out on purpose. Both are
// LIVE: the characters stand in `the-valley` and the gateway lists exactly
// six doors, all of them valley interiors.
// `reldens-town` no longer exists, and asking for it is not free - the round
// asked ~20 times in five minutes, was refused, fell into the shrine and came
// back, once every 40 seconds, a model call each time.
// TOWN now names the room that actually is the town. NOTE the merchant did
// NOT come with it: Gimly is the world's only trader object and he is still
// in the retired room, so selling and buying are impossible until upstream
// places a trader in the valley. See the note on the restock leg.
const TOWN = 'the-valley';
// YARD and FIELD named retired rooms too. FIELD - the 145x145 deep wood -
// has no successor at all; nothing upstream replaces its spawn density. It
// is kept pointing at the dead name deliberately rather than aliased to a
// live room, so nothing silently marches a body somewhere it was never meant
// to hunt; every use of it is now guarded by the scene checks that already
// exist. Delete both once the new grind ground is chosen.
const YARD = 'reldens-bots';
const FIELD = 'reldens-bots-forest';
const GRASSLAND = 'arena-grassland';
const SHORE = 'arena-shore';
const MEADOW = 'hollow-meadow';
const CRYPT = 'arena-crypt';
const DUNGEON = 'arena-dungeon';
// MILLER'S STAIR: the North path's first stop, and as of upstream cbe806a2
// the only door out of the valley - every zone named above it is now
// unreachable, whatever its level gate says. Opened here 2026-08-21.
//
// It is a real hunting ground, unlike everything it replaces: 30 respawners
// carrying up to 8 instances each, four species (Stair Scuttler, Groove Grub,
// Hollow Caller, Strayed Hauler) at 120-180 HP and 38-48 attack, and - the
// part the forest never had - every one of them pays coin, 100 to 500 copper.
// Read off deploy/world/populate-regions.mjs, not guessed.
//
// It is also a 192x176 Voronoi maze with 20,245 of its 33,792 tiles walled,
// so distance here is not the walk. See world.ts's PLACES for the three
// nearest respawn patches; the pathfinder does the rest.
const STAIR = 'millers-stair';

/**
 * The hunting grounds, rotated one per trip. Scouted 2026-08-11:
 * grassland is one door from town with twenty enemies, the shore lies
 * beyond it with eight, and the bots forest holds its three hundred.
 * Variety is exploration with the same armor on: leash, flee, and the
 * live health bar work the same in every room.
 */
// HISTORY, NOT CURRENT STATE - read the gate constants below for what is
// actually open. Kept because the reasoning explains the shape of the
// gates, but every claim here has since been superseded:
//   - "the grassland's invisible boar one-shot a level-6 knight" bit a
//     LEVEL 6 body; the pair is past 30 and the room is authored
//     aggressive:false. It is open again as the coin ground.
//   - "the grassland goes back to being a road" and "CLOSED (user's final
//     word)" are both stale as of 2026-08-16.
//   - "history showed a L30 knight landing eight real hits in two hours
//     there" was measured under a defect that bailed out of the room after
//     four ticks every visit, so it is not evidence about the room at all.
//   - the strongest contrary measurement on record, "~90 XP/hr vs forest's
//     650+", is superseded for the same reason and NOT because it was
//     wrong: it was taken under that same four-tick bail, so it measured
//     the defect rather than the room. The XP gap it reports is real and
//     still expected - the forest IS the better XP ground - which is
//     exactly why the two rooms are kept for two different jobs rather
//     than one replacing the other. If the grassland turns out to be as
//     sparse as that figure implies once the round can actually stay in
//     it, the honest response is to reduce its share of the rotation, not
//     to pretend the number never existed.
// The BOT FOREST remains the primary ground and the best XP in the world
// (~0.200 XP per point of enemy HP, against the grassland's ~0.089): three
// hundred enemies, open terrain, and the zone this pair verifiably levelled
// through. It simply pays no coins - see GRASSLAND_LEVEL below.
// The stair, and only the stair. FIELD (the bot forest) named a retired room
// and GRASSLAND is behind the sealed south road: leaving either in this list
// sends a body marching at a door that is not there. The stair needs no level
// gate the way the zones below did, because it is not one option among
// several - it is the whole of the reachable world outside the valley.
const FIELDS = [STAIR];

/**
 * THE FRONTIER, opened upstream 2026-08-22 and mapped here 2026-08-24.
 *
 * The valley no longer has one way out. Four cardinal paths leave it, three
 * stops each, and every stop is a chain: one door back the way you came, one
 * door onward. Levels and rooms below are upstream's own authored table
 * (deploy/world/frontier-progression.mjs), not guesses, and every one of the
 * twelve rooms is 32px - the harness default, so no tile table needs them.
 *
 * `approach` names the corridor room that has to be crossed first where one
 * exists. Only the west path has one: the valley opens onto the mill road,
 * and the Ford is the room beyond it.
 *
 * One authored gate stands in the whole frontier, and it is on the path we
 * already grind: millers-stair -> widows-watch wants a `roadmenders_mark`,
 * earned from the FESSIC crate in the valley smithy and carried to Fessic at
 * the stair head. Nothing else is locked, so a body of the right level walks
 * straight in.
 */
type Stop = { room: string; level: number; path: string; approach?: string };
const FRONTIER: Stop[] = [
  { room: 'millrace-ford', level: 10, path: 'west', approach: 'millrace-approach' },
  { room: 'oathstone', level: 18, path: 'south' },
  { room: 'sinkfoot-crossing', level: 26, path: 'east' },
  { room: 'widows-watch', level: 35, path: 'north' },
  { room: 'reed-camp', level: 45, path: 'west' },
  { room: 'bleaching-flats', level: 55, path: 'south' },
  { room: 'grey-reeds', level: 65, path: 'east' },
  { room: 'salt-vein', level: 75, path: 'north' },
  { room: 'driftwood-landing', level: 85, path: 'west' },
  { room: 'caravan-rest', level: 92, path: 'south' },
  { room: 'last-farm', level: 100, path: 'east' }
];

/** The door to ask for, room by room, walking a path out and back again. */
const FRONTIER_ROUTE: Record<string, { out: string; back: string }> = {
  'millrace-approach': { out: 'millrace-ford', back: TOWN },
  'millrace-ford': { out: 'reed-camp', back: 'millrace-approach' },
  'reed-camp': { out: 'driftwood-landing', back: 'millrace-ford' },
  'driftwood-landing': { out: 'driftwood-landing', back: 'reed-camp' },
  'oathstone': { out: 'bleaching-flats', back: TOWN },
  'bleaching-flats': { out: 'caravan-rest', back: 'oathstone' },
  'caravan-rest': { out: 'caravan-rest', back: 'bleaching-flats' },
  'sinkfoot-crossing': { out: 'grey-reeds', back: TOWN },
  'grey-reeds': { out: 'last-farm', back: 'sinkfoot-crossing' },
  'last-farm': { out: 'last-farm', back: 'grey-reeds' },
  'widows-watch': { out: 'salt-vein', back: STAIR },
  'salt-vein': { out: 'salt-vein', back: 'widows-watch' }
};

/** The quest gate, so a body can say why a door refused it. */
const FRONTIER_GATE = {
  from: STAIR,
  to: 'widows-watch',
  key: 'roadmenders_mark',
  advice: 'Open the crate marked FESSIC in the Valley smithy, take the tempered '
    + "wedges to Fessic at the stair head, and return with the roadmender's mark."
};
// THE GOLD GROUND. Open at last, and only now, because until 2026-08-16 the
// round could not hunt a passive room at all.
// Why it is worth having: the forest's Tree/Tree Punch are stock Reldens
// demo rows the custom reward seeder never covered - there is no tree row
// in ENEMY_REWARDS at all - so they pay NO coins (branch buyback is 1
// copper, deploy/world/seed-items.mjs:553; 150 of them moved a purse by
// nothing, measured live). grass_boar and grass_stinger pay ~224 and ~208
// copper a kill including their material and rare rows. Those figures need
// BOTH seed files to reconcile: the wave-1 rows alone
// (deploy/world/seed-items.mjs:413-418, buybacks :520-541) come to 179 for
// the boar, and it is the wave-2 rows -
// deploy/world/item-specs/seed-items-wave-2.generated.mjs:675-677 with
// buybacks at :896/:905/:912 - that make up the difference: 90 + 80 + 9 +
// 20 + 10 + 15 = 224 exactly. Coins rows are scaled x100 by
// migrate-currency.mjs. That is the difference between an economy and none.
// Why it could not work before: futileStrikes counts every hunting beat and
// used to reset on exactly one thing, an active battle. This room is
// authored aggressive:false, so nothing here opens a fight, and a level-30+
// swing kills a 90hp boar outright so the engine never starts one either -
// it only does when the target SURVIVES. aggressors was therefore pinned at
// zero here and the round bailed after four ticks on every single visit.
// The forest only ever worked by accident, because #172 made Tree Punch
// aggressive. That is fixed: futileStrikes now also resets on a landed hit
// or kill, read from the battle event log (see arena.ts), with regression
// tests that fail against the old behaviour.
// Danger, checked rather than assumed: aggressive:false
// (deploy/world/populate-regions.mjs:136, written to isAggressive at :448)
// means nothing here attacks first, and the boar's atk 40 / stinger's atk
// 34 (:140,:144) against 500-628hp is noise. The one-shot
// boar that originally closed this room bit a LEVEL 6 knight and no longer
// exists as authored. (PRs #172/#173 tune the FOREST's enemies, not this
// room's - they are not evidence either way here, and an earlier version of
// this comment wrongly cited them.)
// Rotation, stated precisely because the obvious guess is wrong:
// topFields() becomes [GRASSLAND, FIELD], and fieldIndex resets to 0 on
// every town arrival REACHED ON THE HOMEBOUND LEG (the reset lives in
// case 'homebound' under scene === TOWN). restock and resting bounce back
// through homebound when out of town so the normal loop always hits it,
// but an outbound-leg crossing of town - which every grassland and shore
// cache route is - does not. So the real cycle is rest -> grassland ->
// bank -> rest -> grassland, and the forest is reached only when a futile
// bail advances the index. Deliberate now that the grassland pays and the
// forest does not, though it does mean the forest's better XP is the
// exception rather than half the rotation. The forest is still the better
// XP ground - ~0.200 XP per point of enemy HP against the grassland's
// ~0.089, so about 2.2x - and the two rooms are kept for two different
// jobs on purpose.
// All of the above describes a LEADER. A follower's topFields() collapses
// to the single-element [leaderDest] - making fieldIndex inert - but ONLY
// while the leader publishes a hunting or looting leg. When he is outbound
// or homebound he falls back to the same two-element list and the index is
// live again. That fallback is not a footnote: it is the state that made a
// field-locked follower fight the top-field check for ever, because the
// forest is not in his list while the leader works the grassland. See the
// !fieldLocked guard on that check.
// Two more things the lock does NOT cover, worth knowing before trusting it:
// futileCaches also empties treasureTarget(), so writing a cache off (two
// deaths, or ten tries) silently removes the lock's own exemption mid-run;
// and fieldLocked tests FIELD === scene only, so the stay-and-fight-until-
// you-level doctrine is absent from the grassland - which is now where the
// pair spends most of its time. That is deliberate: the grassland is one
// door from town, so the full-map traverse to the western boundary that
// motivated the lock does not exist there, and locking the only room that
// pays would block the bank run that turns those coins into gear, which is
// the whole point of opening it. Widening it is also a coupled change, not
// a constant swap - fieldEntryLevel is cleared on FIELD !== scene.
// Put this back to 999 to close it; nothing else depends on the value.
// CLOSED 2026-08-24, and it should have been closed the day the road was
// sealed. The grassland sits on the retired demo island - flood-filling
// upstream's own room graph from the valley reaches fourteen rooms and none
// of them is this one - so a body sent here marches at a door that does not
// exist. The bug was invisible while it mattered least: the watch feed had
// dropped `sheet`, so `level` was null on every tick and this gate never
// once opened. Restoring the level read through arena_skills would have
// armed it silently. FIELDS' own comment has said the grassland is
// unreachable since 2026-08-16; the constant just never agreed.
const GRASSLAND_LEVEL = Infinity;
// Shore CLOSED too (user order 2026-08-13: "avoid the shores it's
// bugged") - its seven Saltbacks all spawn 20+ tiles from the entrance
// and the room never paid a strike all evening. Crypt only.
const SHORE_LEVEL = Infinity;
// The hollow meadow is CLOSED: surveyed through the knight's own eyes
// on 2026-08-13 and it is an empty shell - zero enemies, zero people,
// zero readables, one door. Nothing to grind. Reported to kadajett;
// re-open by lowering the gate when it gains a population.
const MEADOW_LEVEL = Infinity;
// The crypt: CLOSED after the audit. The doctrine there ended perfect -
// corridor post from map analysis, real arrows, clean lanes, zero
// deaths - and the room still paid nothing: kill credit is inconsistent
// server-side (one probe kill engaged and resolved; hours of identical
// shots credited nothing). On kadajett's bug list. Reopen when he
// confirms the fix; the routes and the (16,4) firing post stay wired.
// Re-closed 2026-08-16 (user order, live emergency): reopened hours earlier
// the same night for its real coin economy (see the git history on this
// line for that reasoning, still valid) - closed again after Sir Qwen's
// own position started drifting steadily off-map while stuck there
// (real px in the tens of thousands and climbing, ~250 tiles further every
// ~50s, matching the documented "sovereign ran off the map" incident's
// shape). Root cause not fully traced - the harness-side code path for the
// specific failure he was stuck on sends no movement command at all, so
// this looks like a server-side door/pathing bug triggered by something
// about this room, not a harness bug reachable from here. Do not reopen
// until that is understood or the server fixes it; a harness-side
// give-up-and-walk-back fix landed the same session and should recover a
// character already stuck, but does not make the room safe to enter again.
const CRYPT_LEVEL = Infinity;
// The dungeon: CLOSED (user order, third and final time tonight - "stay
// out of there for now"). The second attempt lured the sovereign in and
// wedged him. The crypt corridor post is the grind; the dungeon waits
// for kadajett's word that it is stocked and navigable.
const DUNGEON_LEVEL = Infinity;

export function fieldsFor(level: number | null): string[] {
  const open = [...FIELDS];
  if (null !== level && level >= GRASSLAND_LEVEL) {
    open.push(GRASSLAND);
  }
  if (null !== level && level >= SHORE_LEVEL) {
    open.push(SHORE);
  }
  if (null !== level && level >= MEADOW_LEVEL) {
    open.push(MEADOW);
  }
  if (null !== level && level >= CRYPT_LEVEL) {
    open.push(CRYPT);
  }
  if (null !== level && level >= DUNGEON_LEVEL) {
    open.push(DUNGEON);
  }
  // THE FRONTIER IS DELIBERATELY NOT HERE. It was, for about twenty minutes
  // on 2026-08-24, and the result is worth writing down: topFields() takes
  // `.slice(-2).reverse()` of this list, so it hunts the two HIGHEST rooms a
  // body qualifies for. Adding eleven frontier rooms therefore did not widen
  // the rotation, it replaced it - a level 35 knight stopped hunting the
  // room he can clear and marched at the hardest room his level allowed.
  //
  // Measured, which is the only reason this is a fact and not a worry:
  // Miller's Stair holds Groove Grubs at 150hp. Sinkfoot Crossing, the third
  // stop by level, holds Hoppers at 860 and Reed Rats at 1344 - six to nine
  // times the health, on a pair standing at 351/644 and 141/516 with no mana
  // between them. Upstream's own curve says so plainly: hp is
  // 100 + threat*22 + threat^2*0.35, and threat rises with the room.
  //
  // A recommended level is permission to survive a room, not evidence it is
  // the best place to earn. The stair is recommended level 1 and these two
  // are 33 and 35, which is exactly the over-levelled ground a grind wants.
  // frontierOpenTo() below keeps the level rule for deliberate travel, where
  // choosing a hard room is the point rather than an accident of sorting.
  return open;
}

/**
 * The frontier rooms a body of this level may walk into, hardest last.
 *
 * Separate from fieldsFor() on purpose: this is for going somewhere, not for
 * choosing where to hunt. Widow's Watch is excluded at every level - it is
 * the one quest-gated door in the world, and marching at a door that will
 * refuse the body is the failure both lists exist to avoid.
 */
export function frontierOpenTo(level: number | null): string[] {
  if (null === level) {
    return [];
  }
  return FRONTIER
    .filter((stop) => level >= stop.level && FRONTIER_GATE.to !== stop.room)
    .map((stop) => stop.room);
}

/** Every room on the way to `room`, valley first, so a walk can be staged. */
export function frontierPathTo(room: string): string[] {
  const stop = FRONTIER.find((s) => s.room === room);
  if (!stop) {
    return [];
  }
  const chain: string[] = [];
  let at = room;
  // Walk the route backwards to the valley, which terminates because every
  // `back` is either another frontier room or TOWN itself.
  for (let hop = 0; hop < 8 && at !== TOWN; hop += 1) {
    chain.unshift(at);
    at = FRONTIER_ROUTE[at]?.back ?? TOWN;
    if (STAIR === at) {
      chain.unshift(STAIR);
      at = TOWN;
    }
  }
  return chain;
}

/** One door along the routes the scout mapped. */
const NEXT_DOOR: Record<string, Record<string, string>> = {
  [TOWN]: {
    // The valley had exactly one way out and it went up. Not since
    // 2026-08-22: four roads leave it now - north to the stair, west to the
    // mill road, south to the Oathstone, east to Sinkfoot Crossing - and
    // each is the head of a three-stop path. The retired demo rooms below
    // still answer "the stair", because they are not reachable any other
    // way and never will be; the frontier rooms get their own real doors,
    // appended after this table so one list owns them.
    [STAIR]: STAIR,
    [GRASSLAND]: STAIR,
    [SHORE]: STAIR,
    [MEADOW]: STAIR,
    [CRYPT]: STAIR,
    [DUNGEON]: STAIR,
    [FIELD]: STAIR,
    [YARD]: STAIR,
    // Literals, not the INN/GRANGE constants: those are declared far below
    // this table and reading them here is a dead-zone throw at module load.
    'the-valley-inn': "Barnaby's inn",
    'the-valley-smithy': 'the smithy',
    'the-valley-mage': "the mage's shop",
    'the-valley-trading-post': 'the trading post',
    'the-valley-grange': 'the grange',
    'the-valley-shrine': 'the shrine'
  },
  // Down off the stair is the valley for every destination BELOW; the
  // stair's north gate is no longer chained folklore but a real door to
  // Widow's Watch, gated on the roadmender's mark, and it is added with the
  // rest of the frontier after this table.
  [STAIR]: {
    [TOWN]: TOWN, [GRASSLAND]: TOWN, [SHORE]: TOWN, [MEADOW]: TOWN,
    [CRYPT]: TOWN, [DUNGEON]: TOWN, [FIELD]: TOWN, [YARD]: TOWN,
    'the-valley-inn': TOWN, 'the-valley-smithy': TOWN, 'the-valley-mage': TOWN,
    'the-valley-trading-post': TOWN, 'the-valley-grange': TOWN, 'the-valley-shrine': TOWN
  },
  // Out of any valley interior is back into the valley: each has one door.
  // nextDoorToward() would fall through to TOWN anyway, but a wrong default
  // here is a body stuck in a shop, so it is said rather than relied upon.
  ['the-valley-smithy']: { [TOWN]: TOWN, [STAIR]: TOWN },
  ['the-valley-mage']: { [TOWN]: TOWN, [STAIR]: TOWN },
  ['the-valley-inn']: { [TOWN]: TOWN, [STAIR]: TOWN },
  ['the-valley-trading-post']: { [TOWN]: TOWN, [STAIR]: TOWN },
  ['the-valley-grange']: { [TOWN]: TOWN, [STAIR]: TOWN },
  ['the-valley-shrine']: { [TOWN]: TOWN, [STAIR]: TOWN },
  [YARD]: { [FIELD]: FIELD, [TOWN]: TOWN, [GRASSLAND]: TOWN, [SHORE]: TOWN, [MEADOW]: TOWN, [CRYPT]: TOWN, [DUNGEON]: TOWN, 'reldens-house-1': TOWN, 'reldens-house-2': TOWN, 'reldens-forest': TOWN },
  [FIELD]: { [TOWN]: YARD, [YARD]: YARD, [GRASSLAND]: YARD, [SHORE]: YARD, [MEADOW]: YARD, [CRYPT]: YARD, [DUNGEON]: YARD, 'reldens-house-1': YARD, 'reldens-house-2': YARD, 'reldens-forest': YARD },
  [GRASSLAND]: { [SHORE]: SHORE, [MEADOW]: MEADOW, [CRYPT]: CRYPT, [DUNGEON]: CRYPT, [TOWN]: TOWN, [FIELD]: TOWN, [YARD]: TOWN, 'reldens-house-1': TOWN, 'reldens-house-2': TOWN, 'reldens-forest': TOWN },
  [SHORE]: { [GRASSLAND]: GRASSLAND, [TOWN]: GRASSLAND, [FIELD]: GRASSLAND, [YARD]: GRASSLAND, [MEADOW]: GRASSLAND, [CRYPT]: GRASSLAND, [DUNGEON]: GRASSLAND, 'reldens-house-1': GRASSLAND, 'reldens-house-2': GRASSLAND, 'reldens-forest': GRASSLAND },
  ['reldens-house-1']: { [TOWN]: 'town', [YARD]: 'town', [FIELD]: 'town' },
  ['reldens-house-2']: { [TOWN]: 'town', [YARD]: 'town', [FIELD]: 'town' },
  ['reldens-forest']: {
    [TOWN]: 'town', [YARD]: 'town', [FIELD]: 'town', [GRASSLAND]: 'town', [SHORE]: 'town'
  },
  // The deep zones hang off the crypt entry, which hangs off the
  // grassland: every route in or out threads that needle. The crypt is
  // crossed at a walk - it is a road with teeth, never a camp.
  [CRYPT]: { [DUNGEON]: DUNGEON, [GRASSLAND]: GRASSLAND, [TOWN]: GRASSLAND, [SHORE]: GRASSLAND, [MEADOW]: GRASSLAND, [FIELD]: GRASSLAND, [YARD]: GRASSLAND, 'reldens-house-1': GRASSLAND },
  [MEADOW]: { [GRASSLAND]: GRASSLAND, [TOWN]: GRASSLAND, [SHORE]: GRASSLAND, [CRYPT]: GRASSLAND, [DUNGEON]: GRASSLAND, [FIELD]: GRASSLAND, [YARD]: GRASSLAND, 'reldens-house-1': GRASSLAND },
  [DUNGEON]: { [CRYPT]: CRYPT, [GRASSLAND]: CRYPT, [TOWN]: CRYPT, [SHORE]: CRYPT, [MEADOW]: CRYPT, [FIELD]: CRYPT, [YARD]: CRYPT, 'reldens-house-1': CRYPT }
};

const PREY = ['Tree Punch', 'Tree'];
// General loot is sold from actions.sellableItems() now, not a fixed name
// list here (2026-08-15: a name list this small could never keep up with
// what a farming route actually drops - measured at "1000 items" and
// nothing selling). sellableItems() filters on the structured item data
// (equipment, usable) before any key ever reaches this file, which is also
// what makes it safe: a weapon can never appear in that result regardless
// of what it is called, so the old fuzzy-match danger below cannot recur
// through this path.
// Coins are NEVER sold - a first version of this filter missed it
// (equipment:false, usable:false describes money exactly as well as it
// describes junk) and would have put the character's own purse up for
// sale first, every rest. isCargo() in actions.ts excludes it explicitly,
// in the one place carriedBranches() already had to; recorded here anyway
// because it is the kind of exception worth being able to find from this
// side too. The tarnished key got the same exclusion originally, on the
// guess that a sealed door might want it - agentArena issue #114
// confirmed 2026-08-15 that no door in the world is locked and the key
// opens nothing; its only function is a 300-currency sale, so it is cargo
// like anything else now.
// HARD RULE for the JUNK weapons list below, written in scar tissue: NO
// WEAPON NAME EVER GOES IN A NAME-MATCHED LIST WITHOUT CHECKING IT AGAINST
// THE WHOLE ROSTER FIRST. Sale matching there is fuzzy and only the WORN
// item is sale-proof - a bare 'axe' sold the crescent axe, and 'curved
// sabre' sold itself before the equip step could put it in hand.
const POTION_NAMES = ['potion', 'health potion', 'healing potion', 'life potion', 'heal'];
// Weapons of war ONLY, best first: a knight who bought a copper hoe
// with the war chest taught us to curate. The 2026-08-13 restock added
// level-gated tiers (L15 and L35) and true armour, so each rung now
// carries the shop's exact item key (what arena_buy wants), a normalized
// match name (what carriedNames shows, apostrophes stripped), the level
// that unlocks it, and the counter price in copper - the price is what
// lets the round head to market the moment an upgrade is affordable
// instead of shopping on a timer.
export type GearRung = { buy: string; match: string; level: number; price: number };
/**
 * Coins to copper. The world migrated its currency to copper (the server's
 * own `COPPER_SCALE`, deploy/world/migrate-currency.mjs) and multiplied every
 * shop row by it: `priceCopper = priceCoins * 100`. The purse followed - the
 * `coins` item's carried quantity IS copper now, which is why a purse reads
 * 7648 rather than 76.
 *
 * These ladders were written with the server's `priceCoins` numbers (190 for
 * a yew warbow, deploy/world/item-specs/combat-gear.mjs:159), so every price
 * here was being compared against a copper balance and was 100x too cheap
 * (found 2026-08-16). affordableUpgrade() therefore called the top tier
 * affordable the moment the purse held 190 COPPER - about two coins - so the
 * round marched to market over and over on a wish it could never pay for,
 * and the counter refused every rung down to the 5-coin axe. That is the
 * "You cannot afford that" cascade in the logs, and the reason gear never
 * got bought no matter how the sell logic was fixed.
 */
const COINS_TO_COPPER = 100;
/** Named `inCopper`, not `coins`: next() already takes a `coins` parameter,
 *  and a module-level `coins` would be shadowed inside it - legal, and
 *  exactly the kind of quiet collision this fix exists to stop repeating. */
const inCopper = (priceCoins: number): number => priceCoins * COINS_TO_COPPER;
// TWO CONVENTIONS LIVE IN THIS FILE ON PURPOSE, so nobody "corrects" the
// second one: ladder prices are written in the server's coins and converted
// here by inCopper(), because that is how combat-gear.mjs declares them and
// keeping the same numbers makes them checkable against it. The handful of
// bare thresholds elsewhere (the 500 that gates a mana draught, the 2000
// that gates restocking one) are ALREADY copper and correct as written -
// a deep mana draught is priceCoins 5, which is exactly 500 copper. Both
/**
 * Stoops in a row before a sweep hands back to hunting.
 *
 * Eight is taken from the split that demonstrably works rather than chosen:
 * Lord Gemma runs about 1.36 looting beats per hunting beat and earns 56.8
 * xp/min. It is a cap on a RUN, not a budget - a fight's drops are cleared
 * long before eight consecutive successes.
 */
const LOOT_RUN_CAP = 8;
/**
 * The hp% below which a body breaks off to go and recover.
 *
 * Fifty, by user order 2026-08-25 ("add health ourselves with food and spells
 * if under 50% health and under 50% mana"). The mana half of that is
 * `manaDry`, which is the engine's own floor at mp < 10 and stricter than a
 * percentage would be - below it nothing casts at all.
 */
const RECOVER_BELOW_HP_PCT = 50;
/**
 * Three refused marches, then four minutes off. Three because two adjacent
 * failures were measured inside two minutes and a pair should not be enough
 * to give up an authored anchor; four minutes because that is the same order
 * as the target shun, and the approach that failed is usually the thing that
 * has changed by then.
 */
/**
 * A TRADE BEAT, WITHOUT GIVING UP THE GRIND (Glenn, 2026-08-27).
 *
 * "Turn on a gathering and all skills grinding beat for both, in addition to
 * leaving some xp grinding still."
 *
 * Profession experience writes to its own per-skill ledger and never touches
 * character level, so every trade beat is a beat taken from the only number
 * the grind is measured in. That is why nothing drove these until now, and it
 * is why the cadence matters more than the mechanism: one beat in sixteen is
 * about six percent of the hunt, which buys a steady climb in the trades
 * while leaving the levelling essentially where it is.
 *
 * The world's own numbers, read from the catalogue rather than guessed
 * (deploy/world/professions-catalogue.mjs): a copper seam is 25 xp a swing
 * with 8 charges and a 90-second refill, an iron seam 42 with 6 and 120s. So
 * a node standing beside a fight is worth stooping for, and one across a
 * maze is not - which is the whole reason this beat only ever looks at what
 * is ALREADY in the room.
 */
/**
 * ONE BEAT IN EIGHT, and the two numbers before it were both wrong.
 *
 * It was 16, then 0 (off), then 1. Setting it to 1 was mine and it was a live
 * regression: both bodies stopped fighting. Measured on the running world,
 * fifteen consecutive decisions per body:
 *
 *   13 of 15 beats were `gather_nearby`; 1 attack in twenty minutes.
 *
 * THE ERROR IN THE REASONING, written down because it was persuasive. I
 * argued the offer is free, because `gatherNearby` filters an observation
 * already in hand and calls the world only when a node is genuinely in
 * range. That is true, and it is not the cost that matters. The offer still
 * CONSUMES THE BEAT: the round returns it as this tick's intent, so the body
 * does not swing, walk or loot. Free of network is not free of time, and the
 * grind is measured in beats.
 *
 * The proximity measurement that argued for a higher rate still stands - the
 * bodies are within reach of a node about 0.3% of the time, so a rare offer
 * rarely coincides. But the answer to that is not to spend every beat
 * looking; a body that never fights earns neither experience nor coin, and
 * profession experience does not touch character level at all.
 *
 * Eight is a compromise chosen to be cheap rather than optimal: one beat in
 * eight, only in FIELDS, only when nothing is biting. Raise it if the ledger
 * printed every tenth offer shows charges being taken.
 */
const GATHER_EVERY_N_BEATS = 8;
/**
 * TWENTY TILES, because twelve was measured missing the ore by two.
 *
 * Within ninety seconds of the ore gaining its own march anchor, BOTH bodies
 * were logged at tile (89,157). `iron ore` is at (90,171) and `copper ore` at
 * (91,174) - fourteen and fifteen tiles away. The march had put them on the
 * ore's doorstep and the beat looked twelve tiles and saw nothing.
 *
 * The radius was never measured against anything; it was a guess made when
 * the beat was believed to be incapable of walking. It can walk now - it
 * legs the approach in clamped hops and reports "on the way" instead of
 * claiming an empty room - so the number should be set by how close the
 * march actually gets, and the march gets to fourteen.
 *
 * Not larger: the beat still must not become a journey, and a node twenty
 * tiles off is three or four hops. The wide sweep on a trip keeps its own,
 * much bigger, reach.
 */
const GATHER_WITHIN_TILES = 20;

/**
 * SEAMS WE CAN WALK TO, in the room the bodies already fight in.
 *
 * Glenn, 2026-08-27: "I see fishing rods and other tools and no progress with
 * skills. Seems like you're completely wrong and they are broken."
 *
 * He was right, and the tools were never the problem. The lifetime profession
 * ledger is ZERO charges. The reason, measured across every captured log:
 *
 *   Lord Gemma  9,718 samples in millers-stair, within 12 tiles of ore 0.28%
 *   Sir Qwen   11,242 samples in millers-stair, within 12 tiles of ore 0.02%
 *
 * The ore is at tile (90,171) and (91,174). They fight between (13,43) and
 * (60,55). Both have stood ON the copper ore - twice, by accident, dragged
 * there mid-chase. Nothing about buying a pickaxe changes that number, and
 * making the trade beat fire more often did not either: the offer now runs
 * every beat and still answers "nothing of ours", because there is nothing
 * of ours where they stand.
 *
 * So the body has to be taken to the seam deliberately, and this is the
 * third attempt at that. The two before it aimed a single long `arena_move_to`
 * at the ore and it stalled - `go_to 5792,10976 -> did not move from tile
 * 85,25`, five times. THIS ONE USES THE MECHANISM THAT DEMONSTRABLY WORKS
 * INSTEAD: the bay march's clamped 400px hops, which crossed this room and
 * put both bodies on tile (89,157) within ninety seconds of the ore getting
 * its own anchor. One long walk fails; twenty short ones do not.
 *
 * Pixel centres, not tiles, because that is what `go_to` takes: tile n at
 * 64px is n*64+32.
 */
const SEAMS_UNDERFOOT: Record<string, ReadonlyArray<{ x: number; y: number; skill: string }>> = {
  [STAIR]: [
    { x: 5792, y: 10976, skill: 'mining' },
    { x: 5856, y: 11168, skill: 'mining' }
  ]
};
/** One deliberate walk to the seam every twenty minutes, per body. */
const SEAM_WALK_EVERY_MS = 5 * 60 * 1000;
/**
 * THE ONE FLOOR BOTH ERRANDS STAND ON.
 *
 * Named rather than aliased. The seam walk and the fishing trip want the
 * same number for the same reason, but tying one constant to the other
 * means a future tune of the seam for the stair's own sake silently
 * retunes fishing in town, and nothing would catch the drift.
 */
const NO_HEALING_HP_FLOOR = 45;

/**
 * THE HEALTH FLOOR FOR ANY ERRAND, IN A WORLD WITH NO HEALING.
 *
 * Measured 2026-09-02: with the shrine's blessing refusing to mend (the
 * server falls through to the ordinary talker) and the inn's cask still
 * unreachable behind #505, NOTHING in this world heals these two. Lord Gemma
 * sat at 28% and Sir Qwen at 46% for a whole run, so `whole` was false on
 * every beat and this errand fired ZERO times - 485 gather attempts, "0 of
 * 130 offers found something of ours", and mining frozen at the 650xp it
 * reached on 08-31.
 *
 * A 75% gate is right when healing exists. When it does not, it is a gate
 * that never opens, and the cost is the whole profession ladder. The walk is
 * through quiet ground and still aborts at FORAGE_ABORT_HP_PCT (40), so the
 * body is protected by the abort rather than by never setting out.
 */
const SEAM_MIN_HP_PCT = NO_HEALING_HP_FLOOR;
/**
 * THE DELIBERATE WALK IS OFF, on its own ledger (2026-08-27).
 *
 * It works - it announced itself, hopped, and closed 142 tiles to 105 in
 * thirty beats. It has never produced a charge, and while it walked, Sir
 * Qwen earned NOTHING for twenty-one minutes against a clean rate of 3.4 to
 * 4.3 kills a minute. It re-arms every twenty minutes, so that is a standing
 * tax on the only number the grind is measured in.
 *
 * The rule this file keeps having to relearn: judge a beat by whether it
 * PAYS, not by whether it works. Eleven correct fixes once went into an
 * errand whose lifetime ledger was zero.
 *
 * It is off rather than deleted because the cheaper idea below has to be
 * tried first: the bodies already pass within fourteen tiles of the ore on
 * every town trip, and the offer that would catch it was gated to one leg.
 * If passing-by never pays either, this is the next thing to try, and its
 * tests still hold it upright.
 */
const SEAM_WALK_ON = true;
/**
 * And a hard cap on it, set from the walk's OWN measured rate rather than
 * from the hop size.
 *
 * The first live run, logged every ten beats:
 *
 *   [seam] 142 tiles to the seam (beat 10 of 90)
 *   [seam] 137 tiles to the seam (beat 20 of 90)
 *   [seam] 105 tiles to the seam (beat 30 of 90)
 *
 * Thirty-seven tiles in thirty beats, so roughly one and a quarter tiles a
 * beat - not the six a 400px hop would suggest, because the body moves a
 * median 186px per `go_to` and fights interrupt. At that rate the remaining
 * 105 tiles need about eighty-five more beats and the walk would have died
 * at ninety with thirty tiles to go: all of the cost and none of the charge.
 *
 * 250 covers a full crossing twice over. The errand still cannot run away
 * with the evening, because it fires once every twenty minutes and any real
 * trouble - a spent body, a lost tool - ends it early.
 */
const SEAM_WALK_MAX_BEATS = 250;
/**
 * HOW MANY BEATS OF NO PROGRESS BEFORE THE WALK IS ABANDONED.
 *
 * Measured 2026-08-31, three times in one afternoon: Sir Qwen closed to 105
 * tiles of the seam, wedged at tile (55,73), and asked for the SAME step -
 * `go_to 3928,5080` - seventy-nine times. The server answered "ok - got there"
 * to every one and he never moved. The errand had no progress check, so it
 * spent its whole 250-beat budget - about twenty-nine minutes - standing still,
 * and a character doing nothing for half an hour is how the user noticed.
 *
 * This existed once as `seamBest`/`seamStuck` and I deleted both on 2026-08-27
 * as dead constants. They WERE dead - never wired to anything - and deleting
 * them removed the only guard that would have caught this. Wired in now.
 *
 * Twelve beats is about ninety seconds: long enough to survive a detour round
 * an obstacle, short enough that a wedge costs a minute rather than half an
 * hour.
 */
/**
 * How near the seam the deliberate walk gets before it hands the last step to
 * the trade beat. Three tiles, not twenty: at twenty the node is not in the
 * observation, and the hand-off branch returns a gather instead of a step, so
 * the body can never close the remaining distance. See the arrival branch.
 */
const SEAM_ARRIVAL_TILES = 3;
/**
 * TWELVE WAS RIGHT UNTIL THE DETOUR EXISTED, and then it was strangling it.
 *
 * The note above chose twelve as "long enough to survive a detour round an
 * obstacle" - written when no detour was implemented, so nothing was spending
 * those beats. Now one is: detouring does not shorten the distance to the
 * seam, so every sidestep counts as another beat of no progress, and the
 * guard fired mid-detour. Measured 2026-09-02 immediately after shipping it:
 * "[seam] gave up the walk after 15 beats - no progress in 12 beats". The
 * body got three beats of straight walking and nine of detour - not one full
 * attempt at each side.
 *
 * Twenty was chosen when the walk still detoured geometrically, to leave room
 * for a run each way. The detour is gone - the grid search replaced it - but
 * the number stays: a routed walk can still spend beats getting round a long
 * obstruction, and twenty ends a hopeless one in about two and a half minutes
 * rather than the 250-beat budget's half hour.
 */
const SEAM_STALL_BEATS = 20;
/** A step has to beat the best distance by this much to count as progress. */
const SEAM_PROGRESS_PX = 48;

/**
 * How many DISTINCT tiles a body may occupy over its last moves before the
 * ladder calls it pacing rather than travelling. Two, over eight moves: a
 * body going anywhere visits more than two tiles in eight, and a body
 * trading between two corners visits exactly two however long it does it.
 */
/**
 * ONE TOOL PER GATHERING TRADE, BOUGHT ONCE (Glenn, 2026-08-27:
 * "well have them get the tools they need once").
 *
 * Every gathering node in the world declares a `toolFamily` and a
 * `toolPower >= 1` (deploy/world/professions-catalogue.mjs), and neither body
 * owned a single tool - so the trade beat found its seam every time and was
 * refused TOOL_MISSING every time. The beat was scaffolding until this.
 *
 * Toma keeps the three starters at the trading post, and they are cheap
 * against purses over a million: `seed-professions.mjs` gives him exactly
 * `chipped_pickaxe`, `fishing_rod` and `foraging_knife`.
 *
 * THE PICKAXE CANNOT COST HIM THE GREATSWORD, which was the standing worry.
 * `tool()` is built on `material()`, so a tool is `type: 'material'` - it is
 * CARRIED, never equipped, and nothing about owning one touches a weapon
 * slot.
 *
 * `buy` is the shop key; `match` is what a carried name looks like once the
 * world has written it down, the same split the gear ladder uses.
 */
/**
 * A DELIBERATE TRIP TO THE SEAM, because they never pass one (2026-08-27).
 *
 * The trade beat only works a node within twelve tiles, deliberately - an
 * earlier design that walked to ore was killed in review for aiming 190
 * tiles across a maze. Then the beat shipped and the obvious question was
 * measured rather than assumed:
 *
 *   Sir Qwen, 8,609 position samples: within 12 tiles of a seam ONCE. 0.0%.
 *   Lord Gemma, 7,965 samples: 17. 0.2%. Mean distance ~150 tiles.
 *
 * So an opportunistic beat yields nothing here, ever. That is not a radius
 * to widen - it is a place they never go. `salt_vein_copper` and
 * `salt_vein_iron` sit at the FOOT of Miller's Stair while both royals fight
 * its head, and the world put 25 and 42 experience a charge on them.
 *
 * The trip is therefore explicit, bounded, and rare: once an hour at most,
 * in the room they are already in, ended by the seam running dry or by a
 * cap. Between trips nothing changes - the grind is untouched, which is the
 * standing order ("in addition to leaving some xp grinding still").
 */
/**
 * THE SAFEST ROOM WITH A NODE WE CAN WORK (Glenn, 2026-08-27).
 *
 * `oathstone` is frontier level 18 and two supervised trips ended with a body
 * stripped from full health on its arrival tile. `millrace-ford` is level
 * **10** - the lowest of any room holding a gatherable - and carries
 * `ford_rod_fishing`, requiredLevel 1, tool `fishing_rod`, which Toma sells
 * for 45 copper.
 *
 * Fishing is the doorway to the only healing a Magus can ever own: cooked
 * fish restores 12 hp at cooking 1 and 38 at the top of the table, and every
 * cooked output writes `statsBase/hp`. Lord Gemma has no heal spell and
 * `lifeTap` costs him 15 hp to make 15 mp, which is why he lives at 43% below
 * a quarter health while Sir Qwen never drops there at all.
 */
// THE POND AT HOME, NOT THE FORD ACROSS THE WORLD.
//
// This was `millrace-ford` from 2026-08-27, chosen when it was the only
// water the harness knew. The world has since put an easier pond in town:
// `valley_spotted_fishing` sits at tile (60,34) of `the-valley`, is fishing
// level 1, yields `spotted_fish` at 24 xp a charge, holds 10 charges and
// refills in 75 seconds. Both characters are fishing level 1 and both have
// carried a rod since 08-27.
//
// Town is also a road these bodies already walk: they cross `the-valley`
// between the stair door and the inn door on every town trip, 133 of them
// in one day. The ford is a journey; the pond is a detour.
//
// THE POND IS DAY-GATED. `fishingNodeAvailability` marks it DAY on a
// 3600s/3600s cycle, so it opens in odd UTC hours. A night attempt answers
// WRONG_TIME, which this harness reads as an ordinary refusal: the node is
// shunned for 75 seconds and the visit counts as dry against the trip's cap.
// A first arrival at the wrong hour therefore costs the whole errand.
const FORAGE_ROOM = TOWN;

/** At most one seam trip an hour, per body. */
const MINE_EVERY_MS = 60 * 60 * 1000;
/**
 * Set out only from a body that can take the arrival tile. Three quarters
 * rather than full, so a trip is possible at all - these two live in the
 * 20-80% band most of the time - but far enough from the floor that a
 * Stoneclaw meeting them at the door is a fight and not an execution.
 */
// THE SAME FLOOR THE SEAM WALK USES, AND FOR THE SAME REASON.
//
// 75 is right when healing exists. Nothing in this world heals these two -
// the shrine's blessing falls through to the ordinary talker and the inn's
// cask is unreachable behind #505 - so the knight lives at 30-49%. Measured
// 2026-09-04 over one day in the stair: 2,235 observations at 30-39%, 999 at
// 40-49%, and none above. A 75% gate on that distribution is a gate that
// never opens, and this errand fired zero times because of it.
//
// The walk is through town, which is the quietest ground in the world, and
// it still aborts at FORAGE_ABORT_HP_PCT (40). The body is protected by the
// abort rather than by never setting out. This is the argument already
// written out for SEAM_MIN_HP_PCT above, applied to the errand next to it.
const FORAGE_MIN_HP_PCT = NO_HEALING_HP_FLOOR;
/** And turn back if the road takes it out of them before they arrive. */
const FORAGE_ABORT_HP_PCT = 40;
/**
 * Give up a trip that cannot get there, rather than walking for ever.
 *
 * FORTY WAS ARITHMETICALLY IMPOSSIBLE (2026-08-27, measured before it wasted
 * a night). The vein sits ~150 tiles from where they fight; a beat moves at
 * most 400px, which is 6.25 tiles on this 64px map, so even a straight line
 * needs 24 beats - and this maze routes at roughly three times the straight
 * distance, which is exactly the inflation `Actions.circuitous()` was built
 * to measure. Forty could not arrive, so the trip would have timed out every
 * hour for ever while looking like it was trying.
 *
 * A hundred is the walk this actually takes, and the trip still ends early on
 * arrival, on an empty vein, or the moment anything attacks.
 */
const SEAM_WALK_BEATS = 400;
/** Beats without getting nearer before a trip is abandoned. */
const SEAM_STUCK_BEATS = 25;

const TOOL_ROOM = 'the-valley-trading-post';
const TOOL_KEEPER = 'Toma';
const TOOL_FOR: Record<string, { buy: string; match: string }> = {
  mining: { buy: 'chipped_pickaxe', match: 'pickaxe' },
  foraging: { buy: 'foraging_knife', match: 'foraging knife' },
  fishing: { buy: 'fishing_rod', match: 'fishing rod' }
};

const PACE_BUCKET_PX = 32;
/** Firings inside this window count toward the march; older ones lapse. */
const PACE_WINDOW_MS = 5 * 60 * 1000;
const TWO_CYCLE_WINDOW = 8;
const TWO_CYCLE_TILES = 2;
const BAY_MISSES_BEFORE_SKIP = 3;
const BAY_SKIP_MS = 4 * 60 * 1000;
/** Long enough that a cask run cannot become the town shuttle again. */
const RECOVERY_COOLDOWN_MS = 8 * 60_000;
/**
 * OFF UNTIL THE LAST FOUR TILES WORK. Do not turn this on to "try it".
 *
 * The errand itself is right and it fires correctly - measured 2026-08-25,
 * both royals walked to the inn together on the first pass, which is more
 * than the `resting` leg had managed in 900 rounds. What does not work is the
 * end of it: neither can cross the last four tiles to the cask at inn tile
 * (8,2). EIGHT approach tiles were tried and every one came back "still
 * short", with `arena_check_path` answering PATH_FOUND for tiles the body
 * then refused to walk to. Upstream PRs #505 and #539 describe exactly that
 * - `arena_move_to` making zero progress toward a change-point tile while
 * every check says it should work - and both were still open at the time of
 * writing. Filtering `D` tiles out of the destinations (walkEndsHere) cut the
 * candidates from 24 to 17 and did not fix it, so that is not the whole
 * cause either.
 *
 * What it cost while on: both bodies parked in the inn at tile (11,5) with
 * ZERO attack verdicts, having stopped hunting to queue for a drink they
 * cannot buy. Empty pools are bad; not fighting at all is worse. A cure that
 * cannot be reached must not be attempted, because the walk is not free.
 *
 * Turn this on when a cask run ends in `[ale] ... arrived` and a pool that
 * actually refills - not before.
 */
const RECOVERY_TRIPS_WORK = false;

// end up copper, which is the only unit coinsNow is ever in.
// Bows first for EVERYONE (user doctrine): the grind is fought at bow
// range by both royals - bowShot is in both kits and costs no mana.
// The class blades stay on the ladder as DUEL steel: bought when
// affordable, carried always, drawn only when a match forms.
export const SWORD_GEAR: GearRung[] = [
  // BLADE BEFORE BOW at the top rung (user, 2026-08-16: "Buy the Knight
  // Greatblade first then Depths Plate for Sir Qwen"). Both are L35 and
  // openRungs() offers the whole top tier, so whichever is listed first is
  // what the counter is asked for first - and the bow used to be. That is
  // the same complaint as "he still has bow on": the ladder kept buying him
  // one. The greatblade is also the stronger item outright, +40 atk against
  // the warbow's +34 (deploy/world/item-specs/combat-gear.mjs), and cheaper
  // at 180 coins to the bow's 190.
  // ONE rung at L35, not two (user, 2026-08-16: "make sure we have the right
  // best gear to buy in the right order for each"). openRungs() returns
  // EVERY rung at the top level and unownedRungs() walks them all, so a tier
  // holding both the blade and the bow meant buying the greatblade and then
  // spending another 19,000 copper on a warbow this knight should never
  // carry - money owed to the 21,000-copper depths plate. The bow is gone
  // from his ladder entirely; the L15 ash longbow below is left alone
  // because openRungs() only ever offers the top tier, so it is never bought
  // at this level.
  { buy: 'knight_greatblade', match: 'knight greatblade', level: 35, price: inCopper(180) },
  { buy: 'ash_longbow', match: 'ash longbow', level: 15, price: inCopper(50) },
  { buy: 'steel_longsword', match: 'steel longsword', level: 15, price: inCopper(45) },
  { buy: 'wide_blade', match: 'wide blade', level: 0, price: inCopper(26) },
  { buy: 'twin_axe', match: 'twin axe', level: 0, price: inCopper(22) },
  { buy: 'stone_maul', match: 'stone maul', level: 0, price: inCopper(18) },
  { buy: 'crescent_axe', match: 'crescent axe', level: 0, price: inCopper(14) },
  { buy: 'curved_sabre', match: 'curved sabre', level: 0, price: inCopper(12) },
  { buy: 'iron_sword', match: 'iron sword', level: 0, price: inCopper(8) },
  { buy: 'axe', match: 'axe', level: 0, price: inCopper(5) }
];
// The Magus carries a BOW (user doctrine 2026-08-13): bowShot is in his
// kit, costs no mana, and reaches - the pull can never run dry the way
// fireballs do. Foci scale the fireball but a focus cannot pull on an
// empty pool; the bow outranks them. Steel only below L15.
export const CASTER_GEAR: GearRung[] = [
  // FOCUS BEFORE BOW at the top rung (user, 2026-08-16: "He's a mage and
  // supposed to be getting highest magic attack weapon right?"). This
  // reverses the bow doctrine noted above, and deliberately: that doctrine
  // was written when a focus added nothing to spell power, and the L35 tier
  // changed it. The crystal focus is +40 mAtk - the highest magic attack in
  // the game - against the warbow's +34 physical atk, which a caster's
  // stat line barely uses (deploy/world/item-specs/combat-gear.mjs). Both
  // are L35 and both cost 190, and openRungs() offers the whole top tier,
  // so whichever is listed first is simply what gets bought.
  // ONE rung at L35 here too, for the same reason as SWORD_GEAR: buying the
  // focus and then the warbow as well would cost 19,000 copper that the
  // 21,000-copper sepulchral vestment needs. He keeps the ash longbow he
  // already owns, so the bow doctrine is not lost - it is simply not worth a
  // second L35 purchase when the focus is what his spell power scales on.
  { buy: 'crystal_focus', match: 'crystal focus', level: 35, price: inCopper(190) },
  { buy: 'ash_longbow', match: 'ash longbow', level: 15, price: inCopper(50) },
  { buy: 'ember_focus', match: 'ember focus', level: 15, price: inCopper(50) },
  { buy: 'wide_blade', match: 'wide blade', level: 0, price: inCopper(26) },
  { buy: 'twin_axe', match: 'twin axe', level: 0, price: inCopper(22) },
  { buy: 'stone_maul', match: 'stone maul', level: 0, price: inCopper(18) },
  { buy: 'crescent_axe', match: 'crescent axe', level: 0, price: inCopper(14) },
  { buy: 'curved_sabre', match: 'curved sabre', level: 0, price: inCopper(12) },
  { buy: 'iron_sword', match: 'iron sword', level: 0, price: inCopper(8) },
  { buy: 'axe', match: 'axe', level: 0, price: inCopper(5) }
];
export const SWORD_ARMOR: GearRung[] = [
  { buy: 'depths_plate', match: 'depths plate', level: 35, price: inCopper(210) },
  { buy: 'traveler_mail', match: 'traveler mail', level: 15, price: inCopper(55) }
];
export const CASTER_ARMOR: GearRung[] = [
  { buy: 'sepulchral_vestment', match: 'sepulchral vestment', level: 35, price: inCopper(210) },
  { buy: 'spidersilk_robes', match: 'spidersilk robes', level: 15, price: inCopper(55) }
];
const SHIELD_NAME = 'wooden shield';

/**
 * The middle of each huntable room, in pixels, for the march that follows a
 * played-out sweep. Taken from each map's own declared size in
 * world-content/maps: the forest is 145x145 tiles, the grassland 30x20, the
 * shore 60x40, all at 32px a tile.
 * A room absent from here has no march - see the needAdvance branch. That
 * is deliberate: the previous single hardcoded centre was the forest's, and
 * aiming it at a room a fifth the size walked the body into a corner it was
 * not allowed to fight in. Add a room here when it becomes huntable, and
 * take the number from its map rather than from the room next door.
 */
const HEARTS: Record<string, { x: number; y: number }> = {
  [FIELD]: { x: 72 * 32 + 16, y: 72 * 32 + 16 },
  [GRASSLAND]: { x: 15 * 32, y: 10 * 32 },
  [SHORE]: { x: 30 * 32, y: 20 * 32 }
};

/**
 * Where the spawns actually are, per room, in pixels - for rooms where one
 * heart is the wrong shape of answer.
 *
 * A heart works in an open field: walk at the middle and you walk into
 * enemies. Miller's Stair is a Voronoi maze, 20,245 of its 33,792 tiles wall,
 * and its 30 respawn patches are scattered corner to corner. Marching at the
 * centre there aims at a point that is itself a wall (checked: the centroid
 * of all 30 patches lands on one) and crosses the whole map to reach it.
 *
 * So the stair gets a list instead, and the march picks the patch nearest the
 * body, stepping outward through the list as the near ones are cleared. Each
 * coordinate is the WALKABLE tile closest to its patch's centroid, taken from
 * the map's own respawn-area and collision layers - not the centroid itself,
 * for the reason above.
 */
const BAYS: Record<string, Array<{ x: number; y: number }>> = {
  [STAIR]: [
    { x: 10976, y: 288 }, { x: 288, y: 352 }, { x: 5600, y: 544 },
    { x: 8288, y: 608 }, { x: 2720, y: 800 }, { x: 10080, y: 1696 },
    { x: 11680, y: 2592 }, { x: 864, y: 2848 }, { x: 9376, y: 3360 },
    { x: 3872, y: 3552 }, { x: 6560, y: 3552 }, { x: 992, y: 5600 },
    { x: 11936, y: 5728 }, { x: 6624, y: 5792 }, { x: 9056, y: 5792 },
    { x: 4448, y: 5856 }, { x: 10656, y: 6816 }, { x: 1888, y: 7456 },
    { x: 3680, y: 7904 }, { x: 416, y: 8480 }, { x: 6688, y: 8480 },
    { x: 9760, y: 8544 }, { x: 11808, y: 8544 }, { x: 5024, y: 9504 },
    { x: 2848, y: 9696 }, { x: 1376, y: 10656 }, { x: 7200, y: 10784 },
    { x: 12000, y: 10912 }, { x: 4256, y: 10976 }, { x: 9632, y: 10976 },
    // THE ORE'S OWN TILE (2026-08-27). Glenn: "I see fishing rods and other
    // tools and no progress with skills."
    //
    // He is right, and this is the reason. `iron ore` sits at tile (90,171)
    // and `copper ore` at (91,174); both bodies fight around (13,43) to
    // (60,55). Measured across every captured log in this room:
    //
    //   Lord Gemma  9,718 samples   within 12 tiles of ore:  27  (0.28%)
    //   Sir Qwen   11,242 samples   within 12 tiles of ore:   2  (0.02%)
    //
    // Offering the trade beat more often cannot fix that, and did not: the
    // offer now fires every beat and still answers "nothing of ours",
    // because there is nothing of ours where they stand. A tool they cannot
    // carry to a seam is a tool that earns nothing, which is the whole of
    // the profession ledger to date - zero charges, ever.
    //
    // The two nearest bays already sit on the ore's own row, at x 4256 and
    // 9632 against its 5792, which is how Sir Qwen came to be logged at tile
    // (94,174) - three tiles off the copper. They bracket it and miss it: 24
    // tiles west and 60 east, both outside the twelve-tile reach.
    //
    // MARCHING IS THE MECHANISM THAT WORKS. A single long `arena_move_to`
    // stalls (agentArena#573), but the bay march walks in 400px hops and
    // demonstrably crosses this room. The one recorded attempt to walk the
    // ore directly - `go_to 5792,10976 -> did not move from tile 85,25` - is
    // this exact pixel, and it predates both the tile-size race fix in
    // `perform()` and the `/too[ _]far/i` blacklist fix. It has never been
    // retried since either landed, so "the ore is unreachable" is an
    // untested belief, not a measurement.
    { x: 5792, y: 10976 }
  ]
};

/** Scene ids the feed uses, mapped to the door labels the world answers to. */
/**
 * The frontier's own doors, folded into NEXT_DOOR once, at module load.
 *
 * Written as a loop rather than sixty hand-typed rows because the shape is
 * mechanical: from any room on a path, every destination further out is the
 * `out` door and everything else is the `back` door. Hand-typing that is how
 * a table drifts from the map it claims to describe.
 *
 * The valley's four heads are seeded first: a body in the valley asked for
 * any room on a path should walk at that path's first door, not at the stair.
 */
{
  const HEADS: Record<string, string> = {
    west: 'millrace-approach', south: 'oathstone',
    east: 'sinkfoot-crossing', north: STAIR
  };
  const town = NEXT_DOOR[TOWN];
  const stair = NEXT_DOOR[STAIR];
  for (const stop of FRONTIER) {
    town[stop.room] = HEADS[stop.path];
    // From the stair, everything off the north path is back down through the
    // valley; the north path itself continues upward through its own gate.
    stair[stop.room] = 'north' === stop.path ? 'widows-watch' : TOWN;
  }
  town['millrace-approach'] = 'millrace-approach';
  stair['millrace-approach'] = TOWN;

  // Then every frontier room's own two doors.
  for (const [room, route] of Object.entries(FRONTIER_ROUTE)) {
    const row: Record<string, string> = NEXT_DOOR[room] ?? (NEXT_DOOR[room] = {});
    row[TOWN] = route.back;
    row[STAIR] = route.back;
    for (const stop of FRONTIER) {
      if (stop.room === room) {
        continue;
      }
      // Same path and further out means onward; anything else is reached by
      // walking back to the valley and taking a different road entirely.
      const here = FRONTIER.find((s) => s.room === room);
      row[stop.room] = here && stop.path === here.path && stop.level > here.level
        ? route.out
        : route.back;
    }
    row['millrace-approach'] = route.back;
  }
}

const DOOR_LABELS: Record<string, string> = {
  'reldens-house-1': "Barnaby's inn",
  // Best guesses for the two never-visited rooms; the door-hint learner
  // corrects a wrong ask from the refusal's own list of doors.
  'reldens-house-2': 'house 2',
  'reldens-forest': 'the forest'
};

/**
 * The one door a body standing in `scene` should actually ask for to make
 * progress toward `destination`, however many hops away it really is -
 * NOT the destination's own name, which only exists as a door label in the
 * room directly beside it. Exported (2026-08-15) because a caller outside
 * this class - the cross-room rescue in npc.ts - was asking `use_door` for
 * the raw destination scene id directly (e.g. "arena-crypt" from town),
 * which is not a door label anything answers to and just refuses. This is
 * the exact lookup stepToward() already used correctly; giving it a name
 * of its own means the two paths cannot silently diverge again.
 */
export function nextDoorToward(scene: string, destination: string): string {
  return NEXT_DOOR[scene]?.[destination] ?? DOOR_LABELS[destination] ?? TOWN;
}

// The inn came across with a name (and it is the ONLY room in the valley
// with mechanics: an ale cask at 100 copper restores all mana, a bed at 300
// restores all health - upstream's place-inn-services.mjs). The east house
// did not survive as a place; only its chest did, and that went to the
// grange, so GRANGE names where the chest is rather than claiming the grange
// is the house's successor - upstream's own place-registry still maps
// house-east at the retired room, so nothing has declared a rename.
const INN = 'the-valley-inn';
const GRANGE = 'the-valley-grange';
/**
 * THE SHRINE ERRAND (2026-08-27). Ossian Rell's dialog carries a `heal`
 * option whose server side (agentArena's shrine.js) is restoreConsumableStats:
 * hp, mp and stamina to full, FREE, gated only on standing close enough. The
 * room is 10x7, arrival from the valley is tile (4,4) and Ossian stands at
 * (5,3) - one diagonal step, none of the long-walk failure modes.
 *
 * READ FROM SOURCE, NEVER YET SEEN. No body has ever entered this room, so
 * everything above is the server's code, not observed behaviour. The action
 * side (takeBlessing() in actions.ts) therefore discovers the dialog option
 * from Ossian's actual reply and fails loudly when nothing reads as healing;
 * nothing anywhere assumes the option's label or index.
 *
 * Why it exists: Lord Gemma has no heal spell, no potions the ban allows him
 * to buy, and lifeTap costs him the very blood he is short of - he spends a
 * large share of his life under 25% hp and dies for it. A free full restore
 * two doors from town is the difference between that and a working caster.
 *
 * WHAT THIS IS NOT: a retreat. The standing order is fight to the death and
 * flee_below_hp_percent stays null on purpose. The errand fires only when
 * the fighting has STOPPED (a couple of calm beats, not a gap between
 * swings) and the body cannot mend itself by any means it already has.
 */
const SHRINE = 'the-valley-shrine';
/** Below this the body counts as bleeding out. Deliberately under the 45
 *  that drinks a carried potion: a body with a bottle drinks where it
 *  stands and never reaches this errand at all. */
const SHRINE_HP_PCT = 40;
/** No second trip inside this window, however spent the body reads - a
 *  blessing that silently did nothing must not become a corridor loop.
 *  TEN minutes, priced against the alternative it replaces: Lord Gemma
 *  dies about 1.3 times an hour and a death is a free full restore in
 *  about 2m20s. A full shrine round trip is ~6 acted beats (two doors
 *  out, the ask, a beat or two for the stats to read back, two doors
 *  home), ~2-4 minutes wall clock - about the price of one death, paid
 *  without dying (a death also spills cargo and has cost ~280 coins,
 *  measured). At this cooldown the errand can never outspend the deaths
 *  it replaces, and the SHRINE_FAILED_TRIPS latch below caps the
 *  worst case - a blessing that silently does nothing - at two trips
 *  per run, ever. */
const SHRINE_COOLDOWN_MS = 10 * 60_000;
/** Beats the whole walk may take before the errand gives up. The route is
 *  two doors from the stair; sixty was the chest run's number for routes
 *  that never resolve, and this one is shorter. */
const SHRINE_ROUTE_TICKS = 40;
/** Asks at Ossian before the trip is called failed. One ask normally does
 *  the walk-talk-choose in a single beat; the budget covers a slow reach
 *  and the beat or two the restored stats take to read back. */
const SHRINE_ASKS = 6;
/** Failed trips in a row before the shrine is written off for the run. */
const SHRINE_FAILED_TRIPS = 2;
/** Calm beats required before the errand may FIRE: aggressors must have
 *  read zero this many beats running, so a lull mid-fight cannot start a
 *  walk the doctrine forbids. */
const SHRINE_CALM_TICKS = 2;
const EAST_HOUSE = 'reldens-house-2';
const NORTH_FOREST = 'reldens-forest';

/**
 * The six Old Jerr caches (2026-08-14 server update): world chests whose
 * grant is once PER CHARACTER (agent_arena_treasure_claims keys on
 * player_id), so each royal claims a full set - Guy having looted his
 * changes nothing. These are the ONLY boots, gauntlets and helmets in
 * the game outside two elite-region reliquaries; none of it is sold.
 * Ownership is read off the live pack, so a claimed cache never pulls a
 * march again. Ordered close-to-far. The gilded chest below the deep
 * throne is deliberately absent: it pays a book, not gear, and sits past
 * the crypt.
 */
// BACK ON (2026-08-16), because the reason it was switched off is fixed.
// It ran away earlier that day - fourteen open_chest attempts against two
// combat actions - and the cause was never the route: ownsGear() reads the
// carried pack, and BOTH ways of reading that pack were returning nothing
// on a thousand-item bag, because the gateway's reply cap cut them off and
// the salvage rebuilt objects and players but not items. So a claimed cache
// never registered as claimed and the walk repeated for ever.
// The salvage now recovers item rows too, proven against a real truncated
// reply: 174 items out of a body that would not parse at all, coins and
// treasure gear included. Ownership is answerable again, so a claimed chest
// ends its own errand the way it was always meant to.
// NOTE these are not locked and no key opens them - agentArena #114
// confirms no door or chest in the world requires one, and the three key
// items are vendor trash worth 300 apiece. The chests are simply walked to
// and opened; what stopped it was blindness, not a lock.
// Still excluded: the two indoor caches, which need per-floor routing this
// harness does not have. See PILGRIMAGE_CACHES.
// OFF - the boots are in hand (user, 2026-08-16: "Sir Qwen has the boots.
// drop the treasure now and focus on the grind"). The one cache this was
// narrowed to has paid out, so the route has nothing left to fetch and the
// grind gets every beat.
// Everything needed to turn it back on survives: PILGRIMAGE_CACHES, the
// per-character treasureRun flag, and openChest()'s arena_choose claim. The
// remaining rewards are the forest grips and the shore saltguard, and they
// matter because nothing purchasable fills the gauntlet or shield slots -
// see the gear note in the worklog.
const PILGRIMAGE_ON = false;
type TreasureCache = { room: string; title: string; match: string };
// REBUILT AGAINST THE NEW WORLD (2026-08-16), from upstream's own
// treasure-chests.generated.mjs and confirmed against what the live world
// reports standing in the room. Four of the six chests moved when their
// rooms were retired; the two arena chests did not move at all.
const TREASURE_CACHES: TreasureCache[] = [
  // Both outdoor chests were moved into the new town - live-confirmed in
  // `the-valley`'s object list at the tiles below. The grips in particular
  // were the one real detour on the old route (a trip to reldens-forest);
  // they are now underfoot in the room the characters already stand in.
  { room: TOWN, title: 'A Chest Under Fallen Branches', match: 'grips' },
  { room: TOWN, title: "A Child's Nailed-Shut Chest", match: 'cup helm' },
  { room: INN, title: 'A Smoke-Blackened Chest', match: 'blackened spoon' },
  { room: GRANGE, title: 'A Chest Beside the Kitchen Wall', match: 'house jack' },
  // These two stayed where they were, and both are in the arena half of the
  // world - unreachable while the valley road is sealed.
  { room: GRASSLAND, title: 'A Rush-Wrapped Chest', match: 'boots' },
  { room: SHORE, title: 'A Salt-Stiff Chest', match: 'saltguard' }
];
// Re-enabled 2026-08-15, widened same night to four of the six. Inn and
// East House still stay off - they sit on floors the room-level march
// cannot see, the original reason the whole pilgrimage was switched off,
// and that gap is still unfixed. Yard and North Forest are outdoor and
// single-floor: the Yard sits directly on the existing town<->field
// route, so it costs nothing extra, and North Forest ('reldens-forest')
// is a short, separate detour, never actually visited by this harness
// before tonight. Grassland and Shore were added while both were still
// closed zones, as a single walk-through to a chest rather than a hunting
// reopen. That framing has since been overtaken for the grassland, which
// is now a real hunting ground (see GRASSLAND_LEVEL) - which only makes
// its cache cheaper to reach, since the room is on the rotation anyway.
// The SHORE is still closed to hunting and still has no other door in
// (NEXT_DOOR routes every path to it through the grassland), so claiming
// its chest is the one case here that still means a deliberate trip into
// a room nothing else sends us to. Widen further as the indoor-routing
// gap closes.
// NARROWED to exactly three (user, 2026-08-16: "do we know exactly which
// chests have those items? If so, add only those to our current grind loop
// that has been working in grasslands"). We do know, from TREASURE_CACHES
// above: boots are the Rush-Wrapped Chest in the grassland, grips are the
// Chest Under Fallen Branches in the north forest, and the better shield is
// the Salt-Stiff Chest on the shore. Those are the only three wanted, so
// they are the only three routed.
// The YARD is dropped even though it is the cheapest stop on the map: a
// real arena_inventory dump confirms Sir Qwen already wears its
// borrowed_cup_helm, so routing to it buys nothing. Inn and East House stay
// out as before - though note the same dump shows he holds the Inn's
// jerrs_blackened_spoon, so the indoor caches have been claimed at some
// point and the routing gap may be narrower than this comment has assumed.
// Worth testing once the three below are in hand.
// Cost of the detour: the grassland chest is FREE - that room is the
// current grind ground and the body is standing in it already. Only the
// forest and shore are real trips, and each is once, for ever: a claimed
// chest ends its own errand as soon as ownership reads back, which is
// exactly what the inventory-salvage fix restored.
// WHEREVER THE BODY ALREADY STANDS. The boots chest was claimed from the
// grassland on 2026-08-16 with this filter reading `GRASSLAND === cache.room`,
// and that hardcoded room is exactly why rebuilding TREASURE_CACHES for the
// new world did nothing on its own: treasureTarget() walks THIS list, so
// moving the grips and cup-helm chests into `the-valley` filtered them out
// rather than in. A filter naming one room has to be edited every time the
// world moves, and the world just moved.
// The two rooms below are the ones a character is routinely standing in - the
// town it rests in and the field it hunts - so a chest in either costs no
// travel. The shore's saltguard stays out because it is a deliberate trip
// into a room nothing else sends us to, and it is unreachable anyway while
// the valley road is sealed.
const PILGRIMAGE_CACHES = TREASURE_CACHES.filter(
  (cache) => GRASSLAND === cache.room || TOWN === cache.room
);

const ATTACKS_PER_TRIP = 10;
/** What `heal` asks of the pool - skill-catalogue.mjs ownerConditions. */
const HEAL_MP = 2;

const REST_TICKS = 4;

export type RoundOptions = {
  /** Stay in this player's room; hunt only beside them. */
  partner?: string;
  /** Cast this instead of half the sword swings (use_skill). */
  spell?: string;
  /** Cast this on the partner whenever their health bar drops below 60%. */
  healSpell?: string;
  /** The reflex battle style set on entering each hunt (default close_up).
   *  long_range makes the body hurl bolts continuously - the warlock look,
   *  from behind the knight instead of beside him. */
  battleStyle?: string;
  /** One scene where battleStyle becomes long_range regardless of the
   *  option above (user order, 2026-08-15) - see the matching field on the
   *  character sheet in npc.ts for the full reasoning. Positioning only:
   *  the harness side (npc.ts) separately handles actually equipping a
   *  ranged weapon. */
  rangedInScene?: string;
  /** Walk the treasure route (PILGRIMAGE_CACHES) as well as grinding.
   *  Per character on purpose: a cache gives its reward once, so two bodies
   *  sent to the same box means the second one opens an empty chest. */
  treasureRun?: boolean;
  /**
   * Skills by the level that unlocks them, best used automatically: the
   * round reads the live level off the watch feed and casts the highest
   * rung it has earned. Levelling past a gate upgrades the arsenal with
   * no code change - the ladder IS the skill progression.
   */
  skillLadder?: Array<{ level: number; skill: string }>;
  /** Per-character: may this body travel to foraging ground? See npc.ts. */
  foragingTrip?: boolean;
  /**
   * Where the foraging trip goes. Defaults to FORAGE_ROOM, the town pond.
   * Named per character because the destination is a property of who is
   * fishing and not of the harness, and because a test that wants a
   * particular road must be able to say which road rather than inherit
   * whichever one production currently prefers.
   */
  forageRoom?: string;
  /** The trades this body is allowed to work. Empty or absent = none. */
  professions?: readonly string[];
  /** Conjured at rest to eat back health and magic (e.g. conjureFood). */
  feastSpell?: string;
  /** Cast on self when the mana pool runs dry and the body is healthy:
   *  the Magus trades blood for mana (lifeTap). */
  manaSpell?: string;
  /** hp% above which manaSpell may be cast. Default 70; see the tap gate. */
  tapAboveHpPercent?: number;
  /** Preferred strike while wounded: damage that heals the caster
   *  (drainLife) beats damage that does not. */
  drainSpell?: string;
  /**
   * 'follower' walks to the partner's room and side. 'leader' does not
   * chase, but waits at the hunting ground until the partner arrives -
   * two rules that together keep the pair in one place without the two
   * of them orbiting each other forever.
   */
  role?: 'leader' | 'follower';
  /** The weapon wish-ladder, best first (default SWORD_GEAR). */
  gearLadder?: GearRung[];
  /** The armour wish-ladder, best first (default none). */
  armorLadder?: GearRung[];
  /**
   * Where this character's counter actually is, and who stands behind it.
   *
   * Both of these are new on 2026-08-21 and they replace a hardcoded walk to
   * Gimly, who has been unreachable since the demo town was retired - which
   * is the whole reason a season of grinding could never spend a coin.
   *
   * The valley's counters are INSIDE buildings, which the old single-room
   * assumption had no way to express: the round stood in the valley asking
   * for a merchant who was behind a door. So the shop is named as a room to
   * cross into, and the keeper as somebody to walk to once inside.
   *
   * Nerys keeps the smithy (steel: blades and plate). Wren keeps the mage's
   * shop (wands, staffs, foci, and the potion drawer). Both are class_type 5
   * traders - read off deploy/world/place-npcs.mjs, where `shop: true` is
   * what sets that class - unlike Toma at the trading post, who is
   * conversation only and was the near-miss that cost us last session.
   */
  shopRoom?: string;
  /** The trader standing in shopRoom, walked to by name once inside. */
  shopKeeper?: string;
};

export class KnightsRound {
  private leg: Leg = 'outbound';
  private attacks = 0;
  private lootMisses = 0;
  /**
   * Successful pickups in a row on this sweep.
   *
   * `lootMisses` ends a sweep when the floor is BARE. Nothing ended one when
   * the floor was endless, and Miller's Stair is endless: every grub drops
   * coin, so every stoop succeeded, the miss counter never reached three, and
   * the leg never came back. Measured on Sir Qwen over a four-hour log -
   * **1,904 rounds in `looting` against 5 in `hunting`**, and not one in
   * `resting`, which is the only place the cask that refills his mana is
   * reachable from. He sat at 44% hp with 1 mp and 191,118 copper, two mana
   * short of a heal he has known since level 5.
   *
   * The trap is entered off "too far to hit", which is 97% of his swings
   * (attackShort reaches 0.8 tiles, grubs stand at 1.0-1.4), so this is not
   * a rare corner - it is his whole day.
   */
  private lootRun = 0;
  private preyIndex = 0;
  private potionIndex = 0;
  private restLeft = 0;
  private potionsNow = 0;
  private draughtsNow = 0;
  private junkTried = new Set<string>();
  private walkedToShop = false;
  private soldThisRest = false;
  // Keys that just refused sale this rest stop - a race with inventory, or
  // something the merchant will not take. Skipped rather than retried
  // forever; cleared with everything else when a fresh rest begins.
  private sellSkip = new Set<string>();
  // The real limit, not a rare backstop: sellableItems() sends the real
  // owned quantity per call, so a row the gateway genuinely reports stacked
  // clears in one sell - the tarnished key is one (a whole stack of vendor
  // trash gone in a single call, see isCargo() in actions.ts). Coins are
  // the one thing hard-excluded from this list and never appear here at
  // all. Not everything stacks though: a review measured the live pack and
  // found 198 carried branches are 198 separate {key:'branch', quantity:1}
  // rows, not one row of 198 (2026-08-15). So this is one call per unit for
  // whatever actually fills the bag, exactly as before, just now bounded:
  // a rest sells at most 30 rows and stops, rather than either the old
  // fixed-list blindness or an unbounded loop on a stack (real or
  // mis-reported) that never seems to shrink.
  private sellsThisRest = 0;
  private potionBuysThisRest = 0;
  private stoodDownThisRest = false;
  private gearTriedThisRest = false;
  private gearTryOffset = 0;
  private armorTriedThisRest = false;
  private armorTryOffset = 0;
  private coinsNow = 0;
  private sellablesNow: { key: string; quantity: number }[] = [];
  // Coins in the purse the last time the counter refused a wish: no
  // fresh market trip until the purse has GROWN past that mark, or a
  // stale price would march the body to town in a perfect loop.
  private gearRefusedAt = -1;
  private armorRefusedAt = -1;
  // Where the leader's published plan is headed, remembered each tick:
  // the follower's hunting ground IS this room (see topFields).
  private leaderDest: string | null = null;
  /** The leg the leader published alongside that destination. Hunting or
   *  looting there means it is working the ground and a follower should
   *  join; anything else means it is passing through. */
  private leaderLeg: string | null = null;
  private shieldTriedThisRest = false;
  private tapBeat = false;
  private followBeat = false;
  private futileStrikes = 0;
  private wedgeStreak = 0;
  /** Reconnects spent on one wedge. Two without moving means walled in. */
  private wedgeReconnects = 0;
  /** How many times the world has been asked to put an off-map body back
   *  on THIS trip outside. Bounded: three rescue attempts, then one
   *  reconnect, then it stops escalating and just says so - an unbounded
   *  version would sever the session every few seconds forever against a
   *  server that keeps refusing. Zeroed the moment the body reads on-map
   *  again, so a later trip gets the full ladder. */
  private offMapAsks = 0;
  /** Beats spent working the current cache; past the cap it is marked
   *  futile for this session so a missing chest can never trap the round. */
  private chestTries = 0;
  /** Beats spent still WALKING toward the current cache's room, not yet
   *  arrived. chestTries alone cannot catch a route that never resolves -
   *  it only counts once the body is standing in the room - and this
   *  round's own history has a documented case of a walk that "succeeds"
   *  every tick while crossing the same boundary forever (2026-08-15,
   *  fixed for the outbound/homebound case, but any cache room this
   *  harness has never actually visited could reproduce it fresh). */
  private chestRouteTicks = 0;
  /** Which cache title the two counters above are currently measuring, and
   *  how many deaths it has cost - the give-up neither of them alone can
   *  provide, since a death resets whichever counter isn't mid-count at
   *  the moment it happens. Two deaths writes a cache off; see the outbound
   *  cache block and the death branch below. */
  private cacheInProgress: string | null = null;
  private cacheDeaths = 0;
  private futileCaches = new Set<string>();
  private pilgrimageEquip = false;
  private carriedNow: string[] = [];
  private levelNow: number | null = null;
  private sellsRefusedNoPrice = 0;
  private sellsEverMade = false;
  /** Set when a restart handed this round what an earlier run learned. */
  private rememberedNothingBuys = false;
  /** Items a counter has said outright it does not carry. */
  private unstocked = new Set<string>();
  private drankThisRest = false;
  /** So the refused-errand note is said once, not every beat. */
  /** When the last emergency cask run was taken. See the recovery block. */
  private recoveredAt = 0;
  /** So the walk to the cask says why once, not every beat of the way. */
  private recoveryAnnounced = false;
  private aleTries = 0;
  /** When the body last dropped a pile-on, so it cannot thrash. */
  private lastDisengageAt = 0;
  private aleHopeless = false;
  /** Starts now, not at zero: a 0 here makes the first tick a sweep, which
   *  pre-empts the leg the round was about to choose. */
  private shoppedAtLevel: number | null = null;
  private lastPurgeAt = Date.now();

  /**
   * Whether this world has shown it has nobody to sell to.
   *
   * Learned from refusals rather than hardcoded, so it corrects itself the
   * moment a counter starts buying: one successful sale sets sellsEverMade
   * and this can never read true again.
   *
   * Six is one rest stop's worth. Eight was the first guess and it was too
   * slow by exactly one round trip: a measured stop offers seven keys
   * before moving on, so a threshold above that made the body walk home,
   * be refused, walk out, and walk home again before it would believe the
   * world. High enough that one odd item or an inventory race cannot trip
   * it; low enough to be learned the first time it is true.
   */
  private nothingBuys(): boolean {
    if (this.sellsEverMade) {
      // One real sale retires the belief however it was arrived at, so a
      // world that starts buying is picked up without clearing the file.
      return false;
    }
    return this.rememberedNothingBuys || this.sellsRefusedNoPrice >= 6;
  }

  /**
   * Hand this round what an earlier run paid a town trip to find out.
   *
   * Learning survives a restart now (see market.ts). Without it a body spent
   * its first five minutes of every run walking to a counter to be refused
   * six times and told nobody stocks its armour - measured 2026-08-24 as most
   * of the gap between one character's 848 experience and another's 1,572.
   */
  remember(lore: { nothingBuys: boolean; unstocked: string[]; shoppedAtLevel: number | null }): void {
    this.rememberedNothingBuys = lore.nothingBuys;
    lore.unstocked.forEach((key) => this.unstocked.add(key));
    this.shoppedAtLevel = lore.shoppedAtLevel;
  }

  /** What this round has learned, for the caller to write down. */
  lore(): { nothingBuys: boolean; unstocked: string[]; shoppedAtLevel: number | null } {
    return {
      nothingBuys: this.nothingBuys(),
      unstocked: [...this.unstocked],
      shoppedAtLevel: this.shoppedAtLevel
    };
  }
  /** The level this character was when it last set foot in the field.
   *  Cleared the moment it stands anywhere else, so the next arrival
   *  records afresh - see mayLeaveField() and the clear in next(). */
  private fieldEntryLevel: number | null = null;
  private lastPinnedLeg: string | null = null;

  /**
   * May this character leave the hunting field yet?
   *
   * Only once it has gained a level since arriving. Before that, every
   * errand - banking, restocking, marching somewhere better - is refused,
   * because each one walks the body to the door on the western boundary and
   * back again, which is the whole of the edge-drift the spectator sees.
   *
   * RE-LATCHES ON EACH ARRIVAL (2026-08-16). This used to record the level
   * once per process and never again, so its own docstring was false: after
   * the first level-up the lock was spent for good and the doctrine the
   * user actually asked for - stay and fight until you level - was silently
   * off for the rest of the run. The mirror of that is worse now that the
   * grassland pays: a restart re-latched it at whatever level the body
   * happened to be, and if that caught it standing in the forest it was
   * pinned there, unable to reach the coin ground until it levelled again,
   * with no log line saying why.
   * The re-arm cannot live in here, which is a trap worth naming: this is
   * only ever CALLED while standing in the field, so any "have I left and
   * come back" test asked at this point is always false. next() clears the
   * latch instead, on any tick spent anywhere else.
   */
  private mayLeaveField(): boolean {
    if (null === this.levelNow) {
      return false;
    }
    if (null === this.fieldEntryLevel) {
      this.fieldEntryLevel = this.levelNow;
      return false;
    }
    return this.levelNow > this.fieldEntryLevel;
  }

  private wornThisRest = false;
  private conjuredThisRest = false;
  private ateThisRest = false;
  private healSelfNext = false;
  private drinkBeat = false;
  private mendBeat = false;
  private rescueBeat = false;
  private seekDrop = false;
  private tripDamage = 0;
  private lastBattleRead = 0;
  private wantedTactics: string | null = null;
  private spellBlocked = false;
  private healBlocked = false;
  private doorHint: string | null = null;
  private doorHintScene: string | null = null;
  private doorHintPlace: string | null = null;
  private sceneNow = '';
  private fieldIndex = 0;
  private waitTicks = 0;
  private needUnstick = false;
  private doorBlockedStreak = 0;
  private callTheMind = false;
  private needForceDoors = false;
  private wantWorldMove = false;
  private wantReconnect = false;
  private jiggleIndex = 0;
  private advanceCount = 0;
  private needAdvance = false;
  private lastSpot: { x: number; y: number } | null = null;
  private stationarySince = 0;
  /** How deep the current tick has recursed through next(). The legs call
   *  back into next() to hand work to each other, which is fine until two
   *  of them disagree - one writes leg A, the other writes leg B, neither
   *  can see the other, and the tick never returns. That has now been
   *  found four separate times (field lock against the bank run, against
   *  the futile bail, against the top-field check, and the death branch
   *  against resting). Each was fixed where it was found; this bounds the
   *  SHAPE, so the fifth is a bad tick in the log instead of a RangeError
   *  that run() turns into a fifteen-second reconnect storm. */
  private depth = 0;
  /** Whether this tick's death has already been acted on, so a recursive
   *  re-entry cannot rewrite the leg back to 'resting' underneath the leg
   *  that is trying to answer it. Cleared as soon as the feed stops
   *  reporting a death. */
  private deathHandled = false;
  /** Sellable cargo aboard, held across leg handoffs - see the note where
   *  it is assigned. Read by the phoenix cargo guard and by mustBank. */
  private carryingNow = 0;
  private lastWasMovement = false;

  constructor(private readonly options: RoundOptions = {}) {}

  /**
   * One beat of the round. The legs hand work to each other by calling
   * back in, so this is the outer door: it zeroes the recursion budget and
   * the inner `again()` spends it.
   */
  next(
    scene: string,
    danger?: { damage: number; died: boolean; aggressors: number; landed?: boolean },
    hp?: { value: number; total: number } | null,
    partnerLoc?: { room: string; x: number; y: number; hp?: { value: number; total: number } | null } | null,
    ownLoc?: {
      room: string;
      x: number;
      y: number;
      level?: number | null;
      mp?: { value: number; total: number } | null;
    } | null,
    leaderPlan?: { leg: string; dest: string; scene: string } | null,
    victim?: { name: string } | null,
    crisisRoom?: string | null,
    carrying?: number,
    potions?: number,
    carriedNames?: string[],
    coins?: number,
    draughts?: number,
    sellables?: { key: string; quantity: number }[]
  ): Intent {
    this.depth = 0;
    // Re-arm the death latch once the feed stops reporting one, so the
    // next death is acted on. Done here rather than inside the branch so
    // it cannot be skipped by an early return.
    if (true !== danger?.died) {
      this.deathHandled = false;
    }
    return this.beat(
      scene, danger, hp, partnerLoc, ownLoc, leaderPlan, victim, crisisRoom,
      carrying, potions, carriedNames, coins, draughts, sellables
    );
  }

  /**
   * A leg handing the beat to another leg. Bounded, because two legs that
   * disagree about which one owns the tick will otherwise write over each
   * other for ever: the field lock forces `hunting`, the hunting leg's
   * bank run answers `homebound`, and neither can see the other. That is
   * not a slow loop, it is a RangeError, which run() catches as a
   * reconnect - so the body never acts, never levels, and whatever
   * condition pinned it never lifts. A fifteen-second storm needing a
   * human. Four instances of that exact shape have been found and fixed
   * one at a time; this bounds the shape itself, so the fifth costs one
   * wasted beat and a log line naming the legs that fought.
   */

  /**
   * EVERY ROAD TO TOWN, NAMED (2026-08-27).
   *
   * Six separate sites set this leg and not one of them said so, which is
   * why three sessions running argued about a trip instead of reading its
   * cause. Measured: at 01:44:33 Lord Gemma went homebound at 3 hp of 633 -
   * half of one percent - with no [errand] line, bought nothing, rested
   * nothing, and walked back into the maze still at 3. Four candidate
   * triggers were traced against the log and every one of them fell:
   * mustBank is structurally false while `nothingBuys` is latched, the
   * partner was hunting so `leaderTownBound` was false, the wedge ladder
   * needs an `unstick` that never printed, and hp read null in 0 of 251
   * samples. The guard SHOULD have printed either way. One of those
   * premises is wrong and no amount of reading settles which.
   *
   * A REASON THAT NAMES THE WRONG DOOR IS WORSE THAN NO REASON. Two of
   * these were transposed on first writing - the field guard wore the inn's
   * label and the inn guard wore the field's - and a reviewer had already
   * staked a falsifiable prediction on the exact string. A swapped label
   * would have killed a correct hypothesis, or confirmed a wrong one, which
   * is the precise failure this instrumentation exists to prevent. Each
   * reason is now read off the CONDITION beside it, not off the leg name.
   *
   * So the log names the door now. This is instrumentation, not a fix: it
   * changes no decision, and the reason string is the only new fact. Once
   * a real trigger is on the record, the guard can be extended to sit on
   * it rather than on the two triggers someone guessed at.
   */
  private goHome(why: string, alwaysAllowed = false): boolean {
    if (!alwaysAllowed && !this.mayWalkOut(why, this.sceneNow)) {
      this.leg = 'hunting';
      return false;
    }
    this.saidStayingToFight = false;
    if (why !== this.lastHomeReason) {
      this.lastHomeReason = why;
      console.log(`[leg] homebound: ${why}`);
    }
    this.leg = 'homebound';
    return true;
  }

  /**
   * BAYS FORGET NOTHING, AND THAT IS THE DEFECT (2026-08-27).
   *
   * A target that cannot be reached gets shunned and the body moves on. A
   * BAY - one of the authored respawn-patch anchors, "the WALKABLE tile
   * closest to its patch's centroid" - is retried for ever, because nothing
   * on this side ever wrote down that a march at it failed.
   *
   * Measured: the caller pocket's anchor took three did-not-move failures in
   * one night from the eastern approach (01:59:23 from tile 47,10 and
   * 02:01:10 from 45,10 among them), against one "on the way" from a
   * different approach hours earlier - and "on the way" only certifies that
   * the first leg moved, never that the body arrived. Walkable is not the
   * same as reachable-from-here; that is the same gap that made a Hollow
   * Caller 5.7 tiles away and 55 on foot pass a `reachable: true` screen.
   *
   * The cost is a tax rather than a park - he earns between attempts - but
   * it recurs all night, and for every future body in this room. So a bay
   * that will not take a body is set aside for a while, exactly as a target
   * is, and comes back afterwards in case the approach was the problem
   * rather than the bay. If EVERY bay is set aside the whole ledger is
   * ignored, because a body with nowhere authored to march is worse off
   * than one retrying a bad anchor.
   */
  private bayTrouble = new Map<string, { misses: number; until: number }>();
  private bayAimed: string | null = null;
  /** The distinct tiles this body has most recently stood on. See the ladder. */
  private recentTiles: string[] = [];
  /** Pacing trips since the last fight. Owns its own ladder - see above. */
  private paceTrips = 0;
  private paceFirstTrip = 0;
  /** Whether this visit to the tool counter has already crossed to the keeper. */
  /** True only once a walk has actually ARRIVED at the keeper. */
  private atKeeper = false;
  /**
   * DOORS THE WORLD HAS REFUSED BY NAME, and what it said it wanted.
   *
   * A locked door is not a transient failure and must never be retried like
   * one. Watched live, 2026-08-27, minutes after the fishing trip shipped:
   *
   *   use_door millrace-approach -> the door did not open: That door is
   *   locked. It needs tansys_road_writ. Find the Carter's Tally in
   *   Miller's Stair. Deliver it to Tansy in the Valley grange.
   *
   * Both bodies then bounced use_door -> force_doors -> use_door against
   * that door, at full health, with zero hostiles in the room, for four
   * minutes - and would have kept going for SEAM_WALK_BEATS, which at seven
   * seconds a beat is forty-seven minutes of earning nothing.
   *
   * The destination was chosen off the frontier LEVEL table, which says
   * nothing about whether a road is open. Level is not the same as access,
   * and the trip had no way to find that out except by walking into it.
   *
   * Keyed by the door label the route asked for, and kept for the life of
   * the process rather than expiring on a timer: a quest lock does not open
   * because time passed. If the writ is ever earned, a restart clears it.
   */
  private barredDoors = new Map<string, string>();
  /** An active trip to the seam, and when the last one ended. */
  private seamRun = false;
  private seamBeats = 0;
  private seamAt = 0;
  private seamGathers = 0;
  /**
   * The destination itself is shut, not just the next door on the way.
   *
   * `roadBarred` deliberately looks only one door ahead, so from the stair
   * the road to the ford reads open - the lock is two rooms away, at
   * `millrace-approach`. Without this the trip would set out every hour,
   * cross to the valley, meet the same lock, and walk back: cheaper than
   * the loop it replaced, and still a body doing errands instead of
   * earning. Once the world has named the price of a road, the trip that
   * wanted that road is over until a restart.
   */
  private seamBarred = false;
  /** The closest this walk has come, and how many beats since it improved. */
  private seamBest: number | null = null;
  private seamStuck = 0;
  /** The door whose bar killed the trip, so the two can be released together. */
  private seamBarredBy = '';
  /** A deliberate walk to a seam in THIS room, and when the last one ended. */
  private seamWalk = false;
  /** The scene whose seam this errand set out for - see the walk-back below. */
  private seamScene: string | null = null;
  private seamWalkBeats = 0;
  private seamWalkAt = 0;
  private seamWalkGathers = 0;
  /** Beats fought since the last time a trade beat was offered. */
  private sinceGather = 0;
  private lastHomeReason = '';
  private hpPctNow: number | null = null;
  private saidStayingToFight = false;

  /**
   * MAY THIS BODY LEAVE THE FIELD RIGHT NOW? (2026-08-27)
   *
   * The older guard sat on the two triggers someone had named - mustBank
   * and wantsBank - and a third one walked around it. Measured pair, same
   * night, same body:
   *
   *   death in place  01:15  last earning beat -> hunting again 2m20s,
   *                          full hp AND mana, no detour, no coin
   *   the errand      01:43  stopped earning at 3 hp of 633, town at
   *                          01:44:33, bought nothing, rested nothing,
   *                          back in the field at 01:46:18 STILL at 3,
   *                          fought on for a minute, died anyway.
   *                          Six to seven minutes not earning.
   *
   * Three times the cost, the same death at the end of it, and it only
   * escaped being worse because he survived two walks at half of one
   * percent on a coin flip. Its entire yield was a bookkeeping line.
   *
   * So this guards the OUTCOME rather than the cause. Naming triggers has
   * now failed twice; what the standing order actually forbids is walking
   * out of a fight to heal nothing, and that is one condition wherever the
   * door happens to be. A trigger nobody has found yet is covered by it on
   * the day it fires.
   *
   * TWO EXEMPTIONS, both load-bearing rather than cautious:
   *  - the wedge escape. A body sealed in a maze cell has to leave the
   *    room; guarding that trades a bad errand for a permanent trap.
   *  - anywhere that is not a field. The legs that walk out of the inn and
   *    the shop are how he gets back at all, and none of them is a retreat.
   *
   * WHY THIS CANNOT TRAP HIM, and the premise is drainLife rather than
   * anything in this function. The feared state is: under fifty, in a field,
   * nothing biting, so he neither heals nor dies. It needs a field with
   * nothing engageable in it. The stair holds 28-31 hostiles all night off
   * 30 respawners, shuns expire in two to five minutes, and the hunting leg
   * marches at what it can see - so he ends up fighting, and fighting
   * resolves in BOTH directions: drainLife is in his rotation and nets hp
   * per exchange, so he either climbs back over fifty and the guard lifts,
   * or he bleeds out into the free full restore. The unresolvable version
   * needs a permanently emptied or wholly walled room, which this is not.
   * If a future field can be emptied, this argument expires with it.
   *
   * NOT A RETREAT, and the distinction is Glenn's standing order ("no
   * running away - fight to the death"): this never moves a body, it only
   * refuses to move one. The answer to a low bar here is to keep swinging,
   * and to take the free full restore that dying already is.
   */
  private mayWalkOut(why: string, scene: string): boolean {
    if (!FIELDS.includes(scene)) {
      return true;
    }
    const noMedicine = 0 === this.potionsNow
      && !this.options.feastSpell
      && !this.options.healSpell;
    const dying = null !== this.hpPctNow && this.hpPctNow < RECOVER_BELOW_HP_PCT;
    if (!dying || !noMedicine) {
      return true;
    }
    if (!this.saidStayingToFight) {
      this.saidStayingToFight = true;
      console.log(`[errand] ${Math.round(this.hpPctNow ?? 0)}% hp, nothing to drink or cast`
        + ` - refusing "${why}" and staying to fight`);
    }
    return false;
  }

  private again(
    scene: string,
    danger?: { damage: number; died: boolean; aggressors: number; landed?: boolean },
    hp?: { value: number; total: number } | null,
    partnerLoc?: { room: string; x: number; y: number; hp?: { value: number; total: number } | null } | null,
    ownLoc?: {
      room: string;
      x: number;
      y: number;
      level?: number | null;
      mp?: { value: number; total: number } | null;
    } | null,
    leaderPlan?: { leg: string; dest: string; scene: string } | null,
    victim?: { name: string } | null,
    crisisRoom?: string | null,
    carrying?: number,
    potions?: number,
    carriedNames?: string[],
    coins?: number,
    draughts?: number,
    sellables?: { key: string; quantity: number }[]
  ): Intent {
    this.depth += 1;
    if (this.depth > 8) {
      console.log(`[round] leg handoff ran away at depth ${this.depth} (leg ${this.leg}, scene ${scene}) - standing still for a beat`);
      // WAIT, not a swing. An attack also terminates the beat, but it is
      // not free: in town it finds no enemy, and the refusal drives
      // needAdvance, whose blind branch then walks toward the forest's
      // centre tile - a coordinate that does not exist on the town map.
      // Bow-armed it is worse: the executor rewrites it to a bow shot and
      // the refusal flips the leg to looting, so the escape hatch would
      // rewrite the very leg the two blocks were fighting over. `wait` is
      // the only intent with no downstream effect at all - npc.ts logs it
      // and ends the beat without calling perform() or completed().
      return { action: 'wait' };
    }
    return this.beat(
      scene, danger, hp, partnerLoc, ownLoc, leaderPlan, victim, crisisRoom,
      carrying, potions, carriedNames, coins, draughts, sellables
    );
  }

  private beat(
    scene: string,
    danger?: { damage: number; died: boolean; aggressors: number; landed?: boolean },
    hp?: { value: number; total: number } | null,
    partnerLoc?: { room: string; x: number; y: number; hp?: { value: number; total: number } | null } | null,
    ownLoc?: {
      room: string;
      x: number;
      y: number;
      level?: number | null;
      mp?: { value: number; total: number } | null;
    } | null,
    leaderPlan?: { leg: string; dest: string; scene: string } | null,
    victim?: { name: string } | null,
    crisisRoom?: string | null,
    carrying?: number,
    potions?: number,
    carriedNames?: string[],
    coins?: number,
    draughts?: number,
    sellables?: { key: string; quantity: number }[]
  ): Intent {
    // Orders beat breadcrumbs: when the leader has published a plan, the
    // follower walks to where the leader is GOING, not where the feed
    // last saw him. Resting legs mean town; everything else means the
    // leader's destination.
    if (leaderPlan && 'leader' !== this.options.role && this.options.partner) {
      const rallyRoom =
        'homebound' === leaderPlan.leg || 'restock' === leaderPlan.leg || 'resting' === leaderPlan.leg
          ? TOWN
          : leaderPlan.dest;
      this.leaderDest = rallyRoom;
      // Kept beside the destination because topFields() needs to tell a
      // leader WORKING a room from one merely crossing it - see the note
      // there. Read from the same published plan, so the two can never
      // disagree about which tick they describe.
      this.leaderLeg = leaderPlan.leg;
      if (partnerLoc && partnerLoc.room === rallyRoom) {
        // Feed and rally agree; the coordinates are trustworthy.
      } else {
        // Rally overrules a stale feed, but the feed's COORDINATES belong
        // to the room the feed saw - grafting them onto the rally room
        // once marched a follower to literal map-corner points (44,118).
        // Zeroed coords mean "same room, position unknown": walk the
        // route, then stand down until real coordinates arrive.
        partnerLoc = { room: rallyRoom, x: 0, y: 0 };
      }
    }
    const partnerRoom = partnerLoc?.room ?? null;
    if (undefined !== potions) {
      this.potionsNow = potions;
    }
    if (undefined !== carriedNames) {
      this.carriedNow = carriedNames;
    }
    if (undefined !== draughts) {
      // TRUE quantity, not a name count: draughts stack as one row, and
      // counting rows read "one" against a hoard of twenty - the Magus
      // bought four more every rest until the user shouted.
      this.draughtsNow = draughts;
    }
    if (undefined !== coins) {
      // Logged only on change, not every tick: there was no way to answer
      // "are they actually earning anything" from this harness's own logs
      // before now - buy/sell attempts log pass or fail, never the purse
      // total behind them (2026-08-15).
      if (coins !== this.coinsNow) {
        console.log(`[purse] ${this.coinsNow} -> ${coins} (${coins - this.coinsNow >= 0 ? '+' : ''}${coins - this.coinsNow})`);
      }
      this.coinsNow = coins;
    }
    if (undefined !== carrying) {
      // An instance field for the same reason sellablesNow is one: the legs
      // hand the beat to each other WITHOUT re-passing every argument, so a
      // param-only read goes undefined on re-entry. Measured: that is what
      // made a held bank run land a tick late (mustBank read 0), and worse,
      // it silently disabled the phoenix cargo guard - a laden courier at
      // under a quarter health blazing with the whole treasury on its back,
      // which death then spills. Six other fields in this method already
      // follow this pattern; carrying was the one left behind.
      this.carryingNow = carrying;
    }
    if (undefined !== sellables) {
      // An instance field, not just the param, because this round recurses
      // into itself for a leg change without re-passing every argument -
      // a param-only read would go undefined and silently skip market day
      // the moment that recursion lands above the one guard that happens
      // to save it today (2026-08-15).
      this.sellablesNow = sellables;
    }
    this.sceneNow = scene;
    if (null != ownLoc?.level) {
      this.levelNow = ownLoc.level;
    }
    // Standing anywhere but the field arms the field lock for the NEXT
    // arrival (2026-08-16). mayLeaveField() cannot do this itself - it only
    // runs while already in the field - and without it the lock recorded a
    // level once per process and was spent forever after the first
    // level-up, silently dropping the stay-and-fight-until-you-level rule.
    if (FIELD !== scene) {
      this.fieldEntryLevel = null;
      // lastPinnedLeg is the same one-shot-per-process latch, three lines
      // from the one above: written once per leg and cleared nowhere, so
      // after each of outbound/homebound/restock had logged once the field
      // lock went silent for good. Re-arming the level latch without this
      // would make the pin recur INVISIBLY - the exact harm the docstring
      // on mayLeaveField() names.
      this.lastPinnedLeg = null;
    }
    if (this.doorHintScene && this.doorHintScene !== scene) {
      // The hint solved the room it was learned in; a new room starts clean.
      this.doorHint = null;
      this.doorHintScene = null;
      this.doorHintPlace = null;
    }
    // OFF THE MAP: go straight to the world's own rescue, skip the ladder
    // entirely (2026-08-16). Every map in this world is a Tiled grid with
    // origin (0,0) and positions are col*tileWidth, so no legitimate
    // negative exists anywhere - and locate() defaults a missing coordinate
    // to 0, never below it, so the feed cannot manufacture a false positive
    // either. A negative coordinate is therefore proof the body is OUTSIDE
    // the world rather than merely stuck in it, and every rung below this
    // one is a WALK, which cannot work from out there: measured live, a
    // clamped go_to to a sane on-map tile answered "no walking route",
    // because there is no continuous walkable path from outside the map
    // back into it. Seen twice: the "sovereign" incident, and Sir Qwen in
    // the crypt past px -141,509 before the old ladder's last rung fired.
    //
    // 'unstick', NOT 'give_up_and_walk_back', though both call the same
    // arena_unstick tool: unstick has no hour-long harness cooldown, does
    // not spend the door ladder's own give-up budget, needs no 'doors'
    // capability, and uniquely reports a mid-transition wedge - which
    // completed() already turns into a reconnect on its own, so the
    // escalation below becomes evidence-driven instead of blind.
    // Server-side arena_unstick tries a 3-tile nudge first and only warps
    // to the inn when nothing near is open; from off-map every candidate
    // tile fails, so the warp is what actually runs. On-map that same call
    // is a harmless few-tile nudge, which is why a false positive here
    // would be cheap even if one were possible.
    if (ownLoc && (ownLoc.x < 0 || ownLoc.y < 0)) {
      this.lastWasMovement = false;
      this.stationarySince = 0;
      this.doorBlockedStreak = 0;
      this.offMapAsks += 1;
      if (this.offMapAsks <= 3) {
        console.log(`[off-map] px(${Math.round(ownLoc.x)},${Math.round(ownLoc.y)}) is outside the world - asking it to put the body back (try ${this.offMapAsks})`);
        return { action: 'unstick' as never } as Intent;
      }
      if (4 === this.offMapAsks) {
        // Three rescues refused. A fresh session is the last card, and the
        // one that cured the hard wedge. BOUNDED on purpose: the first
        // version re-armed itself while still outside, which alternated
        // rescue and reconnect forever - every other ladder in this file
        // is bounded and this one has to be too, or a server that keeps
        // refusing earns a session sever every twenty seconds for good.
        console.log('[off-map] three rescues refused - reconnecting the body once');
        this.wantReconnect = true;
      }
      // Past that: stop escalating. Say so once a minute so it is visible
      // in the log rather than silent, and let the beat fall through.
      if (this.offMapAsks === 5 || 0 === this.offMapAsks % 20) {
        console.log(`[off-map] still outside the world at px(${Math.round(ownLoc.x)},${Math.round(ownLoc.y)}) after ${this.offMapAsks} attempts - out of harness-side cures, needs a human or a server fix (agentArena #182)`);
      }
    } else if (0 !== this.offMapAsks) {
      // Back on the map: re-arm, so a later trip out there gets the full
      // ladder again rather than starting spent.
      this.offMapAsks = 0;
    }
    // Motion watchdog: the feed says where the body truly is. Three
    // movement orders that left it standing still mean it is wedged on
    // something no error message will ever name - a tree, a fence, a
    // neighbour - and the escape ladder should fire on the evidence of
    // the map rather than wait for a refusal that is not coming.
    if (ownLoc) {
      const moved =
        !this.lastSpot || Math.hypot(ownLoc.x - this.lastSpot.x, ownLoc.y - this.lastSpot.y) > 20;
      if (moved || !this.lastWasMovement) {
        this.stationarySince = 0;
      } else {
        this.stationarySince += 1;
      }
      this.lastSpot = { x: ownLoc.x, y: ownLoc.y };
      // A 2-CYCLE IS A WEDGE TOO (2026-08-27, live).
      //
      // Every detector on this side keys on a body that stops moving: the
      // motion watchdog counts SAME-TILE beats, and `goTo`'s honesty check
      // asks whether this walk changed the tile. Measured tonight, Lord
      // Gemma beat both of them at once - nine minutes and 163 log lines
      // without a single copper, at 16 hp of 633, oscillating (83,42) to
      // (83,34) and back with the nearest hostile drifting from 9 tiles to
      // 20. He genuinely moved every beat, so `stationarySince` reset every
      // beat; each individual walk genuinely progressed, so `goTo` answered
      // ok honestly. He could not earn, could not reach anything, and could
      // not even die - nothing came close enough to kill him.
      //
      // The likely mechanism is the corner-legged walk: the route is
      // recomputed each beat and only its first corner is taken, so two
      // equivalent routes whose first corners are each other will trade the
      // body back and forth for ever, each leg reporting success.
      //
      // So the ladder's memory grows from ONE tile to a short window, and a
      // body whose whole recent history fits in two tiles is wedged whatever
      // the per-beat answers said. Gated hard on there being no fight: a
      // ranged body legitimately HOLDS position while shooting, and holding
      // is the behaviour that keeps a cloth caster alive. Nothing biting us
      // and nothing landing for us is what separates a standoff from a
      // trap.
      if (ownLoc) {
        // Bucketed in PIXELS, not tiles, because tile size is per-scene here
        // (64 on the stair and the valley, 32 elsewhere) and this block sits
        // above the switch that knows which room it is in. The smaller tile
        // is the safe bucket: sub-tile drift stays in one bucket, and two
        // standing spots eight tiles apart never share one.
        // BUCKET BY THE ROOM'S OWN TILE (2026-08-27, caught by its own first
        // live firing). This bucketed at a fixed 32px "to be safe", and the
        // detector promptly reported `pacing 175,126 <-> 175,127` - two
        // halves of ONE 64px tile on Miller's Stair. A body drifting a few
        // pixels inside a single tile was being called a pacer, and the
        // drift test missed it because it jittered by two pixels rather than
        // the thirty a real body moves.
        //
        // `tilePxFor` is the same static per-scene table the walk race was
        // fixed with, and it cannot lag the room the way a cached value can.
        const bucket = tilePxFor(scene) || PACE_BUCKET_PX;
        const here = `${Math.floor(ownLoc.x / bucket)},${Math.floor(ownLoc.y / bucket)}`;
        // EVERY BEAT, NOT ONLY ON CHANGE (2026-08-27, second live stall).
        //
        // Recording only bucket CHANGES meant a body stuck on ONE tile never
        // filled the window, so this caught the 2-cycle and left the 1-cycle
        // to the motion watchdog - which the very next stall walked straight
        // past. Sir Qwen sat on tile (87,33) for 89 log lines without a
        // copper, and `stationarySince` never climbed because it only counts
        // a beat as stationary when the PREVIOUS order was movement, and his
        // beats alternate approach / attack / pick_up. Two detectors, one
        // blind spot each, and the same body in both.
        //
        // Pushing every beat makes the cardinality test cover both shapes at
        // once: one bucket repeated is a wedge, two traded is pacing, and a
        // body actually going somewhere fills the window with eight
        // different ones. `quiet` is what keeps a fighting body out of it.
        this.recentTiles.push(here);
        if (this.recentTiles.length > TWO_CYCLE_WINDOW) {
          this.recentTiles.shift();
        }
        // ONLY IN THE FIELD. Recording every beat (rather than only bucket
        // changes) means standing still now counts, and standing still is
        // ORDINARY off the hunting ground - resting at the inn, waiting at a
        // counter, working a station are all a body on one tile with nothing
        // fighting it. Two suites said so the moment the window widened,
        // which is what suites are for.
        const quiet = FIELDS.includes(scene)
          && !danger?.landed && 0 === (danger?.aggressors ?? 0);
        // A FIGHT WIPES THE PACING MEMORY (review, 2026-08-27). Without this
        // the window never ages: moves recorded DURING a fight - and the
        // server's own spacing bounces a caster between two spots, which is
        // exactly a two-bucket signature - outlive the fight, and the first
        // quiet beat fifteen seconds after the last kill trips on stale
        // combat-era history. It also closes the bucket-boundary straddle,
        // where a body holding ON a 32px edge flips buckets on a few pixels
        // of server glide without going anywhere. A genuinely trapped body
        // is quiet by definition, so it still fires in the same eight beats.
        if (!quiet) {
          // CLEAR THE WINDOW, NOT THE LADDER (2026-08-27, review S1).
          //
          // This cleared `paceTrips` too, and that starved the escalation
          // completely. Driven through repeated pacing episodes, varying only
          // what happened between them:
          //
          //   no landed hits    11 firings -> 4 unstick, 4 jiggle, 3 MARCH
          //   ONE landed hit    11 firings -> 6 unstick, 5 jiggle, 0 MARCH
          //
          // A single landed hit starves it permanently, and "earning while
          // pacing" is by definition a body that lands hits between episodes.
          // The logs agree: 17 pacing firings across every log ever written,
          // and the trip-3 signature follows one exactly zero times. The rung
          // had never executed in production.
          //
          // Clearing `recentTiles` IS correct and has its own test - stale
          // combat-era history tripping the detector. Only the counter was
          // wrong to clear.
          this.recentTiles.length = 0;
        }
        const pacing = this.recentTiles.length >= TWO_CYCLE_WINDOW
          && new Set(this.recentTiles).size <= TWO_CYCLE_TILES;
        if (quiet && pacing) {
          console.log(`[wedge] pacing ${[...new Set(this.recentTiles)].join(' <-> ')}`
            + ` for ${this.recentTiles.length} moves with nothing to fight - treating as wedged`);
          this.recentTiles.length = 0;
          // A ROLLING WINDOW, not an unbounded tally: three firings in a few
          // minutes is a body stuck in one pocket; three firings across an
          // evening is ordinary maze geometry and must not add up to a march.
          if (Date.now() - this.paceFirstTrip > PACE_WINDOW_MS) {
            this.paceTrips = 0;
            this.paceFirstTrip = Date.now();
          }
          this.paceTrips += 1;
          // THE LADDER IS RUN HERE, NOT BORROWED (2026-08-27, second pass).
          //
          // The first version set `stationarySince` and expected the rungs
          // below to fire. Review caught that `= 8` skipped the two cheap
          // cures; the re-aim to `= 2` then failed its own test, and the
          // test was right - the motion watchdog resets `stationarySince`
          // to zero on any beat where the body MOVED, and a pacing body
          // moves every beat. So no value survives to the next beat, and
          // the original `= 8` only ever worked because `>= 8` is read in
          // the same beat it is written. Borrowing a counter whose owner
          // resets it was the mistake; this owns its own.
          //
          // Cheapest first, because a nudge of a few pixels changes the
          // origin the route is recomputed from, which is the likeliest
          // thing to break a two-corner tie.
          if (1 === this.paceTrips) {
            this.lastWasMovement = false;
            return { action: 'unstick' as never } as Intent;
          }
          if (2 === this.paceTrips) {
            this.lastWasMovement = false;
            this.jiggleIndex += 1;
            const hops = [[96, 0], [-96, 64], [0, -96], [-64, -64]];
            const [dx, dy] = hops[this.jiggleIndex % hops.length];
            return { action: 'go_to' as never, target: `${ownLoc.x + dx},${ownLoc.y + dy}` } as Intent;
          }
          // STILL PACING AFTER A NUDGE AND A HOP: GO SOMEWHERE ELSE.
          //
          // Measured live 2026-08-27, Sir Qwen at (82,34)<->(83,35): the
          // ladder escalated exactly as designed - unstick, then the jiggle -
          // and BOTH cures worked. He moved. Then the very next beat's
          // `approach __nearest__` walked him straight back to the same wall,
          // because the nearest target was one he could not actually reach,
          // and he paced again. Three firings in three minutes, full health,
          // 31 hostiles in the room, nearest 18-26 tiles and receding, not
          // one copper earned.
          //
          // The cures were never the problem. The two systems did not talk:
          // pacing knew the body was trapped, and the hunting logic kept
          // choosing the target that trapped it. A nudge cannot win against
          // a chase that re-aims at the same unreachable thing every beat.
          //
          // So the third trip stops nudging and marches: `needAdvance` sends
          // the body to a different respawn patch entirely, which is the one
          // move that changes which targets are nearest. The hard ladder
          // still arms underneath for a body that cannot even march.
          // MARCH DIRECTLY (2026-08-27, review S4). This also set
          // `stationarySince = 8`, and the very next check reads `>= 8` in
          // the SAME beat - so the rung took the hard-wedge branch, spent a
          // model call on `think_free`, and armed a reconnect ladder
          // underneath, all before reaching the march one beat later.
          //
          // That is the borrowed-counter mistake this file already documents
          // having made once, in the comment forty lines up. Owning the
          // counter and then handing control back to someone else's is the
          // same error wearing a different hat.
          this.paceTrips = 0;
          this.needAdvance = true;
        }
      }
      if (this.stationarySince === 3) {
        this.lastWasMovement = false;
        return { action: 'unstick' as never } as Intent;
      }
      if (this.stationarySince === 5) {
        this.lastWasMovement = false;
        this.jiggleIndex += 1;
        const hops = [[96, 0], [-96, 64], [0, -96], [-64, -64]];
        const [dx, dy] = hops[this.jiggleIndex % hops.length];
        return { action: 'go_to' as never, target: `${ownLoc.x + dx},${ownLoc.y + dy}` } as Intent;
      }
      if (this.stationarySince >= 8) {
        this.stationarySince = 0;
        this.lastWasMovement = false;
        // THE HARD WEDGE (three of them on 2026-08-15): the body stops
        // moving for every order - unstick included - and combat quietly
        // stops resolving with it. Nothing client-side shifts it and no
        // error is ever reported; only a fresh session does. Thinking
        // about it was tried twice and thought nothing useful, so the
        // ladder now ends in a reconnect instead of a philosopher.
        this.wedgeStreak += 1;
        if (this.wedgeStreak >= 2) {
          this.wedgeStreak = 0;
          // A RECONNECT THAT CHANGES NOTHING MEANS THE ROOM, NOT THE BODY.
          // Measured on Miller's Stair, 2026-08-21: Lord Gemma sat on tile
          // (0,7) through unsticks, jiggles and two full reconnects, with a
          // scuttler three tiles away and "no walking route" to every tile
          // he asked for. He was not wedged, he was WALLED IN - a maze
          // with 20,245 wall tiles has sealed cells, and respawning drops
          // his back into the same one. Nothing inside the room can fix
          // that, so the last rung leaves the room: out to the valley and
          // back in through the stair's own arrival point.
          this.wedgeReconnects += 1;
          if (this.wedgeReconnects >= 2) {
            this.wedgeReconnects = 0;
            // `true`: the exemption is a PARAMETER, not a prefix on the reason
            // string. Adversarial review, 2026-08-27 - reworded reason text would
            // have deleted a load-bearing exemption silently, which is the same
            // shape as the melee rung that only worked because of array order.
            this.goHome('wedge escape - two reconnects changed nothing, leaving the room', true);
            this.needForceDoors = true;
          } else {
            this.wantReconnect = true;
          }
        } else {
          this.callTheMind = true;
        }
      }
    }
    if (this.callTheMind) {
      this.callTheMind = false;
      return { action: 'think_free' as never } as Intent;
    }
    if (this.wantReconnect) {
      this.wantReconnect = false;
      // #152: reconnecting drops tactics server-side with no signal.
      // Re-arm so the very next reflex tick resends them.
      this.reassertTactics();
      return { action: 'reconnect' as never } as Intent;
    }
    if (this.wantWorldMove) {
      this.wantWorldMove = false;
      return { action: 'give_up_and_walk_back' };
    }
    if (this.needAdvance && ownLoc) {
      this.needAdvance = false;
      // Cleared ground means march toward the heart of THIS room, where the
      // spawns are thickest - shuffling fixed hops kept the pair
      // re-sweeping the same bare corner forever.
      // Per-room, and no blind fallback (2026-08-16). The old code walked
      // toward tile (72,72) whatever room it was standing in, which was
      // survivable only while the forest was the only hunting ground.
      // Opening the grassland - 30x20 tiles against the forest's 145x145 -
      // made the wrong-map case the DEFAULT room: 2320px is 2.4x that
      // map's width, so every empty leash parked the body in the far
      // south-east corner. approach() clamps it back onto the grid so it
      // never leaves the map, but that corner sits inside the six-tile band
      // where chooseTarget() refuses to fight on BOTH axes of a map that
      // small, and the rim recovery that would step it back in is scoped to
      // the forest and never runs there. The room opened for coins would
      // have quietly stopped paying with nothing in the log saying why.
      // A room with no heart written down now falls through to the ordinary
      // beat instead of guessing at a coordinate from another map.
      this.advanceCount += 1;
      // A room with a bay list marches at bays, not at its middle. Nearest
      // first, then the next one out on each further advance: clearing a
      // patch should move the body to the next patch, not walk it back to
      // the one it just emptied. advanceCount is reset by any landed hit,
      // so this only ever walks while nothing is being fought.
      const bays = BAYS[scene];
      if (bays?.length) {
        const now = Date.now();
        const open = bays.filter((b) => (this.bayTrouble.get(`${scene}|${b.x},${b.y}`)?.until ?? 0) <= now);
        // Nowhere authored to march is worse than a bad anchor: if the whole
        // list is set aside, ignore the ledger for this beat.
        const byDistance = [...(open.length ? open : bays)].sort(
          (a, b) => Math.hypot(a.x - ownLoc.x, a.y - ownLoc.y) - Math.hypot(b.x - ownLoc.x, b.y - ownLoc.y)
        );
        // Four hops to a bay before trying the next one out. advanceCount
        // counts HOPS, not bays, and a hop is clamped to 400px - so indexing
        // bays by it directly would re-sort and re-aim every single beat and
        // walk the body between two patches without ever arriving at either.
        const bay = byDistance[Math.min(Math.floor((this.advanceCount - 1) / 4), byDistance.length - 1)];
        this.bayAimed = `${scene}|${bay.x},${bay.y}`;
        const dx = Math.max(-400, Math.min(400, bay.x - ownLoc.x));
        const dy = Math.max(-400, Math.min(400, bay.y - ownLoc.y));
        return { action: 'go_to' as never, target: `${ownLoc.x + dx},${ownLoc.y + dy}` } as Intent;
      }
      const heart = HEARTS[scene];
      if (heart) {
        const dx = Math.max(-400, Math.min(400, heart.x - ownLoc.x));
        const dy = Math.max(-400, Math.min(400, heart.y - ownLoc.y));
        return { action: 'go_to' as never, target: `${ownLoc.x + dx},${ownLoc.y + dy}` } as Intent;
      }
    }
    if (this.needForceDoors) {
      this.needForceDoors = false;
      return { action: 'force_doors' as never } as Intent;
    }
    if (this.seekDrop) {
      this.seekDrop = false;
      return { action: 'seek_drop' as never } as Intent;
    }
    if (this.needUnstick) {
      this.needUnstick = false;
      // Shift to open floor first when we know where we stand: a body
      // wedged on a bad tile fails every door from that spot, and the
      // engine's nudge alone has not been enough.
      if (ownLoc && this.jiggleIndex % 2 === 1) {
        const hops = [[96, 0], [-96, 64], [0, -96], [-64, -64]];
        const [dx, dy] = hops[this.jiggleIndex % hops.length];
        return { action: 'go_to' as never, target: `${ownLoc.x + dx},${ownLoc.y + dy}` } as Intent;
      }
      return { action: 'unstick' as never } as Intent;
    }

    const hpPct = hp && hp.total > 0 ? (100 * hp.value) / hp.total : null;
    this.hpPctNow = hpPct;
    const mpNow = ownLoc?.mp?.value ?? null;
    // A heal cast on an empty mana pool returns "ok" and mends nothing -
    // the statue-lock of 2026-08-12 was a knight at 29% casting free
    // nothings forever. No mana, no casting, full stop.
    const manaDry = null !== mpNow && mpNow < 10;
    // A HEAL IS CHEAPER THAN THE DRY LINE. `heal` asks for mp >= 2
    // (skill-catalogue.mjs, ownerConditions available_mp), and manaDry is a
    // generic ten that stands for "not worth casting anything". Between two
    // and nine the world would allow four heals and the round refused them
    // all, which is the difference between a knight who mends his partner
    // and one who watches. Read the cost, not the mood.
    const canHeal = null === mpNow || mpNow >= HEAL_MP;
    // DEEP MANA DRAUGHTS (user lifted the potion ban for these ONLY,
    // 2026-08-15): the whole mana economy was a lock - heals and
    // fireballs starving at zero MP with nothing to refill them but a
    // death. A dry pool with a draught in the satchel drinks it, every
    // other beat so a stale count can never spin a drinking loop.
    // BLEEDING? MEND IT WHERE YOU STAND (2026-08-15, the day the trees
    // started hitting back). Under 45% is a draught if one is carried -
    // the flask is faster than a walk to town and infinitely faster than
    // a death march back from the inn.
    if (null !== hpPct && hpPct < 45 && this.potionsNow > 0) {
      return { action: 'use_item', item: POTION_NAMES[this.potionIndex % POTION_NAMES.length] };
    }
    if (manaDry && this.draughtsNow > 0) {
      this.drinkBeat = !this.drinkBeat;
      if (this.drinkBeat) {
        return { action: 'use_item', item: 'mana draught' };
      }
    }
    // An empty pool on a healthy body is a lifeTap: the Magus trades
    // blood for mana so the fire never stops. Every other beat only,
    // and never while already bleeding. When the KNIGHT stands in the
    // same room the trade turns into an engine - his heal buys the
    // blood back below 60% - so beside him the sovereign tops the pool
    // up early (under half) and from a higher floor (70%), instead of
    // waiting for bone-dry. The Magus cannot conjure food (the world
    // said so, twice); this loop IS his refill.
    {
      const mpPct = null !== mpNow && ownLoc?.mp?.total ? (100 * mpNow) / ownLoc.mp.total : null;
      const knightBeside = 'leader' !== this.options.role && partnerRoom === scene;
      // Two reasons to tap: DESPERATE (pool dry, body healthy enough to
      // bleed at all) and EARLY (knight beside to heal the blood back -
      // top up under half from a comfortable 70% floor).
      // 50, not 55: the pair settled into a lock at ~54% hp / 0 mp -
      // too hurt to tap, too dry to heal - and sat there for two hours
      // (2026-08-14). Five points of margin buys the way out.
      // 70, not 50: lifeTap BUYS mana WITH BLOOD, which was free money
      // while nothing hit back. As of 2026-08-15 the trees retaliate, and
      // a Magus who taps herself to 50% in a fight is handing the forest
      // the last half of him health bar. Only tap from a comfortable
      // position now.
      // SEVENTY WAS RIGHT WHEN THE POOL COULD BE REFILLED ANOTHER WAY. It
      // cannot (user order, 2026-08-26). The cask that refills mana is
      // unreachable upstream (#573: a walk the pathfinder refuses is reported
      // as STOPPED_SHORT, and its own text says the shipped movement fixes do
      // not touch that path), and a Magus has no heal and no feast spell to
      // learn at any level. So the choice is not "tap or refill", it is "tap
      // or fight with the free bolt forever".
      //
      // What that costs, measured: at 0 mana he fires attackBullet for **60**
      // a hit. With mana it is boneSpear for **~320**, five times more, from
      // the same tile. He held level 41 across Sir Qwen going 41 to 44.
      // lifeTap buys 15 mana for 15 hp, and death - which restores him in
      // full and costs neither a level nor a point of experience - is already
      // his only route back to health. Blood is the cheapest thing he owns.
      //
      // The floor stays a floor. Below `tapAboveHpPercent` he stops paying,
      // so a body cannot tap itself into the ground, and the lock this file
      // records ("~54% hp / 0 mp - too hurt to tap, too dry to heal") needed
      // BOTH halves - it cannot close on a character who has no heal to be
      // too dry for.
      const tapFloor = this.options.tapAboveHpPercent ?? 70;
      const desperate = manaDry && null !== hpPct && hpPct >= tapFloor;
      const early = knightBeside && null !== mpPct && mpPct < 50 && null !== hpPct && hpPct >= tapFloor;
      if (this.options.manaSpell && (desperate || early)) {
        this.tapBeat = !this.tapBeat;
        if (this.tapBeat) {
          return { action: 'use_skill', skill: this.options.manaSpell, target: '__self__' };
        }
      }
    }
    // Phoenix: the game currently has no healing at all - no regen, no
    // potions to buy - but death is a free full heal that has never cost
    // a level or a point of XP. A knight parked forever at 15% is worth
    // less than one who hunts, wins or is reborn whole. Below a quarter
    // health, the safety rails that would park him are suspended.
    // No phoenix with the treasury on your back: death drops the cargo,
    // so a laden courier banks before blazing.
    const phoenix = null !== hpPct && hpPct < 25 && this.carryingNow < 5;
    // LATCHED PER TICK, not per re-entry. `died` stays true for as long as
    // the feed reports it, and this branch sits ABOVE the leg switch, so
    // every recursive re-entry used to rewrite the leg to 'resting'. Out
    // of town that is its own loop: 'resting' answers 'homebound' and
    // recurses, this rewrites 'resting', for ever. It stayed quiet only
    // because the world usually carries a body home before the harness
    // reads the death, so the scene is already town - but the gateway sets
    // its died flag synchronously while the room follow is async, and a
    // read inside that window is a guaranteed reconnect storm. Predates
    // this batch; found while hardening the field lock (2026-08-16).
    if (danger?.died && !this.deathHandled) {
      this.deathHandled = true;
      console.log(`[death] died in ${scene}${hp ? ` (hp ${hp.value}/${hp.total})` : ''} - respawn is whole, resting 3 beats`);
      // Death is a breather, not a shopping trip: respawn is whole and
      // the cargo is already spilled, so there is nothing to sell and
      // nothing to buy. Three ticks to collect the crown, then back to
      // the field - the market rites stay behind their flags until a
      // real bank run resets them.
      this.leg = 'resting';
      this.restLeft = 3;
      this.tripDamage = 0;
      this.lastBattleRead = 0;
      this.attacks = ATTACKS_PER_TRIP;
      this.gearTriedThisRest = true;
      this.armorTriedThisRest = true;
      this.shieldTriedThisRest = true;
      // NOT wornThisRest. Every other rite here is a purchase, and a
      // respawn has nothing to sell and no reason to shop - but the line
      // directly below says a reborn body wakes with default fists, and
      // suppressing the equip step is what left it that way. Death is the
      // one moment the pack is certainly out of step with what is worn, so
      // it is the moment equipping matters most, not least. Found while
      // chasing "Sir Qwen can't even equip the Steel Longsword that I am
      // literally looking at" (user, 2026-08-16).
      this.wornThisRest = false;
      this.conjuredThisRest = true;
      this.ateThisRest = true;
      // A reborn body wakes with default fists; re-assert the doctrine.
      this.wantedTactics = this.effectiveBattleStyle(scene);
      // The give-up neither route counter can provide on its own (see
      // cacheInProgress) - two deaths at the same cache writes it off
      // rather than letting the walk-back/arrive cycle commute forever.
      if (this.cacheInProgress) {
        this.cacheDeaths += 1;
        if (this.cacheDeaths >= 2) {
          this.futileCaches.add(this.cacheInProgress);
          this.cacheInProgress = null;
        }
      }
    } else if (danger) {
      if (danger.damage > this.lastBattleRead) {
        this.tripDamage += danger.damage - this.lastBattleRead;
        this.lastBattleRead = danger.damage;
      } else if (danger.damage < this.lastBattleRead) {
        this.lastBattleRead = danger.damage;
      }
    }
    // Hurt, swarmed, or the live bar says under half: turn tail, with the
    // engine's flee style so the body runs instead of trading blows.
    // No retreat, ever: the engine holds a body in the area while a
    // battle runs, so "fleeing" was really door-bashing with extra steps
    // - and death costs nothing here while cowardice costs hunting time.
    // Battles are finished, not left.
    // A partner elsewhere outranks everything but flight: walk to them.
    // While the leader rests in town, the follower rests BESIDE him:
    // marching out alone just to be yanked back by the bond was an
    // endless bounce at the town gate.
    if (
      'leader' !== this.options.role
      && leaderPlan
      && ('resting' === leaderPlan.leg || 'restock' === leaderPlan.leg)
      && TOWN === scene
    ) {
      return { action: 'wait' };
    }
    if (
      this.options.partner
      && 'leader' !== this.options.role
      && partnerRoom
      && 'homebound' !== this.leg
      && 'restock' !== this.leg
      && 'resting' !== this.leg
    ) {
      if (partnerRoom !== scene) {
        // A battle bars every door: something swinging at us dies BEFORE
        // the walk resumes, or the walk is just door-bashing while bleeding.
        if ((danger?.aggressors ?? 0) > 0) {
          return this.strike(ownLoc?.level ?? 0, manaDry, null !== hpPct && hpPct < 75);
        }
        return this.stepToward(scene, partnerRoom);
      }
      // Same room: stand where the partner stands before doing anything
      // else. Shoulder to shoulder is the strategy - shared targets,
      // shared retreats, no one alone in a crowd.
      if (partnerLoc && ownLoc && (partnerLoc.x || partnerLoc.y)) {
        const apart = Math.hypot(partnerLoc.x - ownLoc.x, partnerLoc.y - ownLoc.y);
        // THIRTY TILES, NOT EIGHT (2026-08-15). The old eight-tile bond
        // meant the sovereign spent his life walking: the knight drifts
        // while he hunts, the sovereign closes the gap, the knight drifts
        // again, and the
        // log fills with go_to instead of kills - 16 marching legs to 28
        // fighting ones, at one point seventy tiles apart on a 145-tile
        // field. The forest is harmless (nothing retaliates), so being
        // loosely together while BOTH fight beats being perfectly paired
        // and idle. Only a real separation is worth a walk.
        // TEN TILES, NOT THIRTY (2026-08-15). Thirty was loose enough that
        // the pair fought sixty-five tiles apart and the "bodyguard" never
        // arrived - both died twice in six minutes. Ten is close enough
        // that his heal and his sword reach him fight, and still far
        // enough that he is not walking every beat.
        if (apart > 320) {
          // Every other beat only: a moving leader once turned the whole
          // follower's day into one long walk - zero swings, zero loot.
          // The off-beats hunt and sweep the ground being crossed; a
          // truly distant leader (>640) is chased at full stride.
          this.followBeat = !this.followBeat;
          if (this.followBeat || apart > 640) {
            return { action: 'go_to' as never, target: `${Math.round(partnerLoc.x)},${Math.round(partnerLoc.y)}` } as Intent;
          }
        }
      }
    }
    // ONE FIGHT AT A TIME. More than one thing swinging is not a
    // fight this body chose: measured 2026-08-24, a single
    // arena_basic_attack naming one scuttler opened battles with two
    // OTHERS, and the pile-on took 470 damage against 364 dealt - the
    // exchange a caster loses. Dropping every fight and taking one again
    // next beat is the difference between fighting one thing and giving
    // three of them a free swing each.
    //
    // arena_disengage has no per-opponent form, so this is all or
    // nothing by the gateway's own contract, and the tool warns an enemy
    // notices a body that stays put - the beats after this are a walk,
    // which the hunting leg already does.
    //
    // Thirty seconds between attempts. Without a floor a body that
    // re-aggros on the next tick spends every beat disengaging and none
    // of them fighting, which is a worse failure than the pile-on.
    // Outnumbered is the proxy; LOSING is the thing that matters. A
    // knight with 644 hp and a greatblade wins against two and should
    // keep the fight - and dropping it costs him more than most, because
    // his reach is short enough that the server's own chase is what
    // carries him into range, and a disengage throws that away. A caster
    // at 0.9 hp with a staff loses the same fight. So the rule reads the
    // exchange rather than the head count: more than one swinging AND
    // the bar going the wrong way.
    //
    // Measurable only since hp became readable (see actions.ownSheet).
    // The watch feed dropped `sheet`, so for months this could not have
    // been written at all.
        const losingIt = (danger?.damage ?? 0) > 0
      && null !== hpPct && hpPct < 60;
    if ((danger?.aggressors ?? 0) > 1 && losingIt
      && Date.now() - this.lastDisengageAt > 30_000) {
      this.lastDisengageAt = Date.now();
      return { action: 'disengage' as never } as Intent;
        }

    // Combat medicine on a metronome: the body swings on reflex without
    // being told, so every tick under attack goes to Health instead -
    // king one beat, knight the next, roughly every ten seconds each
    // while the blades work themselves. No health bar needed; being in
    // battle IS the diagnosis. Out of combat, not a drop is wasted.
    if (this.options.healSpell && !this.healBlocked && canHeal && (danger?.aggressors ?? 0) > 0) {
      this.healSelfNext = !this.healSelfNext;
      // The partner gets the heal only when verifiably at arm's length:
      // casting at a name across the map wastes the tick on "there is
      // no such person here". Self is always in range.
      const partnerNear =
        this.options.partner
        && partnerLoc
        && ownLoc
        && partnerLoc.room === scene
        && Math.hypot(partnerLoc.x - ownLoc.x, partnerLoc.y - ownLoc.y) <= 256;
      const partnerPct =
        partnerNear && partnerLoc?.hp && partnerLoc.hp.total > 0
          ? (100 * partnerLoc.hp.value) / partnerLoc.hp.total
          : null;
      // The worse bar drinks first: blind alternation once left the
      // knight at 11% politely mending a barely-scratched king.
      const patient =
        null === partnerPct || (null !== hpPct && hpPct <= partnerPct)
          ? '__self__'
          : this.options.partner!;
      return { action: 'use_skill', skill: this.options.healSpell, target: patient };
    }
    // ROYAL DECREE (2026-08-12): strangers are condemned - but the
    // server nulls open-field blows against players (accepted, zero
    // damage), and striking a wall of "ok" froze the Magus mid-map.
    // The condemned die in the DUEL CIRCLE: prey triggers the taunt and
    // the queue up in npc.ts, and the round hunts on.
    // A subject dying in another room outranks the hunt (never the
    // fight underfoot - the attack-back law below still wins).
    if (
      crisisRoom
      && crisisRoom !== scene
      && 0 === (danger?.aggressors ?? 0)
      && 'restock' !== this.leg
      && 'resting' !== this.leg
    ) {
      return this.stepToward(scene, crisisRoom);
    }
    // The universal law of being attacked: attack back. Anywhere outside
    // town, whatever leg the round is on - traveling, looting, following
    // - a live aggressor converts the tick into violence. Battles bar
    // travel anyway; the only way out has always been through.
    if ((danger?.aggressors ?? 0) > 0 && TOWN !== scene) {
      return this.strike(ownLoc?.level ?? 0, manaDry, null !== hpPct && hpPct < 75);
    }
    // The bottle answers before the prayer: any bar below half with a
    // potion in the bag is a potion drunk - no vendor, no spell, no town
    // required. A knight whose heal still works saves the bottle for the
    // true emergencies below 30%.
    if (null !== hpPct && this.potionsNow > 0) {
      const drinkLine = this.options.healSpell && !this.healBlocked && canHeal ? 30 : 50;
      if (hpPct < drinkLine) {
        this.drinkBeat = !this.drinkBeat;
        if (this.drinkBeat) {
          return { action: 'use_item', item: POTION_NAMES[this.potionIndex % POTION_NAMES.length] };
        }
      }
    }
    // Below half is below half, battle or no battle: the healer mends
    // himself and his partner the moment either bar crosses 50%, on the
    // road, at the door, mid-sweep - anywhere.
    if (this.options.healSpell && !this.healBlocked) {
      if (null !== hpPct && hpPct < 50 && !manaDry) {
        // Interleaved medicine: heal one beat, act the next, so the
        // mending knight still sweeps and swings instead of standing in
        // an invisible casting animation until whole.
        this.healSelfNext = !this.healSelfNext;
        // Below 35% nothing else matters: every beat is a self-heal
        // until the bar climbs clear of the grave.
        if ((hpPct < 35 && null !== mpNow) || this.healSelfNext) {
          return { action: 'use_skill', skill: this.options.healSpell, target: '__self__' };
        }
      }
      const partnerHurt =
        (null === hpPct || hpPct >= 40)
        && !manaDry
        && this.options.partner
        && partnerLoc?.hp
        && partnerLoc.hp.total > 0
        && (100 * partnerLoc.hp.value) / partnerLoc.hp.total < 50
        && partnerLoc.room === scene
        && ownLoc
        && Math.hypot(partnerLoc.x - ownLoc.x, partnerLoc.y - ownLoc.y) <= 256;
      if (partnerHurt) {
        // Every other beat only: a vow that fires every tick once pinned
        // the knight at the town gate for minutes while the market waited.
        this.mendBeat = !this.mendBeat;
        if (this.mendBeat) {
          return { action: 'use_skill', skill: this.options.healSpell, target: this.options.partner! };
        }
      }
    }
    // The healer's vow outranks the hunt: a partner bleeding below 60%
    // gets the heal before anything else this tick. Blocked at the
    // gateway today ("not enabled for MCP control") - the flag clears at
    // every restart so the first arena update that allows casting turns
    // this on by itself.
    if (
      this.options.healSpell
      && !this.healBlocked
      && this.options.partner
      && partnerLoc?.hp
      && partnerLoc.hp.total > 0
      && (100 * partnerLoc.hp.value) / partnerLoc.hp.total < 60
      && partnerLoc.room === scene
      && (null === hpPct || hpPct >= 40)
      && !manaDry
    ) {
      this.mendBeat = !this.mendBeat;
      if (this.mendBeat) {
        return { action: 'use_skill', skill: this.options.healSpell, target: this.options.partner };
      }
    }
    // STAY AND FIGHT (Glenn's standing order, 2026-08-15). While standing in
    // the hunting field, nothing sends this character to another room until
    // it has actually gained a level. The bouncing the spectator sees -
    // "stuttering, trying to exit the map" - is this: the outbound leg walks
    // toward the town door, which sits at COLUMN 3, the far west edge of the
    // forest; hunting then turns the body around and walks it back. The pair
    // spent their evening crossing the boundary instead of fighting. The
    // level they arrived at is the toll for leaving; until it goes up, every
    // travelling leg becomes hunting.
    // Exception (2026-08-15): an unclaimed pilgrimage cache still pulls the
    // body out, level toll or not. The lock above exists to stop repeated,
    // involuntary outbound/homebound/restock thrashing at a level boundary -
    // a chest run is the opposite of that shape, a single bounded errand
    // (chestTries/chestRouteTicks both cap it) that ends the moment the
    // piece is in the bag or the cache is given up on. Letting it through
    // is what gets a field-locked character to a chest at all.
    // ONE LOCAL, READ BY EVERY BLOCK THAT WOULD OTHERWISE FIGHT IT.
    // The lock forces the leg to 'hunting'; the hunting leg's own bank run
    // sets it to 'homebound' and recurses; the recursion re-enters here and
    // is forced back to 'hunting'. Neither side can see the other, nothing
    // between them returns, and no counter moves - so that is not a loop
    // with a slow exit, it is unbounded recursion and a RangeError, which
    // run() catches as a reconnect. The body then never acts, so it never
    // levels, so the lock never lifts: a fifteen-second reconnect storm
    // that only a human can end. It was nearly unreachable while the lock
    // was a one-shot latch spent on the first level-up; re-arming the latch
    // (2026-08-16) is what would have made it fire on every forest visit,
    // and `carrying >= 50` is true within minutes in a room that drops
    // branches. Hoisted so the blocks agree instead of overwriting.
    // A BODY WITH NOTHING LEFT IS NOT GRINDING, IT IS STANDING THERE.
    //
    // Measured 2026-08-25, both royals at once: Lord Gemma on 9 mana of 646 -
    // below `manaDry`, so not one of his arts can fire, and his whole kit is
    // arts - and at 63% hp, which is under lifeTap's 70% floor, so he cannot
    // convert either. Sir Qwen on 130 hp of 724 with 1 mana against a heal
    // that costs 2. Between them 514,000 copper, and a cask that refills a
    // pool for 100.
    //
    // The cure existed and was unreachable. `drink_ale` lives inside the
    // `resting` leg, and these two logged **zero** resting rounds in 900 -
    // because the field lock below forces `homebound` back to `hunting`
    // until the next level. A level toll is the right rule for a bag full of
    // branches and the wrong one for a body that has run out of the thing it
    // fights with, so this sits ABOVE the lock and is the one errand that
    // outranks it.
    //
    // NOT A RETREAT, and the distinction is the standing order ("no running
    // away though, fight to the death"): it refuses to move while anything
    // is still swinging, so a fight is always finished first. It goes when
    // the fighting has stopped and there is nothing left to fight WITH.
    const spentDry = manaDry || (null !== hpPct && hpPct < RECOVER_BELOW_HP_PCT);
    const canRecover = RECOVERY_TRIPS_WORK
      && spentDry
      && this.coinsNow >= 100
      && !this.aleHopeless
      && 0 === (danger?.aggressors ?? 0)
      && Date.now() - this.recoveredAt > RECOVERY_COOLDOWN_MS;
    if (canRecover) {
      if (INN !== scene) {
        if (!this.recoveryAnnounced) {
          this.recoveryAnnounced = true;
          console.log(`[recover] spent (mp dry: ${manaDry}, hp ${null === hpPct ? '?' : Math.round(hpPct)}%)`
            + ` with ${this.coinsNow} copper - walking to the cask`);
        }
        return this.stepToward(scene, INN);
      }
      // ARRIVED. Hand straight over to the `resting` leg rather than pouring
      // the mug here: that path already knows how to buy one, how not to buy
      // a second, and how to leave the inn afterwards, and it is covered by
      // tests that predate this block. This block's whole job is the part
      // that was missing - getting a trapped body out of the field at all.
      this.recoveredAt = Date.now();
      this.recoveryAnnounced = false;
      // The errand earns its own mug even if the last town rest spent one.
      this.drankThisRest = false;
      this.leg = 'resting';
      return this.again(scene, danger, hp, partnerLoc, ownLoc);
    }
    // A TRIP TO GROUND THAT ACTUALLY HAS NODES (2026-08-27, third design).
    //
    // Two earlier versions aimed at the salt veins in Miller's Stair itself,
    // and both failed on the same wall: the veins sit at tile (90,171) while
    // the pair fight around row 10-25, and long in-room travel through this
    // maze does not work. Measured on the live body, aiming straight at the
    // vein with `goTo` owning the route:
    //
    //   go_to 5792,10976 -> did not move from tile 85,25   (five times)
    //
    // He was pinned 146 tiles out and never closed. Meanwhile ROOM-to-room
    // travel works perfectly - it is how both bodies reached Toma in a room
    // neither had ever visited. So the trip uses the mechanism that works.
    //
    // `oathstone` carries wild carrots (foraging 1) and plant fibre
    // (foraging 5), which is the front of Lord Gemma's whole chain: fibre ->
    // thread -> cloth -> every tailoring pattern in the world. Both sheets
    // carry foraging, so both bodies can work it.
    //
    // Sir Qwen's MINING stays blocked for now and that is worth stating
    // plainly rather than papering over: the only level-1 mining nodes are
    // the stair's own seams, and coal at the ford needs mining 5. Until the
    // stair's foot is reachable, his pickaxe earns nothing.
    {
      // PER BODY, NOT GLOBAL (Glenn, 2026-08-27: "a single supervised trip in
      // each area with the resources we need... may need to avoid oathstone
      // for now unless we can quickly grab the materials there before dying").
      //
      // The frontier table settles which room and which body. `oathstone` is
      // level 18 and `sinkfoot-crossing` is 26, so Oathstone is the LOWER bar
      // despite its reputation here - and it holds `oathstone_wild_carrots`,
      // foraging 1, the node everything else in the chain unlocks from.
      // `millrace-ford` is level 10 and safest, but its coal needs mining 5
      // and its other node is fishing, which neither sheet carries.
      //
      // So the trip belongs to Sir Qwen and not to Lord Gemma: 836hp against
      // 633, a heal spell against none. The logs bear it out - Qwen fought a
      // Stoneclaw down to 268/895 and came out at 3hp, and never actually
      // died there; the arrivals that read as lethal were all his.
      // ARRIVE ABLE TO FIGHT (2026-08-27, watched live on the supervised run).
      //
      // `tooHurtToTravel` asks whether the walk can end in MEDICINE, and a
      // body carrying a heal passes it at any health. That is right for the
      // trading post and wrong for this: Sir Qwen set out at **10 hp of 836**,
      // walked into a level-18 room, and met a Stoneclaw at 0.1 tiles on the
      // arrival tile before he could cast anything:
      //
      //   16:55:33 walked into the Oathstone
      //   16:55:34 hp 10/836   Stoneclaw 59/895 at 0.1t
      //   16:55:45 bounced out to the inn
      //
      // A heal is worth something in safety and nothing on a spawn tile. This
      // is what Glenn saw as "they keep going into Oathstone and just dying" -
      // not the room being too hard, but bodies arriving at it already spent.
      //
      // A shopping errand and a journey into contested ground are different
      // errands and must not share a gate. This once read "go whole, or do
      // not go", which was right when the destination was a contested ford
      // across the world and healing was expected to exist. The destination
      // is now the pond in town and nothing heals these two, so the floor is
      // the one every errand uses and the abort at 40% is what protects the
      // body.
      const fitToTravel = null !== this.hpPctNow && this.hpPctNow >= FORAGE_MIN_HP_PCT;
      const wantsForage = true === this.options.foragingTrip
        // NOT ON TOP OF A MINING WALK (adversarial review, 2026-09-04).
        //
        // The trip block sits above the walk block and returns every beat
        // while `seamRun`, and `completed()` counts a gather against BOTH
        // `seamWalkGathers` and `seamGathers` when both are set. So four
        // fish taken in town would log `[seam] done at the seam` and retire
        // a mining walk that never reached ore.
        //
        // This was unreachable while the 75% gate meant the errand fired
        // zero times. Opening the gate is what makes it live, so the guard
        // ships in the same change: mining keeps the walk it is already on.
        && !this.seamWalk
        && fitToTravel
        && !!this.options.professions?.includes('fishing')
        && !this.toolWanted()
        && 0 === (danger?.aggressors ?? 0)
        && !this.tooHurtToTravel()
        && !this.seamBarred
        && !this.roadBarred(scene, this.forageRoom());
      if (wantsForage && !this.seamRun && Date.now() - this.seamAt > MINE_EVERY_MS) {
        this.seamRun = true;
        this.seamBeats = 0;
        console.log(`[seam] setting out for ${this.forageRoom()} to fish`);
      }
      if (this.seamRun) {
        this.seamBeats += 1;
        const bitten = (danger?.aggressors ?? 0) > 0;
        const spent = null !== this.hpPctNow && this.hpPctNow < FORAGE_ABORT_HP_PCT;
        const barred = this.roadBarred(scene, this.forageRoom());
        if (barred || this.seamBeats > SEAM_WALK_BEATS || (bitten && scene !== this.forageRoom()) || spent) {
          // Abandoned only if the ROAD turns dangerous. Arriving to a fight is
          // not a reason to leave - see below.
          this.seamRun = false;
          this.seamAt = Date.now();
          this.seamBarred = this.seamBarred || barred;
          console.log(barred
            ? `[seam] the road to ${this.forageRoom()} is barred - not setting out again`
            : `[seam] giving up the trip after ${this.seamBeats} beats`);
        } else if (scene !== this.forageRoom()) {
          return this.stepToward(scene, this.forageRoom());
        } else if (bitten) {
          // REDUNDANT TODAY, KEPT DELIBERATELY (verified 2026-08-27).
          //
          // The universal fight-back rule above - "anywhere outside town,
          // whatever leg the round is on, a live aggressor converts the tick
          // into violence" - sits at the top of this method, well before this
          // block. So `bitten` is already false by the time control arrives
          // here for any scene that is not town, and this branch does not
          // execute. The ambush handling was correct before this trip existed.
          //
          // It stays because it encodes the RULE rather than relying on the
          // ordering: a trip must never gather while something is biting, and
          // if that fight-back rule is ever narrowed or moved, this is what
          // keeps a body from standing on a patch being eaten. Documented as
          // redundant-but-kept rather than deleted or claimed as load-bearing.
          //
          // FIGHT FIRST, THEN FORAGE (2026-08-27, and the ground taught this).
          //
          // The first arrival at the Oathstone, verbatim:
          //   walked into the Oathstone at 53/836
          //   Oathfield Hopper 573hp *HITTING* at 0.1t
          //   Stoneclaw        895hp *HITTING* at 0.1t
          //   strike back refused: YOU_ARE_DEAD
          //
          // The arrival tile is a spawn camp, and a Stoneclaw carries 895 hp -
          // far heavier than anything in the stair. Abandoning the trip on
          // contact meant the errand could NEVER work contested ground, and
          // every foraging room in this world is contested.
          //
          // So the beat falls through to the ordinary fighting legs while
          // something is on him, and the trip waits. Standing on a patch
          // gathering while a crab eats him would be the other way to get
          // this wrong.
          this.seamBeats -= 1;
        } else {
          // WIDE, because the whole room is the errand. Twelve tiles is the
          // right radius for an opportunistic beat in a 192x176 maze; it is
          // the wrong one for a body that has just crossed the world to work
          // THIS ground. Measured: Sir Qwen reached the Oathstone, looked
          // twelve tiles, saw nothing, and ended his own trip on arrival.
          return { action: 'gather_nearby' as never, wide: true } as Intent;
        }
      }
    }
    // WALK TO THE SEAM IN THIS ROOM. See SEAMS_UNDERFOOT for why this exists
    // and why it is built on hops rather than one long walk.
    //
    // It sits below the universal fight-back rule, so a live aggressor has
    // already converted the beat into violence before control arrives here:
    // the walk is only ever taken through quiet ground, and a fight on the
    // way simply pauses it.
    {
      const seams = (SEAMS_UNDERFOOT[scene] ?? []).filter(
        (n) => true === this.options.professions?.includes(n.skill));
      const quiet = 0 === (danger?.aggressors ?? 0);
      const whole = null !== this.hpPctNow && this.hpPctNow >= SEAM_MIN_HP_PCT;
      const spent = null !== this.hpPctNow && this.hpPctNow < FORAGE_ABORT_HP_PCT;
      if (SEAM_WALK_ON && seams.length && ownLoc && quiet && whole && !this.toolWanted()
        && !this.seamWalk && Date.now() - this.seamWalkAt > SEAM_WALK_EVERY_MS) {
        this.seamWalk = true;
        this.seamWalkBeats = 0;
        this.seamWalkGathers = 0;
        this.seamBest = null;
        this.seamStuck = 0;
        this.seamScene = scene;
        console.log(`[seam] setting off for the ${seams[0].skill} seam in ${scene}`);
      }
      if (this.seamWalk) {
        // WALKED OUT OF THE ROOM IS NOT "GIVE UP" (2026-09-02, measured).
        //
        // The first walk this errand ever took died after NINE beats, and not
        // on any of its own guards: `unstick` fired mid-walk and put Sir Qwen
        // through a door into Barnaby's inn. `SEAMS_UNDERFOOT` is keyed by
        // scene, so the moment he was somewhere else `seams` was empty and
        // `!seams.length` read as "this room has no seam" - which was true of
        // the inn and irrelevant to the errand. Twenty minutes of cooldown
        // then bought nothing.
        //
        // The seam has not moved. Walk back to the room it is in and let the
        // beat and stall counters keep running, so a detour still costs its
        // own guards rather than being free.
        if (null !== this.seamScene && scene !== this.seamScene && !spent
          && this.seamWalkBeats <= SEAM_WALK_MAX_BEATS
          && this.seamStuck < SEAM_STALL_BEATS) {
          this.seamWalkBeats += 1;
          console.log(`[seam] carried out of ${this.seamScene} into ${scene} - walking back`);
          return this.stepToward(scene, this.seamScene);
        }
        if (!seams.length || !ownLoc || spent
          || this.seamWalkBeats > SEAM_WALK_MAX_BEATS
          || this.seamStuck >= SEAM_STALL_BEATS) {
          const wedged = this.seamStuck >= SEAM_STALL_BEATS;
          this.seamWalk = false;
          this.seamWalkAt = Date.now();
          console.log(`[seam] gave up the walk after ${this.seamWalkBeats} beats`
            + `${spent ? ' - too hurt to keep going' : ''}`
            + `${wedged ? ` - no progress in ${this.seamStuck} beats, the road does not go through` : ''}`);
          this.seamBest = null;
          this.seamStuck = 0;
          this.seamScene = null;
        } else if (quiet) {
          this.seamWalkBeats += 1;
          const px = tilePxFor(scene) || PACE_BUCKET_PX;
          const goal = [...seams]
            .map((n) => ({ n, d: Math.hypot(n.x - ownLoc.x, n.y - ownLoc.y) }))
            .sort((a, b) => a.d - b.d)[0];
          // ARRIVED: hand the last stretch to the trade beat, which knows how
          // to pick the node, walk the final tiles and take the charges.
          // CLOSE ENOUGH FOR THE GATHER TO SEE IT, not merely close enough
          // to feel arrived. Handing off at GATHER_WITHIN_TILES (20) put the
          // body 14 tiles out, where the node is not in the observation at
          // all - so every beat answered "nothing within reach", and because
          // the branch returns a gather rather than a step, the walk could
          // never close the gap it was stopping short of. The morning's
          // successful trip took its charges from 1.4 tiles.
          //
          // We hold the seam's own pixel coordinates (SEAMS_UNDERFOOT), so
          // walking the last stretch blind is exact - it does not depend on
          // seeing the node first.
          if (goal.d <= SEAM_ARRIVAL_TILES * px) {
            return { action: 'gather_nearby' as never, wide: true } as Intent;
          }
          // PROGRESS, NOT ACTIVITY. `go_to` answering "got there" is not
          // evidence the body moved - measured 79 identical steps, every one
          // answered "got there", from a body that never left (55,73). The
          // only trustworthy signal is the distance itself falling.
          if (null === this.seamBest || goal.d < this.seamBest - SEAM_PROGRESS_PX) {
            this.seamBest = goal.d;
            this.seamStuck = 0;
          } else {
            this.seamStuck += 1;
          }
          if (0 === this.seamWalkBeats % 10) {
            console.log(`[seam] ${Math.round(goal.d / px)} tiles to the seam`
              + ` (beat ${this.seamWalkBeats} of ${SEAM_WALK_MAX_BEATS}`
              + `${this.seamStuck ? `, ${this.seamStuck} without progress` : ''})`);
          }
          // ASK FOR THE ROAD, NOT THE CROW'S LINE (2026-09-02, and this
          // replaces four failed attempts at the same wall).
          //
          // What was here steered by geometry - clamp the vector to the seam,
          // walk 400px at it - with sidesteps bolted on as each version
          // failed. The record, all measured live in one afternoon:
          //
          //   straight only          "no progress in 12 beats, the road does
          //                           not go through"
          //   sidestep, alternating  tile(28,39)/(28,45)/(28,39) - paced
          //   sidestep, held 4 beats tile 28 -> 54, then 137 -> 166 tiles
          //   sidestep, blended      159 -> 167 tiles, 11 without progress
          //
          // Every one of them was guessing at a fact already in memory:
          // `arena_walkable_grid` hands over the room's whole collision grid
          // and the harness caches it per room. `route_to` gives the entire
          // distance to actions.routeTo(), which searches that grid and aims
          // at a waypoint on a real road.
          //
          // This is NOT `arena_check_path`, which answers PATH_FOUND for
          // tiles the body then refuses to walk (#505, still open). It is our
          // own breadth-first search over data the world already gave us, so
          // it cannot claim a road the grid does not show.
          return { action: 'route_to' as never, target: `${goal.n.x},${goal.n.y}` } as Intent;
        }
      }
    }
    // THE TOOL RUN OUTRANKS THE LEGS (2026-08-27, third live lap).
    //
    // Written first inside `case 'outbound'`, which was the wrong address:
    // outbound HANDS OFF to restock the moment the body reaches town, and
    // restock then walks it to its OWN shop keeper - Wren in the mage's shop
    // for Lord Gemma - carrying it straight out of the trading post it had
    // just crossed the world to stand in. Teaching the scene guards about
    // the room stopped them marching him out; it could not stop restock
    // simply owning him and going somewhere else.
    //
    // So this sits above the switch, beside the recovery errand, and for the
    // same stated reason: it is an errand that outranks whatever leg the body
    // happens to be on, and it ends by itself the moment the tool is aboard.
    //
    // AND IT WAITS FOR ARRIVAL. `walkToSomebody` answers ok while still
    // walking - deliberately, so a bending route is not read as a failure -
    // so buying on the first ok buys from the doorway and the world answers
    // "too far away to trade". Only an arrival ("walked over to") opens the
    // purchase; anything else walks again.
    {
      const tool = this.toolWanted();
      if (tool) {
        if (scene !== TOOL_ROOM) {
          return this.stepToward(scene, TOOL_ROOM);
        }
        if (!this.atKeeper) {
          return { action: 'walk', place: TOOL_KEEPER };
        }
        this.atKeeper = false;
        console.log(`[tool] buying ${tool} from ${TOOL_KEEPER} - ${this.coinsNow} copper in hand`);
        return { action: 'buy', item: tool, quantity: 1 };
      }
    }
    const fieldLocked = FIELD === scene && !this.mayLeaveField()
      && !this.treasureTarget() && !this.toolWanted();
    if (fieldLocked) {
      if ('outbound' === this.leg || 'homebound' === this.leg || 'restock' === this.leg) {
        if (this.leg !== this.lastPinnedLeg) {
          this.lastPinnedLeg = this.leg;
          console.log(`[field-lock] staying put: ${this.leg} refused until level up (level ${this.levelNow}, arrived at ${this.fieldEntryLevel})`);
        }
        this.leg = 'hunting';
      }
    }
    // THE SHRINE ERRAND's one call site (see the shrine block below for the
    // whole of it). Above the partner-follow block on purpose: a follower
    // bleeding out beside a healthy leader would otherwise be yanked toward
    // him every beat and the errand could never take a step - the exact
    // town-gate bounce this file already documents. It never fires with
    // anything still swinging (the errand's own first guard), so the
    // fight-back law below keeps every combat beat; when merging, keep this
    // below the death branch and any tool run.
    {
      const shrineStep = this.shrineErrand(scene, danger?.aggressors ?? 0, true === danger?.died, hpPct, mpNow);
      if (shrineStep) {
        return shrineStep;
      }
    }
    // OFFER THE TRADES ON ANY LEG, not only while hunting.
    //
    // THE MEASUREMENT THAT MOVED THIS (2026-08-27). Both bodies LEAVE
    // `millers-stair` from tile (89,157). Iron ore is at (90,171) and copper
    // at (91,174) - fourteen and seventeen tiles. They have walked past the
    // seam several times an hour for the life of this harness, and the offer
    // was gated to the `hunting` leg, so it was never made. Sir Qwen was
    // logged at tile (94,174), THREE tiles from the copper, on `outbound`,
    // and nothing happened.
    //
    // This is why the deliberate 250-beat walk above is switched off. The
    // body does not need to be taken to the seam. It already goes.
    //
    // BELOW THE TOOL RUN, DELIBERATELY. Placed above it, a body that has
    // lost or never bought its pickaxe stops to offer for ore it cannot
    // work, every beat, instead of walking to the counter that sells the
    // tool - `gatherNearby` does not check the pack. The suite caught this
    // immediately: "CONTROL: no knife, no trip - the tool run comes first".
    //
    // It costs nothing to ask: `gatherNearby` filters the observation
    // already in hand and answers without calling the world when nothing is
    // near. It sits below the universal fight-back rule, so a body being hit
    // is fighting, not stooping - and only in FIELDS, so no beat is ever
    // spent asking a shop counter for ore.
    // COUNTED BEFORE IT IS TESTED. The increment used to sit further down,
    // below several early returns, so the beat that offered never counted
    // itself and neither did the beats that left early - the counter was
    // reset before it could accumulate. Incrementing here is what lets the
    // period actually mean one beat in N.
    this.sinceGather += 1;
    if (GATHER_EVERY_N_BEATS > 0
      && FIELDS.includes(scene)
      && 0 === (danger?.aggressors ?? 0)
      && this.options.professions?.length
      && this.sinceGather >= GATHER_EVERY_N_BEATS) {
      this.sinceGather = 0;
      return { action: 'gather_nearby' as never } as Intent;
    }

    switch (this.leg) {
      case 'outbound': {
        // GEAR PILGRIMAGE (user order 2026-08-14): before the grind,
        // claim every unclaimed Old Jerr cache - the only boots,
        // gauntlets and helmets in the game. Both royals walk the same
        // list in the same order, so the pair travels together without
        // any extra coordination; ownership read off the live pack ends
        // each detour the moment the piece is in the bag.
        {
          const cache = this.treasureTarget();
          if (cache) {
            // A death at the cache resets BOTH give-up counters against each
            // other - chestTries zeroes on the walk back (not in the room),
            // chestRouteTicks zeroes on arrival (in the room) - so neither
            // one ever reaches its cap and Grassland's boar becomes an
            // unbounded death loop (found in review, 2026-08-15, before this
            // shipped). Count deaths per cache instead, keyed so a new
            // target always starts clean.
            if (cache.title !== this.cacheInProgress) {
              this.cacheInProgress = cache.title;
              this.cacheDeaths = 0;
              this.chestTries = 0;
              this.chestRouteTicks = 0;
            }
            this.pilgrimageEquip = true;
            if (scene === cache.room) {
              this.chestRouteTicks = 0;
              this.chestTries += 1;
              if (this.chestTries > 10) {
                this.futileCaches.add(cache.title);
                this.chestTries = 0;
                return this.again(scene, danger, hp, partnerLoc, ownLoc, leaderPlan, victim, crisisRoom, carrying);
              }
              return { action: 'open_chest' as never, target: cache.title } as Intent;
            }
            this.chestTries = 0;
            this.chestRouteTicks += 1;
            if (this.chestRouteTicks > 60) {
              this.futileCaches.add(cache.title);
              this.chestRouteTicks = 0;
              return this.again(scene, danger, hp, partnerLoc, ownLoc, leaderPlan, victim, crisisRoom, carrying);
            }
            return this.stepToward(scene, cache.room);
          }
          this.chestRouteTicks = 0;
          // The last hasp worked: wear the winnings now rather than at
          // the next rest, which could be half an hour of bare feet away.
          if (this.pilgrimageEquip) {
            this.pilgrimageEquip = false;
            return { action: 'equip_best' as never } as Intent;
          }
        }
        // A leader does not march out alone: it waits at the town gate
        // until the partner is in the same room, then they go together.
        // A partner missing from the feed entirely means hunt solo rather
        // than deadlock on a ghost. And a partner ALREADY STANDING at
        // the destination is not someone to wait for - the rally sends
        // the follower to where the leader is GOING, so waiting in town
        // for the king while he waited at the crypt for the knight deadlocked the
        // pair on opposite sides of the grassland for six straight
        // minutes. He is there; walk.
        {
          const top = this.topFields();
          const marchingTo = top[this.fieldIndex % top.length];
          if (
            !phoenix
            && 'leader' === this.options.role
            && this.options.partner
            && partnerRoom
            && scene === TOWN
            && partnerRoom !== TOWN
            && partnerRoom !== marchingTo
          ) {
            return { action: 'wait' };
          }
        }
        // Any hunting ground underfoot will do - a follower often arrives
        // wherever the leader chose rather than its own pick.
        // Only the TOP grounds are worth swinging in - standing in a
        // lesser field because the walk happened to start there is how a
        // L30 knight ground the played-out grassland for hours while the
        // crypt sat one door away. Anything below the top two is a road,
        // not a hunting ground.
        if (this.topFields().includes(scene)) {
          this.leg = 'hunting';
          this.attacks = 0;
          this.tripDamage = 0;
          this.lastBattleRead = 0;
          this.advanceCount = 0;
          this.wantedTactics = this.effectiveBattleStyle(scene);
          return this.again(scene, danger, hp, partnerLoc, ownLoc);
        }
        {
          // The richest unlocked ground pays the war chest: branches in
          // the starter forest are worth ~1c while higher territories
          // drop real wares. Grind the BEST field by default; the index
          // only leaves it when futile strikes prove it empty.
          const top = this.topFields();
          return this.stepToward(scene, top[this.fieldIndex % top.length]);
        }
      }
      case 'hunting': {
        // Swinging at something the pathfinder cannot reach 'succeeds'
        // forever and starts no battle - a knight spent an evening
        // parked at the bridge attacking across the river. Eight empty
        // swings with no battle payload means the spot is a lie: walk
        // away and work the other field.
        // FUTILE MEANS "NOTHING LANDED", NOT "NOTHING HIT ME" (2026-08-16).
        // This used to reset on aggressors alone, which asks whether
        // something is currently swinging at US - a different question, and
        // one that is structurally unanswerable in a room authored
        // aggressive:false whose enemies die to a single hit: nothing there
        // ever opens a fight, and the engine only starts one when the
        // target SURVIVES, so the counter could never reset and the round
        // bailed after four ticks on every visit. That made every passive
        // room permanently unhuntable - the whole gold half of the world -
        // while the forest worked only because its Tree Punch were made
        // aggressive. A landed hit or a kill is the honest signal that this
        // ground is worth standing on, so read that too.
        if ((danger?.aggressors ?? 0) > 0 || true === danger?.landed) {
          this.futileStrikes = 0;
        } else if (!fieldLocked && this.futileStrikes >= 4) {
          // Guarded on fieldLocked for the same reason the bank run below
          // is: this sets 'outbound' and recurses into a lock that would
          // force it straight back. It survives today only because the
          // counter is zeroed first, so the recursion cannot re-enter this
          // branch - one edit away from being the same crash.
          // The counter deliberately keeps COUNTING while pinned, and that
          // is not stale evidence: it is a streak, zeroed above on any
          // aggressor or landed hit, so a value of four when the lock
          // lifts means the last four-plus beats landed nothing - an
          // honest, current reading of the ground rather than something
          // carried over from the pin.
          this.futileStrikes = 0;
          this.fieldIndex += 1;
          this.leg = 'outbound';
          return this.again(scene, danger, hp, partnerLoc, ownLoc, leaderPlan, victim, crisisRoom, carrying);
        }
        // A full bag is a bank run: dying loses the cargo, and the
        // cargo is the gear fund. Sell, then hunt on. An affordable
        // upgrade on the counter is ALSO a bank run - the purse exists
        // to be spent the moment the next rung comes into reach, not on
        // a cargo timer. Once bought, the wish is owned and this stops
        // firing, so it never re-creates the old every-rest shopping.
        // The pair banks TOGETHER (user order: never separated): a
        // follower holds his cargo until the leader is also town-bound,
        // unless the bag is critically full - a lone sovereign walking
        // the whole route to Gimly while the knight fought on was the
        // main way the two lost each other.
        {
          // An empty flask pocket on a dry pool is a bank run too (the
          // draughts exception, 2026-08-15): without this, the approved
          // mana bottles only got bought whenever cargo happened to
          // fill, which left both royals dry for the hour in between.
          const flasksGone =
            0 === this.draughtsNow && this.coinsNow >= 2000 && null !== mpNow && mpNow < 10;
          // FIGHT FIRST, BANK LATER (user order 2026-08-15: stay in the
          // forest and keep fighting until you level). Fifty sellables is
          // a full bag, not a mid-fight errand; the counter still opens
          // the moment a real upgrade is affordable.
          // The forest RETALIATES now (Tree Punches hit back as of
          // 2026-08-15), so every walk to town is a walk through damage.
          // Only a genuinely full bag is worth it; gear money can wait
          // for that trip, and an empty flask pocket only counts when
          // the pool is dry AND the bag is already worth carrying.
          // FIGHT UNTIL YOU LEVEL (user order, twice). Branches stack fast
          // and a 50-item bag was sending them to town every few minutes -
          // through a forest that now bites - instead of grinding. Only an
          // overflowing bag or actual gear money is worth the walk.
          // BRANCHES ARE WORTHLESS - MEASURED, 2026-08-15. Both royals
          // sold roughly 150 branches each and their coin totals did not
          // move by a single copper (1583 and 7648 before and after). So
          // a bank run costs a walk across a forest that now kills, and
          // earns nothing; meanwhile each death costs ~280 coins. The
          // only trip worth making is one that ends in a real upgrade.
          const wantsBank = this.affordableUpgrade();
          const leaderTownBound =
            !leaderPlan
            || 'homebound' === leaderPlan.leg
            || 'restock' === leaderPlan.leg
            || 'resting' === leaderPlan.leg;
          const following = 'leader' !== this.options.role && !!this.options.partner;
          // Fifty sellables is a full bag - true for either role, not just
          // a follower. A leader gated on wantsBank alone never goes home
          // below L35 (openRungs() now returns nothing to want), so mustBank
          // is what still pulls a below-L35 leader in to sell (2026-08-15).
          // A full bag orders a bank run - unless there is nothing to bank
          // at. Walking home to be refused is worse than a full bag: it
          // costs the whole grind and gains nothing.
          // ONE TOWN TRIP PER LEVEL (Glenn, 2026-08-24), for both halves of
          // it: sell what cannot be worn or used, buy what the ladder opened,
          // and then stay out. A full bag is not a reason on its own - the
          // bag is always full, because a body loots faster than any counter
          // will take, so keying the trip on the bag means going constantly.
          //
          // A level is the only thing that changes what a trip is WORTH: it
          // is what opens a new rung, and it is the unit the round already
          // records against. shoppedAtLevel is stamped on arrival at a
          // counter (see the [shop] line), so a trip counts whether or not
          // it ended in a sale - a trip that sold nothing is exactly the one
          // that must not repeat.
          //
          // A body that cannot read its level keeps the old rule rather than
          // never going: the gate is a refinement, not a prerequisite.
          const shoppedThisLevel = null !== this.levelNow
            && this.shoppedAtLevel === this.levelNow;
          const mustBank = this.carryingNow >= 50
            && !this.nothingBuys()
            && !shoppedThisLevel;
          // `!fieldLocked` is what stops this recursing against the field
          // lock forever - see the note where fieldLocked is computed. A
          // locked body may not bank, however full the bag; the lock lifts
          // on the next level and the bank run happens then.
          // NO ERRANDS AT DEATH'S DOOR WITH AN EMPTY MEDICINE CABINET
          // (2026-08-27). Measured, line by line: Lord Gemma at **4 hp of
          // 620** left the stair, walked the valley, walked THROUGH the inn
          // past Barnaby's cask, stood in the mage's shop, rested four ticks,
          // and walked back into the maze still at 4/620. Two and a half
          // minutes of earning spent, nothing healed, and he was returned to
          // the fight one hit from death.
          //
          // Nothing there could have helped him. The drink gate needs
          // `potionsNow > 0` and he carries none; `feastSpell` and `healSpell`
          // are not in a Magus's class path at any level; the ale is gated on
          // manaDry, not on hp, so the inn's one medicine never arms for a
          // bleeding body. The trip was doomed before the first step.
          //
          // Death is his only full restore and it is free. So when the bar is
          // this low and there is genuinely nothing to buy, drink or cast, the
          // errand is strictly worse than standing and fighting: same death,
          // plus a three-minute detour, and it RECURS on every dip. Bank when
          // he can survive the walk. This is the same rule
          // RECOVERY_TRIPS_WORK encodes - do not attempt a cure that cannot
          // end in medicine.
          // ONE DOOR, ONE LOG (2026-08-27, adversarial review).
          //
          // A second copy of the medicine-cabinet guard used to sit right
          // here, and it defeated the very instrument it sat next to: by
          // swallowing the mustBank/wantsBank trips BEFORE goHome was ever
          // called, it produced neither a `[leg] homebound:` line nor the
          // chokepoint's `[errand]` line. Six silent doors are what made the
          // real trigger unreadable for three sessions; a seventh silent
          // swallower upstream re-created that hole for exactly the two
          // triggers we CAN name. It also carried its own once-per-process
          // `saidTooHurtToShop` latch against the chokepoint's per-trip one,
          // so one message class had two dedupe disciplines.
          //
          // The decision has not moved, only its address: this asks whether
          // the errand is WANTED, and goHome() decides whether it is ALLOWED.
          if (!fieldLocked
            && (following ? mustBank || (wantsBank && leaderTownBound) : mustBank || wantsBank)) {
            // Name WHICH errand. The two triggers share a door and have
            // completely different cures - a full bag is cargo and clears
            // itself, an affordable upgrade is a rung this body has never
            // owned and will want again every single beat until it does.
            // Lord Gemma's is the second: he wears spidersilk robes (L15)
            // while CASTER_ARMOR's top rung, the sepulchral vestment (L35),
            // has sat unowned since he passed 35 - so `unownedRungs()` is
            // NOT empty for him, contrary to the reading this file carried
            // for a day, and `wantsBank` is live at every level past it.
            const why = mustBank
              ? 'errand - a full bag to bank'
              : 'errand - a gear rung he can afford';
            if (this.goHome(why)) {
              return this.again(scene, danger, hp, partnerLoc, ownLoc, leaderPlan, victim, crisisRoom, carrying);
            }
          }
        }
        // THE PACK, once the leg is settled and the body is staying out.
        // A bag of 231 rows is not a housekeeping problem, it is a
        // blindness problem: `carrying` alone was two thirds of the bytes
        // an arena_observe reply is allowed (33,861 of 49,150, against a
        // real payload of 353,661), so the reply was cut mid-object and the
        // last enemy arrived with a label and no tileX. closeOn() turned
        // that into NaN and the gateway refused the move.
        //
        // Deliberately AFTER the bank run above rather than before it: this
        // returns an intent without deciding a leg, so ahead of those
        // transitions it simply stopped them happening. Deliberately in the
        // field rather than in town, because the town trip is the very
        // thing that stops once nothing will buy.
        // On a timer, NOT on carryingNow. That count is read from the
        // observe reply's `carrying` - the very field the overflowing pack
        // truncates away, so a bag too big to read reports no bag at all
        // and the sweep that would fix it never fires. Measured 2026-08-24:
        // with 231 rows the round saw no carrying figure whatsoever.
        // discardJunk() reads arena_inventory itself, which is a separate
        // call with its own byte budget, and returns "nothing worth
        // destroying" when the pack is clean - so an idle sweep is one
        // cheap call a minute, and a needed one cannot be missed.
        // THREE MINUTES, not forty-five seconds, and a small batch.
        //
        // The sweep was written when a pack held about 1,627 rows and the
        // reply that carried it was cut by the byte cap, which is what blinded
        // the body in the first place. That is fixed: both packs now fit under
        // the cap and read whole. What is left is upkeep, and upkeep must not
        // outbid the fight - a forty-row sweep is its own gateway call per
        // row, so at forty-five seconds it was taking a beat in four away
        // from closing on an enemy, measured 2026-08-24 while the nearest
        // Groove Grub sat ten tiles off and stayed there.
        if (Date.now() - this.lastPurgeAt > 180_000) {
          this.lastPurgeAt = Date.now();
          return { action: 'discard_junk' as never } as Intent;
        }
        // The third site of the same fight, and the one that was still
        // live: the lock forces 'hunting', this finds the forest is not a
        // top field and answers 'outbound', the lock forces it back. Most
        // reachable for a FOLLOWER, whose topFields() is the leader's room
        // alone - so a leader working the grassland while he stands
        // field-locked in the forest is the crash, and a leader RESTART is
        // what produces it, since leaderDest is never cleared and his
        // rally goes stale after a minute. A locked body has nowhere to
        // go anyway; let it work the ground it is pinned to.
        if (!fieldLocked && !this.topFields().includes(scene)) {
          this.leg = 'outbound';
          return this.again(scene, danger, hp, partnerLoc, ownLoc);
        }
        // EVERY BEAT OFFERS THE TRADES. Offered here, in the hunting leg,
        // because that is where the body spends its time and because a node
        // in the room costs one beat while a node in another room costs a
        // journey - and because the offer reads an observation already in
        // hand, so a beat with no node near it costs nothing at all. See
        // GATHER_EVERY_N_BEATS for the measurement that retired the counter. `gather_nearby` is an OFFER, not an order:
        // the harness answers it with "nothing here to gather" whenever no
        // allowed node is within reach, and the beat falls through to the
        // fight. Nothing is walked for. Nothing is waited on.
        if (this.attacks >= ATTACKS_PER_TRIP) {
          this.leg = 'looting';
          this.lootMisses = 0;
          this.lootRun = 0;
          return this.again(scene, danger, hp, partnerLoc, ownLoc);
        }
        // A leader hunts beside its partner or not at all - for a while.
        // Eight ticks of patience covers a follower's walk from anywhere
        // on the route; past that, the hunt goes on alone rather than
        // standing forever over an empty field.
        {
          const apart =
            partnerLoc && ownLoc && partnerRoom === scene
              ? Math.hypot(partnerLoc.x - ownLoc.x, partnerLoc.y - ownLoc.y)
              : null;
          const partnerAway = partnerRoom !== scene || (null !== apart && apart > 320);
          if (
            'leader' === this.options.role
            && this.options.partner
            && partnerRoom
            && partnerAway
            && this.waitTicks < 9999
          ) {
            this.waitTicks += 1;
            // Same room or different, apart is apart: STAND AND WORK.
            // The leader walking to the partner's position while he
            // walked to his - both aiming at seven-second-old feed
            // coordinates - swapped the pair across the deep wood for
            // an hour without one sword swing (2026-08-14 evening).
            // The follower's chase is the ONLY closer: he comes to
            // him at full stride while he cuts whatever stands within
            // reach of where he already is.
            return this.waitTicks % 2 === 0
              ? { action: 'pick_up' }
              : { action: 'attack', target: '__nearest__' };
          }
          if (!partnerAway) {
            this.waitTicks = 0;
          }
        }
        this.attacks += 1;
        this.sinceGather += 1;
        this.futileStrikes += 1;
        // '__nearest__' is resolved by the executor to whatever enemy is
        // actually closest, inside the leash. Chasing a preferred name
        // across the field was the aggro train.
        const target = '__nearest__';
        const beat = this.attacks % 5;
        if (1 === beat) {
          return { action: 'approach' as never, target } as Intent;
        }
        // Two sweep beats per cycle: a branch left lying is gear money
        // thrown away, and the reflex body keeps swinging regardless.
        if (0 === beat || 3 === beat) {
          this.futileStrikes += 1;
          return { action: 'pick_up' };
        }
        if (!this.spellBlocked && !manaDry) {
          // Every fighting beat is a casting beat: the body swings steel
          // on reflex regardless, so the spell is pure extra violence.
          const level = ownLoc?.level ?? 0;
          const earned = earnedRung(this.options.skillLadder, level);
          const art =
            null !== hpPct && hpPct < 75 && this.options.drainSpell
              ? this.options.drainSpell
              : earned?.skill ?? this.options.spell;
          if (art) {
            return { action: 'use_skill', skill: art, target };
          }
        }
        return { action: 'attack', target };
      }
      case 'looting': {
        if ((danger?.aggressors ?? 0) > 0) {
          // Something interrupted the sweep; kill it, then keep sweeping.
          return this.strike(ownLoc?.level ?? 0, manaDry, null !== hpPct && hpPct < 75);
        }
        if (this.lootRun >= LOOT_RUN_CAP) {
          // A SWEEP HAS TO END EVEN WHEN IT IS WORKING. The miss counter
          // below ends a bare sweep; this ends a rich one. Without it a floor
          // that always pays keeps a body stooping for ever, and stooping
          // earns coin but no experience - the whole difference between the
          // pair. Measured over the same 181 minutes: Lord Gemma, who splits
          // 159 looting to 117 hunting, took 10,272 xp; Sir Qwen, who never
          // left looting, took 5,247. The coin is not in question - his purse
          // is 191k - so this deliberately keeps the sweep long enough to
          // clear what a fight drops, and merely refuses to let it be the
          // whole day.
          this.lootRun = 0;
          this.lootMisses = 0;
          this.leg = 'hunting';
          this.attacks = 0;
          return this.again(scene, danger, hp, partnerLoc, ownLoc);
        }
        if (this.lootMisses >= 3) {
          // STAY AND FIGHT (user order 2026-08-15). An empty floor is a
          // reason to swing, never a reason to walk to town: three
          // fruitless stoops used to end the trip and send the body home
          // across the whole forest. Back to hunting instead.
          this.lootMisses = 0;
          this.leg = 'hunting';
          this.attacks = 0;
          return this.again(scene, danger, hp, partnerLoc, ownLoc);
        }
        return { action: 'pick_up' };
      }
      case 'homebound': {
        // A battle in progress bars every door. Finish it: whatever is
        // still swinging at us dies before we travel.
        if ((danger?.aggressors ?? 0) > 0 && FIELDS.includes(scene)) {
          return this.strike(ownLoc?.level ?? 0, manaDry, null !== hpPct && hpPct < 75);
        }
        if (scene === TOWN) {
          this.leg = 'restock';
          this.walkedToShop = false;
          this.soldThisRest = false;
          this.sellSkip.clear();
          this.sellsThisRest = 0;
          this.potionBuysThisRest = 0;
          this.gearTriedThisRest = false;
          this.gearTryOffset = 0;
          this.armorTriedThisRest = false;
          this.armorTryOffset = 0;
          this.shieldTriedThisRest = false;
          this.stoodDownThisRest = false;
          this.drankThisRest = false;
          this.conjuredThisRest = false;
          this.ateThisRest = false;
          this.wornThisRest = false;
          // Back to the BEST ground after every rest (user order: grind
          // the crypt). The old next-trip-next-ground rotation spread
          // the pair thin across played-out fields; now only futile
          // strikes push the index off the top rung, and a town rest
          // pulls it back.
          this.fieldIndex = 0;
          return this.again(scene, danger, hp, partnerLoc, ownLoc);
        }
        return this.stepToward(scene, TOWN);
      }
      case 'restock': {
        // The shop room counts as being home. Without this the leg bounced:
        // crossing into the smithy left scene !== TOWN, which threw the round
        // back to 'homebound', which walked it straight out of the shop it
        // had just entered - and round again, for ever.
        const shopRoom = this.options.shopRoom;
        // THE TOOL COUNTER IS HOME GROUND TOO, WHILE A TOOL IS WANTED
        // (2026-08-27, first live run of the errand).
        //
        // This is the smithy bounce verbatim, one room over. The comment ten
        // lines above records Sir Qwen crossing into the smithy, standing a
        // tile from Nerys with 47,695 copper, and being bounced out before
        // the buy branch - round and round, all evening - because the smithy
        // was neither TOWN nor his shopRoom. Lord Gemma's shopRoom is the
        // mage's shop, so the trading post read as foreign ground in the very
        // room the tool errand had just walked him across the world to reach.
        //
        // Teach the guard the ROOM, not the leg. That is what lasted last
        // time: a body standing at the counter it made a journey for must be
        // allowed to finish, and the moment the tool is in the bag
        // `toolWanted()` answers null and this closes again by itself.
        if (scene !== TOWN && scene !== shopRoom
          && !(TOOL_ROOM === scene && this.toolWanted())) {
          this.goHome('restock outside town or the shop room - walking back');
          return this.again(scene, danger, hp, partnerLoc, ownLoc);
        }
        // WEAR IT FIRST (user, 2026-08-16: "Sir Qwen can't even equip the
        // Steel Longsword that I am literally looking at"). This used to
        // live at the far end of the 'resting' leg, behind the whole sell
        // queue - and that queue is up to 30 calls at ~20s each, because
        // branches arrive one row per unit and a farming run brings back
        // well over a hundred. So a sword picked up in the field waited
        // twelve-plus minutes to go on, and any rest cut short by a bank
        // run or an ambush meant it never went on at all. Equipping needs
        // no merchant, costs nothing and takes one tick, so it belongs at
        // the top of the town visit where nothing can crowd it out.
        if (!this.wornThisRest) {
          this.wornThisRest = true;
          return { action: 'equip_best' as never } as Intent;
        }
        // CROSS TO THE COUNTER. Everything below this point - the estate
        // sale, the gear buys - talks to a trader, and a trader that is one
        // room away answers every single call with "too far away to trade".
        // So the door comes first, then the walk to the keeper, then trade.
        if (shopRoom && scene !== shopRoom) {
          return this.stepToward(scene, shopRoom);
        }
        if (!this.walkedToShop) {
          this.walkedToShop = true;
          // The keeper by name, not a fixed coordinate: walkToSomebody()
          // reads the live object list, so this survives the shopkeeper
          // being nudged a tile in a future map pass.
          return { action: 'walk', place: this.options.shopKeeper ?? 'Gimly' };
        }
        // ESTATE SALE (user order 2026-08-15: "do a much better job
        // earning money"): spare arms and shop-sanctioned valuables that
        // are neither duel steel nor bows, sold by EXACT key - the
        // fuzzy-substring disasters came from generic names in a list,
        // never from a full key naming one item. Worn gear is
        // sale-protected by the shop itself. One ask per key per
        // session; ownership is read off the live pack.
        {
          // Strictly-inferior spares and pure materials ONLY. NEVER the duel
          // steel (wide_blade), never the bow (ash_longbow, wanted the day a
          // ranged zone pays), never a treasure keepsake - "sell what cannot
          // be equipped or used" does not mean "sell the kit".
          // Nothing at all is offered once the world has shown it has no
          // buyer. Learning that stopped the body LEAVING the field to bank
          // (see mustBank), but the leg still ran its whole routine once it
          // was in town anyway, so the shuttle simply moved indoors:
          // restock, six refusals at Nerys, resting, restock again
          // (measured 2026-08-24). A counter that buys nothing is not a
          // counter worth standing at.
          const junk = this.nothingBuys() ? undefined
            : ['iron_sword', 'stone_maul', 'axe', 'warded_seal', 'bone_shard', 'buried_skull'].find(
              (key) => !this.junkTried.has(key) && this.ownsGear(key.replace(/_/g, ' '))
            );
          if (junk) {
            this.junkTried.add(junk);
            return { action: 'sell', item: junk, quantity: 1 };
          }
        }
        if (!this.soldThisRest) {
          // Sell whatever is actually in the pack and fits none of the
          // protected jobs (money, equipment, or a consumable) - not a name
          // list, because a farming route drops far more than any fixed
          // list names, and everything protected is already excluded at
          // the source (sellableItems(), backed by isCargo() in
          // actions.ts) - coins are the one thing that never appears here.
          // The tarnished key does now: agentArena #114 confirmed
          // 2026-08-15 that it opens no door in the game, so it is vendor
          // trash worth a 300-currency sale like anything else, not
          // something worth carrying. The real owned quantity goes in
          // every call, so a row the gateway genuinely reports stacked
          // clears in one sell - but branches do not arrive stacked, so a
          // bag with 198 of them is 198 rows and 30 sells this rest clears
          // 30 of them, not all. sellsThisRest is the real limit that fact
          // leans on, not a rare backstop. An empty result means nothing
          // sellable remains right now, not that the bag was ever empty.
          const toSell = 30 > this.sellsThisRest && !this.nothingBuys()
            ? this.sellablesNow.find((it) => !this.sellSkip.has(it.key))
            : undefined;
          if (!toSell) {
            this.soldThisRest = true;
          } else {
            this.sellsThisRest += 1;
            return { action: 'sell', item: toSell.key, quantity: toSell.quantity };
          }
        }
        this.leg = 'resting';
        this.restLeft = REST_TICKS;
        return this.again(scene, danger, hp, partnerLoc, ownLoc);
      }
      case 'resting': {
        // THE SHOP ROOM IS HOME HERE TOO. Every purchase this round makes
        // happens further down this leg, and the counter it buys from is
        // inside a building - so a guard that only accepts `the-valley`
        // ejects the character from the shop on the very tick it was about
        // to spend, walks it back out of the door, and returns it to restock
        // to sell nothing and try again.
        //
        // Measured 2026-08-21: Sir Qwen crossed into the smithy, walked to
        // Nerys, stood one tile from him with 47,695 copper, sold six things
        // he would not buy, and was then bounced out before the buy branch.
        // Round and round, all evening. `restock` above was taught about
        // shopRoom and this leg was not; the [shop] line that would have
        // said so never printed, because it lives past this guard.
        if (scene !== TOWN && scene !== this.options.shopRoom && INN !== scene
          && !(TOOL_ROOM === scene && this.toolWanted())) {
          this.goHome('resting outside town - walking back');
          return this.again(scene, danger, hp, partnerLoc, ownLoc);
        }

        // A DRY POOL IS WORTH THE WALK, unlike a full bag. Barnaby's cask
        // restores mp to base_value for 100 copper (inn-ledger.js
        // SERVICE.ale), and both of these carry thousands, so a mug is the
        // cheapest thing either will ever buy and the only one that changes
        // what they can do in a fight.
        //
        // Measured 2026-08-24, why it matters: eleven of Sir Qwen's twenty
        // logged events in half a minute were skill_cast_failed on
        // thornwhip, whose condition is stats/mp >= 13 against a pool of 0.
        // Lord Gemma is a Magus whose ladder is nothing but arts, meleeing
        // at 0.8 tiles because manaDry sends strike() past every cast. This
        // is the difference between the pair fighting and flailing.
        //
        // Once per rest: `drankThisRest` clears with the other per-rest
        // flags, so a refusal costs one attempt rather than an inn loop.
        if (manaDry && !this.aleHopeless && !this.drankThisRest && this.coinsNow >= 100) {
          if (INN !== scene) {
            return this.stepToward(scene, INN);
          }
          this.drankThisRest = true;
          return { action: 'drink_ale' as never } as Intent;
        }
        // Having drunk, get back out of the inn rather than resting in it.
        if (INN === scene) {
          this.goHome('left the inn after the cask');
          return this.again(scene, danger, hp, partnerLoc, ownLoc);
        }

        // Potions priced like relics are no way to fund a war: nothing is
        // bought at this counter except the best weapon on the board. Any
        // bottle already in the bag still gets drunk when the bar drops.
        if (null !== hpPct && hpPct < 60 && this.potionsNow > 1) {
          return { action: 'use_item', item: POTION_NAMES[this.potionIndex % POTION_NAMES.length] };
        }
        {
          // Ownership is read off the actual pack every tick, so a death,
          // a restart, or a sale never desyncs the ledger. openRungs() now
          // returns only the ladder's own top tier (2026-08-15), so this
          // never wishes for anything below it - moving between two L35
          // rungs on one ladder (a bow and a blade) once the first is
          // owned, never falling to a cheaper one on a refusal. The shield
          // is its own slot and wanted exactly once, and armour climbs its
          // own ladder the same way the weapon does. Below level 35 this
          // returns nothing at all - a L35 blade wished at L30 is 180c the
          // counter will only refuse, so it is not even attempted.
          // Every buy below re-arms the equip step (wornThisRest = false).
          // The wear now happens at the TOP of 'restock', which is upstream
          // of this counter, so without this a character would hand over
          // 190 coins for the L35 blade and walk out still holding the old
          // one - the flag already spent on gear it owned before the sale.
          // A purchase is by definition new kit, so it re-opens the step
          // that puts kit on. Asked outright by the user (2026-08-16):
          // "question is whether he'll even be able to equip it".
          const weaponRungs = this.unownedRungs(this.openRungs(this.options.gearLadder ?? SWORD_GEAR));
          // WHY NOTHING WAS BOUGHT. A character with 21,275 copper and a
          // standing order for an 18,000 blade walked out of the shop with
          // it unbought, and nothing in the log said why - openRungs()
          // returns [] below level 35 and unownedRungs() returns [] when the
          // pack already holds the rung, and both look identical from
          // outside: no purchase, no error, no line. `levelNow` comes from
          // the watch feed and is null until that feed reports a level, and
          // `?? 0` then silently fails the gate for ever. Print the three
          // values that decide it, once per rest, rather than guess again.
          console.log(`[shop] level ${this.levelNow ?? 'unknown'}, coins ${this.coinsNow}, wants ${weaponRungs.length ? weaponRungs.map((r) => r.buy).join('/') : 'no weapon'}`);
          // Reaching the counter is the trip. Record it here rather than on
          // a purchase: a trip that ends in "nothing to buy" is exactly the
          // one that must not be repeated at the same level.
          if (null !== this.levelNow && this.shoppedAtLevel !== this.levelNow) {
            this.shoppedAtLevel = this.levelNow;
            console.log(`[shop] counted this level's one trip; the next is at level ${this.levelNow + 1}`);
          }
          if (!this.gearTriedThisRest && this.gearTryOffset < weaponRungs.length) {
            this.gearTriedThisRest = true;
            this.wornThisRest = false;
            return { action: 'buy', item: weaponRungs[this.gearTryOffset].buy, quantity: 1 };
          }
          // NO SHIELD. NO SUNDRIES. TWO ITEMS EACH, NOTHING ELSE (user,
          // 2026-08-16, after watching both buy a shield they already wore).
          // The gate that was here made it WORSE, and exactly backwards:
          // `stillWanting` asks whether a top-tier rung is still unowned, but
          // openRungs() returns [] below level 35 - so at levels 34 and 33 it
          // read "wanting nothing", judged the war chest free, and opened the
          // shield and draught gates precisely when the pair could not buy
          // either real item. It licensed the very purchases it was added to
          // prevent. Deleting the purchase is the only version that cannot
          // invert: what is not in the code cannot be bought.
          const armorRungs = this.unownedRungs(this.openRungs(this.options.armorLadder ?? []));
          if (!this.armorTriedThisRest && this.armorTryOffset < armorRungs.length) {
            this.armorTriedThisRest = true;
            this.wornThisRest = false;
            return { action: 'buy', item: armorRungs[this.armorTryOffset].buy, quantity: 1 };
          }
        }
        // NO DRAUGHT PURCHASE EITHER (user, 2026-08-16: "NO BUYING ANYTHING
        // OTHER THAN THE TWO ITEMS EACH NEED THAT YOU NAMED IN THAT ORDER").
        // This carried the same inverted gate as the shield above - below
        // level 35 `wantingBigGear` reads false, so the bottles were bought
        // at exactly the levels where the real gear was unreachable. Gone.
        // DRINKING a draught already in the pack is untouched and lives
        // above: a bottle in hand still gets used when the bar drops, which
        // is what keeps a body alive in the field. Only the buying is gone.
        // The buy list is now exactly two items per character:
        //   Sir Qwen    knight_greatblade -> depths_plate
        //   Lord Gemma  crystal_focus     -> sepulchral_vestment
        if (!this.wornThisRest) {
          this.wornThisRest = true;
          return { action: 'equip_best' as never } as Intent;
        }
        if (this.options.feastSpell && !this.conjuredThisRest) {
          this.conjuredThisRest = true;
          return { action: 'use_skill', skill: this.options.feastSpell, target: '__self__' };
        }
        if (this.options.feastSpell && this.conjuredThisRest && !this.ateThisRest) {
          this.ateThisRest = true;
          return { action: 'use_item', item: 'food' };
        }
        if (this.restLeft > 0) {
          this.restLeft -= 1;
          return { action: 'wait' };
        }
        // No extended heal-wait: the game has no resting regeneration, so
        // waiting for 95% was six minutes of standing at the vendor for
        // nothing. The breather above is the whole rest.
        this.tripDamage = 0;
        this.leg = 'outbound';
        return this.again(scene, danger, hp, partnerLoc, ownLoc);
      }
    }
  }

  /**
   * Does the pack hold this piece? One direction only: carrying a
   * 'crescent axe' means owning an 'axe', but carrying an 'axe' must NOT
   * read as owning a 'twin axe' - that reversed test once capped a
   * Magus's whole ladder at the unaffordable top rung. Apostrophes are
   * stripped on both sides so "Knight's Greatblade" (label) and
   * knight_greatblade (key) answer to the same wish.
   */
  private ownsGear(want: string): boolean {
    const w = want.replace(/'/g, '');
    return this.carriedNow.some((held) => {
      const h = held.replace(/'/g, '');
      return h === w || h.includes(w);
    });
  }

  /**
   * Whether a pilgrimage cache is currently being pursued, for callers
   * outside this class that need to know without seeing the cache's own
   * details - npc.ts uses this to prioritize a fresh arena_inventory read
   * while a chest is actively in play, since ownsGear() (which decides
   * whether this ever advances past a claimed chest) can only see what
   * holds() last received, and that can go a whole rest without a real
   * value on an oversized pack (2026-08-15).
   */
  hasActiveTreasureTarget(): boolean {
    return null !== this.treasureTarget();
  }

  /** The next cache this character has not yet claimed, closest first. */
  /**
   * The one tool this body still needs, or null when its trades are equipped.
   *
   * Three ways to answer null, and each is a lesson from tonight:
   *  - nothing on the sheet needs a tool, so no trip;
   *  - the counter has already refused it, remembered in `unstocked`, which
   *    is what stopped the sepulchral vestment ordering a trip to town every
   *    level for something no merchant in the world stocks;
   *  - the body is hurt. A shopping trip at four hit points was measured
   *    tonight at three times the cost of dying and healed nothing. The
   *    errand waits until he can survive the walk.
   */
  /**
   * TOO HURT TO TRAVEL - one test, because it drifted the moment it was two.
   *
   * The rule is not "above half health". It is "do not walk when the walk
   * cannot end in medicine", measured: a trip at 4 hp of 620 cost three times
   * what dying costs and healed nothing.
   *
   * Written as a bare hp check it deadlocks the very body it was meant to
   * protect. Sir Qwen one-shots the room, so nothing survives to hit him and
   * nothing kills him - he lives between 2% and 12% of 836, indefinitely. An
   * hp-only gate means he never buys a pickaxe and never walks to a vein, for
   * ever. He carries `heal`; he was never who the rule was about.
   *
   * That was caught once on the tool errand and fixed there, and then the
   * seam trip was written with a fresh hp check and deadlocked identically an
   * hour later. So it is ONE function now, and `mayWalkOut` asks the same
   * question at the chokepoint.
   */
  private tooHurtToTravel(): boolean {
    if (null === this.hpPctNow || this.hpPctNow >= RECOVER_BELOW_HP_PCT) {
      return false;
    }
    return 0 === this.potionsNow
      && !this.options.feastSpell
      && !this.options.healSpell;
  }

  private toolWanted(): string | null {
    if (!this.options.professions?.length) {
      return null;
    }
    // HURT IS NOT THE SAME AS DOOMED (2026-08-27, caught before it cost a
    // night). This was an hp-only gate, and it deadlocked Sir Qwen outright:
    // he one-shots the room (252-512 a swing against mobs holding 120-160),
    // so nothing survives to hit him back and nothing kills him either - he
    // has sat between 4% and 12% of 836 for hours, stable, never dying and
    // never healing. An "above half to shop" rule means he never buys the
    // pickaxe, so he never mines, for ever.
    //
    // The doctrine this came from is narrower than the number: do not walk
    // to town when the walk cannot end in medicine. That is the same
    // `noMedicine` test `mayWalkOut` uses - and Sir Qwen carries `heal`, so
    // he was never the body it was written about. Lord Gemma, with no heal
    // and no potions, still waits until he can survive the road.
    if (this.tooHurtToTravel()) {
      return null;
    }
    for (const trade of this.options.professions) {
      const tool = TOOL_FOR[trade];
      if (!tool || this.unstocked.has(tool.buy)) {
        continue;
      }
      if (!this.ownsGear(tool.match)) {
        return tool.buy;
      }
    }
    return null;
  }

  private treasureTarget(): TreasureCache | null {
    // Re-enabled 2026-08-15, scoped to PILGRIMAGE_CACHES only - see the
    // comment on that list for why four of the six stay excluded.
    // Two switches, both of which must be on. PILGRIMAGE_ON is the global
    // one; treasureRun is per character, because the route is wanted for
    // ONE body and not the pair (user, 2026-08-16: "turn just that chest on
    // for Sir Qwen"). Sending both would have them walk the same cache and
    // the second one finds an emptied box.
    if (!PILGRIMAGE_ON || !this.options.treasureRun) {
      return null;
    }
    for (const cache of PILGRIMAGE_CACHES) {
      if (this.futileCaches.has(cache.title)) {
        continue;
      }
      if (!this.ownsGear(cache.match)) {
        return cache;
      }
    }
    return null;
  }

  /**
   * The ladder's own top tier, and only if the live level has actually
   * unlocked it. Standing doctrine (2026-08-15, restated many times over):
   * every coin is saved for the best weapon and armor the merchant sells,
   * nothing else, ever - not the cheaper rungs a lower level can already
   * afford. Below the ladder's top level this returns empty: nothing to
   * buy yet, and nothing that should pull the round to market early either
   * - affordableUpgrade() below uses the same restriction, so a purse deep
   * enough for a tier-0 axe does not read as an upgrade worth a trip.
   */
  private openRungs(ladder: GearRung[]): GearRung[] {
    const top = Math.max(0, ...ladder.map((rung) => rung.level));
    // AN UNKNOWN LEVEL IS NOT LEVEL ZERO. `?? 0` read "unknown" as "far too
    // low" and shut the ladder for ever, which is precisely what happened:
    // the 2026-08-21 world update dropped `sheet` from the public watch feed
    // - every player object there is now {sessionId, name, x, y, dir,
    // inState} - and arena_observe's ownPlayer never carried a level either.
    // So levelNow is null on every tick, and Sir Qwen stood at Nerys's
    // counter with 47,695 copper wanting nothing, night after night.
    //
    // Asking is cheap and self-correcting: a counter refuses an item the
    // buyer has not earned, which costs one call and teaches us nothing
    // worse than we already know. Refusing to ask costs the whole economy.
    // Put the `?? 0` back the moment a level source exists again.
    const known = this.levelNow;
    return ladder.filter((rung) => rung.level === top && (null === known || known >= rung.level));
  }

  /** The two richest unlocked hunting grounds, best first. A follower's
   *  best ground is wherever the leader is working, whatever his own
   *  level gates say - a L29 Magus marching to him own meadow while the
   *  L30 knight fought the crypt split the pair within a minute of the
   *  crypt opening. Town is never a hunting ground. */
  private topFields(): string[] {
    // WHAT THE LEADER IS DOING THERE, not WHICH ROOM IT IS (2026-08-16).
    // This used to name grassland and shore and refuse to follow into
    // either, on the explicit premise that a leader only ever stands in
    // them mid-transit "because GRASSLAND_LEVEL/SHORE_LEVEL both stay 999".
    // That premise is a landmine: the moment either gate opens - which is
    // exactly what the gold economy wants - a leader genuinely hunting
    // there would be refused, the follower would fall through to him own
    // rotation, and the pair would split. Which room it is was never the
    // real question; the transit tick that caused the original bug is
    // distinguishable by its LEG, because plan() publishes the current room
    // as dest while looting or hunting, and a body merely passing through
    // is on none of the legs that mean "I am working this ground".
    // Filtering through fieldsFor(this.levelNow) was the other candidate
    // and is wrong for the same reason it always was: it would reject the
    // leader's legitimate ground whenever the follower's own level has not
    // unlocked it, which is the exact L29/L30 crypt split this exception
    // exists to prevent.
    const leaderIsWorkingIt = 'hunting' === this.leaderLeg || 'looting' === this.leaderLeg;
    if (
      'leader' !== this.options.role && this.leaderDest && TOWN !== this.leaderDest
      && leaderIsWorkingIt
    ) {
      return [this.leaderDest];
    }
    return fieldsFor(this.levelNow).slice(-2).reverse();
  }

  /**
   * Every rung not yet owned, in ladder order. openRungs() can hand back
   * more than one top-tier rung on the same ladder (SWORD_GEAR's L35 bow
   * AND greatblade, both duel steel meant to be owned together) - stopping
   * at the first owned rung, as this once did, silently blocked the second
   * one forever once the first was bought (2026-08-15).
   */
  private unownedRungs(rungs: GearRung[]): GearRung[] {
    // Unowned AND obtainable. A rung no counter stocks is not an upgrade
    // waiting to be afforded, it is a trip to be refused; leaving it in
    // sends the body to town for it every rest, forever.
    return rungs.filter((rung) => !this.ownsGear(rung.match) && !this.unstocked.has(rung.buy));
  }

  /**
   * Is there an unlocked, unowned rung on either ladder the purse can
   * pay for right now? This is what sends the round to market outside
   * the cargo schedule - and it respects the same per-rest try offsets,
   * so a rung the counter refused stops pulling the body to town.
   */
  private affordableUpgrade(): boolean {
    // ONE SHOPPING TRIP PER LEVEL (Glenn, 2026-08-24). A ladder only opens a
    // new rung when the level rises, so a body that has already shopped at
    // this level has nothing to go back for - and going back anyway is how a
    // town loop starts. Sir Qwen is the case in point: the top rung of both
    // ladders is level 35, he is level 35, he wears the weapon, and the
    // armour is stocked by nobody, so no trip he makes can end in a purchase.
    //
    // Keyed on the level rather than on a flag, so it clears itself: reach
    // level 36 and the round will look once more, which is exactly what a
    // newly added rung would need. A body that cannot read its level yet is
    // allowed its first trip, because refusing that would strand a genuinely
    // under-geared character.
    if (null !== this.levelNow && this.shoppedAtLevel === this.levelNow) {
      return false;
    }
    const wish = (ladder: GearRung[], refusedAt: number) => {
      if (this.coinsNow <= refusedAt) {
        return false;
      }
      return this.unownedRungs(this.openRungs(ladder)).some((rung) => rung.price <= this.coinsNow);
    };
    return (
      wish(this.options.gearLadder ?? SWORD_GEAR, this.gearRefusedAt)
      || wish(this.options.armorLadder ?? [], this.armorRefusedAt)
    );
  }

  /** One door along the only routes this round knows. */
  /**
   * True when the very next door on the road to `destination` is one the
   * world has already refused by name. Asked BEFORE setting out and again
   * on every beat of a journey, because a road can be barred halfway.
   *
   * Deliberately only the NEXT door: a route two rooms long may pass a door
   * that has never been tried, and refusing to set out over a lock further
   * along than we can see would be guessing.
   */
  private roadBarred(scene: string, destination: string): boolean {
    if (scene === destination) {
      return false;
    }
    const place = nextDoorToward(scene, destination);
    return !!place && this.barredDoors.has(place);
  }

  private stepToward(scene: string, destination: string): Intent {
    if (scene === destination) {
      return { action: 'wait' };
    }
    // Work out which door this route would ask for, then substitute the
    // corrected name ONLY if that exact ask failed here before. A hint
    // that replaced every exit from a room once walked a warlock into an
    // inn he had no business entering.
    // The route table first: a destination's own door label ("Barnaby's
    // inn") only exists in the room adjacent to it - asked from the
    // grassland it fails, and the guesser that picks up the pieces sent
    // bodies ping-ponging across the bridge.
    const place = nextDoorToward(scene, destination);
    if (scene === this.doorHintScene && place === this.doorHintPlace && this.doorHint) {
      return { action: 'use_door', place: this.doorHint };
    }
    return { action: 'use_door', place };
  }

  /** What this round is doing and where it is going, for the rally file. */
  plan(): { leg: string; dest: string } {
    // While actively working a field, the destination IS the field being
    // worked - publishing a hardcoded forest sent the follower to the
    // wrong hunting ground whenever the leader ranged elsewhere.
    if ('hunting' === this.leg || 'looting' === this.leg) {
      return { leg: this.leg, dest: this.sceneNow || FIELDS[0] };
    }
    if ('homebound' === this.leg || 'restock' === this.leg || 'resting' === this.leg) {
      return { leg: this.leg, dest: TOWN };
    }
    // Outbound advertises the same richest-ground pick the legs walk,
    // or the follower marches to the wrong field entirely.
    const top = this.topFields();
    return { leg: this.leg, dest: top[this.fieldIndex % top.length] };
  }

  /** The best violence available: earned spell first, steel as fallback. */
  private strike(level: number, manaDry = false, hurt = false): Intent {
    if (!this.spellBlocked && !manaDry) {
      // BLEED-BACK FIRST. drainLife damages AND heals the caster, so
      // while hurt it is strictly better than any other art: the fight
      // and the recovery are the same action. Since the trees started
      // hitting back this is the only way a caster with no heal spell
      // survives a long engagement.
      if (hurt && this.options.drainSpell) {
        return { action: 'use_skill', skill: this.options.drainSpell, target: '__nearest__' };
      }
      const earned = earnedRung(this.options.skillLadder, level);
      const art = earned?.skill ?? this.options.spell;
      if (art) {
        return { action: 'use_skill', skill: art, target: '__nearest__' };
      }
    }
    return { action: 'attack', target: '__nearest__' };
  }

  pendingTactics(): string | null {
    const style = this.wantedTactics;
    this.wantedTactics = null;
    return style;
  }

  /**
   * Server issue #152: arena_set_tactics silently reverts to unsafe defaults
   * (flee on, no auto-heal, party-follow spacing) on session reconnect, with
   * no error and no signal that it happened. wantedTactics is consume-once,
   * so a reconnect that does not call this leaves the body fighting on
   * whatever the server defaulted to until the next full leg change - which,
   * mid-hunt, may not come for a long time. Call this everywhere a
   * reconnect actually happens, not just where a leg begins.
   */
  reassertTactics(): void {
    this.wantedTactics = this.effectiveBattleStyle(this.sceneNow);
  }

  /** battleStyle, unless the current scene is options.rangedInScene - see
   *  that field's doc for why. Centralized so the three places that set
   *  wantedTactics cannot drift into disagreeing about which scene this is. */
  private effectiveBattleStyle(scene: string): string {
    return this.options.rangedInScene && scene === this.options.rangedInScene
      ? 'long_range'
      : (this.options.battleStyle ?? 'close_up');
  }

  // ---------------------------------------------------------------- shrine
  // THE SHRINE ERRAND, whole in one block (state, trigger, walk, give-up) so
  // it merges as one piece. See the SHRINE constants above for the doctrine
  // and the cost accounting. The only lines outside this block are the
  // call in beat() and the three-line 'shrine_bless' case in completed(),
  // both of which delegate straight back here.
  private shrineActive = false;
  private shrineLastTripAt = 0;
  private shrineRouteTicks = 0;
  private shrineAsks = 0;
  private shrineFailedTrips = 0;
  private shrineHopeless = false;
  /** Beats in a row the feed has read zero aggressors. The errand may only
   *  FIRE once this reaches SHRINE_CALM_TICKS: "the fighting has stopped"
   *  is a streak, not one quiet read between swings. */
  private shrineCalmTicks = 0;

  /**
   * One beat of the shrine recovery errand, or null when the beat is not
   * its to spend.
   *
   * NEVER A RETREAT: anything still swinging returns null immediately, so
   * the fight-back law below the call site keeps the beat - the operator's
   * standing order ("no running away, fight to the death";
   * flee_below_hp_percent null is doctrine) is enforced here as well as
   * there, so the errand stays safe wherever the call site lands.
   *
   * The trip is bounded three ways: SHRINE_ROUTE_TICKS beats for the whole
   * walk, SHRINE_ASKS asks at Ossian, and SHRINE_FAILED_TRIPS fruitless
   * trips before the shrine is written off for the run. Success is judged
   * by the live bars, not by the dialog's answer - see the recovered
   * branch, the only honest referee for a room nobody has ever entered.
   */
  private shrineErrand(
    scene: string,
    aggressors: number,
    died: boolean,
    hpPct: number | null,
    mpNow: number | null
  ): Intent | null {
    if (aggressors > 0 || died) {
      // Still swinging, or just killed: no errand. A death is the free
      // full restore already - the respawn arrives whole - and the bars
      // read garbage around one, so the streak starts over.
      this.shrineCalmTicks = 0;
      return null;
    }
    if (0 === this.depth) {
      // Calm is counted in TICKS, not in beat() re-entries: the legs hand
      // work to each other by recursing through the same tick, and counting
      // those made "two calm beats" arrive inside a single death handoff.
      this.shrineCalmTicks += 1;
    }
    if (this.shrineHopeless) {
      return null;
    }
    const why = this.spentAndHelpless(hpPct, mpNow);
    if (!this.shrineActive) {
      if (null === why || this.shrineCalmTicks < SHRINE_CALM_TICKS) {
        return null;
      }
      if (Date.now() - this.shrineLastTripAt < SHRINE_COOLDOWN_MS) {
        return null;
      }
      this.shrineActive = true;
      this.shrineRouteTicks = 0;
      this.shrineAsks = 0;
      console.log(`[shrine] ${why} - walking to Ossian's shrine for the free mend`);
    } else if (null === why) {
      // Whole again - the blessing worked, or something else mended the
      // body on the road. Either way the errand is over and the walk home
      // belongs to the ordinary legs.
      console.log('[shrine] whole again - errand over, back to the round');
      this.endShrineTrip(false);
      return null;
    }
    this.shrineRouteTicks += 1;
    if (this.shrineRouteTicks > SHRINE_ROUTE_TICKS) {
      console.log(`[shrine] the walk did not resolve in ${SHRINE_ROUTE_TICKS} beats - giving up rather than parking the body (agentArena#573 stalls are origin-tile-bound, so this may be upstream)`);
      this.endShrineTrip(true);
      return null;
    }
    if (SHRINE !== scene) {
      return this.stepToward(scene, SHRINE);
    }
    this.shrineAsks += 1;
    if (this.shrineAsks > SHRINE_ASKS) {
      console.log(`[shrine] Ossian did not mend this body in ${SHRINE_ASKS} asks - giving up rather than parking here`);
      this.endShrineTrip(true);
      return null;
    }
    return { action: 'shrine_bless' as never } as Intent;
  }

  /**
   * Spent AND out of self-cures, as one reason string - or null.
   *
   * Every clause here names a cure the round would otherwise reach for,
   * and the errand only goes when NONE of them can run:
   * - bleeding: a carried potion drinks where the body stands (the hp<45
   *   block above the call site - which also makes the potion clause here
   *   belt-and-braces rather than the working guard), and a working heal
   *   spell mends without a walk;
   * - dry pool: a carried draught drinks, lifeTap buys mana with blood
   *   when there is blood to spare (>= 70%, the tap block's own floor),
   *   and Barnaby's ale is the proven cure when it is reachable and
   *   affordable. Only a caster is "spent" on mana - a body with no arts
   *   loses nothing to an empty pool.
   */
  private spentAndHelpless(hpPct: number | null, mpNow: number | null): string | null {
    const healWorks =
      !!this.options.healSpell && !this.healBlocked && (null === mpNow || mpNow >= HEAL_MP);
    if (null !== hpPct && hpPct < SHRINE_HP_PCT && 0 === this.potionsNow && !healWorks) {
      return `hp at ${Math.round(hpPct)}% with no potion and no working heal`;
    }
    const caster =
      !!this.options.spell || !!this.options.manaSpell || 0 < (this.options.skillLadder?.length ?? 0);
    const dry = null !== mpNow && mpNow < 10;
    const tapWorks = !!this.options.manaSpell && null !== hpPct && hpPct >= 70;
    const aleWorks = !this.aleHopeless && this.coinsNow >= 100;
    if (caster && dry && 0 === this.draughtsNow && !tapWorks && !aleWorks) {
      return `mana dry (${mpNow}) with no draught, not enough blood to tap, and no ale to reach`;
    }
    return null;
  }

  /** Close the errand and stamp the cooldown. A fruitless trip counts
   *  toward the run-scoped give-up; a mended body clears the count. */
  private endShrineTrip(failed: boolean): void {
    this.shrineActive = false;
    this.shrineLastTripAt = Date.now();
    if (!failed) {
      this.shrineFailedTrips = 0;
      return;
    }
    this.shrineFailedTrips += 1;
    if (this.shrineFailedTrips >= SHRINE_FAILED_TRIPS) {
      this.shrineHopeless = true;
      console.log(`[shrine] ${this.shrineFailedTrips} trips came back empty - no more shrine errands this run`);
    }
  }

  /**
   * What came of one shrine_bless ask, from completed().
   *
   * A structural refusal - no Ossian standing there, a dialog with no
   * choices, or nothing on offer that reads as healing - means the room is
   * not what the server source promised, and asking again cannot change
   * that: latch the whole errand off for the run, loudly. Anything else
   * (too far, a slow walk) is left to the ask budget. `ok` is deliberately
   * NOT treated as success: the dialog answering politely proves nothing
   * about the stats, and the recovered branch in shrineErrand() judges
   * those against the live bars next beat.
   */
  private shrineOutcome(ok: boolean, note: string): void {
    if (ok) {
      console.log(`[shrine] Ossian answered: ${note || 'ok'} - the bars will say whether it worked`);
      return;
    }
    if (/no ossian here|offered no choices|reads as healing/i.test(note)) {
      console.log(`[shrine] the shrine is not what the source promised: ${note} - no more shrine errands this run`);
      this.shrineHopeless = true;
      this.shrineActive = false;
      this.shrineLastTripAt = Date.now();
      return;
    }
    console.log(`[shrine] refused this beat: ${note}`);
  }
  // ------------------------------------------------------------ end shrine

  /** Where this character's foraging trip goes. */
  private forageRoom(): string {
    return this.options.forageRoom ?? FORAGE_ROOM;
  }

  completed(intent: Intent, ok: boolean, note: string): void {
    // THE SEAM TRIP ENDS AT THE SEAM. A vein holds six to eight charges and
    // the beat takes four at a time, so two visits empty it; after that the
    // world answers "nothing of ours" or refuses, and the trip is over for
    // the hour. Ending on the gather rather than on a timer is what stops a
    // body standing on an empty vein until the walk cap expires.
    // THE WALK ENDS AT THE SEAM. Four worked visits empty a vein, and an
    // approach beat is not a visit - see the walk-is-not-an-empty-room fix.
    // A MISS IS NOT A VISIT, AND NOR IS AN APPROACH.
    //
    // This counted ANY gather_nearby as a worked visit except the approach,
    // so four beats of "nothing of ours to gather within reach" retired the
    // errand as though the vein had been emptied. Measured 2026-08-31: the
    // body stopped 14 tiles short at tile (88,157) with the node at (90,171),
    // saw nothing four times, and logged "done at the seam" having taken zero
    // charges. The vein was full - the morning's trip emptied it from 1.4
    // tiles and it had refilled.
    //
    // The sibling case was already fixed here ("an approach beat is not a
    // visit"). This is the same mistake one branch over: only a beat that
    // actually TOOK something counts against the four.
    const missed = /nothing of ours to gather/i.test(note)
      || /on the way to a node/i.test(note);
    if ('gather_nearby' === (intent.action as string) && this.seamWalk && !missed) {
      this.seamWalkGathers += 1;
      if (this.seamWalkGathers >= 4) {
        this.seamWalk = false;
        this.seamWalkAt = Date.now();
        console.log(`[seam] done at the seam after ${this.seamWalkBeats} beats`);
      }
    }
    if ('gather_nearby' === (intent.action as string) && this.seamRun) {
      // A BEAT SPENT WALKING TO A NODE IS NOT A VISIT TO IT. `seamGathers`
      // ends the trip at six regardless of dryness, so counting the approach
      // would retire the errand while the body was still on its way - the
      // cap would be spent before the first charge was ever taken.
      if (/on the way to a node/i.test(note)) {
        return;
      }
      this.seamGathers += 1;
      // An empty FIRST look on arrival is ordinary - the body lands at a
      // door, not on a patch. Give the room a few beats before writing it off.
      const dry = !ok || /nothing of ours|gave nothing|no charges/i.test(note);
      if ((dry && this.seamGathers >= 4) || this.seamGathers >= 6) {
        this.seamRun = false;
        this.seamGathers = 0;
        this.seamAt = Date.now();
        console.log(`[seam] trip done - ${dry ? 'the vein gave nothing' : 'charges taken'}`);
      }
    }
    // A DOOR THAT NAMES ITS PRICE IS SHUT, NOT BUSY. The world answers a
    // lock with the requirement in plain words ("That door is locked. It
    // needs tansys_road_writ"), which is the one refusal that will still be
    // true on the next beat, and the next thousand.
    if ('use_door' === (intent.action as string) && !ok) {
      // MATCH THE LOCK, NOT THE WORD "NEEDS" (adversarial review, 2026-08-27).
      //
      // This read /that door is locked|it needs \w|requires? \w/i, and the
      // note it is given is NOT limited to the world's refusal prose:
      // `perform()` catches every transport, gateway and validation error and
      // hands the raw message through as the note. The review ran real
      // strings against the old pattern - each of these BARRED a door for the
      // life of the process:
      //
      //   "the door did not open: The gateway requires a moment; try again."
      //   "the door did not open: it needs to finish moving first"
      //   "Server requires initialization"
      //   "rate limited; requires backoff"
      //   "Requires Blacksmithing level 20."
      //
      // That last one is not hypothetical: it appears fifty times over in the
      // logs as world `gameplayHint` text. A bar is permanent and silent, so
      // a false one is the worst failure this file can produce.
      //
      // The world says the same sentence every time it means a lock, and that
      // sentence is the whole test now. Measured against every recorded
      // `use_door` failure in the logs: 23 matches, all 23 the genuine
      // `tansys_road_writ` lock, zero false positives.
      const shut = /that door is locked/i.test(note);
      const place = (intent as { place?: string }).place;
      if (shut && place && !this.barredDoors.has(place)) {
        this.barredDoors.set(place, note);
        console.log(`[door] ${place} is barred and will not be tried again: ${note}`);
      }
    }
    // Standing AT the keeper, not merely heading for him. See the tool run.
    if ('walk' === (intent.action as string)) {
      this.atKeeper = /walked over to/i.test(note);
    }
    if (/wedged mid-transition/i.test(note)) {
      this.wantReconnect = true;
    }
    // A march that moved the body nowhere counts against the bay it aimed
    // at. `goTo` reports that honestly now ("did not move from tile x,y"),
    // which is the whole reason this can be written down at all - before
    // that fix every one of these answered ok.
    if ('go_to' === (intent.action as string) && this.bayAimed) {
      const key = this.bayAimed;
      this.bayAimed = null;
      if (!ok || /did not move|no walking route|no usable tile/i.test(note)) {
        const seen = this.bayTrouble.get(key) ?? { misses: 0, until: 0 };
        seen.misses += 1;
        if (seen.misses >= BAY_MISSES_BEFORE_SKIP) {
          seen.misses = 0;
          seen.until = Date.now() + BAY_SKIP_MS;
          console.log(`[bay] ${key} refused ${BAY_MISSES_BEFORE_SKIP} marches`
            + ` - set aside for ${Math.round(BAY_SKIP_MS / 60000)} minutes`);
        }
        this.bayTrouble.set(key, seen);
      } else {
        this.bayTrouble.delete(key);
      }
    }
    // Attacks are NOT movement: melee is fought standing still, and
    // counting swings as failed steps made the watchdog interrupt every
    // fight with escape maneuvers. Only orders whose purpose is to
    // change position belong here.
    this.lastWasMovement = ['walk', 'use_door', 'approach', 'go_to'].includes(
      intent.action as string
    );
    const missing = /there is no|nothing|not sold|does not sell|cannot find/i.test(note);
    switch (intent.action as string) {
      case 'use_skill':
        if (/mana|not enough|too tired|cooldown/i.test(note)) {
          // Dry well, not a missing art: swing steel this trip and let
          // the rest-time feast refill the reserves.
          return;
        }
        if (
          /not enabled|does not have|no such skill|does not know|is not something/i.test(note)
        ) {
          // Whatever we asked for, this body cannot do it (yet): stop
          // asking until the next session. The refusal helpfully names
          // the real kit, which the log keeps for us.
          if (intent.skill === this.options.healSpell) {
            this.healBlocked = true;
          } else {
            this.spellBlocked = true;
          }
          return;
        }
        if (/no enemy within the leash/i.test(note)) {
          this.leg = 'looting';
          this.lootMisses = 0;
          this.lootRun = 0;
          return;
        }
        if (/not enabled/i.test(note)) {
          // The gateway does not allow casting yet. Swing steel instead and
          // stop asking; try again after the next restart in case it shipped.
          this.spellBlocked = true;
          return;
        }
      // falls through
      case 'approach':
      case 'attack':
        // "could not close" belongs here too. In an open field the only way
        // to have no fight is to have nothing in the leash; in a maze the
        // usual way is to have plenty in the leash and no path to any of it,
        // which reported as an ordinary failure and left the round trying the
        // same blocked approach for ever. Both mean the same thing to the
        // legs: this spot is played out, go somewhere else in the room.
        if (/no enemy within the leash|could not close|too far to hit/i.test(note)) {
          if (this.advanceCount < 8) {
            // Push deeper before giving up on the field.
            this.needAdvance = true;
          } else {
            this.leg = 'looting';
            this.lootMisses = 0;
            this.lootRun = 0;
          }
          return;
        }
        if (ok) {
          this.advanceCount = 0;
        }
        if (!ok && missing) {
          if (this.preyIndex % PREY.length < PREY.length - 1) {
            this.preyIndex += 1;
          } else {
            this.preyIndex = 0;
            this.leg = 'looting';
            this.lootMisses = 0;
            this.lootRun = 0;
          }
        }
        return;
      case 'shrine_bless' as never: {
        // Delegated whole to the shrine block; see shrineOutcome() there.
        this.shrineOutcome(ok, note);
        return;
      }
      case 'use_door': {
        if (!intent.place) {
          return;
        }
        // Two ways the world corrects a wrong door name, both of which
        // list what the room actually has: ambiguity ("could not tell
        // which door") and absence ("no door here it would call"). Either
        // way, take a listed door - one whose name shares a word with
        // where we are headed if any does, else the first, which in
        // practice points back the way rooms expect you to leave.
        if (ok) {
          this.doorBlockedStreak = 0;
          return;
        }
        // A LOCK IS NOT A BLOCKAGE, and the ladder below is built for a door
        // the body cannot REACH: shake loose, force the doors, hand a turn to
        // the model. Not one rung of it can produce a quest item, so running
        // it against a lock spends beats to learn the same sentence again.
        //
        // Watched live: `use_door millrace-approach` answered "That door is
        // locked. It needs tansys_road_writ", which matches `did not open`
        // and armed force_doors, which answered "every visible door refused",
        // which armed the door again. Four minutes, two bodies, no hostiles.
        //
        // REDUNDANT TODAY, KEPT DELIBERATELY - and unlike the last claim of
        // that kind in this file, it was MEASURED rather than argued. A
        // mutation battery deleted these four lines, rebuilt, and every test
        // in `a-locked-door-is-not-a-retry.test.mjs` still passed:
        //
        //   the ladder short-circuit     failures when broken: 0
        //
        // The reason is the bar above it. Once a lock is written down the
        // door is never asked a second time, so `doorBlockedStreak` reaches
        // one and stops, and the threshold that arms force_doors is four.
        //
        // It stays because it encodes the RULE rather than relying on that
        // arithmetic: a refusal that names its price must not be handed to
        // the escalation ladder. If the bar is ever narrowed, scoped per
        // room, or given an expiry, this is what keeps the loop from coming
        // back. Documented as unexercised - not described as working.
        if (this.barredDoors.has(intent.place)) {
          this.doorBlockedStreak = 0;
          return;
        }
        if (/did not open|something may be in the way|could not find anywhere to stand/i.test(note)) {
          // Physically blocked: shake loose and retry. Four failures in a
          // row is no longer a nudge problem - hand one turn to the model,
          // which can path-check, sidestep, and try doors the clockwork
          // does not know.
          // "could not find anywhere to stand beside the door" (2026-08-15)
          // used to match NONE of this method's three patterns and fall
          // through to a bare `return` two screens down - the whole
          // escalation ladder (unstick, force-doors, hand to model,
          // eventually arena_unstick/give-up-and-walk-back) never engaged,
          // so this exact failure could repeat forever with zero backoff.
          // Found live: Sir Qwen stuck on this precise message every ~55s
          // while something else kept walking him further off the map each
          // cycle - the same failure class as the documented sovereign
          // incident (real px in the tens of thousands), just never caught
          // here because the message never tripped the ladder that exists
          // to catch it.
          this.doorBlockedStreak += 1;
          if (this.doorBlockedStreak >= 7) {
            // Beyond nudges, beyond forcing, beyond thought: ask the world
            // itself to move the body. Its own cooldown stops overuse.
            this.doorBlockedStreak = 0;
            this.wantWorldMove = true;
          } else if (this.doorBlockedStreak >= 5) {
            this.callTheMind = true;
          } else if (this.doorBlockedStreak >= 2) {
            // A door two tiles wide is rarely blocked on both: walk to
            // each tile in turn and force the crossing.
            this.needForceDoors = true;
          } else {
            this.needUnstick = true;
          }
          this.jiggleIndex += 1;
          return;
        }
        if (/could not tell which door|no door here it would call/i.test(note)) {
          const offered = [...note.matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter((d) => d !== intent.place);
          if (offered.length > 0) {
            const wantedWords = intent.place.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3);
            const match = offered.find((d) => wantedWords.some((w) => d.toLowerCase().includes(w.slice(0, 5))));
            // No named match: prefer anything that sounds like town - lost
            // is best cured by going home - before taking the first door,
            // which in an inn is the staircase.
            const homeward = offered.find((d) => /town|square|outside/i.test(d));
            // NO BLIND FIRST DOOR (2026-08-16). Taking offered[0] when nothing
            // matches assumes every room's doors all lead roughly the right
            // way. In a sealed world they do not. Measured live: a body in
            // `the-valley` asking for a room the valley has no door to was
            // handed "the valley shrine" - the first of six interiors - walked
            // in, found the shrine's single door, came straight back, and did
            // it again every 40 seconds. The door-blocked ladder never fires
            // on this branch either, so nothing escalates and nothing stops.
            // An unrelated door is not a lead; it is a detour with a return
            // trip. Standing still costs one refusal and keeps the body where
            // it is, which is where any fix will find it.
            this.doorHint = match ?? homeward ?? null;
            this.doorHintScene = this.sceneNow;
            this.doorHintPlace = intent.place;
          }
        }
        return;
      }
      case 'pick_up':
        if (ok) {
          this.lootMisses = 0;
          if ('looting' === this.leg) {
            this.lootRun += 1;
          }
          return;
        }
        if (/nothing lying here|nothing here called/i.test(note)) {
          // Bare ground underfoot does not mean a bare field: walk to
          // the nearest visible drop before giving up on the harvest.
          this.seekDrop = true;
        }
        if ('looting' === this.leg) {
          this.lootMisses += 1;
        }
        return;
      case 'seek_drop':
        if (!ok && 'looting' === this.leg) {
          this.lootMisses += 1;
        }
        return;
      case 'sell':
        if (ok) {
          // One real sale proves a buyer exists and retires the learning
          // below, so a merchant added upstream is picked up by itself.
          this.sellsEverMade = true;
          // The whole of that row's quantity was sold in one call;
          // sellableItems() answers fresh next tick from what is actually
          // left in the pack.
          return;
        }
        if (/too far away to trade/i.test(note)) {
          this.walkedToShop = false;
          this.leg = 'restock';
          return;
        }
        // "has no sell price" is not this item being wrong for this
        // counter, it is this world having nobody to sell to. Upstream says
        // so outright in seed-items.mjs - the valley specialists sell their
        // trade and buy nothing, and the only buyer is the shore fisherman,
        // who has been unreachable since the road was sealed. Counting the
        // refusals is what stops a full bag ordering a bank run that cannot
        // bank: 227 rows, six refusals a stop, then the walk back out, over
        // and over, which is what "going back and forth doing nothing"
        // looked like from outside (2026-08-24).
        if (/no sell price|will not buy/i.test(note)) {
          this.sellsRefusedNoPrice += 1;
        }
        this.sellSkip.add(intent.item ?? '');
        return;
      case 'discard_junk' as never: {
        // Deliberately does NOT give up on a failed sweep any more. The
        // give-up was keyed on the pack not getting smaller, and the pack
        // cannot be seen to get smaller: arena_inventory is byte-capped and
        // returns a prefix, so a delete pulls a hidden row into view and
        // pins the count. That turned a working cure off. A sweep that
        // genuinely cannot read the pack answers false and simply waits for
        // the next beat; the pack is around 1,600 rows and draining it is
        // the work of an hour, not one call.
        return;
      }
      case 'drink_ale' as never: {
        // A failed reach is not a drink. Standing too far from the cask
        // costs a tick, not the rest's one attempt - but cap the retries so
        // a cask that cannot be reached at all does not become its own
        // loop, which is the failure this whole day has been about.
        if (ok) {
          this.aleTries = 0;
          return;
        }
        this.aleTries += 1;
        if (this.aleTries < 3) {
          // A failed reach costs a tick, not the rest's one attempt.
          this.drankThisRest = false;
          return;
        }
        // THREE FAILURES IS THE ANSWER, and it has to be a RUN-scoped answer.
        // drankThisRest clears with every other per-rest flag, so a cap that
        // only guarded one rest let the trip start again on the next one -
        // and the trip is itself what ends the rest. Measured 2026-08-24:
        // resting -> inn -> "too far away to talk to them" -> homebound ->
        // restock -> resting, 251 times in two hours, against two trips to
        // the field. A cure that cannot reach the cask is worse than an
        // empty pool, because it costs the whole hunt.
        if (!this.aleHopeless) {
          this.aleHopeless = true;
          console.log(`[ale] could not reach the cask in ${this.aleTries} tries - no more trips to the inn this run`);
        }
        return;
      }
      case 'buy': {
        const wanted = intent.item ?? '';
        // "does not sell X" is the counter saying X is not on its shelves,
        // and for the level 35 armour that is every counter in the world:
        // depths_plate and sepulchral_vestment are priced in
        // combat-gear.mjs and stocked by none of the three. Remembering the
        // refusal is what stops the armour rung ordering a trip to town for
        // something that cannot be bought there - the buy half of the same
        // shuttle the sell refusals caused (2026-08-24). Keyed by item, so
        // a counter that starts stocking it is found on the next restart.
        if (!ok && /does not sell/i.test(note)) {
          this.unstocked.add(wanted);
          console.log(`[shop] nobody stocks ${wanted} - it will not be asked for again this run`);
        }
        const weaponBuy = (this.options.gearLadder ?? SWORD_GEAR).some((rung) => rung.buy === wanted);
        const armorBuy = (this.options.armorLadder ?? []).some((rung) => rung.buy === wanted);
        const gearBuy = weaponBuy || armorBuy || SHIELD_NAME === wanted;
        if (/too far away to trade/i.test(note)) {
          this.walkedToShop = false;
          this.leg = 'restock';
          if (weaponBuy) {
            this.gearTriedThisRest = false;
          }
          if (armorBuy) {
            this.armorTriedThisRest = false;
          }
          return;
        }
        if (gearBuy) {
          if (ok) {
            if (weaponBuy) {
              this.gearTryOffset = 0;
              this.gearRefusedAt = -1;
            }
            if (armorBuy) {
              this.armorTryOffset = 0;
              this.armorRefusedAt = -1;
            }
            return;
          }
          if (weaponBuy) {
            // Refused (too costly, missing, whatever): move to the next
            // still-unowned top rung THIS rest, if the ladder has one -
            // SWORD_GEAR's L35 tier holds both the bow and the duel
            // greatblade, so a refusal on one still lets the other be
            // tried. unownedRungs() in the resting step bounds the walk.
            this.gearTryOffset += 1;
            this.gearTriedThisRest = false;
            this.gearRefusedAt = this.coinsNow;
          } else if (armorBuy) {
            this.armorTryOffset += 1;
            this.armorTriedThisRest = false;
            this.armorRefusedAt = this.coinsNow;
          }
          return;
        }
        if (ok) {
          this.potionsNow += 1;
        } else if (/none of what that costs|cannot afford/i.test(note)) {
          // Priced beyond today's purse: stop asking until the next rest.
          this.potionBuysThisRest = 4;
        } else if (/keeps a shop|no merchant/i.test(note)) {
          this.goHome('bought something - back through the loop');
        } else if (missing && this.potionIndex % POTION_NAMES.length < POTION_NAMES.length - 1) {
          this.potionIndex += 1;
        }
        return;
      }
      case 'use_item':
        if (ok && /potion/i.test(intent.item ?? '')) {
          this.potionsNow = Math.max(0, this.potionsNow - 1);
        }
        return;
      default:
        return;
    }
  }
}
