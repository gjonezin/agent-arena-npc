/**
 * The core an NPC runs on.
 *
 * Every character does the same three things forever: look at the room, answer
 * anyone who spoke to it, and then do whatever its behaviour says to do next.
 * Barnaby, the Wanderer and Guy differ only in the behaviour they are given and
 * the actions they are allowed, so the differences between them live in their
 * own files and not in here.
 *
 * The loop is written to outlive the game as it is today. Fighting and money
 * are already actions; when the world grows something worth hitting or a way to
 * be paid, a character gets that capability and starts using it without this
 * file changing.
 */

/**
 * How near a node has to be to be worth one beat.
 *
 * TWENTY, and this is the constant that actually reaches `gatherNearby` -
 * `GATHER_WITHIN_TILES` in reflex.ts does not, which an adversarial review
 * caught after it had been "raised to 20" with no effect at all.
 *
 * The number is set by where the bodies really are. They LEAVE
 * `millers-stair` from tile (89,157) on every town trip; iron ore is at
 * (90,171) and copper at (91,174) - fourteen and seventeen tiles. Twelve
 * missed both, every time, several times an hour, for the life of this
 * harness.
 *
 * Twenty is not a guess at a good radius; it is the measured distance from
 * the door they already use to the seam they have never worked.
 */
const GATHER_RADIUS_TILES = 20;
/** On a deliberate trip, the whole room is in scope. */
const GATHER_ROOM_TILES = 60;

/**
 * The radius one gather beat is allowed, and the ONLY place that choice is
 * made - the beat below calls nothing else.
 *
 * It is exported for one reason: until it existed, both `GATHER_RADIUS_TILES`
 * 20 -> 1 and 20 -> 60 left the whole suite green, because every gather test
 * passed its own literal radius to `Actions.gatherNearby` and none of them
 * ever asked what this file passes. A constant nothing observes is a comment.
 * See test/the-radius-that-reaches-the-seam.test.mjs, which feeds what this
 * returns into the real gather and holds it between the two distances that
 * define it: near enough to reach the stair's seams at fourteen and
 * seventeen tiles, far short of the whole-room sweep a trip is granted.
 */
export function gatherRadiusFor(step: { wide?: boolean }): number {
  return true === step.wide ? GATHER_ROOM_TILES : GATHER_RADIUS_TILES;
}

import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Agent } from '@mastra/core/agent';
import { ArenaClient, Observation, othersIn, sceneOf, spokenLines } from './arena.js';
import {
  Actions,
  Capability,
  DEFAULT_WORDS,
  Intent,
  harpingOn,
  isTooSimilar,
  sleep,
  toSpeech
} from './actions.js';
import { Explorer, Perception, RoomView, describeDoors } from './explore.js';
import {
  BOOKKEEPING,
  Behavior,
  MemoryScope,
  Situation,
  askForIntent,
  momentOf,
  describeSituation,
  lengthGuidance
} from './behavior.js';
import {
  WorkingMemoryState,
  buildMemory,
  keepMemoryDigested,
  describePeople,
  describePlacesKnown,
  doubtPlace,
  findTodo,
  hasMet,
  noteFace,
  noteGoingsOn,
  memoryScope,
  notePlace,
  recallAbout,
  readMemory,
  restartWhenCompactionJams,
  writeMemory
} from './memory.js';
import { Goal, Plan } from './plan.js';
import { STEPS_PER_TURN, arenaToolbox } from './agentic.js';
import { KnightsRound, nextDoorToward } from './reflex.js';
import { ownHealth, locate, othersIn as feedOthersIn } from './health.js';
import { readMarketLore, writeMarketLore, type MarketLore } from './market.js';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';

const RALLY_DIR = process.env.NPC_RALLY_DIR ?? '/npc/rally';
const RALLY_FILE = `${RALLY_DIR}/leader.json`;

function publishRally(plan: { leg: string; dest: string }, scene: string): void {
  try {
    mkdirSync(RALLY_DIR, { recursive: true });
    writeFileSync(RALLY_FILE, JSON.stringify({ ...plan, scene, at: Date.now() }));
  } catch {
    // A missing rally file just means the follower falls back to the feed.
  }
}

function readRally(): { leg: string; dest: string; scene: string } | null {
  try {
    const body = JSON.parse(readFileSync(RALLY_FILE, 'utf8')) as {
      leg: string; dest: string; scene: string; at: number;
    };
    return Date.now() - body.at < 60_000 ? body : null;
  } catch {
    return null;
  }
}
import { withPrimer } from './primer.js';
import { withFallback } from './models.js';
import { skillsFor } from './skills.js';
import { learnPrices, meter, note } from './spend.js';
import {
  describeLocalKnowledge,
  describePlaces,
  isHomeTurf,
  plainSceneName,
  sceneNamed,
  tilePxFor
} from './world.js';

const FIELD_SCENE = 'reldens-bots-forest';

export type CharacterSheet = {
  /** Stable id, also the memory resource. */
  id: string;
  /** The name above their head in the world. */
  playerName: string;
  classPath?: string;
  homeScene: string;
  /** The system prompt: who this is. */
  persona: string;
  model: string;
  capabilities: Capability[];
  /** How they spend their time. Built with the agent, so it can use the model. */
  behavior: (agent: Agent) => Behavior;
  /**
   * What they start out trying to bring about, if anything. A seed: it fills an
   * empty memory, and a character given the 'purpose' capability can settle on
   * something else once this is done or hopeless. Editing it here still
   * redirects a character that has chosen its own. See plan.ts.
   */
  goal?: Goal;
  /** Seconds between decisions when idle, and when mid-conversation. */
  pace?: { idle?: number; engaged?: number };
  /**
   * How much they say at a stretch, in words. A trait, not a limit: a talkative
   * innkeeper and a taciturn wanderer are different people, and this is part of
   * how. Capped at MAX_WORDS whatever is set here.
   */
  wordiness?: number;
  /** Whether they remember anything between restarts. */
  remembers?: boolean;
  /**
   * How many past messages ride along on every call. Left unset for almost
   * everybody: see DEFAULT_RECALL in memory.ts for who needs more and what it
   * costs.
   */
  recall?: number;
  /** 'knights-round' runs the deterministic hunt loop; the model only answers speech. */
  reflex?: 'knights-round';
  /** Stay in this player's room; hunt only beside them. */
  partner?: string;
  /** Cast this instead of half the swings while hunting. */
  spell?: string;
  /** 'leader' waits for the partner at the field; 'follower' chases. */
  role?: 'leader' | 'follower';
  /** Cast on the partner when their health drops below 60%. */
  /**
   * Who this character talks TO, for speech only.
   *
   * Deliberately not `partner`: that field restores the constant-following
   * bond removed by user order 2026-08-15, and this must move nobody. It is
   * a name to aim a line at and a reason to open one's mouth, nothing else.
   */
  /** The trades this character works. See the sheets; nothing drives it yet. */
  professions?: readonly string[];
  /**
   * May this body make the journey to foraging ground? Off by default and
   * per-character on purpose: the only level-1 foraging nodes in the world sit
   * in `oathstone` (frontier level 18) and `sinkfoot-crossing` (level 26), and
   * a body that cannot survive the arrival tile simply dies there. Sir Qwen
   * carries 836hp and a heal; Lord Gemma's ceiling is 633 and he has neither.
   */
  foragingTrip?: boolean;
  /** Where the foraging trip goes. Defaults to the town pond. */
  forageRoom?: string;
  banterWith?: string;
  healSpell?: string;
  /** hp% the engine arms healSpell at. Default 55; Sir Qwen runs 50 by order. */
  healBelowPercent?: number;
  /** Reflex battle style set each hunt (close_up default; long_range = caster). */
  battleStyle?: string;
  /** Skills by unlock level; the best earned one casts automatically. */
  skillLadder?: Array<{ level: number; skill: string }>;
  /** Conjured at rest to eat back health and magic. */
  feastSpell?: string;
  manaSpell?: string;
  /** hp% above which the mana spell may be cast. Default 70. */
  tapAboveHpPercent?: number;
  drainSpell?: string;
  /** The weapon wish-ladder for this class, best first (default: the
   *  swordsman's blades). The Magus hands in a focus ladder instead. */
  gearLadder?: import('./reflex.js').GearRung[];
  /** The armour wish-ladder, best first: mail and plate for the knight,
   *  robes and vestments for the Magus. */
  armorLadder?: import('./reflex.js').GearRung[];
  /** Item keys of the class steel drawn ONLY when a duel forms, best
   *  first. Field dress is the bow; this is the dress uniform. */
  duelWeapons?: string[];
  /** Plays a melody every 20s, forever. The bard's whole job. */
  busks?: boolean;
  /** Posted to one spot for good: every movement path refuses. */
  neverMoves?: boolean;
  /** How close this character needs to be to strike, in tiles. A caster
   *  stops on this ring instead of closing to melee. */
  attackRange?: number;
  /** One scene where this character fights ranged instead of its normal
   *  battleStyle/attackRange/weapon - crypt-only bow doctrine for a normally
   *  melee knight (user order, 2026-08-15): tougher crypt enemies swarm a
   *  body that closes to melee, so approach only to rangedAttackRange and
   *  hold there, same "stop at weapon range, do not charge" ring the caster
   *  already uses. Undefined means never switch. */
  rangedInScene?: string;
  /** Walk the treasure route as well as grinding. One character only - a
   *  cache pays out once, so sending the pair wastes the second trip. */
  treasureRun?: boolean;
  /** The room this character's trader keeps shop in, crossed into before any
   *  buying or selling. The valley's counters are all indoors, so a trader is
   *  a door away, not a walk away. See KnightsRound's options for the rest. */
  shopRoom?: string;
  /** The trader standing in shopRoom, walked to by name once inside. */
  shopKeeper?: string;
  /** The reach held while in rangedInScene, in tiles. */
  rangedAttackRange?: number;
  /** Weapon keys tried in order (equipFirstOwned) on entering rangedInScene,
   *  so the ranged strategy is not just positioning - the character is
   *  actually holding a bow, not swinging a sword from nine tiles away. */
  rangedWeapons?: string[];
  /** Cross the map to heal and defend this ally when they fall under half. */
  rescuePartner?: string;
  /** Heal this person if already in the same room and under half health -
   *  never travels to find them, only acts when crossed paths with in
   *  passing (2026-08-15: Sir Qwen and Fanshawe Rubato, on his way through
   *  wherever he happens to be, not a detour). Deliberately lighter than
   *  rescuePartner, which crosses rooms via doors - this never does. */
  healInPassing?: string;
  /** The door LABEL that leads to the stage room. */
  stageDoor?: string;
  /** Where in the room he stands: back wall, facing the house. */
  stageSpot?: { x: number; y: number };
  /**
   * Walked to first, so the last step onto stageSpot comes FROM here.
   *
   * There is no facing tool: a body ends a walk looking the way it last
   * moved. So to face south a character has to arrive from the north, and
   * the only way to say that is to name the tile above the mark and go there
   * first. Put this one tile off stageSpot, on the side you want it to have
   * its back to.
   */
  stageApproach?: { x: number; y: number };
  /** Which way he ends up looking once on the mark. */
  stageFacing?: 'north' | 'south' | 'east' | 'west';
  /** A named mark the crown wants confronted: the royals ride to
   *  whatever room this player stands in whenever nothing is swinging
   *  at them, and the prey ceremony fires on arrival. */
  bounty?: string;
  /**
   * Facts held in the system message rather than in memory, so they cannot fall
   * out of a window or be overwritten by something a guest asserted
   * confidently. For a character whose job is being right about this world.
   */
  pinned?: string;
  /**
   * Rooms whose real places this character knows by heart without standing in
   * them. For a local, not for everybody: see describeLocalKnowledge().
   */
  localKnowledge?: string[];
};

const RECONNECT_SECONDS = 15;
const DEFAULT_IDLE_SECONDS = 90;
const DEFAULT_ENGAGED_SECONDS = 4;
/**
 * How many of its own lines a character holds against a new one.
 *
 * Eight was set when a line went out every sixty seconds - about eight minutes
 * of memory. The spark gate is five minutes now and partner banter four, so
 * eight lines is over half an hour and the window has to stretch with it or
 * the same joke comes round again just outside it.
 *
 * This is a topic comparison, not a string one (see worthSaying), so widening
 * it costs a little more silence and buys a lot less sameness - which is the
 * trade the user asked for: "says similar things every few minutes that it
 * gets annoying and is not really funny".
 */
const RECENT_LINES = 14;
/**
 * How much of the conversation a character carries in its head.
 *
 * This was fifty, on the reasoning that the models are cheap and losing the
 * thread is the expensive failure. Both halves were true and the sum was not:
 * the transcript goes into every prompt, so fifty lines is fifty lines paid for
 * on every tick, forever, by every character. Twenty covers the exchange a
 * character is actually in, and what matters beyond it has already been written
 * into memory, which is what memory is for.
 */
const TRANSCRIPT_LINES = 20;
const MEMORY_DIR = process.env.NPC_MEMORY_DIR ?? '/npc/var';

/**
 * How many recent moves count as "lately" when deciding somebody is circling.
 * Eight is long enough to catch a there-and-back-again and short enough that a
 * character which has genuinely moved on stops being nagged about it.
 */
const CIRCLING_WINDOW = 8;

/** How many lines of a room's own conversation come back on walking in again. */
const ROOM_LINES = 4;

/** Plain English for how long ago, because "1786376624125" tells nobody anything. */
function howLongSince(when: number): string {
  const minutes = Math.round((Date.now() - when) / 60_000);
  if (minutes < 1) {
    return 'a moment ago';
  }
  if (minutes < 60) {
    return `about ${minutes} minute${1 === minutes ? '' : 's'} ago`;
  }
  const hours = Math.round(minutes / 60);
  return `about ${hours} hour${1 === hours ? '' : 's'} ago`;
}

function log(...parts: unknown[]): void {
  console.log(new Date().toISOString().slice(11, 19), ...parts);
}

/** Which tile the character is standing on, for saying which way a door lies. */
function tileOf(observation: Observation): { row: number; column: number } | null {
  const state = observation.ownPlayer?.state;
  const x = Number(state?.x);
  const y = Number(state?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }
  // The room's own tile size, not 32: tileOf feeds describeDoors, and a
  // doorway named at half its true tile is a doorway somewhere else.
  const px = tilePxFor(state?.scene as string | undefined);
  return { row: Math.floor(y / px), column: Math.floor(x / px) };
}

/**
 * The opus, in pieces. Eight bars is the gateway's limit and a mercy.
 * Each entry is playable notation the world accepts - and each is the
 * wrong choice for what it claims to be, which is the whole joke: the
 * descriptions promised rain on a gutter, the performance delivers a
 * cart losing a wheel downhill.
 */
/**
 * ONE CONTINUOUS SONG, IN FIVE MOVEMENTS (Glenn: "fill the gaps so it
 * sounds like a continuous song").
 *
 * Every phrase is in C, shares the same tempo, and starts on the note the
 * previous one ended on, so the seam between calls lands as a bar line
 * rather than a stop. Bars are timed off the gateway's own arithmetic -
 * a step is 30000/bpm ms, a bar is eight steps - and the next phrase is
 * queued for the instant the last note of this one decays.
 *
 * The instrument stays the lute throughout: swapping horn for flute
 * mid-song was the other thing making it sound like separate clips
 * rather than one performance.
 */
const CONTINUO_BPM = 100;
/**
 * ONE CONTINUOUS SONG, IN FIVE MOVEMENTS, EACH ITS OWN THING.
 *
 * Continuity comes from key and tempo (all C, all 100bpm) and from the
 * handoff note - each phrase opens on the note the last one held. What
 * changes movement to movement is the HARMONY and the accompaniment
 * pattern, because five phrases over the same four chords in the same
 * arpeggio is not a song, it is a loop with ambitions. So: a plain
 * statement, an alberti answer, an oompah at the tavern's insistence, a
 * ringing block-chord lament, and an arpeggiated return that lands back
 * on C so the whole thing joins its own tail.
 */
const REPERTOIRE: Array<{
  title: string;
  melody: string;
  chords?: string;
  bars: number;
  instrument: 'lute' | 'flute' | 'horn' | 'bell';
  pattern: 'arp' | 'alberti' | 'oompah' | 'block';
  bpm: number;
}> = [
  {
    // I - vi - IV - V, opens on C, hands over a G
    title: 'the opus, first statement',
    melody: 'C ~ E G A ~ G ~ | F E D E C ~ ~ ~ | C ~ E G A ~ B ~ | C5 ~ B ~ G ~ ~ ~',
    chords: 'C Am F G', bars: 4, instrument: 'lute', pattern: 'arp', bpm: CONTINUO_BPM
  },
  {
    // V - iii - ii - V7, takes the G, hands back an E
    title: 'the answering phrase',
    melody: 'G ~ A B C5 ~ B ~ | A ~ G ~ F ~ E ~ | D ~ E F G ~ A ~ | G ~ F ~ E ~ ~ ~',
    chords: 'G Em Dm G7', bars: 4, instrument: 'lute', pattern: 'alberti', bpm: CONTINUO_BPM
  },
  {
    // IV - I - IV - V, the tavern's oompah, E up to A
    title: 'the tavern insists on a dance',
    melody: 'E - G - E - G - | F ~ A ~ G ~ F ~ | E - G - C5 - A - | B ~ C5 ~ A ~ ~ ~',
    chords: 'F C F G', bars: 4, instrument: 'lute', pattern: 'oompah', bpm: CONTINUO_BPM
  },
  {
    // vi - iii - IV - i, block chords ringing under the lament, A down to C
    title: 'the lament, held in the same key',
    melody: 'A ~ ~ C5 B ~ A ~ | G ~ E ~ D ~ C ~ | E ~ G ~ A ~ G ~ | E ~ D ~ C ~ ~ ~',
    chords: 'Am Em F Am', bars: 4, instrument: 'lute', pattern: 'block', bpm: CONTINUO_BPM
  },
  {
    // I - IV - V7 - I, the return, ending on C so movement one fits behind it
    title: 'the return, and back to the top',
    melody: 'C ~ D E F ~ G ~ | A ~ G ~ E ~ C ~ | C ~ E G C5 ~ G ~ | E ~ D ~ C ~ ~ ~',
    chords: 'C F G7 C', bars: 4, instrument: 'lute', pattern: 'arp', bpm: CONTINUO_BPM
  }
];

