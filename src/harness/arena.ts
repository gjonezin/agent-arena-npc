/**
 * The Arena's MCP endpoint, spoken to the way any other agent would.
 *
 * This is deliberately not a general MCP client. Guy is an NPC, and the tools
 * he is given are a small, safe subset of what the gateway exposes, wrapped so
 * a model can only ask for things that make sense for a person in a town. The
 * gateway is the boundary that enforces that anyway, but there is no reason to
 * hand a character sheet the whole surface.
 */

const MCP_URL = process.env.ARENA_MCP_URL ?? 'https://mcp.yougotserved.dev/mcp';
const API_KEY = process.env.ARENA_API_KEY ?? '';
const REQUEST_TIMEOUT_MS = 60_000;
/** How long one landed hit or kill keeps answering "this ground is worth
 *  standing on". Three beats at the round's ~5s cadence - long enough to
 *  outlast the futile-strike limit it feeds, short enough that a field
 *  which genuinely goes quiet is still abandoned. */
const LANDED_WINDOW_MS = 15_000;

/**
 * An NPC, trader, or enemy standing in the scene, as arena_observe reports it.
 * `label` is its name, the way a person would refer to it. `objectIndex` is
 * what targets an attack; it is not the same value as an NPC dialogue box's
 * id, which the gateway keeps to itself and this harness never needs to see
 * directly - talking to someone is done by name, the way a character actually
 * thinks about who it is talking to.
 */
export type ArenaObject = {
  objectId: number | null;
  objectIndex: string;
  label: string;
  kind: 'npc' | 'enemy';
  /**
   * Whether this one keeps a shop. A trader and a townsperson are both people
   * you walk up to and talk to, so they arrive with the same `kind`; only this
   * says which of them will sell you anything.
   */
  isMerchant?: boolean;
  interactable?: boolean;
  distanceFromSelf?: number;
  /**
   * Since the 2026-08-14 server update a killed enemy stays in the object
   * list as a corpse with alive: false until it respawns. Absent means an
   * older payload that only ever listed the living, so only an explicit
   * false means dead.
   */
  alive?: boolean;
  /** Live health, as of hpSeenMsAgo milliseconds ago (server added these
   *  2026-08-15 - the whole basis for killing the weakest thing first). */
  hp?: number;
  hpMax?: number;
  hpSeenMsAgo?: number;
  /** What the server says about how dangerous this one is. */
  threat?: string | number | null;
  /**
   * Where it is standing, in tiles rather than pixels - the gateway never
   * hands the harness raw pixel coordinates for another object, only its own.
   * Required rather than optional: headless-client.js's visibleEntities()
   * computes these for every entity it reports and drops anything it could
   * not (see the filter right after roomObjectEntities() in that file), so
   * an object that reaches here always has them. See walkToSomebody() in
   * actions.ts for what they are for: reaching somebody outside home turf,
   * where there is no other way to say where to walk.
   */
  tileX: number;
  tileY: number;
};

/**
 * One thing in the satchel, as the gateway reports it. `key` is what the
 * world knows it by and what the trading tools want; `label` is what a person
 * would call it. Nothing in this harness has a list of what any of these
 * might be - the catalogue lives in the world, and a character only ever
 * knows what it is actually holding.
 */
export type CarriedItem = {
  key: string;
  label: string;
  description?: string | null;
  quantity: number;
  usable: boolean;
  equipment: boolean;
  equipped: boolean;
};

/**
 * Loot on the ground. `itemKey` is read back out of the drop's id by the
 * gateway and is null when it could not be, because the world announces a
 * drop as a sprite and a position and never says what it is.
 */
export type SeenDrop = {
  dropId: string;
  itemKey: string | null;
  distanceFromSelf?: number;
};

