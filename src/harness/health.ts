/**
 * The public watch feed, read for what the gateway hides: real hit points
 * and everyone's whereabouts. The agent API says hp "unknown" while a
 * knight bleeds out; the audience's feed says 43/100 and which room. So
 * the body learns how it feels - and where its partner is - by watching
 * the broadcast. One fetch serves every question for seven seconds.
 */

const FEED = process.env.NPC_WATCH_FEED ?? 'https://world.yougotserved.dev/api/watch/feed';
const MIN_INTERVAL_MS = 7_000;

type Standing = {
  room: string;
  x: number;
  y: number;
  level: number | null;
  hp: { value: number; total: number } | null;
  mp: { value: number; total: number } | null;
};

let lastAt = 0;
let lastMap: Map<string, Standing> | null = null;

async function feed(): Promise<Map<string, Standing> | null> {
  if (Date.now() - lastAt < MIN_INTERVAL_MS) {
    return lastMap;
  }
  lastAt = Date.now();
  try {
    const response = await fetch(FEED, {
      headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) agent-arena-npc-health' },
      signal: AbortSignal.timeout(5_000)
    });
    if (!response.ok) {
      return lastMap;
    }
    const body = (await response.json()) as {
      scenes?: Array<{
        roomName?: string;
        players?: Array<{ name?: string; x?: number; y?: number; sheet?: { hp?: { value?: number; total?: number }; mp?: { value?: number; total?: number }; progress?: { level?: number } } }>;
      }>;
    };
    const map = new Map<string, Standing>();
    for (const scene of body.scenes ?? []) {
      for (const player of scene.players ?? []) {
        if (player.name) {
          map.set(player.name, {
            room: scene.roomName ?? '',
            x: player.x ?? 0,
            y: player.y ?? 0,
            level: player.sheet?.progress?.level ?? null,
            hp: player.sheet?.hp
              ? { value: player.sheet.hp.value ?? 0, total: player.sheet.hp.total ?? 100 }
              : null,
            mp: player.sheet?.mp
              ? { value: player.sheet.mp.value ?? 0, total: player.sheet.mp.total ?? 100 }
              : null
          });
        }
      }
    }
    lastMap = map;
    return map;
  } catch {
    return lastMap;
  }
}

export async function ownHealth(playerName: string): Promise<{ value: number; total: number } | null> {
  return (await feed())?.get(playerName)?.hp ?? null;
}

export async function whereIs(playerName: string): Promise<string | null> {
  return (await feed())?.get(playerName)?.room ?? null;
}

/** Everyone ELSE standing in a room, with their health, for the rescue watch. */
export async function othersIn(
  room: string,
  excluding: string[]
): Promise<Array<{ name: string; x: number; y: number; hpPct: number | null }>> {
  const map = await feed();
  if (!map) {
    return [];
  }
  const out: Array<{ name: string; x: number; y: number; hpPct: number | null }> = [];
  for (const [name, standing] of map) {
    if (standing.room === room && !excluding.includes(name)) {
      out.push({
        name,
        x: standing.x,
        y: standing.y,
        hpPct: standing.hp && standing.hp.total > 0 ? (100 * standing.hp.value) / standing.hp.total : null
      });
    }
  }
  return out;
}

/** Every player anywhere, for the realm-wide distress scan. */
export async function everyoneEverywhere(
  excluding: string[]
): Promise<Array<{ name: string; room: string; hpPct: number | null }>> {
  const map = await feed();
  if (!map) {
    return [];
  }
  const out: Array<{ name: string; room: string; hpPct: number | null }> = [];
  for (const [name, standing] of map) {
    if (!excluding.includes(name)) {
      out.push({
        name,
        room: standing.room,
        hpPct: standing.hp && standing.hp.total > 0 ? (100 * standing.hp.value) / standing.hp.total : null
      });
    }
  }
  return out;
}

export async function locate(
  playerName: string
): Promise<{
  room: string;
  x: number;
  y: number;
  level: number | null;
  hp: { value: number; total: number } | null;
  mp: { value: number; total: number } | null;
} | null> {
  const standing = (await feed())?.get(playerName);
  return standing
    ? { room: standing.room, x: standing.x, y: standing.y, level: standing.level, hp: standing.hp, mp: standing.mp }
    : null;
}
