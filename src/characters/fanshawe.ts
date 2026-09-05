/**
 * Fanshawe: the opus is the performance, and the performance is the risk.
 *
 * Ported from TennesseePete's patch (2026-08-15) into this harness. A vain
 * bard whose masterpiece exists only as description - and the first holder
 * of the 'perform' capability, because his whole tragedy needs the
 * instrument to be reachable: sober he never touches it, drunk he always
 * does, and the town hears exactly what the descriptions were protecting.
 * He gets money and trade so the ale that lowers the wall is bought with
 * his own coin, on the record.
 *
 * Differences from Pete's original, all local: he runs on our own Gemma
 * server rather than OpenRouter, he takes the BARD class (the game has one,
 * and it evolves into Troubadour - Pete's sheet left it to the server
 * default), and he lives under our speech guards so he cannot narrate
 * himself.
 */

import { Agent } from '@mastra/core/agent';
import { CharacterSheet } from '../harness/npc.js';
import { Autonomous } from '../harness/behavior.js';
import { INN } from '../harness/world.js';
import { loadPersona } from '../persona.js';

export const fanshawe: CharacterSheet = {
  id: 'fanshawe',
  playerName: process.env.ARENA_PLAYER_NAME ?? 'Fanshawe of Kettleworth',
  classPath: 'bard',
  homeScene: INN,
  persona: loadPersona('fanshawe'),
  model: process.env.NPC_MODEL ?? 'gemma-4-31b',
  // NO 'walk', NO 'doors' (user: never move from this spot). The model
  // cannot wander him off the mark; the harness keeps its own goTo for
  // returning to the stage if the world ever displaces him.
  // HE ONLY NEEDS TO PLAY MUSIC (Glenn, 2026-09-02). Every capability adds
  // tool schemas to every call, so a busker carrying a merchant's toolbox
  // pays for it on every turn. Dropped: 'money' and 'trade' (zero calls; he
  // buys and sells nothing) and 'talk_to_folk' (his log is busking, beat
  // after beat). 'speak' stays so he can still address the room between
  // songs. If he is ever meant to hold a conversation, 'talk_to_folk' is the
  // one to restore.
  capabilities: ['speak', 'perform', 'purpose'],
  behavior: (agent: Agent) => new Autonomous(agent),
  goal: {
    aim: 'be known as the greatest artist this town has ever held - on the '
      + 'strength of the opus, which must be described often, gorgeously, '
      + 'and never played. Keep the drinks coming; when the ale has had '
      + 'its say you will play after all, badly, and the morning after '
      + 'you will explain why that was not the real opus.',
    done: 'the town calls you its great bard without ever having heard '
      + 'the opus - or the night it finally hears you, whichever the ale '
      + 'decides first.'
  },
  // No reflex round: he is a talker, not a grinder. The knight's clock
  // does not apply to a man whose work is being seen in a bar.
  // User order: he plays and never stops. The sober-refusal gate was
  // beautiful writing and produced silence, because nothing in this
  // world can get a man drunk.
  busks: true,
  /**
   * THE POST IS STILL FINAL - but he has to reach it first (Glenn,
   * 2026-08-21: "Fanshawe needs to go to the inn and find a place in the
   * open by himself to continue playing").
   *
   * The old post was tile (20,12) on a 32px grid, written for the retired
   * `reldens-house-1`. Barnaby's inn is now `the-valley-inn`: twenty tiles
   * by thirteen at 64px. Column 20 does not exist there - the map's last
   * column is 19 - so the mark he was pinned to is off the edge of the room
   * he lives in, which is why the sheet needed a real one rather than the
   * absence of one.
   *
   * MOVED NORTH 2026-08-21 (Glenn: "relocate to the north about 6 steps and
   * face south"). (864, 160) is tile (13, 2), six half-tile steps up the room
   * from where he was standing at (12, 5).
   *
   * It had to be column 13, not his own: the collision layer walls (12,2) and
   * (12,4), so his column does not go north at all, while 13 is open floor
   * from row 5 clear up to row 1. Barnaby is seven tiles west along the same
   * row, which keeps him in the open and by himself.
   *
   * stageApproach is the tile directly above it. Nothing sets a facing - a
   * body looks the way it last walked - so facing south means arriving from
   * the north, and that is the only way to say so.
   *
   * neverMoves still holds. It is simply latched AFTER he arrives now: see
   * takeStageThenPlay() in npc.ts. Nothing moves him once he is standing
   * there - not the model, not housekeeping, not a nudge.
   */
  neverMoves: true,
  stageSpot: { x: 864, y: 160 },
  stageApproach: { x: 864, y: 96 },
  // SLOWED 2026-09-02, same reason as the royals. Busking is not time
  // critical - a slower beat costs him nothing but song frequency.
  // PACE DOES NOT GOVERN HIS MUSIC - measured 2026-09-02, twice. His busking
  // beat is driven by the 38-second song completing, not by this timer: at
  // idle 90 / engaged 45 the gaps were 36,35,36,36,36,33,36,35,36,36,33s, and
  // after raising the pace to 120 they were 36,36,37s. Unchanged.
  //
  // So this is set high because it is FREE, not because it saves anything.
  // Raising it buys no GPU either - his call rate is the song rate. If his
  // load ever needs cutting, the lever is the busking cycle or the song
  // length, not this pair.
  pace: { idle: 600, engaged: 300 },
  recall: 10,
  wordiness: 44,
  // He remembers, unlike the grinders: the running bit REQUIRES continuity
  // (the morning-after reframing only lands if last night happened).
  remembers: true
};