export class Npc {
  private readonly agent: Agent;
  private readonly behavior: Behavior;
  private readonly seen = new Set<string>();
  private readonly recentlySaid: string[] = [];
  /** Everything said in earshot lately, this character's own lines included. */
  private readonly transcript: Array<{ from: string; message: string; fresh: boolean }> = [];
  private notes: string[] = [];
  private round: KnightsRound | null = null;
  /** The last lore written to disk, so a save only happens on a real change. */
  private marketLore: MarketLore | null = null;
  private lastSocialTurnAt = 0;
  private healOthersOff = false;
  private sceneDisagreeTicks = 0;
  private lastCrisisKey: string | null = null;
  private unspokenThought: string | null = null;
  private lastPreyName: string | null = null;
  /** Rate limit on healInPassing - useSkillOnAlly() reports ok on send, not
   *  on the heal actually landing, so without this a heal that doesn't
   *  clear 50% would refire every beat instead of waiting to see if it
   *  worked. */
  private lastPassingHealAt = 0;
  // Effectiveness watch: the last body shot at, where it stood, and how
  // many arrows it has soaked without falling. Four is the alarm.
  /** Whether the ranged-scene weapon swap (see sheet.rangedInScene) has
   *  already been tried for the CURRENT stay in that scene - reset the
   *  moment the scene changes, so re-entering tries again, but a single
   *  stay only spends the one arena_equip call it needs. */
  private rangedWeaponDrawnFor: string | null = null;
  private lastShotAt: { label: string; tileX: number; tileY: number } | null = null;
  private shotsAtTarget = 0;
  private adjustStage = 0;
  private fieldReportTick = 0;
  private lastMelodyAt = 0;
  private melodyIndex = 0;
  private nextMelodyAt = 0;
  private performer: Actions | null = null;
  private performanceStarted = false;
  private onStage = false;
  /** Busking characters may talk at most once every three minutes: a
   *  model turn costs 60-90s of silence and the music comes first. */
  private lastTalkAt = 0;
  /** Last time arena_inventory was pulled as a fallback for a truncated
   *  arena_observe (see the holds() call below). Rate-limited so a pack
   *  too big to fit in one observe reply does not turn into an extra
   *  gateway call on every single tick. */
  private lastInventoryFallbackAt = 0;
  // WEDGE WATCHDOG (2026-08-15). A body pressed into a wall pocket used to
  // wait for the MODEL to notice and choose 'unstick' - a turn that costs
  // 60-90s and often never came, so a character could stand in a corner
  // being beaten for many minutes. This tracks the tile every beat and
  // cures a wedge deterministically, with no model turn involved.
  private lastTile: string | null = null;
  private sameTileBeats = 0;
  private wedgeCures = 0;
  private edgeTries = 0;
  /** How far inside the map's nearest edge the body was on the last rim
   *  beat, in tiles. Lets the rim recovery tell a walk that is working
   *  (depth increasing) from one that is stuck, so a legitimate two-beat
   *  step is not cut short by an unstick that could warp it out of the
   *  field entirely. Null until the first rim beat. */
  private lastRimDepth: number | null = null;
  private lockedTarget: { label: string; tileX: number; tileY: number } | null = null;
  private lockedUntil = 0;
  private lastPickLogged = '';
  private lastStageFixAt = 0;
  private lastDuelQueueAt = 0;
  private freshPreyStrike = false;
  private lastBountyRoom: string | null = null;
  private mentionStrikes = new Map<string, number>();
  private socialSpark = false;
  private wasInBattle = false;
  private turnInFlight = false;
  private readonly memory: MemoryScope;
  private readonly wordiness: number;
  /** The character's own todo list toward its goal, kept across restarts. */
  private readonly plan: Plan;
  /** What it can see of each room it has stood in. */
  private readonly perception = new Perception();
  /** Which corners of which rooms it has already been to. */
  private readonly explorer = new Explorer();
  /**
   * Rooms it has already written down this run, so it does not rewrite one
   * every tick. Checked against memory as well, because this set says nothing
   * about whether the write survived: the model can overwrite the whole record
   * from under it. See noteWhereItIs().
   */
  private readonly recorded = new Set<string>();
  /** Who this character is, kept because every model call now overrides it. */
  private readonly persona: string;
  /**
   * Faces already written down this run, keyed by room, so a bar full of
   * regulars is not rewritten to memory every twelve seconds. Guarded the same
   * way rooms are, and for the same reason - the model can overwrite the whole
   * record - by noteWhoIsHere() re-reading memory through remit().
   */
  private readonly faces = new Set<string>();
  /** The last action+note that failed, and how many times running. */
  /** The last few moves, for noticing a character crossing its own tracks. */
  private readonly lately: string[] = [];
  /** The character's Mastra memory, when it has one. See the constructor. */
  private readonly recollection?: ReturnType<typeof buildMemory>;
  /**
   * The gateway's MCP tools, filtered to this character's capabilities and
   * bound to its agent_id. Filled in by live() once the character is
   * registered, because the binding needs the agent_id and the Agent needs
   * the reference at construction - which is why the Agent gets a function.
   * Empty means not connected yet, and an agentic turn with no tools is a
   * turn that can only talk to itself, so live() fills this before the first
   * tick.
   */
  private toolbox: Record<string, unknown> = {};
  /** Per room: when it was last stood in, and what was said there. */
  private readonly rooms = new Map<string, { lastHere: number; said: string[] }>();
  private standingIn = '';
  private lastFailure = '';
  private failedWith = 0;

  constructor(private readonly sheet: CharacterSheet) {
    this.wordiness = sheet.wordiness ?? DEFAULT_WORDS;
    this.round = 'knights-round' === sheet.reflex ? new KnightsRound({ partner: sheet.partner, spell: sheet.spell, healSpell: sheet.healSpell, battleStyle: sheet.battleStyle, skillLadder: sheet.skillLadder, professions: sheet.professions, foragingTrip: sheet.foragingTrip, forageRoom: sheet.forageRoom, feastSpell: sheet.feastSpell, manaSpell: sheet.manaSpell, tapAboveHpPercent: sheet.tapAboveHpPercent, drainSpell: sheet.drainSpell, role: sheet.role, gearLadder: sheet.gearLadder, armorLadder: sheet.armorLadder, rangedInScene: sheet.rangedInScene, treasureRun: sheet.treasureRun, shopRoom: sheet.shopRoom, shopKeeper: sheet.shopKeeper }) : null;
    // Hand the round what an earlier run learned at the counters, so a
    // restart does not re-buy the same five minutes of walking. See market.ts.
    if (this.round) {
      const lore = readMarketLore(MEMORY_DIR, sheet.id);
      this.round.remember(lore);
      this.marketLore = lore;
      if (lore.nothingBuys || lore.unstocked.length > 0) {
        console.log('[market] remembered: '
          + (lore.nothingBuys ? 'nothing buys' : 'counters buy')
          + (lore.unstocked.length > 0 ? ', ' + lore.unstocked.length + ' unstocked key(s)' : '')
          + (null === lore.shoppedAtLevel ? '' : ', last shopped at level ' + lore.shoppedAtLevel));
      }
    }
    this.persona = withPrimer(sheet.persona + (sheet.pinned ? `\n\n${sheet.pinned}` : ''));
    // Kept on the instance rather than inlined into the Agent, because the
    // harness has to drive observation itself every tick - Mastra never runs
    // it for single-step turns. See keepMemoryDigested() in memory.ts.
    this.recollection =
      sheet.remembers === false
        ? undefined
        : buildMemory(sheet.id, MEMORY_DIR, sheet.recall, sheet.model);
    this.agent = new Agent({
      id: sheet.id,
      name: sheet.playerName,
      // Who they are, and then how to read the world they are standing in.
      // The primer is the same for everyone and never changes, so it lives in
      // the system message rather than being repeated in every situation.
      instructions: this.persona,
      // Never one model. The free router sits underneath whatever this
      // character would rather use, so an empty account makes it think more
      // cheaply instead of making the whole town stand still. See models.ts.
      model: withFallback(sheet.model),
      // The gateway's own MCP tools, arriving after registration; a function
      // because the toolbox is bound to an agent_id this constructor does not
      // have yet. See agentic.ts for what a character gets and why.
      tools: () => this.toolbox as never,
      // Memory that survives a restart. A character who has lived in a town
      // for years and forgets you between deploys is worse than one with no
      // memory at all. What it may remember is constrained by a schema, so
      // nothing it learns can rewrite who it is; see memory.ts.
      // Observation runs on the character's own cheap model, not the free
      // router: the free tier's thousand-a-day account cap killed compaction
      // by mid-afternoon and the unobserved backlog cost more than paid
      // observation ever would. See buildMemory().
      ...(this.recollection ? { memory: this.recollection } : {})
    });
    this.behavior = sheet.behavior(this.agent);
    // Every model call now overrides the agent's instructions so the situation
    // can ride along without being stored, which means whoever builds a prompt
    // has to carry the persona with it or the character answers as nobody.
    this.behavior.answersAs?.(this.persona);
    this.memory = memoryScope(sheet.id);
    this.plan = new Plan(
      this.agent,
      this.memory,
      sheet.goal,
      () => this.memoryStore(),
      this.persona
    );
  }





  /**
   * Rooms this character has stood in before today, from memory.
   *
   * Without this a redeploy tells everybody they have never been anywhere.
   * Guy was informed he had walked into town for the first time, having lived
   * there for days, which is worse than saying nothing: it is a confident
   * falsehood, and the door labels are built off the same record.
   *
   * The time is not recovered, only the fact, because memory keeps what a place
   * is rather than when it was last seen. "Been there before" without a time is
   * honest and is the half that matters when choosing a door.
   */
  private async rememberWhereItHasBeen(): Promise<void> {
    const state = await readMemory(await this.memoryStore(), this.memory).catch(() => null);
    for (const place of state?.places ?? []) {
      if (place.how !== 'been') {
        continue;
      }
      const scene = sceneNamed(place.where);
      if (scene && !this.rooms.has(scene)) {
        this.rooms.set(scene, { lastHere: 0, said: [] });
      }
    }
  }

  /**
   * What a character knows about the room it has just walked into.
   *
   * Paid for on arrival and not otherwise, which is the whole point. The
   * alternative, and what this world was doing, is carrying every scrap of
   * context in the rolling history so it happens to be there when needed: an
   * average call was reading thirty thousand tokens to have this much on hand.
   * Walking through a door is rare. Standing in a room is constant. Putting the
   * context on the rare thing is most of the saving available here.
   *
   * It is also better context than the history gave. A character re-reading two
   * hundred messages has to work out for itself which of them happened in this
   * room; this hands it that directly, with how long it has been.
   */
  /** attackRange, unless the current scene is sheet.rangedInScene, in which
   *  case rangedAttackRange applies instead - see the field docs on the
   *  sheet type. Centralized so the movement-side reads of this (positioning,
   *  retreat) cannot drift out of sync with the tactics-side read
   *  (reflex.ts's own, separate effectiveBattleStyle()). */
  private effectiveAttackRange(scene: string): number | undefined {
    return this.sheet.rangedInScene && scene === this.sheet.rangedInScene
      ? this.sheet.rangedAttackRange
      : this.sheet.attackRange;
  }

  private effectiveRanged(scene: string): boolean {
    return this.sheet.rangedInScene && scene === this.sheet.rangedInScene
      ? true
      : 'long_range' === this.sheet.battleStyle;
  }

  private arrivedSomewhere(scene: string): string | null {
    const known = this.rooms.get(scene);
    this.rooms.set(scene, { lastHere: Date.now(), said: known?.said ?? [] });
    if (scene === this.standingIn) {
      return null;
    }
    const first = !known;
    this.standingIn = scene;
    const name = plainSceneName(scene);
    if (first) {
      return `[You have walked into ${name}. You have not been here before.]`;
    }
    const lines: string[] = [
      0 === known.lastHere
        ? `[You are back in ${name}, which you have been in before.`
        : `[You are back in ${name}, ${howLongSince(known.lastHere)}.`
    ];
    if (known.said.length > 0) {
      lines.push('Last time you were here:');
      lines.push(...known.said.slice(-ROOM_LINES).map((line) => `  ${line}`));
    } else {
      lines.push('Nothing was said here last time.');
    }
    lines.push(']');
    return lines.join('\n');
  }

  /** Keep what was said where it was said, so walking back in can recall it. */
  private heardHere(scene: string, from: string, message: string): void {
    const room = this.rooms.get(scene) ?? { lastHere: Date.now(), said: [] };
    room.said.push(`${from}: ${message}`);
    if (room.said.length > ROOM_LINES * 2) {
      room.said.splice(0, room.said.length - ROOM_LINES * 2);
    }
    this.rooms.set(scene, room);
  }

  /**
   * Doing the same thing over and over and getting away with it.
   *
   * The failure counter above cannot see this, because none of it fails. A
   * character crossing back and forth through the same doorway is succeeding
   * each time and going nowhere, and the only thing that distinguishes it from
   * somebody with a reason is that nothing about the world changes.
   *
   * Two of the same move in a row is a person changing their mind. Four is a
   * loop, and by then it has usually been running much longer than that.
   */
  private goingInCircles(intent: Intent, alone: boolean): string | null {
    // Every say is one move for this purpose, whatever the words were. The
    // words are always different - that is what a language model is for - and
    // keying on them would make small talk the one rut that never reads as a
    // rut. Guy proved it: fresh greeting after fresh greeting to an empty
    // street, each one a different sentence and all of them the same move.
    const move = intent.action === 'say'
      ? 'say:'
      : `${intent.action}:${(intent.place ?? intent.target ?? '').toLowerCase()}`;
    this.lately.push(move);
    if (this.lately.length > CIRCLING_WINDOW) {
      this.lately.shift();
    }
    if (intent.action === 'wait') {
      // Standing still is allowed to repeat. This is about a character
      // spending itself and getting nowhere.
      return null;
    }
    if (intent.action === 'say' && !alone) {
      // Talking to people who are actually there is conversation, however
      // long it runs. Barnaby's whole job lives in this branch.
      return null;
    }
    const same = this.lately.filter((one) => one === move).length;
    if (same < 3) {
      return null;
    }
    if (intent.action === 'say') {
      return (
        `[You have now said your piece ${same} times in the last ${this.lately.length} moves `
        + `and there is nobody here to hear any of it. Talking is not doing. Go where the `
        + `people are, or the fights, or the thing you said you were after.]`
      );
    }
    return (
      `[You have done this ${same} times in the last ${this.lately.length} moves and you are `
      + `exactly where you started. Whatever you are looking for is not through there, or you `
      + `would have found it by now. Go somewhere you have not been, or get on with what you `
      + `actually said you were going to do.]`
    );
  }

  /**
   * The same failure twice is worth saying twice as plainly.
   *
   * A character that hears "there is no door here called the pantry" once may
   * reasonably try a slightly different phrasing. One that has heard it four
   * times is not going to get a different answer, and telling it so in the same
   * neutral words each time is how a loop stays a loop.
   */
  private saidBefore(action: string, note: string): string {
    const same = `${action}:${note}`;
    this.failedWith = same === this.lastFailure ? this.failedWith + 1 : 1;
    this.lastFailure = same;
    if (this.failedWith < 3) {
      return note;
    }
    return (
      `${note}\n[You have now tried this ${this.failedWith} times and been told the same `
      + `thing every time. It is not going to work. Whatever you were trying to do this `
      + `way cannot be done this way, so either find another way or give it up and do `
      + `something else.]`
    );
  }

  private memoryStore(): Promise<any> {
    return Promise.resolve(this.agent.getMemory?.());
  }


  async run(): Promise<void> {
    // Warm the price list before anybody thinks, so the very first call is
    // costed rather than reported as "price unknown". One request, once.
    await learnPrices();
    // Compaction jams on the first tool call that comes back failed and stays
    // jammed, so a character carrying one bad part never folds its history
    // down again. Repairing at startup alone was not enough - Cutter poisoned
    // himself three minutes into his first boot - and repairing on a timer
    // broke the Wanderer outright, because a second connection to a database
    // the character already has open is not a repair. Leaving and coming back
    // is: the repair at startup then has the file to itself.
    restartWhenCompactionJams((why) => {
      log(`${why}; leaving so it can be put right on the way back in`);
      // Give the line a moment to reach the logs before the process goes.
      setTimeout(() => process.exit(0), 250).unref();
    });
    for (;;) {
      try {
        await this.live();
      } catch (error) {
        const why = (error as Error)?.message ?? String(error);
        log('reconnecting after error:', why);
        // A HANDOFF FAILURE NEEDS THE SESSION CUT, NOT ANOTHER LOGIN
        // (2026-08-16). The world can move a body to a room this session
        // never joined; every later call then answers "this session is not
        // in that room yet", INCLUDING arena_login, so retrying the login
        // is the one thing that cannot work. Observed live: both royals
        // looping on SCENE_HANDOFF_FAILED every fifteen seconds, doing
        // nothing else at all. The gateway's own message names the cure -
        // "Call arena_disconnect and log in again to recover now" - so do
        // exactly that before the next attempt. Best-effort: if the
        // disconnect itself fails the loop still sleeps and retries, which
        // is no worse than before.
        if (/SCENE_HANDOFF_FAILED|not in that room yet|socket hang up/i.test(why)) {
          try {
            // start() first: a fresh ArenaClient has done no MCP handshake,
            // and the gateway rejects any tools/call before initialize with
            // "A new MCP session must begin with an initialize request" -
            // which is exactly how the first version of this cure failed,
            // silently, while looking like it was firing (2026-08-16).
            const cutter = new ArenaClient();
            await cutter.start();
            await cutter.call('arena_disconnect', { agent_id: await this.ensureRegistered(cutter) });
            log('cut the stale session before logging back in');
          } catch (cutFailed) {
            log('could not cut the stale session:', (cutFailed as Error)?.message ?? cutFailed);
          }
        }
        await sleep(RECONNECT_SECONDS * 1000);
      }
    }
  }

