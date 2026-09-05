/**
 * Everything an NPC is able to do, and nothing else.
 *
 * The gateway exposes a lot of tools. A character in a town needs a handful of
 * them, expressed the way a person would think about them: go somewhere, go
 * through that door, say something, stand still. Each action here wraps the
 * gateway call and constrains its inputs, so a character asks for "the east
 * gate" rather than a pixel coordinate and a badly chosen action sends someone
 * to the wrong end of town instead of into a wall.
 *
 * A character declares which of these it may use. Barnaby cannot walk out of
 * his own inn because he was never given the door.
 */

import { z } from 'zod';
import { ArenaClient, ArenaObject, CarriedItem, Observation, SeenDrop, sceneOf } from './arena.js';
import { Explorer, RoomView, SeenDoor } from './explore.js';
import { placesIn, plainSceneName, rawSceneName, roomOf, tilePxFor } from './world.js';
import { Feeling, FEELINGS, emojiFor } from './feeling.js';

/**
 * The six Old Jerr cache items (agentArena deploy/world/item-specs/treasure-
 * items.mjs) - each a once-per-character, non-farmable grant the server
 * itself marks canBeDropped:false. User standing order, 2026-08-15: never
 * sell, drop, or destroy one of these, keep every one claimed until told
 * otherwise. Named by key, not by room or title, so the protection travels
 * with the item regardless of which chest logic changes later.
 */
const TREASURE_ITEM_KEYS = new Set([
  'jerrs_blackened_spoon',
  'mara_saltguard',
  'east_house_jack',
  'empty_mat_boots',
  'button_keeper_grips',
  'borrowed_cup_helm'
]);

/**
 * Loot worth about a copper a unit, sorted to the BACK of the sell queue by
 * sellableItems(). Branches are the only member and the only one measured:
 * the counter pays 1 for one, and a farming run brings back well over a
 * hundred rows of them. A rest is capped at 30 sells, so without this the
 * whole budget can go at a copper a call. Not a price table - there is no
 * price on a carried item to read - just the one key this harness has
 * already documented as near-worthless in two other comments.
 */
const LOW_VALUE_KEYS = new Set(['branch']);

export const CAPABILITIES = [
  'speak',
  'talk_to_folk',
  'walk',
  'doors',
  'fight',
  /**
   * May agree to fight another character, which is not the same permission as
   * fighting wildlife. A monster-culler with no interest in duelling people
   * and a duellist with no business swinging at boars are both writable.
   * Requires 'fight' in code: you must be able to swing at all before you can
   * challenge somebody to.
   */
  'duel',
  /**
   * May work a gathering node and a work station: mine, forage, smelt, forge,
   * cut, sew, cook.
   *
   * A separate permission from `trade` because it is a separate risk. Trading
   * spends coin and can lose gear; crafting spends MATERIALS and can only add
   * to the satchel - `arena_craft` is one transaction and "a refusal leaves
   * the satchel unchanged", in the world's own words.
   *
   * Every one of these tools was invisible to this harness until 2026-08-26.
   * The gateway offers 57 and we were handing characters 27: `arena_gather`,
   * `arena_craft`, `arena_recipes` and `arena_merchant_catalog` were all
   * simply never wired, while both royals sat at level 1 with 0 experience in
   * all nine professions and the world put a recipe in the `gameplayHint` of
   * every single reply.
   */
  'craft',
  'money',
  /**
   * May stand at a merchant's counter and haggle. Separate from 'money',
   * which is only the ability to count what it has, because the two are
   * genuinely different characters: a monster-culler carries coins and never
   * shops, and a trader shops without ever swinging at anything. Nothing that
   * fights automatically learns to bargain.
   */
  'trade',
  /**
   * May perform music the whole scene hears. Separate from 'speak' because
   * a performance is a public act with an audience, and most characters who
   * can talk have no business holding an instrument. (Capability and idea
   * from TennesseePete's Fanshawe patch, 2026-08-15.)
   */
  'perform',
  'purpose'
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/**
 * How the step a character is working on stands after this action. It is the
 * character that says, because only it knows what it was trying to do; the
 * harness holds the list and does the writing down.
 */
export type Progress = 'same' | 'done' | 'blocked';

/**
 * How long a character has to wait before it can give up on a room again.
 *
 * Long on purpose. This is the one action that does not have to obey the map,
 * so the cost of reaching for it has to be higher than the cost of walking.
 */
const GIVING_UP_AGAIN_MS = 60 * 60 * 1000;

const ACTIONS = [
  'say',
  'walk',
  'explore',
  'use_door',
  'talk_to',
  'answer_npc',
  'attack',
  'use_skill',
  'use_item',
  'pick_up',
  'buy',
  'sell',
  'check_money',
  'set_goal',
  'duel_queue',
  'give_up_and_walk_back',
  'wait'
] as const;

/**
 * What a character decided to do this tick.
 *
 * One action, plus anything it wants written down while doing it. The
 * bookkeeping fields are separate from the action on purpose: a character
 * should be able to walk out of a room and remember why on the same tick,
 * rather than spending a turn standing still to make a note.
 */
export type Intent = {
  /** A trip's gather sweeps the room, not just what is underfoot. */
  wide?: boolean;
  action: (typeof ACTIONS)[number];
  place?: string;
  /** With talk_to, attack or use_skill: who or what it means, by name. */
  target?: string;
  /**
   * With use_skill: which of its own skills, by name. A character only has the
   * ones its class path grants it, so this is checked against what it actually
   * knows rather than taken on trust. See Actions.useSkill().
   */
  skill?: string;
  /**
   * With use_item, buy, sell or pick_up: which thing, by the name it is
   * carried or sold under. Kept apart from `target`, which is a person: a
   * character selling a pelt to Gimly names both, and collapsing them into
   * one field means it can only ever say one.
   */
  item?: string;
  /** With buy or sell: how many. One when it does not say. */
  quantity?: number;
  message?: string;
  /**
   * With answer_npc: which of the choices it was just given, by the words of
   * the choice or its number. Only meaningful right after a talk_to that
   * offered any.
   */
  option?: string;
  progress?: Progress;
  /**
   * Something the character just learned about a place, in its own words. This
   * is how hearsay gets into memory: somebody mentions a room upstairs, the
   * character notes that it heard it and from whom, and can go and check later.
   */
  noted?: string;
  /**
   * A place it was told about and has now looked for and not found. The other
   * half of hearsay: a rumour that can only ever be confirmed is an
   * announcement.
   */
  notThere?: string;
  /**
   * Set by the harness, never by the model: this intent was recovered from a
   * reply that arrived as prose with no action in it. It is the only way to
   * tell a character that chose to speak from one that has stopped answering
   * in the format at all, since both arrive as a say.
   */
  salvagedFromProse?: boolean;
  /** Something to hold in mind for the next hour, then forget. */
  remember?: string;
  /** Something it is taking on, added to its own list. */
  todo?: string;
  /** With todo: who asked for it, if this is a favour rather than a chore it set itself. */
  askedBy?: string;
  /** An item on that list it has just finished, by number or by roughly what it was. */
  finished?: string;
  /** An item it is giving up on, same way of referring to it. */
  gaveUpOn?: string;
  /**
   * Somebody or somewhere it wants to think back on. What it knows comes back
   * in the next brief rather than immediately, which costs a tick and is about
   * how remembering works anyway. Its purpose is reaching past the summary the
   * brief can afford to carry: see recallAbout() in memory.ts.
   */
  recall?: string;
  /** An item on its list it has got somewhere with, by number or by what it was. */
  progressOn?: string;
  /** What it found out about that item, kept against it. */
  learned?: string;
  /** With set_goal: what it has decided it is after now. */
  aim?: string;
  /** With set_goal: how it would know it had got there. */
  done?: string;
  /** With set_goal: why it settled on that, in its own words. */
  why?: string;
  /**
   * How it feels right now, from the closed set in feeling.ts. Optional and
   * additive, exactly like the bookkeeping fields above: it rides along with
   * whatever action this is, and never replaces one. See emojiFor() and
   * Actions.showFeeling() for what becomes of it.
   */
  feeling?: Feeling;
};

export const IntentSchema = z.object({
  // Lenient for the same reason `progress` below is lenient, and it costs more
  // here. A model that means "look around" writes {"action": "look"}, which is
  // not on the list, so the whole reply was thrown away - the action, and the
  // note it was going to make, and the thing it had just decided to take on.
  // The character then stood still for a tick having apparently decided
  // nothing. Reading the near-misses is cheaper than losing the turn.
  action: z.preprocess((value) => {
    if ('string' !== typeof value) {
      return value;
    }
    const said = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
    if ((ACTIONS as readonly string[]).includes(said)) {
      return said;
    }
    const meant: Record<string, (typeof ACTIONS)[number]> = {
      look: 'explore',
      look_around: 'explore',
      observe: 'explore',
      examine: 'explore',
      search: 'explore',
      wander: 'explore',
      move: 'walk',
      go: 'walk',
      go_to: 'walk',
      travel: 'walk',
      enter: 'use_door',
      exit: 'use_door',
      leave: 'use_door',
      door: 'use_door',
      // A sign is an NPC that cannot walk, so reading one is talking to it.
      read: 'talk_to',
      talk: 'talk_to',
      speak: 'say',
      speak_to: 'talk_to',
      ask: 'talk_to',
      answer: 'answer_npc',
      reply: 'say',
      fight: 'attack',
      hit: 'attack',
      duel: 'duel_queue',
      challenge: 'duel_queue',
      queue: 'duel_queue',
      cast: 'use_skill',
      // "use" stays a skill because that is what it has always meant to these
      // characters and to every prompt they have been written against. The
      // things a person does to a potion get their own readings below.
      use: 'use_skill',
      skill: 'use_skill',
      drink: 'use_item',
      eat: 'use_item',
      consume: 'use_item',
      apply: 'use_item',
      take: 'pick_up',
      grab: 'pick_up',
      pick: 'pick_up',
      collect: 'pick_up',
      loot: 'pick_up',
      purchase: 'buy',
      shop: 'buy',
      trade: 'buy',
      barter: 'buy',
      vend: 'sell',
      hawk: 'sell',
      stuck: 'give_up_and_walk_back',
      unstick: 'give_up_and_walk_back',
      give_up: 'give_up_and_walk_back',
      idle: 'wait',
      stay: 'wait',
      nothing: 'wait',
      rest: 'wait'
    };
    return meant[said] ?? value;
  }, z.enum(ACTIONS)),
  place: z.string().optional(),
  target: z.string().optional(),
  skill: z.string().optional(),
  item: z.string().optional(),
  // Coerced rather than strict: a model asked how many writes "2" about as
  // often as 2, and losing the whole intent over the quotes would cost a tick.
  // Anything that is not a number at all falls back to one in the actions.
  quantity: z.coerce.number().int().min(1).max(99).optional().catch(undefined),
  message: z.string().optional(),
  option: z.string().optional(),
  // Lenient on purpose. A model asked where a step stands will answer "doing",
  // "in progress", "ongoing" - all of which mean "same" - and a strict enum
  // threw the entire intent away over one word, costing the character a whole
  // tick of standing still for a reply that was otherwise perfectly good.
  progress: z
    .preprocess((value) => {
      if ('string' !== typeof value) {
        return value;
      }
      const said = value.trim().toLowerCase();
      if (['done', 'finished', 'complete', 'completed'].includes(said)) {
        return 'done';
      }
      if (['blocked', 'stuck', 'impossible', 'failed'].includes(said)) {
        return 'blocked';
      }
      return 'same';
    }, z.enum(['same', 'done', 'blocked']))
    .optional(),
  noted: z.string().optional(),
  notThere: z.string().optional(),
  remember: z.string().optional(),
  todo: z.string().optional(),
  askedBy: z.string().optional(),
  finished: z.string().optional(),
  gaveUpOn: z.string().optional(),
  /** Somebody or somewhere to bring to mind; answered into the next brief. */
  recall: z.string().optional(),
  /** What it has found out about something already on its list. */
  progressOn: z.string().optional(),
  learned: z.string().optional(),
  aim: z.string().optional(),
  done: z.string().optional(),
  why: z.string().optional(),
  // Closed, unlike progress: a feeling is not worth guessing a meaning for.
  // Anything outside the known set is dropped rather than failing the whole
  // intent, same reasoning as bookkeepingOf() in behavior.ts - losing the
  // decoration is a shrug, losing the action over it would not be.
  feeling: z.preprocess((value) => {
    if ('string' !== typeof value) {
      return undefined;
    }
    const said = value.trim().toLowerCase();
    return (FEELINGS as readonly string[]).includes(said) ? said : undefined;
  }, z.enum(FEELINGS).optional())
});

/**
 * Chat is a voice, not a novel. The RP model writes fiction - dialogue
 * tags, stage directions, scene-setting, third-person royals - and the
 * fallback once voiced `"Count on me, SaneJack," says Sir Qwen,
 * straightening his gauntlet.` into a public room. A tagged quote is
 * salvaged by voicing only the words inside the quotes; everything else
 * that reads as narration is held (null). Twin guard lives in
 * agentic.ts - change both or neither.
 */
/** Expand one run-length-encoded grid row: "12#3.#" -> "############...#". */
export function expandRle(row: string): string {
  let out = '';
  let count = '';
  for (const ch of row) {
    if (ch >= '0' && ch <= '9') {
      count += ch;
      continue;
    }
    out += ch.repeat(count ? Number(count) : 1);
    count = '';
  }
  return out;
}

/**
 * How far along a computed route to aim in one beat, in tiles. Six is about
 * the 400px stride the seam walk already takes, and short enough that the
 * world's own straight walk to the waypoint does not meet the wall we are
 * getting round.
 */
const ROUTE_LOOKAHEAD_TILES = 6;

export type WalkGrid = { rows: string[]; w?: number; h?: number };
export type Tile = { x: number; y: number };

/**
 * The shortest way through the room's own collision grid, or the nearest a
 * body can get to it.
 *
 * WHY THIS EXISTS, and it is a whole afternoon's worth of not doing it. The
 * seam walk steered by geometry - clamp the vector to the seam, walk 400px
 * at it - and failed four separate ways on 2026-09-02, each measured live:
 *
 *   straight only          "no progress in 12 beats, the road does not go through"
 *   sidestep, alternating  tile(28,39)/(28,45)/(28,39) - paced on the spot
 *   sidestep, held 4 beats tile 28 -> 54, then 137 tiles -> 166 - overshot
 *   sidestep, blended      159 tiles -> 167, 11 beats without progress
 *
 * Four heuristics standing in for a fact the harness already had:
 * `arena_walkable_grid` hands back the WHOLE scene, cached per room, and
 * `escapeWall`'s note records flood-filling it to "a single connected region
 * of 13,547 tiles". The map was in memory the entire time.
 *
 * BREADTH-FIRST, not A*: the grid is at most 192x176 = 33,792 tiles, a plain
 * queue clears that in well under the beat it would otherwise waste, and BFS
 * cannot be talked into a wrong answer by a bad heuristic - which, given the
 * four above, is the property worth having.
 *
 * A GOAL INSIDE A WALL STILL ANSWERS. Callers aim at clamped intermediate
 * points that may be solid, and returning null there would put the body back
 * to standing still - the exact bug this replaces. So the closest reached
 * tile wins instead, and the walk continues next beat from wherever that put
 * it.
 *
 * Standability matches `standable()` deliberately: '.' is floor and 'D' is a
 * door. The two must not drift, or a route ends on a tile the walk refuses.
 */
/**
 * Is the straight line between two tiles clear of walls and refusals?
 *
 * The world's own walk is a straight line, so this is the question that
 * decides whether a distant waypoint is reachable in one step. It exists
 * because a 4-connected route to anywhere diagonal is a STAIRCASE - right,
 * down, right, down - whose longest straight run is one tile. Taking only
 * that run walked a body one tile a beat (measured 2026-09-02: 199 tiles to
 * go, single-tile beats). The staircase is an artefact of the search, not of
 * the room; the line through it is usually wide open.
 *
 * Bresenham, and it checks EVERY tile it crosses including the destination.
 */
export function clearLine(
  grid: WalkGrid, from: Tile, to: Tile, shut?: ReadonlySet<string>
): boolean {
  const rows = grid?.rows;
  if (!Array.isArray(rows) || !rows.length) {
    return false;
  }
  const open = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || y >= rows.length) {
      return false;
    }
    if (shut?.has(`${x},${y}`)) {
      return false;
    }
    const row = rows[y];
    return x < row.length && ('.' === row[x] || 'D' === row[x]);
  };
  let x = from.x;
  let y = from.y;
  const stepX = from.x < to.x ? 1 : -1;
  const stepY = from.y < to.y ? 1 : -1;
  let dx = Math.abs(to.x - from.x);
  let dy = -Math.abs(to.y - from.y);
  let err = dx + dy;
  for (;;) {
    if (!open(x, y)) {
      return false;
    }
    if (x === to.x && y === to.y) {
      return true;
    }
    const twice = 2 * err;
    if (twice >= dy) {
      err += dy;
      x += stepX;
    }
    if (twice <= dx) {
      err += dx;
      y += stepY;
    }
  }
}

export function routeThrough(
  grid: WalkGrid, from: Tile, to: Tile, shut?: ReadonlySet<string>
): Tile[] | null {
  const rows = grid?.rows;
  if (!Array.isArray(rows) || !rows.length) {
    return null;
  }
  const height = rows.length;
  const open = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || y >= height) {
      return false;
    }
    // BELIEVE THE BODY OVER THE MAP. `shut` holds tiles the world has refused
    // to walk to in practice - the reachability lie this harness documents
    // against PRs #505/#539/#545, where a route exists on every map anyone
    // can read and `arena_move_to` still moves nothing. Measured 2026-09-02:
    // Sir Qwen reached tile (41,24) and could not leave it, with a clear
    // six-tile road east on the grid. A router that keeps offering a step the
    // world has already refused is a router that never arrives.
    if (shut?.has(`${x},${y}`)) {
      return false;
    }
    const row = rows[y];
    return x < row.length && ('.' === row[x] || 'D' === row[x]);
  };
  if (from.x === to.x && from.y === to.y) {
    return [];
  }
  if (!open(from.x, from.y)) {
    // A body off the graph is `escapeWall`'s problem, not this one, and it
    // already refuses to guess. Saying so beats inventing a route from a
    // tile the pathfinder cannot see.
    return null;
  }
  const width = Math.max(...rows.map((row) => row.length));
  const seen = new Uint8Array(width * height);
  const cameFrom = new Int32Array(width * height).fill(-1);
  const at = (x: number, y: number): number => y * width + x;
  const queue: number[] = [at(from.x, from.y)];
  seen[queue[0]] = 1;
  let best = queue[0];
  let bestGap = Math.abs(from.x - to.x) + Math.abs(from.y - to.y);
  let head = 0;
  while (head < queue.length) {
    const node = queue[head];
    head += 1;
    const x = node % width;
    const y = (node - x) / width;
    const gap = Math.abs(x - to.x) + Math.abs(y - to.y);
    if (gap < bestGap) {
      bestGap = gap;
      best = node;
    }
    if (x === to.x && y === to.y) {
      best = node;
      break;
    }
    // Four-way only. A diagonal that clips a wall corner is a step the world
    // refuses, and a route whose steps are refused is not a route.
    const around: Tile[] = [
      { x: x + 1, y }, { x: x - 1, y }, { x, y: y + 1 }, { x, y: y - 1 }
    ];
    for (const next of around) {
      if (!open(next.x, next.y)) {
        continue;
      }
      const id = at(next.x, next.y);
      if (seen[id]) {
        continue;
      }
      seen[id] = 1;
      cameFrom[id] = node;
      queue.push(id);
    }
  }
  const path: Tile[] = [];
  for (let node = best; -1 !== node; node = cameFrom[node]) {
    const x = node % width;
    path.push({ x, y: (node - x) / width });
    if (node === at(from.x, from.y)) {
      break;
    }
  }
  path.reverse();
  // Drop the tile already stood on: a route is where to go next.
  return path.slice(1);
}

export function unstaged(line: string): string | null {
  const tagged =
    /["“]([^"”]{12,200})["”]\s*,?\s*(?:says?|said|repl(?:y|ies|ied)|ask(?:s|ed)?|mutter(?:s|ed)?)/i.exec(line)
    ?? /(?:says?|said|repl(?:y|ies|ied)|ask(?:s|ed)?|mutter(?:s|ed)?)[^"“]{0,40}["“]([^"”]{12,200})["”]/i.exec(line);
  if (tagged) {
    return (tagged[1] ?? '').trim() || null;
  }
  if (/^\s*["']?(sir qwen|lord gemma)\b\s*(is|was|stands?|walks?|strides?|rides?|says?|sits?|holds?|takes?|returns?|surveys?|straightens?|nods?|smiles?|raises?|draws?|turns?|casts?|swings?|moves?|arrives?|rests?|fights?)\b/i.test(line)) {
    return null;
  }
  if (/^\s*\*|^\s*(straightening|adjusting|nodding|smiling|turning|gazing|striding|kneeling)\b/i.test(line)) {
    return null;
  }
  if (/^\s*(in|as|with|beneath|under|amid|by)\s+the\b[^.!?]{0,80}\b(hour|light|dusk|dawn|silence|quiet|wind|sun|evening|morning)\b/i.test(line)) {
    return null;
  }
  // A REASONING MODEL'S NOTEBOOK IS NOT DIALOGUE (Gemma 4, 2026-08-15).
  // With its thinking budget cut it stops hiding the deliberation and
  // just prints it: "* Persona: ... * Constraint: ... * Angle 1:".
  // Voicing that in the town square is the worst line a knight ever
  // said. Anything shaped like planning notes is refused outright.
  if (/\b(persona|situation|constraint|requirement|angle \d|the joke is|deadpan|punchline|user (wants|asks))\s*:/i.test(line)) {
    return null;
  }
  if (/^\s*[-*\u2022]\s|\n\s*[-*\u2022]\s/.test(line)) {
    return null;
  }
  return line;
}

const ARRIVAL_PIXELS = 40;
const WALK_POLL_MS = 1500;
const STILL_POLLS = 3;
const LEG_TIMEOUT_MS = 45_000;
/**
 * Whether a name is really a heading. The same eight the room description
 * uses (see explore.ts's WAYS), plus the spellings a model reaches for when
 * it is not copying them back exactly.
 */
const BEARINGS = new Set([
  'north', 'south', 'east', 'west',
  'north-east', 'north-west', 'south-east', 'south-west',
  'northeast', 'northwest', 'southeast', 'southwest',
  'up', 'down', 'left', 'right', 'back', 'onwards', 'ahead'
]);

function isBearing(name: string): boolean {
  return BEARINGS.has(name.trim().toLowerCase().replace(/^(the|to the|towards?)\s+/, ''));
}

/**
 * What the gateway says came of walking into a door. `entered` is the only
 * field always present; `reason` and `message` come back together when it did
 * not open, and `reason` is what tells a retry-worth-having (DOOR_TOO_FAR,
 * the door is fine and simply far off) from one that is not.
 */
type DoorAttempt = {
  entered: boolean;
  scene?: string;
  reason?: string;
  message?: string;
};

/**
 * Tiles beside a given one, nearest and truest "beside" first. Standing on
 * top of somebody is not standing next to them, and `talk_to` has its own
 * range check on top of that - see walkToSomebody() - so a spot has to be
 * picked, not just the target's own tile.
 */
/**
 * How far a character will walk to pick a fight, in tiles of the room it is
 * standing in.
 *
 * SIX, not twelve, and the change is a unit correction rather than a policy
 * one. Every leash in this file was tuned when a tile was 32 pixels
 * everywhere, so "12 tiles" meant 384 pixels of ground. The valley and the
 * stair are 64px maps (see tilePxFor), and once distances were being measured
 * correctly the same 12 quietly became twice the reach it had always been.
 *
 * That is not a harmless generosity in a maze. Sir Qwen held marks at 13, 18,
 * even 19.8 tiles on Miller's Stair, and neither his own walk nor the
 * server's chase ever arrived - the enemy was reachable, just far enough away
 * through enough corridors that something else always interrupted first. At
 * the old effective range he had been killing steadily.
 */
const LEASH_TILES = 6;

/**
 * How long a chase-gap baseline stays comparable, spanning a handful of the
 * round's beats. A baseline older than this belongs to a different fight,
 * and measuring a fresh refusal against it would compare two unrelated
 * gaps. The number is a leash on staleness, not a fact about the world - it
 * only needs to outlive the pause between one refusal and the next.
 */
const CHASE_BASELINE_FRESH_MS = 30_000;

const ADJACENT_TILES: Array<[number, number]> = [
  [0, 1],
  [0, -1],
  [1, 0],
  [-1, 0],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1]
];
/** Let a body finish sliding before anything reads its position. */
const SETTLE_MS = 600;
/** Reldens clips chat at 100 characters (config chat/messages/characterLimit). */
export const CHAT_LINE_LIMIT = 138; // the gateway's arena_say schema caps at 140 (z.string().max(140)) - 100 was fragmenting whole sentences mid-thought
/**
 * How much anyone may say at a stretch. A character's own wordiness sets what
 * it usually says; this is the ceiling none of them may pass, because a wall of
 * text arrives as a stack of chat bubbles nobody reads.
 */
export const MAX_WORDS = 120;
export const DEFAULT_WORDS = 35;
/** Long enough to read as one person talking, short enough not to be a speech. */
const MAX_LINES = 6;
const BETWEEN_LINES_MS = 1400;

export type ActionResult = { ok: boolean; note: string };

/**
 * Whether the character has lost its body, as opposed to merely failed at
 * something. Only this is worth throwing away a session and a plan over.
 */
export function isDisconnected(error: unknown): boolean {
  const said = String((error as Error)?.message ?? error);
  return said.includes('AGENT_NOT_CONNECTED')
    || said.includes('NOT_CONNECTED')
    || said.includes('MCP session');
}

/** What went wrong, said the way a person would notice it rather than as a code. */
export function whatWentWrong(error: unknown): string {
  const said = String((error as Error)?.message ?? error);
  const lower = said.toLowerCase();
  // A request that never got an answer, whichever plumbing failed to deliver
  // one: the gateway's own RELDENS_TIMEOUT, the transport aborting the call
  // once REQUEST_TIMEOUT_MS ran out (arena.ts's AbortSignal.timeout(), which
  // surfaces as "The operation was aborted due to timeout" - Guy hit this
  // three times in six minutes in the volcano with the raw text showing
  // through), or the stream closing with nothing in it. All three read the
  // same to a character standing there waiting, so they get the same words
  // back instead of whichever one happened to fail today.
  if (
    said.includes('RELDENS_TIMEOUT')
    || lower.includes('timed out')
    || lower.includes('aborted due to timeout')
    || lower.includes('mcp endpoint')
  ) {
    return 'waited, and nothing came of it';
  }
  if (said.includes('NO_DOORS_HERE')) {
    return 'there is no way out of here that it can see';
  }
  if (said.includes('too far') || said.includes('INTERACTION')) {
    return 'is not close enough for that';
  }
  // Everything else, trimmed of the transport noise in front of it.
  const plain = said.replace(/^[a-z_]+:\s*/i, '').replace(/^[A-Z_]+:\s*/, '');
  return plain.slice(0, 120) || 'did not work';
}

/**
 * How much further than the basic swing an art must reach before a body will
 * stand off and cast it instead of closing. Three tenths of a tile is a step,
 * not a range - see worthCasting().
 */
const MIN_REACH_GAIN_TILES = 2;
/** Casts the pool must cover before a body commits to fighting at range. */
const CASTS_BEFORE_STANDING_OFF = 4;

/**
 * A DIALOGUE OPTION AS TEXT, WHATEVER SHAPE IT ARRIVED IN.
 *
 * Measured live 2026-08-31, Lord Gemma at 56/646 with no heal: every ask at
 * the shrine came back `value.trim is not a function`, twelve times across
 * two trips, and the errand ledger then shut shrine trips off for the whole
 * run. `matchOption` is typed `Record<string, string>` and calls `.trim()` on
 * the value; the gateway sent something that is not a string, and the type
 * annotation asserted otherwise without ever checking.
 *
 * The coercion belongs HERE, at the one place a reply enters this file,
 * rather than at the five call sites downstream that each assume a string.
 * Two of those - the `offered.join(', ')` in the talk note and `String(label)`
 * in takeBlessing - would not have thrown at all; they would have quietly
 * shown the model "[object Object]" and sent it back as an answer.
 *
 * The shape is not guessed at: an object is searched for the fields a label
 * plausibly lives in, and anything still unresolved is logged ONCE with its
 * real JSON so the next run knows what the world actually sends instead of
 * inferring it from a stack trace.
 */
const OPTION_TEXT_FIELDS = ['label', 'text', 'title', 'name', 'value', 'description'] as const;
let unknownOptionLogged = false;

export function optionText(value: unknown): string | null {
  if ('string' === typeof value) {
    return value;
  }
  if ('number' === typeof value || 'boolean' === typeof value) {
    return String(value);
  }
  if (value && 'object' === typeof value) {
    const row = value as Record<string, unknown>;
    for (const field of OPTION_TEXT_FIELDS) {
      if ('string' === typeof row[field] && (row[field] as string).length) {
        return row[field] as string;
      }
    }
    if (!unknownOptionLogged) {
      unknownOptionLogged = true;
      let shown = '(unserialisable)';
      try {
        shown = JSON.stringify(value).slice(0, 300);
      } catch {
        // A cycle is still worth knowing about; the key list alone says a lot.
        shown = Object.keys(row).join(',');
      }
      console.log(`[dialogue] an option arrived in a shape this harness does not read: ${shown}`);
    }
  }
  return null;
}

/** Every option the NPC offered, as text, with the ones we cannot read dropped. */
export function readableOptions(options: unknown): Record<string, string> {
  if (!options || 'object' !== typeof options) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(options as Record<string, unknown>)) {
    const text = optionText(value);
    if (null !== text) {
      out[key] = text;
    }
  }
  return out;
}


/**
 * WHAT A COUNTER COSTS, IN THE UNITS A PERSON READS.
 *
 * Two separate bugs meet in one line, and both are about trusting the
 * gateway to have done the formatting for us.
 *
 * THE UNITS. Every `quantity` a counter sends is COPPER, and our own gear
 * ladders are written in coins (COINS_TO_COPPER, reflex.ts). `listOffers`
 * dodged that by preferring the gateway's `display` string; `tradeResult`
 * never did, so a sale that paid 190 coins has been reporting "for 19000
 * coins" in every note it wrote. That is the same 100x error the ladders
 * were fixed for on 2026-08-16, still live in the sentence the model reads
 * back after a trade.
 *
 * THE SHAPE. `display` is not ours to rely on. On the merged server
 * (c90f9e9a, not yet deployed) `describeAmount` is gone and the raw wire
 * object goes out instead: `quantity` becomes `requiredQuantity` on a price
 * and `rewardQuantity` on a payout, and `display` does not exist at all. The
 * old fallback would then read `undefined`, so the day that build ships,
 * every price the model is shown becomes "for undefined undefined" - a
 * silent one, because it is a string and nothing type-checks a template.
 *
 * So: take whichever quantity field arrived, and format it ourselves using
 * the server's own arithmetic (currency.js: 100 copper to the silver, 10,000
 * to the gold). `display` is still preferred when it is there, which keeps
 * today's build byte-identical and makes this change safe to land before the
 * deploy rather than after it.
 */
const COPPER_PER_SILVER = 100;
const COPPER_PER_GOLD = 10_000;

export function formatCopper(copper: number): string {
  if (!Number.isSafeInteger(copper) || copper < 0) {
    return String(copper);
  }
  const gold = Math.floor(copper / COPPER_PER_GOLD);
  const silver = Math.floor((copper % COPPER_PER_GOLD) / COPPER_PER_SILVER);
  const remainder = copper % COPPER_PER_SILVER;
  const parts: string[] = [];
  if (gold > 0) {
    parts.push(`${gold}g`);
  }
  if (silver > 0) {
    parts.push(`${silver}s`);
  }
  if (remainder > 0 || 0 === parts.length) {
    parts.push(`${remainder}c`);
  }
  return parts.join(' ');
}

/** A price or a payout, in either the shape today's build sends or the merged one's. */
export type CounterMoney = {
  itemKey?: string;
  requiredItemKey?: string;
  rewardItemKey?: string;
  quantity?: number;
  requiredQuantity?: number;
  rewardQuantity?: number;
  display?: string;
} | null | undefined;

/** The money as a sentence, or null when the counter named no price at all. */
export function moneyText(money: CounterMoney): string | null {
  if (!money) {
    return null;
  }
  if ('string' === typeof money.display && money.display.length) {
    return money.display;
  }
  const amount = [money.quantity, money.requiredQuantity, money.rewardQuantity]
    .find((value) => 'number' === typeof value && Number.isFinite(value));
  if ('number' !== typeof amount) {
    return null;
  }
  const key = money.itemKey ?? money.requiredItemKey ?? money.rewardItemKey ?? 'coins';
  return 'coins' === key ? formatCopper(amount) : `${amount} ${key}`;
}


/**
 * THE WORLD SENDS ITS CORNERS AS STRINGS (2026-08-27, caught by the log line
 * added to survive them).
 *
 * `pathTurns` was destructured as `[col, row]` for as long as this file has
 * existed. The entries are not arrays. The first one ever captured reads:
 *
 *     "[2]: 14,44"
 *
 * Destructure that and you get `col = '['` and `row = '2'`, so the walk
 * computed `'[' * 64` = NaN and `'2' * 64 + 32` = **160** - which is exactly
 * the `[move] refused a walk to (NaN, 160)` seen six times in one night and
 * mistaken for a world defect. It was a parse, and the constant 160 was the
 * digit 2 all along.
 *
 * The consequence is larger than the refusals: this harness has never once
 * been able to FOLLOW a route corner. Every walk in a room that is 60% wall
 * has been a straight line at the target, with the pathfinder's own answer
 * discarded. Reading the corner properly is what lets a body round a corner.
 *
 * Three shapes accepted, because the wire has already surprised us once: a
 * real `[col, row]` pair, an `{x, y}` / `{column, row}` object, and the
 * string above - from which the LAST two numbers are the tile.
 */
