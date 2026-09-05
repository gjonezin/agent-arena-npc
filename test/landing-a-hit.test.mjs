/**
 * "Is this ground worth standing on?" - and why the honest answer is not
 * "is something hitting me".
 *
 * The round abandons a field after a few futile strikes. It used to decide
 * that on `aggressors`, which counts what is currently swinging at US. That
 * is a different question, and in a room the world authored passive - where
 * nothing opens a fight, and a grown character kills a small thing before it
 * can fight back - the answer is permanently zero. So the counter never
 * reset, and the round walked out of every such room after four ticks
 * forever. That is most of the world's gold, unreachable by construction.
 *
 * The signal that actually answers the question is whether we LANDED
 * anything, which the battle payload's own event log reports. These tests
 * exist because the first attempt to read it passed the whole suite while
 * doing nothing at all: it stored a per-payload boolean, and a second
 * gateway answer arriving later in the same tick recomputed it from events
 * already consumed, so the round read false every single time. A green suite
 * was not evidence then and would not be now, which is the point of the
 * cases below - each one is a mechanism that has already broken once.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ArenaClient } from '../dist/harness/arena.js';

/** A battle payload shaped the way the gateway really sends one. */
const battle = (events) => ({ battle: { aggressors: [], events } });
/** noteDanger is private to the client; the compiled JS has no such notion. */
const feed = (client, payload) => client.noteDanger(payload);

test('a landed hit still reads as landed after a later answer re-reads the same events', () => {
  // THE NO-OP THAT SHIPPED GREEN. One tick makes several gateway calls, and
  // several of them carry a battle payload: arena_observe first, then
  // arena_render_map, and only then does the round ask. A per-payload
  // boolean was therefore recomputed from already-consumed events before
  // anybody read it, and the answer the round saw was always false.
  const arena = new ArenaClient();
  feed(arena, battle([{ seq: 101, event_type: 'damage_dealt' }]));
  assert.equal(arena.danger().landed, true, 'the answer that first saw the hit');
  feed(arena, battle([{ seq: 101, event_type: 'damage_dealt' }]));
  assert.equal(
    arena.danger().landed,
    true,
    'a later answer in the same tick must not erase it - this is what the round actually reads'
  );
});

test('an old kill sitting in the kept window does not re-latch on every read', () => {
  // The gateway keeps only its last dozen events, so a single kill lingers
  // across many ticks. Without de-duplication by sequence it would re-latch
  // forever and the round would never leave any field again.
  const arena = new ArenaClient();
  const window = Array.from({ length: 12 }, (_, i) => ({ seq: i + 6, event_type: 'damage_taken' }));
  window[1] = { seq: 7, event_type: 'enemy_killed' };
  const seen = [];
  for (let i = 0; i < 6; i += 1) {
    feed(arena, battle(window));
    seen.push(arena.danger().landed);
  }
  assert.deepEqual(
    seen,
    [true, true, true, true, true, true],
    'stable, not flapping: an earlier rewind guess oscillated between latched and cleared on this exact window'
  );
});

test('the window closes, so a field that has genuinely gone quiet is still abandoned', () => {
  // The safety valve this whole signal must not break: swinging at
  // something the pathfinder cannot reach succeeds forever and starts no
  // battle. If `landed` never expired, the round would stand there for good.
  const realNow = Date.now;
  const arena = new ArenaClient();
  try {
    let clock = realNow.call(Date);
    Date.now = () => clock;
    feed(arena, battle([{ seq: 5, event_type: 'damage_dealt' }]));
    assert.equal(arena.danger().landed, true, 'just landed');

    const stale = [{ seq: 5, event_type: 'damage_dealt' }];
    clock += 10_000;
    feed(arena, battle(stale));
    assert.equal(arena.danger().landed, true, 'ten seconds on, still recent enough to count');

    clock += 6_000;
    feed(arena, battle(stale));
    assert.equal(
      arena.danger().landed,
      false,
      'past the window with nothing new landed - the ground reads dead and the round may leave'
    );
  } finally {
    Date.now = realNow;
  }
});

test('taking damage is not landing damage', () => {
  // The distinction the original defect turned on. Being hit says somebody
  // else opened a fight; it says nothing about whether this ground pays.
  const arena = new ArenaClient();
  feed(arena, battle([{ seq: 3, event_type: 'damage_taken' }]));
  assert.equal(arena.danger().landed, false, 'hits taken must not answer the question');
  feed(arena, battle([{ seq: 4, event_type: 'enemy_killed' }]));
  assert.equal(arena.danger().landed, true, 'a kill does');
});

test('a reply that arrives late does not wipe the guard and re-latch a stale kill', () => {
  // The busker's melody loop shares one client with the round's own tick and
  // rpc() takes no lock, so answers can overtake each other. A late one
  // reads as a rewound log; treating it as a restart cleared the de-dup
  // guard, and the next payload then re-latched a kill twenty seconds old.
  // A genuinely restarted log's newest event is inside its first dozen,
  // which is what tells the two apart.
  const realNow = Date.now;
  const arena = new ArenaClient();
  try {
    let clock = realNow.call(Date);
    Date.now = () => clock;
    const window = [{ seq: 40, event_type: 'enemy_killed' }, { seq: 41, event_type: 'damage_taken' }];
    feed(arena, battle(window));
    assert.equal(arena.danger().landed, true, 'the kill lands');

    clock += 20_000;
    feed(arena, battle([{ seq: 30, event_type: 'damage_taken' }]));
    feed(arena, battle(window));
    assert.equal(
      arena.danger().landed,
      false,
      'the twenty-second-old kill must stay expired - a late reply is not a restarted world'
    );
  } finally {
    Date.now = realNow;
  }
});

test('a genuinely restarted log is still recognised, so events are not ignored forever', () => {
  // The case the rewind branch exists for. A fresh session restarts the
  // gateway's counter near one; if the guard did not reset, every event
  // thereafter would read as already-seen and nothing would ever latch.
  const arena = new ArenaClient();
  feed(arena, battle([{ seq: 900, event_type: 'damage_taken' }]));
  feed(arena, battle([{ seq: 2, event_type: 'damage_taken' }]));
  feed(arena, battle([{ seq: 3, event_type: 'enemy_killed' }]));
  assert.equal(arena.danger().landed, true, 'the restarted log is followed rather than ignored');
});
