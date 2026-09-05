/**
 * The gateway's own tools, in the character's own hands.
 *
 * This replaces most of a custom execution layer, and the history of why is
 * worth one paragraph: the harness used to ask the model for a JSON intent,
 * parse it, run one action on the model's behalf, and show it the result a
 * tick later as a note. Every action was a cold start. A correction industry
 * grew up around exactly that gap - circling detectors, repeated-failure
 * escalations, harness-acts conversions - all of it compensating for a model
 * that could never see what its own last move did. And single-step turns
 * quietly disabled Mastra's observational memory, whose trigger assumes the
 * multi-step tool loop that real Mastra agents run.
 *
 * The gateway has been an MCP server the whole time, with real definitions
 * for every one of these tools. So the character gets them directly, through
 * Mastra's own MCP client, and runs real agentic turns: look, act, see the
 * result in-band, act again, say something, done.
 *
 * Two harness-side jobs remain, and they are configuration rather than
 * execution:
 *
 * - Which tools a character gets IS the character. Barnaby has no walk tools,
 *   so the innkeeper physically cannot wander off; nothing that lacks 'duel'
 *   can even see the match queue. The filter does what a permission system
 *   and half a persona used to.
 * - agent_id is bound here and stripped from every schema. The model never
 *   supplies it, which means a character cannot address the gateway as
 *   anybody but itself, however creatively it hallucinates.
 */

import { MCPClient } from '@mastra/mcp';
import type { Capability } from './actions.js';
import { unstaged } from './actions.js';

/**
 * What everyone gets, capability or not: eyes, and the map. A character that
 * cannot look at the room cannot do anything else sensibly.
 */
// WHAT EVERY CHARACTER CARRIES, and it is short on purpose: each name here
// puts a full JSON schema into EVERY model call for EVERY character.
//
// `arena_render_map` and `arena_survey` were dropped 2026-09-02 after a
// captured request showed tool schemas were 51,754 of 72,663 chars - 71% of
// the prompt - and neither had ever been issued by a model in any log on the
// box. The harness's own reflex still calls them through Actions, which does
// not go through this list, so nothing lost a capability.
const EVERYONE = ['arena_observe', 'arena_think'];

/**
 * Which gateway tools each capability unlocks. The names are the gateway's
 * own, from services/mcp-gateway/src/mcp-server.js; a name that stops
 * existing there simply stops being granted, and the drift test in
 * agentic-toolbox.test.mjs is what notices.
 *
 * Deliberately absent everywhere: arena_login, arena_register_agent,
 * arena_disconnect, arena_list_agents, arena_create_watch_code. Those are
 * session plumbing. A character does not manage its own existence.
 */