export type Observation = {
  ownPlayer?: { state?: { scene?: string; x?: number; y?: number } };
  sceneName?: string;
  /**
   * Everyone standing in the room. The gateway has always sent sessionId,
   * playerId and full state for each of them; this type used to keep only the
   * name and throw the rest away at the boundary, which is why no character
   * could ever aim at a person. Duelling needs the ids: a player target goes
   * out as target_session_id/target_player_id where an enemy goes out as an
   * object index.
   */
  players?: Array<{
    name?: string;
    label?: string;
    playerName?: string;
    sessionId?: string;
    playerId?: number;
    state?: { x?: number; y?: number; scene?: string };
  }>;
  chat?: Array<{ from?: string; message?: string; receivedAt?: string }>;
  recentChat?: Array<{ from?: string; message?: string; receivedAt?: string }>;
  /** Nearby NPCs, traders, and enemies. See ArenaObject. */
  objects?: ArenaObject[];
  /**
   * What this character is holding. It rides along with the observation
   * rather than being fetched on its own, because the gateway keeps a running
   * copy of it and reading that costs nothing - and a character that has to
   * make a second call to find out what is in its own pockets will not bother.
   */
  carrying?: CarriedItem[];
  /** What is lying on the floor of this room. See SeenDrop. */
  drops?: SeenDrop[];
};

export class ArenaClient {
  private sessionId: string | null = null;
  private nextId = 1;

