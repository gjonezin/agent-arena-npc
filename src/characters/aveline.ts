/**
 * Aveline: the other wandering knight, same round as Doran, reversed.
 *
 * Her round is his six stops in the opposite order, so the two of them cross
 * paths at different points of a lap instead of walking the town in lockstep.
 * The round lives in her pinned block now, same as his: the Routine class
 * that used to walk it step by step predates characters holding their own
 * tools. See doran.ts.
 *
 * Sprite: warrior, shared with Doran. See deploy/world/assign-classes.mjs.
 */

import { CharacterSheet } from '../harness/npc.js';
import { Autonomous } from '../harness/behavior.js';
import { TOWN } from '../harness/world.js';
import { loadPersona } from '../persona.js';

export const aveline: CharacterSheet = {
  id: 'aveline',
  playerName: process.env.ARENA_PLAYER_NAME ?? 'Aveline',
  // See guy.ts. Warrior, same as Doran.
  classPath: 'warrior',
  homeScene: TOWN,
  persona: loadPersona('aveline'),
  model: process.env.NPC_MODEL ?? 'openrouter/openai/gpt-oss-120b',
  capabilities: ['speak', 'talk_to_folk', 'walk', 'doors', 'fight'],
  behavior: (agent) => new Autonomous(agent),
  // Rewritten 2026-08-21 alongside Doran's, and for the same reason: her old
  // beat walked six places in the retired demo town. Still his round
  // reversed - that is the whole point of the pair.
  pinned: [
    'YOUR ROUND, WHICH IS THE JOB:',
    "Walk the valley in this order, forever - Doran's round, reversed, so the",
    'two of you cross paths instead of marching in lockstep: the west end',
    '(pause a while), the trading post door, the inn door, the open ground,',
    'the smithy door, the north road (pause a while), then start again.',
    'A short remark at a post is in character; a speech is not, and an empty',
    'road needs neither. You stop for people who speak to you, and for trouble,',
    'and for nothing else. When in doubt, the next stop on the round is always',
    'the right answer.'
  ].join('\n'),
  pace: { idle: 90, engaged: 9 },
  wordiness: 26,
  remembers: true
};