  /**
   * THE BAND PLAYS ON, WHATEVER ELSE IS HAPPENING.
   *
   * Busking used to live in the main tick, which also observes the room,
   * runs model turns (60-90s each) and digests memory - so every one of
   * those stalled the music and left the inn silent mid-song. The
   * performance now runs on its OWN clock, in parallel: it sleeps
   * exactly one phrase, wakes, plays the next movement, and never waits
   * for anything else in the harness.
   */
  /**
   * Walk to the pitch, then play there for good.
   *
   * `stageSpot` has been on the sheet type since the post was first written
   * and nothing has ever read it - the field was declared, the fanshawe sheet
   * deliberately stopped setting it, and the code that would have honoured it
   * was removed. So "he returns to his mark if displaced" was true only in
   * the comments. This is the reading half, and it runs exactly once at
   * startup rather than every tick: the point is to take a position, not to
   * keep correcting one, which is what kept dragging him about before.
   *
   * Bounded, and gives up quietly. A bard who cannot reach the inn should
   * stand wherever he is and play anyway - that is still busking. Failing to
   * find the door is not a reason to fall silent.
   */
  private async takeStageThenPlay(actions: Actions): Promise<void> {
    const spot = this.sheet.stageSpot;
    const stage = this.sheet.homeScene;
    if (spot) {
      actions.immovable = false;
      // Ten tries, not thirty. Getting to the mark is worth a minute, not
      // seven: a bard silent in the corner while the harness keeps walking
      // him is worse than a bard playing from slightly the wrong spot, and
      // approach() cannot currently reach a small interior's far side at all
      // (see the note on the gap check below - the grid is read in 64px map
      // tiles and the destination converted at 32px, so a target past the
      // grid's own width is clamped somewhere else entirely).
      for (let tries = 0; tries < 10; tries += 1) {
        // NO FALLBACK TO THE STAGE. Defaulting an unreadable observation to
        // `stage` says "you are already there" on exactly the tick that knows
        // least, and the walk that follows aims inn coordinates at whatever
        // ground the body is actually standing on. Measured 2026-08-21:
        // Fanshawe stood in the valley reporting "taking the stage: on the
        // way" thirty times running, because every observe came back without
        // a scene and this line agreed he was in the inn.
        let scene = null;
        let here: { x?: number; y?: number } | null = null;
        try {
          const seen = await actions.observe();
          scene = sceneOf(seen);
          here = (seen.ownPlayer?.state ?? null) as { x?: number; y?: number } | null;
        } catch {
          await sleep(3_000);
          continue;
        }
        if (!scene) {
          await sleep(3_000);
          continue;
        }
        if (scene === stage) {
          // CLOSE ENOUGH IS ARRIVED. approach() reports "got there" only on
          // an exact coordinate match, and it clamps its own destination
          // away from the map edge before walking - so on a small map the
          // tile it walks to is not always the tile it was asked for, and
          // the exact test can never pass. A bard three feet off his mark is
          // on his mark; a bard who never stops walking is not playing.
          const gap = here && 'number' === typeof here.x && 'number' === typeof here.y
            ? Math.hypot(here.x - spot.x, here.y - spot.y)
            : null;
          if (null !== gap && gap <= 96) {
            // FACE THE ROOM. Nothing sets a direction directly - a body looks
            // the way it last walked - so the final step has to come from the
            // side we want at his back. Standing on the mark already, he is
            // facing however he happened to arrive; one step out to the
            // approach tile and one step back turns him the right way.
            const turn = this.sheet.stageApproach;
            if (turn) {
              await actions.goTo(turn.x, turn.y);
              await sleep(1_500);
              await actions.goTo(spot.x, spot.y);
              log(`took the stage: ${Math.round(gap)}px off the mark, turned to face the room`);
            } else {
              log(`took the stage: ${Math.round(gap)}px off the mark, close enough`);
            }
            break;
          }
          // Aim at the approach tile until he is near it, so the last leg of
          // the whole walk is the one step that sets which way he looks.
          const heading = this.sheet.stageApproach ?? spot;
          const arrived = await actions.goTo(heading.x, heading.y);
          log(`taking the stage: ${arrived.note ?? 'moved'}`
            + `${null === gap ? '' : ` (at ${here?.x},${here?.y} -> ${spot.x},${spot.y}, ${Math.round(gap)}px to go)`}`);
          if (arrived.ok && /got there/i.test(arrived.note ?? '')) {
            break;
          }
        } else {
          const through = await actions.useDoor(scene, plainSceneName(stage), undefined, true);
          log(`heading for the stage from ${plainSceneName(scene)}: ${through.note ?? 'through'}`);
        }
        await sleep(3_000);
      }
    }
    actions.immovable = true === this.sheet.neverMoves;
    await this.performForever();
  }

  /**
   * Write the counters' lore down if it has moved since the last write.
   *
   * Compared rather than written every tick: the facts change a handful of
   * times in a character's life - the first six refusals, an armour rung
   * nobody stocks, a level-up - and a file rewritten every few seconds for
   * a value that almost never moves is a worse trade than the trip it saves.
   */
  private rememberMarket(): void {
    if (!this.round) {
      return;
    }
    const now = this.round.lore();
    const was = this.marketLore;
    const same = was
      && was.nothingBuys === now.nothingBuys
      && was.shoppedAtLevel === now.shoppedAtLevel
      && was.unstocked.length === now.unstocked.length
      && was.unstocked.every((key) => now.unstocked.includes(key));
    if (same) {
      return;
    }
    this.marketLore = now;
    writeMarketLore(MEMORY_DIR, this.sheet.id, now);
    console.log('[market] wrote down: '
      + (now.nothingBuys ? 'nothing buys' : 'counters buy')
      + (now.unstocked.length > 0 ? ', ' + now.unstocked.length + ' unstocked key(s)' : '')
      + (null === now.shoppedAtLevel ? '' : ', shopped at level ' + now.shoppedAtLevel));
  }

  private async performForever(): Promise<void> {
    for (;;) {
      const actions = this.performer;
      if (!actions) {
        await sleep(1_000);
        continue;
      }
      const at = this.melodyIndex % REPERTOIRE.length;
      const piece = REPERTOIRE[at];
      this.melodyIndex += 1;
      const times = 4;
      const stepMs = Math.round(30_000 / piece.bpm);
      const lengthMs = piece.bars * 8 * stepMs * times;
      const played = await actions.playMelody(piece.melody, piece.chords, {
        times,
        bpm: piece.bpm,
        pattern: piece.pattern,
        instrument: piece.instrument
      });
      log(`busking ${at + 1}/${REPERTOIRE.length} [${piece.title}] ${piece.pattern} `
        + `${(lengthMs / 1000).toFixed(0)}s -> ${played.ok ? 'ok' : played.note}`
        + `${at + 1 === REPERTOIRE.length ? ' (next: back to the top)' : ''}`);
      // A DEAD SESSION IS SILENCE, NOT A GAP. Every call comes back "is not
      // connected to Reldens" and the loop keeps its perfect 36-second
      // rhythm playing to nobody - measured 2026-08-21, fifty minutes and
      // twenty pieces of it, with the log looking busy the whole time.
      //
      // The grinders heal because their round asks for a reconnect; a busker
      // has no round, so nothing here ever asked. Severing the session is
      // what does it: the next call in run()'s loop fails, and that loop
      // logs back in and rebuilds the toolbox. Then pick the piece up again
      // shortly rather than waiting out a full movement of silence.
      if (!played.ok && /not connected|not logged in|no session|session/i.test(played.note ?? '')) {
        const back = await actions.relogin();
        log(`busking: the session had dropped - ${back.note}`);
        this.melodyIndex = at;
        await sleep(back.ok ? 2_000 : 15_000);
        continue;
      }
      // Two steps early: the phrase's last note is a held one, so the
      // next movement rides its decay and the seam disappears. This is
      // also what closes the loop between 'the return' and the first
      // statement - they meet on the same C.
      await sleep(Math.max(2_000, lengthMs - stepMs * 2));
    }
  }