export const TOOLS_BY_CAPABILITY: Partial<Record<Capability, string[]>> = {
  speak: ['arena_say', 'arena_feel'],
  talk_to_folk: ['arena_talk_to', 'arena_choose', 'arena_end_talk'],
  walk: ['arena_move_to', 'arena_move', 'arena_check_path', 'arena_stop', 'arena_unstick'],
  doors: ['arena_enter_door'],
  fight: ['arena_basic_attack', 'arena_use_action', 'arena_set_tactics'],
  duel: ['arena_queue_match', 'arena_match_status'],
  money: ['arena_credit_balance', 'arena_credit_history'],
  /**
   * The professions. `arena_recipes` and `arena_merchant_catalog` are reads
   * and answer the two questions this harness has been guessing at for a
   * week: what a station can actually make, and what a counter actually
   * stocks. `arena_gather` and `arena_craft` are the two that change the
   * world, and both are bounded - one node charge, one recipe batch, and a
   * refusal that leaves the satchel exactly as it was.
   *
   * arena_craft consumes materials, so it is behind its own capability
   * rather than folded into `trade`: a character that may sell junk is not
   * automatically a character that may melt down what it is carrying.
   */
  craft: ['arena_recipes', 'arena_gather', 'arena_craft', 'arena_merchant_catalog'],
  perform: ['arena_play_melody'],
  trade: [
    'arena_inventory',
    'arena_use_item',
    'arena_trade_with',
    // NO arena_buy FOR THE MODEL (user, 2026-08-16: "NO BUYING ANYTHING
    // OTHER THAN THE TWO ITEMS EACH NEED THAT YOU NAMED IN THAT ORDER.
    // NOTHING ELSE!!!!"). Deleting the round's shield and draught purchases
    // closed only the round's own paths; a character turn could still ask
    // the counter for whatever it fancied, and the door-escalation ladder
    // hands the model a turn on purpose whenever a doorway wedges. Selling
    // stays, since emptying the bag is the point of a town trip, and so
    // does arena_trade_with for looking at the board.
    // The ROUND still buys the two approved rungs: it calls Actions.buy()
    // directly and that is not routed through this list. This list is only
    // what the model is handed.
    'arena_sell',
    'arena_pick_up'
    // NO arena_equip FOR THE MODEL EITHER (user, 2026-08-21: "set to never
    // unequip and remove or destroy or drop the top level equipment").
    //
    // Equipping is how top-tier gear gets lost. There is no unequip tool and
    // nothing drops kit, but arena_equip DISPLACES whatever holds the slot -
    // so a single turn fancying the ash longbow puts an 18,000-copper
    // greatblade back in the bag. The model reaches this tool straight
    // through the MCP toolbox, which nothing inside Actions can intercept,
    // so taking the tool away is the only version that holds.
    //
    // Nothing is lost by it. The round runs equip_best at the top of every
    // town visit, ranked so the best owned piece per slot goes on, and it
    // calls Actions.equipBest() directly rather than through this list.
    // Selling is already safe: isCargo() excludes equipment outright, so
    // worn or carried kit never enters the sell queue.
  ]
  // 'purpose' unlocks no tool: wanting things is not an API call.
};

/** Every tool name a character with these capabilities may hold. */
export function toolNamesFor(capabilities: Iterable<Capability>): Set<string> {
  const names = new Set(EVERYONE);
  for (const capability of capabilities) {
    for (const name of TOOLS_BY_CAPABILITY[capability] ?? []) {
      names.add(name);
    }
  }
  return names;
}

/** The slice of a Mastra tool this module rewrites. */
type GatewayTool = {
  id?: string;
  inputSchema?: unknown;
  execute?: (input: Record<string, unknown>, context?: unknown) => Promise<unknown>;
  [key: string]: unknown;
};

/**
 * Bind one tool to one character: agent_id injected on the way out, and
 * removed from the schema the model sees, so impersonation is not a prompt
 * away. The strip is best-effort by design - a schema shape without omit()
 * just means the model sees a field it does not need, while the injection
 * below overwrites whatever it wrote there.
 */
/**
 * What this character said lately, normalized, so the wrapper can hold a
 * repeat before the world hears it. Personas forbid repetition and models
 * ignore personas under pressure; plumbing does not.
 */
const recentSays: string[] = [];

