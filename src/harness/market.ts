/**
 * What a body has learned about the counters, kept across restarts.
 *
 * The round learns two things at a counter and both cost a walk to town to
 * find out: that nothing here buys (every sale is refused "it has no sell
 * price"), and that nobody stocks a particular rung of the gear ladder. Both
 * are learned from refusals rather than hardcoded, which is right - a counter
 * that starts buying is picked up with no code change - but the learning
 * lived on the round object and died with the process.
 *
 * Measured 2026-08-24: that cost one full town trip per restart. The trip is
 * about five minutes of walking, selling six things that will not sell, and
 * asking for armour nobody carries. Across a day of restarts it is most of
 * the reason one character gained 848 experience while the other gained
 * 1,572.
 *
 * Written beside the spend ledger, one small JSON file per character. A
 * missing or unreadable file means a body that has learned nothing yet,
 * which is exactly the state a fresh character is in, so there is no repair
 * path and no migration - the worst case is the trip it would have made
 * anyway.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type MarketLore = {
  /** The world has shown it has no counter that buys anything. */
  nothingBuys: boolean;
  /** Item keys a counter has said outright it does not carry. */
  unstocked: string[];
  /** The level at which this body last stood at a counter. */
  shoppedAtLevel: number | null;
};

const EMPTY: MarketLore = { nothingBuys: false, unstocked: [], shoppedAtLevel: null };

function ledgerPath(dir: string, id: string): string {
  return join(dir, `market-${id}.json`);
}

export function readMarketLore(dir: string, id: string): MarketLore {
  try {
    const raw = JSON.parse(readFileSync(ledgerPath(dir, id), 'utf8')) as Partial<MarketLore>;
    return {
      // Each field is validated on its own: a file half-written by a kill
      // during a save still yields the fields that did land.
      nothingBuys: true === raw?.nothingBuys,
      unstocked: Array.isArray(raw?.unstocked) ? raw.unstocked.filter((k) => 'string' === typeof k) : [],
      shoppedAtLevel: 'number' === typeof raw?.shoppedAtLevel ? raw.shoppedAtLevel : null
    };
  } catch {
    return { ...EMPTY, unstocked: [] };
  }
}

export function writeMarketLore(dir: string, id: string, lore: MarketLore): void {
  try {
    mkdirSync(dirname(ledgerPath(dir, id)), { recursive: true });
    writeFileSync(ledgerPath(dir, id), `${JSON.stringify(lore, null, 2)}\n`);
  } catch {
    // A body that cannot write its lore repeats one town trip next restart.
    // That is the cost of the bug this fixes, not a new one, so it is not
    // worth failing a tick over.
  }
}
