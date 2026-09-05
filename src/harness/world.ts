/**
 * The little a character is born knowing.
 *
 * This file used to be a gazetteer of the whole world, which quietly made
 * every character omniscient: they could name rooms they had never entered and
 * walk straight to landmarks nobody had shown them. That empties the world out.
 * If everyone already knows what is upstairs, nobody ever goes to look, and
 * nothing anybody says about it is worth hearing.
 *
 * So what is here is only home: the town these characters live in and the inn
 * they drink in, the way you know your own street. Everything past those doors
 * is found out by walking through them - see explore.ts for how a character
 * gets around a room it has never been in, and memory.ts for where what it
 * finds is kept.
 *
 * Doors are deliberately not listed. A character can see the doorways in
 * whatever room it is standing in, and where each one leads, because the
 * gateway reports them; that is reading the sign over the door. What is behind
 * it is not knowledge until somebody goes and looks.
 */

// Both of these named retired rooms until 2026-08-21. `reldens-town` and
// `reldens-house-1` were carried into the valley by upstream ec2126 and are
// gone; every coordinate below them described a map that no longer exists, so
// a character "knowing its way around" was being handed directions into empty
// space. reflex.ts had already moved on and named the live rooms itself, which
// left the two files disagreeing about where home is - the stale half of that
// split is what this replaces.
export const TOWN = process.env.ARENA_TOWN_SCENE ?? 'the-valley';
export const INN = process.env.ARENA_INN_SCENE ?? 'the-valley-inn';
/** The North path's first stop, and the only door out of the valley. */
export const STAIR = process.env.ARENA_STAIR_SCENE ?? 'millers-stair';

export type Place = { x: number; y: number; description: string };

/**
 * Home turf. Every coordinate was checked against the map's collision layers
 * and confirmed reachable on foot *from the door a character arrives through* -
 * not merely unblocked, which is weaker and lets a tile sit behind a wall.
 *
 * The valley entries are the map's own `return-point-*` properties, read out
 * of world-content/maps/the-valley.json: the tile the engine itself stands a
 * character on when it comes back out of each building. Nothing is more surely
 * walkable than the spot the engine picks to put a body, and it saves guessing
 * at a doorway's approach from the collision layer.
 *
 * The stair's are its arrival point and the centroids of the three nearest
 * respawn patches, taken from the map's own respawn-area layers. It is a
 * Voronoi maze - 20,245 of its 33,792 tiles are wall - so these are the
 * destinations, not the route; the pathfinder still has to find the way.
 */
export const PLACES: Record<string, Record<string, Place>> = {
  [TOWN]: {
    'the north road': {
      x: 2144,
      y: 96,
      description: "the top of the valley road, where it climbs out onto Miller's Stair"
    },
    'the smithy door': { x: 2912, y: 1088, description: "the way in to Nerys's forge" },
    'the mage shop door': { x: 2560, y: 1312, description: "the way in to Wren's shop" },
    'the inn door': { x: 1632, y: 1312, description: "the way in to Barnaby's inn" },
    'the trading post door': { x: 2560, y: 1568, description: 'the way in to the trading post' },
    'the grange door': { x: 1248, y: 1312, description: 'the way in to the grange' },
    'the shrine door': { x: 416, y: 1056, description: 'the way in to the shrine' },
    // NOT "the middle of the valley", which is what this was first called:
    // door matching runs before the same-room check and matches loosely on
    // shared words, so that name collided with the doors to `the-valley-inn`
    // and the rest, and a character asking for it walked into the inn. Any
    // place name here that contains "valley" has the same problem.
    'the open ground': { x: 2272, y: 1184, description: 'the middle of the valley, where Aveline stands' },
    'the west end': { x: 352, y: 1504, description: 'the low western corner, where Doran stands' }
  },
  [INN]: {
    'the bar': { x: 416, y: 160, description: 'where Barnaby stands' },
    'the middle of the floor': {
      x: 672,
      y: 608,
      description: 'clear floor in the middle of the room, in line with the door'
    },
    'the near table': { x: 352, y: 352, description: 'the table Hollis keeps' },
    'the far table': { x: 608, y: 352, description: "the table on Marren's side" },
    'the inn door': { x: 672, y: 736, description: 'the way back out to the valley' }
  },
  [STAIR]: {
    'the valley gate': {
      x: 6048,
      y: 11104,
      description: 'the cut in the south wall, back down to the valley'
    },
    'the first bay': { x: 7200, y: 10784, description: 'the passing bay just up the stair, where scuttlers work' },
    'the low bay': { x: 4256, y: 10976, description: 'the bay west along the bottom, thick with grubs' },
    'the upper bay': { x: 5024, y: 9504, description: 'the next bay up the climb, grubs again' }
  }
};

export function placesIn(scene: string): Record<string, Place> {
  return PLACES[scene] ?? {};
}

