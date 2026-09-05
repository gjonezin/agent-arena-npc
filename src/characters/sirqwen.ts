/**
 * Sir Qwen: the knight whose oath is measured in kills.
 *
 * Built against what the live game actually has (checked 2026-08-11):
 * enemies by the hundred in the wild rooms, reflex battle with tactics
 * styles, drops, merchants, credits, signed duels, and a level/XP bar
 * the spectator viewer shows even though the agent API does not.
 * Reuses the existing "Sir Qwen" registration on this key.
 */

import { Agent } from '@mastra/core/agent';
import { CharacterSheet } from '../harness/npc.js';
import { Autonomous } from '../harness/behavior.js';
import { SWORD_ARMOR, SWORD_GEAR } from '../harness/reflex.js';
import { TOWN } from '../harness/world.js';
import { loadPersona } from '../persona.js';

export const sirqwen: CharacterSheet = {
  id: 'sirqwen',
  playerName: process.env.ARENA_PLAYER_NAME ?? 'Sir Qwen',
  classPath: 'swordsman',
  // HOME IS THE HUNTING GROUND, NOT THE TOWN (2026-08-15). With homeScene
  // set to TOWN the round's whole cycle pointed back at the town gate, and
  // the gate is the door at COLUMN 3 - the forest's western boundary. That
  // is what marched both characters into the map edge again and again and
  // left them marooned in an empty corner with the nearest enemy nineteen
  // tiles away. The field is where the work is, so the field is home.
  homeScene: 'reldens-bots-forest',
  persona: loadPersona('sirqwen'),
  model: process.env.NPC_MODEL ?? 'qwen3-vl-32b',
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
  capabilities: ['speak', 'talk_to_folk', 'walk', 'doors', 'fight', 'craft', 'trade', 'purpose'],
  behavior: (agent: Agent) => new Autonomous(agent),
  // The round runs on reflex; the model speaks only when spoken to.
  reflex: 'knights-round',
  // NO PARTNER BOND (user order 2026-08-15: "stop them from following
  // each other"). Each hunts the forest on its own. The bond cost far
  // more than it bought: the follower spent his rounds walking to a
  // leader who had already moved on, and the leader idled at town gates
  // waiting for him. Party XP is shared without standing together.
  // partner: 'Lord Gemma',
  // role: 'leader',   // nobody leads, nobody follows
  // The twist nobody wrote: the SWORDSMAN carries the heal. His kit,
  // per the world itself: attackShort, heal. The shield mends what it
  // guards.
  // RESCUE ONLY (user order 2026-08-15): he does not follow Lord Gemma
  // about, but when the king's bar drops under half he crosses the forest,
  // heals him, and kills whatever is chewing on him. This is deliberately NOT
  // `partner`, which would restore the constant-following bond we just
  // removed.
  rescuePartner: 'Lord Gemma',
  // Tried healInPassing: 'Fanshawe Rubato' the same night (2026-08-15) -
  // dropped by user order to keep focus on the treasure/equip problem.
  // The field and its reflex block stay in the codebase (harmless, unused
  // by any sheet now), same as the crypt ranged-tactics fields above.
  /**
   * The trades this character works. Plain names, deliberately NOT a
   * levelled ladder: profession level is the world's to know, and
   * `arena_recipes` already answers `canMake` per recipe against the live
   * skill. A sheet-side copy would be a second source of truth that drifts.
   *
   * Mining is Sir Qwen's alone: it yields Copper/Iron/Silver/Gold Ore and
   * nothing else, so it feeds smelting and then his forge. Lord Gemma's
   * line is gems, cloth and wandwood. The one thing they trade is cut
   * gems, which both a blade and a wand want.
   *
   * NOTHING DRIVES THESE YET. Profession experience writes to a separate
   * per-skill ledger and never touches character level, so a gathering
   * beat is a beat taken from the only number the grind is measured in.
   * This is the allowlist a beat would read WHEN one is justified.
   */
  professions: ['fishing', 'mining', 'foraging', 'smelting', 'blacksmithing', 'cooking'],
  // OFF, AFTER TWO SUPERVISED ATTEMPTS (Glenn, 2026-08-27).
  //
  // The reasoning that turned it on was that the frontier table rates
  // `oathstone` at level 18 against Sir Qwen's 46, so it should be
  // comfortable. It is not. Watched live, arriving at FULL health with the
  // fitness gate working exactly as intended:
  //
  //   17:01:00  the-valley-inn   hp 836/836   (healed, set out whole)
  //   17:01:29  oathstone        hp ?         (arrived)
  //   17:01:37  oathstone        hp 10/836    Stoneclaw *HITTING*
  //
  // **826 hit points in about eight seconds.** A recommended level says what
  // a room is balanced around, not what its mobs hit for - these strip a
  // level-46 body with a heal spell before it can cast. The first attempt was
  // dismissed as "he set out spent"; the second, from full, ended identically.
  //
  // Glenn said to avoid Oathstone and the analysis talked past him. Two runs,
  // same result, zero charges. Off until the world offers foraging ground
  // that a body can stand on - or until these two can beat a Stoneclaw.
  foragingTrip: true,
  banterWith: 'Lord Gemma',
  healSpell: 'heal',
  // Fifty, by order. With no art competing for the pool there is more of it
  // to spend on staying up, and heal is the cheapest thing he owns at 2 mp.
  healBelowPercent: 50,
  feastSpell: 'conjureFood',
  // NO OFFENSIVE ART AT ALL. THE MANA IS FOR STAYING ALIVE (user order,
  // 2026-08-25: "have Qwen not burn all his mp on skills other than healing.
  // His melee should be enough at this point"). It is.
  //
  // Measured 2026-08-25 from his own battle.events: the greatblade lands
  // **252 to 512 per swing** against a Groove Grub holding 150 and a Hollow
  // Caller holding 160. He one-shots everything in the room, which is why his
  // hp read 351/644 across 437 straight samples with `aggressors: []` - none
  // of them survive to swing back.
  //
  // Against that, thornwhip is base 17 and costs **13 mp**, and it fed BOTH
  // spenders: `use_skills` on the server's own rotation and `strike()`'s cast
  // in the harness. What that mana is actually worth to him:
  //   heal         2 mp -> +10 hp
  //   conjureFood  6 mp -> +14 hp
  // Thirteen mana is six heals. He has been sitting at 44% hp with 1 mp,
  // two short of a heal he has known since level 5, while his whole pool went
  // on an art that adds nothing to a body that already one-shots the room.
  //
  // An empty ladder is the whole mechanism: `strike()` and the hunting beat
  // both end at `{ action: 'attack' }` with no rung and no `spell`, which is
  // arena_basic_attack - the measured 252-512 path. healSpell and feastSpell
  // are separate rules and are untouched.
  skillLadder: [],
  // Back to close_up: the best grind ever measured (30 kills/17min) was
  // the ENGINE fighting continuously in melee - one harness arrow every
  // nine seconds cannot compete against harmless timber. The bow stays
  // in the pack for the day a dangerous zone pays again.
  battleStyle: 'close_up',
  // HE HAD NO REACH AT ALL, AND SO NEVER SWUNG (2026-08-16). This field was
  // simply absent, so effectiveAttackRange() returned undefined and the
  // target-lock advance in npc.ts fell back to `?? 1.5`. The gate there is
  // `distanceTiles > reach`, measured against an observation the code itself
  // documents as seconds stale, on enemies that move - so a demand for 1.5
  // tiles was never satisfied and the beat spent itself walking instead of
  // attacking, every time. Measured across 80 minutes: every single
  // [attack-verdict] came back OUT_OF_RANGE, and nothing died all afternoon.
  // 1.5, NOT the 1.6 the refusal prose prints. The server's verdict rounds
  // for display - Math.round(px/32*10)/10 - so a 50px reach prints as "1.6"
  // though it is 1.5625, and it rounds UP. The real check is Chebyshev in
  // PIXELS, centre to centre, spread <= range, so taking 1.6 as a bound puts
  // the gate at 51.2px against a 50px reach and an axis-aligned swing at
  // exactly that distance is refused. Never derive a bound from the printed
  // number; floor it.
  // 0.8, because that is what the weapon actually reaches. Measured
  // 2026-08-24 across 316 attack verdicts: every one says "attackShort
  // reaches about 0.8" and every one was refused OUT_OF_RANGE, because this
  // number feeds keep_distance_tiles - so the server was told to hold him at
  // 2 tiles and swing a weapon that reaches 0.8. Zero damage dealt over the
  // whole window. The last of the 32px->64px conversion: the leash constants
  // moved and this did not.
  attackRange: 0.8,
  // Tried the crypt as that day (2026-08-15): rangedInScene: 'arena-crypt'
  // drew the bow and held at range, but the server-side tactics push that
  // makes "hold at range" real did not land until ~7 seconds after arrival
  // - he walked in still on his prior close_up settings, five enemies
  // swarmed him in that window, and he died before the ranged positioning
  // ever took effect. Reverted (user order): steel back out, nearest
  // target, everywhere, crypt included. No scene-conditional tactics at
  // all now, which also removes the whole class of bug this was - there
  // is no transition to race.
  // The 2026-08-13 restock: bows for the grind, steel for the circle,
  // true armour at last - mail, then plate.
  gearLadder: SWORD_GEAR,
  armorLadder: SWORD_ARMOR,
  // The smithy is his counter: Nerys sells steel, which is the whole of his
  // wish-ladder. She is a real class_type 5 trader, unlike Toma at the
  // trading post, who only talks - that near-miss is what cost the last run.
  shopRoom: 'the-valley-smithy',
  shopKeeper: 'Nerys',
  // The treasure route is OFF, and not by preference: every cache in
  // TREASURE_CACHES sits in a room behind the sealed south road, so the one
  // stop this flag used to buy him - the grassland's Rush-Wrapped Chest - is
  // no longer somewhere he can stand. He already has its boots. Turn this
  // back on when caches are surveyed in the valley or on the stair.
  treasureRun: false,
  duelWeapons: ['knight_greatblade', 'steel_longsword', 'wide_blade'],
  goal: {
    aim: 'grow into the most powerful agent in this arena. Gain every '
      + 'scrap of experience the world will grant toward every level, '
      + 'slay monsters by the hundred, sell what they drop, and buy and '
      + 'equip the best gear the merchants sell. Work the knight\'s '
      + 'round like a clock: out from town to the forest, slay, collect '
      + 'every drop, back to town, sell, and save every coin for the '
      + 'finest weapon the merchant sells - spend on steel first and no '
      + 'potions, but DO buy and keep the tools of your trades, and never '
      + 'sell them. Heal to whole, and rest safe in town between '
      + 'rounds. Answer everyone who speaks to you. When a champion '
      + 'calls you to the duel circle, accept with courtesy and win. '
      + 'Above all: never die.',
    done: 'you have slain five hundred monsters and won ten duels'
  },
  // One turn a minute, always - the knight's round is a clock, not a
  // mood. Between turns his body rests in town or reflex-fights.
  // SLOWED 2026-09-02, same reason as Lord Gemma - see his note. He was
  // already the gentlest of the three at 60/60; this is a smaller cut.
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
