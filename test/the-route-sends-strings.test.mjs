/**
 * The world sends its route corners as strings, and we never noticed.
 *
 * `pathTurns` was destructured as `[col, row]` for as long as this harness
 * has existed. The entries are not arrays. The first specimen ever captured,
 * by a log line added only to survive them, reads:
 *
 *     [move] the route's first corner is unusable ("[2]: 14,44")
 *
 * Destructure that string and you take its CHARACTERS: col = '[' and
 * row = '2'. So the walk computed `'[' * 64` = NaN and `'2' * 64 + 32` =
 * **160** - which is exactly the `(NaN, 160)` refusal seen six times in one
 * night and written up as a world defect. The constant 160 was the digit 2
 * from a turn-index label. The arithmetic had been naming the shape all
 * along; nothing was reading it.
 *
 * The consequence is bigger than the refusals. This harness has never once
 * FOLLOWED a route corner - every walk in a room that is 60% wall has been a
 * straight line at the target with the pathfinder's own answer discarded.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The parser is module-private, so this drives the exact source text rather
// than a copy that could drift away from it.
const source = readFileSync(
  new URL('../src/harness/actions.ts', import.meta.url), 'utf8');
const body = source.slice(
  source.indexOf('function cornerTile('),
  source.indexOf('export class Actions'));
const cornerTile = new Function(
  `${body.replace(/: unknown|: \[number, number\]|as Record<string, unknown>/g, '')}
   return cornerTile;`)();

test('the real specimen from the live log parses to its tile', () => {
  assert.deepEqual(cornerTile('[2]: 14,44'), [14, 44],
    'index 2, tile (14,44) - the last two numbers are the corner');
});

test('the old destructure is what produced (NaN, 160)', () => {
  // Not a test of our code - a test of the explanation, so the next reader
  // does not have to re-derive it.
  const [col, row] = '[2]: 14,44';
  assert.equal(col, '[');
  assert.equal(row, '2');
  assert.ok(Number.isNaN(col * 64), 'the X was always NaN');
  assert.equal(row * 64 + 32, 160, 'and the Y was always the digit 2');
});

test('a proper pair still works, and so do both object spellings', () => {
  assert.deepEqual(cornerTile([14, 44]), [14, 44]);
  assert.deepEqual(cornerTile({ column: 14, row: 44 }), [14, 44]);
  assert.deepEqual(cornerTile({ x: 14, y: 44 }), [14, 44]);
});

test('anything unreadable stays unreadable, so the guard still catches it', () => {
  for (const junk of ['rubbish', '', null, undefined, 7, {}, ['only-one']]) {
    const [x, y] = cornerTile(junk);
    assert.ok(!Number.isFinite(x) || !Number.isFinite(y),
      `${JSON.stringify(junk)} must not resolve to a usable tile`);
  }
});