/** How long a node that gave nothing is left alone. */
/**
 * Shorter than the fastest refill in the world (a copper seam is 90s), so a
 * node that merely emptied is available again the moment it is worth taking.
 * Two minutes outlived the refill by thirty seconds.
 */
const NODE_SHUN_MS = 75 * 1000;

function cornerTile(corner: unknown): [number, number] {
  if (Array.isArray(corner) && corner.length >= 2) {
    return [Number(corner[0]), Number(corner[1])];
  }
  if (corner && 'object' === typeof corner) {
    const o = corner as Record<string, unknown>;
    const col = o.column ?? o.col ?? o.x;
    const row = o.row ?? o.y;
    return [Number(col), Number(row)];
  }
  if ('string' === typeof corner) {
    const numbers = corner.match(/-?\d+/g);
    if (numbers && numbers.length >= 2) {
      return [Number(numbers[numbers.length - 2]), Number(numbers[numbers.length - 1])];
    }
  }
  return [NaN, NaN];
}

export class Actions {
  /** What the character can see of the room it is in. Set each tick. */
  private view: RoomView | null = null;
  /** NPCs, traders, and enemies visible right now. Set each tick. */
  private nearby: ArenaObject[] = [];
  /** The scene `nearby` was observed in, or null when the caller could not
   *  say. Written only by notices(); read only by staleSceneNote(). */
  private noticedScene: string | null = null;
  /** Everyone standing in the room, with the ids a player target needs. */
  private people: NonNullable<Observation['players']> = [];
  /** What is in the satchel, as of this tick. */
  private carried: CarriedItem[] = [];
  /** What is lying on the floor here, as of this tick. */
  private loot: SeenDrop[] = [];
  /**
   * The duel this character is actually in, once the coordinator has paired
   * it. Same lifecycle as this.talking: per-run, set by the harness, never by
   * the model. Its presence is the gate that lets attack and use_skill aim at
   * a person, and only at this person: without it a character with the duel
   * capability could hit any bystander it can see by asking to.
   */
  private matched: { matchId: string; opponentName: string; scene: string } | null = null;
  /**
   * When this character last gave up and walked back, so it cannot do it
   * again straight away. Starts at zero rather than "now", because a character
   * that comes up already walled in should not have to serve an hour it never
   * earned.
   */
  private gaveUpAt = 0;
  /** Rooms this character has actually stood in, and how long ago. */
  private visited = new Map<string, string>();
  /**
   * How many times in a row this character has chosen to explore each scene.
   * The count that matters is per scene and it survives leaving, because the
   * thing it guards against - wandering a room that has nothing left to show
   * - is true of the room, not of the visit.
   */
  private roamed = new Map<string, number>();
  /**
   * Where this body stood as of the last observation, in pixels.
   *
   * closeOn() needs it to work out a spot SHORT of a target rather than on
   * top of one, and the observation that feeds notices() already carries it.
   */
  private selfAt: { x: number; y: number } | null = null;
  /**
   * The attack arts the world says are usable right now, strongest first.
   *
   * Read out of the same arena_skills reply ownSheet() already fetches, so
   * this costs no extra call. `available` and `reachTiles` are the server's
   * own words: a skill list is NOT a list of what can be cast (mindSpike
   * sits in Lord Gemma's list at unlockLevel 56 with available:false), and a
   * reach is in pixels until the server converts it for the room he is
   * standing in. Both were being guessed at before.
   */
  private artsLast: Array<{ key: string; reachTiles: number; damage: number; mp: number }> = [];
  /** The dialog box currently open, if any, and what it last offered. */
  private talking: { objectId: number; label: string; options: Record<string, string> | null } | null = null;
  /**
   * What an NPC just told this character, waiting to be written into memory
   * as a first-hand finding. Set by talkTo()/answerNpc(), read and cleared by
   * takeNpcReply(); see noteToldByNpc() in npc.ts.
   */
  private lastReply: { from: string; said: string } | null = null;
  /**
   * The feeling last shown to the gateway, so it is only sent again once it
   * actually changes - see showFeeling(). Carrying the same emoji on every
   * tick would be one more call for nothing every few seconds, forever.
   */
  private lastShownFeeling: Feeling | null = null;

  constructor(
    private readonly arena: ArenaClient,
    private readonly agentId: string,
    private readonly capabilities: Set<Capability>,
    /** How much this character says at a stretch, in words. */
    private readonly wordiness: number = DEFAULT_WORDS,
    private readonly explorer: Explorer = new Explorer(),
    /**
     * The named skills this character's class path grants it. Empty for
     * somebody who only ever swings. See useSkill() for why this is declared
     * rather than discovered: the skills are rows in the world, they differ by
     * class path, and a character asking for one it does not have should hear
     * so rather than watch nothing happen.
     */
    private readonly skills: readonly string[] = [],
    /**
     * The curated arts this character is meant to fight with, as the sheet
     * ordered them - the SAME list npc.ts flattens into the server's
     * `use_skills`.
     *
     * `attack()`'s reach-substitution used to pick from everything the world
     * said was castable, sorted by raw damage, and that reached straight past
     * the sheet's own judgement. Measured 2026-08-25 on Lord Gemma: the
     * battle payload correctly carried the curated
     * ["arcaneRay","attackBullet","boneSpear","drainLife"], while `attack()`
     * was separately casting **manaBurn** - the one spell his sheet excludes
     * by name, at 7.5 mp/s against boneSpear's 5.0. It emptied 646 mana in
     * about twenty minutes, top-down, spending the most expensive option
     * first, and left him dry at 69% hp - under `lifeTap`'s 70% floor, so he
     * could not even convert his way back. His own sheet had already written
     * the warning: "manaBurn at 7.5 mp/s is the one that can empty a 576 pool
     * while lifeTap is locked out below 70% hp."
     *
     * Filtering to the ladder reuses a judgement that was already made and
     * argued rather than inventing a second heuristic on a damage number this
     * file admits is unmeasured. It also degrades correctly for a body with
     * no ladder at all: Sir Qwen's is empty by order, so the filter empties
     * the candidate list, `reachingArt()` answers null, and he swings his
     * greatblade - which is the behaviour that was already wanted and was
     * previously resting on his mana happening to be zero.
     */
    private readonly ladder: readonly string[] = []
  ) {}

  can(capability: Capability): boolean {
    return this.capabilities.has(capability);
  }

  sees(view: RoomView | null): void {
    this.view = view;
    // Also here, not only in observe(): the room view is set before the first
    // observation on some paths, and a beat that converts coordinates with a
    // stale tile size walks to the wrong half of the room.
    if (view?.scene) {
      this.tilePx = tilePxFor(view.scene);
    }
  }

  /**
   * What is standing nearby right now: NPCs, traders, enemies. Set once a
   * tick from the same observation the harness already fetched, so naming
   * somebody to talk to or hit does not cost a second round trip.
   */
  /** Who is standing here this tick, ids included. See the players type. */
  meets(players: Observation['players']): void {
    this.people = players ?? [];
  }

  notices(objects: ArenaObject[] | undefined, scene?: string | null): void {
    this.nearby = objects ?? [];
    // WHICH ROOM THESE WERE SEEN IN (2026-08-27). An observation is correct
    // when taken and stale the moment the world moves the body - measured:
    // observed on the Oathstone arrival tile, killed there (upstream #610),
    // carried to the inn by carryTheFallenHome, and then 25 acts fired
    // against Oathstone's objects from the inn. The gateway's refusal
    // ("Object 256 is not in the current scene, the-valley-inn") names the
    // agent's OWN current scene, not the object's. Wholesale replacement of
    // the list stays as it is - this only records where it came from, so
    // staleSceneNote() below can refuse before the wire does. Unknown means
    // unknown: a caller that cannot say leaves the guard unarmed.
    this.noticedScene = scene ?? null;
  }

  /**
   * A refusal note when the body's current scene no longer matches the room
   * the object list was observed in - or null when acting is fine. Declines
   * to judge when either side is unknown, so nothing gets refused on a
   * guess. See notices() above for the measured failure this stops.
   */
  private staleSceneNote(sceneNow: string | undefined): string | null {
    if (!sceneNow || !this.noticedScene || sceneNow === this.noticedScene) {
      return null;
    }
    return `these objects were seen in ${this.noticedScene}, but the body is now in ${sceneNow} - observe again before acting on them`;
  }

  /** Where this body is, from the observation notices() came out of. */
  standsAt(state: { x?: number; y?: number } | null | undefined): void {
    this.selfAt = state && 'number' === typeof state.x && 'number' === typeof state.y
      ? { x: state.x, y: state.y }
      : null;
  }

  /**
   * The strongest art that reaches `gapTiles` and can be paid for, or null.
   *
   * The basic swing is deliberately excluded: `arena_basic_attack` swings the
   * EQUIPPED WEAPON, and that is not the same as casting the weapon's own
   * skill. Sir Qwen's attackShort is base 5 and lands 252 because his
   * greatblade is doing the work; routing him through arena_use_action would
   * throw the weapon away. So this only ever answers for a gap the swing
   * cannot cover anyway, and a body with no mana (his pool is 0) gets null
   * and keeps swinging exactly as before.
   */
  private reachingArt(gapTiles: number): { key: string; reachTiles: number; damage: number; mp: number } | null {
    // THE SHEET'S ARTS, NOT EVERY ART THE WORLD ALLOWS. See `ladder` above.
    // An empty ladder means "this body does not cast" and must answer null
    // rather than falling back to the whole book.
    if (!this.ladder.length) {
      return null;
    }
    return this.artsLast.find(
      (art) => this.ladder.includes(art.key) && art.reachTiles >= gapTiles && this.worthCasting(art)
    ) ?? null;
  }

  /**
   * Is this art worth standing off to use, rather than closing and swinging?
   *
   * TWO GUARDS, and both exist because "Sir Qwen is untouched" was true only
   * by accident (adversarial review, 2026-08-25). It rested entirely on his
   * pool being 0 - and `drink_ale` (reflex.ts:2412) already fires on manaDry
   * with coins in hand, and he carries thousands. His mana can come back on
   * any rest, at which point nothing here was stopping him.
   *
   * REACH, not damage. This substitution exists to hit what the swing CANNOT.
   * Sir Qwen's thornwhip reaches 1.1 tiles against a swing that reaches 0.8:
   * three tenths of a tile is not a ranged posture, it is a step. For a body
   * like that, closing and swinging is simply right, and his 252 damage comes
   * out of the greatblade through arena_basic_attack - a cast would throw the
   * weapon away. Requiring a real reach gain makes that structural instead of
   * contingent on a mana pool that is one mug from changing.
   *
   * AFFORDABLE FOUR TIMES OVER, not once. Standing off at spell range with
   * one cast in the pool is the worst of both: the cast goes out, the pool
   * empties, and the body is left holding a distance its weapon cannot cross.
   * `manaDry` is mp < 10 and it sends strike() past every cast, so the floor
   * has to be well above one cast's worth.
   */
  /**
   * ONE CAST PER BEAT, and the reason is a stale number.
   *
   * Retaliation (`strikeBack`) and the ordinary swing (`attack`) are now two
   * independent gates that can BOTH fire in the same beat - npc.ts runs the
   * retaliation unconditionally and then calls the round, which can resolve
   * to `attack` regardless of whether retaliation already acted. Both judge
   * affordability against the same `sheetLast.mp` snapshot, which ownSheet()
   * only refreshes every seven seconds, so both can read "affordable" from
   * one reading of a pool that the first cast has already spent. The second
   * comes back NO_MANA - honestly, and it falls through to a swing - but the
   * burn rate is up to twice what every mana figure on Lord Gemma's sheet was
   * tuned against (the 9-casts-in-64-minutes measurement, `tapAboveHpPercent`).
   *
   * Charging the snapshot ourselves is what makes the second gate see the
   * first one's spending. It is deliberately pessimistic: an over-count costs
   * one swing instead of one cast, and an under-count costs a refused call
   * plus a beat of a caster believing he is armed when he is not.
   */
  private spendFromSnapshot(mp: number): void {
    if (this.sheetLast?.mp && mp > 0) {
      this.sheetLast.mp.value = Math.max(0, this.sheetLast.mp.value - mp);
    }
  }

  private worthCasting(art: { key: string; reachTiles: number; mp: number }): boolean {
    if ('attackShort' === art.key) {
      return false;
    }
    // A FREE BOLT IS NEVER THE WRONG TRADE (2026-08-26). The margin below
    // exists to stop a body standing off for an art that is barely longer
    // than the weapon it is giving up. An art that costs NOTHING gives up
    // nothing: there is no pool to protect and no weapon being traded, so
    // the only question left is whether it reaches.
    //
    // Measured on Lord Gemma, dry at 0/660 for hours: 721 of his swings were
    // attackShort at 0.8 tiles, refused, while attackBullet - 0 mana, 3.9
    // tiles - sat unused because 3.9 - 0.8 cleared the margin but the pool
    // could not pay for a margin it was never being asked for. He held level
    // 41 through Sir Qwen going 41 to 44.
    if (art.mp <= 0) {
      return art.reachTiles > this.basicReachTiles();
    }
    if (art.reachTiles - this.basicReachTiles() < MIN_REACH_GAIN_TILES) {
      return false;
    }
    return art.mp * CASTS_BEFORE_STANDING_OFF <= (this.sheetLast?.mp?.value ?? 0);
  }

  /** How far the basic swing reaches, as the world measures it this room. */
  private basicReachTiles(): number {
    return this.artsLast.find((art) => 'attackShort' === art.key)?.reachTiles ?? 0.8;
  }

  /** The longest reach this body could cast right now, for closing short. */
  private longestArtReach(): number {
    if (!this.ladder.length) {
      return 0;
    }
    return this.artsLast.reduce(
      (best, art) => (
        this.ladder.includes(art.key) && this.worthCasting(art) && art.reachTiles > best
          ? art.reachTiles
          : best
      ),
      0
    );
  }

  /**
   * What this character is carrying and what is on the floor around it, from
   * the same observation everything else this tick came from. Handed in
   * rather than fetched so that knowing what is in your own pockets costs
   * nothing: a character that has to make a call to find out will not.
   */
  holds(carrying: CarriedItem[] | undefined, drops: SeenDrop[] | undefined): void {
    // A truncated/salvaged reply never carries `carrying` at all -
    // salvageTruncated() has no recovery path for it, unlike objects/players
    // which it at least partially rebuilds. The old `?? []` here read every
    // truncation as "the pack is empty", which wiped what sellableItems(),
    // carriedBranches() (the bank-run trigger), and ownsGear() (pilgrimage
    // completion) all believe is owned, until a full reply happened to land.
    // undefined now means "unknown this tick", not "empty" - the last real
    // report is kept until a genuine one (even a genuinely empty one) replaces
    // it. Both default to [] already, so the very first tick is unaffected.
    // MEASURED 2026-08-15: for a pack this size (175+ rows, mostly branches),
    // a genuine reply may never land - arena_observe truncated on nearly
    // every one of 1,180 ticks in one 3-hour window, the cut landing mid
    // inventory. This guard stops the wipe but cannot supply data that never
    // arrives; see pullInventoryFallback() below for the actual recovery.
    if (undefined !== carrying) {
      this.carried = carrying;
    }
    if (undefined !== drops) {
      this.loot = drops;
    }
  }

  /**
   * Recover the pack straight from arena_inventory when arena_observe keeps
   * truncating before it reaches `carrying` - a big-enough pack (168+
   * branches, measured 2026-08-15) can push "carrying" past the observe
   * reply's byte cap on nearly every tick, so holds() alone can go the
   * whole session without ever seeing a real value. arena_inventory is a
   * separate call with its own byte budget and was measured fitting whole
   * at 207 items / 42.5KB, comfortably under the cap that sinks observe.
   * Returns true on a real read so the caller can rate-limit calling this.
   */
  /**
   * hp, mp and level, from arena_skills.
   *
   * The public watch feed used to carry all three under `sheet`, and
   * health.ts still reads it there; a world update dropped the field, so
   * every consumer has been reading null since. That silently disabled far
   * more than the "hp ?" in the logs: fieldsFor() gates every field but the
   * first on a level it could no longer see, and the whole mana economy -
   * the Magus's lifeTap, the draught, the rule that a heal cast on an empty
   * pool mends nothing - hangs off mp.
   *
   * arena_skills reads the same sheet server-side through the bridge rather
   * than from the public feed, so it still answers in full. Measured
   * 2026-08-24: hp 351/644, mp 0/202, level 35 "Blade Master" for Sir Qwen.
   *
   * Cached for the feed's own seven seconds, so putting this on every tick
   * costs one call per body per seven seconds rather than one per tick.
   */
  private sheetAt = 0;
  private sheetLast: { hp: { value: number; total: number } | null;
                       mp: { value: number; total: number } | null;
                       level: number | null } | null = null;

  async ownSheet(): Promise<{ hp: { value: number; total: number } | null;
                              mp: { value: number; total: number } | null;
                              level: number | null } | null> {
    if (Date.now() - this.sheetAt < 7_000) {
      return this.sheetLast;
    }
    this.sheetAt = Date.now();
    try {
      const sheet = await this.arena.call('arena_skills', { agent_id: this.agentId });
      const pair = (v: any) =>
        v && 'number' === typeof v.value && 'number' === typeof v.total
          ? { value: v.value, total: v.total }
          : null;
      // A character still loading answers with progress null and no skills;
      // that is not a reading, so keep the last one rather than overwrite a
      // good level with a blank.
      const level = 'number' === typeof sheet?.progress?.level ? sheet.progress.level : null;
      if (null === level && !pair(sheet?.hp)) {
        return this.sheetLast;
      }
      this.sheetLast = { hp: pair(sheet?.hp), mp: pair(sheet?.mp), level };
      // The reaches ride along in the same reply and were being thrown away.
      // Only what the world says is castable NOW: `available` is false for
      // everything above this level, and `reachTiles` is the server's own
      // conversion for the room the body is standing in - which is the whole
      // argument that has been had four times in tiles that were never the
      // same size twice.
      const listed = Array.isArray(sheet?.skills) ? sheet.skills : [];
      const arts = listed
        .filter((art: any) => true === art?.available && 'number' === typeof art?.damage && art.damage > 0)
        .map((art: any) => ({
          key: String(art.key ?? ''),
          reachTiles: 'number' === typeof art.reachTiles
            ? art.reachTiles
            : (Number(art.range) || 0) / this.tilePx,
          damage: Number(art.damage) || 0,
          mp: Number(
            (Array.isArray(art.requirements) ? art.requirements : [])
              .find((need: any) => 'stats/mp' === need?.property)?.value ?? 0
          )
        }))
        .filter((art: { key: string; reachTiles: number }) => art.key && art.reachTiles > 0)
        .sort((a: { damage: number }, b: { damage: number }) => b.damage - a.damage);
      if (arts.length) {
        this.artsLast = arts;
      }
      this.noteProfessions(sheet);
      return this.sheetLast;
    } catch {
      return this.sheetLast;
    }
  }


  /** The last profession standing we printed, so only a CHANGE is logged. */
  private professionsSeen: string | null = null;
  /** So the sheet's own field list is printed once, not every seven seconds. */
  private sheetKeysLogged = false;

  /**
   * THE TRADES WERE IN THE REPLY ALL ALONG, AND WE THREW THEM AWAY.
   *
   * `arena_skills` returns every skill this body has. The filter above keeps
   * only rows with `damage > 0` - the combat arts - because that is what the
   * reach substitution needed. A profession has no damage, so mining, fishing
   * and the rest were fetched every seven seconds and discarded, every beat,
   * for the life of this harness.
   *
   * The cost of that was not the call. It was that when Glenn asked whether
   * the trades were gaining anything, the honest answer was "we cannot tell" -
   * we had the server's own number in hand and dropped it before anything
   * could read it. `arena_gather` reports `experience` per charge, which is
   * the world saying what it GRANTED; only the sheet says what STUCK. Those
   * are different claims and one does not evidence the other.
   *
   * Logged on change rather than every read, because a level that has not
   * moved is not news and this runs every seven seconds.
   */
  private noteProfessions(sheet: unknown): void {
    const row = (sheet ?? {}) as Record<string, unknown>;
    // arena_skills says outright that it "returns class progress, class skills,
    // AND PROFESSION LEVELS" (mcp-server.js:3028), so they are somewhere in this
    // reply. They are NOT in `skills` - that list is the combat arts, which is
    // why the first version of this printed nothing at all. Rather than guess
    // the field name a second time, say what actually arrived, once, and then
    // read whichever likely field is populated.
    if (!this.sheetKeysLogged) {
      this.sheetKeysLogged = true;
      console.log(`[trades] arena_skills carries: ${Object.keys(row).join(', ')}`);
    }
    const candidates = ['professions', 'trades', 'professionLevels', 'professionSkills', 'skills'];
    let listed: unknown[] = [];
    for (const field of candidates) {
      const value = row[field];
      if (Array.isArray(value) && value.length) {
        listed = value;
        break;
      }
      if (value && 'object' === typeof value) {
        listed = Object.entries(value as Record<string, unknown>)
          .map(([key, v]) => ('object' === typeof v && v ? { key, ...(v as object) } : { key, level: v }));
        break;
      }
    }
    const trades = (Array.isArray(listed) ? listed : [])
      .map((row) => row as Record<string, unknown>)
      .filter((row) => row && !(Number(row.damage) > 0))
      .map((row) => {
        const key = String(row.key ?? row.skillKey ?? '');
        const level = row.level ?? row.skillLevel ?? null;
        const xp = row.experience ?? row.xp ?? null;
        return { key, level, xp };
      })
      .filter((row) => row.key && (null !== row.level || null !== row.xp));
    if (!trades.length) {
      return;
    }
    const said = trades
      .map((row) => `${row.key} L${row.level ?? '?'}${null !== row.xp ? ` (${row.xp}xp)` : ''}`)
      .join(', ');
    if (said !== this.professionsSeen) {
      console.log(`[trades] ${said}`);
      this.professionsSeen = said;
    }
  }

  async pullInventoryFallback(): Promise<boolean> {
    try {
      const bag = await this.arena.call('arena_inventory', { agent_id: this.agentId });
      const items = bag?.items;
      if (!Array.isArray(items)) {
        // SAY SO. This returning false in silence is why the purse looked
        // frozen: the caller rate-limits on the attempt, not the success,
        // so a run of quiet failures reads exactly like a run of unchanged
        // coin counts. Two reads landed out of roughly thirty attempts in
        // one measured window and nothing anywhere said why (2026-08-16).
        console.log(`[inventory] fallback read gave no items (${bag?.truncated ? 'truncated' : typeof items}) - purse and pack stay stale this tick`);
        return false;
      }
      this.carried = items.map((it: Record<string, unknown>) => ({
        key: String(it.key ?? ''),
        label: String(it.label ?? it.key ?? ''),
        description: 'string' === typeof it.description ? it.description : null,
        quantity: 'number' === typeof it.quantity ? it.quantity : 1,
        usable: true === it.usable,
        equipment: true === it.equipment,
        equipped: true === it.equipped
      }));
      return true;
    } catch (error) {
      // A failed fallback call is not worth crashing a tick over - holds()
      // already preserved whatever was last known, real or empty - but it
      // IS worth saying, for the same reason as above.
      console.log(`[inventory] fallback read failed: ${whatWentWrong(error)}`);
      return false;
    }
  }

  /** What it is carrying, said in one line. Empty when it has nothing. */
  carryingLine(): string {
    if (0 === this.carried.length) {
      return '';
    }
    const said = this.carried.map((item) => {
      const many = 1 < item.quantity ? ` x${item.quantity}` : '';
      return `${item.label}${many}${item.equipped ? ' (worn)' : ''}`;
    });
    return `You are carrying: ${said.join(', ')}.`;
  }

  /** The merchant standing here, if one is. */
  private merchantHere(): ArenaObject | null {
    return this.nearby.find((object) => object.isMerchant && object.objectId != null) ?? null;
  }

  /**
   * What could be offered to a merchant: everything carried that is not
   * currently being worn. Whether the merchant actually wants any of it is
   * the merchant's to say - the harness has no price list and should never
   * pretend to one.
   */
  private sellable(): CarriedItem[] {
    return this.carried.filter((item) => !item.equipped);
  }

  /** Match a name against something carried, the way a person refers to it. */
  private carriedNamed(name: string): CarriedItem | null {
    const wanted = name.trim().toLowerCase();
    if (!wanted) {
      return null;
    }
    return (
      this.carried.find((item) => item.key.toLowerCase() === wanted)
      ?? this.carried.find((item) => item.label.toLowerCase() === wanted)
      ?? this.carried.find((item) => item.label.toLowerCase().includes(wanted))
      ?? this.carried.find((item) => wanted.includes(item.label.toLowerCase()))
      ?? null
    );
  }

  /** The doorways out of here, as the character can see them. */
  doors(): SeenDoor[] {
    return this.view?.doors ?? [];
  }

  /** Match a name against what is nearby, the way a person would refer to it. */
  /**
   * Is this `kind: 'npc'` row actually a resource node rather than a person?
   *
   * The world has exactly two kinds, 'npc' and 'enemy', so an iron seam and a
   * gate warden arrive identically labelled. That was harmless while nothing
   * gathered; now that a node is a thing we work, it must not also appear in
   * the list of people a character can strike up a conversation with. Nobody
   * wants to watch the crown attempt small talk with a rock.
   */
  private static readonly NODE_WORDS = new Set([
    'ore', 'seam', 'vein', 'node', 'bush', 'thicket', 'shoal', 'outcrop'
  ]);

  /**
   * TWO WORD LISTS THAT HAD TO AGREE, AND DID NOT (2026-08-27).
   *
   * `isResourceNode` screened for ore, seam, vein, bush, thicket, shoal,
   * outcrop - written when mining was the only trade anyone had. `gatherNearby`
   * runs it FIRST and only then asks `skillForNode` which trade owns the node,
   * so every foraging node in the world was rejected before the trade check
   * was ever reached.
   *
   * Measured, standing on the ground itself: Sir Qwen crossed to the Oathstone
   * and the world told him plainly what was there -
   *
   *   objects 4: pot garlic@(14,18) - hot pepper@(9,18)
   *              plant fibre@(4,17) - wild carrot@(4,18)
   *
   * - all within twenty-three tiles of him, and he reported "nothing of ours
   * to gather" and went home. Not one of those four words was on the list.
   *
   * One source of truth now: a node is anything a trade claims, plus the
   * generic terms above. The two lists cannot drift apart because there is
   * only one question being asked.
   */
  private isResourceNode(object: ArenaObject): boolean {
    const label = String(object.label ?? '');
    if (null !== this.skillForNode(label)) {
      return true;
    }
    const words = label.toLowerCase().split(/[^a-z]+/);
    return words.some((w) => Actions.NODE_WORDS.has(w));
  }

  private findNearby(name: string, kind: ArenaObject['kind']): ArenaObject | null {
    const wanted = name.trim().toLowerCase();
    if (!wanted) {
      return null;
    }
    // The gateway now marks corpses (alive: false) instead of removing them
    // - swinging at one returns "ok" and does nothing, so the dead never
    // count as candidates for anything.
    const candidates = this.nearby.filter(
      (object) => object.kind === kind && ('enemy' !== kind || false !== object.alive)
    );
    return (
      candidates.find((object) => object.label.trim().toLowerCase() === wanted)
      ?? candidates.find((object) => object.label.toLowerCase().includes(wanted))
      ?? candidates.find((object) => wanted.includes(object.label.trim().toLowerCase()))
      ?? null
    );
  }

  /** The list of actions to offer a character, given where it is standing. */
  describe(scene: string): string {
    const lines: string[] = [];
    if (this.can('speak')) {
      lines.push('- "say": say something out loud. Needs: message');
    }
    if (this.can('walk')) {
      const names = Object.keys(placesIn(scene));
      if (names.length > 0) {
        lines.push(`- "walk": go somewhere in this room. Needs: place, one of ${names
          .map((name) => `"${name}"`)
          .join(', ')}`);
      }
      // Anywhere that is not home is found out by walking around it. This is
      // the only way to see a room nobody has written down.
      lines.push('- "explore": wander to a part of this room you have not seen');
    }
    if (this.can('doors')) {
      const doors = this.doors();
      if (doors.length === 1) {
        lines.push(`- "use_door": go through to ${this.doorWithHistory(doors[0])}`);
      } else if (doors.length > 1) {
        lines.push(
          '- "use_door": go through a door. Needs: place, one of '
            + doors.map((door) => this.doorWithHistory(door)).join(', ')
        );
        // Only the doors are places you can walk through. Said here because a
        // character that wants somewhere in the next room keeps naming that
        // place as a door: Guy asked for "the east gate" six times running from
        // inside a house, and the east gate is a spot in town, two steps past a
        // door he could see the whole time. He was told each time that no such
        // door existed, which is true and no help at all.
        lines.push('  (a door goes to a whole room. To reach a spot inside one, go through, then walk.)');
      }
    }
    if (this.can('talk_to_folk')) {
      if (this.talking) {
        const offered = this.talking.options ? Object.values(this.talking.options) : [];
        lines.push(
          offered.length > 0
            ? `- "answer_npc": answer ${this.talking.label}. Needs: option, one of `
              + offered.map((choice) => `"${choice}"`).join(', ')
            : `- "talk_to": speak to ${this.talking.label} again, or somebody else. Needs: target`
        );
      } else {
        const names = this.nearby
          .filter((object) => object.kind === 'npc' && !this.isResourceNode(object))
          .map((object) => object.label);
        if (names.length > 0) {
          lines.push(
            `- "talk_to": start a conversation. Needs: target, one of ${names
              .map((name) => `"${name}"`)
              .join(', ')}`
          );
        }
      }
    }
    if (this.can('fight')) {
      const names = this.nearby
        .filter((object) => object.kind === 'enemy' && false !== object.alive)
        .map((object) => object.label);
      if (names.length > 0) {
        lines.push(
          `- "attack": attack something here. Needs: target, one of ${names
            .map((name) => `"${name}"`)
            .join(', ')}`
        );
        // Only offered with something to aim at, same as attack. A character
        // told it can cast fireball in an empty room will try, and be told no
        // by the only part of this that can see there is nobody there.
        if (this.skills.length > 0) {
          lines.push(
            `- "use_skill": use one of your own skills on something. Needs: skill, one of ${this.skills
              .map((skill) => `"${skill}"`)
              .join(', ')}; and target`
          );
        }
      }
    }
    if (this.can('duel') && this.can('fight')) {
      lines.push(
        this.matched
          ? `- you are in a duel with ${this.matched.opponentName}. Attack them by name when they are here.`
          : '- "duel_queue": stand for a duel here, against whoever answers. Needs nothing;'
            + ' name a target if you have somebody in mind.'
      );
    }
    // Anybody can drink what they are carrying; it is not a trade and it is
    // not a fight. Only offered when there is actually something to drink,
    // the same rule attack follows: an action with nothing to point it at is
    // an invitation to waste a turn.
    const usable = this.carried.filter((item) => item.usable);
    if (0 < usable.length) {
      lines.push(
        `- "use_item": use something you are carrying. Needs: item, one of ${usable
          .map((item) => `"${item.label}"`)
          .join(', ')}`
      );
    }
    if (0 < this.loot.length) {
      const named = this.loot.filter((drop) => drop.itemKey).map((drop) => drop.itemKey as string);
      lines.push(
        0 < named.length
          ? `- "pick_up": pick up what has been dropped here: ${named.join(', ')}. Needs nothing for the nearest.`
          : '- "pick_up": pick up what has been dropped here. Needs nothing for the nearest.'
      );
    }
    if (this.can('trade')) {
      const merchant = this.merchantHere();
      if (merchant) {
        lines.push(
          `- "buy": buy from ${merchant.label}. Needs: item, and quantity if more than one.`
            + ' Leave out the item to ask what is for sale.'
        );
        const offerable = this.sellable();
        lines.push(
          0 < offerable.length
            ? `- "sell": sell to ${merchant.label}. Needs: item, one of ${offerable
                .map((item) => `"${item.label}"`)
                .join(', ')}`
            : `- "sell": you have nothing loose to sell ${merchant.label}.`
        );
      }
    }
    if (this.can('money')) {
      lines.push('- "check_money": count your arena credits, which are not the coins in your purse.');
    }
    if (this.can('purpose')) {
      lines.push(
        '- "set_goal": decide what you are after from now on. Needs: aim, done, why.'
          + ' Only when what you wanted is finished or plainly hopeless.'
      );
    }
    // Deliberately last, after everything that involves actually walking, and
    // worded so it reads as the admission it is. A character offered this next
    // to "walk" will use it as a shortcut home.
    if (this.can('doors')) {
      lines.push(
        '- "give_up_and_walk_back": only if you have genuinely tried and cannot get out of'
          + ' where you are. You end up back at the inn and cannot do it again for an hour.'
      );
    }
    lines.push('- "wait": stay where you are');
    return lines.join('\n');
  }


  /**
   * A door, and whether this character has already been through it.
   *
   * Without this a door is just a name, and every unexplored room and every
   * room somebody has walked in and out of nine times read exactly alike. A
   * character deciding where to go next had nothing to go on and so kept
   * picking the nearest one, which is how a loop between two rooms starts and
   * why it never stops.
   *
   * The knowledge is the harness's own record of where this character has
   * actually stood, not anything the model wrote down, so it cannot talk itself
   * into having explored somewhere it has not.
   */
  private doorWithHistory(door: SeenDoor): string {
    const name = this.doorLabel(door);
    const been = door.leadsTo ? this.visited.get(door.leadsTo) : undefined;
    if (!door.leadsTo) {
      return `"${name}"`;
    }
    if (!been) {
      return `"${name}" (never been)`;
    }
    return `"${name}" (been there, ${been})`;
  }

  /**
   * What the character remembers about rooms it has stood in, keyed by scene.
   * Handed in each tick rather than kept here, because the harness owns it and
   * a stale copy would tell somebody they had been somewhere they had not.
   */
  remembersRooms(visited: Map<string, string>): void {
    this.visited = visited;
  }