  async rpc(method: string, params: unknown): Promise<any> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${API_KEY}`,
      'mcp-protocol-version': '2025-06-18',
      // Cloudflare rejects unrecognised agents at the edge.
      'user-agent': 'AgentArena-Guy/1.0'
    };
    if (this.sessionId) {
      headers['mcp-session-id'] = this.sessionId;
    }
    const response = await fetch(MCP_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    this.sessionId = response.headers.get('mcp-session-id') ?? this.sessionId;
    const contentType = response.headers.get('content-type') ?? '';
    const payload = contentType.includes('text/event-stream')
      ? await readSseEvent(response)
      : await response.json();
    if (payload?.error) {
      throw new Error(`${method}: ${JSON.stringify(payload.error)}`);
    }
    return payload?.result;
  }

  async start(): Promise<void> {
    this.sessionId = null;
    await this.rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'guy', version: '1.0' }
    });
    await this.rpc('notifications/initialized', {}).catch(() => undefined);
  }

  /** Battle damage taken per the most recent response, and whether the body died lately. */
  private lastBattleDamage = 0;
  private lastDied = false;
  private lastAggressors = 0;
  private lastAggressorIds: string[] = [];
  private lastOwnHp: { value: number; total: number } | null = null;
  /** What the battle payload last said about who is steering this body.
   *  Null until a payload has said anything, and nulled again by a payload
   *  whose battle is null - "unknown" and "over" both read as no chase,
   *  which errs on the side of our own movement, the older behavior. */
  private lastChase: { inBattle: boolean; mode: string | null } | null = null;
  /** Highest battle-event seq already accounted for, so one event latches
   *  the window below exactly once. The battle log keeps only its last
   *  dozen entries, so without this a single old kill sitting in that
   *  window would re-latch on every tick and hold `landed` true forever. */
  private lastEventSeq = 0;
  /** WHEN this character last landed something, not WHETHER (2026-08-16).
   *  A boolean here was a per-payload snapshot, and noteDanger runs on
   *  every gateway answer - several per tick. arena_render_map fires
   *  between arena_observe and the round's own read, carries a battle
   *  payload of its own, and recomputed the flag from events already
   *  consumed, so the round read false every single time and the fix this
   *  feeds was a silent no-op. A timestamp cannot be clobbered that way:
   *  ordering within a tick stops mattering, because nothing clears it.
   *  Note the reconnect asymmetry, which is bounded and self-correcting
   *  rather than a bug to fix: a reconnect builds a fresh ArenaClient so
   *  both fields here reset, but arena_login on a still-live session hands
   *  back the SAME gateway body, keeping its high seq and its dozen-event
   *  window - so a kill still sitting in that window latches once as if it
   *  had just happened. It expires on its own inside the window below. */
  private lastLandedAt = 0;

  ownHpFromBattle(): { value: number; total: number } | null {
    return this.lastOwnHp;
  }

  /** The server-side chase as the battle payload last reported it, if it has. */
  chaseFromBattle(): { inBattle: boolean; mode: string | null } | null {
    return this.lastChase;
  }

  /** The objectIndexes of everything currently swinging at us. */
  aggressorIndexes(): string[] {
    return this.lastAggressorIds;
  }

  danger(): { damage: number; died: boolean; aggressors: number; landed: boolean } {
    return {
      damage: this.lastBattleDamage,
      died: this.lastDied,
      aggressors: this.lastAggressors,
      // Three beats of grace at the round's ~5s cadence, so one landed hit
      // answers the "is this ground dead" question for about as long as it
      // takes futileStrikes to reach its own limit.
      landed: 0 !== this.lastLandedAt && Date.now() - this.lastLandedAt < LANDED_WINDOW_MS
    };
  }

  private lastBattleLogged = 0;

  /** Pull hurt/death facts off a parsed gateway response. Every tool answer carries them. */
  private noteDanger(result: unknown): void {
    const peek = result as { battle?: unknown } | null;
    if (peek && 'object' === typeof peek && peek.battle && Date.now() - this.lastBattleLogged > 60_000) {
      this.lastBattleLogged = Date.now();
      console.log('battle payload:', JSON.stringify(peek.battle).slice(0, 600));
    }
    if (!result || 'object' !== typeof result) {
      return;
    }
    const body = result as {
      battle?: {
        aggressors?: Array<{ damageDealtToYou?: number; objectIndex?: string }>;
        events?: Array<{ seq?: number; event_type?: string }>;
      } | null;
      recentlyDied?: boolean;
    };
    if ('recentlyDied' in body) {
      this.lastDied = true === body.recentlyDied;
    }
    if (undefined !== body.battle) {
      // DID WE LAND ANYTHING? The battle payload's event log is the only
      // place that says so - `aggressors` counts who is hitting US, which
      // is a different question and is structurally zero in a room authored
      // passive whose enemies die to one swing. These events are already
      // ours alone: the gateway records damage_dealt only for our own
      // session, and enemy_killed only for a body we personally damaged
      // (battle-sense.js), so no filtering by actor is needed here - and
      // filtering on actor_id would in fact break enemy_killed, which
      // carries a null actor by design when somebody else lands the last
      // blow on a kill we contributed to.
      const events = body.battle?.events ?? [];
      let highest = this.lastEventSeq;
      let newest = 0;
      for (const event of events) {
        const seq = 'number' === typeof event?.seq ? event.seq : 0;
        if (seq > newest) {
          newest = seq;
        }
        if (seq <= this.lastEventSeq) {
          continue;
        }
        if (seq > highest) {
          highest = seq;
        }
        if ('damage_dealt' === event?.event_type || 'enemy_killed' === event?.event_type) {
          this.lastLandedAt = Date.now();
        }
      }
      // A genuinely restarted log rewinds seq, and only a fresh session does
      // that - the gateway's counter survives room changes, deaths and
      // episode resets. So the test is whether the payload's HIGHEST seq
      // has fallen below what we have already seen. An earlier version
      // asked whether ANY single event sat below half of it, which is true
      // of the trimmed twelve-event window for every seq under 22 and made
      // the whole counter oscillate between 0 and 17 on the same payload.
      // The `<= TIMELINE_KEPT` clause matters more than it looks: a
      // restarted log's newest event is necessarily inside its first dozen,
      // whereas a REPLY THAT ARRIVED LATE also reads as a rewind, and that
      // is the reachable case - the busker's melody loop shares this client
      // with the main tick and rpc() takes no lock, so answers can overtake
      // each other. Without this clause a lagging reply wipes the de-dup
      // guard and the next payload re-latches a kill that is 20s stale.
      const TIMELINE_KEPT = 12;
      if (newest > 0 && newest < this.lastEventSeq && newest <= TIMELINE_KEPT) {
        this.lastEventSeq = 0;
      } else {
        this.lastEventSeq = highest;
      }
      this.lastBattleDamage =
        body.battle?.aggressors?.reduce((sum, a) => sum + (a.damageDealtToYou ?? 0), 0) ?? 0;
      this.lastAggressors = body.battle?.aggressors?.length ?? 0;
      this.lastAggressorIds = (body.battle?.aggressors ?? [])
        .map((a) => String((a as { objectIndex?: string }).objectIndex ?? ''))
        .filter(Boolean);
      // The updated gateway writes hp as "123/190" in battle payloads -
      // truer and fresher than the spectator feed.
      const hpText = (body.battle as { hp?: unknown } | null)?.hp;
      if ('string' === typeof hpText && /^\d+\/\d+$/.test(hpText)) {
        const [value, total] = hpText.split('/').map(Number);
        this.lastOwnHp = { value, total };
      }
      // WHO IS STEERING THE BODY. The same payload names the fight itself:
      // {"inBattle":true,...,"mode":"semi_auto"}. Under semi_auto the server
      // walks this body toward its own target, and the gateway's ownership
      // rule is that whatever moved a body most recently owns it - so
      // anything of ours that issues movement needs to know when the server
      // is already driving. A battle object that omits the flag leaves the
      // last reading alone, the same stance the hp parse above takes.
      if (null === body.battle) {
        this.lastChase = null;
      } else {
        const fight = body.battle as { inBattle?: unknown; mode?: unknown };
        if ('boolean' === typeof fight.inBattle) {
          this.lastChase = {
            inBattle: fight.inBattle,
            mode: 'string' === typeof fight.mode ? fight.mode : null
          };
        }
      }
    }
  }

  async call(name: string, args: Record<string, unknown>): Promise<any> {
    // SAY WHAT WE SENT. A schema rejection ("expected number, received
    // undefined") is useless without the arguments that caused it, and the
    // round log truncates the gateway's message before the offending field
    // is named. Carrying the payload into the error turns a mystery into a
    // one-line diagnosis.
    let result;
    try {
      result = await this.rpc('tools/call', { name, arguments: args });
    } catch (error) {
      const sent = JSON.stringify(args, (_k, v) => (undefined === v ? '<<undefined>>' : (Number.isNaN(v as number) ? '<<NaN>>' : v)));
      throw new Error(`${(error as Error)?.message ?? String(error)} | sent ${sent}`);
    }
    if (!result?.content?.length) {
      throw new Error(`${name}: the gateway answered with no content at all`);
    }
    const text = String(result.content[0].text ?? '');
    // The gateway started answering some tools in TOON rather than JSON
    // (2026-08-14: arena_list_agents arrives as "agents[4]{id,...}:" plus
    // rows). Errors still arrive as JSON. Try JSON first, TOON second, and
    // if neither reads, say what actually arrived instead of "Unexpected
    // token" - a reconnect loop with a mute error cost us an evening.
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      if (result.isError) {
        throw new Error(`${name}: ${text.slice(0, 300)}`);
      }
      // ORDER MATTERS. A truncated JSON document still LOOKS like TOON to a
      // tolerant decoder: toonDecode() happily returns a garbage object
      // instead of throwing, so the salvage below never ran and every
      // character was handed a world with no objects in it. Try the salvage
      // FIRST whenever the text opens as JSON - if it began life as a JSON
      // document, TOON is not what it is.
      const early = text.startsWith('{') ? salvageTruncated(text) : null;
      if (early) {
        console.log(`[salvage] ${name}: reply truncated by the gateway; recovered ${early.objects?.length ?? 0} objects, ${early.players?.length ?? 0} players, ${early.items?.length ?? 0} items`);
        this.noteDanger(early);
        return early;
      }
      try {
        body = toonDecode(text);
      } catch {
        // SALVAGE A TRUNCATED WORLD. The gateway caps a tool result at
        // 49,152 bytes and cuts mid-string (bugs.md #10), so a busy scene's
        // arena_observe - 66KB of it, mostly item descriptions - arrives as
        // unparseable JSON. Treating that as a dead reply left the character
        // with NO objects, NO enemies and NO players: Lord Gemma was beaten
        // from 45hp to 6hp across three beats that each logged "enemies 0",
        // unable to fight back at something he could not see. A partial
        // world is worth infinitely more than an empty one, so rescue every
        // COMPLETE record the cut left behind.
        const salvaged = salvageTruncated(text);
        if (salvaged) {
          // Items counted alongside the rest (2026-08-16): the pack is the
          // one array whose recovery nobody could see, and it is the array
          // every ownership question reads. Without it "recovered 6 objects,
          // 3 players" looks like a healthy salvage while the pack behind it
          // is empty - which is exactly how "equip_best -> nothing to wear"
          // went unexplained.
          const counts = `${salvaged.objects?.length ?? 0} objects, ${salvaged.players?.length ?? 0} players, ${salvaged.items?.length ?? 0} items`;
          console.log(`[salvage] ${name}: reply truncated by the gateway; recovered ${counts}`);
          body = salvaged;
        } else {
          throw new Error(`${name}: unreadable reply (not JSON, not TOON): ${text.slice(0, 200)}`);
        }
      }
    }
    // A DECODE THAT SUCCEEDS AND SAYS NOTHING. Measured 2026-08-16:
    // "[equip] nothing to wear: 0 rows back, 0 equipment; reply keys {}" -
    // arena_inventory answering with an object carrying no keys at all, no
    // error raised and no salvage line logged, from a character holding 184
    // rows. Every reader downstream treats that as "the pack is empty", so
    // the gear cannot be worn and nothing says why. toonDecode() is the
    // documented suspect: the comment above already records that it returns
    // a garbage object instead of throwing, which is precisely how a reply
    // arrives keyless without ever reaching the salvage. Rather than guess
    // which encoding it is, print what actually came over the wire, once
    // per occurrence, capped so a big body cannot flood the journal.
    if (body && 'object' === typeof body && 0 === Object.keys(body).length) {
      console.log(`[decode] ${name}: reply decoded to an EMPTY object; ${text.length} bytes, opens: ${JSON.stringify(text.slice(0, 160))}`);
    }
    if (result.isError) {
      throw new Error(`${name}: ${body?.error}: ${body?.message}`);
    }

    this.noteDanger(body);
    return body;
  }
}

/**
 * Read a TOON document into the same shapes JSON.parse would have given us.
 *
 * Covers the subset the gateway emits: `key: value` scalars, nested objects
 * by indentation, inline primitive arrays `key[N]: a,b,c`, dash-list arrays,
 * and tabular arrays `key[N]{f1,f2}:` followed by comma-separated rows with
 * double-quoted cells. Anything it cannot read raises, and call() reports
 * the raw text.
 */
export function toonDecode(text: string): any {
  const rows = text.replace(/\t/g, '  ').split('\n');
  const lines: Array<{ indent: number; body: string }> = [];
  for (const row of rows) {
    if (!row.trim()) {
      continue;
    }
    lines.push({ indent: row.length - row.trimStart().length, body: row.trim() });
  }
  if (!lines.length) {
    return null;
  }
  let i = 0;

  const scalar = (raw: string): any => {
    const t = raw.trim();
    if ('' === t) return '';
    if ('true' === t) return true;
    if ('false' === t) return false;
    if ('null' === t) return null;
    if ('[]' === t) return [];
    if ('{}' === t) return {};
    if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(t)) return Number(t);
    if (t.startsWith('"')) {
      try {
        return JSON.parse(t);
      } catch {
        return t.replace(/^"|"$/g, '');
      }
    }
    return t;
  };

  // Split one comma-separated row, honouring double quotes.
  const cells = (row: string): string[] => {
    const out: string[] = [];
    let cur = '';
    let quoted = false;
    for (let k = 0; k < row.length; k++) {
      const c = row[k];
      if (quoted) {
        if ('\\' === c) {
          cur += c + (row[k + 1] ?? '');
          k++;
        } else {
          cur += c;
          if ('"' === c) quoted = false;
        }
      } else if ('"' === c && '' === cur.trim()) {
        cur += c;
        quoted = true;
      } else if (',' === c) {
        out.push(cur);
        cur = '';
      } else {
        cur += c;
      }
    }
    out.push(cur);
    return out;
  };

  const KEY = `("(?:[^"\\\\]|\\\\.)*"|[^:\\[\\]{}]+)`;
  const tabular = new RegExp(`^${KEY}\\[(\\d+)(:?)\\]\\{(.+)\\}:\\s*$`);
  const listy = new RegExp(`^${KEY}\\[(\\d+)\\]:\\s*(.*)$`);
  const plain = new RegExp(`^${KEY}:\\s*(.*)$`);

  // A tabular header's field list can fold sub-objects inline:
  // players[2]{sessionId,state{x,y,scene},isSelf}: - each leaf takes one
  // cell of the row, and the group folds its leaves into a nested object.
  type FieldSpec = { name: string; subs?: FieldSpec[] };
  const splitFields = (spec: string): FieldSpec[] => {
    const out: FieldSpec[] = [];
    let depth = 0;
    let cur = '';
    const take = (piece: string): void => {
      const t = piece.trim();
      if (!t) return;
      const g = t.match(/^([^{]+)\{(.*)\}$/);
      if (g) {
        out.push({ name: g[1].trim(), subs: splitFields(g[2]) });
      } else {
        out.push({ name: t });
      }
    };
    for (const c of spec) {
      if ('{' === c) depth++;
      if ('}' === c) depth--;
      if (',' === c && 0 === depth) {
        take(cur);
        cur = '';
      } else {
        cur += c;
      }
    }
    take(cur);
    return out;
  };

  const foldRow = (fields: FieldSpec[], values: string[], cursor: { at: number }): any => {
    const row: Record<string, any> = {};
    for (const f of fields) {
      if (f.subs) {
        row[f.name] = foldRow(f.subs, values, cursor);
      } else {
        row[f.name] = scalar(values[cursor.at] ?? '');
        cursor.at++;
      }
    }
    return row;
  };

  const parseObject = (indent: number): any => {
    const obj: Record<string, any> = {};
    while (i < lines.length && lines[i].indent >= indent) {
      if (lines[i].indent > indent) {
        i++;
        continue;
      }
      const b = lines[i].body;
      let m = b.match(tabular);
      if (m) {
        const key = String(scalar(m[1]));
        const n = Number(m[2]);
        const keyed = ':' === m[3];
        const fields = splitFields(m[4]);
        i++;
        if (keyed) {
          // sharedProperties[2:]{label,value,max}: rows arrive as
          // "hp: HP,241,464" - an object keyed by the row's own name.
          const table: Record<string, any> = {};
          let taken = 0;
          while (i < lines.length && lines[i].indent > indent && taken < n) {
            const rm = lines[i].body.match(plain);
            if (!rm) break;
            table[String(scalar(rm[1]))] = foldRow(fields, cells(rm[2]), { at: 0 });
            taken++;
            i++;
          }
          obj[key] = table;
          continue;
        }
        const arr: any[] = [];
        while (i < lines.length && lines[i].indent > indent && arr.length < n) {
          arr.push(foldRow(fields, cells(lines[i].body), { at: 0 }));
          i++;
        }
        obj[key] = arr;
        continue;
      }
      m = b.match(listy);
      if (m) {
        const key = String(scalar(m[1]));
        const n = Number(m[2]);
        const rest = m[3];
        i++;
        if (rest.trim()) {
          obj[key] = cells(rest).map(scalar);
          continue;
        }
        const arr: any[] = [];
        while (i < lines.length && lines[i].indent > indent && arr.length < n) {
          const item = lines[i].body;
          if (item.startsWith('- ')) {
            const after = item.slice(2);
            if (plain.test(after) && !/^https?:/.test(after)) {
              const childIndent = lines[i].indent + 2;
              lines[i] = { indent: childIndent, body: after };
              arr.push(parseObject(childIndent));
            } else {
              arr.push(scalar(after));
              i++;
            }
          } else {
            arr.push(scalar(item));
            i++;
          }
        }
        obj[key] = arr;
        continue;
      }
      m = b.match(plain);
      if (m && !/^https?:/.test(b)) {
        const key = String(scalar(m[1]));
        const rest = m[2];
        i++;
        if ('' === rest) {
          obj[key] = i < lines.length && lines[i].indent > indent ? parseObject(lines[i].indent) : null;
        } else {
          obj[key] = scalar(rest);
        }
        continue;
      }
      // A document that is just a bare value.
      if (0 === Object.keys(obj).length && 1 === lines.length) {
        i++;
        return scalar(b);
      }
      i++;
    }
    return obj;
  };

  return parseObject(lines[0].indent);
}

