/**
 * What a body learns at a counter, kept across restarts.
 *
 * Two facts cost a walk to town to discover: that nothing here buys, and that
 * nobody stocks a rung of the gear ladder. Both are learned from refusals
 * rather than hardcoded, which is right - a counter that starts buying is
 * picked up with no code change - but the learning used to die with the
 * process. Measured 2026-08-24, that was one full town trip per restart:
 * five minutes of walking, six refused sales, and a request for armour
 * nobody carries, before a single swing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMarketLore, writeMarketLore } from '../dist/harness/market.js';
import { KnightsRound, SWORD_GEAR, SWORD_ARMOR } from '../dist/harness/reflex.js';

const FIELD = 'millers-stair';
const QUIET = { damage: 0, died: false, aggressors: 0, landed: false };
const KITTED = ['cup helm', 'grips', 'boots', 'saltguard',
                'traveler mail', 'knight greatblade'];

const round = () => new KnightsRound({
  battleStyle: 'close_up',
  gearLadder: SWORD_GEAR,
  armorLadder: SWORD_ARMOR,
  shopRoom: 'the-valley-smithy',
  shopKeeper: 'Nerys'
});

const tick = (it, carrying) => it.next(
  FIELD, QUIET, { value: 600, total: 644 }, null,
  { room: FIELD, x: 2320, y: 2320, level: 35 },
  null, null, null, carrying, 2, KITTED, 29695, 0, []
);

const refuseSale = (it, item) =>
  it.completed({ action: 'sell', item, quantity: 1 },
    false, `Nerys will not buy ${item}; it has no sell price.`);

test('a fresh body has learned nothing, and says so quietly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lore-'));
  try {
    const lore = readMarketLore(dir, 'nobody');
    assert.deepEqual(lore, { nothingBuys: false, unstocked: [], shoppedAtLevel: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('what one run learns, the next run starts with', () => {
  const first = round();
  for (const item of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
    refuseSale(first, item);
  }
  first.completed({ action: 'buy', item: 'depths_plate' },
    false, 'Nerys does not sell "depths_plate".');

  const dir = mkdtempSync(join(tmpdir(), 'lore-'));
  try {
    writeMarketLore(dir, 'sirqwen', first.lore());
    assert.ok(existsSync(join(dir, 'market-sirqwen.json')));

    // A brand new round, as a restart produces.
    const next = round();
    next.leg = 'outbound';
    tick(next, 60);
    assert.equal(next.plan().leg, 'homebound',
      'without the lore this bag should still order a bank run, or the test proves nothing');

    const remembering = round();
    remembering.remember(readMarketLore(dir, 'sirqwen'));
    remembering.leg = 'outbound';
    tick(remembering, 60);
    assert.notEqual(remembering.plan().leg, 'homebound',
      'a restart walked to town for what the last run already learned');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('one real sale retires the belief, whatever the file says', () => {
  // The file must never outrank the world. A counter that starts buying has
  // to be picked up without anyone clearing state by hand.
  const it = round();
  it.remember({ nothingBuys: true, unstocked: [], shoppedAtLevel: null });
  it.completed({ action: 'sell', item: 'cave_web', quantity: 1 }, true, 'sold');
  it.leg = 'outbound';
  tick(it, 60);
  assert.equal(it.plan().leg, 'homebound',
    'a proven sale did not overturn a remembered belief');
});

test('an unreadable file leaves a body no worse than a fresh one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lore-'));
  try {
    const lore = readMarketLore(join(dir, 'does', 'not', 'exist'), 'sirqwen');
    assert.deepEqual(lore, { nothingBuys: false, unstocked: [], shoppedAtLevel: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