  private doorLabel(door: SeenDoor): string {
    return door.leadsTo ? plainSceneName(door.leadsTo) : 'somewhere else';
  }

  /**
   * Do the thing, and treat a refusal as a refusal rather than a catastrophe.
   *
   * Every gateway call throws when it fails, and nothing used to catch them, so
   * an NPC that did not answer in time came all the way up through the tick
   * loop to the reconnect handler. The character then tore down its session,
   * logged back in, and came back with no plan - having lost, over one
   * unanswered greeting, everything it had worked out about what it was doing.
   *
   * Almost nothing that goes wrong in a single action is fatal. A door that
   * will not open, a monster that died before the swing landed, an NPC too far
   * away to hear: all of those are things that happen to people, and the
   * honest response is to say so and carry on. Only losing the body itself is
   * worth reconnecting for, so only that is allowed past.
   */
  async perform(intent: Intent, scene: string): Promise<ActionResult> {
    // THE TILE SIZE MUST NOT RACE THE ROOM (2026-08-27, four lost laps).
    //
    // `this.tilePx` defaults to 32 and is corrected when the room's view
    // lands. But an action can run BEFORE that view arrives on a freshly
    // entered room, and the log order proves it did, every lap:
    //
    //   walked into the trading post
    //   walk Toma -> ok
    //   [grid] the-valley-trading-post: ... tilePx believed 64
    //
    // The walk therefore converted Toma's tile (6,2) at HALF scale and
    // walked to (208,80) - which is exactly 6*32+16, 2*32+16 - arriving
    // happily at a phantom two rooms' worth of pixels short of the real
    // counter at (416,160). The walk answered ok; the buy then measured the
    // real distance and answered "You are too far away to trade with Toma",
    // four laps running, purse untouched.
    //
    // `tilePxFor` is a static table and cannot race, which is the whole
    // reason it exists (see world.ts, where this class of bug cost an
    // evening of swinging at nothing seven tiles away). Adopt it on every
    // action; `sees()` still overrides from the world's own report when the
    // two disagree, so the table is a floor, not a ceiling.
    const known = tilePxFor(scene);
    if (scene && known !== this.tilePx) {
      this.tilePx = known;
    }
    // Carried to the gateway alongside the action, never in place of it, and
    // never allowed to affect the result below - see showFeeling().
    if (intent.feeling) {
      await this.showFeeling(intent.feeling);
    }
    try {
      return await this.attempt(intent, scene);
    } catch (error) {
      if (isDisconnected(error)) {
        throw error;
      }
      return { ok: false, note: whatWentWrong(error) };
    }
  }

  /**
   * Tell the gateway how this character is doing, so the spectator viewer can
   * show it over its head. This is decoration, not an action: it costs no
   * turn, and nothing it does can fail the tick it rides along on. Only sent
   * when it actually changed, so a character sitting in one mood for a while
   * is not re-announcing it every few seconds.
   */
  private async showFeeling(feeling: Feeling): Promise<void> {
    if (feeling === this.lastShownFeeling || !emojiFor(feeling)) {
      return;
    }
    try {
      await this.arena.call('arena_feel', { agent_id: this.agentId, feeling });
      this.lastShownFeeling = feeling;
    } catch {
      // Never worth losing the turn over. The next tick tries again if the
      // feeling still holds, same as any other best-effort side channel.
    }
  }

  private async attempt(intent: Intent, scene: string): Promise<ActionResult> {
    // ACT ON THE SCENE YOU OBSERVED, NOT THE ONE YOU WERE MOVED TO. Every
    // act below that aims at an observed object is refused when the body has
    // changed rooms since the object list was taken - see notices() and
    // staleSceneNote() for the measured 25-gather failure this stops. The
    // body was dying on the Oathstone arrival tile and being carried to the
    // inn between the observation and the act, so the objects were real and
    // the room was not. Refusing costs one beat and a plain note; acting
    // costs a wire round trip to be told the same thing less clearly.
    if (['talk_to', 'attack', 'use_skill', 'pick_up', 'gather_nearby', 'shrine_bless']
      .includes(intent.action as string)) {
      const stale = this.staleSceneNote(scene);
      if (stale) {
        return { ok: false, note: stale };
      }
    }
    // Harness-only intents ride perform()'s fallback, the same way the
    // round's other synthetic actions do - checked here rather than added to
    // that chain so the whole shrine feature stays inside the two files that
    // own it.
    if ('shrine_bless' === (intent.action as string)) {
      return this.takeBlessing();
    }
    switch (intent.action) {
      case 'say':
        return this.say(intent.message);
      case 'walk':
        return this.walk(intent.place, scene, intent.message);
      case 'explore':
        return this.explore(scene, intent.message);
      case 'use_door':
        return this.useDoor(scene, intent.place, intent.message);
      case 'talk_to':
        return this.talkTo(intent.target);
      case 'answer_npc':
        return this.answerNpc(intent.option);
      case 'attack':
        return this.attack(intent.target);
      case 'use_skill':
        return this.useSkill(intent.skill, intent.target);
      case 'use_item':
        return this.useItem(intent.item ?? intent.target);
      case 'pick_up':
        return this.pickUp(intent.item ?? intent.target);
      case 'buy':
        return this.buy(intent.item, intent.quantity);
      case 'sell':
        return this.sell(intent.item, intent.quantity);
      case 'duel_queue':
        return this.duelQueue(scene, intent.target);
      case 'give_up_and_walk_back':
        return this.giveUpAndWalkBack();
      case 'check_money':
        return this.checkMoney();
      case 'set_goal':
        // The harness owns the goal, because it owns the memory it is written
        // to. It applies this before anything gets here; see npc.ts.
        return { ok: true, note: 'thought about what you are doing with yourself' };
      default:
        return { ok: true, note: 'stayed put' };
    }
  }

  /**
   * Wander somewhere in this room the character has not been. The harness picks
   * the spot off the real collision grid and confirms the route first, so this
   * is exploring rather than walking hopefully into a wall.
   */
  async explore(scene: string, message?: string): Promise<ActionResult> {
    if (!this.can('walk')) {
      return { ok: false, note: 'this character stays where it is' };
    }
    const here = await this.where();
    if (!here) {
      return { ok: false, note: 'could not tell where it was standing' };
    }
    this.explorer.markHere(scene, here.x, here.y);
    // The third explore of the same room is where wandering stops teaching.
    // Guy spent an afternoon proving this: explore picks a fresh bearing every
    // time, so each look "succeeds", the model copies its own success, and the
    // circling detector - which keys on action plus place - never sees two
    // moves alike. If there is a door here this character has never been
    // through, the harness takes it, because a room it has never seen beats
    // any corner of one it has. Advice was tried first and lost to pattern,
    // the same as it did at the pickDoor fallthrough.
    const wandered = (this.roamed.get(scene) ?? 0) + 1;
    this.roamed.set(scene, wandered);
    if (wandered > 3 && this.can('doors')) {
      const somewhereUnseen = this.doors().find(
        (door) => door.leadsTo && !door.locked && !this.visited.get(door.leadsTo)
      );
      if (somewhereUnseen) {
        this.roamed.set(scene, 0);
        const through = await this.useDoor(scene, this.doorLabel(somewhereUnseen), message);
        if (through.ok) {
          return {
            ok: true,
            note:
              `this room had nothing left it had not seen, so instead of another look around it `
              + `${through.note}, somewhere it had never been`
          };
        }
        // The door refused; fall through to an honest wander rather than
        // failing an explore the character never asked to convert.
      }
    }
    const spot = await this.explorer.somewhereNew(this.arena, this.agentId, scene, here);
    if (!spot) {
      return { ok: false, note: 'there was nowhere new to go from here' };
    }
    const talking = this.alsoSay(message);
    // Through approach(), not raw: exploration used to be able to pick a
    // spot on the rim and walk straight to it.
    const arrived = await this.approach(spot.x, spot.y);
    await talking;
    // Mark where it actually ended up, not where it meant to go. A character
    // that stalls against a corner has still moved, and recording the target
    // would tell it it had seen a patch it never reached.
    const landed = await this.where();
    if (landed) {
      this.explorer.markHere(scene, landed.x, landed.y);
    }
    return {
      ok: arrived,
      note: arrived
        ? `had a look around to the ${spot.bearing}`
        : `set off ${spot.bearing} and did not get there`
    };
  }

  private async where(): Promise<{ x: number; y: number } | null> {
    const observation = await this.observe().catch(() => null);
    const state = observation?.ownPlayer?.state;
    if (!state || !Number.isFinite(Number(state.x))) {
      return null;
    }
    return { x: Number(state.x), y: Number(state.y) };
  }

  /**
   * Speak. A long thought goes out as several chat lines in a row, paced like
   * someone actually saying it, because the chat field takes 100 characters and
   * a character who talks in paragraphs would otherwise arrive cut mid-word.
   */
  async say(message: string | undefined): Promise<ActionResult> {
    if (/\b(well met|greetings|fair greeting|at your service|good (soul|morrow|day)|hail)\b/i.test(String(message ?? ''))) {
      return { ok: false, note: 'held: the crown does not greet - lead with wit, taunt, or decree' };
    }
    // Chat is a VOICE, not a novel (user order: no third person, no
    // stage directions). A dialogue-tagged line is salvaged by voicing
    // just the quote; narration is held entirely. Twin of the same
    // guard in agentic.ts - change both or neither.
    const cleaned = unstaged(String(message ?? ''));
    if (null === cleaned) {
      return { ok: false, note: 'held: that is narration, not speech - talk TO someone, first person only' };
    }
    message = cleaned;
    if (!this.can('speak')) {
      return { ok: false, note: 'this character does not speak' };
    }
    const lines = toSpeech(message ?? '', this.wordiness);
    if (lines.length === 0) {
      return { ok: false, note: 'nothing worth saying' };
    }
    for (const [index, line] of lines.entries()) {
      if (index > 0) {
        await sleep(BETWEEN_LINES_MS);
      }
      await this.arena.call('arena_say', { agent_id: this.agentId, message: line });
    }
    return { ok: true, note: `said: ${lines.join(' ')}` };
  }

  async walk(place: string | undefined, scene: string, message?: string): Promise<ActionResult> {
    if (!this.can('walk')) {
      return { ok: false, note: 'this character stays where it is' };
    }
    const places = placesIn(scene);
    const key = Object.keys(places).find(
      (name) => name.toLowerCase() === String(place ?? '').trim().toLowerCase()
    );
    if (!key) {
      // The place may simply be in the next room, and the way to another room
      // is through the door. A character heading for the bar from the street
      // should walk in rather than report that the bar does not exist.
      const elsewhere = roomOf(String(place ?? ''));
      if (elsewhere && elsewhere !== scene && this.can('doors')) {
        const through = this.doors().find((door) => door.leadsTo === elsewhere);
        if (through) {
          return this.useDoor(scene, place, message);
        }
      }
      // Somebody standing right here is also somewhere to walk to - the only
      // named destination that exists at all outside home turf, where
      // placesIn() is empty by design (see world.ts). Without this, "walk
      // over to the sellsword" had nothing to resolve to anywhere but town
      // and fell straight through to exploring at random, while talk_to on
      // its own kept failing as too far away. See walkToSomebody().
      const toSomebody = await this.walkToSomebody(place, message);
      if (toSomebody) {
        return toSomebody;
      }
      // Somewhere it has heard of but cannot place: look around for it rather
      // than announcing that it does not exist.
      if (this.can('walk') && place) {
        return this.explore(scene, message);
      }
      return { ok: false, note: `there is no "${place}" here` };
    }
    // Talk on the way. Waiting for a three-line remark to finish before taking
    // a step means standing in the street reciting, and it reads as a stall.
    const talking = this.alsoSay(message);
    const target = places[key];
    const arrived = await this.approach(target.x, target.y);
    await talking;
    // PROGRESS IS NOT FAILURE (2026-08-16). approach() now answers for the
    // DESTINATION rather than this beat's waypoint, which is right - it is
    // what stopped the harness believing it stood at a counter it was
    // seventeen tiles from. But a walk deliberately covers one corner of a
    // bending route per beat, so reporting ok:false for "still walking" made
    // every multi-corner walk look like a failed one, and callers that gate
    // on ok (the too-far-to-trade retry above all) gave up on a walk that was
    // working. Say ok and say plainly which it was; the note carries the
    // truth and no caller has to treat a normal stride as an error.
    return { ok: true, note: arrived ? `walked to ${key}` : `on the way to ${key}` };
  }

  /** Start saying something without waiting for it to finish. */
  private alsoSay(message: string | undefined): Promise<unknown> {
    return message ? this.say(message).catch(() => undefined) : Promise.resolve();
  }

