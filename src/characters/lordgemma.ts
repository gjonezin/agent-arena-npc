/**
 * Lord Gemma: the fire half of the pair.
 *
 * Reborn as Sir Qwen's hunting partner: same reflex round, same route,
 * same rules - but a warlock, so half his blows are fireballs. The
 * partner option keeps him in whatever room the knight stands in; two
 * bodies on one battlefield, and neither dies alone.
 *
 * RECONSTRUCTED 2026-09-02, and the loss is recorded so it is not repeated.
 * A `git checkout -- src/characters/lordgemma.ts` was run to undo a one-line
 * edit; this file's other changes were UNCOMMITTED, so it reverted to the
 * 08-25 commit instead of to the edit. `npm test` then ran `tsc` first (see
 * package.json: `test = tsc -p tsconfig.json && node --test ...`) and
 * recompiled the reverted source over `dist`, destroying the built copy too.
 * After that only the tests still described the file. Three things were put
 * back from them: `craft` in capabilities, `attackShort` at level 1 on the
 * ladder, and the professions list. Anything NOT covered by a test may still
 * be missing - compare against a known-good copy if one ever turns up.
 * Never `git checkout --` a file whose changes are not committed.
 */

import { Agent } from '@mastra/core/agent';
import { CharacterSheet } from '../harness/npc.js';
import { Autonomous } from '../harness/behavior.js';
import { CASTER_ARMOR, CASTER_GEAR } from '../harness/reflex.js';
import { TOWN } from '../harness/world.js';
import { loadPersona } from '../persona.js';