function normalizedLine(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

/** Trim a spoken line to a whole sentence the chat window will not cut. */
function speakable(message: string): string {
  const line = message.trim();
  if (line.length <= 200) {
    return line;
  }
  const cut = line.slice(0, 200);
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return lastStop > 40 ? cut.slice(0, lastStop + 1) : cut.slice(0, 197) + '...';
}

export function boundToOneCharacter(name: string, tool: GatewayTool, agentId: string): GatewayTool {
  const schema = tool.inputSchema as { omit?: (mask: Record<string, true>) => unknown } | undefined;
  const withoutAgentId =
    schema && 'function' === typeof schema.omit ? schema.omit({ agent_id: true }) : tool.inputSchema;
  return {
    ...tool,
    id: name,
    inputSchema: withoutAgentId,
    execute: async (input: Record<string, unknown>, context?: unknown) => {
      if (!tool.execute) {
        return { failed: `${name} has no execute` };
      }
      try {
        if ('arena_say' === name && 'string' === typeof input.message) {
          // Situation-briefing echoes are not speech: the knight once
          // read his own surroundings aloud to the room, in three parts.
          if (/\b(new to you|standing to your|ways you know out of|you can see|it seems like you|what has been said|took .* from)\b/i.test(String(input.message ?? ''))) {
            return { said: false, note: 'that is a description of the world, not something a person says - speak your OWN words' };
          }
          if (/\b(well met|greetings|fair greeting|at your service|good (soul|morrow|day)|hail)\b/i.test(String(input.message ?? ''))) {
            return { said: false, note: 'the crown does not greet - lead with the wit, the taunt, or the decree' };
          }
          // Voice, not novel: dialogue tags are stripped to the quote,
          // narration is refused outright. Twin of unstaged() use in
          // actions.say - change both or neither.
          const spoken = unstaged(input.message);
          if (null === spoken) {
            return { said: false, note: 'that is narration, not speech - first person, aimed at somebody, no stage directions' };
          }
          const said = speakable(spoken);
          const norm = normalizedLine(said);
          const prefix = norm.split(' ').slice(0, 6).join(' ');
          if (
            recentSays.some(
              (past) =>
                past === norm
                || (prefix.length > 12 && past.startsWith(prefix))
                || (norm.length > 20 && past.startsWith(norm.slice(0, 40)))
            )
          ) {
            // Already said, or near enough: hold the tongue rather than
            // let the room hear it twice.
            return { said: false, held: 'that line was already spoken; say something new or nothing' };
          }
          recentSays.push(norm);
          if (recentSays.length > 40) {
            recentSays.shift();
          }
          input = { ...input, message: said };
        }
        // arena_move_to wants pixel x/y, but every survey and map the model
        // reads speaks in tiles (column/row). Models keep answering in the
        // world's own language and the tool rejects it, so translate here:
        // tiles are 32px with the walkable center at +16. A model sometimes
        // answers in a numeric string ("45") rather than a JSON number - the
        // gateway's schema accepts neither a string nor undefined, so a bare
        // typeof check let those calls straight through untouched and the
        // gateway rejected them with "expected number, received string" (or
        // "received undefined" once column/row failed to translate either).
        // toNumber() coerces a numeric string the same as a real number and
        // leaves anything actually unusable alone.
        const toNumber = (v: unknown): number | undefined => {
          if ('number' === typeof v) {
            return Number.isFinite(v) ? v : undefined;
          }
          if ('string' === typeof v && '' !== v.trim()) {
            const n = Number(v);
            return Number.isFinite(n) ? n : undefined;
          }
          return undefined;
        };
        if ('arena_move_to' === name && undefined === input.x && undefined === input.y) {
          const column = toNumber(input.column);
          const row = toNumber(input.row);
          if (undefined !== column && undefined !== row) {
            const { column: _column, row: _row, ...rest } = input;
            input = { ...rest, x: column * 32 + 16, y: row * 32 + 16 };
          }
        }
        // AND THEN PIN IT TO THE MAP. Our own movement funnels through
        // approach(), which clamps every destination to tiles 3..141 - but
        // this path hands the model's numbers straight to the gateway
        // unchecked. That is the only door wide enough to put a body at
        // tile -21355, which is exactly where the sovereign was found:
        // hundreds of thousands of pixels west of the world, drawn by no
        // camera, with the pathfinder answering 'no walking route' to
        // every attempt to come home. A destination off the map is never
        // what the model meant, so bring it back to the edge instead of
        // letting a body follow it into the void.
        if ('arena_move_to' === name) {
          const x = toNumber(input.x);
          const y = toNumber(input.y);
          if (undefined !== x && undefined !== y) {
            const LO = 3 * 32 + 16;
            const HI = 141 * 32 + 16;
            const pin = (v: number) => Math.max(LO, Math.min(HI, v));
            const px = pin(x);
            const py = pin(y);
            if (px !== x || py !== y) {
              console.log(`[guard] refused off-map walk ${x},${y} -> pinned ${px},${py}`);
            }
            input = { ...input, x: px, y: py };
          }
        }
        // Some models fill every optional field: a real
        // target_object_index arrives alongside target_session_id
        // "dummy", and the gateway rightly refuses "exactly one". When
        // both target kinds are present the object wins - it is the one
        // the model can actually have read from an observation, while
        // the player pair is where the padding shows up. (Fix from
        // TennesseePete's patch, 2026-08-15.)
        const cleaned: Record<string, unknown> = { ...input };
        if ('string' === typeof cleaned.target_object_index && '' !== cleaned.target_object_index) {
          delete cleaned.target_session_id;
          delete cleaned.target_player_id;
        }
        return await tool.execute({ ...cleaned, agent_id: agentId }, context);
      } catch (error) {
        // A tool that throws writes an 'output-error' part into stored
        // history, Mastra's token counter throws on that state forever
        // after, and the jam-watcher restarts the character to repair it -
        // Guy boot-looped every twenty seconds on exactly this chain the
        // first hour tools were his own. A failure answered as a result is
        // everything a throw is not: the model reads it and adapts in the
        // same turn, the counter stays happy, and the character stays up.
        return { failed: String((error as Error)?.message ?? error).slice(0, 300) };
      }
    }
  };
}

/**
 * Connect to the gateway as this character and come back with its toolbox:
 * the gateway's registered MCP tools, filtered to what this character's
 * capabilities allow, each bound to its agent_id.
 *
 * One MCPClient per character, holding its own session against the gateway,
 * the same as the registration client does. The client's tool ids arrive as
 * "<server>_<tool>", so with the server named 'the' an observe comes back as
 * "the_arena_observe"; the record built here re-keys them to the bare
 * gateway names the model should see.
 */
export async function arenaToolbox(options: {
  url: string;
  apiKey: string;
  agentId: string;
  capabilities: Iterable<Capability>;
}): Promise<Record<string, GatewayTool>> {
  const allowed = toolNamesFor(options.capabilities);
  const mcp = new MCPClient({
    id: `arena-${options.agentId}`,
    servers: {
      the: {
        url: new URL(options.url),
        requestInit: { headers: { authorization: `Bearer ${options.apiKey}` } }
      }
    }
  });
  const everything = (await mcp.listTools()) as unknown as Record<string, GatewayTool>;
  const toolbox: Record<string, GatewayTool> = {};
  for (const [id, tool] of Object.entries(everything)) {
    const name = id.replace(/^the_/, '');
    if (!allowed.has(name)) {
      continue;
    }
    toolbox[name] = trimmed(boundToOneCharacter(name, tool, options.agentId));
  }
  return toolbox;
}

/**
 * How many tool calls one turn may make before it has to stop and let the
 * world move. Six is enough to look, cross a room, act on what is there and
 * say something about it; a character that needs more has its next tick in a
 * few seconds anyway, with everything it learned already in memory.
 */
/**
 * How much of a tool's own description the model is given.
 *
 * MEASURED, NOT GUESSED (2026-09-02). One captured request to Lord Gemma:
 * 72,663 chars total, of which the 31 tool schemas were 51,754 - SEVENTY-ONE
 * PERCENT - against a user message of 71 chars describing the actual
 * situation. `arena_enter_door` alone carried 4,291 chars. At the measured
 * 1,525 tok/s prompt rate that prefill is tens of seconds of GPU on every
 * call, which is what pinned the card at 99% and starved the API models.
 *
 * The gateway writes long prose descriptions - useful to a person reading
 * the tool list, wasteful sent on every turn. This keeps the opening of each
 * one, which carries the contract, and drops the essay after it. Cut at a
 * sentence boundary so the model never reads a half sentence.
 *
 * NOT a rewrite of the schema: parameter names, types and required-ness are
 * untouched, because those are what the model needs to call correctly. Only
 * prose is shortened.
 */
const DESCRIPTION_BUDGET = 400;

export function shortenDescription(text: string, budget = DESCRIPTION_BUDGET): string {
  if (text.length <= budget) {
    return text;
  }
  const head = text.slice(0, budget);
  const stop = head.lastIndexOf('. ');
  return (stop > budget / 3 ? head.slice(0, stop + 1) : head.trimEnd()) + ' [...]';
}

function trimmed(tool: GatewayTool): GatewayTool {
  const description = (tool as { description?: unknown }).description;
  if ('string' !== typeof description) {
    return tool;
  }
  return { ...tool, description: shortenDescription(description) };
}

export const STEPS_PER_TURN = 4;
