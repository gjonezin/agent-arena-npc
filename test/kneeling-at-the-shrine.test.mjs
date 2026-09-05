/**
 * Taking Ossian's blessing: discovered from his actual reply, never assumed.
 *
 * Nobody has ever entered the-valley-shrine. The dialog's shape is read
 * from the world's SOURCE (place-npcs.mjs: one option, key `heal`, label
 * "Kneel and ask for the blessing"; shrine.js answers it with a full
 * restore) - so takeBlessing() must find the option in whatever Ossian
 * actually offers, choose it through the same arena_choose every counter
 * uses, and refuse loudly rather than guess when nothing on offer reads
 * as healing. Choosing an unknown option at an unknown NPC is how a body
 * agrees to something it cannot see.
 *
 * Also here: the stale-scene guard. An observation is correct when taken
 * and stale the moment the world moves the body (measured: observed on the
 * Oathstone arrival tile, killed there, carried to the inn, then 25 acts
 * fired against Oathstone's objects from the inn). Object-directed acts
 * refuse when the current scene no longer matches the one the object list
 * was observed in - and decline to judge when either side is unknown.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Actions } from '../dist/harness/actions.js';

const SHRINE = 'the-valley-shrine';

/** A stand-in for the MCP client, queuing one canned reply per call(). */
class FakeArena {
  constructor(replies = []) {
    this.replies = [...replies];
    this.calls = [];
  }

  async call(name, args) {
    this.calls.push({ name, args });
    if (0 === this.replies.length) {
      throw new Error(`FakeArena: no reply queued for ${name}`);
    }
    return this.replies.shift();
  }
}

const OSSIAN = {
  objectId: 9,
  objectIndex: 'npcs4',
  label: 'Ossian Rell',
  kind: 'npc',
  interactable: true,
  // One diagonal step: no walking leg, the talk goes straight out.
  distanceFromSelf: 10,
  tileX: 5,
  tileY: 3
};

const dialog = (options) => ({
  opened: true,
  objectId: 9,
  title: 'Ossian Rell',
  content: 'Six candles. Names go in the book by the door.',
  options
});

const BLESSED = {
  opened: true,
  objectId: 9,
  title: 'Ossian Rell',
  content: 'You kneel. When you stand, you are whole - 644 HP, 548 MP.',
  options: null
};

const TOO_FAR = {
  opened: false,
  objectId: 9,
  reason: 'TOO_FAR_AWAY',
  message: 'You are too far away to talk to them. Walk closer and try again.'
};

function shrineActions(replies, { scene = SHRINE, folk = true } = {}) {
  const arena = new FakeArena(replies);
  const actions = new Actions(arena, 'agent-1', new Set(folk ? ['talk_to_folk'] : []));
  actions.notices([OSSIAN], scene);
  return { arena, actions };
}

const kneel = (actions, scene = SHRINE) => actions.perform({ action: 'shrine_bless' }, scene);

test('the heal option is found by the key the server source handles', async () => {
  // A label with no healing word in it at all: only the key can carry this.
  const { arena, actions } = shrineActions([dialog({ heal: 'Approach the stone' }), BLESSED]);
  const result = await kneel(actions);
  assert.equal(result.ok, true);
  assert.equal(arena.calls.length, 2);
  assert.equal(arena.calls[0].name, 'arena_talk_to');
  assert.equal(arena.calls[1].name, 'arena_choose');
  assert.equal(arena.calls[1].args.option_key, 'heal');
});

test('or by a label that reads as healing, whatever its key', async () => {
  const { arena, actions } = shrineActions(
    [dialog({ '2': 'Kneel and ask for the blessing' }), BLESSED]
  );
  const result = await kneel(actions);
  assert.equal(result.ok, true);
  assert.equal(arena.calls[1].args.option_key, '2');
});

test('CONTROL: a dialog with nothing that reads as healing refuses loudly and chooses NOTHING', async () => {
  const { arena, actions } = shrineActions(
    [dialog({ '1': 'Ask about the candles', '2': 'Look at the book' })]
  );
  const result = await kneel(actions);
  assert.equal(result.ok, false);
  assert.match(result.note, /reads as healing/);
  assert.match(result.note, /Ask about the candles/, 'the refusal shows what WAS offered');
  assert.equal(arena.calls.length, 1, 'talked, but never chose blind');
});

test('CONTROL: a dialog with no choices at all is a loud failure, not a shrug', async () => {
  const { arena, actions } = shrineActions([dialog(null)]);
  const result = await kneel(actions);
  assert.equal(result.ok, false);
  assert.match(result.note, /offered no choices/);
  assert.equal(arena.calls.length, 1);
});

test('CONTROL: no Ossian in the room fails by name, before any call', async () => {
  const arena = new FakeArena([]);
  const actions = new Actions(arena, 'agent-1', new Set(['talk_to_folk']));
  actions.notices([], SHRINE);
  const result = await kneel(actions);
  assert.equal(result.ok, false);
  assert.match(result.note, /no Ossian here/);
  assert.equal(arena.calls.length, 0);
});

test('too far to talk comes back as the failure it is, and nothing is chosen', async () => {
  const { arena, actions } = shrineActions([TOO_FAR]);
  const result = await kneel(actions);
  assert.equal(result.ok, false);
  assert.match(result.note, /too far away/i);
  assert.equal(arena.calls.length, 1);
});

test('a character without talk_to_folk cannot kneel', async () => {
  const { arena, actions } = shrineActions([], { folk: false });
  const result = await kneel(actions);
  assert.equal(result.ok, false);
  assert.equal(arena.calls.length, 0);
});

test('an act against objects observed in another room is refused before the wire', async () => {
  // Observed in the shrine, then moved (a death's carry-home, a door): the
  // stale list must not be acted on from the new room.
  const { arena, actions } = shrineActions([dialog({ heal: 'Approach the stone' }), BLESSED]);
  const result = await actions.perform({ action: 'shrine_bless' }, 'the-valley-inn');
  assert.equal(result.ok, false);
  assert.match(result.note, /seen in the-valley-shrine/);
  assert.match(result.note, /now in the-valley-inn/);
  assert.equal(arena.calls.length, 0, 'refused client-side, no round trip spent');
});

test('the stale-scene guard covers talk_to too', async () => {
  const { arena, actions } = shrineActions([dialog({ heal: 'x' })]);
  const result = await actions.perform({ action: 'talk_to', target: 'Ossian' }, 'the-valley-inn');
  assert.equal(result.ok, false);
  assert.match(result.note, /observe again/);
  assert.equal(arena.calls.length, 0);
});

test('CONTROL: the guard declines to judge when the observed scene is unknown', async () => {
  // A caller that cannot say where the list came from leaves the guard
  // unarmed - degrading to exactly the old behaviour, never to a refusal.
  const arena = new FakeArena([dialog({ heal: 'Approach the stone' }), BLESSED]);
  const actions = new Actions(arena, 'agent-1', new Set(['talk_to_folk']));
  actions.notices([OSSIAN]);
  const result = await actions.perform({ action: 'shrine_bless' }, SHRINE);
  assert.equal(result.ok, true);
  assert.equal(arena.calls.length, 2);
});

test('CONTROL: a matching scene passes the guard untouched', async () => {
  const { arena, actions } = shrineActions([dialog({ heal: 'Approach the stone' }), BLESSED]);
  const result = await kneel(actions, SHRINE);
  assert.equal(result.ok, true);
  assert.equal(arena.calls.length, 2);
});