export const lordgemma: CharacterSheet = {
  id: 'lordgemma',
  playerName: process.env.ARENA_PLAYER_NAME ?? 'Lord Gemma',
  classPath: 'warlock',
  // HOME IS THE HUNTING GROUND, NOT THE TOWN (2026-08-15). With homeScene
  // set to TOWN the round's whole cycle pointed back at the town gate, and
  // the gate is the door at COLUMN 3 - the forest's western boundary. That
  // is what marched both characters into the map edge again and again and
  // left them marooned in an empty corner with the nearest enemy nineteen
  // tiles away. The field is where the work is, so the field is home.
  homeScene: 'reldens-bots-forest',
  persona: loadPersona('lordgemma'),
  model: process.env.NPC_MODEL ?? 'qwen3-vl-32b',
  // `craft` is the permission the gathering and cooking tools ride on -
  // the-professions.test.mjs pins it for both royals.
  // CAPABILITIES ARE THE PROMPT BUDGET (2026-09-02). Every capability adds
  // tool SCHEMAS to every model call, and a captured request showed the 31
  // schemas were 51,754 of 72,663 chars - 71% of the prompt - to decide one
  // ~200-token action. Two were dropped here on measured grounds:
  //   'duel'  - arena_queue_match / arena_match_status. ZERO model-issued
  //             calls in every log on the box, and PvP is a known open defect
  //             (agentArena #115: the duel queue never pairs and open-field
  //             PvP deals 0 damage). A broken feature was costing prompt.
  //   'money' - arena_credit_balance / arena_credit_history. ZERO calls, and
  //             the world runs settlementMode sandbox with realMoneyEnabled
  //             false, so credits are not the coin these two actually use.
  // Add either back the moment something needs it - but measure first.
  capabilities: ['speak', 'talk_to_folk', 'walk', 'doors', 'fight', 'trade', 'purpose', 'craft'],
  behavior: (agent: Agent) => new Autonomous(agent),
  reflex: 'knights-round',
  // PAIRED AGAIN, FOR SAFETY (user ruling 2026-08-15, after the trees
  // started killing them): he keeps station near the knight so his heal
  // and his sword can actually reach him. This is NOT the old bond that
  // made him walk all day - the follow threshold is 30 tiles, so inside
  // that he simply fights where he stands.
  // partner: 'Sir Qwen',   // symmetric with Qwen, whose leader role is off
  // role: 'follower',      // he was trailing a leader who leads nowhere
  // role: 'follower', // nobody leads, nobody follows
  // No 'spell' option: it made half of every strike pair a fireball,
  // and a fireball on a dry pool is a silent no-op - half his arrows
  // were nothing. Fireball still rides in the ladder for the ENGINE to
  // cast whenever lifeTap has filled the pool.
  // The arsenal grows with the crown: best earned skill casts automatically.
  // His kit per the world: attackBullet, attackShort, fireball - and
  // the gateway finally casts. The king IS the artillery.
  // fireball only: with the Ember Focus back in hand (bows stay packed)
  // bowShot would fail bow-less, and the strike's mana gate already
  // falls back to the free attackBullet when the pool is dry.
  // THE WAND IS THE WEAPON (user order 2026-08-15). attackBullet is the
  // warlock's level-1 ranged basic - it costs NO mana, it reaches, and it
  // is what the Ember Focus is for. Fireball is off the ladder on
  // purpose: it was the top rung, so every strike beat tried it first,
  // and at an empty pool that resolved to a silent no-op - a sovereign
  // "attacking" all night while nothing took damage. The engine still
  // casts fireball and drainLife on its own through use_skills when the
  // pool allows; the ladder just guarantees a bolt always goes out.
  // THE LADDER WAS NEVER CLIMBED (2026-08-25). One rung, at level 1, on a
  // level-35 Magus. arena_skills carries `unlockLevel` and `available` per
  // skill, and read out loud it says he has walked past three unlocks
  // without ever casting one:
  //   attackBullet  unlock 1   dmg 3    mp 0   cd 1000 + cast 0
  //   boneSpear     unlock 14  dmg 16   mp 11  cd 1670 + cast 530
  //   chillTouch    unlock 20  dmg 19   mp 16  cd 2020 + cast 680
  //   manaBurn      unlock 32  dmg 31   mp 33  cd 3210 + cast 1190
  // `damage` is a base coefficient, not the number the world prints, and the
  // SCALE IS NOT KNOWN. An earlier note here read the 252 Sir Qwen lands off
  // his thornwhip and called the factor 14.8x. He cannot have cast thornwhip:
  // it costs 13 mp and his pool was 0. The 252 is his GREATBLADE coming
  // through arena_basic_attack, so that arithmetic was measuring a weapon and
  // labelling it a spell - and a weapon-scaled physical swing says nothing
  // about how mAtk scales an art anyway.
  // What survives is the ordering, and the ordering is the server's own:
  // boneSpear's 16 is more than five times attackBullet's 3 whatever the
  // multiplier turns out to be, and it reaches 3.8 tiles against a nearest
  // grub sitting at a median 3.9. That is the whole reason a 542hp caster
  // keeps arriving in town at 14hp - not his spacing, his rate. How many
  // casts a grub actually takes is UNMEASURED; take it from battle.events
  // after the next restart rather than from arithmetic.
  // WHY boneSpear AND NOT chillTouch OR manaBurn (2026-08-25). The three
  // differ by less than their cost does, and cost is the axis that has a
  // measured floor under it:
  //   boneSpear   dmg 16  2.2s  11 mp  -> 5.0 mp/s
  //   chillTouch  dmg 19  2.7s  16 mp  -> 5.9 mp/s
  //   manaBurn    dmg 31  4.4s  33 mp  -> 7.5 mp/s
  // boneSpear is the fastest cycle and the cheapest. Whether the extra base
  // damage above it buys a kill this room cannot be settled from the sheet -
  // it needs a `damage_dealt` number out of battle.events against a 150hp
  // grub. Until somebody takes that number, the cheap fast one wins on the
  // axis that IS known, and manaBurn at 7.5 mp/s is the one that can empty a
  // 576 pool while lifeTap is locked out below 70% hp.
  // WHY THE MANA MATTERS, and it is not squeamishness. His ladder used to
  // hold ONE skill and it cost 0 mp, so the reflex's own cast could never
  // drain him. Every rung added here can. `manaDry` is mp < 10 and it gates
  // the WHOLE cast branch (reflex.ts:2214, 2727) - dry does not fall back to
  // attackBullet, it falls through to `attack`, which is a 50px staff poke.
  // And `lifeTap` refuses below 70% hp (reflex.ts:1560). Those two together
  // are the lock this file already records: "~54% hp / 0 mp - too hurt to
  // tap, too dry to heal - and sat there for two hours (2026-08-14)".
  // At the measured cast rate (9 casts in 64 minutes) 11 mp a cast is
  // nothing against a 576 pool. If that rate ever climbs, this is the first
  // thing to re-measure.
  // attackBullet STAYS at level 1 and that is the point of it: it is the only
  // free bolt he owns (mp 0). The reflex's own cast takes the highest earned
  // rung, so it will take chillTouch - but npc.ts flattens EVERY rung into
  // the server's use_skills pool, so the engine keeps a no-mana option to
  // rotate to when the pool runs low. The guarantee moved from the reflex to
  // the pool; it was not dropped.
  // arcaneRay is level 0 ON PURPOSE, so it never wins the top-rung sort and
  // is never what the reflex casts. It is here for the POOL. Measured across
  // 303 log lines where he could see a grub, the nearest one sits at a
  // median 3.9 tiles, and reach decides how many beats can land at all:
  //   attackShort  0.8t -> 9% of beats     (his basic swing; 200/200 refused)
  //   drainLife    3.8t -> 50%
  //   attackBullet 3.9t -> 53%
  //   arcaneRay    4.7t -> 71%
  // It is the longest reach he owns and the Crystal Focus is what grants it
  // (`grantedByEquipment: true`) - so it lives and dies with that focus
  // staying equipped, which the junk allowlist already guarantees.
  //
  // attackShort RIDES HERE FOR THE SERVER, NEVER FOR US (2026-08-27). Every
  // projectile art he owns spawns its bullet about 35px toward the target, so
  // at contact the world refuses PROJECTILE_DEAD_ZONE and a grub standing on
  // him met a caster who could not fire anything at all. Putting the melee
  // art into `use_skills` gives the server's own rotation a point-blank
  // option; `worthCasting()` keeps the harness from ever choosing it. It sits
  // at level 1, TYING with attackBullet - melee-is-not-a-casters-top-rung
  // pins that the pick must not depend on where a rung sits in the array.
  skillLadder: [
    { level: 0, skill: 'arcaneRay' },
    { level: 1, skill: 'attackBullet' },
    { level: 1, skill: 'attackShort' },
    { level: 14, skill: 'boneSpear' }
  ],
  manaSpell: 'lifeTap',
  drainSpell: 'drainLife',
  // The 2026-08-13 restock: a sovereign of fire buys foci (they scale
  // mAtk, the fireball's whole career) and silk, not steel.
  gearLadder: CASTER_GEAR,
  armorLadder: CASTER_ARMOR,
  // Wren keeps the mage's shop - wands, staffs, foci and the potion drawer -
  // which is where a focus is actually sold. Sending his to the smithy for
  // one would be sending his to a counter that has never stocked it.
  shopRoom: 'the-valley-mage',
  shopKeeper: 'Wren',
  duelWeapons: ['crystal_focus', 'ember_focus', 'wide_blade'],
  // HE IS THE ONE WHO NEEDS THE FOOD (Glenn, 2026-08-27). Measured: he spends
  // 43% of his life under a quarter health, against Sir Qwen's 0%, because a
  // Magus pays blood for magic - `lifeTap` costs 15 hp to make 15 mp - and has
  // no heal on his class path. Cooked fish is the only healing he will ever
  // own. `millrace-ford` is frontier level 10, the safest room in the world,
  // not the level-18 room that killed these trips before.
  //
  // NO MINING, and it is a decision rather than an omission: ore yields ore,
  // he cannot smelt it, and the seam is 151 tiles from where he hunts - so
  // the walk buys him nothing he can eat. the-professions.test.mjs pins it.
  professions: ['fishing', 'foraging', 'jewelcrafting', 'tailoring', 'woodcraft', 'cooking'],
  // Attempted whenever Sir Qwen's bar drops below 60%; armed the moment
  // the gateway allows casting.
  // conjure_food is not in the warlock kit (the world said so), and a
  // failed conjure was poisoning the session's fireballs via the
  // cannot-do handler. No feast until a class that cooks exists.
  // The sovereign's final station (user order): CLOSE to the knight,
  // supporting fire from behind him - the engine's long_range style
  // streams free bullets continuously, fireballs ride on top whenever
  // lifeTap has filled the pool, and keep_distance holds his spacing.
  // CLOSE_UP, not long_range (2026-08-15). The engine defines
  // long_range as "hit from a distance" and enforces it by WALKING THE
  // BODY BACKWARDS - which, once the trees started hitting back, meant
  // he reversed across the forest all night. He still casts (his
  // skills are passed separately); he just does it standing still.
  // Ranged again, but at a SANE ring: five tiles is inside his bolt's
  // reach and far enough that he is not standing in the fight. The old
  // seven-tile setting is what made the engine walk his backwards across
  // the whole forest once the trees started hitting back.
  battleStyle: 'long_range',
  // FIVE IS CORRECT - do not "fix" this to a smaller number. It was briefly
  // cut to 2.2 on 2026-08-16 and that was wrong twice over. His real weapon
  // is attackBullet, range 250px = 7.81 tiles (the server's own skill-costs
  // table), so 2.2 is about a quarter of him actual reach: it walked a cloth
  // caster to melee distance, and it also drove the server's own spacing
  // reflex down to min(keepDistance, 7) = 2, so the engine stopped backing
  // his away until something was already on top of him - and he has no
  // flee threshold set. The evidence used to justify 2.2 was a thornwhip
  // refusal, and thornwhip is SIR QWEN's skill, not the king's; that log
  // line was Qwen's, misread onto Lord Gemma's sheet.
  // THREE, and the argument above is settled by a unit, not a preference.
  // A skill's reach is in PIXELS and a tile is not one size: millers-stair,
  // where he actually hunts, is a 64px map and nearly everywhere else is
  // 32px (see tilePxFor). So both earlier notes were right about different
  // rooms - attackBullet's 250px IS 7.81 tiles at 32px and 3.9 at 64px -
  // and five was measured at zero damage because five 64px tiles is 320px,
  // outside attackBullet (250) and drainLife (240) both.
  //
  // Three is inside his reach in either map (192px at 64, 96px at 32) and
  // outside a grub's. The 0.8 that replaced five was worse than the 2.2 the
  // note above forbids: it is his STAFF's reach, so keep_distance_tiles
  // rounded to 1 and stood a cloth caster in the middle of the pack. The
  // reason given for it - that melee is all he has when the pool runs dry -
  // is false: measured 2026-08-25 his pool is 576/576 and never falls, while
  // 119 swings were refused OUT_OF_RANGE and he was driven to 14hp of 542.
  attackRange: 3,
  goal: {
    aim: 'fight at Sir Qwen\'s side and never leave it. Whatever room the '
      + 'knight stands in is your post: hunt the monsters he hunts, burn '
      + 'them with fire while he takes the front, sweep up every drop, '
      + 'and rest in town when he rests. Grow strong together - kills, '
      + 'credits, gear when the merchants finally stock any - and if a '
      + 'champion calls either of you to the duel circle, answer as a '
      + 'pair: with courtesy, and with victory. Above all: neither of '
      + 'you dies. When the fight turns, you both leave together.',
    done: 'you and Sir Qwen have slain five hundred monsters together'
  },
  // SLOWED 2026-09-02 to give the GPU back to the work services. Engaged was
  // 12s - five model calls a minute while fighting, and he was the heaviest
  // caller of the three. The card was measured at 96% utilisation with the
  // characters alone, before Grunnur/Meet Pete traffic existed.
  // Cost, stated plainly: he reacts to a fight every 36s instead of every 12s,
  // so he takes more damage per kill. Revert this pair to { idle: 60,
  // engaged: 12 } if the grind matters more than the GPU on a given day.
  pace: { idle: 120, engaged: 60 },
  // RECALL CUT 10 -> 3 (2026-09-02) because it, not the beat rate, was what
  // pinned the GPU at 99%.
  //
  // Measured that day: prompts of 66,765-93,482 tokens against a server whose
  // --ctx-size is 40,960 - so 27 requests were REJECTED outright with
  // "exceeds the available context size". At the measured 1,525 tok/s prompt
  // rate a 72k prefill is ~47 SECONDS of solid GPU, and three calls a minute
  // is ~141 seconds of work per 60 - 2.3x oversubscribed, before Grunnur or
  // Meet Pete ask for anything.
  //
  // `lastMessages: recall` (memory.ts:461) replays this many past turns into
  // every call. A royal's turn carries a world observation listing a dozen
  // enemies plus tool results, so ten of them is ~70k tokens to decide one
  // ~200-token action. Three keeps the immediate thread and cuts the prefill
  // by roughly two thirds.
  //
  // Slowing the beat could never fix this: it reduces how OFTEN a 47-second
  // call happens, not what it costs. Fanshawe keeps recall 10 - his messages
  // are small (~6,300 tokens for the window) and he carries `remembers`.
  recall: 3,
  wordiness: 25,
  // Off on purpose: persistent memory regrew past the context window
  // within half an hour of play and hung every model turn. A grinder
  // needs its reflexes and this turn's conversation, not last week's.
  remembers: false
};