/**
 * How many pixels a tile is, in a given room.
 *
 * THE HARNESS ASSUMED 32 EVERYWHERE, and for the demo world that was true -
 * reflex.ts still says so in as many words: "the forest is 145x145 tiles, the
 * grassland 30x20, the shore 60x40, all at 32px a tile". Every room upstream
 * has built since is 64: the valley is 68x40 at 64, its interiors likewise,
 * Miller's Stair 192x176 at 64. Read off each map's own `tilewidth` in
 * world-content/maps, not inferred.
 *
 * Getting this wrong is not a rounding error, it is a different map. An enemy
 * on tile (14,43) sits at pixel (928, 2784); converted at 32 it comes out at
 * (464, 1392), the wrong half of the room, and a walk aimed there arrives
 * nowhere near it. Distances break the other way: `distanceFromSelf` is in
 * pixels, so dividing by 32 in a 64px room reports every enemy as twice as
 * far as it is, which is how a 14-tile leash came to reject things standing
 * seven tiles away and the pair spent an evening swinging at nothing.
 */
const TILE_PX: Record<string, number> = {
  [TOWN]: 64,
  [INN]: 64,
  [STAIR]: 64,
  'the-valley-smithy': 64,
  'the-valley-mage': 64,
  'the-valley-trading-post': 64,
  'the-valley-grange': 64,
  'the-valley-shrine': 64
};

/**
 * 32 is the default, and it is right for more of the world than "legacy"
 * suggests. Every room that predates the valley is 32, and so is every one
 * of the twelve frontier rooms added on 2026-08-22 - measured off their own
 * maps, not assumed. Only the valley, its six interiors and Miller's Stair
 * are 64, and they are all listed above. So a room missing from that table
 * is 32 by fact rather than by hope.
 */
export function tilePxFor(scene: string | null | undefined): number {
  return (scene && TILE_PX[scene]) || 32;
}

/** Whether this is somewhere the character grew up knowing its way around. */
export function isHomeTurf(scene: string): boolean {
  return scene in PLACES;
}

/**
 * The real places in rooms a character knows by heart but is not standing in.
 *
 * Everyone can see the room they are in. An innkeeper who has stood behind the
 * same bar for years also knows his own street, and being able to say "the east
 * gate is that way" is the difference between a local and a stranger. Without
 * it he has nothing true to offer when somebody asks for directions, and a
 * model with nothing true to offer invents a guildhall.
 *
 * Only ever the coordinates already checked against the map, and only for the
 * characters given it on their sheet. This is not the gazetteer this file used
 * to be: it is one person knowing their own town.
 */
export function describeLocalKnowledge(scenes: string[], standingIn: string): string {
  const lines: string[] = [];
  for (const scene of scenes) {
    if (scene === standingIn) {
      continue;
    }
    const places = placesIn(scene);
    const names = Object.keys(places);
    if (names.length === 0) {
      continue;
    }
    lines.push(`In ${plainSceneName(scene)}, which you know your way around:`);
    lines.push(...names.map((name) => `  ${name} - ${places[name].description}`));
  }
  if (lines.length === 0) {
    return '';
  }
  lines.push('These are the places you can actually send somebody to. There are no others you know of.');
  return lines.join('\n');
}

export function describePlaces(scene: string): string {
  const places = placesIn(scene);
  const names = Object.keys(places);
  if (names.length === 0) {
    return '';
  }
  // Coordinates ride along because an agentic character moves itself with
  // arena_move_to(x, y): a place it can name but not locate is a place it can
  // only talk about. The old harness resolved names to coordinates on the
  // model's behalf; now the map itself has to say where things are.
  return names
    .map(
      (name) =>
        `- "${name}" (x ${places[name].x}, y ${places[name].y}): ${places[name].description}`
    )
    .join('\n');
}

/** Which room a named place is in, of the rooms a character knows by heart. */
export function roomOf(place: string): string | null {
  const wanted = place.trim().toLowerCase();
  for (const [scene, places] of Object.entries(PLACES)) {
    if (Object.keys(places).some((name) => name.toLowerCase() === wanted)) {
      return scene;
    }
  }
  return null;
}

/**
 * A room's name as a person would say it, not as the database spells it.
 *
 * This is the sign over the door, and it is the one bit of the world every
 * character is allowed to read without going in: the gateway reports where a
 * doorway leads, so a character standing in the street can tell the inn from
 * the house next to it the same way anybody could. Without distinct names both
 * doors read as "somewhere else", the character picks whichever, and you get
 * Guy announcing he is off to the house on the east side and walking straight
 * back into the inn.
 *
 * Naming a door is not knowing what is behind it. "Upstairs at the inn" tells
 * a character the stairs exist, which they can see; it does not tell them what
 * is up there, which is the thing worth going to find out.
 */