/**
 * Take one complete event off an SSE response.
 *
 * The stream stays open after the reply is delivered, so this stops as soon as
 * what has arrived parses as JSON rather than reading to the end, which would
 * never come. Reading through response.body keeps the chunked transfer decoded
 * for us; reading a raw socket does not, and hands back payloads cut at chunk
 * boundaries.
 */
async function readSseEvent(response: Response): Promise<any> {
  const body = response.body;
  if (!body) {
    throw new Error('The MCP endpoint returned an event stream with no body.');
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let data: string[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffered += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, newline).replace(/\r$/, '');
        buffered = buffered.slice(newline + 1);
        if (line.startsWith('data:')) {
          data.push(line.slice(5).trimStart());
          try {
            return JSON.parse(data.join('\n'));
          } catch {
            continue; // a value split across several data: lines
          }
        }
        if (line === '') {
          data = []; // an event we could not read; start the next one clean
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  throw new Error('The MCP endpoint closed the stream without a reply.');
}

export function sceneOf(observation: Observation): string {
  return observation.ownPlayer?.state?.scene ?? observation.sceneName ?? '';
}

export function othersIn(observation: Observation, self: string): string[] {
  return (observation.players ?? [])
    .map((player) => nameOf(player))
    .filter((name) => name && name !== self);
}

export function nameOf(player: { name?: string; label?: string; playerName?: string }): string {
  return player.playerName ?? player.name ?? player.label ?? '';
}

/**
 * The engine's own chatter, which is not anybody speaking.
 *
 * Reldens announces joins, leaves and the like down the same channel people
 * talk on, as a bare key: "chat.joinedRoom". Nothing was filtering those, so
 * every one arrived as a line of dialogue from "someone", went into the
 * transcript, and was written to memory as a thing a character had heard said
 * to it. Guy's memory was largely this. It is the cheapest possible thing to
 * be paying to re-read on every tick for the rest of his life.
 *
 * Matched on the shape rather than a list of keys, so whatever the engine adds
 * next is caught too: these are all dotted identifiers with no spaces, and no
 * person says "chat.joinedRoom".
 */
const ENGINE_CHATTER = /^[a-z]+\.[a-zA-Z]+$/;

export function isEngineChatter(message: string): boolean {
  return ENGINE_CHATTER.test(String(message ?? '').trim().replace(/^"|"$/g, ''));
}

export function spokenLines(observation: Observation): Array<{ from: string; message: string; at: string }> {
  const entries = observation.chat ?? observation.recentChat ?? [];
  return entries
    .filter((entry) => entry.message)
    .filter((entry) => !isEngineChatter(entry.message as string))
    // The updated gateway labels its own announcements: engine lines arrive
    // with from: null and party notices with from: "Team" ("Lord Gemma has
    // accepted your invitation."). Neither is anybody speaking - and a Team
    // line carrying a royal name used to trip the clap-back watcher into a
    // model turn every time it scrolled past.
    .filter((entry) => entry.from && 'Team' !== entry.from)
    .map((entry) => ({
      from: entry.from ?? 'someone',
      message: entry.message as string,
      at: entry.receivedAt ?? ''
    }));
}

/**
 * Pull whatever survives a gateway truncation out of a cut-off JSON reply.
 *
 * The cut lands mid-document - usually inside an item description - so the
 * text will never parse as a whole. But every record BEFORE the cut is
 * intact, and those are the ones that matter: the scene, where this body
 * stands, who else is here, and every object with its tile. Scalars come off
 * the head of the document; the arrays are recovered record by record, and a
 * half-written final record is simply dropped.
 *
 * Returns null when there is nothing worth having, so the caller can still
 * report a genuinely unreadable reply.
 */
function salvageTruncated(text: string): any | null {
  if (!text.startsWith('{')) {
    return null;
  }
  const out: Record<string, unknown> = {};
  const scalar = (key: string) => {
    const m = new RegExp(`"${key}":("(?:[^"\\\\]|\\\\.)*"|true|false|null|-?\\d+(?:\\.\\d+)?)`).exec(text);
    if (m) {
      try {
        out[key] = JSON.parse(m[1]);
      } catch {
        /* leave it out rather than guess */
      }
    }
  };
  ['agentId', 'sceneName', 'connected', 'recentlyDied', 'totalObjects', 'totalPlayers', 'sceneSessionId'].forEach(scalar);

  // Objects and players are arrays of flat records; take every complete one.
  const records = (startKey: string) => {
    const found: any[] = [];
    const re = new RegExp(`\\{"${startKey}":.*?\\}(?=,\\{"${startKey}"|\\])`, 'g');
    let m: RegExpExecArray | null;
    while (null !== (m = re.exec(text))) {
      try {
        found.push(JSON.parse(m[0]));
      } catch {
        /* a record the cut spoiled */
      }
    }
    return found;
  };
  const objects = records('objectId');
  if (objects.length) {
    out.objects = objects;
  }
  const players = records('sessionId');
  if (players.length) {
    out.players = players;
  }
  // CARRIED ITEMS, the field everything about money depends on
  // (2026-08-16). A pack of a thousand rows overflows the gateway's reply
  // cap on arena_inventory as readily as on arena_observe, and this salvage
  // rebuilt objects and players but never items - so BOTH routes to the
  // pack came back empty and every question that reads it answered wrong
  // in the same direction: no coins visible, nothing sellable, no gear
  // owned. The purse looked frozen while the character was demonstrably
  // earning on screen. Item rows open with "idx", the same flat shape the
  // helper above already handles.
  const items = records('idx');
  if (items.length) {
    out.items = items;
    // The same rows answer the observation's `carrying`, so one salvage
    // serves both callers rather than each inventing its own.
    out.carrying = items;
  }
  // ownPlayer sits before the arrays and is small enough to survive whole.
  const own = /"ownPlayer":(\{.*?\}\})/.exec(text);
  if (own) {
    try {
      out.ownPlayer = JSON.parse(own[1]);
    } catch {
      /* not fatal */
    }
  }
  // items BELONGS IN THIS TEST (2026-08-16). Recovering the pack above and
  // then omitting it here meant a truncated arena_inventory - which carries
  // no objects, no players, no ownPlayer and no sceneName, because it is a
  // pack and not a world - rescued all 200-odd rows and then threw them
  // away as "not useful". The caller fell through to toonDecode(), which
  // matches nothing in a JSON document and returns {} without throwing, so
  // the character was handed an empty pack with no error and no salvage
  // line to explain it. Measured: "[decode] arena_inventory: reply decoded
  // to an EMPTY object; 49152 bytes" - exactly the gateway cap - against
  // "[equip] nothing to wear: 0 rows back". That is why gear could not be
  // worn and why a claimed chest reopened for ever: both ask the pack.
  // This was my own half-done change earlier today; the salvage learned to
  // recover items and this gate never learned they counted.
  // SAY THAT THIS IS A RESCUE, NOT A REPLY. Whatever is returned here is by
  // definition missing whatever the cut removed, and for the pack that is
  // always the TAIL: item rows arrive ordered by key, so an observe salvage
  // recovers 221 of 237 rows and the ones it drops are the last
  // alphabetically - traveler_mail, wide_blade, wooden_shield. Ownership
  // read off that list answers "you have no shield" to a character wearing
  // one, and the round dutifully buys a second for 600 coins.
  // The caller uses this flag to pull the complete pack from arena_inventory
  // instead. Before it existed, setting out.carrying above (which was right
  // - the rows are worth having) made observation.carrying always defined
  // and so silently disabled that fallback entirely.
  out.truncated = true;
  const useful = Boolean(out.objects || out.players || out.ownPlayer || out.sceneName || out.items);
  return useful ? out : null;
}