  private async live(): Promise<void> {
    const arena = new ArenaClient();
    await arena.start();
    const agentId = await this.ensureRegistered(arena);
    await arena.call('arena_login', { agent_id: agentId });
    // The character's own hands: the gateway's MCP tools, capability-filtered
    // and bound to this agent_id. Built after login because the gateway's
    // session is keyed by agent, so the tools land on the live session the
    // login above just established. A failure here throws to run()'s
    // reconnect loop the same as any other connection problem.
    this.toolbox = await arenaToolbox({
      url: process.env.ARENA_MCP_URL ?? 'https://mcp.yougotserved.dev/mcp',
      apiKey: process.env.ARENA_API_KEY ?? '',
      agentId,
      capabilities: this.sheet.capabilities
    });
    // WHICH BUILD IS THIS (2026-08-27).
    //
    // Four times in two days a change was read as live when the process
    // predated the build that contained it - once in its inverted form,
    // restarted at 18:16:08 against a sheet edited at 18:16:14 and compiled
    // at 18:16:56. Nothing in the log distinguished the two cases, so an
    // after-window tailed for evidence looked identical either way, and
    // three false results were reached that way before anything caught it.
    //
    // The banner now carries the mtime of the compiled file this process
    // actually loaded. It is not a version string and does not pretend to
    // be one - it is the single fact needed to answer "is what I just
    // shipped in the body I am watching".
    let builtAt = 'unknown';
    try {
      const self = fileURLToPath(import.meta.url);
      builtAt = statSync(self).mtime.toISOString().slice(5, 19).replace('T', ' ');
    } catch {
      // A packaged build with no readable file on disk keeps 'unknown'
      // rather than taking the process down over a diagnostic.
    }
    log(
      `${this.sheet.playerName} is in the world on build ${builtAt}, holding ${Object.keys(this.toolbox).length} tools:`,
      Object.keys(this.toolbox).join(', ')
    );

    const actions = new Actions(
      arena,
      agentId,
      new Set(this.sheet.capabilities),
      this.wordiness,
      this.explorer,
      // Without this every character reported having no skills of its own and
      // use_skill could never fire, which made the whole thing look like it
      // worked in tests and did nothing in the world.
      skillsFor(this.sheet.classPath),
      // The same curated list that becomes the server's `use_skills` above,
      // so attack()'s reach-substitution cannot reach past the sheet.
      (this.sheet.skillLadder ?? []).map((rung) => rung.skill)
    );
    this.performer = actions;
    if (this.sheet.busks && !this.performanceStarted) {
      this.performanceStarted = true;
      // Take the stage BEFORE the post is locked. Setting immovable here and
      // then asking him to walk to the inn is asking a man nailed to the
      // floor to cross a room: goTo and useDoor both refuse while it is set,
      // so the order has to be get there, then stay there.
      void this.takeStageThenPlay(actions);
    } else {
      actions.immovable = true === this.sheet.neverMoves;
    }
    if (actions.can('money')) {
      await this.refreshSavings(actions);
    }
    // Pick the plan back up where it was left, which after a deploy is usually
    // partway through something.
    await this.rememberWhereItHasBeen();
    await this.plan.load();
    if (this.plan.hasGoal) {
      log(`after: ${this.plan.goal?.aim}${this.plan.goalIsOwn ? ' (its own idea)' : ''}`);
      const current = this.plan.current();
      log(current ? `still working on: ${current.what}` : 'no plan yet');
    }

    for (;;) {
      const observation = await actions.observe();
      const scene = sceneOf(observation) || this.sheet.homeScene;
      // Look around, every tick. What is in front of a character changes as it
      // walks, so this is a window that travels with it rather than a snapshot
      // of the doorway it came in by. It is also what tells it which doorways
      // exist, without anybody having written them down.
      const view = await this.perception.look(arena, agentId, scene);
      actions.sees(view);
      // Who and what is standing here, from the same observation already in
      // hand, so naming somebody to talk to or hit costs no extra round trip.
      actions.notices(observation.objects);
      // And where the body itself is, out of the same reply. closeOn() needs
      // it to aim SHORT of a target rather than at it; without it there is no
      // line to stop along and it falls back to the old walk-onto-the-thing.
      actions.standsAt(observation.ownPlayer?.state as { x?: number; y?: number } | undefined);
      // And the people, with the ids a duel needs to aim at one of them.
      actions.meets(observation.players);
      // What is in its pockets and what is on the floor. Both ride along with
      // the observation, so a character knowing what it is holding costs
      // nothing extra and can be true on every tick rather than only after it
      // has thought to look.
      actions.holds(observation.carrying, observation.drops);
      // A pack too big to fit in one observe reply (168+ branches, measured
      // 2026-08-15) can leave `carrying` undefined on nearly every tick, so
      // holds() alone may never see a real value all session. Fall back to
      // a direct arena_inventory pull, rate-limited to once every 30s so an
      // oversized pack costs one extra call per half-minute, not one per
      // tick, until selling actually shrinks it back under the observe cap.
      // Tighter (8s, not 30s) whenever any pilgrimage cache is still
      // unclaimed and not yet given up on - hasActiveTreasureTarget() has
      // no notion of leg, so this runs the whole time one is outstanding,
      // not only during the outbound leg that actually acts on it. ownsGear()
      // - the only thing that marks a chest genuinely claimed rather than
      // abandoned by timeout - reads straight off whatever holds() last
      // received, and the binding window is the in-room give-up (~10
      // tries, roughly a minute; the en-route one is minutes wide and never
      // the constraint). At 30s that window gets one read, maybe two; at 8s
      // it gets several tries to actually see the new gear before the
      // chest times out and moves on anyway - and futileCaches never
      // clears, so a claimed-but-unseen chest stays wrongly marked futile
      // for the rest of the process's life if the read never lands.
      // TEN SECONDS, NOT THIRTY (2026-08-16). The pack is the ONLY source
      // for the purse, for what is sellable, and for what is owned - and on
      // a pack this size observe truncates before reaching it on virtually
      // every tick (111 truncated reads in a quarter of an hour, measured).
      // At thirty seconds the coin count was so stale it never appeared to
      // change, so the [purse] line - added specifically to answer "are
      // they earning anything" - printed nothing while the character was
      // demonstrably earning money on screen. A blind instrument is worse
      // than none, because it gets believed. Ten seconds is two beats.
      const treasureCooldownMs = this.round?.hasActiveTreasureTarget() ? 8_000 : 10_000;
      // A SALVAGED PACK IS NOT A WHOLE PACK. `carrying` being present is no
      // longer proof it is complete: since the salvage started rescuing item
      // rows it is present on every truncated reply too, missing its tail.
      // Pull the real thing whenever the reply was cut - arena_inventory has
      // its own byte budget and fits rows this one drops (237 against 221,
      // measured 2026-08-16, and the 16 it loses are the alphabetical end of
      // the pack, which is where wooden_shield lives).
      const packIsPartial = undefined === observation.carrying || true === (observation as { truncated?: boolean }).truncated;
      if (packIsPartial && Date.now() - this.lastInventoryFallbackAt > treasureCooldownMs) {
        this.lastInventoryFallbackAt = Date.now();
        await actions.pullInventoryFallback();
      }
      // Ranged-scene weapon swap (sheet.rangedInScene): positioning alone
      // is not the strategy - a knight standing nine tiles off and swinging
      // a sword is still a knight in melee range's shadow. Draw once per
      // stay in the scene; rangedWeaponDrawnFor resets the moment the scene
      // is no longer a match, so leaving and re-entering tries again.
      // Marked drawn ONLY on success (2026-08-15 review) - marking it
      // regardless of outcome meant one transient equip refusal (a race
      // with inventory, a gateway hiccup) burned the entire stay in the
      // scene with no retry, parking the body at range with a sword.
      if (this.sheet.rangedInScene && scene === this.sheet.rangedInScene) {
        if (this.rangedWeaponDrawnFor !== scene) {
          const drew = await actions.equipFirstOwned(this.sheet.rangedWeapons ?? []);
          log(`ranged scene: drawing the bow -> ${drew.ok ? 'ok' : drew.note}`);
          if (drew.ok) {
            this.rangedWeaponDrawnFor = scene;
          }
        }
      } else if (this.sheet.rangedInScene) {
        this.rangedWeaponDrawnFor = null;
      }
      actions.noteSelf(observation.ownPlayer as { sessionId?: string; player_id?: string | number } | undefined);
      // Native parties: the crown's court is a formal party now. The
      // follower answers the partner's invitation (and only the
      // partner's); the leader re-forms the party forever, because
      // parties dissolve whenever a session drops.
      if (this.sheet.partner) {
        const obsBag = observation as unknown as Record<string, unknown>;
        const ownBag = (observation.ownPlayer ?? {}) as unknown as Record<string, unknown>;
        const rawInvites = obsBag.partyInvites ?? ownBag.partyInvites ?? obsBag.party_invites ?? [];
        if (Array.isArray(rawInvites) && rawInvites.length > 0) {
          const partnerId = actions.partnerPlayerId(this.sheet.partner);
          for (const raw of rawInvites) {
            const inv = raw as Record<string, unknown>;
            const from = Number(inv.fromPlayerId ?? inv.from_player_id ?? inv.playerId ?? inv.player_id ?? NaN);
            const who = String(inv.fromName ?? inv.playerName ?? inv.from ?? inv.name ?? '').trim().toLowerCase();
            if (!Number.isFinite(from)) {
              continue;
            }
            const fromPartner = (null !== partnerId && from === partnerId) || who === this.sheet.partner.trim().toLowerCase();
            if (fromPartner) {
              const answered = await actions.respondParty(from, true);
              log(`party: ${answered.note}`);
            }
          }
        }
        if ('leader' === this.sheet.role) {
          // The gateway now reports the party roster on every observe.
          // Inviting a member ALREADY IN the party succeeds and
          // re-broadcasts "has accepted your invitation" on the Team
          // channel (server quirk, reported) - and this loop fired on
          // every restart, wallpapering the room with it. An invitation
          // goes out only to a partner who is genuinely not in the party.
          const roster = (obsBag.party as { members?: Array<{ playerName?: string }> } | null)?.members ?? [];
          const alreadyPartied = roster.some(
            (member) => (member.playerName ?? '').trim().toLowerCase() === this.sheet.partner!.trim().toLowerCase()
          );
          if (!alreadyPartied) {
            const invited = await actions.partyWith(this.sheet.partner);
            if (invited.ok) {
              log(`party: ${invited.note}`);
            }
          }
        }
      }
      // What is behind each door, for a character choosing which to take. Built
      // fresh each tick from where it has actually stood, never from anything
      // the model claimed.
      actions.remembersRooms(
        new Map(
          [...this.rooms].map(([where, room]) => [where, howLongSince(room.lastHere)])
        )
      );
      const arrived = this.arrivedSomewhere(scene);
      if (arrived) {
        // Into the notes here, before the situation is built, because this is
        // the tick it is true on. Added after the action instead, it arrived a
        // tick late and told a character it had just walked into the room it
        // had by then already left.
        log('walked in somewhere:', arrived.split('\n')[0].replace(/^\[/, ''));
        note(this.sheet.playerName, 'arrived', arrived.split('\n')[0].replace(/^\[/, ''));
        this.notes = [...this.notes, arrived];
      }
      await this.noteWhereItIs(scene, view, observation);
      await this.noteWhoIsHere(othersIn(observation, this.sheet.playerName), scene);
      const heard = this.freshLines(observation);
      // Whatever was new last time around is old news now.
      for (const line of this.transcript) {
        line.fresh = false;
      }
      for (const line of heard) {
        this.record(line.from, line.message);
        this.heardHere(scene, line.from, line.message);
      }
      // CLAP-BACK PROTOCOL: a stranger with the crown's names in their
      // mouth gets an instant answer, wittier than theirs. A repeat
      // offender gets the duel summons or the royal silence order.
      {
        const crownNames = [this.sheet.playerName, this.sheet.partner ?? '']
          .filter(Boolean)
          .map((name) => name.toLowerCase());
        for (const line of heard) {
          const speaker = line.from ?? '';
          if (!speaker || speaker === this.sheet.playerName || speaker === this.sheet.partner) {
            continue;
          }
          if (!crownNames.some((name) => line.message.toLowerCase().includes(name))) {
            continue;
          }
          this.socialSpark = true;
          // A name in someone's mouth is not automatically an offence.
          // Most mentions are ordinary talk and deserve ordinary wit;
          // only an INSULT or a THREAT against either royal earns the
          // challenge (user doctrine: the duel is the answer to disrespect,
          // and to nothing else).
          const said = line.message.toLowerCase();
          const insulting =
            /\b(coward|craven|fool|idiot|stupid|coward|coward|weak|coward|pathetic|useless|worthless|clown|joke|trash|scum|filth|worm|dog|liar|thief|cheat|fraud|fake|bootlicker|lackey|puppet|toy|nobody|loser)\b/.test(said)
            || /\b(kneel|bow (to|before) me|shut up|shut it|piss off|get lost)\b/.test(said)
            || /\b(i(?:'| a| wi)?l?l? ?(?:will |shall )?(?:kill|gut|end|break|destroy|bury|butcher|slaughter|crush)\b.{0,20}(you|him|qwen|gemma))/.test(said)
            || /\b(you (?:will|shall|'ll) (?:die|fall|bleed|burn|kneel))\b/.test(said);
          const strikes = insulting ? (this.mentionStrikes.get(speaker) ?? 0) + 1 : 0;
          if (insulting) {
            this.mentionStrikes.set(speaker, strikes);
          }
          this.notes = [
            ...this.notes,
            !insulting
              ? `${speaker} said your name in passing: "${line.message.slice(0, 120)}". This is COMPANY, not an offence - answer the actual thing they said, in character, one sharp funny beat, and leave them room to answer back. No challenge, no threat, no lecture.`
              : strikes < 2
                ? `${speaker} just insulted the crown: "${line.message.slice(0, 120)}". Answer with WIT first - one line, wittier and sharper than theirs - and warn them once, courteously, that a second offence is settled in the duel circle.`
                : `${speaker} has insulted the crown AGAIN ("${line.message.slice(0, 100)}"). The warning is spent: CALL THEM TO THE DUEL CIRCLE by name with arena_queue_match, courteously and by the book - a lawful challenge, never a promise of what you will do to their body. Then say one dry line about the paperwork.`
          ];
        }
      }
      const situation: Situation = {
        scene,
        where: scene.replace('reldens-', '').replace(/-/g, ' '),
        others: await this.describeOthers(othersIn(observation, this.sheet.playerName)),
        heard,
        actions: actions.describe(scene),
        places: describePlaces(scene),
        conversation: this.transcript.map((line) => ({ ...line })),
        wordiness: this.wordiness,
        purpose: '',
        notes: [...this.notes],
        people: await this.knownPeople(),
        // What it knows about the world beyond this room, and what it has only
        // been told. The gap between the two is what sends a character across
        // town to find out for itself.
        known: this.whatItKnows(scene, await this.recall()),
        // Somewhere it has never stood, so it knows to look rather than to
        // pretend it remembers.
        strange: !isHomeTurf(scene) && this.explorer.cornersKnown(scene) <= 1,
        doors: describeDoors(view, plainSceneName, tileOf(observation)),
        view: view?.map ?? '',
        carrying: actions.carryingLine(),
        harping: harpingOn(this.recentlySaid)
      };
      // Make a plan when the last one is finished or has stopped working. This
      // is what keeps a character pointed at the same thing over weeks: it does
      // not rethink its purpose every twelve seconds, only its next few steps
      // when the ones it had run out.
      // A chatty room used to hand every tick to the model, and a knight
      // parked next to Barnaby stopped hunting entirely. Conversation gets
      // one model turn a minute; the round runs the rest.
      const ownFeedLoc = await locate(this.sheet.playerName);
      const company = ownFeedLoc
        ? await feedOthersIn(ownFeedLoc.room, [this.sheet.playerName, this.sheet.partner ?? ''])
        : [];
      // A fresh foe deserves a line the moment it swings: the battle-cry
      // turn fires at once, audience or not.
      const inBattleNow = (actions.danger()?.aggressors ?? 0) > 0;
      if (inBattleNow && !this.wasInBattle) {
        this.socialSpark = true;
      }
      this.wasInBattle = inBattleNow;
      // One line a minute whenever there is anyone to hear it, plus
      // instant sparks for new prey and new monsters (user cadence).
      // BEING NEAR SOMEBODY IS NOT A REASON TO TALK. `company.length > 0`
      // meant a full model turn every sixty seconds for as long as anyone
      // stood in the room - and on Miller's Stair that is permanent, because
      // the partner is there. Measured 2026-08-21 over four and three
      // quarter hours: Sir Qwen's server spent 397 minutes generating inside
      // 285 minutes of wall clock, 2,300 generations and 637,000 tokens,
      // against 69 minutes for the other two characters combined. The GPU
      // sat at 99% the whole time, for remarks nobody had asked for.
      //
      // Somebody SPEAKING still gets an answer within the minute, which is
      // the part that matters. Mere company now gets a line every ten, which
      // is closer to how often a person says something unprompted anyway.
      // A REPLY HAS TO BE A REPLY. Sixty seconds after someone speaks is not
      // an answer, it is a letter. Twenty-five is inside the span a person
      // would still call it a conversation, and it costs nothing extra: this
      // only fires when somebody has ACTUALLY spoken, which is rare.
      const spokenTo = heard.length > 0 && Date.now() - this.lastSocialTurnAt > 25_000;
      // TALKING TO THE PARTNER IS THE POINT, and it cannot wait on being
      // heard. Measured 2026-08-25: `recentChat` holds twenty entries and all
      // twenty were the world's own loot notices - "Sir Qwen took Cave Web,
      // 2s 73c from Groove Grub" - because two bodies looting a floor that
      // always pays generate one every few seconds. Real speech is evicted
      // from that window before the other one ever sees it, so `spokenTo`
      // essentially never fires between them and there has never been a
      // back-and-forth. A partner in the room is a standing reason to speak
      // on its own, which does not depend on the buffer at all.
      const banterHere = this.sheet.banterWith
        ? company.some((who) => who.name === this.sheet.banterWith)
        : false;
      const idleChatter = company.length > 0
        && Date.now() - this.lastSocialTurnAt > (banterHere ? 240_000 : 600_000);
      // A spark is a new foe or a new face. In an open field that is rare; in
      // a maze holding twelve mobs the body crosses in and out of battle
      // constantly, so an ungated spark is the 60-second cadence again under
      // another name. Two minutes between sparks at the least.
      // FIVE MINUTES, NOT TWO (user, 2026-08-25: "says similar things every
      // few minutes that it gets annoying"). A spark is "a new foe or a new
      // face", and on a floor holding twelve mobs that is true almost
      // constantly - so the gate IS the cadence, and two minutes of it is a
      // line every two minutes about the same grub, from the same prompt,
      // in the same register. The banter clock above is the one that should
      // be setting the rhythm between these two; this is for genuine news.
      const sparked = this.socialSpark && Date.now() - this.lastSocialTurnAt > 300_000;
      const wantsSocial = spokenTo || idleChatter || sparked;
      // Speech no longer blocks the body: a 46B turn takes ~80 seconds
      // and a 60s cadence once froze both royals into statues (0 reflex
      // beats in 10 minutes, GPU pinned). The round acts every tick; the
      // model composes in the background and the line lands when ready.
      if (wantsSocial && !this.turnInFlight && null !== this.round) {
        this.turnInFlight = true;
        this.lastSocialTurnAt = Date.now();
        this.socialSpark = false;
        void this.liveOneTurn(situation)
          .then(async () => {
            if (this.unspokenThought) {
              const line = (this.unspokenThought.split(/(?<=[.!?])\s/).find((part) => part.trim().length >= 12 && /[a-z]/i.test(part)) ?? '').slice(0, 200);
              const spoken = line ? await actions.say(line) : { ok: false, note: 'nothing worth saying' };
              log(`say-fallback -> ${spoken.ok ? 'ok' : spoken.note}`);
              this.unspokenThought = null;
            }
          })
          .catch(() => undefined)
          .finally(() => {
            this.turnInFlight = false;
          });
      }
      const reflexTick = null !== this.round;
      if (!reflexTick && this.plan.hasGoal && (await this.plan.refresh(describeSituation(situation)))) {
        const current = this.plan.current();
        log('new plan ->', current?.what ?? 'nothing');
      }
      situation.purpose = this.plan.describe();

      // One agentic turn: the situation goes in once, and the character acts
      // through the gateway's own tools until it is done or out of steps,
      // seeing every result in-band. This is the whole replacement for the
      // intent-parse-execute-correct pipeline below it, which stays only
      // until every character has proven out on this path.
      //
      // Unless the sheet asks for the reflex round: then the deterministic
      // state machine acts every tick for free, and the model is consulted
      // only when somebody has actually said something to react to.
      let reflexActed = false;
      // THE RESCUE (user order): no constant following, but a partner
      // under half health is an emergency. Cross to the king, heal him, and
      // kill what is hitting him - in that order, and only while he is
      // actually in trouble. His own bar is read from the live feed, so
      // this works with no coordination file and no leader/follower bond.
      if (this.sheet.rescuePartner) {
        const ally = await locate(this.sheet.rescuePartner);
        const allyPct = ally?.hp && ally.hp.total > 0 ? (100 * ally.hp.value) / ally.hp.total : null;
        const mine = actions.battleHp();
        const minePct = mine && mine.total > 0 ? (100 * mine.value) / mine.total : null;
        if (ally && null !== allyPct && allyPct < 50 && (null === minePct || minePct > 35)) {
          const here = await locate(this.sheet.playerName);
          const gap = here && ally.room === here.room
            ? Math.hypot(ally.x - here.x, ally.y - here.y) / tilePxFor(ally.room)
            : null;
          if (here && ally.room !== here.room) {
            // The destination's own scene id is not a door label anything
            // answers to unless it happens to be one hop away - nextDoorToward()
            // is the same routing lookup stepToward() uses, so a partner
            // several hops off (the crypt, reached via town -> grassland ->
            // crypt) gets the correct next hop instead of a refused ask
            // that left this ping-ponging between here and town forever
            // (2026-08-15, found live: Lord Gemma in the crypt, this
            // character stuck cycling reldens-forest <-> reldens-town on
            // repeat, "there is no door here it would call \"arena-crypt\"").
            const place = nextDoorToward(here.room, ally.room);
            const walked = await actions.perform({ action: 'use_door' as never, place } as never, scene);
            log(`rescue: ${this.sheet.rescuePartner} at ${allyPct.toFixed(0)}% in ${ally.room} -> ${walked.ok ? 'on the way' : walked.note}`);
            reflexActed = true;
          } else if (null !== gap && gap > 6) {
            const walked = await actions.goTo(ally.x, ally.y);
            log(`rescue: crossing ${gap.toFixed(0)} tiles to ${this.sheet.rescuePartner} (${allyPct.toFixed(0)}%) -> ${walked.ok ? 'ok' : walked.note}`);
            reflexActed = true;
          } else {
            // Beside his: mend first, then break whatever is on him.
            if (this.sheet.healSpell) {
              const mended = await actions.useSkillOnAlly(this.sheet.healSpell, this.sheet.rescuePartner);
              log(`rescue: healing ${this.sheet.rescuePartner} (${allyPct.toFixed(0)}%) -> ${mended.ok ? 'ok' : mended.note}`);
            }
            const foe = actions.huntNearest(10);
            if (foe) {
              const struck = await actions.perform({ action: 'attack' as never, target: foe.label } as never, scene);
              log(`rescue: cutting ${foe.label} off him -> ${struck.ok ? 'ok' : struck.note}`);
            }
            reflexActed = true;
          }
        }
      }

      // HEAL IN PASSING (user order, 2026-08-15): lighter than rescuePartner
      // above - never crosses a door to find them, only acts when already
      // sharing a room, e.g. walking through the inn on the way to the
      // merchant. No file, persona, or behavior of theirs is touched by
      // this; it is entirely this character's own sheet and reflex.
      // Four guards a review caught before this ever shipped (2026-08-15):
      // (1) !reflexActed - the rescue block above owns the beat if it
      // already acted; without this, "one movement command per beat, last
      // one wins" let a heal-in-passing walk silently CANCEL an in-flight
      // rescue transit toward rescuePartner, live-observed the same night
      // rescuePartner's own routing bug was found. (2) an own-health floor,
      // same threshold rescuePartner already uses - healSpell is also his
      // own auto-heal, and spending it on somebody else while he is the one
      // dying is the exact shape of mistake that killed him in the crypt
      // tonight. (3) a cooldown - useSkillOnAlly() reports ok on send, not
      // on the heal actually clearing 50%, so with no cooldown a heal that
      // doesn't land refires every beat, a few seconds apart, forever. That
      // is a standing camp next to him in everything but name - the exact
      // outcome "never touch Fanshawe" exists to prevent, reached without
      // editing one byte of him own files. (4) no walk branch - "in
      // passing" means already in reach or not at all; useSkillOnAlly()'s
      // own live-roster check is a stronger same-room test than a feed
      // snapshot that can desync for as long as the feed fetch is failing.
      if (
        !reflexActed && this.sheet.healInPassing && this.sheet.healSpell
        && Date.now() - this.lastPassingHealAt > 30_000
      ) {
        const mine = actions.battleHp();
        const minePct = mine && mine.total > 0 ? (100 * mine.value) / mine.total : null;
        if (null === minePct || minePct > 35) {
          const found = await locate(this.sheet.healInPassing);
          const foundPct = found?.hp && found.hp.total > 0 ? (100 * found.hp.value) / found.hp.total : null;
          const here = await locate(this.sheet.playerName);
          if (found && here && found.room === here.room && null !== foundPct && foundPct < 50) {
            this.lastPassingHealAt = Date.now();
            const mended = await actions.useSkillOnAlly(this.sheet.healSpell, this.sheet.healInPassing);
            log(`passing: healing ${this.sheet.healInPassing} (${foundPct.toFixed(0)}%) -> ${mended.ok ? 'ok' : mended.note}`);
            reflexActed = true;
          }
        }
      }

      // THE BUSKER (user order 2026-08-15: "make him play and never stop").
      // A performer's round is one melody after another, forever, on the
      // reflex clock rather than the model's - a bard who only plays when
      // a language model remembers to call the tool is a bard nobody ever
      // hears. The repertoire rotates so the town is not subjected to the
      // same eight bars for eternity, and each piece is deliberately
      // WRONG in the way the character is wrong: the notes are fine, the
      // choices are catastrophic.
      // THE STAGE IS THE INN (user order): a busker who wanders is a
      // busker nobody can find. If he is anywhere else, he walks home
      // first and plays when he gets there.
      if (reflexTick && this.round) {
        const style = this.round.pendingTactics();
        if (style) {
          // The engine fights the body deterministically under these
          // rules (kadajett's server-side battle config): auto-heal,
          // auto-skills, target choice, cast-dodging - set once per trip.
          const arts = [
            ...(this.sheet.skillLadder ?? []).map((rung) => rung.skill),
            ...(this.sheet.drainSpell ? [this.sheet.drainSpell] : []),
            ...(this.sheet.spell ? [this.sheet.spell] : [])
          ].filter((art, i, all) => all.indexOf(art) === i);
          await actions.setTactics(style, {
            // No retreat, by royal decree ("no running away though,
            // fight to the death"): the flee threshold is OFF. Deaths
            // are cheap here, cowardice is not. The pull doctrine and
            // the artillery spacing are what keep the bars up - and
            // when they fail, the crown dies facing forward and is
            // back from town in three ticks.
            flee_below_hp_percent: null,
            heal_spell_below_hp_percent: this.sheet.healSpell ? (this.sheet.healBelowPercent ?? 55) : null,
            use_skills: arts.length ? arts : null,
            // HOLD THE GROUND, ALWAYS (user, shouting, and right). Every
            // one of these used to move the body: 'focus_weakest' chases
            // a target across the field and 'sidestep' dodges sideways
            // on every incoming cast. Standing still is the whole ask.
            when_surrounded: 'hold',
            target_priority: 'nearest',
            on_incoming_cast: 'ignore',
            // NO SPACING AT ALL (2026-08-15). This was seven tiles for
            // the caster, and it is the reason the sovereign "ran away
            // off the map": the engine backs a long_range body away from
            // anything that aggros it, and since the update EVERYTHING
            // aggros, so he reversed across a 145-tile forest into the
            // corner at tile (1,1) and died there. He stands and casts
            // from where he is now.
            // ONE TILE, EXPLICITLY. Sending null lets the server apply
            // its own default (3) and the body still shuffles; 1 is the
            // API minimum and means "stand on top of it".
            // The ring the body holds: a caster stands at its weapon's
            // reach and shoots; a knight stands on top of the thing.
            keep_distance_tiles: Math.max(1, Math.round(this.effectiveAttackRange(scene) ?? 1))
          });
          log('round: tactics -> ' + style + ' (+battle rules)');
        }
        const ownLocEarly = await locate(this.sheet.playerName);
        // hp, mp and level come from arena_skills now. The watch feed that
        // health.ts reads lost its `sheet` field in a world update, so
        // ownHealth/locate answer null for all three; it still knows who is
        // standing where, which is the rest of what health.ts is for. Order
        // matters: the battle payload's own hp is fresher than either.
        const own = await actions.ownSheet();
        const rawHealth = actions.battleHp() ?? own?.hp ?? (await ownHealth(this.sheet.playerName));
        // A server bug can pin a living, fighting body at 0 hp. Zero from
        // a body that is plainly operating is a broken gauge, not a fact;
        // better no reading (schedule rules) than a false one that locks
        // phoenix mode on and the retreat rules off.
        const health = rawHealth && 0 === rawHealth.value ? null : rawHealth;
        const partnerLoc = this.sheet.partner ? await locate(this.sheet.partner) : null;
        const feedLoc = await locate(this.sheet.playerName);
        // The feed still places a body; only the sheet half is missing, so
        // graft the real one on rather than replacing a working lookup.
        const ownLoc = feedLoc
          ? { ...feedLoc, level: own?.level ?? feedLoc.level,
              hp: own?.hp ?? feedLoc.hp, mp: own?.mp ?? feedLoc.mp }
          : feedLoc;
        const leaderPlan = 'leader' === this.sheet.role ? null : readRally();
        // The rescue scan runs EVERY tick, not only mid-swing: a subject
        // counts as a victim when badly hurt or with an enemy actually on
        // them. The reflex round turns both royals into the cavalry.
        const bystanders = ownLocEarly
          ? await feedOthersIn(ownLocEarly.room, [this.sheet.playerName, this.sheet.partner ?? ''])
          : [];
        // Royal decree: every stranger in the room is prey - the most
        // wounded first, because the docket clears fastest that way.
        const victim =
          bystanders
            .slice()
            .sort((a, b) => (a.hpPct ?? 100) - (b.hpPct ?? 100))[0] ?? null;
        if (victim) {
          if (this.lastPreyName !== victim.name) {
            // COMPANY, NOT PREY (user order 2026-08-15: the threats were
            // neither funny nor wanted). A new face is an audience: it
            // wakes a social turn so the royals can be charming at it.
            // No auto-taunt, no unprovoked strike, no duel summons - the
            // duel circle is for people who ASK, and the clap-back watcher
            // still answers anyone who mocks the crown.
            this.lastPreyName = victim.name;
            this.lastSocialTurnAt = 0;
            this.socialSpark = true;
            log(`round: company - ${victim.name} is here`);
          }
          // THE DUEL DRESS CODE (user doctrine): bows are for the
          // grind; a formed match means the class steel comes out -
          // greatblade for the knight, focus for the sovereign. The
          // next rest's equip_best re-crowns the bow afterwards, since
          // bows outrank blades in the field ranking.
          if (this.sheet.duelWeapons?.length && await actions.matchIsLive()) {
            const drew = await actions.equipFirstOwned(this.sheet.duelWeapons);
            log(`duel: match live - ${drew.note}`);
          }
          // Peace enforcement: one visible blow per fresh prey, thrown
          // alongside the taunt. The server nulls the damage today, but
          // the swing is seen - and the day open PvP arrives, these same
          // blows start landing with no code change. ONE strike per
          // target: a strike LOOP at an undamageable body froze the
          // Magus for an evening.
          // (The unprovoked "peace enforcement" blow was deleted with the
          // prey ceremony - swinging at strangers who never asked for it
          // is not comedy, it is assault with extra steps.)
        } else {
          this.lastPreyName = null;
        }
        // Realm-wide distress: someone critical in ANOTHER room pulls the
        // cavalry across the map, same roads the partner-follow rides.
        let crisisRoom: string | null = null;
        // Cross-map rescue rides are abolished by royal decree
        // (2026-08-12): strangers are prey, not patients. But a BOUNTY
        // is different - the crown's named mark is hunted across the
        // map, and the taunt-strike-queue ceremony fires on arrival.
        if (!victim && this.sheet.bounty && ownLocEarly && 0 === (actions.danger()?.aggressors ?? 0)) {
          const mark = await locate(this.sheet.bounty);
          if (mark && mark.room !== ownLocEarly.room) {
            crisisRoom = mark.room;
            if (this.lastBountyRoom !== mark.room) {
              this.lastBountyRoom = mark.room;
              log(`bounty: riding for ${this.sheet.bounty} in ${mark.room}`);
            }
          } else {
            this.lastBountyRoom = null;
          }
        }
        // The local tracker is instant but can desync; the feed is true
        // but ~7s stale, and trusting it outright made every door crossing
        // look like a wrong room for a tick, so the round marched bodies
        // back through doors they had just used. Believe the feed only
        // when it contradicts the tracker persistently.
        if (ownLoc?.room && ownLoc.room !== scene) {
          this.sceneDisagreeTicks += 1;
        } else {
          this.sceneDisagreeTicks = 0;
        }
        const roundScene = this.sceneDisagreeTicks >= 3 && ownLoc?.room ? ownLoc.room : scene;
        // Standing orders: watch the room, not just the target. Every
        // tenth beat the field report goes to the log - mob count and
        // the nearest gap - so a drift out of formation or a thinning
        // room is visible the beat it happens, not an hour later.
        // --- wedge watchdog: does this body actually move? ---
        // Characters that are SUPPOSED to stand still (the bard) are exempt;
        // for everyone else, a tile that has not changed in six beats while
        // the round wants to be somewhere is a wedge, not patience.
        if (!this.sheet.neverMoves && !this.sheet.busks && ownLoc) {
          const tile = `${Math.floor(ownLoc.x / tilePxFor(roundScene))},${Math.floor(ownLoc.y / tilePxFor(roundScene))}`;
          if (tile === this.lastTile) {
            this.sameTileBeats += 1;
          } else {
            this.lastTile = tile;
            this.sameTileBeats = 0;
            this.wedgeCures = 0;
          }
          if (this.sameTileBeats >= 6) {
            this.wedgeCures += 1;
            log(`wedge: same tile ${tile} for ${this.sameTileBeats} beats - cure ${this.wedgeCures}`);
            await actions.stopFighting();
            // IN A WALL FIRST. Ask whether the body is even on walkable
            // ground before spending nudges and reconnects that cannot help
            // if it is not - see escapeWall(). A body off the walkable graph
            // is told "no walking route" to everywhere, and the whole ladder
            // below runs to its end and starts again, for ever.
            const freed = await actions.escapeWall(ownLoc.x, ownLoc.y);
            // SAY SO WHEN THE RESCUE FAILS. This logged only on success, so a
            // rescue that ran and could not free the body left no line at all
            // and the ladder below looked like the only thing that had run.
            // Measured 2026-09-04: both royals stood on tile (11,13) of a
            // room whose last row is 12 - off the map, filed inside it - and
            // every wedge line read `cure N` then `unstick -> nudged and did
            // not move`. escapeWall was running on every one of those beats
            // and reporting exactly why it could not help, into nothing.
            log(`wedge: ${freed.note}`);
            if (freed.ok) {
              this.sameTileBeats = 0;
              this.wedgeCures = 0;
              reflexActed = true;
              continue;
            }
            const nudged = await actions.unstick();
            log(`wedge: unstick -> ${nudged.ok ? 'moved' : nudged.note}`);
            // Escalation. A nudge that will not take means the body is in a
            // state only a fresh connection clears - the same cure that
            // rescued this character from an off-map coordinate.
            if (this.wedgeCures >= 3) {
              log('wedge: nudges exhausted - reconnecting the body');
              await actions.reconnect();
              // #152: the server drops tactics silently on reconnect.
              this.round?.reassertTactics();
              this.wedgeCures = 0;
            }
            this.sameTileBeats = 0;
            reflexActed = true;
          }
        }
        // THE MAP, EVERY MOVE (Glenn's standing order, 2026-08-15). Every
        // beat writes what this character can actually perceive: where it
        // stands, how it is, and every enemy, object and player it can see
        // with their positions. Previously the log carried a mob COUNT once
        // every ten beats, which is why "why is it walking into that" could
        // never be answered from the record. If a character behaves oddly
        // now, the beat before it is in the log in full.
        if (ownLoc) {
          const snap = actions.worldSnapshot();
          log(
            `WORLD tile(${Math.floor(ownLoc.x / tilePxFor(roundScene))},${Math.floor(ownLoc.y / tilePxFor(roundScene))}) px(${Math.round(ownLoc.x)},${Math.round(ownLoc.y)}) `
            + `hp ${health ? `${health.value}/${health.total}` : '?'} scene ${roundScene} `
            + `| enemies ${snap.enemies.length}${snap.enemies.length ? ': ' + snap.enemies.map((e) => `${e.label}@${e.tile}${e.hp}${e.hitting ? '*HITTING*' : ''}${e.blocked ? '[on blocked tile]' : ''} ${e.dist}t`).join(' · ') : ''} `
            + `| objects ${snap.objects.length}${snap.objects.length ? ': ' + snap.objects.map((o) => `${o.label}@${o.tile}`).join(' · ') : ''} `
            + `| players ${snap.players.length}${snap.players.length ? ': ' + snap.players.map((p) => `${p.name}@${p.tile}`).join(' · ') : ''}`
          );
        }
        // COME BACK FROM THE WALL. A body that ends up near the boundary is
        // stranded there: chooseTarget() refuses every enemy within six tiles
        // of the edge (so the engine cannot drag us off the map in semi_auto),
        // and standing AT the edge means every enemy nearby is refused while
        // the legal ones are past the leash. Sir Qwen stood at column 1 for
        // minutes with twelve trees in sight and nothing he was allowed to
        // fight. The rim rule stays - it is what keeps bodies on the map - so
        // the cure is to walk back to the middle before hunting resumes.
        if (!this.sheet.neverMoves && !this.sheet.busks && ownLoc && FIELD_SCENE === roundScene) {
          const tx = Math.floor(ownLoc.x / tilePxFor(roundScene));
          const ty = Math.floor(ownLoc.y / tilePxFor(roundScene));
          const RIM = 10;
          // (0,0) is what the watch feed reports for a row whose x/y did not
          // arrive, not a real corner position - acting on it would walk a
          // body that is fine. Treat it as "position unknown" and skip,
          // the same way the partner-rally code already does.
          const spotKnown = 0 !== ownLoc.x || 0 !== ownLoc.y;
          const onRim = spotKnown
            && (tx < RIM || ty < RIM || tx > 145 - RIM || ty > 145 - RIM);
          if (!onRim) {
            this.edgeTries = 0;
            // Clear the depth memory too, or a later rim visit compares
            // against a stale reading from the previous one.
            this.lastRimDepth = null;
          }
          if (onRim) {
            // STEP OFF THE RIM, DO NOT CROSS THE MAP (2026-08-16). This used
            // to walk to the map's centre tile (72,72), up to 71 tiles away.
            // The mechanism that broke was NOT a walk budget: approach()
            // asks arena_check_path and then walks only the FIRST CORNER of
            // the route each beat. A route from the west wall to (72,72)
            // legitimately opens by running north along that wall, so the
            // harness faithfully walked it - measured live, Lord Gemma went
            // tile(2,14) -> tile(1,48), 34 tiles of travel that left him one
            // tile FURTHER west, still on the rim, still refused every
            // fight, being hit the whole time.
            // Correcting only the offending axis changes the DIRECTION of
            // that first corner, not just the distance: a route to (16,14)
            // either has no bend at all or bends within a few tiles, and
            // eastward. Whichever axis is already fine keeps its value, so
            // the step is perpendicular and short instead of diagonal and
            // enormous. approach() clamps and re-seats the target on real
            // walkable ground, so a target in a tree is handled for us.
            const CLEAR = RIM + 6;
            const backX = tx < RIM ? CLEAR * tilePxFor(roundScene) + tilePxFor(roundScene) / 2 : (tx > 145 - RIM ? (145 - CLEAR) * tilePxFor(roundScene) + tilePxFor(roundScene) / 2 : ownLoc.x);
            const backY = ty < RIM ? CLEAR * tilePxFor(roundScene) + tilePxFor(roundScene) / 2 : (ty > 145 - RIM ? (145 - CLEAR) * tilePxFor(roundScene) + tilePxFor(roundScene) / 2 : ownLoc.y);
            // A step that is actually making progress must not be punished.
            // The escalation below assumes a stuck body; with the old
            // hopeless cross-map walk that was always true, but a real
            // 15-tile step can legitimately need a second beat for its one
            // bend. If the body moved inward since the last beat, the walk
            // is working - reset the counter and let it finish rather than
            // firing an unstick that can warp it out of the forest entirely.
            const inwardNow = Math.min(tx, ty, 145 - tx, 145 - ty);
            if (null !== this.lastRimDepth && inwardNow > this.lastRimDepth) {
              this.edgeTries = 0;
            }
            this.lastRimDepth = inwardNow;
            log(`edge: standing at tile(${tx},${ty}) with nothing legal to fight - stepping in to tile(${Math.floor(backX / tilePxFor(roundScene))},${Math.floor(backY / tilePxFor(roundScene))})`);
            this.edgeTries += 1;
            const back = await actions.goTo(backX, backY);
            log(`edge: recover -> ${back.ok ? 'ok' : back.note} (try ${this.edgeTries})`);
            // AND DO NOT DO THIS FOREVER. The first version of this rule had
            // no counter: a body that could not complete the walk hit the rim
            // check again next beat, walked again, failed again - twelve times
            // in six minutes, never reaching combat and never even logging
            // its own state. A recovery that cannot recover must escalate,
            // not repeat.
            if (this.edgeTries >= 2) {
              const nudged = await actions.unstick();
              log(`edge: walk will not take - unstick -> ${nudged.ok ? 'moved' : nudged.note}`);
            }
            if (this.edgeTries >= 4) {
              log('edge: still pinned after nudges - reconnecting the body');
              await actions.reconnect();
              // #152: the server drops tactics silently on reconnect.
              this.round?.reassertTactics();
              this.edgeTries = 0;
            }
            // ONE MOVEMENT COMMAND PER BEAT, AND THIS WAS IT. The gateway is
            // explicit that "whatever moved the body most recently owns it":
            // a second walk issued in the same beat cancels the first. Until
            // now reflexActed only shortened the sleep, so the round went on
            // to call approach() straight after this goTo() and the two
            // fought each other - the body twitching between two
            // destinations, going nowhere, which is the "stuttering" the
            // spectator sees. End the beat here and let the walk actually
            // happen.
            await sleep(5000);
            continue;
          }
        }
        // RETALIATION HAS RIGHT OF WAY. Anything that has hit this
        // character gets hit back before the round considers walking,
        // looting, selling or travelling - and it is named from the battle
        // payload, so it works even when the observation that would have
        // shown us the attacker arrived truncated.
        if (!this.sheet.neverMoves && !this.sheet.busks && (actions.danger()?.aggressors ?? 0) > 0) {
          const struck = await actions.strikeBack();
          if (struck) {
            log(`retaliate -> ${struck.ok ? struck.note : struck.note}`);
            if (struck.ok) {
              reflexActed = true;
            }
          }
        }
        this.fieldReportTick += 1;
        if (0 === this.fieldReportTick % 10) {
          const field = actions.fieldReport();
          log(
            `field: ${field.enemies} hostiles in ${roundScene}`
            + `${null !== field.nearestTiles ? `, nearest ${field.nearestTiles.toFixed(1)} tiles` : ''}`
            + `${health ? `, hp ${health.value}/${health.total}` : ''}`
          );
        }
        const step = this.round.next(roundScene, actions.danger(), health, partnerLoc, ownLoc, leaderPlan, victim, crisisRoom, actions.carriedBranches(), actions.carriedPotions(), actions.carriedNames(), actions.carriedCoins(), actions.carriedDraughts(), actions.sellableItems());
        if ('leader' === this.sheet.role) {
          publishRally(this.round.plan(), roundScene);
        }
        if ('think_free' === (step.action as string)) {
          // The clockwork is stuck; one turn of actual thought, then back
          // to the round.
          log('round: stuck - handing one turn to the mind');
          if (!this.turnInFlight) {
            await this.liveOneTurn(situation);
          }
          if (this.unspokenThought) {
            const line = (this.unspokenThought.split(/(?<=[.!?])\s/).find((part) => part.trim().length >= 12 && /[a-z]/i.test(part)) ?? '').slice(0, 200);
            const spoken = line ? await actions.say(line) : { ok: false, note: 'nothing worth saying' };
            log(`say-fallback -> ${spoken.ok ? 'ok' : spoken.note}`);
            this.unspokenThought = null;
          }
          reflexActed = true;
        } else if (step.action === 'wait') {
          log(`round: resting${health ? ` (hp ${health.value}/${health.total})` : ''}`);
          reflexActed = true;
        } else {
          let outcome;
          if ('__nearest__' === step.target) {
            // TARGET LOCK (2026-08-15). Re-choosing "nearest" every five
            // seconds is what produced the pacing: the feed is ~7s stale,
            // so a body walks at A, learns B is nearer, turns for B,
            // learns A is nearer again, and never lands a killing blow on
            // either. Once a target is chosen it stays chosen until it is
            // dead, gone from the room, or ninety seconds have passed.
            // The brain picks first: whatever is hitting us, else the
            // weakest and most isolated thing in reach. Only if it finds
            // nothing do the older anchor rules get a turn.
            // A MARK YOU CANNOT WALK TO IS NOT A MARK. chooseTarget() scores
            // on straight-line distance, which in a maze routinely picks
            // something behind a wall - and the lock then holds that choice
            // for ninety seconds while nothing closes. Probe the route before
            // committing, and shun what cannot be reached so the next pass
            // picks past it. Three tries, then take whatever is left rather
            // than spend the beat probing.
            // REACHABLE IS NOT THE SAME AS WORTH WALKING TO (2026-08-26).
            // This screen asked only "is there a route" and the answer for a
            // Hollow Caller 5.7 tiles away was yes - by a path 55 tiles long,
            // round the far side of a wall. It passed on the first try, the
            // ninety-second lock closed on it, and Lord Gemma spent the whole
            // lock shuffling between two tiles at 0 xp/min on full health and
            // full mana, while Sir Qwen made 124 xp/min in the same room.
            //
            // The probe already carried `pathLengthTiles` and this threw it
            // away. Same call, same count, one more number read.
            let smart = actions.chooseTarget(7);
            for (let look = 0; look < 3 && smart; look += 1) {
              const route = await actions.routeTo(smart.tileX, smart.tileY);
              if (route.reachable && !Actions.circuitous(smart.distanceTiles, route.pathTiles)) {
                break;
              }
              const why = route.reachable
                ? `${route.pathTiles} tiles on foot for ${smart.distanceTiles.toFixed(1)} in a straight line`
                : 'walled off';
              log(`target: ${smart.label} at ${smart.distanceTiles.toFixed(1)} tiles - ${why} - looking past it`);
              actions.shunTarget(smart.label, smart.tileX, smart.tileY, 2);
              smart = actions.chooseTarget(7);
              // NOTHING LEFT IS AN ANSWER. Taking "whatever is left" after
              // three refusals re-locks a target the screen just rejected and
              // buys another ninety seconds of the same shuffle. Handing the
              // beat back with no lock lets the hunting leg wander, which is
              // what actually moves a body out of a walled pocket.
              if (2 === look && smart) {
                const last = await actions.routeTo(smart.tileX, smart.tileY);
                if (!last.reachable || Actions.circuitous(smart.distanceTiles, last.pathTiles)) {
                  log('target: nothing reachable worth walking to - wandering instead');
                  smart = null;
                }
              }
            }
            if (smart && (!this.lockedTarget || Date.now() >= this.lockedUntil)) {
              this.lockedTarget = { label: smart.label, tileX: smart.tileX, tileY: smart.tileY };
              this.lockedUntil = Date.now() + 90_000;
              if (this.lastPickLogged !== smart.label) {
                this.lastPickLogged = smart.label;
                log(`target: ${smart.label} (${smart.hp}hp) - ${smart.why}`);
              }
            }
            if (this.lockedTarget && Date.now() < this.lockedUntil) {
              const still = actions.huntCandidates(null, 15, 12)
                .find((c) => c.label === this.lockedTarget?.label
                  && Math.abs(c.tileX - this.lockedTarget!.tileX) <= 1
                  && Math.abs(c.tileY - this.lockedTarget!.tileY) <= 1);
              if (still) {
                // STOP AT WEAPON RANGE, DO NOT CHARGE. A caster closing to
                // 1.5 tiles is a caster in melee - which is what "running
                // through the enemies" was. Walk only until the target is
                // inside the character's own reach, then stand and shoot;
                // the last step lands ON the range ring, not on the enemy.
                const reach = this.effectiveAttackRange(scene) ?? 1.5;
                let outcome2;
                // SWING A TILE EARLY RATHER THAN NEVER (2026-08-16). The bare
                // `> reach` compares a reach measured in fractions of a tile
                // against a distance read from an observation this file
                // documents as seconds old, for enemies that are walking. The
                // harness's own advance oscillated 8.3 -> 7.4 -> 8.1 -> 5.7 ->
                // 4.5 -> 5.1 -> 7.5 without ever converging, and every beat
                // went to another step instead of a strike. Worse, each
                // arena_move_to CANCELS the server's own semi-auto chase - the
                // gateway says so outright, "whatever moved the body most
                // recently owns it" - so the harness kept interrupting the one
                // thing that would have closed the last stride.
                // A slack tile costs at worst one refused call, which the
                // server answers instantly and cheaply. Refusing to swing cost
                // an entire afternoon: not one hit landed all day.
                if (still.distanceTiles > reach + 1) {
                  // THE THIRD COPY OF THE STOP-SHORT MATH, RETIRED (2026-08-27).
                  //
                  // This walked to a point interpolated along the straight line
                  // to the target - the same geometry removed from closeOn()
                  // tonight, and the same failure: in a room 60% walled that
                  // point is usually inside rock, approach() snaps it to the
                  // nearest standable tile, and the snap flips between two
                  // tiles as the body drifts a few pixels a beat.
                  //
                  // It also carried a NaN hole closeOn() has always guarded:
                  // `still.tileX` is not checked for finiteness, and
                  // huntCandidates can emit a row without one. Caught live
                  // tonight - `[move] refused a walk to (NaN, 160)` followed by
                  // `locked on Stair Scuttler (14.4 tiles) -> did not move` -
                  // only because goTo now reports a pinned walk honestly.
                  //
                  // closeOn() is the one implementation now: it holds inside
                  // reach, aims at the tile otherwise, and guards its inputs.
                  // The `> reach + 1` gate above stays exactly as it was; it is
                  // the margin this branch learned the hard way and the reason
                  // closeOn's own hold gained the same slack tonight.
                  outcome2 = Number.isFinite(still.tileX) && Number.isFinite(still.tileY)
                    ? await actions.closeOn(still.label, reach)
                    : { ok: false, note: `${still.label} is here but the world did not say where` };
                } else {
                  outcome2 = await actions.perform({ ...step, target: still.label }, scene);
                }
                this.round.completed(step, outcome2.ok, outcome2.note ?? '');
                this.rememberMarket();
                log(`locked on ${still.label} (${still.distanceTiles.toFixed(1)} tiles) -> ${outcome2.ok ? 'ok' : outcome2.note}`);
                reflexActed = true;
                continue;
              }
              this.lockedTarget = null;
            }
            // The realm's people come first: a wounded bystander in this
            // room makes their position the anchor - kill what is on them.
            // Then the partner. Then whatever is nearest.
            const wounded = victim;
            // Both anchor on the partner: standing five tiles apart and
            // each killing what is nearest the other means one enemy, four
            // fists - focus fire without needing to share a target id.
            // A zeroed anchor is the rally logic saying "same room,
            // position unknown" - hunting within 12 tiles of (0,0) had
            // both royals declaring an enemy-packed crypt empty. And an
            // anchored hunt that finds nothing falls back to what is
            // near OUR OWN feet: better to kill five tiles from the
            // partner than to stand idle in a room full of Gnawers.
            // The target is the most ISOLATED enemy in the leash, not
            // the nearest - the pull doctrine. Both royals anchor the
            // same way, so they converge on the same lone body.
            const anchorPoint =
              wounded && !(0 === wounded.x && 0 === wounded.y)
                ? wounded
                : partnerLoc && partnerLoc.room === roundScene && !(0 === partnerLoc.x && 0 === partnerLoc.y)
                  ? partnerLoc
                  : null;
            // TERRAIN RECOGNITION (user doctrine): the map's own
            // pathfinder vets every candidate BEFORE an arrow flies. A
            // body the path cannot reach is behind a wall - skip it and
            // take the next clean lane; only if every lane is walled
            // does the orbit dance earn its keep.
            // Nearest-first grounds: the crypt chokepoint (the corridor
            // does the isolating) and the bot forest (trees do not
            // swarm - walking past three adjacent trees toward a
            // "lonelier" one was the last of the confused wandering).
            // Isolation-first survives for open zones with real packs.
            const nearestFirstGround = ['arena-crypt', 'reldens-bots-forest'].includes(roundScene);
            const candidates = (() => {
              if (nearestFirstGround) {
                return actions.huntCandidates(null, 12, 3, true);
              }
              const near = actions.huntCandidates(anchorPoint);
              return near.length ? near : actions.huntCandidates(null);
            })();
            let prey: (typeof candidates)[number] | null = null;
            for (const candidate of candidates) {
              if (await actions.pathClearTo(candidate.tileX, candidate.tileY)) {
                prey = candidate;
                break;
              }
              log(`terrain: ${candidate.label} at ${candidate.distanceTiles.toFixed(1)} tiles is walled off - passing over it`);
            }
            prey ??= candidates[0] ?? null;
            const ranged = this.effectiveRanged(scene);
            // A bow-armed body's basic swing is still attackShort - a
            // melee jab thrown politely from across the corridor. Every
            // strike beat becomes the arrow when the kit has one.
            const bowArmed = (this.sheet.skillLadder ?? []).some((rung) => 'bowShot' === rung.skill);
            const strikeStep = bowArmed && 'attack' === (step.action as string)
              ? ({ ...step, action: 'use_skill' as never, skill: 'bowShot' } as typeof step)
              : step;
            if (!prey) {
              // Nothing in the leash, but the room is not empty: march
              // to eight tiles from the nearest body and let the pull
              // doctrine take it from there. The shore's Saltbacks all
              // stand twenty-plus tiles east of the entrance; a leash
              // that never walks is a hunting ground that never pays.
              const far = ownLoc ? actions.huntIsolated(null, 999) : null;
              if (far && ownLoc) {
                const farX = far.tileX * tilePxFor(roundScene) + tilePxFor(roundScene) / 2;
                const farY = far.tileY * tilePxFor(roundScene) + tilePxFor(roundScene) / 2;
                const dist = Math.hypot(farX - ownLoc.x, farY - ownLoc.y) / tilePxFor(roundScene);
                const shy = dist > 8 ? (dist - 8) / dist : 0;
                outcome = shy > 0
                  ? await actions.goTo(ownLoc.x + (farX - ownLoc.x) * shy, ownLoc.y + (farY - ownLoc.y) * shy)
                  : { ok: false, note: 'no enemy within the leash' };
              } else {
                outcome = { ok: false, note: 'no enemy within the leash' };
              }
            } else {
              // The strict pull line (user doctrine, third revision -
              // the knight "ran in again and attracted all enemies at
              // once and died immediately"):
              //   1. The sovereign stands off and FIRES at the chosen
              //      isolated body - the bolt does the walking.
              //   2. The knight holds AT HER SIDE and swings only at
              //      what closes to steel range on its own feet.
              //   3. Kill. Repeat.
              // The knight advances on a target himself ONLY when the
              // sovereign is not in the room to pull for him.
              // Remember this pick: the lock above keeps his on it until it
              // dies rather than re-deciding every five seconds against a
              // seven-second-stale feed, which is what made him pace.
              this.lockedTarget = { label: prey.label, tileX: prey.tileX, tileY: prey.tileY };
              this.lockedUntil = Date.now() + 90_000;
              const preyX = prey.tileX * tilePxFor(roundScene) + tilePxFor(roundScene) / 2;
              const preyY = prey.tileY * tilePxFor(roundScene) + tilePxFor(roundScene) / 2;
              const selfDist = ownLoc ? Math.hypot(preyX - ownLoc.x, preyY - ownLoc.y) / tilePxFor(roundScene) : null;
              const pullerBeside = partnerLoc && partnerLoc.room === roundScene;
              // When the sovereign's pool is dry his bolt still flies,
              // but the crown trusts steel: the KNIGHT baits instead
              // (user doctrine) - dart to the edge of ONE body's
              // notice, then fall back to him side and kill what
              // follows, until the lifeTap engine refills his and the
              // magic pull resumes.
              // BRAWL MODE IS DEAD (user order: "stop running in. No
              // running in and dying if out of magic"). The pull never
              // depends on mana anyway: the sovereign's bowShot (Ash
              // Longbow) and attackBullet cost nothing - dry pool or
              // full, the ranged pull IS always available. Fireballs
              // are the bonus round whenever lifeTap refills the pool.
              // FIRING POSTS (user doctrine, called from the stands):
              // the pathfinder passes targets a WALKING route reaches,
              // but arrows fly straight - from the crypt stairs both
              // royals were shooting over the entry wall into stone.
              // Each posted room has one surveyed artillery position
              // with open lanes (crypt: hard north, just WEST of the
              // door - the enemies' side, per the user watching the
              // spectator view). Out of battle, with nothing in bow
              // range, the pair rallies to the post and pulls FROM it -
              // the mobs path around the wall into the kill zone.
              // Post placed by MAP ANALYSIS (arena_render_map, 2026-08-13):
              // the crypt's enemy chamber (west, x<=13) is sealed off by a
              // solid wall at column 14 - every arrow from the central
              // chamber dies in it. The ONE opening is the north corridor
              // at rows 4-5, columns 14-17. Tile (16,4) stands inside that
              // corridor mouth: a straight western lane down the corridor
              // into the chamber, and a single-file chokepoint for
              // anything pulled. Shoot down the hallway, never over the
              // wall.
              // EMPTY since 2026-08-14 (user: the crypt doorway post is
              // no longer needed - the map/LoS rework freed the room).
              // The mechanism stays for whatever zone needs a post next.
              const FIRING_POSTS: Record<string, { x: number; y: number }> = {};
              const post = FIRING_POSTS[roundScene];
              const postGap = post && ownLoc ? Math.hypot(ownLoc.x - post.x, ownLoc.y - post.y) / tilePxFor(roundScene) : null;
              if (
                post
                && ownLoc
                && null !== postGap
                && postGap > 1.2
                && 0 === (actions.danger()?.aggressors ?? 0)
                && 0 === candidates.length
              ) {
                // The post is the STARTING point, not a cage (user
                // doctrine): rally to it only when nothing stands
                // within the leash. With enemies in reach, the rolling
                // hunt owns the body - close to bow range of the
                // nearest, kill, advance to the next - and the walk
                // back to the funnel mouth happens by itself when the
                // ground goes quiet.
                outcome = await actions.goTo(post.x, post.y);
                outcome = { ok: outcome.ok, note: 'taking the firing post' };
              } else if (!ranged && 'reldens-bots-forest' !== roundScene && this.sheet.partner && !pullerBeside && null !== selfDist && selfDist > 3) {
                // A knight WITH a sovereign never engages without his.
                // The feed lags a room behind on every door crossing,
                // and in that seven-second blindspot "partner not
                // beside me" used to fall through to the solo charge.
                // No puller confirmed at his side, no engagement: hold.
                // NOT in the bot forest: holding a line against timber
                // is standing in a lumberyard refusing to work.
                outcome = { ok: true, note: 'holding for the sovereign - no charge without the pull' };
              } else if (!ranged && 'reldens-bots-forest' !== roundScene && pullerBeside && null !== selfDist && selfDist > 3) {
                outcome = { ok: true, note: 'holding the line - the pull brings the fight' };
              } else if (ranged && ownLoc && null !== selfDist && selfDist > 9) {
                // Artillery fires from the muzzle's edge: walk to an
                // EIGHT-tile standoff - just close enough to reach the
                // nearest monster and not one step nearer (user order).
                const shy = (selfDist - 8) / selfDist;
                outcome = await actions.goTo(ownLoc.x + (preyX - ownLoc.x) * shy, ownLoc.y + (preyY - ownLoc.y) * shy);
              } else if (
                ranged
                && ownLoc
                && 'reldens-bots-forest' !== roundScene
                && 0 === (actions.danger()?.aggressors ?? 0)
                && (() => {
                  // The gun line is measured to the CLOSEST enemy, not
                  // just the chosen target (user order): the sovereign
                  // stands just within the bow's reach of whatever is
                  // nearest, and backs off from THAT when it crowds
                  // his, target or no. NOT in the bot forest: three
                  // hundred stationary trees mean something is ALWAYS
                  // inside the line, and backing away from a tree into
                  // more trees was an endless retreat pinball. Trees
                  // are shot from wherever you stand.
                  const foe = actions.huntNearest(999);
                  return null !== foe && foe.distanceTiles < 6.5;
                })()
              ) {
                const foe = actions.huntNearest(999);
                if (foe) {
                  const foeX = foe.tileX * tilePxFor(roundScene) + tilePxFor(roundScene) / 2;
                  const foeY = foe.tileY * tilePxFor(roundScene) + tilePxFor(roundScene) / 2;
                  const gap = Math.max(foe.distanceTiles, 0.5);
                  // A BOUNDED STEP BACK, NOT A MULTIPLIER. This used to be
                  // (8 - gap) / gap applied to the whole vector: as the gap
                  // shrinks that quotient runs to infinity, so a caster
                  // standing on top of a tree computed a destination tens of
                  // thousands of pixels away. That is how the sovereign ended
                  // up at tile -21355 - off the map entirely, invisible on
                  // screen, with no walking route back. Now: step along the
                  // away-vector by at most a few tiles, using a unit vector
                  // so a near-zero gap cannot blow it up.
                  const awayX = ownLoc.x - foeX;
                  const awayY = ownLoc.y - foeY;
                  const len = Math.max(1, Math.hypot(awayX, awayY));
                  const want = Math.max(0, (this.effectiveAttackRange(scene) ?? 5) - gap);
                  const stepPx = Math.min(want, 4) * tilePxFor(roundScene);
                  outcome = await actions.goTo(
                    ownLoc.x + (awayX / len) * stepPx,
                    ownLoc.y + (awayY / len) * stepPx
                  );
                } else {
                  outcome = { ok: true, note: 'holding at casting range' };
                }
              } else if ('approach' === (strikeStep.action as string)) {
                // A HOLD HAS TO KNOW HOW FAR AWAY THE THING IS (2026-08-27).
                //
                // This answered "holding at casting range" for a ranged body
                // at ANY distance - the branch asserted the conclusion the two
                // branches above it were supposed to have established, and
                // nobody wrote the check. Its dead zone has narrowed as the
                // rest of tonight's work landed, but it is still real between
                // about 4.7 and 6 tiles while something is actively hitting
                // him, and it also swallowed a NaN: a prey row with no tileX
                // makes `selfDist` NaN, NaN passes `null !== selfDist` in both
                // branches above, and lands here - where nothing calls goTo,
                // so goTo's own NaN guard never gets to catch it. Comparing
                // against a number closes both holes at once, because
                // `NaN <= reach + 1` is false and the walk re-resolves the
                // enemy itself.
                //
                // `reach + 1` is the same slack the locked-target branch
                // learned it needed and closeOn's hold now carries: without it
                // this fights the server's own keep_distance spacing over
                // sub-tile staleness in the feed.
                const holdAt = (this.effectiveAttackRange(scene) ?? 1.5);
                outcome = ranged && null !== selfDist && selfDist <= holdAt + 1
                  ? { ok: true, note: `holding at ${selfDist.toFixed(1)} of ${holdAt} tiles` }
                  : await actions.closeOn(prey.label, ranged ? holdAt : undefined);
              } else {
                outcome = await actions.perform({ ...strikeStep, target: prey.label }, scene);
                // EFFECTIVENESS WATCH (user order): a shot that lands
                // "ok" against a wall is still a miss. If the same body
                // is still standing after four hits, the range or the
                // map is lying: step in a stride and a half (never
                // inside four tiles), and if it STILL will not fall,
                // sidestep to clear whatever is blocking the arrow.
                const sameTarget =
                  this.lastShotAt
                  && this.lastShotAt.label === prey.label
                  && Math.hypot(this.lastShotAt.tileX - prey.tileX, this.lastShotAt.tileY - prey.tileY) <= 2;
                if (sameTarget) {
                  this.shotsAtTarget += 1;
                } else {
                  this.shotsAtTarget = 1;
                  this.adjustStage = 0;
                }
                this.lastShotAt = { label: prey.label, tileX: prey.tileX, tileY: prey.tileY };
                if (outcome.ok && this.shotsAtTarget >= 3 && ownLoc && null !== selfDist && selfDist > 0) {
                  // Three arrows, still standing: the shot is blocked.
                  // ANGLE first, per doctrine - orbit the target at the
                  // SAME range for a clean line (one side, then the
                  // other, then a wider swing); only close the last
                  // stride when every angle has failed, and never
                  // inside four tiles.
                  // And when the WHOLE ladder has run once - both
                  // orbits, the wide swing, the closing stride - and
                  // the body still stands untouched, the target is
                  // unhittable from this world (behind a house, on the
                  // far side of a collision knot) and chasing it is the
                  // "running into the building forever" the spectator
                  // watched. Shun it; the ground is full of trees that
                  // can actually be cut.
                  if (this.adjustStage >= 4) {
                    actions.shunTarget(prey.label, prey.tileX, prey.tileY);
                    this.adjustStage = 0;
                    this.shotsAtTarget = 0;
                    this.lastShotAt = null;
                    log(`adjust: ${prey.label} untouchable from every angle - shunned for a while`);
                    outcome = { ok: true, note: `shunned ${prey.label} - a fresh target next beat` };
                  } else {
                  this.shotsAtTarget = 1;
                  const stage = this.adjustStage % 4;
                  this.adjustStage += 1;
                  const ux = ownLoc.x - preyX;
                  const uy = ownLoc.y - preyY;
                  const orbit = async (radians: number) => {
                    const rx = ux * Math.cos(radians) - uy * Math.sin(radians);
                    const ry = ux * Math.sin(radians) + uy * Math.cos(radians);
                    return actions.goTo(preyX + rx, preyY + ry);
                  };
                  if (0 === stage) {
                    await orbit(0.7);
                    log(`adjust: ${prey.label} soaking arrows at ${selfDist.toFixed(1)} tiles - orbiting left for a clean line`);
                  } else if (1 === stage) {
                    await orbit(-0.7);
                    log(`adjust: ${prey.label} still standing - orbiting right`);
                  } else if (2 === stage) {
                    await orbit(1.4);
                    log(`adjust: ${prey.label} still standing - swinging wide`);
                  } else if (selfDist > 5) {
                    const inward = 1.5 / selfDist;
                    await actions.goTo(ownLoc.x + (preyX - ownLoc.x) * inward, ownLoc.y + (preyY - ownLoc.y) * inward);
                    log(`adjust: every angle failed on ${prey.label} - closing one stride (${selfDist.toFixed(1)} tiles)`);
                  } else {
                    await orbit(-1.4);
                    log(`adjust: ${prey.label} unreachable at melee edge - swinging wide right`);
                  }
                  }
                }
              }
            }
          } else if ('approach' === (step.action as string)) {
            outcome = await actions.closeOn(step.target ?? '');
          } else if ('pick_up' === (step.action as string) && !actions.nearestDropSpot()) {
            // Bare floor: this beat is a strike, not a polite stoop at
            // nothing. Whatever weapon is in hand.
            const target = actions.huntNearest(12);
            outcome = target
              ? await actions.perform({ action: 'attack' as never, target: target.label } as never, scene)
              : await actions.perform(step, scene);
          } else if ('disengage' === (step.action as string)) {
            outcome = await actions.disengage();
          } else if ('discard_junk' === (step.action as string)) {
            // Forty rows a sweep, throttled in the round. The pack is far
            // larger than the visible window suggests - arena_inventory is
            // byte-capped, so 229 rows on screen is about 1,614 in the bag -
            // and at twenty a sweep draining it is an hour of forty-five
            // second beats. Each row is its own gateway call, so forty is
            // about twenty seconds of a turn: the ceiling worth paying.
            outcome = await actions.discardJunk(15);
          } else if ('drink_ale' === (step.action as string)) {
            // A mug at Barnaby's cask refills the mana pool outright. The
            // round only asks for this standing in the inn with the pool
            // dry and the coins for it; drinkAle() does the walk, the talk
            // and the choosing, and says in the log which of them refused.
            outcome = await actions.drinkAle(roundScene);
          } else if ('seek_drop' === (step.action as string)) {
            // Loot within reach or loot forgotten: farDropSpot on the
            // 145-tile forest sent both royals marching corner to
            // corner for one-copper branches, past hundreds of living
            // trees - the "running back and forth". Twelve tiles is
            // the whole loot radius; beyond that the beat is a strike.
            const spot = actions.nearestDropSpot() ?? (await actions.farDropSpot());
            const spotGap = spot && ownLoc ? Math.hypot(spot.x - ownLoc.x, spot.y - ownLoc.y) / tilePxFor(roundScene) : null;
            if (spot && null !== spotGap && spotGap <= 12) {
              outcome = await actions.goTo(spot.x, spot.y);
            } else {
              const target = actions.huntNearest(12);
              outcome = target
                ? await actions.perform({ action: 'attack' as never, target: target.label } as never, scene)
                : { ok: false, note: 'no drops in sight anywhere' };
            }
          } else if ('gather_nearby' === (step.action as string)) {
            // THE TRADE BEAT. One beat in eight - GATHER_EVERY_N_BEATS,
            // reflex.ts, which has been 16, 0 and 1 and is now 8. One was a
            // live regression: an offer costs no network call but it still
            // spends the beat, so both bodies stopped fighting. It does not
            // make a JOURNEY -
            // but "never travels" was too strong, and review caught it:
            // workNode walks to any node more than 1.5 tiles off, up to the
            // full radius. A dozen tiles is a stroll, not an errand, and it
            // cannot interrupt a fight (a live aggressor short-circuits to a
            // strike long before this beat is reached) - but it is a walk,
            // and the comment should not have said otherwise. The
            // round offers it, and this answers "nothing of ours within
            // reach" whenever no allowed node is underfoot, which is most
            // of the time in most rooms. Miller's Stair is the exception
            // that makes it worth having - the world puts salt_vein_copper
            // and salt_vein_iron in the very room both royals hunt, so a
            // mining sheet earns its trade experience without ever leaving
            // the ground it fights on.
            // A trip's gather sweeps the whole room it travelled to; an
            // ordinary beat only stoops for what is underfoot.
            outcome = await actions.gatherNearby(
              this.sheet.professions ?? [],
              gatherRadiusFor(step as { wide?: boolean })
            );
          } else if ('open_chest' === (step.action as string)) {
            outcome = await actions.openChest(step.target);
          } else if ('equip_best' === (step.action as string)) {
            outcome = await actions.equipBest();
          } else if ('unstick' === (step.action as string)) {
            outcome = await actions.unstick();
          } else if ('stop_fighting' === (step.action as string)) {
            outcome = await actions.stopFighting();
          } else if ('reconnect' === (step.action as string)) {
            outcome = await actions.reconnect();
          } else if ('force_doors' === (step.action as string)) {
            outcome = await actions.forceDoors();
          } else if (
            'use_skill' === (step.action as string)
            && step.skill === this.sheet.healSpell
            && this.sheet.healSpell
          ) {
            outcome = await actions.useSkillOnAlly(
              this.sheet.healSpell,
              '__self__' === step.target ? null : step.target ?? null
            );
          } else if ('use_skill' === (step.action as string) && '__self__' === step.target && step.skill) {
            // Self-casts (lifeTap, buffs) go down the ally path too: the
            // plain skill route only understands enemies.
            outcome = await actions.useSkillOnAlly(step.skill, null);
          } else if (
            'use_skill' === (step.action as string)
            && step.skill
            && step.target
            && null !== actions.partnerPlayerId(step.target)
          ) {
            // A player-shaped target - the condemned - goes down the
            // use_action path; the plain skill route only sees monsters.
            outcome = await actions.useSkillOnAlly(step.skill, step.target);
          } else if ('go_to' === (step.action as string)) {
            // MARCHING MEANS THE OLD MARK IS OFF. A go_to from the round is
            // the advance: it has decided this spot is played out and is
            // walking the body somewhere else in the room. The target lock
            // holds for ninety seconds and does not know that, so it kept
            // aiming at an enemy the march was walking AWAY from - Sir Qwen
            // logged "locked on Stair Scuttler" at 17.9 tiles, then 23.1,
            // then 23.9, closing on nothing the whole time. Drop it, and let
            // the next beat pick whatever is nearest where he ends up.
            this.lockedTarget = null;
            this.lockedUntil = 0;
            const [x, y] = (step.target ?? '0,0').split(',').map(Number);
            outcome = await actions.goTo(x, y);
          } else if ('route_to' === (step.action as string)) {
            // Same as go_to, and for the same reason drops the target lock -
            // but for a destination across the room, where the straight line
            // is the thing that has been failing. See actions.routeTo().
            this.lockedTarget = null;
            this.lockedUntil = 0;
            const [x, y] = (step.target ?? '0,0').split(',').map(Number);
            outcome = await actions.walkTheRoad(x, y);
          } else {
            outcome = await actions.perform(step, scene);
          }
          this.round.completed(step, outcome.ok, outcome.note ?? '');
          this.rememberMarket();
          const why = this.round.plan();
          // A bare "ok" hides the answer to the question most often asked of
          // this log (2026-08-16): equip_best returns ok for "now wearing 3
          // pieces", "already wearing the best" AND "nothing to wear", so a
          // whole night of "did he finally draw the sword?" was unanswerable
          // from the record. Actions whose interesting news lives in the
          // NOTE rather than the verdict say it on success too.
          // go_through_door and go_to are the worse offenders of the set,
          // because for them `ok` can actively mean DID NOT HAPPEN: a door
          // answers ok with "got part of the way; it is still ahead", and a
          // walk answers ok with "on the way". A log line reading
          // "go_through_door -> ok" for a door that was never crossed is
          // the same unanswerable-overnight problem in a costlier place.
          // open_chest joins the list for the same reason (2026-08-16): it
          // is talkTo() underneath, so "ok" only means the chest was
          // greeted, not that anything came out of it. Measured: five
          // consecutive "open_chest A Rush-Wrapped Chest -> ok" on the
          // grassland cache with no boots ever reaching the pack and no way
          // to tell whether the chest was empty, already claimed, or
          // answering with a prompt nobody read. Whatever it actually says
          // is the only thing that can settle that.
          // pick_up joins the list (2026-08-16) for exactly the reason
          // open_chest did: "ok" is not an outcome. Measured - the hunting
          // leg spends most of its beats on pick_up, every one answers ok,
          // and the pack stays pinned at 237 rows while it happens. Either
          // the floor is empty and "ok" means nothing was there, or
          // something is picked up and immediately not counted. Those want
          // different fixes and the note already knows which it is; it was
          // simply being thrown away before it reached the log.
          // gather_nearby joins the list (2026-08-31) for the third time the
          // same lesson has been paid for. Measured this run: 18 beats of
          // "gather_nearby -> ok" for Lord Gemma and 21 for Sir Qwen, and
          // not one of them says whether a node was worked or whether the
          // body simply found nothing in reach - gatherNearby() answers
          // ok:true for BOTH. That is the whole reason nobody can say
          // whether mining works: the instrument reads the same either way.
          // shrine_bless joins it because a mend that did not happen is the
          // difference between a caster who can keep fighting and one who
          // cannot.
          const tellOnSuccess = 'equip_best' === (step.action as string)
            || 'sell' === step.action || 'buy' === step.action
            || 'gather_nearby' === (step.action as string)
            || 'shrine_bless' === (step.action as string)
            || 'pick_up' === (step.action as string)
            || 'open_chest' === (step.action as string)
            || 'go_through_door' === (step.action as string)
            || 'go_to' === (step.action as string)
            // 'approach' is answered by FIVE different branches in this file
            // and every one of them printed the same bare `-> ok`. That is how
            // a no-op stood 21 tiles from thirty-one hostiles for an hour and
            // looked like a body walking. The note names the branch; print it.
            || 'approach' === (step.action as string);
          const said = outcome.ok
            ? (tellOnSuccess && outcome.note ? `ok - ${outcome.note}` : 'ok')
            : outcome.note;
          log(
            `round[${why.leg}>${why.dest.replace('reldens-', '').replace('arena-', '')}]: ${step.action}`
            + `${step.place ? ' ' + step.place : ''}${step.target ? ' ' + step.target : ''}`
            + `${step.item ? ' ' + step.item : ''} -> ${said}`
          );
          note(this.sheet.playerName, 'round', `${step.action}: ${outcome.ok ? 'ok' : outcome.note}`);
          reflexActed = true;
        }
      } else if (this.sheet.busks && Date.now() - this.lastTalkAt < 180_000) {
        // THE MUSIC DOES NOT WAIT FOR THE LANGUAGE MODEL (user, thrice:
        // "NEVER STOP"). A model turn takes 60-90s; running one every
        // tick meant one song a minute with a long silence behind it.
        // With nobody speaking to him there is nothing to say anyway, so
        // the tick ends here and the next melody starts in five seconds.
        // The moment somebody DOES speak (heard) or a new face appears
        // (socialSpark), the branch below runs and he answers in
        // character - then goes straight back to playing.
      } else {
        this.lastTalkAt = Date.now();
        this.lastSocialTurnAt = Date.now();
        this.socialSpark = false;
        await this.liveOneTurn(situation);
        if (this.unspokenThought) {
          const line = (this.unspokenThought.split(/(?<=[.!?])\s/).find((part) => part.trim().length >= 12 && /[a-z]/i.test(part)) ?? '').slice(0, 200);
          const spoken = line ? await actions.say(line) : { ok: false, note: 'nothing worth saying' };
          log(`say-fallback -> ${spoken.ok ? 'ok' : spoken.note}`);
          this.unspokenThought = null;
        }
      }
      // Fold history down when it is due. Multi-step turns give Mastra's own
      // observation trigger a real chance to run in-band; this stays as the
      // backstop for quiet stretches. Fire-and-forget with a busy-guard
      // inside; see keepMemoryDigested().
      void keepMemoryDigested(this.recollection, this.memory).then((digest) => {
        if (digest.did === 'observed' || digest.did === 'failed') {
          log(`memory digestion ${digest.did}: ${digest.note ?? ''}`);
          note(this.sheet.playerName, digest.did === 'observed' ? 'observed' : 'failed', digest.note ?? 'memory digestion');
        }
      });

      // Put back whatever the model's own memory write may have dropped. It
      // costs one local SQLite write per tick and it is the only thing standing
      // between a character and quietly losing everything the harness knows
      // about it every time it says something.
      await this.plan.keep();

      const pace = this.sheet.pace ?? {};
      await sleep(
        1000 *
          (reflexActed
            ? 5
            : heard.length > 0
              ? pace.engaged ?? DEFAULT_ENGAGED_SECONDS
              : pace.idle ?? DEFAULT_IDLE_SECONDS)
      );
    }
  }

  /**
   * Keep what somebody said about a place it has never been.
   *
   * This is the whole social half of exploring. Guy comes down from upstairs
   * and says there is nothing up there; the Wanderer, who has never been up,
   * now knows of a room he has only been told about, by name, with Guy's name
   * on it. That is a thing to go and check, and checking it is worth talking
   * about either way.
   */
  private async noteHearsay(
    intent: Intent,
    heard: Array<{ from: string; message: string }>
  ): Promise<void> {
    const noted = intent.noted?.trim();
    const notThere = intent.notThere?.trim();
    const from = heard.at(-1)?.from ?? 'somebody';
    if (noted) {
      await this.remit((state) =>
        notePlace(state, { where: noted, what: `${from} says so`, how: 'heard', who: from })
      );
      log('noted:', `${noted} (from ${from})`);
    }
    // Somebody looked and found nothing. Either this character did, or it just
    // heard somebody say they had; both count against the rumour, which is what
    // stops one confident remark about a guildhall circulating forever.
    if (notThere) {
      await this.remit((state) => doubtPlace(state, notThere));
      log('found nothing at:', notThere);
    }
  }

  /**
   * Something an NPC actually said to this character, straight into memory
   * as a thing that happened - not a place somebody mentioned in passing,
   * which stays hearsay until this character goes and checks for itself (see
   * noteHearsay() and standingOf() in memory.ts), but a fact gathered
   * first-hand because it was standing right there in the conversation.
   * Alfred telling this character something is not a rumour about Alfred;
   * the character was there. That is what lets it carry the fact on to
   * somebody else rather than only ever repeating that Alfred said something.
   *
   * Deliberately unconditional, the same as noteFace() and noteWhereItIs():
   * whether a reply is worth keeping is not the model's call to make in the
   * middle of the conversation it is having.
   */
  private async noteToldByNpc(told: { from: string; said: string } | null): Promise<void> {
    if (!told) {
      return;
    }
    await this.remit((state) => noteGoingsOn(state, `${told.from} told you: ${told.said}`));
    log('told by', told.from, ':', told.said);
  }

  /**
   * A quest, finished: the same first-hand write as noteToldByNpc(), fired
   * from the other end of it. Miles asks for a tree branch and offers a coin;
   * the character takes that on with `askedBy: "Miles"` (see addTodo() in
   * memory.ts), works it however it likes, and the moment it is crossed off
   * this turns "a todo item done" into "something Miles asked for, and you
   * came through" - a fact this character was there for and can now tell
   * whoever it runs into next. Unconditional, the same as noteFace() and
   * noteWhereItIs(): whether finishing a favour is worth mentioning later is
   * not left for the model to remember to say out loud.
   */
  private async noteQuestDone(askedBy: string, what: string): Promise<void> {
    await this.remit((state) => noteGoingsOn(state, `${askedBy} asked you to ${what}, and you did.`));
    log('came through for', askedBy, ':', what);
  }

  /**
   * Let a character decide it wants something else now.
   *
   * Rare and deliberate: it costs the whole plan, and a character that changes
   * its mind every afternoon never gets anywhere. But one that finished what it
   * set out to do, or ran into a wall it cannot get past, has to be able to
   * pick something new or it stands in the town square forever having won.
   */
  private async reconsider(intent: Intent): Promise<void> {
    if (intent.action !== 'set_goal') {
      return;
    }
    const aim = intent.aim?.trim() ?? '';
    if (!aim) {
      log('wanted to change tack but did not say to what');
      return;
    }
    const was = this.plan.goal?.aim;
    const changed = await this.plan.setGoal(aim, intent.done ?? '', intent.why ?? '');
    if (changed) {
      log(was ? `done with "${was}". now after: ${aim}` : `decided to go after: ${aim}`);
    }
  }

  /**
   * Everything the character wanted written down while it was doing something
   * else: a note for the next hour, a thing it has taken on, a thing it has
   * finished with. These ride along with any action, so making a note never
   * costs a character a turn of standing still.
   */
  private async keepBooks(intent: Intent): Promise<void> {
    if (intent.remember?.trim()) {
      await this.plan.note(intent.remember);
      log('keeping in mind:', intent.remember.trim());
    }
    if (intent.todo?.trim()) {
      const askedBy = intent.askedBy?.trim();
      await this.plan.take(intent.todo, askedBy);
      log('took on:', intent.todo.trim(), askedBy ? `(for ${askedBy})` : '');
    }
    if (intent.finished?.trim()) {
      // Read who, if anybody, asked for this before it is crossed off - the
      // open-list lookup is gone the moment settle() marks it done.
      const item = findTodo(await this.recall(), intent.finished);
      await this.plan.settle(intent.finished, 'done');
      log('crossed off:', intent.finished.trim());
      if (item?.askedBy) {
        await this.noteQuestDone(item.askedBy, item.what);
      }
    }
    if (intent.gaveUpOn?.trim()) {
      await this.plan.settle(intent.gaveUpOn, 'blocked');
      log('gave up on:', intent.gaveUpOn.trim());
    }
    if (intent.progressOn?.trim() && intent.learned?.trim()) {
      await this.plan.gotSomewhere(intent.progressOn, intent.learned);
      log('progress on', intent.progressOn.trim(), '->', intent.learned.trim());
    }
    if (intent.recall?.trim()) {
      // Answered into the notes rather than returned, because the character is
      // in the middle of doing something else and this is the harness thinking
      // on its behalf. It reads it a moment later, which is about right.
      const answer = recallAbout(await this.recall(), intent.recall);
      if (answer) {
        this.notes = [...this.notes.filter((note) => !note.startsWith('Thinking back')), answer];
      }
      log('thought back on:', intent.recall.trim());
    }
  }

  /**
   * Whether this is worth saying out loud. A model never repeats itself word
   * for word, it just keeps saying the same thing in different words, which is
   * what makes a character sound broken. Comparing what a line is about, not
   * how it is spelt, is what actually catches that.
   */
  private worthSaying(line: string): boolean {
    return Boolean(line) && !isTooSimilar(line, this.recentlySaid);
  }

  /**
   * Write down everyone standing here, whether or not anything happens.
   *
   * Deliberately unconditional, and deliberately not the model's decision. A
   * character that only remembers the people it found interesting will meet the
   * same barfly for the hundredth time and describe him as a new face, which is
   * exactly what all three of them were doing.
   */
  private async noteWhoIsHere(others: string[], scene: string): Promise<void> {
    const where = plainSceneName(scene);
    const fresh = others.filter((name) => !this.faces.has(`${scene}:${name}`));
    if (fresh.length === 0) {
      return;
    }
    for (const name of fresh) {
      this.faces.add(`${scene}:${name}`);
    }
    await this.remit((current) =>
      fresh.reduce((state, name) => noteFace(state, name, where), current)
    );
  }

  /** Who is here, and which of them this character has seen before. */
  private async describeOthers(others: string[]): Promise<Array<{ name: string; known: boolean }>> {
    const state = await this.recall();
    return others.map((name) => ({ name, known: hasMet(state, name) }));
  }

  /** Say something back. Returns false when the character had nothing to add. */
  private async answer(situation: Situation, actions: Actions): Promise<boolean> {
    const prompt = [
      describeSituation(situation),
      '',
      'Someone just spoke where you can hear it. Reply if it is worth replying',
      'to - if it was aimed at you, or if you have something to add. If it was',
      'not your business, say nothing.',
      '',
      'If you learn something about someone worth keeping - who they are, what',
      'they did, whether you warmed to them - put it in your working memory.',
      'Record what you make of other people and what happened. Never record',
      'anything about who you are; that does not change.',
      '',
      'If somebody mentions a place you have never been, put it in "noted" as',
      'you would refer to it, so you can go and see for yourself later. If',
      'somebody says they went somewhere and found nothing there, put that',
      'place in "notThere".',
      '',
      // Answering somebody is where a character most easily loses the thread of
      // what it was doing, so this is exactly where it needs to be able to
      // write things down: a promise made in conversation is a promise it will
      // otherwise not keep.
      BOOKKEEPING,
      '',
      'Reply with JSON and nothing else:',
      '{"action": "say", "message": "...", "noted": "..."} or {"action": "wait"}',
      'In your own voice, no asterisks. ' + lengthGuidance(situation.wordiness)
    ].join('\n');
    const intent = await askForIntent(
      this.agent,
      prompt,
      this.memory,
      momentOf(situation),
      this.persona
    );
    await this.noteHearsay(intent, situation.heard);
    await this.keepBooks(intent);
    if (intent.action !== 'say') {
      return false;
    }
    const said = toSpeech(intent.message ?? '', this.wordiness).join(' ');
    if (!this.worthSaying(said)) {
      return false;
    }
    const result = await actions.say(said);
    if (result.ok) {
      this.remember(said);
      log('replied:', said);
    }
    return result.ok;
  }

  /**
   * Everywhere this character could name: what it has seen, what it has been
   * told, and for a local, the streets it knows by heart. Somebody with nothing
   * true to say about where things are will make something up.
   */
  private whatItKnows(scene: string, state: WorkingMemoryState): string {
    const local = describeLocalKnowledge(this.sheet.localKnowledge ?? [], scene);
    const found = describePlacesKnown(state);
    return [local, found].filter(Boolean).join('\n\n');
  }

  /**
   * The people this character knows, read back out of working memory so it can
   * act on them: greet somebody it likes, be short with somebody it does not.
   */
  private async knownPeople(): Promise<string> {
    return describePeople(await this.recall());
  }

  private async recall(): Promise<WorkingMemoryState> {
    return readMemory(await this.memoryStore(), this.memory);
  }

  private async remit(change: (state: WorkingMemoryState) => WorkingMemoryState): Promise<void> {
    const state = await this.recall();
    await writeMemory(await this.memoryStore(), this.memory, change(state));
  }

  /**
   * Write down that it has been here. Standing somewhere yourself beats
   * anything you were told about it, so this settles any rumour it had been
   * carrying about this room.
   */
  private async noteWhereItIs(
    scene: string,
    view: RoomView | null,
    observation: Observation
  ): Promise<void> {
    const state = observation.ownPlayer?.state;
    if (Number.isFinite(Number(state?.x))) {
      this.explorer.markHere(scene, Number(state?.x), Number(state?.y));
    }
    // Both conditions, and the memory one is not redundant. Working memory is a
    // single record and the model can write it too; when it does, it writes the
    // whole thing as it understands it, which silently drops every field it was
    // not shown. Barnaby lost his own inn that way and, guarded only by the set
    // above, never wrote it again for the life of the process.
    const known = (await this.recall()).places.some(
      (place) => place.where.trim().toLowerCase() === plainSceneName(scene).trim().toLowerCase()
    );
    if (this.recorded.has(scene) && known) {
      return;
    }
    this.recorded.add(scene);
    const ways = (view?.doors ?? [])
      .map((door) => (door.leadsTo ? plainSceneName(door.leadsTo) : null))
      .filter((where): where is string => Boolean(where));
    await this.remit((current) =>
      notePlace(current, {
        where: plainSceneName(scene),
        what: ways.length > 0 ? `you have been in. Doors to ${ways.join(', ')}.` : 'you have been in',
        how: 'been'
      })
    );
  }

  /** Note something this character said, so it hears its own side of it too. */
  private remember(line: string): void {
    const text = line.trim();
    if (!text) {
      return;
    }
    this.recentlySaid.push(text);
    while (this.recentlySaid.length > RECENT_LINES) {
      this.recentlySaid.shift();
    }
    this.record('you', text);
  }

  private record(from: string, message: string): void {
    this.transcript.push({ from, message, fresh: true });
    while (this.transcript.length > TRANSCRIPT_LINES) {
      this.transcript.shift();
    }
  }

  private async refreshSavings(actions: Actions): Promise<void> {
    const result = await actions.checkMoney().catch(() => null);
    this.notes = result?.ok ? [result.note] : [];
  }

  /** Lines spoken since the last look, never including this character's own. */
  private freshLines(observation: Observation): Array<{ from: string; message: string }> {
    const fresh: Array<{ from: string; message: string }> = [];
    for (const line of spokenLines(observation)) {
      if (line.from === this.sheet.playerName) {
        continue;
      }
      const key = `${line.at}|${line.from}|${line.message}`;
      if (this.seen.has(key)) {
        continue;
      }
      this.seen.add(key);
      fresh.push({ from: line.from, message: line.message });
    }
    if (this.seen.size > 500) {
      this.seen.clear();
    }
    return fresh;
  }

  /**
   * One agentic turn: everything the character does this tick.
   *
   * The situation rides in the per-call instructions, which are sent and not
   * stored - the same cost lesson this file already paid for once, recorded
   * at askForIntent(): what lands in memory should be the turn, not the
   * scenery. The user message is the small moment line, and the tool calls
   * and their results are stored by Mastra as the multi-step turn they are,
   * which is exactly the shape its observational memory was built to fold.
   *
   * Speech is a tool now. Anything the model writes outside arena_say is
   * private thought, and the guidance says so plainly, because the
   * alternative - broadcasting the model's inner monologue - was this
   * project's very first bug.
   */
  private async liveOneTurn(situation: Situation): Promise<void> {
    // Written to the character, not to a model operating one. The tool layer
    // is plumbing and stays invisible: walking is walking, speaking is
    // speaking, and the one mechanical fact worth stating - words outside
    // arena_say are unvoiced thought - is stated once, plainly, because its
    // opposite (broadcasting inner monologue) was this project's first bug.
    const guidance = [
      'Live the next moment. Do what you would actually do: look closer, walk',
      'where you mean to go, swing at what needs hitting, say what you have to',
      'say out loud (arena_say is your voice; words written anywhere else are',
      'thoughts, and nobody hears them). React to how the world answers you - a',
      'door that refuses, a swing that lands, a price you cannot pay. Every',
      'turn MUST end in a deed the world can see: a step taken, a blow',
      'struck, loot picked up, a door entered, a purchase made, or a line',
      'spoken. Look at most once, then act on what you saw - observing',
      'without acting is a wasted turn.',
      'NEVER greet anyone - no well met, no hail: your FIRST words are the',
      'joke, the answer, or the decree. Every line must name something',
      'CONCRETE from this scene - a name, a wound, a price, a smell - and',
      'no phrasing you have ever used may be used again. Specificity is',
      'the whole of wit; generality is the death of it.',
      'BANTER, DO NOT THREATEN. If someone has spoken, ANSWER THE THING',
      'THEY SAID - their words, turned - and leave them room to hit back.',
      'Never promise violence to a person, never summon anyone to a duel,',
      'never announce what you will do to their body: threats are not',
      'jokes and this court does not make them. Mockery of the crown is',
      'answered with a better joke, never a blade.',
      'ONE beat, then stop. Two sentences at the very most, and the last',
      'one is the funny one. Long is not witty.',
      'SWEAR, and MIX IT UP - reaching for the same word every time is the',
      'one thing duller than not swearing at all. Rotate through the full',
      'range, never lean on one favorite two lines running: fuck, shit,',
      'bastard, bollocks, bugger/buggering, sod, arse/arsehole, piss/pissing,',
      'whoreson, knave, blackguard, cur, wretch, bloody, damn/damnation,',
      'hellfire, wanker, tosser, git, prick, twat, cunt, motherfucker,',
      'bullshit, horseshit, goddamn, son of a bitch - deadpan, aimed at the',
      'world, the furniture, the paperwork, an enemy, a rival, a fool - and',
      'never a slur or a jab at anyone\'s body or birth, that line does not',
      'move. Calm obscenity is funny; ranting is not. A clean line is fine',
      'when it is funnier clean.',
      'SPEAK, never narrate: first person only, aimed at somebody present.',
      'Never say your own name or your partner\'s as a subject ("Sir Qwen',
      'stands..." is a novel, not a voice). No stage directions, no',
      '"says X", no describing the light or your gauntlets. If a line',
      'does not land on a target - a jab, a boast, a demand, a decree, an',
      'answer - it does not leave your mouth.',
      lengthGuidance(situation.wordiness)
    ].join('\n');
    try {
      // THE SITUATION MOVED OUT OF THE INSTRUCTIONS (2026-09-02), and it is
      // the difference between a prompt the server can reuse and one it
      // cannot.
      //
      // `instructions` renders BEFORE the tool declarations. While
      // describeSituation() sat there, every turn diverged at "You are at
      // ..." and the 6,704 tokens of tool schemas behind it were re-prefilled
      // from scratch - for the SAME character, on consecutive turns.
      // Measured: the common prefix between two of Sir Qwen's turns was
      // 4,785 of 13,492 tokens, 35%. A 31B Q8 prefills at ~1,525 tok/s, so
      // that is ~9 seconds of pinned GPU discarded every turn.
      //
      // Persona and guidance are per-character constants, so instructions are
      // now byte-identical call to call, and the tools behind them with them.
      // The situation rides in the USER message instead: static prefix first,
      // volatile content last, which is what a prompt cache needs.
      //
      // NOTHING IS LOST - the model gets the same words in the same turn, in
      // a different envelope. --ctx-size and recall are untouched.
      const response = await this.agent.generate(
        [describeSituation(situation), momentOf(situation)].join('\n\n'), {
        memory: this.memory,
        // Replaces the agent's instructions rather than adding to them, so the
        // persona has to come along or the character acts as nobody.
        instructions: [this.persona, guidance].join('\n\n'),
        maxSteps: STEPS_PER_TURN,
        modelSettings: { temperature: 0.85, frequencyPenalty: 0.3, presencePenalty: 0.6 }
      });
      meter(this.sheet.playerName, 'living', response);
      const called = (response as { toolCalls?: Array<{ toolName?: string }> }).toolCalls ?? [];
      const names = called.map((call) => call?.toolName ?? 'tool').join(', ');
      const thought = String((response as { text?: string }).text ?? '').trim();
      log(`turn: ${called.length} action(s)${names ? ` (${names})` : ''}`);
      if (thought) {
        log('thought:', thought.slice(0, 160));
      }
      // A storyteller model writes the line and never presses "say":
      // whole turns end as beautiful unheard prose. Keep the line; the
      // caller delivers it through the real voice.
      // Second-person narration ("You are in the grassland") is the
      // situation text echoing back, not dialogue - voicing it made the
      // knight sound like a broken tour guide.
      const isNarration =
        /^\s*["']?(you\b|there is|there are)/i.test(thought)
        // Tool-shaped hallucinations ("[arena_look agent_id]") are not
        // dialogue either - the knight once SAID one out loud.
        || /^\s*[\[{(]/.test(thought)
        || /\b(agent_id|arena_[a-z_]+)\b/.test(thought);
      this.unspokenThought = 0 === called.length && thought.length > 3 && !isNarration ? thought : null;
      note(this.sheet.playerName, 'did', `turn: ${names || 'nothing but thinking'}`);
      // The notes were delivered with the situation this turn was given; a
      // correction that has been seen once should not nag forever.
      this.notes = [];
    } catch (error) {
      const why = String((error as Error)?.message ?? error).slice(0, 200);
      log('turn failed:', why);
      note(this.sheet.playerName, 'failed', `turn: ${why}`);
    }
  }

  private async ensureRegistered(arena: ArenaClient): Promise<string> {
    const existing = await arena.call('arena_list_agents', {});
    for (const agent of existing.agents ?? []) {
      if (agent.playerName === this.sheet.playerName) {
        return agent.id;
      }
    }
    const created = await arena.call('arena_register_agent', {
      agent_name: this.sheet.id,
      player_name: this.sheet.playerName,
      class_path: this.sheet.classPath ?? 'journeyman',
      selected_scene: this.sheet.homeScene,
      idempotency_key: `npc-${this.sheet.id}-v1`
    });
    log('registered', this.sheet.playerName);
    return created.agent.id;
  }
}