export const SCENE_NAMES: Record<string, string> = {
  [TOWN]: 'the valley',
  [INN]: "Barnaby's inn",
  // The valley's other five interiors, and the stair above it. Without these
  // the fallback below hands a character the database key with its hyphens
  // filed off - "the valley smithy", "millers stair" - which is close enough
  // to read past and wrong enough to say out loud.
  [STAIR]: "Miller's Stair",
  'the-valley-smithy': "the smithy",
  'the-valley-mage': "the mage's shop",
  'the-valley-trading-post': 'the trading post',
  'the-valley-grange': 'the grange',
  'the-valley-shrine': 'the shrine',
  // The frontier, opened 2026-08-22. Four cardinal paths lead out of the
  // valley, three stops each; the harness reached this world knowing only
  // the first stop of one of them. Named here because the fallback files
  // the hyphens off a key and says "widows watch" and "salt vein" out loud.
  'millrace-approach': 'the mill road',
  'millrace-ford': 'the Millrace Ford',
  'reed-camp': 'the reed camp',
  'driftwood-landing': 'Driftwood Landing',
  'oathstone': 'the Oathstone',
  'bleaching-flats': 'the bleaching flats',
  'caravan-rest': 'the caravan rest',
  'sinkfoot-crossing': 'Sinkfoot Crossing',
  'grey-reeds': 'the grey reeds',
  'last-farm': 'the last farm',
  'widows-watch': "Widow's Watch",
  'salt-vein': 'the salt vein',
  'reldens-house-1-2d-floor': 'upstairs at the inn',
  'reldens-house-2': 'the house on the east side',
  'reldens-forest': 'the woods',
  // Every remaining room, because the fallback below is not a name, it is a
  // database key with its punctuation filed off. Guy was heard talking about
  // "bots", and nothing had leaked into his memory: reldens-bots is a real room
  // and the fallback handed him "bots" as the name of a place, so he did what
  // anybody would and said it out loud. The others were no better waiting to
  // happen - "gravity", "arena crypt", and a room that came out as "bots forest
  // house 01 n0", which no person has ever said.
  //
  // The demo rooms get names that fit what is actually in them: the two full of
  // walking trees are woodland, and the hut is the one building in it.
  'reldens-bots': 'the clearing',
  'reldens-bots-forest': 'the deep wood',
  'reldens-bots-forest-house-01-n0': "the woodcutter's hut",
  'reldens-gravity': 'the sunken chamber',
  // The arena regions. "Arena" is our word for them, not theirs.
  'arena-grassland': 'the grasslands',
  'arena-crypt': 'the crypt',
  'arena-depths': 'the depths',
  'arena-shore': 'the shore',
  'arena-volcano': 'the volcano',
  // Named for what the person down there is doing, which is counting them.
  'arena-dungeon': 'the cells'
};

export function plainSceneName(scene: string): string {
  return SCENE_NAMES[scene] ?? rawSceneName(scene);
}

/**
 * What a scene's own key reads as, with none of the overrides above applied -
 * "forest" for reldens-forest, never "the woods". plainSceneName() gives a
 * door only the pretty name; a character's own memory of a room it has
 * actually stood in is written in this raw form instead (see notePlace() in
 * npc.ts, which also calls plainSceneName() - but a room *without* an entry
 * above gets this same string back either way, since that is the fallback
 * plainSceneName() falls back to). A pretty override, when one exists, masks
 * this name completely, so a door has to be found both ways: see doorNames()
 * in actions.ts, which asks for both and is the whole reason this exists as
 * its own function rather than staying folded into plainSceneName().
 */
export function rawSceneName(scene: string): string {
  // Both prefixes, not just the engine's. "arena" is our word for a group of
  // rooms and no more a place than "reldens" is, so a region added tomorrow
  // without an entry above should read as "somewhere new" rather than "arena
  // somewhere new". The named rooms above are the fix for the world as it
  // stands; this is the fix for the next one somebody adds, which is the one
  // that would otherwise be found by hearing a character say it out loud.
  return scene.replace(/^(reldens|arena)-/, '').replace(/-/g, ' ');
}

/**
 * Every place in this world, by name, and nothing whatever about what is in it.
 *
 * This file opens by warning against exactly this, and the warning still holds:
 * a gazetteer handed to everybody made every character omniscient, so nobody
 * ever went to look at anything and nothing anybody said was worth hearing.
 * What follows is narrower than that on purpose, and is given to one person.
 *
 * It is a list of names. Not where anything is, not what is through which door,
 * not a single coordinate. That is the difference between a map and having
 * heard of somewhere, and a man who has stood behind a bar for forty years
 * listening to travellers has certainly heard of the volcano. He has never been
 * up it and this tells him nothing about it.
 *
 * The reason he needs it is not so he can describe those places. It is so he
 * can tell when somebody names one that does not exist. Guests have started
 * asking after the Hinge Gate and the pantry door, and a man who cannot say
 * "there is no such place" is no use as a record at all: he nods along, and
 * the next person to ask gets told the innkeeper confirmed it.
 */
export function everywhereByName(): string[] {
  return [...new Set(Object.values(SCENE_NAMES))].sort();
}

/** The scene whose in-world name this is, if any. The reverse of plainSceneName. */
export function sceneNamed(name: string): string | null {
  const wanted = String(name ?? '').trim().toLowerCase();
  for (const [scene, pretty] of Object.entries(SCENE_NAMES)) {
    if (pretty.toLowerCase() === wanted || rawSceneName(scene).toLowerCase() === wanted) {
      return scene;
    }
  }
  return null;
}