  /**
   * Reach somebody standing nearby by name, matched the same forgiving way a
   * door is (see matchDoors()) rather than needing the exact string the
   * gateway calls them. Only NPCs: an enemy is what `attack` is for, and
   * walking up to one on purpose is a different thing to mean.
   *
   * Returns null, not a failure, when the name matches nobody here at all and
   * nobody is standing here to report either - the caller then falls through
   * to explore() exactly as it always did for a place only ever heard of.
   * That is still the right guess for an unfamiliar name in an empty room.
   * But once somebody actually is standing here, guessing wrong and wandering
   * off is worse than saying so: a real failure names who is actually here,
   * the same as a door with no matching name lists what doors there are.
   */
  private async walkToSomebody(place: string | undefined, message?: string): Promise<ActionResult | null> {
    const wanted = String(place ?? '').trim();
    if (!wanted || isBearing(wanted)) {
      // "south", "south-east": a heading, not somebody's name. Reporting who
      // is standing here in answer to it is worse than useless - Guy asked to
      // walk south in the volcano and was told twice, in consecutive turns,
      // that there was nobody here called "south", with two people listed
      // back at him. explore() knows what to do with a bearing; this does not.
      return null;
    }
    // A seam of ore is `kind: 'npc'` too. It is not somebody to talk to.
    const people = this.nearby.filter((object) => object.kind === 'npc' && !this.isResourceNode(object));
    // Only the one name each: unlike a door, a person has no second, raw form
    // hiding behind a pretty override for a memory to have recorded instead.
    const matches = this.matchByLabel(wanted, people, (person) => [person.label]);
    if (matches.length === 0) {
      if (people.length === 0) {
        return null;
      }
      return {
        ok: false,
        note: `there is nobody here it would call "${place}". It can see: `
          + people.map((person) => `"${person.label}"`).join(', ')
      };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        note: `it could not tell which of them "${place}" meant: `
          + matches.map((person) => `"${person.label}"`).join(' or ')
      };
    }
    const [person] = matches;
    if (!Number.isFinite(person.tileX) || !Number.isFinite(person.tileY)) {
      return { ok: false, note: `cannot tell where ${person.label} actually is` };
    }
    const spot = await this.adjacentTile(person.tileX, person.tileY);
    if (!spot) {
      return { ok: false, note: `could not find a way to stand next to ${person.label}` };
    }
    const talking = this.alsoSay(message);
    const arrived = await this.approach(spot.x, spot.y);
    await talking;
    // Same reasoning as walk() above: a bending route takes several beats by
    // design, and the trade retry gates on ok. Reporting failure mid-stride
    // meant the retry refused to fire on a walk that was working.
    return {
      ok: true,
      note: arrived
        ? `walked over to ${person.label}`
        : `on the way to ${person.label}`
    };
  }

  /**
   * Walk to a point and wait for the body to actually get there. The one
   * move every one of these actions needs once it has worked out where to
   * go - a person's tile, a spot to explore, a door too far off to reach in
   * one try - so it is written once here rather than three times over.
   */
  /**
   * THE ONE DOOR EVERY WALK GOES THROUGH.
   *
   * The clamp used to live in goTo(), which covered maybe half the
   * movement in this harness: five call sites reach approach() directly
   * (explore, walk-to-place, door approach, walk-to-somebody) and they
   * all skipped it. That is why bodies kept arriving at column 1 and row
   * 145 no matter how many times the "fix" was deployed. It lives here
   * now, at the bottom, where nothing can go around it.
   */
  private async approach(x: number, y: number): Promise<boolean> {
    const g = await this.walkableGrid();
    // THE RIM MARGIN SCALES WITH THE ROOM. Three tiles keeps a body off the
    // boundary of a hunting ground, which is what it was written for: under
    // semi_auto the engine walks a body to its own target, so a fight picked
    // near the edge drags it onto the rim.
    //
    // On an interior it is a cage. Barnaby's inn is thirteen rows, so a
    // margin of three forbids rows 0-2 and 10-12 - forty-six per cent of the
    // room, the whole north wall included. Fanshawe was sent to a mark up
    // there and the clamp quietly rewrote it to the row he already stood on,
    // so the walk reported "got there" without him having moved.
    //
    // An eighth of the shorter side, capped at three: unchanged for the
    // stair (176/8) and the valley (40/8), one tile in the inn.
    const margin = g ? Math.min(3, Math.max(0, Math.floor(Math.min(g.w, g.h) / 8))) : 3;
    const maxX = (g?.w ?? 145) - 1 - margin;
    const maxY = (g?.h ?? 145) - 1 - margin;
    // THE MARGIN IS A RULE ABOUT PICKING FIGHTS, NOT ABOUT REACHING THINGS.
    //
    // It exists because `semi_auto` walks the body to its own target, so a
    // mark chosen near the boundary drags it onto the rim. A GATHER has no
    // engine behind it doing that, and the clamp was quietly making one of
    // the two seams unreachable - the only one that could ever have been
    // worked.
    //
    // `millers-stair` is 192x176, so `maxY` is 172. `salt_vein_copper` sits
    // at row 174. Every walk toward it was rewritten to (91,172) - measured
    // six beats running - and `workNode` needs 1.5 tiles to swing. Copper is
    // the ONLY level-1 mining vein in reach (iron, at row 171, needs mining
    // 10), so this clamp is a complete explanation for a lifetime ledger of
    // zero charges, and it has been true for the life of this harness.
    //
    // Clamp to the MAP. `nearestStandable` still runs after this, so an
    // unwalkable rim tile is still corrected; what is no longer done is
    // refusing to aim at a real object because of a rule about combat.
    const hardX = (g?.w ?? 145) - 1;
    const hardY = (g?.h ?? 145) - 1;
    const wantX = Math.max(0, Math.min(hardX, Math.floor(x / this.tilePx)));
    const wantY = Math.max(0, Math.min(hardY, Math.floor(y / this.tilePx)));
    const fixed = this.nearestStandable(wantX, wantY);
    if (fixed) {
      x = fixed.x;
      y = fixed.y;
    } else {
      x = wantX * this.tilePx + this.tilePx / 2;
      y = wantY * this.tilePx + this.tilePx / 2;
    }
    // arena_move_to walks a straight line, and a blocked step returns ok
    // (#107): a body ordered across a wall presses against it forever
    // while the gateway reports success - the spectator's "stuck behind
    // walls". The pathfinder itself is honest, so ask it first: refuse
    // the truly unreachable out loud, and when the route bends, walk its
    // FIRST corner this beat - the next beat asks again from there and
    // walks the next leg, which is the whole path eventually.
    let legX = x;
    let legY = y;
    try {
      const route = await this.arena.call('arena_check_path', {
        agent_id: this.agentId,
        row: Math.floor(y / this.tilePx),
        column: Math.floor(x / this.tilePx)
      });
      if (false === route?.reachable) {
        throw new Error(`no walking route to tile ${Math.floor(x / this.tilePx)},${Math.floor(y / this.tilePx)}`);
      }
      const turns = Array.isArray(route?.pathTurns) ? route.pathTurns : [];
      // turns[0] is where we stand; a route with more than two points
      // bends, and the first corner is this beat's whole journey.
      if (turns.length > 2) {
        // A MALFORMED CORNER IS NOT A REASON NOT TO WALK (2026-08-27).
        //
        // This destructured turns[1] unchecked, and the world sometimes
        // hands back a corner whose column is not a number. Measured six
        // times in one night, every one identical: `[move] refused a walk
        // to (NaN, 160)`. The 160 is the tell - row * 64 + 32 = 160 means
        // row came through as a clean 2 while col did not come through at
        // all, so it is one bad element rather than a bad reply.
        //
        // The cost was not the NaN. `goTo`'s guard catches that and fails
        // honestly. The cost is that a bad corner OVERWROTE a target that
        // was already good, so the whole walk was cancelled rather than
        // taken directly - which is one of the ways a body ends a beat on
        // the tile it started on. The catch below already holds the right
        // rule for a failed probe ("go direct, as before"); a probe that
        // succeeds with rubbish in it never reached that rule.
        //
        // Written twice. The first time it was applied, the suite went
        // green, and it was gone from the tree an hour later with nobody
        // the wiser - a reviewer found it missing from BOTH src and dist
        // while signing off a list that claimed it. The patch script's own
        // success message is not evidence that a change is in the file.
        const corner = turns[1] as unknown;
        const [col, row] = cornerTile(corner);
        const stepX = (col as number) * this.tilePx + this.tilePx / 2;
        const stepY = (row as number) * this.tilePx + this.tilePx / 2;
        if (Number.isFinite(stepX) && Number.isFinite(stepY)) {
          legX = stepX;
          legY = stepY;
        } else if (!this.saidBadCorner) {
          this.saidBadCorner = true;
          console.log(`[move] the route's first corner is unusable (${JSON.stringify(corner)})`
            + ' - walking straight at the target instead of cancelling');
        }
      }
    } catch (error) {
      if (/no walking route/.test(String((error as Error)?.message ?? ''))) {
        throw error;
      }
      // The probe failing is not the walk failing: go direct, as before.
    }
    // The last gate before the wire. goTo() guards its own arguments, but
    // approach() derives these from the walkable grid and the tile size, so
    // a missing grid or a target with no tile of its own can still make a
    // NaN here - which the gateway answers with "Invalid arguments for tool
    // arena_move_to: expected number", and the round reads as the target
    // being unreachable rather than as a bug in us (measured 2026-08-24,
    // through three separate callers).
    if (!Number.isFinite(legX) || !Number.isFinite(legY)) {
      console.log(`[move] refused a walk to (${legX}, ${legY}) - the grid gave no usable tile`);
      return false;
    }
    await this.arena.call('arena_move_to', { agent_id: this.agentId, x: legX, y: legY });
    const atLeg = await this.waitForArrival(legX, legY);
    // ARRIVED WHERE? This returned arrival at the LEG, and goTo turns that
    // into the words "got there" - so a body that reached the first corner
    // of a bending route reported having arrived at a destination it had not
    // reached. Measured 2026-08-16 against the grassland treasure chest:
    // "open_chest -> ok - got there" six beats running while the instrument
    // put the chest 17.02 tiles away, at tile (27,9). Any caller that acts on
    // arrival - the chest talks, a shop trades - was acting on a waypoint.
    // A leg IS the destination when the route did not bend, which is the
    // common case, so this only tightens the bending one: "on the way" now
    // means genuinely still walking, and the next beat continues from the
    // corner just reached, exactly as the design intends. The final target
    // is re-seated onto standable ground above, so arriving at it is
    // reachable and this cannot wait for somewhere unstandable for ever.
    return atLeg && legX === x && legY === y;
  }

  /**
   * A tile beside the given one that the character can actually reach,
   * checked against the real collision grid the same way
   * Explorer.somewhereNew() confirms a spot before setting off - standing
   * next to somebody, not on top of them, is the whole point, and next door
   * is exactly where a wall might be.
   */
  private async adjacentTile(
    tileX: number,
    tileY: number,
    rings = 1
  ): Promise<{ x: number; y: number } | null> {
    for (let ring = 1; ring <= rings; ring++) {
      for (const [dx, dy] of ADJACENT_TILES) {
        const x = (tileX + dx * ring) * this.tilePx + this.tilePx / 2;
        const y = (tileY + dy * ring) * this.tilePx + this.tilePx / 2;
        if (x < this.tilePx || y < this.tilePx) {
          continue;
        }
        try {
          const path = await this.arena.call('arena_check_path', { agent_id: this.agentId, x, y });
          if (path?.reachable) {
            return { x, y };
          }
        } catch {
          // Treat an unanswerable probe as unreachable and try the next side.
        }
      }
    }
    return null;
  }

  /**
   * Go through a doorway the character can see. Which doors exist comes from
   * looking at the room, not from a table somebody wrote out in advance, so
   * this works the same in a room nobody has ever surveyed.
   */
  /** Set from the character sheet's neverMoves flag. See goTo(). */
  immovable = false;

  /**
   * `harnessDriven` is the one way past the 'doors' capability, and it exists
   * for a single caller: taking a busker to their stage at startup.
   *
   * Fanshawe deliberately does NOT hold 'doors' - that is what stops the
   * model walking him out of the inn mid-set, and it should keep stopping it.
   * The same gate also stopped the harness carrying him TO the inn, which is
   * how "he returns to his mark if displaced" came to be true only in the
   * comments. Granting the capability instead would hand the model the door
   * tool along with it, because the tool list is derived from that same set;
   * this route leaves the set untouched.
   *
   * Not a general-purpose override: nothing the model asks for reaches this
   * parameter, and it is unset at every other call site.
   */
  async useDoor(
    scene: string,
    which?: string,
    message?: string,
    harnessDriven = false
  ): Promise<ActionResult> {
    if (!harnessDriven && !this.can('doors')) {
      return { ok: false, note: 'this character does not leave this room' };
    }
    const doors = this.doors();
    if (doors.length === 0) {
      return { ok: false, note: 'there is no way out of here that it can see' };
    }
    const picked = this.pickDoor(which, doors, scene);
    if ('walkTo' in picked) {
      // A WALK TOWARD A DOOR IS NOT A DOOR CROSSED. This result is handed
      // back as a use_door outcome, and the round zeroes doorBlockedStreak
      // whenever that comes back ok - which disarms the whole escalation
      // ladder (unstick, then force_doors, then ask the mind, then ask the
      // world to move the body). That ladder is what stops a wedged
      // character standing at a doorway for ever. Since walk() began
      // answering ok mid-stride, a body inching toward a door it never
      // reaches would reset the counter on every beat and never escalate.
      // Report progress honestly and let only a real crossing count.
      const toward = await this.walk(picked.walkTo, scene, message);
      return /on the way/i.test(String(toward.note ?? ''))
        ? { ok: false, note: toward.note }
        : toward;
    }
    if ('note' in picked) {
      // Never just "could not tell": a character stuck on a door with no
      // idea what its actual choices are will try the same unreadable name
      // again next tick. Naming what is really there is what gets it moving.
      return { ok: false, note: picked.note };
    }
    const door = picked;
    if (door.locked) {
      return { ok: false, note: `the door to ${this.doorLabel(door)} is locked` };
    }
    if (message) {
      await this.say(message).catch(() => undefined);
    }
    // The gateway routes to the door, steps through, and retries: door tiles
    // are excluded from path-finding on purpose, so they can only be walked
    // into. See arena_enter_door.
    const result = await this.enterDoor(door);
    if (result.entered) {
      return { ok: true, note: `went through into ${this.arrivedIn(result, door)}` };
    }
    // "Ran out of time" is the same situation as DOOR_TOO_FAR wearing a
    // different name, and it was falling through to a sentence the round
    // could do nothing with (2026-08-16). The gateway's own message ends
    // "get closer first, then try the door" - which is exactly what
    // crossToDoor does, and it was never being called. It matters most on
    // the forest, whose town door sits at column 3 of a 145-tile map, so
    // every trip out is a long walk that routinely exceeds the gateway's
    // budget: measured live, three of four door failures in the first
    // minutes after a deploy were this, each costing a whole beat and
    // leaving the body exactly where it started. Matched on the message as
    // well as the reason code because the code is not stable across
    // gateway versions and the prose is what was observed.
    const ranOutOfTime = /ran out of time|get closer first/i.test(String(result.message ?? ''));
    if (result.reason === 'DOOR_TOO_FAR' || ranOutOfTime) {
      return this.crossToDoor(door);
    }
    return { ok: false, note: `the door did not open: ${result.message ?? result.reason}` };
  }

  /**
   * A door the gateway could not reach inside its own budget: cross the room
   * and, if that gets us there, step through.
   *
   * Not a refusal. The gateway is saying the door is fine and simply a long
   * way off, so the useful move is the one it suggests rather than a sentence
   * the character can do nothing with.
   *
   * Two details, both learned by watching this run in the volcano and taking
   * three minutes over it. The walk aims at a tile BESIDE the door, not the
   * door: a change point is walked into, not stood on, so aiming at it either
   * fails or trips the transition halfway through a leg and leaves the retry
   * running in the wrong room. And when the walk still has not arrived, that
   * is the end of the turn. Chaining another door attempt onto the end of a
   * timed-out crossing stacks forty five seconds of walking onto two forty
   * second door budgets, and for those three minutes the character cannot
   * hear anybody, look at anything, or be talked to. Getting most of the way
   * across a room is real progress and is reported as such, so the next tick
   * picks the door up from close enough for the ordinary path to work.
   */
  private async crossToDoor(door: SeenDoor): Promise<ActionResult> {
    const where = this.doorLabel(door);
    // Two rings, not one. The eight tiles touching a doorway are the obvious
    // place to stand and often the worst: half of them are the wall the door
    // is set into, and in a narrow passage the rest can be a change point
    // itself. Widening the search is cheaper than the alternative, which is a
    // character standing across the room from a door it can see and being told
    // there is no way to it.
    const spot = await this.adjacentTile(door.column, door.row, 2);
    if (!spot) {
      // Nothing beside the door answered. That is a fact about the probe, not
      // about the world, and the old wording said the opposite: "there is no
      // way through to the door" is a claim the character will believe and act
      // on, and it was wrong often enough to strand somebody. Say what was
      // actually established, and leave the door worth trying again.
      return {
        ok: false,
        note:
          `could not find anywhere to stand beside the door to ${where} from here, `
          + 'so it may be walled off from this side or simply too far to work out yet'
      };
    }
    if (!(await this.approach(spot.x, spot.y))) {
      return { ok: true, note: `set off for the door to ${where} and got part of the way; it is still ahead` };
    }
    const retried = await this.enterDoor(door);
    return retried.entered
      ? { ok: true, note: `went through into ${this.arrivedIn(retried, door)}` }
      : { ok: false, note: `the door did not open: ${retried.message ?? retried.reason}` };
  }

  /**
   * Where the character ended up, named the way it would name it.
   *
   * The gateway reports the scene it arrived in, and that is the truth worth
   * having, because a door can land somebody somewhere other than the room its
   * label advertised. But `scene` is only documented as present alongside
   * `entered`, not guaranteed by anything, and typing this properly is what
   * turned that up: it used to be read straight into plainSceneName(), so a
   * reply without it would have told the character it "went through into
   * undefined" and written that into its memory as a place it had been. Fall
   * back to what the door said it led to, which is at worst a label the
   * character already had.
   */
  private arrivedIn(result: DoorAttempt, door: SeenDoor): string {
    return result.scene ? plainSceneName(result.scene) : this.doorLabel(door);
  }

  /** Ask the gateway to walk a character to a door already resolved to a tile. */
  private async enterDoor(door: SeenDoor): Promise<DoorAttempt> {
    return this.arena.call('arena_enter_door', { agent_id: this.agentId, x: door.x, y: door.y });
  }

  /**
   * Match what the character asked for against the doorways it can see, or
   * say plainly why nothing was picked. Returns the door itself, or a note
   * to hand straight back as the result - never a bare failure with nothing
   * for the character to go on, because that is what left it stuck on "the
   * inn door" with no way to know that was not close enough.
   */
  private pickDoor(
    which: string | undefined,
    doors: SeenDoor[],
    scene = ''
  ): SeenDoor | { note: string } | { walkTo: string } {
    if (doors.length === 1) {
      // Only one way out, whatever they called it: "the door out", "outside",
      // "back" when there is somewhere it came from. Nothing to disambiguate.
      return doors[0];
    }
    const wanted = String(which ?? '').trim();
    if (!wanted) {
      return { note: `it was not clear which door. It can see: ${this.listDoors(doors)}` };
    }
    const matches = this.matchDoors(wanted, doors);
    if (matches.length === 1) {
      return matches[0];
    }
    if (matches.length > 1) {
      // A doorway two tiles wide is two change points, so it arrives here as
      // two doors with the same label. Asking a character to choose between
      // "town" and "town" is asking it to answer a question with no answer,
      // and it did: the Wanderer spent a turn on exactly that. If every
      // candidate leads to the same room then the name was never ambiguous.
      const first = matches[0];
      if (matches.every((door) => door.leadsTo === first.leadsTo)) {
        return first;
      }
      return {
        note: `it could not tell which door "${which}" meant: `
          + matches.map((door) => `"${this.doorLabel(door)}"`).join(' or ')
      };
    }
    // Before giving up: the thing it asked for may be a real place, just not a
    // door. Guy asked for "the east gate" from inside a house on the far side
    // of town, thirteen times, and each time was told no such door exists.
    // Which is true, and useless: the east gate is a spot in town, through a
    // door he could see the whole time. A character that knows where somewhere
    // is and cannot get there is worse off than one that has never heard of it.
    const elsewhere = roomOf(String(which ?? ""));
    if (elsewhere === scene) {
      // The place is in this very room. Guy stood in town asking for a door to
      // the south field, which is forty tiles away across the grass he was
      // looking at, and was told there was no door to there from here. True,
      // in the way that only useless things are true. Walking is the action he
      // meant, so it becomes a walk.
      return { walkTo: String(which) };
    }
    if (elsewhere) {
      const wayThrough = doors.find((door) => door.leadsTo === elsewhere);
      if (wayThrough) {
        // Take it, rather than explaining it. Guy was handed this exact
        // sentence as advice - "go through the door to town first, then walk
        // to it" - and asked for the same non-existent door five more times,
        // because a model copies the pattern its own history demonstrates and
        // his history was thirteen attempts at that door. Advice loses to the
        // pattern. Doing the obvious thing breaks it.
        //
        // There is no guesswork in the choice: the name is a place, the place
        // is in a room, and exactly one door here goes to that room. Somebody
        // asking for the east gate from a house across town wants to head that
        // way, and this is the first step of the only route there is.
        return wayThrough;
      }
      return {
        note:
          `"${which}" is not a door, it is a spot in ${plainSceneName(elsewhere)}, `
          + `and there is no door to there from here. The doors here go to: ${this.listDoors(doors)}`
      };
    }
    return { note: `there is no door here it would call "${which}". It can see: ${this.listDoors(doors)}` };
  }

  /**
   * Every door a name could plausibly mean. Delegates to matchByLabel(): a
   * door is just a candidate with names, the same as a person is - see
   * walkToSomebody(), which names somebody nearby the identical way, just
   * with only the one name to offer instead of a door's two.
   */
  private matchDoors(which: string, doors: SeenDoor[]): SeenDoor[] {
    return this.matchByLabel(which, doors, (door) => this.doorNames(door));
  }

  /** The doorways here, named the way a character would name them. */
  private listDoors(doors: SeenDoor[]): string {
    return doors.map((door) => `"${this.doorLabel(door)}"`).join(', ');
  }

  /**
   * Every name a door could reasonably be asked for by, not only the pretty
   * one describe() and listDoors() show.
   *
   * plainSceneName() - what doorLabel() is built from - overrides a handful
   * of rooms with a name a person would actually say: reldens-forest reads
   * as "the woods". But a character's own memory of standing in that same
   * room is written with rawSceneName() instead (see notePlace() in npc.ts),
   * which never applies that override and calls it "forest". A production
   * memory fragment showed exactly this: a character had "bots forest" and
   * "bots forest house 01 n0" written down, and a door that only answered to
   * its pretty name could never be reached again by the name the character
   * actually had for it. Deduped, since most doors have no override at all
   * and the two forms are the same string.
   */
  private doorNames(door: SeenDoor): string[] {
    const pretty = this.doorLabel(door);
    const raw = door.leadsTo ? rawSceneName(door.leadsTo) : pretty;
    return raw === pretty ? [pretty] : [pretty, raw];
  }

  /**
   * Every candidate a name could plausibly mean, out of anything with one or
   * more names: an exact match against any of them, a substring either way,
   * or - failing both - any word the name and one of theirs actually share
   * once filler words are out of it, using the same word-overlap
   * contentWords() already does for catching a character repeating itself.
   * "the inn door" reaches "Barnaby's inn" on the shared word "inn"; "the
   * sellsword" reaches "Old Ferro the sellsword" the same way. One matcher
   * for both doors and people, because it is one problem: a name given
   * loosely against a short list of real names - a person only ever has the
   * one, a door can have two.
   */
  private matchByLabel<T>(which: string, candidates: T[], namesOf: (item: T) => string[]): T[] {
    const wanted = which.toLowerCase();
    const exact = candidates.filter((item) =>
      namesOf(item).some((name) => name.toLowerCase() === wanted)
    );
    if (exact.length > 0) {
      return exact;
    }
    const substring = candidates.filter((item) =>
      namesOf(item).some((name) => {
        const label = name.toLowerCase();
        return label.includes(wanted) || wanted.includes(label);
      })
    );
    if (substring.length > 0) {
      return substring;
    }
    const wantedWords = contentWords(which);
    if (wantedWords.size === 0) {
      return [];
    }
    return candidates.filter((item) =>
      namesOf(item).some((name) => {
        const labelWords = contentWords(name);
        return [...wantedWords].some((word) => labelWords.has(word));
      })
    );
  }

  /**
   * Put this character up for a duel where it is standing.
   *
   * The scene is the harness's, never the model's. arena_queue_match defaults
   * a missing scene to the agent's home, so a model that forgot the field
   * would queue Nerys against her own bedroom rather than the plateau she just
   * walked to. Supplying it from the actual current scene is the same shape of
   * decision as walk supplying coordinates from a place name.
   *
   * The named opponent is intent, not enforcement. The coordinator pairs
   * whoever queued on the same scene, first come first served; there is no way
   * to queue against a specific person and no way to leave a queue once in it.
   * So the honest thing is to say who turned up, and refuse to pretend a
   * stranger is the person this character meant: the pairing still stands,
   * because two people who both walked to the same flat and asked for a fight
   * have agreed to one, whoever they hoped would be there.
   */
  async duelQueue(scene: string, opponent: string | undefined): Promise<ActionResult> {
    if (!this.can('duel') || !this.can('fight')) {
      return { ok: false, note: 'this character does not duel' };
    }
    if (this.matched) {
      // The one standing duel may have finished: the world decides that, not
      // this slot, so ask before refusing. This is also the only place the
      // slot is cleared, which keeps its lifecycle in one method.
      const standing = await this.arena
        .call('arena_match_status', { match_id: this.matched.matchId })
        .catch(() => null);
      if ('completed' === standing?.status) {
        const beaten = this.matched.opponentName;
        this.matched = null;
        return {
          ok: true,
          note: `the duel with ${beaten} is over and decided. Free to queue for another.`
        };
      }
      return {
        ok: false,
        note: `already in a duel with ${this.matched.opponentName}; that has to finish first`
      };
    }
    const match = await this.arena.call('arena_queue_match', {
      agent_id: this.agentId,
      scene_name: scene
    });
    if ('queued' === match?.status) {
      return {
        ok: true,
        note:
          `waiting at ${plainSceneName(scene)} for somebody to answer the challenge`
          + (opponent ? `, hoping for ${opponent}` : '')
          + '. Keep doing other things; the fight starts when somebody turns up.'
      };
    }
    const participants: Array<{ agentId?: string; playerName?: string }> = match?.participants ?? [];
    const other = participants.find((one) => one.agentId !== this.agentId);
    if (!match?.id || !other?.playerName) {
      return { ok: false, note: 'the queue did not answer sensibly; try again in a moment' };
    }
    this.matched = { matchId: String(match.id), opponentName: other.playerName, scene };
    const hoped = opponent?.trim().toLowerCase();
    const got = other.playerName.trim().toLowerCase();
    return {
      ok: true,
      note:
        `matched: a duel with ${other.playerName} at ${plainSceneName(scene)}`
        + (hoped && hoped !== got ? ` (you hoped for ${opponent}, but it is ${other.playerName} who answered)` : '')
        + '. Attack them by name when you are ready.'
    };
  }

  /**
   * The registered opponent as a live player target, if that is who was named.
   *
   * Gated on the match, not the capability. The capability says this character
   * may duel; the match says it is in one, with this person, and only somebody
   * both named by the match and actually standing here resolves. A duellist
   * cannot hit a bystander by asking, and cannot hit its opponent from another
   * room.
   */
  private opponentNamed(target: string): { sessionId: string; playerId: number; label: string } | null {
    if (!this.matched) {
      return null;
    }
    const wanted = target.trim().toLowerCase();
    const opponent = this.matched.opponentName.trim().toLowerCase();
    if (wanted !== opponent && !opponent.includes(wanted) && !wanted.includes(opponent)) {
      return null;
    }
    for (const person of this.people) {
      const name = (person.playerName ?? person.name ?? person.label ?? '').trim().toLowerCase();
      if (name === opponent && person.sessionId && person.playerId) {
        return {
          sessionId: String(person.sessionId),
          playerId: Number(person.playerId),
          label: this.matched.opponentName
        };
      }
    }
    return null;
  }

  /**
   * Walk into arm's reach of the named enemy. The attack call itself does
   * not move a character, and a melee style swung from across the room is
   * how a knight stands in a field of three hundred enemies hitting none
   * of them. Movement is fire-and-forget: the engine walks the body while
   * the round keeps ticking.
   */
  /** Walk to a point the round already trusts (a partner's spot on the feed). */
  /**
   * The scene's real collision grid, cached per room.
   *
   * arena_walkable_grid returns the WHOLE scene unscaled, run-length
   * encoded ("12#3.#" = twelve walls, three floors, one wall). This is
   * the honest picture: arena_render_map downsamples and, in its own
   * words, "draws walls as floor and floor as walls", which is why
   * map-derived destinations kept putting bodies into scenery. One call
   * per room, then every destination can be checked for free.
   */
  private grid: { scene: string; rows: string[]; w: number; h: number } | null = null;
  private gridAt = 0;
  /**
   * Tiles this room's collision grid calls floor and the WORLD will not walk
   * to. See walkTheRoad(). Cleared with the grid, so a tile that was merely
   * occupied for a moment gets another chance shortly.
   */
  private shutTiles = new Set<string>();

  private async walkableGrid(): Promise<{ rows: string[]; w: number; h: number } | null> {
    // Refreshed at most once a minute, and whenever the room changes - a
    // room change invalidates every tile.
    // The scene half of that was only ever a docstring: `grid.scene` was
    // written and never read, so for up to a minute after walking into a
    // new room every caller was clamping and standability-testing against
    // the PREVIOUS room's map (2026-08-16). Harmless while one room was
    // huntable; actively wrong now that the rotation moves between a
    // 145x145 forest and a 30x20 grassland, where the stale grid is five
    // times too big and clamps nothing.
    const here = this.view?.scene ?? null;
    const sameRoom = !here || !this.grid || this.grid.scene === here;
    if (this.grid && sameRoom && Date.now() - this.gridAt < 60_000) {
      return this.grid;
    }
    if (!sameRoom) {
      // DROP THE OLD ROOM'S MAP BEFORE FETCHING, not after. standable(),
      // nearestStandable() and chooseTarget() read `this.grid` directly
      // rather than this function's return value, so if the refetch below
      // fails - truncated, empty, or a throw - returning null is not
      // enough: those three would carry on measuring the new room against
      // the previous one's walls, and against its SIZE, which is what the
      // rim rule uses. A missing grid is handled everywhere ("assume the
      // tile is fine"); a confidently wrong one is not.
      this.grid = null;
      // The shut list describes THIS room's refusals. A new room, or a
      // refetched grid, deserves a clean sheet - otherwise a tile that was
      // briefly occupied stays shut for the session.
      this.shutTiles.clear();
    }
    try {
      const got = await this.arena.call('arena_walkable_grid', { agent_id: this.agentId });
      const rows = (got?.rows ?? []) as string[];
      this.gridAt = Date.now();
      if (!rows.length || true === got?.truncated) {
        return null;
      }
      this.grid = {
        scene: String(got?.sceneName ?? ''),
        rows: rows.map((row) => expandRle(String(row))),
        w: Number(got?.sceneSize?.widthTiles ?? 0),
        h: Number(got?.sceneSize?.heightTiles ?? 0)
      };
      if (this.gridLogged !== this.grid.scene) {
        this.gridLogged = this.grid.scene;
        console.log(`[grid] ${this.grid.scene}: ${this.grid.w}x${this.grid.h} tiles,`
          + ` row0 len ${this.grid.rows[0]?.length ?? 0}, tilePx believed ${this.tilePx}`);
      }
      return this.grid;
    } catch {
      return null;
    }
  }

  /**
   * How long each push holds, growing so a refusal is distinguishable from
   * a step that was simply too short. Two hundred and fifty milliseconds
   * moved a live body fourteen pixels; a tile is sixty-four.
   */
  private static readonly STEP_MS = [250, 800, 2_000] as const;

  /**
   * Step straight out of a wall.
   *
   * A body can end up ON a collision tile - Lord Gemma spent an evening on
   * map tile (0,3) of Miller's Stair, which that map's own collision layer
   * calls solid. Flood-filling from his tile reaches nothing, while the
   * walkable area is a single connected region of 13,547 tiles holding both
   * his partner and the door home. He was not walled into a pocket; he was
   * off the graph altogether.
   *
   * That is why every ordinary cure failed and kept failing. Routes are
   * computed FROM the walkable graph, so a body not on it is told "no walking
   * route" to everywhere, unstick nudges it two pixels along the wall, and a
   * reconnect puts it back exactly where it was. Nothing that asks the
   * pathfinder can rescue a body the pathfinder cannot see.
   *
   * So this asks nothing. It finds the nearest tile the grid calls floor and
   * moves there directly, with no route probe in front of it.
   */
  async escapeWall(x: number, y: number): Promise<ActionResult> {
    const grid = await this.walkableGrid();
    if (!grid) {
      return { ok: false, note: 'no grid to tell wall from floor' };
    }
    const tileX = Math.floor(x / this.tilePx);
    const tileY = Math.floor(y / this.tilePx);
    if (this.standable(tileX, tileY)) {
      return { ok: false, note: 'standing on solid ground already' };
    }
    // TRY EVERY DIRECTION, NOW. arena_move_to walks a straight line, and a
    // line out of a wall usually runs through more wall - so the single
    // nearest patch of floor is often the one exit that cannot work. One
    // exit per wedge cure meant one attempt every thirty seconds, which for
    // sixty candidate tiles is half an hour of standing in a wall.
    //
    // This is a rescue, so it runs as one: work outward through the floor
    // tiles nearby, and after each attempt look to see whether the body
    // actually moved. The first direction that is open ends it.
    const exits = this.standableTilesNear(tileX, tileY);
    if (!exits.length) {
      return { ok: false, note: `in a wall at tile ${tileX},${tileY} with no floor near it` };
    }
    const startedAt = `${x},${y}`;
    /** Where a failed attempt left the body, for the note if all 24 fail. */
    let lastSeen = '';
    for (const spot of exits.slice(0, 24)) {
      try {
        await this.arena.call('arena_move_to', { agent_id: this.agentId, x: spot.x, y: spot.y });
      } catch {
        continue;
      }
      // GIVE A BODY THAT IS MOVING TIME TO ARRIVE. A single check at 1200ms
      // was enough while this loop always returned on its first attempt;
      // now that it runs all 24, it is not. The exits are sorted
      // nearest-first but reach eight rings out, so a late candidate is a
      // 512px walk that cannot finish in 1200ms - and declaring it failed
      // issues the NEXT arena_move_to, which cancels the walk that was
      // working. So poll: stop early the moment the body is on floor, and
      // stop early when it has stopped moving (nothing is in flight, so
      // waiting longer buys nothing). Three polls caps one attempt at
      // ~3.6s against a wedge that otherwise runs for minutes.
      let now: { x?: number; y?: number } | null = null;
      let wasAt = startedAt;
      let freeNow = false;
      for (let poll = 0; poll < 3; poll += 1) {
        await new Promise((done) => setTimeout(done, 1_200));
        try {
          now = ((await this.observe())?.ownPlayer?.state ?? null) as { x?: number; y?: number } | null;
        } catch {
          now = null;
          break;
        }
        if (!now || 'number' !== typeof now.x || 'number' !== typeof now.y) {
          break;
        }
        freeNow = this.standable(Math.floor(now.x / this.tilePx), Math.floor(now.y / this.tilePx));
        const here = `${now.x},${now.y}`;
        if (freeNow || here === wasAt) {
          break;
        }
        wasAt = here;
      }
      if (!now || 'number' !== typeof now.x || 'number' !== typeof now.y) {
        continue;
      }
      // AGAINST WHERE THIS ATTEMPT BEGAN, not where the wedge did. Comparing
      // to the original pixel forever meant an exit that moved the body and
      // let it drift back read as "never moved" and was silently discounted.
      if (`${now.x},${now.y}` === startedAt && !freeNow) {
        continue;
      }
      // MOVING IS NOT ESCAPING (2026-08-25). This used to return ok on ANY
      // change of position and merely append "but is still in a wall" to the
      // note - so the rescue ended on its FIRST attempt and the other 23
      // exits were never tried. Measured on Lord Gemma, wedged at tile (1,0)
      // in the-valley-mage: the server nudges a wedged body a pixel or two on
      // its own, so his x,y read 64,53 / 64,54 / 64,55 / 64,56 across
      // successive beats. Every one of those differs from where the cure
      // started, so every cure "succeeded", and he stood in the same wall
      // tile for four minutes and counting, at 36hp, earning nothing.
      // A pixel is not a tile. The rescue is over when the body is on floor.
      if (freeNow) {
        return {
          ok: true,
          note: `was in a wall at tile ${tileX},${tileY} - moved to ${Math.round(now.x)},${Math.round(now.y)} and is on solid ground`
        };
      }
      lastSeen = `${Math.round(now.x)},${Math.round(now.y)}`;
    }
    // A STEP, NOT A ROUTE - THE LAST RUNG.
    //
    // Every exit above is asked for with `arena_move_to`, which ROUTES. A
    // body standing off the map has no route to anywhere, so all 24 are
    // refused the same way and the note reads "none of 24 exits opened".
    // `arena_move` takes a heading and a duration instead of a destination,
    // so it asks the world for a step rather than for a path.
    //
    // Measured 2026-09-04: both royals stood on tile (11,13) of
    // `the-valley-inn`, whose grid is 20x13 and whose last row is 12. The
    // body was filed in the room and was outside it, and a restart put the
    // new session back on the same impossible row, so the position is the
    // world's and not ours (agentArena #716).
    //
    // UNPROVEN ON PURPOSE. Nothing in this harness has ever called
    // `arena_move`, and no log anywhere shows it moving a body the
    // pathfinder refused. It may fail exactly like the routed attempts. It
    // is here because it is the one lever that has not been tried, it is
    // bounded to six short steps, and - unlike the silence this defect hid
    // behind - it reports what happened either way.
    const back = exits[0];
    /** Every distinct reason the world gave for refusing a step. */
    const heard: string[] = [];
    const headings: Array<'up' | 'down' | 'left' | 'right'> = [];
    if (back) {
      if (back.y < y) { headings.push('up'); } else if (back.y > y) { headings.push('down'); }
      if (back.x < x) { headings.push('left'); } else if (back.x > x) { headings.push('right'); }
    }
    // TOWARD FLOOR ONLY, AND THIS WAS MEASURED THE HARD WAY.
    //
    // Every heading was tried once, on the reasoning that a refused
    // direction should not end the rescue. Live on 2026-09-05 it walked both
    // royals from y=845 to y=1153 and y=1161 - row 18 of a room whose last
    // row is 12, five rows FURTHER out than they began. The world accepted
    // every downward step and refused every upward one, which says its
    // collision space for these bodies is not the map this client holds.
    //
    // A rescue that cannot tell floor from void must not wander. It heads
    // for the nearest tile its own grid calls floor, and stops.
    // EVERY DIRECTION, AND LONGER EACH TIME.
    //
    // Measured live 2026-09-05 against both royals on row 13 of a 13-row
    // room: the step toward the nearest floor answered
    // `TARGET_OUT_OF_BOUNDS` and the sideways step moved the body 14 px and
    // no further. Two headings and one step length were not enough to tell
    // "this heading is refused" from "this step was too short", so the rung
    // now tries all four headings and lengthens the step each time. The
    // nearest floor is still tried first; the rest are the fallback.
    for (const direction of headings) {
      for (const duration of Actions.STEP_MS) {
        // KEEP WHAT IT SAID. `arena_move` waits the movement out and answers
        // `moved` with a `reason` - TARGET_OUT_OF_BOUNDS, TARGET_BLOCKED,
        // STOPPED_SHORT, BLOCKED_BY_LOCKED_DOOR. For a body filed off the
        // map, which of those comes back is the fact #716 needs, and this
        // rung's whole argument for existing is that it reports rather than
        // going quiet. Discarding the reply would have made that a lie.
        let said: { moved?: boolean; reason?: string } | null = null;
        try {
          said = (await this.arena.call('arena_move', {
            agent_id: this.agentId, direction, duration_ms: duration
          })) as { moved?: boolean; reason?: string } | null;
        } catch {
          break;
        }
        if (said?.reason && !heard.includes(String(said.reason))) {
          heard.push(String(said.reason));
        }
        const before = lastSeen;
        let stepped: { x?: number; y?: number } | null = null;
        try {
          stepped = ((await this.observe())?.ownPlayer?.state ?? null) as { x?: number; y?: number } | null;
        } catch {
          break;
        }
        if (!stepped || 'number' !== typeof stepped.x || 'number' !== typeof stepped.y) {
          break;
        }
        // THE SAME TEST THE ROUTED RUNGS USE. A body that has moved is not a
        // body that is free - see "moving is not escaping" above. Only floor
        // ends this.
        if (this.standable(Math.floor(stepped.x / this.tilePx), Math.floor(stepped.y / this.tilePx))) {
          return {
            ok: true,
            note: `was off the map at tile ${tileX},${tileY} - stepped ${direction} onto `
              + `${Math.round(stepped.x)},${Math.round(stepped.y)} and is on solid ground`
          };
        }
        // THE SAME RULE THE ROUTED RUNGS KEEP. `lastSeen` reports where a
        // failed rescue LEFT the body, and the loop above deliberately does
        // not record a position the body never left. Written without that
        // guard here, the note read "the body shifted to 712,845 and stayed
        // walled" for a body that had not moved a pixel - the exact kind of
        // confident, false sentence this rung was added to stop.
        const now = `${Math.round(stepped.x)},${Math.round(stepped.y)}`;
        if (now !== before && now !== `${Math.round(x)},${Math.round(y)}`) {
          lastSeen = now;
        }
      }
    }
    return {
      ok: false,
      note: `in a wall at tile ${tileX},${tileY} and none of ${Math.min(24, exits.length)} exits opened`
        + `${headings.length ? `, nor ${headings.length * 3} steps ${headings.join('/')}` : ''}`
        + `${heard.length ? ` (the world said ${heard.join(', ')})` : ''}`
        + `${lastSeen ? ` (the body shifted to ${lastSeen} and stayed walled)` : ''}`
    };
  }

  /** Can a body stand on this tile? Unknown grid means "assume yes". */
  /**
   * Walk toward somewhere FAR, by the road rather than the crow's line.
   *
   * `goTo` walks straight and only consults the grid once the body has
   * provably not moved. That is the right trade for a short hop, and it is
   * the wrong one for a long march: measured 2026-09-02, the seam walk slid
   * ALONG a wall for eleven beats - the body moved every beat, so `goTo`
   * answered ok every beat, while the distance to the seam went UP. Nothing
   * was ever stuck enough to trigger the fallback, and the errand died on its
   * own stall guard having learnt nothing.
   *
   * So a caller that knows it is crossing a room says so, and gets the grid
   * consulted FIRST. If there is no grid or no route the straight walk still
   * stands - this can only add a road, never remove one.
   *
   * NAMED `walkTheRoad`, NOT `routeTo`: that name is taken by the wrapper
   * around `arena_check_path` below, which answers a question ("is this
   * reachable, and how far on foot") rather than moving anything. tsc caught
   * the collision as a duplicate implementation; the two must not be confused
   * because one of them consults a service that is known to lie (#505) and
   * this one reads the grid the world already handed us.
   */
  async walkTheRoad(x: number, y: number): Promise<ActionResult> {
    const waypoint = await this.routedWaypoint(x, y);
    if (!waypoint) {
      return this.goTo(x, y);
    }
    const walked = await this.goTo(waypoint.x, waypoint.y);
    if (!walked.ok && /did not move/.test(String(walked.note ?? ''))) {
      // THE WORLD IS THE AUTHORITY ON WHERE A BODY MAY GO. The grid said this
      // step was clear and the walk moved nothing, which is the upstream
      // reachability lie (#505/#539/#545) and not something a better search
      // fixes. Shut the tile so the NEXT search picks another road, rather
      // than offering the same refused step until the errand's stall guard
      // ends the walk. Cheap to be wrong: the shut list is per room, cleared
      // with the grid, so a tile that was merely busy reopens shortly.
      const tile = `${Math.floor(waypoint.x / this.tilePx)},${Math.floor(waypoint.y / this.tilePx)}`;
      if (!this.shutTiles.has(tile)) {
        this.shutTiles.add(tile);
        console.log(`[route] the world refused tile ${tile} - shutting it and`
          + ` looking for another road (${this.shutTiles.size} shut here)`);
      }
    }
    return walked;
  }

  /**
   * The next place to aim for on a grid-computed route, in pixels.
   *
   * Not the whole path: one waypoint a beat, far enough to be worth a call
   * and near enough that the world's own straight walk can reach it without
   * meeting the wall we are getting round. Six tiles is about the 400px the
   * seam walk already steps.
   *
   * Returns null rather than guessing when there is no grid, no position, or
   * no route - the callers all treat that as "the straight answer stands".
   */
  private async routedWaypoint(x: number, y: number): Promise<{ x: number; y: number } | null> {
    const grid = await this.walkableGrid();
    const self = this.selfAt;
    if (!grid || !self) {
      return null;
    }
    const from = { x: Math.floor(self.x / this.tilePx), y: Math.floor(self.y / this.tilePx) };
    const to = { x: Math.floor(x / this.tilePx), y: Math.floor(y / this.tilePx) };
    const path = routeThrough(grid, from, to, this.shutTiles);
    if (!path?.length) {
      return null;
    }
    // THE FURTHEST TILE THE BODY CAN ACTUALLY WALK TO IN ONE LINE.
    //
    // Two measured failures shaped this, both on 2026-09-02:
    //
    // Taking the tile N steps along the path blindly sent the body through
    // the very wall the route went around, whenever the path turned inside
    // those N steps - it pinned at 41,24, the log alternating between the
    // real route and a useless re-route to the same refused tile.
    //
    // Taking only the leading STRAIGHT run fixed that and cost the speed: a
    // 4-connected route to anywhere diagonal is a staircase, so the run is
    // one tile, and the body crawled - 199 tiles to go, one tile a beat.
    //
    // Both are answered by asking the right question. The world's walk is a
    // straight line, so the waypoint may be any tile whose LINE is clear,
    // staircase or not. Walk the candidates outward and keep the last one
    // that passes; the first step always does, so there is always an answer.
    let step = path[0];
    for (let i = 1; i < path.length && i < ROUTE_LOOKAHEAD_TILES; i += 1) {
      if (!clearLine(grid, from, path[i], this.shutTiles)) {
        break;
      }
      step = path[i];
    }
    console.log(`[route] ${from.x},${from.y} -> ${to.x},${to.y}:`
      + ` the grid goes via ${step.x},${step.y} (${path.length} tiles of road)`);
    return {
      x: step.x * this.tilePx + this.tilePx / 2,
      y: step.y * this.tilePx + this.tilePx / 2
    };
  }

  private standable(tileX: number, tileY: number): boolean {
    const g = this.grid;
    if (!g) {
      return true;
    }
    if (tileX < 0 || tileY < 0 || tileY >= g.rows.length) {
      return false;
    }
    const row = g.rows[tileY];
    if (tileX >= row.length) {
      return false;
    }
    const glyph = row[tileX];
    return '.' === glyph || 'D' === glyph;
  }


  /** Every standable tile within `rings`, nearest first. For escapeWall(). */
  /**
   * Can a WALK END on this tile? Narrower than standable(), on purpose.
   *
   * `D` is a change point - a doorway - and a body may stand on one quite
   * happily, which is why standable() accepts it. A walk aimed at one is a
   * different question and the answer is no: the engine marks every change
   * point unwalkable in its OWN path-finder, so a destination on a door tile
   * produces no route and the body never takes a step, at any distance,
   * however many times it is asked (upstream PRs #505 and #539 - since shipped in
   * gateway build d8cce175, 2026-08-27T00:02Z, so this guard may now be
   * redundant rather than load-bearing. Measure before removing it.)
   *
   * What makes it expensive to find is that every check we have says yes.
   * `arena_check_path` answers PATH_FOUND for such a tile - measured, on the
   * very tile that would not move - and `arena_walkable_grid` draws it as
   * `D` under a legend that says you can stand on `.` and `D`. So the walk
   * is issued, everything agrees it should work, and nothing moves.
   *
   * Measured 2026-08-25: both royals stood in the inn on 4/646 and 1/217
   * mana with 731,755 and 599,366 copper, and failed to cross four tiles to
   * the cask across EIGHT different approach tiles, every one "still short".
   * Retire this the day those PRs deploy; until then a walk aims at floor.
   */
  private walkEndsHere(tileX: number, tileY: number): boolean {
    const g = this.grid;
    if (!g) {
      return true;
    }
    if (tileX < 0 || tileY < 0 || tileY >= g.rows.length) {
      return false;
    }
    const row = g.rows[tileY];
    return tileX < row.length && '.' === row[tileX];
  }

  /**
   * Every tile near here a walk can actually END on, nearest first.
   *
   * `floorOnly` is the default because both callers - the wedge rescue and
   * the walk to the cask - are choosing somewhere to WALK TO.
   */
  private standableTilesNear(tileX: number, tileY: number, rings = 8, floorOnly = true): Array<{ x: number; y: number }> {
    const found: Array<{ x: number; y: number; d: number }> = [];
    for (let dx = -rings; dx <= rings; dx += 1) {
      for (let dy = -rings; dy <= rings; dy += 1) {
        if (0 === dx && 0 === dy) {
          continue;
        }
        if (floorOnly ? !this.walkEndsHere(tileX + dx, tileY + dy) : !this.standable(tileX + dx, tileY + dy)) {
          continue;
        }
        found.push({
          x: (tileX + dx) * this.tilePx + this.tilePx / 2,
          y: (tileY + dy) * this.tilePx + this.tilePx / 2,
          d: Math.hypot(dx, dy)
        });
      }
    }
    return found.sort((a, b) => a.d - b.d).map(({ x, y }) => ({ x, y }));
  }

  /** The nearest tile that can actually be stood on, spiralling outward. */
  private nearestStandable(tileX: number, tileY: number, rings = 6): { x: number; y: number } | null {
    if (this.standable(tileX, tileY)) {
      return { x: tileX * this.tilePx + this.tilePx / 2, y: tileY * this.tilePx + this.tilePx / 2 };
    }
    for (let r = 1; r <= rings; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) {
            continue;
          }
          if (this.standable(tileX + dx, tileY + dy)) {
            return { x: (tileX + dx) * this.tilePx + this.tilePx / 2, y: (tileY + dy) * this.tilePx + this.tilePx / 2 };
          }
        }
      }
    }
    return null;
  }

  async goTo(x: number, y: number): Promise<ActionResult> {
    // THE IMMOVABLE (Glenn's standing order, 2026-08-15): a character
    // posted to a spot is never walked anywhere by anything - not by the
    // model, not by harness housekeeping, not by a one-off nudge that
    // seemed reasonable at the time. Every movement path in this file
    // funnels through goTo/useDoor, so refusing here is the refusal that
    // actually holds.
    if (this.immovable) {
      return { ok: false, note: 'posted here and staying: this character does not move' };
    }
    // WHERE WE STOOD BEFORE ASKING. See the progress check at the end: a walk
    // that reports ok while the body has not moved is the single failure that
    // hid five separate broken movement sites in npc.ts, because every one of
    // them logged `approach -> ok` while the tile never changed.
    const stoodAt = this.selfAt ? { ...this.selfAt } : null;
    // A COORDINATE THAT IS NOT A NUMBER IS NOT A DESTINATION. Every walk in
    // this file funnels through here, and twelve of the callers reach it by
    // multiplying an object's tileX/tileY - which arena.ts declares
    // required, on the strength of a gateway comment saying visibleEntities()
    // drops anything it could not compute them for. Measured 2026-08-24,
    // that is no longer true: closeOn() sent NaN and the gateway answered
    // "Invalid arguments for tool arena_move_to: expected number", which
    // surfaced to the round as the target being unreachable. So the body
    // stood still, blamed the maze, and the log said "could not close".
    // Guarding here rather than at each caller is the version that cannot be
    // forgotten by the thirteenth one.
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { ok: false, note: `asked to walk to (${x}, ${y}), which is not a place` };
    }
    try {
      const arrived = await this.approach(x, y);
      // "ON THE WAY" MUST MEAN THE BODY MOVED (2026-08-27).
      //
      // This answered ok for a walk that made ZERO progress, and that single
      // lie is what hid five separate broken movement sites in npc.ts: every
      // one of them logged `approach __nearest__ -> ok` on a beat where the
      // tile did not change, so the logs read like a body walking and showed
      // a body standing. Lord Gemma spent over an hour that way, parked 21
      // tiles from thirty-one hostiles on full health and full mana, while
      // Sir Qwen made 124 xp/min in the same room.
      //
      // `unstick()` and `escapeWall()` both learned this lesson already. This
      // is the same check at the one door every walk in the file goes through,
      // so the next site that cannot move says so on its first beat instead of
      // hiding for an hour.
      if (!arrived && stoodAt) {
        const now = await this.whereAmI();
        const before = { tileX: Math.floor(stoodAt.x / this.tilePx), tileY: Math.floor(stoodAt.y / this.tilePx) };
        if (now && now.tileX === before.tileX && now.tileY === before.tileY) {
          // THE GRID KNOWS A WAY THE STRAIGHT LINE DOES NOT (2026-09-02).
          //
          // `arena_move_to` walks a straight line, so a wall between here and
          // the destination stops it dead and it says so honestly. Four
          // successive geometric guesses were tried against that on the seam
          // walk and all four failed - see routeThrough's note. The room's
          // own collision grid was cached in memory throughout.
          //
          // Only on the second attempt, deliberately: the straight walk is
          // right nearly always and costs one call, while this costs a grid
          // read plus a search. Nothing that already works pays for it.
          const detour = await this.routedWaypoint(x, y);
          if (detour) {
            await this.approach(detour.x, detour.y);
            const after = await this.whereAmI();
            if (after && (after.tileX !== before.tileX || after.tileY !== before.tileY)) {
              return { ok: true, note: `on the way (round a wall, via ${after.tileX},${after.tileY})` };
            }
          }
          return { ok: false, note: `did not move from tile ${now.tileX},${now.tileY}` };
        }
      }
      return { ok: true, note: arrived ? 'got there' : 'on the way' };
    } catch (error) {
      return { ok: false, note: whatWentWrong(error) };
    }
  }

  /**
   * The nearest enemy of any name, if one stands within the leash.
   *
   * Hunting by a preferred name walked knights past three closer Trees to
   * reach a Tree Punch, aggroing everything on the way - the classic death
   * march. The nearest thing IS the strategy, and past the leash nothing
   * is worth the walk.
   */
  /**
   * The nearest enemy to a POINT - the crown's coordinates, not our own.
   * A bodyguard kills what is closest to the person he guards.
   */
  huntNearestTo(x: number, y: number, leashTiles = LEASH_TILES): { label: string; distanceTiles: number } | null {
    const enemies = this.nearby.filter(
      (object) => 'enemy' === object.kind && false !== object.alive && 0 < Number(object.hp ?? 1) && !this.isShunned(object)
    );
    if (0 === enemies.length) {
      return null;
    }
    const dist = (e: (typeof enemies)[number]) =>
      Math.hypot(e.tileX * this.tilePx + this.tilePx / 2 - x, e.tileY * this.tilePx + this.tilePx / 2 - y);
    const best = enemies.reduce((a, b) => (dist(a) <= dist(b) ? a : b));
    const distanceTiles = dist(best) / this.tilePx;
    if (distanceTiles > leashTiles) {
      return null;
    }
    return { label: best.label, distanceTiles };
  }

  /**
   * The most ISOLATED enemy within the leash - the anti-swarm choice.
   * Walking to the nearest of fourteen crypt-mates aggroed the other
   * thirteen; the pull doctrine picks the one with the fewest packmates
   * within four tiles (ties go to the closer one), the sovereign opens
   * on it from range, and the fight comes to the pair one body at a
   * time. Anchor on a point (the partner, a wounded charge) or on our
   * own feet when no anchor is given.
   */
  /**
   * Targets proven unhittable - attacked from every angle the orbit
   * ladder knows with not a point of damage landing (a body behind a
   * house, across a collision knot). Keyed by name and tile, forgotten
   * after a few minutes so a respawn or a repositioned fight gets a
   * fresh chance.
   */
  private shunned = new Map<string, number>();

  shunTarget(label: string, tileX: number, tileY: number, minutes = 5): void {
    this.shunned.set(`${label}@${tileX},${tileY}`, Date.now() + minutes * 60_000);
  }

  /**
   * Is there a walking route to this tile, as the server reckons it?
   *
   * The leash is a straight line, and a straight line means nothing in a
   * maze: on Miller's Stair, 20,245 of 33,792 tiles are wall, so an enemy
   * twelve tiles away as the crow flies is routinely on the far side of
   * several of them. Locking onto one of those produces a fight that never
   * happens - Sir Qwen held a mark at 12.5 tiles for minutes on end while
   * neither his own walk nor the server's semi-auto chase could reach it.
   *
   * One gateway call, asked only before committing to a target. An error or
   * a silent answer counts as reachable: this is here to rule targets OUT on
   * good evidence, never to refuse a fight because a probe went missing.
   */
  async routeExists(tileX: number, tileY: number): Promise<boolean> {
    return (await this.routeTo(tileX, tileY)).reachable;
  }

  /**
   * The whole answer about a route, not just whether one exists.
   *
   * `routeExists()` made this exact call and threw away everything but the
   * boolean - including `pathLengthTiles`, which is the number that would
   * have prevented the incident its own docstring describes. Measured
   * 2026-08-26 on Lord Gemma: a Hollow Caller **5.7 tiles away in a straight
   * line and 55 tiles away on foot**. It answered `reachable: true`, so the
   * screen passed it, the ninety-second lock closed on it, and he spent the
   * whole lock shuffling between two tiles at 0 xp/min on full bars while
   * Sir Qwen made 124 xp/min in the same room.
   *
   * `lineOfSight` rides along on the same reply and is kept for the same
   * reason: it is free here and it is the difference between a cast that
   * lands and one that dies on a rock.
   */
  async routeTo(tileX: number, tileY: number): Promise<{
    reachable: boolean; pathTiles: number | null; lineOfSight: boolean | null;
  }> {
    try {
      const route = await this.arena.call('arena_check_path', {
        agent_id: this.agentId,
        row: tileY,
        column: tileX
      });
      const len = Number(route?.pathLengthTiles);
      return {
        reachable: false !== route?.reachable,
        pathTiles: Number.isFinite(len) ? len : null,
        lineOfSight: 'boolean' === typeof route?.lineOfSight ? route.lineOfSight : null
      };
    } catch {
      // FAIL OPEN, as before: an unanswered probe must not shun the world.
      return { reachable: true, pathTiles: null, lineOfSight: null };
    }
  }

  /**
   * Is this route so much longer on foot than it looks that the target is
   * effectively somewhere else?
   *
   * Deliberately generous, and deliberately NOT tuned to the one case that
   * prompted it. Some inflation is normal in a room that is 60% wall
   * (world.ts: 20,245 of 33,792 tiles), so this only catches the gross
   * outliers - the 5.7-versus-55 shape - and lets a route with an honest bend
   * through. Every rejection logs both numbers, so the threshold can be set
   * from live pairs later instead of from this one incident.
   */
  static circuitous(straightTiles: number, pathTiles: number | null): boolean {
    if (null === pathTiles || !Number.isFinite(straightTiles) || straightTiles <= 0) {
      return false;
    }
    return pathTiles > Math.max(straightTiles * 3, straightTiles + 10);
  }

  private isShunned(target: { label: string; tileX: number; tileY: number }): boolean {
    const key = `${target.label}@${target.tileX},${target.tileY}`;
    const until = this.shunned.get(key);
    if (!until) {
      return false;
    }
    if (Date.now() > until) {
      this.shunned.delete(key);
      return false;
    }
    return true;
  }

  /**
   * WHO TO KILL NEXT, using everything the server now tells us.
   *
   * The order is not "nearest" any more, because nearest is what made a
   * body wander between two equidistant trees while a third chewed on
   * it. The rules, in order:
   *
   *  1. ANYTHING ALREADY HITTING ME. An aggressor is taking health right
   *     now; every second it lives costs blood. Finish it first.
   *  2. THE WEAKEST THING IN REACH. Live hp arrived on 2026-08-15, so a
   *     50hp Tree dies in half the swings of a 90hp Tree Punch - killing
   *     it first removes an attacker from the field sooner. Fewer live
   *     enemies is less incoming damage; this is the whole strategy.
   *  3. THE ONE STANDING ALONE. Neighbours within three tiles are the
   *     pack that joins in when the fight starts. All else equal, take
   *     the isolated one.
   *  4. THE CLOSER ONE. Distance is the tiebreak, not the rule.
   */
  chooseTarget(leashTiles = LEASH_TILES): { label: string; distanceTiles: number; tileX: number; tileY: number; hp: number; why: string } | null {
    // NEVER PICK A FIGHT ON THE RIM. The harness cannot clamp the ENGINE:
    // in semi_auto combat the server walks the body to its target itself,
    // so a tree chosen five tiles from the southern boundary drags the
    // character to row 145 no matter how carefully our own walks are
    // bounded. The only lever that reaches the engine is WHICH enemy we
    // name - so anything near the edge is simply never named.
    const g = this.grid;
    const w = g?.w ?? 145;
    const h = g?.h ?? 145;
    const edge = 6;
    // HIT BACK, ALWAYS. Standing order (Glenn, 2026-08-15): the moment
    // something attacks this character, it is the target until it is dead -
    // no leash, no rim rule, no scoring. Those filters exist to stop us
    // PICKING a bad fight; they must never stop us FINISHING one that was
    // picked for us. Before this, a tree that opened fire from fifteen
    // tiles out, or from near the boundary, was filtered away before the
    // aggressor discount could apply, and the character stood there being
    // chewed on while it looked for someone more convenient to fight.
    const hitters = new Set(this.arena.aggressorIndexes());
    if (hitters.size) {
      const retaliation = this.nearby
        .filter((o) => 'enemy' === o.kind && false !== o.alive && 0 < Number(o.hp ?? 1) && hitters.has(o.objectIndex))
        .sort((a, b) => (Number(a.hp ?? 100) - Number(b.hp ?? 100))
          || ((a.distanceFromSelf ?? 0) - (b.distanceFromSelf ?? 0)));
      const mark = retaliation[0];
      if (mark) {
        return {
          label: mark.label,
          distanceTiles: (mark.distanceFromSelf ?? 0) / this.tilePx,
          tileX: mark.tileX,
          tileY: mark.tileY,
          hp: Number(mark.hp ?? 100),
          why: 'it hit us - finish it',
        };
      }
    }
    const live = this.nearby.filter(
      (o) => 'enemy' === o.kind
        && false !== o.alive
        && 0 < Number(o.hp ?? 1)
        && !this.isShunned(o)
        && this.standable(o.tileX, o.tileY)
        && o.tileX > edge && o.tileY > edge && o.tileX < w - edge && o.tileY < h - edge
        && (o.distanceFromSelf ?? 9999) / this.tilePx <= leashTiles
    );
    if (!live.length) {
      return null;
    }
    const attackers = new Set(this.arena.aggressorIndexes());
    const packOf = (o: ArenaObject) =>
      live.filter((n) => n !== o && Math.hypot(n.tileX - o.tileX, n.tileY - o.tileY) <= 3).length;
    const scored = live.map((o) => {
      const dist = (o.distanceFromSelf ?? 0) / this.tilePx;
      const hp = Number(o.hp ?? 100);
      const hitting = attackers.has(o.objectIndex);
      // Lower is better. An aggressor gets a huge discount; health is the
      // main term; company and distance are modifiers.
      // Company is now the deadliest term, not distance. Since the trees
      // started fighting back, a fight next to three of its friends is
      // four sets of teeth: the pack penalty is heavier than any health
      // difference, so a lone 90hp Punch beats a 60hp Tree standing in a
      // crowd. Threat, when the server reports it, adds to the same
      // caution.
      const threat = Number(o.threat ?? 0) || 0;
      const score = (hitting ? -1000 : 0) + hp + packOf(o) * 60 + threat * 20 + dist * 4;
      return { o, dist, hp, hitting, pack: packOf(o), score };
    }).sort((a, b) => a.score - b.score);
    const best = scored[0];
    return {
      label: best.o.label,
      distanceTiles: best.dist,
      tileX: best.o.tileX,
      tileY: best.o.tileY,
      hp: best.hp,
      why: best.hitting
        ? 'it is hitting me'
        : `weakest in reach (${best.hp}hp, ${best.pack} others near, ${best.dist.toFixed(1)} tiles)`
    };
  }

  huntCandidates(
    anchor?: { x: number; y: number } | null,
    leashTiles = LEASH_TILES,
    max = 3,
    nearestFirst = false
  ): Array<{ label: string; distanceTiles: number; tileX: number; tileY: number }> {
    const enemies = this.nearby.filter(
      (object) => 'enemy' === object.kind && false !== object.alive && 0 < Number(object.hp ?? 1) && !this.isShunned(object)
    );
    if (0 === enemies.length) {
      return [];
    }
    const distTo = anchor
      ? (e: (typeof enemies)[number]) =>
        Math.hypot(e.tileX * this.tilePx + this.tilePx / 2 - anchor.x, e.tileY * this.tilePx + this.tilePx / 2 - anchor.y) / this.tilePx
      : (e: (typeof enemies)[number]) => (e.distanceFromSelf ?? 0) / this.tilePx;
    const within = enemies.filter((e) => distTo(e) <= leashTiles);
    const packOf = (e: (typeof enemies)[number]) =>
      enemies.filter((o) => o !== e && Math.hypot(e.tileX - o.tileX, e.tileY - o.tileY) <= 4).length;
    return within
      .slice()
      // At a firing post the CORRIDOR does the isolating - the nearest
      // body is by definition the one in the lane. Everywhere else,
      // isolation first keeps pulls from clipping packs.
      .sort(nearestFirst
        ? (a, b) => distTo(a) - distTo(b)
        : (a, b) => packOf(a) - packOf(b) || distTo(a) - distTo(b))
      .slice(0, max)
      .map((e) => ({ label: e.label, distanceTiles: distTo(e), tileX: e.tileX, tileY: e.tileY }));
  }

  huntIsolated(
    anchor?: { x: number; y: number } | null,
    leashTiles = LEASH_TILES
  ): { label: string; distanceTiles: number; tileX: number; tileY: number } | null {
    return this.huntCandidates(anchor, leashTiles, 1)[0] ?? null;
  }

  /** Does the map's own pathfinder reach that tile? A walled-off body is
   *  no target: an arrow lane and a walking lane fail together in this
   *  tileset, so PATH_FOUND is the terrain's word for "shootable". */
  async pathClearTo(tileX: number, tileY: number): Promise<boolean> {
    try {
      const answer = await this.arena.call('arena_check_path', {
        agent_id: this.agentId,
        row: tileY,
        column: tileX
      });
      return /PATH_FOUND/i.test(JSON.stringify(answer ?? {}));
    } catch {
      // Fail open: a probe hiccup must not paralyze the hunt.
      return true;
    }
  }

  huntNearest(leashTiles = 10): { label: string; distanceTiles: number; tileX: number; tileY: number } | null {
    const enemies = this.nearby.filter(
      (object) => 'enemy' === object.kind && false !== object.alive && 0 < Number(object.hp ?? 1) && !this.isShunned(object)
        // A body standing off the map or inside a wall cannot be reached
        // and cannot be hit; chasing one is how a sovereign ends up
        // pinned at row 145 of a 145-row forest.
        && this.standable(object.tileX, object.tileY)
    );
    if (0 === enemies.length) {
      return null;
    }
    const best = enemies.reduce((a, b) =>
      (a.distanceFromSelf ?? Infinity) <= (b.distanceFromSelf ?? Infinity) ? a : b
    );
    const distanceTiles = (best.distanceFromSelf ?? 0) / this.tilePx;
    if (distanceTiles > leashTiles) {
      return null;
    }
    return { label: best.label, distanceTiles, tileX: best.tileX, tileY: best.tileY };
  }

  /**
   * Try every visible door tile in turn, walking right up to each before
   * forcing the crossing. Doors are usually two tiles wide and a body
   * blocks only one; the polite path picks the nearest tile and gives up
   * when it is occupied, which is how a warlock spent an evening jailed
   * in an inn.
   */
  async forceDoors(): Promise<ActionResult> {
    const doors = (this.view?.doors ?? []).filter((door) => !door.locked);
    if (0 === doors.length) {
      return { ok: false, note: 'no doors visible from here' };
    }
    for (const door of doors.slice(0, 6)) {
      try {
        await this.approach(door.x, door.y);
        const crossed = await this.arena.call('arena_enter_door', {
          row: door.row,
          column: door.column
        });
        if (crossed?.entered) {
          return { ok: true, note: `forced the door to ${crossed.scene ?? 'the next room'}` };
        }
      } catch {
        // Try the next tile; one refusal is exactly what this is for.
      }
    }
    return { ok: false, note: 'every visible door refused' };
  }

  /** Stand down: clear any lingering battle engagement before resting. */
  async stopFighting(): Promise<ActionResult> {
    try {
      await this.arena.call('arena_stop', { agent_id: this.agentId });
      return { ok: true, note: 'stood down' };
    } catch (error) {
      return { ok: false, note: whatWentWrong(error) };
    }
  }

  /** Ask the engine to nudge a body off whatever it is wedged against. */
  /** This body's tile right now, straight from the world, or null. */
  private async whereAmI(): Promise<{ tileX: number; tileY: number } | null> {
    try {
      const state = (await this.observe())?.ownPlayer?.state as { x?: number; y?: number } | undefined;
      return state && 'number' === typeof state.x && 'number' === typeof state.y
        ? { tileX: Math.floor(state.x / this.tilePx), tileY: Math.floor(state.y / this.tilePx) }
        : null;
    } catch {
      return null;
    }
  }

  /**
   * What one work station in this room can make, and whether we may make it.
   *
   * The answer carries each recipe's skill gate, its inputs, its outputs and
   * `meetsGate` - so this replaces guessing at professions entirely. The
   * harness spent a week inferring recipes from the `gameplayHint` string,
   * which rotates through a narrow subset: 48 samples surfaced Blacksmithing
   * and Woodcraft and not one recipe for Tailoring, Jewelcrafting, Cooking or
   * Smelting. This asks instead.
   */
  async recipesAt(objectId: number, skill?: string): Promise<ActionResult> {
    if (!this.can('craft')) {
      return { ok: false, note: 'this character does not craft' };
    }
    try {
      const said = await this.arena.call('arena_recipes', {
        agent_id: this.agentId,
        object_id: objectId,
        ...(skill ? { skill } : {})
      });
      // `canMake`, NOT `meetsGate`. I invented the second name from the tool
      // description and it does not exist - every recipe would have read as
      // out of reach for ever, and a crafting beat keyed on it would never
      // have crafted anything, silently. Checked against the world's own
      // publicRecipe() (professions.js) rather than guessed a second time.
      if (false === said?.listed) {
        return { ok: false, note: `no recipe list here: ${String(said?.reason ?? 'not a station')}` };
      }
      const rows = Array.isArray(said?.recipes) ? said.recipes : null;
      if (!rows) {
        // FAIL LOUD ON A SHAPE WE DO NOT RECOGNISE. Coercing to [] is how a
        // working tool reports an empty world.
        return { ok: false, note: `unrecognised recipes reply: ${Object.keys(said ?? {}).join(',')}` };
      }
      const makeable = rows.filter((r: Record<string, unknown>) => true === r.canMake);
      this.recipesSeen = rows.map((r: Record<string, unknown>) => ({
        key: String(r.key ?? ''),
        skill: String(r.skillKey ?? ''),
        level: Number(r.requiredLevel ?? 0),
        canMake: true === r.canMake,
        inputs: r.inputs
      }));
      console.log(`[craft] ${rows.length} recipe(s) at object ${objectId}`
        + `${skill ? ` for ${skill}` : ''}, ${makeable.length} within our skill`
        + (makeable.length ? `: ${makeable.slice(0, 6).map((r: Record<string, unknown>) => r.key).join(', ')}` : ''));
      return { ok: true, note: `${rows.length} recipes, ${makeable.length} makeable` };
    } catch (error) {
      return { ok: false, note: whatWentWrong(error) };
    }
  }

  /**
   * Work one gathering node in reach.
   *
   * THE TOOL IS CARRIED, NOT WIELDED - "the world selects the strongest
   * matching tool in the satchel". So a pickaxe rides alongside the
   * greatblade and the weapon slot is never touched, which is the whole
   * reason mining is safe for a knight under the standing no-unequip order.
   */
  /**
   * WHICH TRADE WORKS THIS NODE, read off its name.
   *
   * The world does not label a seam with its skill, it labels it "iron ore",
   * so the mapping lives here. Taken from the world's own catalogue
   * (deploy/world/professions-catalogue.mjs, read 2026-08-27) rather than
   * from intuition: every mining node outputs an ore or coal, every foraging
   * node a herb, fibre, timber, carrot, pepper, garlic, berry, pumpkin or
   * grape, and every fishing node is a rod or a net.
   *
   * A word set, not a regular expression, and for a reason with scar tissue:
   * a `` written into one of these through a heredoc arrived as a literal
   * backspace, and the resulting pattern matched nothing at all while looking
   * perfectly correct in review.
   */
  /** Trade beats offered, and how many found work. See gatherNearby. */
  private saidBadCorner = false;
  private tradeOffered = 0;
  private tradeWorked = 0;
  /**
   * NODES THAT REFUSED, AND WHEN THEY MAY BE ASKED AGAIN (2026-08-27).
   *
   * The first per-gather line ever printed was this, three times, identically:
   *
   *   [trade] pot garlic at 17.7t - 0 of 4 charges taken
   *           (Object 256 is not in the current scene, the-valley-inn.)
   *
   * He was standing IN the Oathstone - the world feed said so and the garlic
   * is seeded there - while the gateway still placed his session in the inn
   * he had left a minute earlier. A scene desync, not a bad object list.
   *
   * What made it repeat for ever was ours: nothing remembered the refusal, so
   * every offer walked at the same phantom again. This is the same ledger the
   * bays got and the unstocked-item list got before them, in its third
   * costume. Short-lived on purpose - a desync clears in a minute or two, and
   * a node genuinely worked out will refuse again and re-shun itself.
   */
  private nodeShun = new Map<number, number>();
  /** The node this body is part-way through walking to. See gatherNearby. */
  private approaching: number | null = null;
  private tradeCharges = 0;

  private static readonly MINING_WORDS = new Set(
    ['ore', 'seam', 'vein', 'coal', 'salt']
  );

  // HEAD NOUNS ONLY. `wild`, `bramble` and `hedge` were on this list and are
  // modifiers, not things - "Wild Boar" would have been claimed as forage.
  // Every name here is the output of a real node in the world catalogue.
  private static readonly FORAGING_WORDS = new Set(
    ['herb', 'herbs', 'fibre', 'fiber', 'timber', 'log', 'logs', 'carrot',
     'carrots', 'pepper', 'peppers', 'garlic', 'strawberry', 'strawberries',
     'pumpkin', 'pumpkins', 'grape', 'grapes']
  );

  private static readonly FISHING_WORDS = new Set(
    ['fishing', 'rod', 'net', 'fish']
  );

  private skillForNode(label: string): string | null {
    const words = String(label ?? '').toLowerCase().split(/[^a-z]+/);
    if (words.some((w) => Actions.MINING_WORDS.has(w))) {
      return 'mining';
    }
    if (words.some((w) => Actions.FISHING_WORDS.has(w))) {
      return 'fishing';
    }
    if (words.some((w) => Actions.FORAGING_WORDS.has(w))) {
      return 'foraging';
    }
    return null;
  }

  /**
   * Work a node that is ALREADY underfoot, or say plainly that none is.
   *
   * Deliberately incapable of a journey. The round offers this beat once in
   * sixteen; if the answer were "walk across the maze to a seam" it would be
   * an errand, and errands are what cost this pair their evening. So the
   * radius is small, the answer is honest, and a beat that finds nothing
   * falls straight back into the fight.
   *
   * Charges matter: a copper seam holds 8 and refills in 90 seconds, so
   * standing on a fresh one and taking every charge is the whole yield. The
   * loop takes up to `swings`, and stops the moment the world stops giving.
   */
  async gatherNearby(
    allowed: readonly string[],
    withinTiles: number,
    swings = 4
  ): Promise<ActionResult> {
    if (!this.can('craft')) {
      return { ok: false, note: 'this character does not gather' };
    }
    if (!allowed.length) {
      return { ok: false, note: 'no trades on this sheet' };
    }
    const reach = withinTiles * this.tilePx;
    const nodes = this.nearby
      .filter((o) => this.isResourceNode(o))
      .filter((o) => {
        const skill = this.skillForNode(String(o.label ?? ''));
        return null !== skill && allowed.includes(skill);
      })
      .filter((o) => {
        const gap = o.distanceFromSelf;
        return 'number' === typeof gap && Number.isFinite(gap) && gap <= reach;
      })
      .filter((o) => {
        if ('number' !== typeof o.objectId) {
          return true;
        }
        const until = this.nodeShun.get(o.objectId) ?? 0;
        if (until > Date.now()) {
          return false;
        }
        // Prune on read: the map was written to and never cleaned, which is a
        // slow leak keyed by every object id this body ever failed against.
        this.nodeShun.delete(o.objectId);
        return true;
      })
      .sort((a, b) => (a.distanceFromSelf ?? 0) - (b.distanceFromSelf ?? 0));
    this.tradeOffered += 1;
    // TRY THE NEXT ONE (2026-08-27, and this is what was actually blocking
    // every charge). This took `[0]` - the nearest candidate - and gave up if
    // it refused. Measured in the Oathstone with Lord Gemma standing on the
    // ground itself: the gateway was leaking another room's profession
    // objects into the observation at 16-21 tiles, the real carrot and fibre
    // sat at ~22, so a phantom sorted FIRST on every single beat, failed, and
    // the beat ended. The real node was never once reached.
    //
    // Nearest-first is still the right order; stopping at the first refusal
    // was the mistake.
    // FINISH THE WALK YOU STARTED (2026-08-27, and this is why the Oathstone
    // kept coming back dry).
    //
    // Iterating candidates was right - a phantom used to block the real node
    // behind it. But abandoning the approach every beat was not: the nodes
    // there sit 17-22 tiles out, a walk takes several beats, and each beat
    // the loop walked one leg toward the nearest, got "on the way", and then
    // tried the NEXT candidate and walked toward that one instead. Four
    // nodes, four half-walks, no arrivals, and `gather_nearby -> ok` with no
    // `[trade]` line at all because workNode never reached a gather.
    //
    // So a body already walking to a node keeps walking to THAT node until it
    // arrives, is refused, or the node leaves the feed. Only then does the
    // next candidate get a turn.
    const holding = null !== this.approaching
      ? nodes.filter((o) => o.objectId === this.approaching)
      : [];
    if (null !== this.approaching && !holding.length) {
      this.approaching = null;
    }
    let walking = false;
    for (const candidate of (holding.length ? holding : nodes)) {
      this.approaching = 'number' === typeof candidate.objectId ? candidate.objectId : null;
      const worked = await this.workNode(candidate, swings);
      if (worked) {
        this.approaching = null;
        return worked;
      }
      if (null !== this.approaching) {
        // Still walking to this one - do not start a second walk this beat.
        walking = true;
        break;
      }
    }
    {
      // COUNT THE BEATS THAT DO NOTHING (peer review, 2026-08-27):
      // "incapable of a journey" and "silently does nothing fifteen times
      // in sixteen" look identical from outside until somebody counts. A
      // radius of twelve tiles filtered by an allowlist is empty on most
      // beats in most rooms, and that is fine - but it has to be VISIBLE,
      // or this beat's whole value rests on an assumption nobody checked.
      // Every tenth offer says the running tally, so the ratio is readable
      // straight off the log instead of being inferred from silence.
      if (0 === this.tradeOffered % 10) {
        console.log(`[trade] ${this.tradeWorked} of ${this.tradeOffered} offers found`
          + ` something of ours within ${withinTiles} tiles;`
          + ` ${this.tradeCharges} charges actually taken`);
      }
      // A WALK IN PROGRESS IS NOT AN EMPTY ROOM (adversarial review,
      // 2026-08-27, and this would have wasted the first trip that ever got
      // through a door).
      //
      // Both outcomes used to leave by this same line. `KnightsRound`
      // .completed() reads the note against /nothing of ours|gave nothing|no
      // charges/ to decide a gather was DRY, and four dry gathers end the
      // trip. So a node that was found, was in range, and simply needed more
      // than four beats to walk to would report itself as four empty rooms
      // and retire the errand before the body arrived - the same shape as the
      // Oathstone's four half-walks, one layer further out.
      //
      // The distinction has to survive into the note, because the note is the
      // only thing the round gets to see.
      if (walking) {
        return { ok: true, note: 'on the way to a node of ours' };
      }
      return { ok: true, note: 'nothing of ours to gather within reach' };
    }
  }

  /**
   * Work one node, or answer null so the caller can try the next.
   *
   * Null rather than a failure result, because a refused node is not a
   * refused BEAT - there may be a real one standing behind the phantom.
   */
  private async workNode(
    node: ArenaObject,
    swings: number
  ): Promise<ActionResult | null> {
    const label = String(node.label ?? 'node');
    const gap = (node.distanceFromSelf ?? 0) / this.tilePx;
    if (gap > 1.5) {
      if (!Number.isFinite(node.tileX) || !Number.isFinite(node.tileY)) {
        this.approaching = null;
        return null;
      }
      const toX = node.tileX * this.tilePx + this.tilePx / 2;
      const toY = node.tileY * this.tilePx + this.tilePx / 2;
      const walked = await this.goTo(toX, toY);
      if (!walked.ok) {
        this.approaching = null;
        return null;
      }
      // ARRIVED, OR STILL WALKING? (2026-08-27) `goTo` answers ok for a walk
      // that is under way as well as one that is finished - deliberately, so
      // a bending multi-beat route is not read as failure. Gathering on "on
      // the way" is how the tool run bought from the doorway, and here it
      // produced TOO_FAR_AWAY against a node that was real, in scene, and
      // simply not reached yet.
      //
      // Crucially it must NOT be shunned for that: the node is good, the walk
      // is merely unfinished. Answer null and let the next beat carry on.
      if (/on the way/i.test(walked.note ?? '')) {
        // Keep the claim: the caller must not switch nodes mid-walk.
        return null;
      }
    }
    const id = node.objectId;
    if ('number' !== typeof id) {
      this.approaching = null;
      return null;
    }
    let took = 0;
    let last = '';
    for (let i = 0; i < swings; i += 1) {
      const said = await this.gather(id, label);
      if (!said.ok) {
        last = said.note ?? '';
        break;
      }
      took += 1;
      last = said.note ?? '';
    }
    // `TOO_FAR_AWAY`, WITH UNDERSCORES (2026-08-27, found by review against
    // the artifact rather than the code). This read `/too far/i` and the
    // world's word is `TOO_FAR_AWAY`, so the pattern never matched once. The
    // guard written specifically to stop an unfinished walk being punished
    // was dead, and every unfinished walk was blacklisted for two minutes
    // instead - 5 of the 6 refusals ever recorded went down the shun path,
    // and `not reached yet - keeping it` appears in no log ever written.
    //
    // That, not the walk-one-node-at-a-time fix, is the live mechanism behind
    // the Oathstone coming back dry, and it is a precondition for ever
    // re-enabling the trip.
    if (0 === took && /too[ _]far/i.test(last)) {
      // Too far is not a bad node - it is an unfinished walk. Leave it alone
      // so the next beat can close the gap.
      console.log(`[trade] ${label} at ${gap.toFixed(1)}t not reached yet - keeping it`);
      return null;
    }
    if (0 === took) {
      // Set it aside rather than walking at it again next offer. Two minutes
      // outlasts a scene desync and costs nothing if the node was merely
      // empty - an emptied vein refuses again and re-shuns itself.
      this.nodeShun.set(id, Date.now() + NODE_SHUN_MS);
      this.approaching = null;
      console.log(`[trade] ${label} at ${gap.toFixed(1)}t gave nothing`
        + `${last ? ` (${last})` : ''} - trying the next`);
      return null;
    }
    this.tradeCharges += took;
    this.tradeWorked += 1;
    console.log(`[trade] ${label} at ${gap.toFixed(1)}t - ${took} of ${swings} charges taken`);
    return { ok: true, note: `gathered ${took} from ${label}` };
  }

  async gather(objectId: number, label = 'node'): Promise<ActionResult> {
    if (!this.can('craft')) {
      return { ok: false, note: 'this character does not gather' };
    }
    try {
      const said = await this.arena.call('arena_gather', {
        agent_id: this.agentId,
        object_id: objectId
      });
      // `!said?.gathered`, not `false === said?.gathered`. The strict form
      // only catches a literal false and lets an ABSENT field sail through as
      // success - which is how a refusal gets logged as a haul. This matches
      // tradeResult(), the one refusal check in this file that production has
      // actually exercised.
      if (!said?.gathered) {
        const why = String(said?.reason ?? said?.message ?? 'refused');
        console.log(`[craft] gather ${label} refused: ${why}`);
        return { ok: false, note: `could not work ${label}: ${why}` };
      }
      // itemKey/quantity/experience/skillKey/node - the world's own words
      // (profession-rules.js). `item` and `gained` were mine and are not real.
      // The node's remaining charges matter: they are SHARED and refill on a
      // timer, so a beat that does not read them stands at an empty rock.
      const key = String(said?.itemKey ?? '');
      const qty = Number(said?.quantity ?? 0);
      const xp = Number(said?.experience ?? 0);
      const charges = Number((said?.node as Record<string, unknown> | undefined)?.charges ?? -1);
      if (!key) {
        return { ok: false, note: `unrecognised gather reply: ${Object.keys(said ?? {}).join(',')}` };
      }
      console.log(`[craft] ${label} gave ${qty} x ${key} (+${xp} ${String(said?.skillKey ?? 'skill')} xp`
        + `${charges >= 0 ? `, ${charges} charge(s) left` : ''})`);
      return { ok: true, note: `${qty} ${key} from ${label}`
        + `${0 === charges ? ' - node is empty now' : ''}` };
    } catch (error) {
      return { ok: false, note: whatWentWrong(error) };
    }
  }

  /**
   * Make one batch at a station in reach.
   *
   * One transaction: every input consumed and every output added together, or
   * nothing at all. That is the world's contract, not ours, which is why this
   * needs no rollback of its own.
   */
  async craft(recipe: string, objectId: number, quantity = 1): Promise<ActionResult> {
    if (!this.can('craft')) {
      return { ok: false, note: 'this character does not craft' };
    }
    try {
      const said = await this.arena.call('arena_craft', {
        agent_id: this.agentId,
        object_id: objectId,
        recipe,
        quantity: Math.max(1, Math.trunc(quantity))
      });
      // There is no `ok` on this reply - `crafted` is the real flag. The
      // refusal carries `reason`, and INPUT_CHANGED can arrive with `lost`,
      // so a partial failure says so rather than reading as a clean refusal.
      if (true !== said?.crafted) {
        const why = String(said?.reason ?? 'refused');
        const lost = said?.lost;
        console.log(`[craft] ${recipe} refused: ${why}${lost ? ` (lost ${JSON.stringify(lost)})` : ''}`);
        return { ok: false, note: `could not make ${recipe}: ${why}` };
      }
      const quality = said?.quality ? ` (${String(said.quality)})` : '';
      console.log(`[craft] made ${quantity} x ${recipe}${quality}`);
      return { ok: true, note: `made ${quantity} ${recipe}${quality}` };
    } catch (error) {
      return { ok: false, note: whatWentWrong(error) };
    }
  }

  /**
   * What a counter actually stocks.
   *
   * The market file exists because this was learned by walking to a shop and
   * failing to buy things. This asks the counter instead.
   */
  async merchantCatalog(objectId: number): Promise<ActionResult> {
    if (!this.can('craft') && !this.can('trade')) {
      return { ok: false, note: 'this character does not shop' };
    }
    try {
      const said = await this.arena.call('arena_merchant_catalog', {
        agent_id: this.agentId,
        object_id: objectId
      });
      // `offers`, not `items` or `catalog` - both of those were mine. As
      // written this reported every counter in the world as empty stock while
      // answering ok, which is precisely the silent lie this file spends most
      // of its comments hunting.
      const rows = Array.isArray(said?.offers) ? said.offers : null;
      if (!rows) {
        return { ok: false, note: `unrecognised catalog reply: ${Object.keys(said ?? {}).join(',')}` };
      }
      const truncated = true === said?.truncated;
      console.log(`[shop] counter ${objectId} stocks ${rows.length}`
        + `${truncated ? ` of ${said?.totalOffers ?? '?'} (cut)` : ''} line(s)`
        + (rows.length ? `: ${rows.slice(0, 8).map((r: Record<string, unknown>) => r.key ?? r.label).join(', ')}` : ''));
      return { ok: true, note: `${rows.length} lines stocked${truncated ? ' (truncated)' : ''}` };
    } catch (error) {
      return { ok: false, note: whatWentWrong(error) };
    }
  }

  async unstick(): Promise<ActionResult> {
    const before = await this.whereAmI();
    try {
      const result = await this.arena.call('arena_unstick', { agent_id: this.agentId });
      if ('ALREADY_CHANGING_SCENE' === result?.reason) {
        // The one wedge a nudge cannot fix: the server thinks this body is
        // mid-door forever. Only a fresh login clears it.
        return { ok: false, note: 'wedged mid-transition (ALREADY_CHANGING_SCENE)' };
      }
      // A NUDGE IS NOT AN ESCAPE. The same defect escapeWall() carried until
      // this morning: reporting success for the CALL rather than the outcome.
      // This answered "shook loose" whatever happened, so a cure that moved
      // nothing read identically to one that worked, and the only way to tell
      // was to notice the body still there six beats later.
      //
      // Measured 2026-08-25 on Lord Gemma: four wedge episodes on tile (34,8)
      // across 23 minutes - 02:09, 02:22, 02:31, 02:32 - every one answering
      // "unstick -> moved". He does genuinely relocate between them, so this
      // is NOT what pinned him; that is the reachability lie upstream, where
      // arena_check_path answers PATH_FOUND for a tile the body then will not
      // walk to (PRs #505/#539/#545). THOSE SHIPPED: the gateway went to
      // d8cce175 at 2026-08-27T00:02Z carrying them, plus #580 (a stalled
      // scene handoff wedges a character permanently) and #582 (silent
      // action failures). Re-measure before citing any of this as current. But a cure that cannot fail
      // is a cure nobody can measure, and the next wedge that IS a no-op
      // would hide exactly as well as this one would have.
      const now = await this.whereAmI();
      const shifted = !before || !now
        || before.tileX !== now.tileX || before.tileY !== now.tileY;
      return shifted
        ? { ok: true, note: 'shook loose' }
        : { ok: false, note: `nudged and did not move, still on tile ${now.tileX},${now.tileY}` };
    } catch (error) {
      return { ok: false, note: whatWentWrong(error) };
    }
  }

  /**
   * Sever the session on purpose. The run loop notices the disconnect on
   * its next call and logs back in fresh, which is the only known cure for
   * the mid-transition wedge. Manual version of this saved Lord Gemma once
   * already; now the body can prescribe it for itself.
   */
  /**
   * Log back in on the session this character already holds.
   *
   * reconnect() below severs the session and leaves the reconnect to run()'s
   * own loop, which is right when the session is alive but wedged. It is
   * useless when the session is already GONE: arena_disconnect fails with the
   * same "is not connected to Reldens" as everything else, so nothing is
   * severed and nothing re-logs in. Fanshawe sat that way for fifty minutes,
   * playing to an empty room on a perfect thirty-six second rhythm.
   *
   * A busker has no reflex round to notice, so this is the direct repair.
   */
  async relogin(): Promise<ActionResult> {
    try {
      await this.arena.call('arena_login', { agent_id: this.agentId });
      return { ok: true, note: 'logged back in' };
    } catch (error) {
      return { ok: false, note: whatWentWrong(error) };
    }
  }

  async reconnect(): Promise<ActionResult> {
    try {
      await this.arena.call('arena_disconnect', { agent_id: this.agentId });
      return { ok: true, note: 'session severed; the loop logs back in fresh' };
    } catch (error) {
      return { ok: false, note: whatWentWrong(error) };
    }
  }

  /**
   * Walk toward a target and STOP AT REACH, not on top of it.
   *
   * This used to aim at the enemy's own tile centre - distance zero - with no
   * reference to any range at all. For a knight that is correct and it is
   * what he still gets: `longestArtReach()` answers 0 for a body with no
   * castable art (Sir Qwen's pool is 0), and a zero stop aims at the tile
   * exactly as before. For a caster it was the whole bug, undoing the
   * server's spacing every time a swing was refused.
   */
  async closeOn(target: string, stopShortTiles?: number): Promise<ActionResult> {
    const enemy = this.findNearby(target, 'enemy');
    if (!enemy) {
      return { ok: false, note: `there is no "${target}" here` };
    }
    // THROUGH THE GRID, LIKE EVERY OTHER WALK. This used to call
    // approach() raw, which skipped the walkable-grid check that goTo
    // does - so a target sitting outside the map (or inside scenery)
    // walked a body to the boundary and pinned it there, swinging at
    // something it could never reach while the gateway answered "ok" to
    // everything. Every movement path goes through one guarded door now.
    if (!Number.isFinite(enemy.tileX) || !Number.isFinite(enemy.tileY)) {
      // Say which one, so a gateway that stops reporting tiles is diagnosed
      // from the log rather than from a body that will not advance.
      return { ok: false, note: `${enemy.label} is here but the world did not say where` };
    }
    const atX = enemy.tileX * this.tilePx + this.tilePx / 2;
    const atY = enemy.tileY * this.tilePx + this.tilePx / 2;
    const stop = Math.max(0, stopShortTiles ?? this.longestArtReach());
    // AIM AT THE TILE. THE PATHFINDER OWNS THE ROUTE (2026-08-27).
    //
    // This used to interpolate the stop point along the STRAIGHT LINE from
    // body to target. In a room that is 60% wall (world.ts: 20,245 of 33,792
    // tiles) that point is usually inside rock, and `approach()` then snaps it
    // to the nearest standable tile - which is a valid answer to the wrong
    // question, and an unstable one: `selfAt` shifts a few pixels each beat,
    // so the snap flips between two tiles and the body shuffles for ever.
    // Measured on Lord Gemma: pinned between (38,20) and (39,20) for a full
    // ninety-second lock at 0 xp/min on full bars, while Sir Qwen - who is
    // melee, so his stop is 0 and he simply aimed AT the tile - made 124
    // xp/min in the same room.
    //
    // The hold below is what keeps a cloth caster out of a grub's teeth, and
    // it stays. Aiming at the tile only decides where to walk when we are out
    // of reach; the hold decides when to stop walking at all.
    const aimX = atX;
    const aimY = atY;
    if (stop > 0 && this.selfAt) {
      const dx = this.selfAt.x - atX;
      const dy = this.selfAt.y - atY;
      const away = Math.hypot(dx, dy);
      // A TILE OF SLACK, the same margin npc.ts's locked-target branch
      // already learned it needed (`> reach + 1`). Without it this fights the
      // server's own `keep_distance_tiles` spacing over sub-tile staleness in
      // the feed: we walk in, the server nudges out, we walk in again. The
      // slack costs at worst one refused swing and buys the end of that
      // tug-of-war - which is the same trade serverIsClosing() exists to make.
      const wantPx = (stop + 1) * this.tilePx;
      if (away <= wantPx) {
        // ALREADY IN REACH. Walking now would only shorten a gap that is
        // already short enough to cast across, and it is the walk itself
        // that puts a cloth caster in a grub's teeth.
        return { ok: true, note: `${enemy.label} is ${(away / this.tilePx).toFixed(1)} tiles off, within ${stop} + 1 slack - holding` };
      }
    }
    const walked = await this.goTo(aimX, aimY);
    return walked.ok
      ? { ok: true, note: stop > 0 ? `closing on ${enemy.label} to ${stop.toFixed(1)} tiles` : `closing on ${enemy.label}` }
      : walked;
  }

  /** Gap to the last OUT_OF_RANGE target, as the refusing verdict measured
   *  it - the baseline the next refusal's gap is judged against. */
  private chaseWatch: { target: string; gapTiles: number; at: number } | null = null;

  /**
   * Should this refused swing stand still and let the server's own chase
   * finish, instead of closing the gap ourselves?
   *
   * TWO DRIVERS MAKE A BODY JITTER (2026-08-24). The gateway's rule is that
   * whatever moved a body most recently owns it. Under semi_auto the server
   * chases the target itself, and a refused OUT_OF_RANGE swing used to
   * answer with closeOn() unconditionally - so our arena_move_to cancelled
   * the chase mid-stride, the body stayed out of range, the next swing was
   * refused, and we moved again. On the spectator that reads as bodies
   * glitching back and forth: one character's consecutive logged positions
   * reversed outright - a stretch north undone straight back south - and
   * the interleaving showed eleven of our movement calls against three
   * battle payloads reporting inBattle.
   *
   * But the chase is trusted on its measurements, never on its word. A
   * chase that is not actually shrinking the gap - a stuck route, a fleeing
   * target, a stale payload - would leave the body standing and swinging at
   * nothing forever, the exact failure the closeOn() call was written to
   * prevent. So the rule, with no numbers in it:
   *
   *   - Movement is suppressed only while the server says it is in battle,
   *     in a mode where it chases, AND the gap measured across successive
   *     refusals is demonstrably shrinking.
   *   - The first refusal of a chase holds one beat, purely to take the
   *     baseline the next refusal is measured against.
   *   - No measurement means no trust: a verdict without a distance, or a
   *     baseline stale enough to belong to a different fight, closes
   *     exactly as before.
   */
  private serverIsClosing(target: string, verdict: Record<string, unknown>): boolean {
    const chase = this.arena.chaseFromBattle();
    if (!chase || true !== chase.inBattle || 'semi_auto' !== chase.mode) {
      // No battle, or a mode in which the server does not chase: there is
      // nothing to defer to, so close as always. Deferring under a mode
      // with no server-side chase would stand the body still on the
      // strength of a flag that promises nothing.
      this.chaseWatch = null;
      return false;
    }
    const gap = Number(verdict.targetDistanceTiles);
    if (!Number.isFinite(gap)) {
      // "Demonstrably" means measured. A verdict carrying no distance
      // cannot show the chase working, so it does not get the benefit.
      this.chaseWatch = null;
      return false;
    }
    const baseline = this.chaseWatch;
    this.chaseWatch = { target, gapTiles: gap, at: Date.now() };
    if (!baseline || baseline.target !== target) {
      // First refusal of this chase: hold one beat to take the baseline
      // the next refusal is judged against. The beat is the cheapest
      // possible measurement, and moving instead costs the whole loop
      // this exists to break.
      return true;
    }
    if (Date.now() - baseline.at > CHASE_BASELINE_FRESH_MS) {
      // A STALE BASELINE IS NOT EVIDENCE OF A CHASE - IT IS THE ABSENCE OF
      // ONE, AND IT MUST CLOSE (2026-08-26).
      //
      // This was folded into the branch above and so answered "hold", which
      // the docstring has always claimed it did not. The freshness window is
      // 30s and the live refusal cadence is 31-74s apart, so EVERY refusal
      // looked like the first one, every refusal held, and the body never
      // closed at all. Measured on the new build within twelve minutes of a
      // restart: 21 holds against 9 closes and **zero damage_dealt events**
      // between the pair - a full-health caster and a full-health knight
      // standing among full-health enemies, deferring forever to a chase
      // that was not happening. Other characters in the same room were
      // fighting normally, so the world was not the problem.
      //
      // Holding is only ever right while the server is DEMONSTRABLY shutting
      // the gap, and a baseline this old demonstrates nothing. Take a fresh
      // one on the way past, and close.
      this.chaseWatch = { target, gapTiles: gap, at: Date.now() };
      return false;
    }
    if (gap < baseline.gapTiles) {
      // Demonstrably working: our arena_move_to would cancel the chase and
      // hand the gap straight back. Stay put and let it finish.
      return true;
    }
    // Successive refusals and the gap has not shrunk: the chase has
    // demonstrably stalled, and a body that keeps deferring to it stands
    // and swings at nothing. Close ourselves - and drop the baseline,
    // because the move we are about to make re-owns the body, so the next
    // refusal opens a fresh measurement rather than continuing this one.
    this.chaseWatch = null;
    return false;
  }

  /** What the last gateway responses said about being hurt, dead, or swarmed. */
  danger(): { damage: number; died: boolean; aggressors: number; landed: boolean } {
    return this.arena.danger();
  }

  /**
   * Log the real verdict arena_basic_attack/arena_use_action now carry
   * (server PR #133, merged 2026-08-14) - every swing in this file used to
   * report "ok: true, swung at X" unconditionally regardless of what the
   * server actually said, so a refused attack (NO_MANA, CONDITION_NOT_MET,
   * OUT_OF_RANGE) looked identical in the log to a landed one. Observability
   * only for now: this does not change what any caller returns to the round
   * loop, just makes a silent refusal visible so the real refusal rate can
   * be measured before anything reacts to it (2026-08-15).
   * `condition` (CONDITION_NOT_MET) is a {key,property,comparison,value}
   * object, not a string - a first version of this interpolated it raw and
   * printed "[object Object]" for every one. The server's own `note` field
   * is already human-readable text (action-verdict.js), so prefer that and
   * fall back to the structured fields only if it is missing. OUT_OF_RANGE
   * is also NOT a true refusal - the action still sends (a target can step
   * back into reach mid-flight) - so it is worded "flagged", not "refused",
   * to avoid inflating the refusal count this exists to measure.
   */
  private logAttackVerdict(
    label: string,
    body: unknown,
    target?: { label?: string; tileX?: number; tileY?: number } | null
  ): void {
    if (!body || 'object' !== typeof body) {
      return;
    }
    const b = body as Record<string, unknown>;
    if (false !== b.ok) {
      return;
    }
    const reason = String(b.reason ?? 'unknown');
    // A CORPSE IS NOT A TARGET, AND THE WORLD JUST SAID SO.
    //
    // `TARGET_NOT_FIGHTABLE` means "the target's body is DEATH". Until now
    // this was logged and nothing else - so the next beat re-read the same
    // stale hp, picked the same corpse, and spent another swing on it.
    //
    // The selectors upstream already guard on `false !== alive` AND `hp > 0`,
    // and both guards pass here: the corpse arrives with NO `alive` field at
    // all (arena.ts assumes absent means a payload that only lists the
    // living, which stopped being true), and its hp reading is stale - the
    // merged build adds `hpIsStale` for exactly this. So the only reliable
    // signal that a body is dead is the server refusing to fight it, and
    // that signal was being thrown away.
    //
    // Shunned briefly rather than for ever: corpses respawn, and the shun
    // list already expires on its own.
    if ('TARGET_NOT_FIGHTABLE' === reason && target?.label
      && 'number' === typeof target.tileX && 'number' === typeof target.tileY) {
      this.shunTarget(target.label, target.tileX, target.tileY, 1);
    }
    if ('string' === typeof b.note && b.note) {
      const verb = 'OUT_OF_RANGE' === reason ? 'flagged' : 'refused';
      console.log(`[attack-verdict] ${label} ${verb}: ${reason} - ${b.note}`);
      return;
    }
    const detail =
      'NO_MANA' === reason ? ` (needed ${b.needed}, have ${b.have})`
      : 'CONDITION_NOT_MET' === reason
        ? ` (${(b.condition as Record<string, unknown> | undefined)?.property ?? (b.condition as Record<string, unknown> | undefined)?.key ?? 'unmet'})`
      : 'OUT_OF_RANGE' === reason ? ` (target ${b.targetDistanceTiles}t, reach ${b.reachTiles}t)`
      : '';
    const verb = 'OUT_OF_RANGE' === reason ? 'flagged' : 'refused';
    console.log(`[attack-verdict] ${label} ${verb}: ${reason}${detail}`);
  }

  /**
   * Hit whatever is currently hitting this character, named by the id the
   * BATTLE payload gives - not by anything found in an observation.
   *
   * This exists because arena_observe is truncated by the gateway at 49,152
   * bytes (bugs.md #10) and the object list is the part that gets cut. An
   * attacker missing from `nearby` is invisible to every targeting path we
   * have, so the character stands there taking hits from something it cannot
   * "see". The battle payload always names its aggressors, so strike from
   * that instead: no map, no observation, no leash - just the id of the thing
   * currently doing damage.
   */
  async strikeBack(): Promise<ActionResult | null> {
    if (!this.can('fight')) {
      return null;
    }
    const hitters = this.arena.aggressorIndexes();
    if (!hitters.length) {
      return null;
    }
    const mark = hitters[0];
    // RETALIATE WITH SOMETHING THAT REACHES (2026-08-27).
    //
    // This threw the equipped weapon's basic swing and nothing else, while
    // attack() above has had the reach-art ladder for a day. For a caster the
    // two drivers therefore disagreed about what he is armed with: the attack
    // beat cast attackBullet at 3.9 tiles and landed, and every retaliate beat
    // poked with attackShort at 0.8 from the 2-tile ring the server's own
    // spacing holds him on - a guaranteed miss, thrown at the one moment
    // something is actually biting him.
    //
    // Measured live: Lord Gemma slid 469 -> 202 of 620 hp in forty seconds,
    // ten `strike back ... OUT_OF_RANGE` verdicts against aggressors at
    // 1.3-1.6 tiles, returning nothing while a scuttler took 15hp a hit. He
    // was earning through it, so this was never a reason to stop fighting -
    // it was a reason to hit back with the free bolt he already owns.
    //
    // The aggressor is named by objectIndex, not by label, so the gap comes
    // off the battle feed rather than findNearby().
    const seen = this.nearby.find((o) => o.objectIndex === mark);
    const px = seen?.distanceFromSelf;
    const markGap = 'number' === typeof px && Number.isFinite(px) ? px / this.tilePx : null;
    if (null !== markGap && markGap > this.basicReachTiles()) {
      const art = this.reachingArt(markGap);
      if (art) {
        const cast = await this.arena.call('arena_use_action', {
          agent_id: this.agentId,
          action_type: art.key,
          target_object_index: mark
        });
        this.spendFromSnapshot(art.mp);
        this.logAttackVerdict(`${art.key} back at ${mark}`, cast);
        const verdict = cast && 'object' === typeof cast ? cast as Record<string, unknown> : null;
        if (!verdict || false !== verdict.ok) {
          return { ok: true, note: `struck back at ${mark} with ${art.key}` };
        }
        // Refused: fall through to the swing, which owns the chase.
      }
    }
    const result = await this.arena.call('arena_basic_attack', {
      agent_id: this.agentId,
      target_object_index: mark,
    });
    const failed = result && 'object' === typeof result && 'error' in (result as Record<string, unknown>);
    this.logAttackVerdict(`strike back at ${mark}`, result);
    return failed
      ? { ok: false, note: `strike back at ${mark} refused: ${String((result as Record<string, unknown>).error).slice(0, 60)}` }
      : { ok: true, note: `struck back at ${mark}` };
  }

  /**
   * Everything this character can perceive right now, shaped for the log.
   *
   * Own position and health live in the caller; this is the rest of the
   * world: enemies with their tile, health, distance, whether they are
   * currently hitting us, and - the part that matters for the wedging -
   * whether the collision grid claims their tile is WALKABLE. Enemy bodies
   * are absent from the grid (bugs.md #8), so "[on blocked tile]" almost
   * never appears and every enemy reads as open floor. That is the defect,
   * recorded beat by beat instead of argued about.
   */
  worldSnapshot(): {
    enemies: { label: string; tile: string; hp: string; dist: string; hitting: boolean; blocked: boolean }[];
    objects: { label: string; tile: string }[];
    players: { name: string; tile: string }[];
  } {
    const hitters = new Set(this.arena.aggressorIndexes());
    const enemies = this.nearby
      .filter((o) => 'enemy' === o.kind && false !== o.alive && 0 < Number(o.hp ?? 1))
      .sort((a, b) => (a.distanceFromSelf ?? 0) - (b.distanceFromSelf ?? 0))
      .slice(0, 12)
      .map((o) => ({
        label: String(o.label ?? '?'),
        tile: `(${o.tileX},${o.tileY})`,
        hp: (undefined === o.hp || null === o.hp) ? '' : ` ${o.hp}/${o.hpMax ?? '?'}hp`,
        dist: ((o.distanceFromSelf ?? 0) / this.tilePx).toFixed(1),
        hitting: hitters.has(o.objectIndex),
        blocked: !this.standable(o.tileX, o.tileY),
      }));
    const objects = this.nearby
      .filter((o) => 'enemy' !== o.kind)
      .slice(0, 10)
      .map((o) => ({ label: String(o.label ?? o.kind ?? '?'), tile: `(${o.tileX},${o.tileY})` }));
    const players = this.people
      .slice(0, 8)
      .map((p) => ({
        name: String(p.playerName ?? p.name ?? p.label ?? '?'),
        tile: `(${Math.floor((p.state?.x ?? 0) / this.tilePx)},${Math.floor((p.state?.y ?? 0) / this.tilePx)})`,
      }));
    return { enemies, objects, players };
  }

  /** The room at a glance: how many hostiles, and how near the nearest. */
  fieldReport(): { enemies: number; nearestTiles: number | null } {
    // HP, NOT JUST `alive`. Measured 2026-08-31: 157 observations carried an
    // enemy at 0 hp that had no `alive` field at all, so this counted every
    // corpse in the room as a live hostile. This number gates the quiet
    // checks - gathering, resting, the shrine errand - so a field full of
    // bodies never read as calm and those beats never came.
    const enemies = this.nearby.filter((object) =>
      'enemy' === object.kind && false !== object.alive && 0 < Number(object.hp ?? 1));
    const nearest = enemies.reduce(
      (best: number | null, e) => {
        const d = (e.distanceFromSelf ?? NaN) / this.tilePx;
        return Number.isFinite(d) && (null === best || d < best) ? d : best;
      },
      null
    );
    return { enemies: enemies.length, nearestTiles: nearest };
  }

  /** Own hp as the battle payload last reported it, if it has. */
  battleHp(): { value: number; total: number } | null {
    return this.arena.ownHpFromBattle();
  }

  /** Choose the reflex battle style. Used by the knight's round, once per outing. */
  async setTactics(style: string, rules?: Record<string, unknown>): Promise<void> {
    try {
      await this.arena.call('arena_set_tactics', { agent_id: this.agentId, style, ...(rules ?? {}) });
    } catch {
      // The round survives a refused preference; the default style still fights.
    }
  }

  async attack(target: string | undefined): Promise<ActionResult> {
    if (!this.can('fight')) {
      return { ok: false, note: 'this character does not fight' };
    }
    if (!target) {
      return { ok: false, note: 'nothing named to hit' };
    }
    const enemy = this.findNearby(target, 'enemy');
    if (!enemy) {
      // Not a monster: perhaps the person this character has agreed to fight.
      // Enemies resolve first so a duel never shadows the room's real
      // dangers, and the opponent path is gated on the match itself.
      const opponent = this.opponentNamed(target);
      if (opponent) {
        const result = await this.arena.call('arena_basic_attack', {
          agent_id: this.agentId,
          target_session_id: opponent.sessionId,
          target_player_id: opponent.playerId
        });
        this.logAttackVerdict(`swing at ${opponent.label}`, result, opponent);
        return { ok: true, note: `swung at ${opponent.label}` };
      }
      return { ok: false, note: `there is no "${target}" here to hit` };
    }
    // Attacking targets the objectIndex (layer_name+tile_index), a different
    // value from the objectId dialogue uses - see the comment on ArenaObject
    // in arena.ts and on target_object_index in the gateway's own tools.
    // CAST WHAT REACHES, RATHER THAN SWING AT NOTHING AND THEN WALK IN.
    //
    // This is the melee driver, and it is not the tactics call. `attackRange`
    // is read in exactly ONE place - npc.ts sends it to the server as
    // keep_distance_tiles - and the server's spacing loses every argument
    // with this method, because whatever moved the body most recently owns
    // it. So the sequence was: a 0.8-tile staff cannot reach, the swing is
    // refused, closeOn() walks a cloth caster onto the grub's own tile, and
    // the spacing that was just asked for is undone. 93 times in one hour.
    //
    // Measured on Lord Gemma over 303 lines where he could see a grub: the
    // nearest sits at a median 3.9 tiles, his swing reaches 0.8, and 9% of
    // beats could land at all. 261 swings against 9 casts. He owns arts
    // that reach 3.8 and 4.7 and was throwing a staff poke instead.
    //
    // Sir Qwen is deliberately untouched by this: reachingArt() skips the
    // basic swing and requires the mana, and his pool is 0, so he gets null
    // and swings his greatblade exactly as before - which is right, because
    // his 252 damage comes from the weapon, not from a skill.
    const gapPx = enemy.distanceFromSelf;
    const gapTiles = 'number' === typeof gapPx && Number.isFinite(gapPx) ? gapPx / this.tilePx : null;
    // THE GAP HAS TO BE WORTH STANDING OFF FOR, not merely past the swing.
    // Gated on `> basicReach` alone, a knight one tile from a grub cast a
    // 3.8-tile spell at point-blank instead of swinging the greatblade that
    // does his damage - caught by the knight test, not by reasoning.
    // A PAID art waits for the full standoff margin - see worthCasting. A
    // FREE one only has to out-reach the swing, because there is nothing to
    // weigh against it. Without this split a caster with an empty pool poked
    // at 0.8 tiles for hours with a 3.9-tile bolt in his book.
    const reaching = null !== gapTiles ? this.reachingArt(gapTiles) : null;
    const freeArtReaches = null !== gapTiles
      && gapTiles > this.basicReachTiles()
      && null !== reaching
      && reaching.mp <= 0;
    if (null !== gapTiles
      && (freeArtReaches || gapTiles > this.basicReachTiles() + MIN_REACH_GAIN_TILES)) {
      const art = this.reachingArt(gapTiles);
      if (art) {
        // CAST HERE RATHER THAN THROUGH useSkill(), and the reason is its
        // return: useSkill() answers `{ ok: true }` unconditionally after the
        // call and only LOGS the verdict, so a refused cast is indisputable
        // in the log and invisible to every caller. Returning that from here
        // would have been a standstill - a cast refused for cooldown, mana or
        // the server's own range check would report success, this method would
        // return before the chase machinery below, and closeOn() would decline
        // to move because the target is already inside our cached reach. The
        // body would stand and cast nothing, every beat, and reflex.ts's
        // failure watchdog keys on the intent, so it would never see it
        // either (adversarial review, 2026-08-25).
        console.log(`[reach] ${enemy.label} at ${gapTiles.toFixed(1)}t is past the swing`
          + ` (${this.basicReachTiles()}t) - casting ${art.key} (${art.reachTiles}t)`);
        const cast = await this.arena.call('arena_use_action', {
          agent_id: this.agentId,
          action_type: art.key,
          target_object_index: enemy.objectIndex
        });
        this.spendFromSnapshot(art.mp);
        this.logAttackVerdict(`${art.key} on ${enemy.label}`, cast, enemy);
        const castVerdict = cast && 'object' === typeof cast ? cast as Record<string, unknown> : null;
        if (!castVerdict || false !== castVerdict.ok) {
          return { ok: true, note: `cast ${art.key} at ${enemy.label} from ${gapTiles.toFixed(1)} tiles` };
        }
        // Refused: say why, and fall through to the swing and the chase it
        // owns. That path is the one the watchdogs can already see.
        console.log(`[reach] ${art.key} refused (${String(castVerdict.reason ?? 'unknown')})`
          + ' - falling back to the swing and its chase');
      }
    }
    const result = await this.arena.call('arena_basic_attack', {
      agent_id: this.agentId,
      target_object_index: enemy.objectIndex
    });
    this.logAttackVerdict(`swing at ${enemy.label}`, result, enemy);
    // OUT OF RANGE MEANS WALK, NOT SWING AGAIN (2026-08-16). Measured live
    // in the grassland: every beat threw attackShort - which reaches 1.6
    // tiles - at bodies five and six tiles off, so nothing ever landed, and
    // the round read its own swings as fine because this returned ok
    // regardless. That is a whole character's worth of beats spent hitting
    // air, and it is why no XP and no coin appeared however many other
    // things got fixed.
    // The locked-target path in npc.ts already stops at weapon range; the
    // ordinary hunting beat had no distance check at all. Rather than
    // hardcode a reach here - it is 1.6 for a blade and 8.75 for a bow, and
    // it moves with what is equipped - take the server's own verdict and
    // spend the rest of the beat closing, so the NEXT swing is in reach.
    const verdict = result && 'object' === typeof result ? result as Record<string, unknown> : null;
    // ONLY WHEN THE SERVER REFUSED, and this condition is deliberate - it was
    // widened to every OUT_OF_RANGE for an afternoon on 2026-08-21 and that
    // was a mistake worth recording.
    //
    // An ACCEPTED swing (ok:true, reason merely flagged) means the server has
    // taken the order and is chasing the target itself under semi_auto. Our
    // own closeOn() issues arena_move_to, and the gateway is explicit that
    // "whatever moved the body most recently owns it" - so closing on an
    // accepted swing cancels the very chase that was about to land it, every
    // beat, and the gap oscillates instead of shutting: 9.4 tiles, 13.4, 9.0,
    // 10.0, for as long as it was left running.
    //
    // The thing that actually had them swinging at nothing was the tile size
    // (see world.ts's tilePxFor), not this. Widening it here only papered
    // over that while making the real fight worse.
    //
    // THE REFUSED HALF OF THE SAME COLLISION (2026-08-24): even a genuinely
    // refused swing must not close while the server is in battle, chasing
    // under semi_auto, and demonstrably shrinking the gap - closing then
    // cancels the chase exactly as it did on accepted swings, and the body
    // reverses back and forth on the spectator. serverIsClosing() below
    // holds our movement precisely as long as the chase is measurably
    // working, and not a refusal longer.
    if (verdict && false === verdict.ok && 'OUT_OF_RANGE' === verdict.reason) {
      if (this.serverIsClosing(enemy.label, verdict)) {
        return { ok: true, note: `too far to hit ${enemy.label} - the server is closing the gap itself, holding still` };
      }
      const closed = await this.closeOn(enemy.label);
      return closed.ok
        ? { ok: true, note: `too far to hit ${enemy.label} - closing instead` }
        : { ok: false, note: `too far to hit ${enemy.label} and could not close: ${closed.note}` };
    }
    return { ok: true, note: `swung at ${enemy.label}` };
  }

  /**
   * Use a named skill on something, which is the only way a fight looks like
   * anything in particular.
   *
   * Worth setting down, because everyone including me assumed otherwise: a
   * character's costume has nothing to do with how its attacks look. Every
   * class-path spritesheet in this world produces exactly four animations,
   * all of them walking, and there is no attack frame on any of them. The
   * swings and casts come from a separate set of effects keyed by SKILL, so
   * a mage in mage robes swinging the default attack is visually identical
   * to a swordsman doing the same thing. Dressing somebody as a mage does not
   * make them cast; casting makes them cast.
   *
   * The skills are real rows in the world and differ by class path: fireball
   * belongs to sorcerers, warlocks and journeymen, and a swordsman genuinely
   * does not have it. So what a character may use comes from its sheet rather
   * than from what it fancies, and asking for one it does not have is a plain
   * no rather than a silent fizzle.
   */
  /**
   * The way out for a character that has genuinely run out of ways to walk.
   *
   * It is the only thing in here that does not move a character by asking the
   * engine to move it, and it is deliberately unpleasant to reach for. Guy
   * spent real days in the volcano because every route out was refused and
   * nothing in his hands could tell the difference between "try again" and
   * "there is no way". This is that difference, made available once.
   *
   * The world does the actual moving, and even there it sets no position: the
   * character arrives at the inn on the inn's own return point, the same tile
   * anybody walking in off the street lands on. So the worst this can do is
   * put somebody at the bar who did not need to be.
   *
   * The wait afterwards is the point. Without one this stops being a last
   * resort and becomes a fast way across the map, and every locked door in the
   * world turns into a free trip home. An hour is long enough that a character
   * has to actually try the room it is in.
   */
  async giveUpAndWalkBack(): Promise<ActionResult> {
    if (!this.can('doors')) {
      return { ok: false, note: 'this character does not leave where it is' };
    }
    const waited = Date.now() - this.gaveUpAt;
    if (waited < GIVING_UP_AGAIN_MS) {
      const minutes = Math.ceil((GIVING_UP_AGAIN_MS - waited) / 60_000);
      return {
        ok: false,
        note:
          `already gave up and walked back once, and it is too soon to do it again: `
          + `${minutes} more minute${1 === minutes ? '' : 's'}. Whatever is wrong with this room `
          + `has to be walked out of. Try a door, or a different way across to one.`
      };
    }
    const result = await this.arena.call('arena_unstick', { agent_id: this.agentId });
    if (false === result?.moved) {
      // Not a failure worth spending the hour on: nothing moved, so nothing
      // was used up. ALREADY_AT_THE_INN is the common one and reads as a
      // character having lost track of where it is, which is worth saying.
      return {
        ok: false,
        note:
          'ALREADY_AT_THE_INN' === result?.reason
            ? 'already at the inn, so there is nowhere to be walked back to'
            : 'could not walk back just now; try again in a moment'
      };
    }
    this.gaveUpAt = Date.now();
    // Everything it thought it knew about where it was standing is now wrong.
    this.nearby = [];
    this.talking = null;
    return {
      ok: true,
      note:
        'gave up on getting out of there under your own steam and walked back to the inn, '
        + 'arriving at the door off the street. It cannot be done again for an hour.'
    };
  }

  /**
   * Wear the best of what the bag holds: every equipment item not yet
   * equipped gets put on. Run each rest, so the first bought sword goes
   * straight onto the belt instead of riding in the pack forever.
   */
  async equipBest(): Promise<ActionResult> {
    try {
      // READ TWICE BEFORE BELIEVING AN EMPTY PACK (2026-08-16). Measured:
      // this call answers correctly at login - both purses read whole - and
      // then hands back a keyless object at the town counter, so the fault
      // is intermittent, not structural. The likeliest window is the scene
      // handoff: this step was moved to the FIRST beat of the town visit
      // earlier today, which put it right where the gateway still answers
      // "not in that room yet", so that reorder made this more frequent
      // rather than less. The round compounds it by marking wornThisRest
      // spent BEFORE the action runs, so one bad read used to cost the
      // whole rest - nothing wore anything until the next trip.
      // A second read one beat later costs a single call and cannot make
      // anything worse: an empty pack is already the do-nothing case.
      let bag = await this.arena.call('arena_inventory', { agent_id: this.agentId });
      if (!((bag?.items ?? []) as unknown[]).length) {
        await new Promise((done) => setTimeout(done, 1_200));
        const again = await this.arena.call('arena_inventory', { agent_id: this.agentId });
        if (((again?.items ?? []) as unknown[]).length) {
          console.log(`[equip] first read came back empty; the retry found ${((again.items ?? []) as unknown[]).length} rows`);
          bag = again;
        }
      }
      type Piece = {
        key?: string;
        label?: string;
        equipment?: boolean;
        equipped?: boolean;
        details?: { modifiers?: Array<{ property?: string; value?: number }> };
      };
      // Weapons share ONE slot, so equipping every unworn piece in bag
      // order crowns whatever happens to be LAST - which is how a +5 axe
      // once shoved a +9 crescent axe out of the knight's hand. Score by
      // actual attack modifiers and wear exactly the best, plus a shield
      // (its own slot) if one is carried.
      const pieces = ((bag?.items ?? []) as Piece[]).filter((piece) => piece.equipment);
      if (0 === pieces.length) {
        // SAY WHY. Observed 2026-08-16: "equip_best -> ok - nothing to wear"
        // from a character provably holding a longbow, a helm and a spoon.
        // The old note could not distinguish the three ways that happens -
        // the call returned no rows at all, returned rows with no equipment
        // among them, or returned a shape with no `items` key to read - and
        // without telling them apart there is no way to know whether the
        // fault is the gateway, the pack, or this parse. A wrong guess here
        // costs an hour, so the reply describes itself instead.
        const rows = (bag?.items ?? []) as Piece[];
        const shape = bag && 'object' === typeof bag ? Object.keys(bag).join(',') : typeof bag;
        console.log(`[equip] nothing to wear: ${rows.length} rows back, 0 equipment; reply keys {${shape}}`);
        return { ok: true, note: `nothing to wear (${rows.length} rows in pack)` };
      }
      console.log(`[equip] ${pieces.length} equippable of ${((bag?.items ?? []) as Piece[]).length} rows`);
      // NAME THEM. "11 equippable" cannot answer the only question anyone
      // actually asks of this line - does he own any armour, and is he
      // wearing it - and that question came up the moment the greatblade
      // landed. One line per rest is cheap; guessing at the pack is not.
      console.log(`[equip] holding: ${pieces
        .map((p) => `${p.key ?? p.label}${p.equipped ? '*' : ''}`)
        .join(', ')}`);
      // arena_inventory carries NO stat fields (modifiers live only on
      // the watch feed), so power is ranked by the shop's own tier order,
      // with live modifiers as a bonus signal when they do appear.
      // Apostrophes are stripped so "Knight's Greatblade" (label) and
      // knight_greatblade (key) rank the same. The 2026-08-13 restock's
      // tiers sit on top: L35 relics, then the L15 arms, then the old
      // board. Foci ARE weapons - they take the weapon slot and scale
      // spell damage - so they must rank here or the exotic pass would
      // wear one LAST and shove the ranked blade out of the hand.
      const WEAPON_RANK = [
        'greatblade',
        'crystal focus',
        'steel longsword',
        'ember focus',
        'yew warbow',
        'ash longbow',
        'wide blade',
        'twin axe',
        'stone maul',
        'horn bow',
        'crescent axe',
        'curved sabre',
        'hunting bow',
        'iron sword',
        'pitted hatchet',
        'axe',
        'spear',
        'bodkin',
        // Old Jerr's cache weapon: charming, and strictly worse than
        // anything above it. Unranked it would ride the exotic pass and
        // shove the real blade out of the hand.
        'blackened spoon'
      ];
      const plainName = (piece: Piece) =>
        `${piece.key ?? ''} ${piece.label ?? ''}`.toLowerCase().replace(/_/g, ' ').replace(/'/g, '');
      const atkOf = (piece: Piece) => {
        const name = plainName(piece);
        const tier = WEAPON_RANK.findIndex((rung) => name.includes(rung));
        const fromTier = tier >= 0 ? (WEAPON_RANK.length - tier) * 100 : 0;
        const fromMods = (piece.details?.modifiers ?? []).reduce(
          (sum, mod) => sum + ((mod.property ?? '').includes('atk') ? (mod.value ?? 0) : 0),
          0
        );
        return Math.max(fromTier, fromMods);
      };
      const isKnownWeapon = (piece: Piece) =>
        WEAPON_RANK.some((rung) => plainName(piece).includes(rung));
      const bestWeapon = pieces.filter(isKnownWeapon).sort((a, b) => atkOf(b) - atkOf(a))[0];
      // The 2026-08-14 update opened six worn slots (weapon, shield,
      // armour, boots, gauntlets, helmet). arena_inventory never says
      // which slot a piece takes, so the slots are known here by name,
      // each row best-first - wearing row[0] must displace row[1], never
      // the other way around. Substrings dodge the hyphens the treasure
      // labels carry ("Empty-Mat Boots" answers to 'boots').
      const SLOT_RANKS: string[][] = [
        ['saltguard', 'shield'],
        ['depths plate', 'sepulchral vestment', 'traveler mail', 'spidersilk robes', 'jack'],
        ['boots'],
        ['ossuary vigil grips', 'grips'],
        ['ash mouth helm', 'helm']
      ];
      const slotIndexOf = (piece: Piece) =>
        SLOT_RANKS.findIndex((row) => row.some((rung) => plainName(piece).includes(rung)));
      const slotBests = SLOT_RANKS.map((row, slot) =>
        pieces
          .filter((piece) => !isKnownWeapon(piece) && slotIndexOf(piece) === slot)
          .sort(
            (a, b) =>
              row.findIndex((rung) => plainName(a).includes(rung))
              - row.findIndex((rung) => plainName(b).includes(rung))
          )[0]);
      // A piece no rank knows goes on FIRST, so every ranked choice
      // lands after it and keeps the slot - the +5-axe-over-crescent
      // lesson, generalized.
      const unknowns = pieces.filter((piece) => !isKnownWeapon(piece) && -1 === slotIndexOf(piece));
      const wanted = [...unknowns, bestWeapon, ...slotBests].filter(
        (piece): piece is Piece => null != piece && !piece.equipped
      ).slice(0, 8);
      if (0 === wanted.length) {
        return { ok: true, note: 'already wearing the best' };
      }
      let worn = 0;
      for (const piece of wanted) {
        // The schema says plainly: { item: key-or-label }.
        try {
          const put = await this.arena.call('arena_equip', {
            agent_id: this.agentId,
            item: piece.key ?? piece.label
          });
          if (put && false !== put.equipped) {
            worn += 1;
          }
        } catch {
          // Not wearable after all; the next rest tries again.
        }
      }
      return { ok: worn > 0, note: worn > 0 ? `now wearing the best (${worn} piece(s))` : 'could not equip anything' };
    } catch (error) {
      return { ok: false, note: whatWentWrong(error) };
    }
  }

  /**
   * Where the nearest visible drop lies, if the gateway shared positions.
   * The polite pick_up only reaches what is underfoot; a field of branches
   * twenty tiles off needs walking to.
   */
  nearestDropSpot(): { x: number; y: number } | null {
    let best: { x: number; y: number; d: number } | null = null;
    for (const drop of this.loot) {
      const spot = drop as unknown as { x?: number; y?: number; tileX?: number; tileY?: number; distanceFromSelf?: number };
      const x = spot.x ?? (undefined !== spot.tileX ? spot.tileX * this.tilePx + this.tilePx / 2 : undefined);
      const y = spot.y ?? (undefined !== spot.tileY ? spot.tileY * this.tilePx + this.tilePx / 2 : undefined);
      if (undefined === x || undefined === y) {
        continue;
      }
      const d = spot.distanceFromSelf ?? 0;
      if (!best || d < best.d) {
        best = { x, y, d };
      }
    }
    return best ? { x: best.x, y: best.y } : null;
  }

  /**
   * The nearest drop anywhere in the SCENE, by asking the world for a
   * full survey. The local loot list only knows what is underfoot; the
   * survey sees the whole room's harvest.
   */
  async farDropSpot(): Promise<{ x: number; y: number } | null> {
    try {
      const s = await this.arena.call('arena_survey', { agent_id: this.agentId });
      const spots: Array<{ x: number; y: number; d: number }> = [];
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) {
          for (const item of node) {
            walk(item);
          }
          return;
        }
        if (node && 'object' === typeof node) {
          const o = node as Record<string, unknown>;
          const isDrop =
            ('string' === typeof o.dropId || 'string' === typeof o.itemKey || 'string' === typeof o.drop_id)
            && ('number' === typeof o.tileX || 'number' === typeof o.x);
          if (isDrop) {
            const x = (o.x as number) ?? (o.tileX as number) * this.tilePx + this.tilePx / 2;
            const y = (o.y as number) ?? (o.tileY as number) * this.tilePx + this.tilePx / 2;
            spots.push({ x, y, d: (o.distanceFromSelf as number) ?? 0 });
          }
          for (const value of Object.values(o)) {
            if (value && 'object' === typeof value) {
              walk(value);
            }
          }
        }
      };
      walk(s);
      // Fallback: the prose survey names drop tiles even when the JSON
      // shape hides them.
      if (0 === spots.length && 'string' === typeof s?.survey) {
        const section = /DROPS?[^]*?(?=\n[A-Z]{3,}|$)/.exec(s.survey)?.[0] ?? '';
        for (const m of section.matchAll(/tile \((\d+),\s*(\d+)\)/g)) {
          spots.push({ x: Number(m[1]) * this.tilePx + this.tilePx / 2, y: Number(m[2]) * this.tilePx + this.tilePx / 2, d: 0 });
        }
      }
      if (0 === spots.length) {
        return null;
      }
      spots.sort((a, b) => a.d - b.d);
      return { x: spots[0].x, y: spots[0].y };
    } catch {
      return null;
    }
  }

  /**
   * Whether this is sellable cargo: not the character's own money, not
   * equipment worn or spare, not a consumable being kept, not a one-time
   * treasure piece. carriedBranches() and sellableItems() both answer from
   * this one predicate so the two questions - "how much cargo" and "what to
   * actually offer Gimly" - cannot quietly disagree again. They already had
   * once: sellableItems() briefly excluded neither money nor the tarnished
   * key, which would have put the character's own purse up for sale first
   * every rest.
   * The tarnished key held a second exclusion until 2026-08-15, on the
   * guess a sealed door might want it - a market ritual once burned a full
   * trip on four of them with nothing else to sell rather than risk it.
   * agentArena issue #114 (server content audit) confirmed no door in the
   * world is locked and the key opens nothing; its only function is a
   * 300-currency sale. It is ordinary cargo now.
   * The six Old Jerr cache items (user standing order, 2026-08-15: never
   * sell, drop, or destroy a once-only treasure, keep every one until told
   * otherwise) are already caught by !item.equipment since all six are
   * equipment-typed - but that protection is incidental to their gear slot,
   * not their irreplaceability, and a later change to how equipment gets
   * sold (spares, duplicates) would not know to except them. Named
   * explicitly here so the exclusion means what it says regardless of
   * what else this predicate learns to do with equipment later.
   */
  private isCargo(item: CarriedItem): boolean {
    return 'coins' !== item.key && !item.equipment && !item.usable && !TREASURE_ITEM_KEYS.has(item.key);
  }

  /** Sellable cargo riding in the pack - the load a death would spill,
   *  and the trigger for a bank run. Branches are worth ~1c so a
   *  branches-only counter starved the runs that actually pay. */
  carriedBranches(): number {
    // COPPERS DO NOT FILL A BAG (2026-08-16). This counts sellable cargo and
    // the round banks at 50 of it - so ~167 carried branches, worth about
    // 167 copper all told, held mustBank permanently true. The measured
    // result: the body reached the field, the round declared the bag full,
    // and it turned straight back to town. ZERO attacks in an hour, one
    // hunting tick, an endless town-grassland-town shuffle selling twigs at
    // a copper a call while boars worth ~224 each stood unfought.
    // A bank run exists to cash in a bag of VALUABLES. Excluding the
    // near-worthless keys means the trigger measures what it was always
    // meant to measure; the branches still sell during an ordinary rest,
    // last in the queue, and a pack too big for the gateway's byte cap is
    // survivable now that the salvage keeps its items (see arena.ts).
    return this.carried.reduce(
      (sum, item) => this.isCargo(item) && !LOW_VALUE_KEYS.has(item.key) ? sum + (item.quantity ?? 1) : sum,
      0
    );
  }

  /**
   * Every carried row that is cargo per isCargo() - key and the real owned
   * quantity, so a row the gateway genuinely reports stacked sells in one
   * call instead of one unit per tick (coins and the tarnished key are the
   * two things actually reported stacked; coins are excluded by isCargo(),
   * the key is not and sells this way). Nothing else arrives stacked -
   * branches are one row per unit - so this narrows how many calls a sell
   * needs for a stacked row, it does not bound the total. No name list:
   * the world already answers "you do not have that" for a wrong guess.
   */
  sellableItems(): { key: string; quantity: number }[] {
    const rows = this.carried
      .filter((item) => this.isCargo(item))
      .map((item) => ({ key: item.key, quantity: Math.max(1, item.quantity ?? 1) }));
    // Coppers-last. The round takes the FIRST row it has not already tried
    // and a rest is capped at 30 sells, so pack order decides what a town
    // trip is worth. A farming run comes back with well over a hundred
    // branch rows (they arrive one row per unit, never stacked) against a
    // handful of real loot, so an unsorted list can spend the whole budget
    // at a copper a call while a 1,600-copper canteen stack waits for a
    // trip that never comes. Observed 2026-08-16: '[purse] 23150 -> 23151
    // (+1)', repeatedly.
    // Sorted, not filtered: branches are still worth selling once the good
    // rows are gone, and they are also what carriedBranches() counts to
    // trigger a bank run - refusing to sell them would leave that trigger
    // permanently hot and march the body to town for ever. No price field
    // exists on a carried item (checked against a real arena_inventory
    // dump), so this ranks the one key the codebase already documents as
    // ~1c rather than inventing a price table that would rot.
    return rows.sort((a, b) => this.junkRank(a.key) - this.junkRank(b.key));
  }

  /** Sort key for sellableItems(): 1 for loot worth about a copper, 0 for
   *  everything else. Deliberately a rank and not a boolean so a second
   *  near-worthless drop can be slotted between the two without reworking
   *  the comparator. */
  private junkRank(key: string): number {
    return LOW_VALUE_KEYS.has(key) ? 1 : 0;
  }

  /** Copper in the purse right now, straight off the live pack: what
   *  tells the round an upgrade on the counter is affordable. */
  carriedCoins(): number {
    for (const item of this.carried) {
      const it = item as { key?: string; quantity?: number };
      if ('coins' === it.key) {
        return it.quantity ?? 0;
      }
    }
    return 0;
  }

  /** Everything carried, lowercased, for live gear-ownership checks. */
  carriedNames(): string[] {
    const out: string[] = [];
    for (const item of this.carried) {
      const it = item as { key?: string; label?: string };
      if (it.key) {
        out.push(it.key.toLowerCase().replace(/_/g, ' '));
      }
      if (it.label) {
        out.push(it.label.toLowerCase());
      }
    }
    return out;
  }

  /** How many healing draughts ride in the pack right now. */
  carriedPotions(): number {
    return this.carried.reduce((sum, item) => {
      const it = item as { key?: string; label?: string; quantity?: number };
      const name = `${it.key ?? ''} ${it.label ?? ''}`.toLowerCase();
      return name.includes('potion') ? sum + (it.quantity ?? 1) : sum;
    }, 0);
  }

  /** Mana draughts riding in the pack, by true quantity - they stack as
   *  ONE inventory row, which is how a name-counting heuristic once let
   *  a Magus quietly hoard a shelf of them (user: "TOO MANY MAGIC
   *  POTIONS!!"). */
  carriedDraughts(): number {
    return this.carried.reduce((sum, item) => {
      const it = item as { key?: string; label?: string; quantity?: number };
      const name = `${it.key ?? ''} ${it.label ?? ''}`.toLowerCase();
      return name.includes('draught') ? sum + (it.quantity ?? 1) : sum;
    }, 0);
  }

  /** The partner's numeric playerId, if they are visible right now. */
  partnerPlayerId(partnerName: string): number | null {
    const wanted = partnerName.trim().toLowerCase();
    const person = this.people.find((p) => {
      const name = (p.playerName ?? p.name ?? p.label ?? '').trim().toLowerCase();
      return name === wanted && null != p.playerId;
    });
    return person ? Number(person.playerId) : null;
  }

  private lastPartyInvite = 0;

  /**
   * Keeps the royal party formed through the native Reldens party system.
   * Parties dissolve on disconnect, so the leader re-invites forever - at
   * most once per five minutes, and only while the partner stands in the
   * same scene (the server refuses cross-scene invitations anyway).
   */
  async partyWith(partnerName: string): Promise<ActionResult> {
    const now = Date.now();
    if (now - this.lastPartyInvite < 300000) {
      return { ok: false, note: 'the last invitation still stands' };
    }
    const playerId = this.partnerPlayerId(partnerName);
    if (null === playerId) {
      return { ok: false, note: `${partnerName} is not here to invite` };
    }
    this.lastPartyInvite = now;
    try {
      await this.arena.call('arena_party_invite', {
        agent_id: this.agentId,
        target_player_id: playerId
      });
      return { ok: true, note: `party invitation sent to ${partnerName}` };
    } catch (err) {
      return { ok: false, note: `party invite refused: ${String(err).slice(0, 120)}` };
    }
  }

  /** Steps into the duel queue - the one lawful way to kill a player. */
  async queueMatch(): Promise<ActionResult> {
    try {
      await this.arena.call('arena_queue_match', { agent_id: this.agentId });
      return { ok: true, note: 'stepped into the duel circle queue' };
    } catch (err) {
      return { ok: false, note: `queue refused: ${String(err).slice(0, 120)}` };
    }
  }

  /** Is a duel live right now, per the coordinator's own report? */
  async matchIsLive(): Promise<boolean> {
    try {
      const status = await this.arena.call('arena_match_status', { agent_id: this.agentId });
      const said = JSON.stringify(status ?? {}).toLowerCase();
      return /"(state|status|phase)":"?(active|live|matched|in_progress|fighting)/.test(said);
    } catch {
      return false;
    }
  }

  /** Wear the first of these the pack actually holds - the duel steel. */
  async equipFirstOwned(keys: string[]): Promise<ActionResult> {
    for (const key of keys) {
      try {
        const put = await this.arena.call('arena_equip', { agent_id: this.agentId, item: key });
        if (put && false !== put.equipped) {
          return { ok: true, note: `drew ${key}` };
        }
      } catch {
        // Not carried; try the next.
      }
    }
    return { ok: false, note: 'no duel steel in the pack' };
  }

  /** Answers a pending party invite by the inviter's playerId. */
  async respondParty(fromPlayerId: number, accept: boolean): Promise<ActionResult> {
    try {
      await this.arena.call('arena_party_respond', {
        agent_id: this.agentId,
        from_player_id: fromPlayerId,
        accept
      });
      return { ok: true, note: accept ? 'joined the party' : 'declined the party' };
    } catch (err) {
      return { ok: false, note: `party answer refused: ${String(err).slice(0, 120)}` };
    }
  }

  /** Our own session/player ids, noted off each observation, for self-casts. */
  private selfIds: { sessionId: string; playerId: number } | null = null;

  noteSelf(own: { sessionId?: string; player_id?: string | number } | undefined): void {
    if (own?.sessionId && null != own.player_id) {
      this.selfIds = { sessionId: String(own.sessionId), playerId: Number(own.player_id) };
    }
  }

  /**
   * Cast a kit skill on a friendly player - self when allyName is null -
   * by session ids rather than the enemy/opponent lookup, which by design
   * cannot see friends. This is how a heal finds its patient.
   */
  async useSkillOnAlly(skill: string, allyName: string | null): Promise<ActionResult> {
    // The session's skill roster lags class evolutions (a Magus login
    // still reports the old warlock three), so an unlisted skill is
    // ATTEMPTED rather than refused - the game server is the only
    // authority on what this character can actually do.
    const known = this.skills.find((name) => name.toLowerCase() === skill.trim().toLowerCase()) ?? skill.trim();
    let ids = this.selfIds;
    let label = 'own wounds';
    if (allyName) {
      const wanted = allyName.trim().toLowerCase();
      const person = this.people.find((p) => {
        const name = (p.playerName ?? p.name ?? p.label ?? '').trim().toLowerCase();
        return name === wanted && p.sessionId && null != p.playerId;
      });
      if (!person) {
        return { ok: false, note: `${allyName} is not close enough to receive ${known}` };
      }
      ids = { sessionId: String(person.sessionId), playerId: Number(person.playerId) };
      label = allyName;
    }
    if (!ids) {
      return { ok: false, note: 'own ids not observed yet; next look will fix that' };
    }
    const result = await this.arena.call('arena_use_action', {
      agent_id: this.agentId,
      action_type: known,
      target_session_id: ids.sessionId,
      target_player_id: ids.playerId
    });
    this.logAttackVerdict(`${known} on ${label}`, result);
    return { ok: true, note: `laid ${known} on ${label}` };
  }

  async useSkill(skill: string | undefined, target: string | undefined): Promise<ActionResult> {
    if (!this.can('fight')) {
      return { ok: false, note: 'this character does not fight' };
    }
    if (!skill) {
      return { ok: false, note: 'no skill named to use' };
    }
    // The session's skill roster lags class evolutions (a Magus login
    // still reports the old warlock three), so an unlisted skill is
    // ATTEMPTED rather than refused - the game server is the only
    // authority on what this character can actually do.
    const known = this.skills.find((name) => name.toLowerCase() === skill.trim().toLowerCase()) ?? skill.trim();
    if (!target) {
      return { ok: false, note: `nothing named to use ${known} on` };
    }
    const enemy = this.findNearby(target, 'enemy');
    if (!enemy) {
      // Same second look attack takes: the registered opponent, and only the
      // registered opponent, standing in this room. See opponentNamed().
      const opponent = this.opponentNamed(target);
      if (opponent) {
        const result = await this.arena.call('arena_use_action', {
          agent_id: this.agentId,
          action_type: known,
          target_session_id: opponent.sessionId,
          target_player_id: opponent.playerId
        });
        this.logAttackVerdict(`${known} on ${opponent.label}`, result);
        return { ok: true, note: `used ${known} on ${opponent.label}` };
      }
      return { ok: false, note: `there is no "${target}" here to use ${known} on` };
    }
    const result = await this.arena.call('arena_use_action', {
      agent_id: this.agentId,
      action_type: known,
      target_object_index: enemy.objectIndex
    });
    this.logAttackVerdict(`${known} on ${enemy.label}`, result, enemy);
    return { ok: true, note: `used ${known} on ${enemy.label}` };
  }

  /**
   * Start a conversation with an NPC or trader standing nearby, found by
   * name against what notices() was just told, not by an object index no
   * character would ever think in.
   */
  /**
   * Buy a mug at Barnaby's cask, which refills the mana pool.
   *
   * Worth a whole method because the pool being empty is not a small
   * problem for these two: measured 2026-08-24, eleven of Sir Qwen's twenty
   * logged events in half a minute were `skill_cast_failed` on thornwhip,
   * whose condition is stats/mp >= 13 against a pool holding 0. Lord Gemma
   * is worse - a Magus whose whole ladder is arts, meleeing at the 0.8
   * tiles his staff reaches because manaDry sends strike() past every cast.
   *
   * The cask restores mp to base_value outright for 100 copper
   * (inn-ledger.js SERVICE.ale), so one mug buys a full pool. Both carry
   * thousands. It is an ordinary object with runOnAction, so this is the
   * same walk-talk-choose any other counter takes.
   */
  /**
   * Destroy worthless bulk material, by an explicit list of keys.
   *
   * This is not tidying. Measured 2026-08-24, it is what stops the harness
   * going blind: Lord Gemma's pack held 231 rows, 216 of them `branch`,
   * which do not stack - so each is its own entry with its own description.
   * That put `carrying` at 33,861 of the 49,150 bytes an arena_observe
   * reply is allowed, against a real payload of 353,661. The gateway cut the
   * reply mid-object, the last enemy arrived with a label and no tileX, and
   * closeOn() multiplied undefined into NaN - which came back as "Invalid
   * arguments for tool arena_move_to: expected number" and reached the round
   * as the target being unreachable. A body that cannot see cannot fight.
   *
   * An ALLOWLIST of keys, never a rule about what looks unimportant. The
   * standing order is that top equipment is never dropped or destroyed, and
   * the way to keep that promise is for the code to be incapable of naming
   * anything else. The gateway refuses a worn item anyway (arena_discard's
   * own contract), which is a second lock, not the first.
   *
   * Quest rewards and rare drops are deliberately absent: clay_canteen,
   * tarnished_key, blue_currants, garnet_drop, bone_shard, buried_skull,
   * silk_shroud and bound_kindling are all authored reward or rare keys in
   * frontier-progression.mjs, whatever they look like in a bag.
   */
  private static readonly JUNK = new Set([
    'branch', 'field_wheat', 'cave_web', 'driftwood'
  ]);

  async discardJunk(limit = 40): Promise<ActionResult> {
    let bag: any = null;
    try {
      bag = await this.arena.call('arena_inventory', { agent_id: this.agentId });
    } catch {
      return { ok: false, note: 'could not read the pack to clear it' };
    }
    const items = Array.isArray(bag?.items) ? bag.items : null;
    if (!items) {
      return { ok: false, note: 'the pack did not read back' };
    }
    const doomed = items.filter((row: any) =>
      Actions.JUNK.has(String(row?.key ?? ''))
      && !row?.equipped
      && !row?.equipment);
    if (!doomed.length) {
      return { ok: true, note: 'nothing in the pack worth destroying' };
    }
    let claimed = 0;
    for (const row of doomed.slice(0, limit)) {
      try {
        const said = await this.arena.call('arena_discard', {
          agent_id: this.agentId,
          item: String(row.key)
        });
        if (said?.discarded) {
          claimed += 1;
        }
      } catch {
        // One refusal does not end the sweep; the next key may still go.
        continue;
      }
    }
    // DO NOT RECOUNT THE PACK TO CHECK. That check was here, and it was
    // wrong, and it switched off a cure that works.
    //
    // arena_inventory is byte-capped: every reply is exactly 49,152 bytes and
    // carries a PREFIX of the pack. Sir Qwen's pack is about 1,627 rows and
    // the reply shows 229. Destroying a row pulls a hidden row into the
    // visible window, so the count cannot fall however much is destroyed -
    // it even rose, 227 to 229, across a successful delete. Reading that as
    // a failed delete is counting rows in a capped list.
    //
    // Adversarially verified 2026-08-24: 62 of 62 discards were real
    // removals, and the duplicate-key case deleted exactly one of two rows
    // sharing a key (`ash_longbow`), with the sibling untouched and the row
    // still gone 45 seconds later. The gateway's `discarded` flag is the
    // honest signal here; the row count is the unreliable one.
    console.log(`[pack] destroyed ${claimed} junk row(s)`);
    return { ok: true, note: `destroyed ${claimed} worthless row(s)` };
  }

  /**
   * Walk away from every fight at once, then say how many were dropped.
   *
   * The gateway offers no per-opponent version - `arena_disengage` takes an
   * agent and leaves EVERY fight - so this is deliberately all or nothing.
   * That is still the right lever for being outnumbered: a body in three
   * fights it did not pick drops all three and takes one again on the next
   * beat, which is the difference between fighting one thing and being
   * surrounded by things that each get a free swing.
   *
   * The tool's own contract says an enemy can notice a body again if it
   * stays put, so the caller is expected to move afterwards rather than
   * stand where it was.
   */
  async disengage(): Promise<ActionResult> {
    if (!this.can('fight')) {
      return { ok: false, note: 'this character does not pick fights to walk away from' };
    }
    try {
      const said = await this.arena.call('arena_disengage', { agent_id: this.agentId });
      // `left` IS NOT "DID A FIGHT END" (server PR #540, merged 2026-08-25).
      // The world answers a disengage with two facts that look like one:
      // `fightEnded` is the boundary - this body was in a PvE fight and now is
      // not - while `left` names only the leave calls that did not throw. A
      // failure on the enemy's way home ends the fight and leaves `left`
      // empty, and reading the empty list as "nothing happened" is the exact
      // bug that PR fixed on its own side of the wire. This method was making
      // it again from here, and would have reported a real disengage as
      // "walked away from 0 fight(s)".
      const ended = true === said?.fightEnded;
      const left = Array.isArray(said?.left) ? said.left.length
        : Array.isArray(said?.disengaged) ? said.disengaged.length
        : null;
      // The gateway composes its own sentence from both halves now, the same
      // way action verdicts carry `note` - prefer the server's words over
      // anything reassembled here, which is how the two stay in step.
      if ('string' === typeof said?.message && said.message) {
        return { ok: true, note: said.message.trim() };
      }
      return {
        ok: true,
        note: ended ? `walked away, fight over${left ? ` (${left} left the field)` : ''}`
          : null === left ? 'walked away'
          : `walked away from ${left} fight(s)`
      };
    } catch {
      return { ok: false, note: 'could not walk away' };
    }
  }

  async takeBlessing(): Promise<ActionResult> {
    const keeper = this.findNearby('Ossian', 'npc');
    if (!keeper) {
      return { ok: false, note: 'there is no Ossian here to kneel to' };
    }
    const gapTiles = (keeper.distanceFromSelf ?? 0) / this.tilePx;
    console.log(`[shrine] ${keeper.label}: gap ${gapTiles.toFixed(2)} tiles, at tile (${keeper.tileX},${keeper.tileY})`);
    if (gapTiles > 1.8 && null != keeper.tileX && null != keeper.tileY) {
      // The nearest tile the grid says can be stood on, not a guessed
      // offset - the cask taught that lesson (see drinkAle above).
      const near = this.standableTilesNear(keeper.tileX, keeper.tileY, 3);
      const walked = near.length
        ? await this.goTo(near[0].x, near[0].y)
        : await this.goTo(
          keeper.tileX * this.tilePx + this.tilePx / 2,
          keeper.tileY * this.tilePx + this.tilePx / 2
        );
      // Still on the way means still on the way: return and let the next
      // beat ask again, exactly as openChest() does. Arrived is enough to
      // try - the server judges the range itself and says so plainly.
      if (!walked.ok || !/got there/i.test(String(walked.note ?? ''))) {
        return walked;
      }
    }
    const opened = await this.talkTo('Ossian');
    if (!opened.ok) {
      return opened;
    }
    const entries = Object.entries(this.talking?.options ?? {});
    if (0 === entries.length) {
      return { ok: false, note: `Ossian offered no choices at all - heard: ${opened.note ?? 'nothing'}` };
    }
    // Discovered, never assumed: the key the server source handles
    // (`heal`), or failing that any offered label that sounds like
    // mending. Anything else refuses rather than picking blind - unlike
    // the chests, where taking the only thing in the box is safe.
    const HEALING = /heal|bless|kneel|restore|mend|renew|whole/i;
    const found =
      entries.find(([key]) => 'heal' === key.trim().toLowerCase())
      ?? entries.find(([, text]) => HEALING.test(String(text)));
    if (!found) {
      return {
        ok: false,
        note: `nothing Ossian offers reads as healing (offered: ${entries.map(([, text]) => `"${text}"`).join(', ')})`
      };
    }
    const [, label] = found;
    const took = await this.answerNpc(String(label));
    console.log(took.ok
      ? `[shrine] chose "${label}" -> ${took.note ?? 'ok'}`
      : `[shrine] Ossian refused the choice: ${took.note}`);
    return took;
  }

  async drinkAle(scene: string): Promise<ActionResult> {
    const cask = this.findNearby('cask', 'npc');
    if (!cask) {
      return { ok: false, note: 'there is no cask in this room' };
    }
    // Walk to the cask's OWN tile rather than asking walk() for it by name.
    // Measured 2026-08-24: walk('cask') put Sir Qwen at inn tile (12,7)
    // with the cask at (8,2) - it moved him further away - and talk_to then
    // answered "You are too far away to talk to them." walkToSomebody()
    // resolves people, and a cask is furniture with a label.
    if (null != cask.tileX && null != cask.tileY) {
      // The nearest tile the grid says can be stood on, NOT a guessed
      // offset. Measured 2026-08-24: the cask is at inn tile (8,2) and the
      // whole of row 3 from x=2 to x=10 is wall, so "one tile below it" -
      // the obvious guess, and the first thing tried - aimed the body into
      // the inn's back wall and left it stranded three tiles off, failing
      // talk_to with "too far away" every time. Row 2 beside the cask is
      // open; standableTilesNear() finds that without being told.
      const near = this.standableTilesNear(cask.tileX, cask.tileY, 3);
      const px = tilePxFor(scene);
      console.log(`[ale] cask at tile(${cask.tileX},${cask.tileY}); `
        + `${near.length} standable near it`
        + (near.length ? `, aiming at tile(${Math.floor(near[0].x / px)},${Math.floor(near[0].y / px)})` : ''));
      // NEAREST IS NOT REACHABLE, AND ONE CANDIDATE IS NOT AN ATTEMPT.
      //
      // Two bugs sat on top of each other here, and the first hid the second.
      // `goTo` answers ok for a walk it has merely STARTED, so this read that
      // as arrival and knocked on the cask from across the room: talk_to came
      // back "too far away" three times and `aleHopeless` then retired the
      // only mana source either of them has for the whole run. Waiting for a
      // real arrival made the failure honest - and revealed that the walk
      // itself never lands, because only `near[0]` was ever tried and the
      // nearest standable tile is not necessarily one there is a path to.
      // The comment above already records that shape once: row 3 of the inn
      // is wall from x=2 to x=10, so the obvious tile beside the cask aims a
      // body into it. Picking a different obvious tile does not fix a rule
      // that only gets one guess.
      //
      // Measured 2026-08-25: both royals walked to the inn correctly, both
      // aimed at tile (7,2), both came away "still short" three times, and
      // both left on 4/646 and 1/217 with 731,755 and 599,366 copper in
      // pocket. Four tiles between them and the cure.
      for (const spot of near.slice(0, 4)) {
        const walked = await this.goTo(spot.x, spot.y);
        const arrived = walked.ok ? await this.waitForArrival(spot.x, spot.y) : false;
        console.log(`[ale] walk to the cask tile(${Math.floor(spot.x / px)},${Math.floor(spot.y / px)}): `
          + `${walked.ok ? 'ok' : 'failed'} - ${arrived ? 'arrived' : 'still short'}`);
        if (arrived) {
          break;
        }
      }
    }
    const opened = await this.talkTo('cask');
    if (!opened.ok) {
      return opened;
    }
    // The option is labelled "Pay 1s and drink"; match on the verb rather
    // than the price, which is written in silver there and in copper
    // everywhere else in the harness.
    const took = await this.answerNpc('drink');
    console.log(took.ok
      ? '[ale] bought a mug at the cask - the pool should be full'
      : `[ale] the cask refused: ${took.note}`);
    return took;
  }

  async talkTo(target: string | undefined): Promise<ActionResult> {
    if (!this.can('talk_to_folk')) {
      return { ok: false, note: 'this character does not strike up conversation like that' };
    }
    if (!target) {
      return { ok: false, note: 'nobody named to talk to' };
    }
    const npc = this.findNearby(target, 'npc');
    if (!npc) {
      return { ok: false, note: `there is no "${target}" here to talk to` };
    }
    if (npc.objectId == null) {
      return { ok: false, note: `there is no way to open a conversation with ${npc.label}` };
    }
    const reply = await this.arena.call('arena_talk_to', {
      agent_id: this.agentId,
      object_id: npc.objectId
    });
    return this.describeNpcReply(npc.label, reply);
  }

  /**
   * Open a treasure chest by its title. The chest is a server object
   * (class_type NPC, runOnAction) - standing beside it and talking works
   * the hasp, and the grant is once per character: an emptied chest just
   * describes its hollow. Far chests are walked to first; the round asks
   * again next beat.
   */
  async openChest(title: string | undefined): Promise<ActionResult> {
    if (!title) {
      return { ok: false, note: 'no chest named' };
    }
    const chest = this.findNearby(title, 'npc');
    if (!chest) {
      return { ok: false, note: `no "${title}" stands in this room` };
    }
    const gapTiles = (chest.distanceFromSelf ?? 0) / this.tilePx;
    // SAY HOW FAR, because "got there" plainly is not (2026-08-16). Measured:
    // six consecutive "open_chest A Rush-Wrapped Chest -> ok - got there",
    // which is THIS branch returning success while the next tick measures
    // the same gap and walks again. The talk below - and so arena_choose,
    // and so the reward - is never reached at all. Either the walk is not
    // moving the body, or the chest's tile cannot be stood on and the gap
    // never closes under 1.8, or distanceFromSelf is not the unit assumed
    // here. Those want three different fixes, so print the number rather
    // than pick one.
    console.log(`[chest] ${title}: gap ${gapTiles.toFixed(2)} tiles (raw ${chest.distanceFromSelf}), chest tile (${chest.tileX},${chest.tileY})`);
    if (gapTiles > 1.8) {
      const walked = await this.goTo(chest.tileX * this.tilePx + this.tilePx / 2, chest.tileY * this.tilePx + this.tilePx / 2);
      // ARRIVING IS ENOUGH TO TRY (2026-08-16). This used to return here, so
      // a body that could not close the last stride never got past the walk:
      // six "open_chest -> ok - got there" in a row, the talk below never
      // reached, and so arena_choose and the reward never reached either.
      // approach() seats the body on the nearest STANDABLE tile, and a chest
      // stands on its own tile with scenery around it, so the final gap is
      // whatever the map allows and not necessarily under 1.8. Once the walk
      // says it got there, ask - the server judges the range itself and says
      // so plainly if it is too far, which is a real answer and cheaper than
      // walking for ever. Still on the way means still on the way: return
      // and let the next beat continue, exactly as before.
      if (!walked.ok || !/got there/i.test(String(walked.note ?? ''))) {
        return walked;
      }
    }
    // GREETING A CHEST IS NOT EMPTYING IT (2026-08-16). A chest is an NPC
    // with a dialogue, and the game grants the reward from the OPTION, not
    // from the hello: the server's treasure-claim.js takes a chestKey and a
    // rewardKey and hands the item to the inventory manager, and the only
    // gateway call that reaches it is arena_choose. This used to stop at
    // talkTo(), so the body walked up, opened the lid, said hello and left
    // the boots in the box - five "open_chest A Rush-Wrapped Chest -> ok"
    // in a row against a pack that never gained a thing.
    const opened = await this.talkTo(title);
    if (!opened.ok) {
      return opened;
    }
    const options = this.talking?.options;
    const entries = options ? Object.entries(options) : [];
    if (!entries.length) {
      // No choices offered: an already-emptied chest answers with its own
      // emptyContent line and nothing to pick, which is a real answer and
      // not a failure. The note carries it so the log can tell the two
      // apart instead of printing "ok" for both.
      return opened;
    }
    // Prefer a choice that sounds like taking the thing; fall back to the
    // first on offer rather than guessing at wording that may change. The
    // chest text is written per chest ("When it is lifted...", "The lid
    // tears free..."), so no fixed phrase can be relied on.
    const TAKING = /take|claim|open|lift|keep|yes|inside/i;
    const [, label] = entries.find(([, text]) => TAKING.test(text)) ?? entries[0];
    const claimed = await this.answerNpc(label);
    console.log(`[chest] ${title}: chose "${label}" -> ${claimed.ok ? claimed.note ?? 'ok' : claimed.note}`);
    return claimed.ok
      ? { ok: true, note: `${opened.note ?? 'opened it'}; chose "${label}" - ${claimed.note ?? 'no reply'}` }
      : { ok: true, note: `${opened.note ?? 'opened it'} but could not take: ${claimed.note}` };
  }

  /**
   * Play a melody the whole scene hears. Bars of exactly 8 steps split by
   * "|", chords one per bar. The gateway validates the notation, so a
   * malformed tune is refused rather than silently swallowed.
   */
  async playMelody(
    melody: string,
    chords?: string,
    how?: { times?: number; bpm?: number; pattern?: string; instrument?: string }
  ): Promise<ActionResult> {
    if (!this.can('perform')) {
      return { ok: false, note: 'this character has no business holding an instrument' };
    }
    try {
      const played = await this.arena.call('arena_play_melody', {
        agent_id: this.agentId,
        melody,
        ...(chords ? { chords } : {}),
        ...(how?.times ? { times: how.times } : {}),
        ...(how?.bpm ? { bpm: how.bpm } : {}),
        ...(how?.pattern ? { pattern: how.pattern } : {}),
        ...(how?.instrument ? { instrument: how.instrument } : {})
      });
      return { ok: true, note: `played: ${String(played?.melody ?? melody).slice(0, 60)}` };
    } catch (error) {
      return { ok: false, note: whatWentWrong(error) };
    }
  }

  /** Pick one of the choices a conversation just offered. */
  async answerNpc(option: string | undefined): Promise<ActionResult> {
    if (!this.can('talk_to_folk')) {
      return { ok: false, note: 'this character does not strike up conversation like that' };
    }
    if (!this.talking) {
      return { ok: false, note: 'is not in the middle of talking to anyone' };
    }
    if (!option) {
      return { ok: false, note: 'did not say which answer to give' };
    }
    const key = this.matchOption(option);
    if (!key) {
      return { ok: false, note: `"${option}" was not one of the choices on offer` };
    }
    const label = this.talking.label;
    const reply = await this.arena.call('arena_choose', {
      agent_id: this.agentId,
      object_id: this.talking.objectId,
      option_key: key
    });
    return this.describeNpcReply(label, reply);
  }

  /**
   * Turn the gateway's reply from arena_talk_to/arena_choose into what the
   * character heard, and remember it for the next call so answer_npc knows
   * who it is still talking to and takeNpcReply() can hand the harness what
   * was actually said.
   */
  private describeNpcReply(npcLabel: string, reply: {
    opened: boolean;
    objectId: number;
    title?: string | null;
    content?: string | null;
    options?: Record<string, unknown> | null;
    message?: string;
  }): ActionResult {
    if (!reply.opened) {
      this.talking = null;
      this.lastReply = null;
      return { ok: false, note: reply.message ?? `${npcLabel} is too far away to talk to` };
    }
    const said = [reply.title, reply.content].filter(Boolean).join(': ').trim();
    // NORMALISED HERE, ONCE. Everything downstream may go on assuming a
    // string, which is what its types already claim.
    const readable = readableOptions(reply.options);
    this.talking = {
      objectId: reply.objectId,
      label: npcLabel,
      options: Object.keys(readable).length ? readable : null
    };
    this.lastReply = said ? { from: npcLabel, said } : null;
    const offered = this.talking.options ? Object.values(this.talking.options) : [];
    const heard = said || `${npcLabel} has nothing more to say`;
    const note = offered.length > 0
      ? `${heard}${/[.!?]$/.test(heard) ? '' : '.'} You can answer: ${offered.join(', ')}`
      : heard;
    return { ok: true, note };
  }

  /** Match what the character said back against the choices actually on offer. */
  private matchOption(said: string): string | null {
    const options = this.talking?.options;
    if (!options) {
      return null;
    }
    const wanted = said.trim().toLowerCase();
    const entries = Object.entries(options);
    return (
      entries.find(([key]) => key.toLowerCase() === wanted)?.[0]
      ?? entries.find(([, value]) => value.trim().toLowerCase() === wanted)?.[0]
      ?? entries.find(([, value]) => value.toLowerCase().includes(wanted))?.[0]
      ?? entries.find(([, value]) => wanted.includes(value.trim().toLowerCase()))?.[0]
      ?? null
    );
  }

  /**
   * What an NPC just told this character, for the harness to write into
   * memory as a first-hand finding - see noteToldByNpc() in npc.ts. Read
   * once and cleared, so the same line is not remembered twice.
   */
  takeNpcReply(): { from: string; said: string } | null {
    const reply = this.lastReply;
    this.lastReply = null;
    return reply;
  }

  /**
   * Count what is in the purse, and say what it is actually good for.
   *
   * The number on its own is a fortune with nothing behind it: every agent is
   * granted a large opening balance, nothing in the world sells anything, and a
   * character handed a bare figure decides it is rich and goes looking for a
   * land office to spend it at. Guy spent an evening walking to a council
   * building the Wanderer had invented, on the strength of ten thousand
   * coppers he cannot spend on anything. Saying so is not flavour, it is the
   * true state of the economy.
   */
  async checkMoney(): Promise<ActionResult> {
    if (!this.can('money')) {
      return { ok: false, note: 'this character has no purse' };
    }
    const balance = await this.arena.call('arena_credit_balance', { agent_id: this.agentId });
    return {
      ok: true,
      note: `has ${balance.balance} arena credits, which nothing here sells anything for yet`
    };
  }

  /**
   * Drink, eat, or otherwise use something out of the satchel.
   *
   * Not gated behind anything: using what you are already carrying is not a
   * trade and it is not a fight, and a character who has been handed a potion
   * should be able to drink it. What it is gated on is the item being real
   * and being usable, both of which the harness can see from the observation
   * it already has, so a wrong guess costs a plain sentence rather than a
   * round trip and a shrug from the world.
   */
  async useItem(item: string | undefined): Promise<ActionResult> {
    const usable = this.carried.filter((carried) => carried.usable);
    if (0 === usable.length) {
      return { ok: false, note: 'is carrying nothing that can be used' };
    }
    // Nothing named and only one thing it could possibly mean is not
    // ambiguous, it is a person saying "drink it".
    const meant = item ? this.carriedNamed(item) : (1 === usable.length ? usable[0] : null);
    if (!meant) {
      return {
        ok: false,
        note: item
          ? `is not carrying anything called "${item}"`
          : `did not say which to use: ${usable.map((carried) => carried.label).join(', ')}`
      };
    }
    if (!meant.usable) {
      return {
        ok: false,
        note: meant.equipped || meant.equipment
          ? `${meant.label} is worn, not drunk`
          : `${meant.label} is not something you use`
      };
    }
    const result = await this.arena.call('arena_use_item', {
      agent_id: this.agentId,
      item: meant.key
    });
    if (!result.used) {
      return { ok: false, note: result.message ?? `nothing came of using ${meant.label}` };
    }
    const left = Number(result.remaining ?? 0);
    return {
      ok: true,
      note: `used ${meant.label}${0 < left ? `, ${left} left` : ', the last one'}`
    };
  }

  /**
   * Take something off the floor. Walking over loot does nothing on this
   * world, so this is the only way anything a monster dropped ever reaches a
   * character's hands.
   */
  async pickUp(item: string | undefined): Promise<ActionResult> {
    if (0 === this.loot.length) {
      return { ok: false, note: 'there is nothing lying here to pick up' };
    }
    const wanted = item?.trim().toLowerCase();
    const drop = wanted
      ? this.loot.find((lying) => (lying.itemKey ?? '').toLowerCase().includes(wanted))
      : this.loot[0];
    if (!drop) {
      return { ok: false, note: `there is no "${item}" lying here` };
    }
    let result = await this.arena.call('arena_pick_up', {
      agent_id: this.agentId,
      drop_id: drop.dropId
    });
    if (!result.pickedUp) {
      // The gateway reports drops with a position at runtime even though
      // the type never promised one. If this one is simply out of reach,
      // walk to it and ask once more before giving up.
      const spot = drop as unknown as { x?: number; y?: number; tileX?: number; tileY?: number };
      const x = spot.x ?? (undefined !== spot.tileX ? spot.tileX * this.tilePx + this.tilePx / 2 : undefined);
      const y = spot.y ?? (undefined !== spot.tileY ? spot.tileY * this.tilePx + this.tilePx / 2 : undefined);
      if (undefined !== x && undefined !== y) {
        await this.approach(x, y);
        result = await this.arena.call('arena_pick_up', {
          agent_id: this.agentId,
          drop_id: drop.dropId
        });
      }
    }
    if (!result.pickedUp) {
      return { ok: false, note: result.message ?? 'could not reach it' };
    }
    return { ok: true, note: `picked up ${result.item ?? 'what was lying there'}` };
  }

  /**
   * Buy something from the merchant standing here.
   *
   * With no item named this asks what is for sale instead of failing, because
   * that is what a person does on walking into a shop, and because a character
   * cannot name a thing it has never been shown. The answer comes back as the
   * note, which the harness puts in front of it on the very next tick.
   */
  async buy(item: string | undefined, quantity: number | undefined): Promise<ActionResult> {
    const counter = this.tradingWith();
    if (counter.refusal) {
      return counter.refusal;
    }
    const shop = counter.merchant as ArenaObject;
    if (!item) {
      return this.listOffers(shop, 'buy');
    }
    const result = await this.arena.call('arena_buy', {
      agent_id: this.agentId,
      object_id: shop.objectId,
      item,
      quantity: Math.max(1, Math.trunc(Number(quantity) || 1))
    });
    // BUYING NEEDS THE SAME WALK SELLING DOES (2026-08-16). The too-far cure
    // went into sell() alone and buy() was left with the old behaviour, which
    // is the half that actually matters here: measured "buy wooden shield ->
    // You are too far away to trade with Gimly" and the same for the mana
    // draughts, from a character carrying 22,000 copper and a standing order
    // to fetch a 18,000-copper greatblade. A refused sale costs one item; a
    // refused purchase costs the upgrade the whole grind is for.
    // walkToSomebody() reads the merchant's live tile rather than the static
    // place table walk() prefers - see the matching note in sell().
    const tooFar = /too far away to trade|too far off to trade/i.test(String(result?.message ?? ''));
    if (tooFar) {
      const beside = await this.walkToSomebody(shop.label);
      const walked = beside ?? await this.walk(shop.label, this.view?.scene ?? '');
      // ARRIVED, not merely ok. Since walk/walkToSomebody began reporting a
      // mid-stride beat as ok (so a bending route stops looking like a
      // failure), `walked.ok` is true while the body is still walking - and
      // retrying the trade then just draws a second refusal, which becomes
      // the final answer. The note is what distinguishes them: "walked
      // over to X" means standing there, "on the way to X" does not.
      // Match the ARRIVAL wording, not the absence of the mid-stride wording.
      // A negative test fails open: if the merchant is not in `nearby` and
      // the label is not a known place, walk() falls through to explore(),
      // which answers "had a look around to the north" - no "on the way" in
      // it, so a negative guard would pass and the trade would be retried
      // from wherever the body wandered to.
      if (/^walked (to|over to) /i.test(String(walked.note ?? ''))) {
        const retry = await this.arena.call('arena_buy', {
          agent_id: this.agentId,
          object_id: shop.objectId,
          item,
          quantity: Math.max(1, Math.trunc(Number(quantity) || 1))
        });
        return this.tradeResult(shop, retry, 'bought');
      }
    }
    return this.tradeResult(shop, result, 'bought');
  }

  /** Sell something to the merchant standing here. Mirrors buy(). */
  async sell(item: string | undefined, quantity: number | undefined): Promise<ActionResult> {
    const counter = this.tradingWith();
    if (counter.refusal) {
      return counter.refusal;
    }
    const shop = counter.merchant as ArenaObject;
    if (!item) {
      return this.listOffers(shop, 'sell');
    }
    const result = await this.arena.call('arena_sell', {
      agent_id: this.agentId,
      object_id: shop.objectId,
      item,
      quantity: Math.max(1, Math.trunc(Number(quantity) || 1))
    });
    // TOO FAR MEANS WALK, THEN SELL - same lesson as the door (2026-08-16).
    // Measured at Gimly's counter: a run of "You are too far away to trade"
    // refusals, each costing a whole beat, until the body happened to drift
    // into reach. The round's own cure is to clear walkedToShop and try the
    // whole restock leg again next beat, which is slow and leaves a bag of
    // cargo unsold. Step to the counter and repeat the sale once instead.
    const tooFar = /too far away to trade|too far off to trade/i.test(String(result?.message ?? ''));
    if (tooFar) {
      // GO TO THE MERCHANT, NOT TO THE MAP'S IDEA OF THE MERCHANT
      // (2026-08-16). walk() resolves a known name against the static place
      // table FIRST and only falls through to the live person lookup for a
      // name it does not recognise - so "walk Gimly" marches to a fixed
      // coordinate. When the counter is not there any more the body arrives,
      // reports "set off for Gimly but stopped short", and every sale after
      // it answers "You are too far away to trade with Gimly" for ever. The
      // retry walking the same way was no retry at all. Measured against a
      // full bag: 11:21:48 stopped short, 11:22:27 too far, unbroken.
      // walkToSomebody() reads the merchant's live tile and stands on an
      // ADJACENT one - which is what a counter wants anyway, since the
      // merchant is standing on its own tile and a path onto it can never
      // complete. Fall back to the old walk if nobody of that name is
      // visible, so a scene without the person still behaves as before.
      const beside = await this.walkToSomebody(shop.label);
      const walked = beside ?? await this.walk(shop.label, this.view?.scene ?? '');
      // ARRIVED, not merely ok. Since walk/walkToSomebody began reporting a
      // mid-stride beat as ok (so a bending route stops looking like a
      // failure), `walked.ok` is true while the body is still walking - and
      // retrying the trade then just draws a second refusal, which becomes
      // the final answer. The note is what distinguishes them: "walked
      // over to X" means standing there, "on the way to X" does not.
      // Match the ARRIVAL wording, not the absence of the mid-stride wording.
      // A negative test fails open: if the merchant is not in `nearby` and
      // the label is not a known place, walk() falls through to explore(),
      // which answers "had a look around to the north" - no "on the way" in
      // it, so a negative guard would pass and the trade would be retried
      // from wherever the body wandered to.
      if (/^walked (to|over to) /i.test(String(walked.note ?? ''))) {
        const retry = await this.arena.call('arena_sell', {
          agent_id: this.agentId,
          object_id: shop.objectId,
          item,
          quantity: Math.max(1, Math.trunc(Number(quantity) || 1))
        });
        return this.tradeResult(shop, retry, 'sold');
      }
    }
    return this.tradeResult(shop, result, 'sold');
  }

  /**
   * The merchant this character is allowed to deal with, or the reason it is
   * not. Returns one or the other so buy() and sell() can share every refusal
   * without either of them repeating it.
   */
  private tradingWith(): { merchant?: ArenaObject; refusal?: ActionResult } {
    if (!this.can('trade')) {
      return { refusal: { ok: false, note: 'this character does not haggle' } };
    }
    const merchant = this.merchantHere();
    if (!merchant) {
      return { refusal: { ok: false, note: 'there is nobody here who keeps a shop' } };
    }
    return { merchant };
  }

  /** What is on the counter, said the way somebody would read it back. */
  private async listOffers(merchant: ArenaObject, side: 'buy' | 'sell'): Promise<ActionResult> {
    const listing = await this.arena.call('arena_trade_with', {
      agent_id: this.agentId,
      object_id: merchant.objectId,
      side
    });
    if (!listing.opened) {
      return { ok: false, note: listing.message ?? `${merchant.label} is too far off to trade with` };
    }
    const offers = (listing.offers ?? []) as Array<{
      label: string;
      price?: CounterMoney;
      payout?: CounterMoney;
    }>;
    if (0 === offers.length) {
      return {
        ok: true,
        note: 'buy' === side
          ? `${merchant.label} has nothing for sale`
          : `${merchant.label} does not want anything you are carrying`
      };
    }
    const said = offers.map((offer) => {
      const cost = 'buy' === side ? offer.price : offer.payout;
      if (!cost) {
        return `${offer.label} (no price)`;
      }
      // The raw quantity is COPPER, so printing "19000 coins" told the
      // character a warbow cost nineteen thousand coins when it costs a
      // hundred and ninety - the same 100x unit error the gear ladders had,
      // aimed at the model this time instead of the reflex. moneyText()
      // prefers the gateway's own `display` and formats the copper itself
      // when the build stops sending one.
      const text = moneyText(cost);
      return `${offer.label} for ${text ?? 'an unstated price'}`;
    });
    return {
      ok: true,
      note: 'buy' === side
        ? `${merchant.label} sells: ${said.join(', ')}`
        : `${merchant.label} will pay for: ${said.join(', ')}`
    };
  }

  /** One completed - or refused - transaction, in a sentence. */
  private tradeResult(
    merchant: ArenaObject,
    result: {
      traded?: boolean;
      message?: string;
      item?: { label?: string };
      quantity?: number;
      price?: CounterMoney;
      payout?: CounterMoney;
    },
    verb: 'bought' | 'sold'
  ): ActionResult {
    if (!result.traded) {
      return { ok: false, note: result.message ?? `${merchant.label} would not do it` };
    }
    const what = result.item?.label ?? 'it';
    const many = 1 < Number(result.quantity ?? 1) ? ` x${result.quantity}` : '';
    const money = 'bought' === verb ? result.price : result.payout;
    const said = moneyText(money);
    const price = said ? ` for ${said}` : '';
    return { ok: true, note: `${verb} ${what}${many}${price} from ${merchant.label}` };
  }

  /**
   * How wide a tile is in the room this character is standing in.
   *
   * Every tile<->pixel conversion below reads this rather than the 32 it used
   * to hardcode. It is refreshed on each observation, which is the one call
   * that always knows the room: a character can change rooms between beats,
   * and the valley is 64 where the forest it came from was 32.
   */
  private tilePx = 32;
  private gridLogged: string | null = null;
  /** What the last recipe list at a station actually offered. */
  private recipesSeen: Array<{ key: string; skill: string; level: number; canMake: boolean; inputs: unknown }> = [];

  /** The scene whose tile-size disagreement has already been logged. */
  private tileSizeLogged: string | null = null;
  private ownShapeLogged = false;

  async observe(): Promise<Observation> {
    const observation = await this.arena.call('arena_observe', { agent_id: this.agentId }) as Observation;
    const scene = observation?.ownPlayer?.state?.scene ?? observation?.sceneName;
    // THE MAP WINS. THE TABLE IS THE FALLBACK (server PR #543, 2026-08-25).
    //
    // `tilePxFor` is a hand-maintained list of which rooms are 64px, and it
    // is a guess at something the world states outright: arena_observe carries
    // `pixelsPerTile` per scene. The server made exactly this change on its own
    // side in #543 - `battle-sense.js` had `const TILE_PX = 32` with the
    // comment "Every scene in this world runs 32px tiles", which stopped being
    // true when the Blender-baked rooms landed, and its constant is now named
    // FALLBACK_TILE_PX because that is what it always was. The same sentence
    // applies here, and the same bug has been paid for four times on this side.
    //
    // It matters most for the two numbers that decide whether a swing lands:
    // `distanceFromSelf` and a skill's `range` are BOTH in pixels, and every
    // comparison between them and a tile happens through this field. A room
    // added upstream after the table was last audited reads 32 by assumption;
    // read this way it reads whatever the map says, including a room nobody
    // here has heard of.
    const saidPx = Number((observation as { pixelsPerTile?: { width?: number } })?.pixelsPerTile?.width);
    if (Number.isFinite(saidPx) && saidPx > 0) {
      if (scene && saidPx !== tilePxFor(scene)) {
        // Say it once per disagreement rather than every tick: a table that
        // has drifted from the world is worth one line in the log, and this
        // is the only place the two are ever compared.
        if (this.tileSizeLogged !== scene) {
          this.tileSizeLogged = scene;
          console.log(`[tiles] ${scene}: the world says ${saidPx}px, the table says ${tilePxFor(scene)}px - using the world`);
        }
      }
      this.tilePx = saidPx;
    } else if (scene) {
      this.tilePx = tilePxFor(scene);
    }
    // ONE-SHOT: what the gateway actually says about this body. The public
    // watch feed used to carry sheet.progress.level and sheet.hp, and as of
    // the 2026-08-21 world update it carries neither - every player object is
    // now {sessionId, name, x, y, dir, inState}. That is why every log line
    // reads "hp ?" and why the shop reads "level unknown" and buys nothing.
    // Print what is on offer here instead of guessing at a replacement.
    if (!this.ownShapeLogged && observation?.ownPlayer) {
      this.ownShapeLogged = true;
      const own = observation.ownPlayer as unknown as Record<string, unknown>;
      const state = (own.state ?? {}) as Record<string, unknown>;
      console.log(`[own] ownPlayer keys: ${Object.keys(own).join(', ')}`);
      console.log(`[own] state keys: ${Object.keys(state).join(', ')}`);
      for (const [k, v] of [...Object.entries(own), ...Object.entries(state)]) {
        if (/level|lvl|exp|hp|mp|stat|progress/i.test(k)) {
          console.log(`[own] ${k} = ${JSON.stringify(v)?.slice(0, 200)}`);
        }
      }
    }
    return observation;
  }

  /**
   * Watch until the body arrives or stops moving, then let it settle.
   *
   * The settle matters: a body still sliding when the next decision is made
   * reports a position it is about to leave, and the character decides where
   * to go next from where it briefly was. Waiting for it to actually stop
   * costs half a second and makes every following observation true.
   */
  private async waitForArrival(x: number, y: number): Promise<boolean> {
    const deadline = Date.now() + LEG_TIMEOUT_MS;
    let last: string | null = null;
    let still = 0;
    while (Date.now() < deadline) {
      await sleep(WALK_POLL_MS);
      // A LOOK THAT FAILS IS NOT A WALK THAT FAILED (2026-08-16). This poll
      // let any observe error escape, so a single hiccup part-way through a
      // walk threw out of approach() and out of whichever action was walking
      // - a door crossing, a trip to a merchant - rather than simply meaning
      // "cannot confirm arrival yet". The gateway drops a reply often enough
      // to matter: the journal carries AGENT_NOT_CONNECTED and truncation
      // errors through the day. Not arriving is the honest answer, and the
      // caller already knows what to do with it: keep walking next beat.
      // This is also what fails ten tests in the suite, where the fake arena
      // runs out of queued replies mid-poll and the exception surfaces as
      // "FakeArena: no reply queued for arena_observe".
      let observation;
      try {
        observation = await this.observe();
      } catch {
        return false;
      }
      const state = observation.ownPlayer?.state ?? {};
      const here = { x: Number(state.x ?? 0), y: Number(state.y ?? 0) };
      if (Math.abs(here.x - x) <= ARRIVAL_PIXELS && Math.abs(here.y - y) <= ARRIVAL_PIXELS) {
        await sleep(SETTLE_MS);
        return true;
      }
      // Leaving the room mid-walk counts as done; something else moved us.
      if (sceneOf(observation) === '') {
        return false;
      }
      const key = `${here.x},${here.y}`;
      if (key === last) {
        still += 1;
        if (still >= STILL_POLLS) {
          return false;
        }
      } else {
        still = 0;
      }
      last = key;
    }
    return false;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Turn what a character meant to say into the chat lines it actually sends.
 *
 * Two separate limits are at work. How much a character says is a trait: an
 * innkeeper who has told the same story for twenty years runs on, and a
 * wanderer who has spoken to nobody for a week does not. That is `maxWords`,
 * and it is enforced by dropping whole sentences, never by cutting one short.
 *
 * How much fits in one chat line is Reldens': 100 characters. So the kept
 * sentences are packed into lines under that limit and sent in sequence, which
 * is what a person typing in a chat box does anyway.
 */
export function toSpeech(raw: string, maxWords: number = DEFAULT_WORDS): string[] {
  // Models narrate themselves in asterisks however firmly they are told not
  // to. Cut what is between them, not just the markers: stripping only the
  // asterisks turns "*Guy shrugs.* Fine." into a character announcing that he
  // shrugs, which is worse than the stage direction was.
  const text = raw
    .replace(/\*[^*]*\*/g, ' ')
    .replace(/\*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["“”]|["“”]$/g, '');
  if (!text) {
    return [];
  }
  const budget = Math.max(1, Math.min(Math.round(maxWords), MAX_WORDS));
  const kept: string[] = [];
  let spent = 0;
  for (const sentence of splitSentences(text)) {
    const words = countWords(sentence);
    // The first sentence always goes, however long: a character cut off
    // before it has said anything is worse than one that ran over.
    if (kept.length > 0 && spent + words > budget) {
      break;
    }
    kept.push(sentence);
    spent += words;
    if (spent >= budget) {
      break;
    }
  }
  return packIntoLines(kept).slice(0, MAX_LINES);
}

/** Words too common to say anything about what a line is about. */
const FILLER = new Set([
  'the', 'a', 'an', 'and', 'but', 'or', 'so', 'is', 'it', 'its', 'was', 'be',
  'been', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'that', 'this', 'there',
  'here', 'you', 'your', 'i', 'im', 'me', 'my', 'we', 'they', 'he', 'she',
  'not', 'no', 'yes', 'do', 'does', 'did', 'have', 'has', 'had', 'will',
  'would', 'can', 'could', 'if', 'as', 'up', 'out', 'about', 'just', 'like',
  'what', 'who', 'how', 'why', 'when', 'where', 'still', 'got', 'get', 'one'
]);

function contentWords(line: string): Set<string> {
  return new Set(
    line
      .toLowerCase()
      .replace(/[^a-z\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 2 && !FILLER.has(word))
  );
}

/**
 * Whether a character is about to say something it has effectively just said.
 *
 * Exact-match checks catch nothing, because a model never repeats itself
 * word for word: it says "the road's the same as ever" and then "same road as
 * always" and sounds like a broken toy. Comparing what a line is *about*
 * catches that.
 */
export function isTooSimilar(line: string, recent: string[], threshold = 0.6): boolean {
  const words = contentWords(line);
  if (words.size === 0) {
    return recent.some((said) => said.toLowerCase() === line.toLowerCase());
  }
  for (const said of recent) {
    const before = contentWords(said);
    if (before.size === 0) {
      continue;
    }
    let shared = 0;
    for (const word of words) {
      if (before.has(word)) {
        shared++;
      }
    }
    // Against the shorter line, so a long rambling repeat of a short remark
    // still counts as the same remark.
    if (shared / Math.min(words.size, before.size) >= threshold) {
      return true;
    }
  }
  return false;
}

/**
 * A subject a character keeps coming back to. Naming it in the prompt works
 * far better than a general plea not to repeat itself, which models agree to
 * and then ignore.
 */
export function harpingOn(recent: string[], minLines = 3): string {
  if (recent.length < minLines) {
    return '';
  }
  const counts = new Map<string, number>();
  for (const line of recent.slice(-6)) {
    for (const word of contentWords(line)) {
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  const stuck = [...counts.entries()]
    .filter(([, count]) => count >= minLines)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 2)
    .map(([word]) => word);
  return stuck.length === 0
    ? ''
    : `You have brought up ${stuck.map((word) => `"${word}"`).join(' and ')} in most of `
      + 'your last few lines. Talk about something else, or say nothing.';
}

function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let current = '';
  for (const character of text) {
    current += character;
    if ('.!?'.includes(character)) {
      sentences.push(current.trim());
      current = '';
    }
  }
  if (current.trim()) {
    sentences.push(current.trim());
  }
  return sentences;
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Fill each chat line as full as it will go, breaking only between words. */
function packIntoLines(sentences: string[]): string[] {
  const lines: string[] = [];
  let line = '';
  const push = () => {
    if (line) {
      lines.push(line);
      line = '';
    }
  };
  for (const sentence of sentences) {
    for (const piece of sentence.length > CHAT_LINE_LIMIT ? breakUp(sentence) : [sentence]) {
      const candidate = line ? `${line} ${piece}` : piece;
      if (candidate.length > CHAT_LINE_LIMIT) {
        push();
        line = piece;
        continue;
      }
      line = candidate;
    }
  }
  push();
  return lines;
}

/** A sentence too long for one line, split on words as late as it can be. */
function breakUp(sentence: string): string[] {
  const pieces: string[] = [];
  let rest = sentence;
  while (rest.length > CHAT_LINE_LIMIT) {
    let cut = rest.lastIndexOf(' ', CHAT_LINE_LIMIT);
    if (cut <= 0) {
      cut = CHAT_LINE_LIMIT;
    }
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) {
    pieces.push(rest);
  }
  return pieces;
}
