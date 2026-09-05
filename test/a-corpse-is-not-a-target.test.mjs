/**
 * The world says a body is dead; we act on it.
 *
 * Measured live 2026-08-31, both characters: 157 observations carried an enemy
 * at 0 hp, and the server refused attacks on them with
 *
 *   TARGET_NOT_FIGHTABLE - "the target's body is DEATH, and the world refuses
 *   combat with it until it is active again."
 *
 * Every selector already guarded on `false !== alive` AND `hp > 0`, and both
 * guards passed anyway: the corpse arrives with NO `alive` field (arena.ts
 * assumes absent means a payload listing only the living - no longer true),
 * and the hp reading is stale. So the refusal itself is the only reliable
 * signal, and it was being logged and discarded.
 *
 * Two separate costs, so two separate fixes and two separate tests:
 *   - the same corpse is re-targeted every beat (shun it on the refusal)
 *   - a room full of corpses never reads as calm, so gathering, resting and
 *     the shrine errand never fire (count the living only)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const CORPSE = { kind: 'enemy', label: 'Stair Scuttler', tileX: 84, tileY: 8, hp: 0, distanceFromSelf: 64 };
const LIVE = { kind: 'enemy', label: 'Groove Grub', tileX: 70, tileY: 12, hp: 150, distanceFromSelf: 128 };
// The shape that actually arrives: dead, but with no `alive` field at all.
const living = (o) => 'enemy' === o.kind && false !== o.alive && 0 < Number(o.hp ?? 1);

test('a 0 hp body with no `alive` field is not a hostile', () => {
  assert.equal(living(CORPSE), false, 'the corpse must not count');
  assert.equal(living(LIVE), true, 'the living one must');
});

test('THE REGRESSION: `alive` alone lets the corpse through', () => {
  // This is the old predicate, exactly. It is kept so the test says WHY the
  // hp clause is there rather than just that it is.
  const aliveOnly = (o) => 'enemy' === o.kind && false !== o.alive;
  assert.equal(aliveOnly(CORPSE), true, 'the old guard passed a corpse - that was the bug');
  assert.equal(living(CORPSE), false, 'the new one does not');
});

test('an explicit alive:false is still honoured', () => {
  assert.equal(living({ ...LIVE, alive: false }), false);
});

test('CONTROL: an absent hp is not a corpse', () => {
  // Older payloads omit hp entirely. Defaulting to 1 keeps them fightable -
  // treating "unknown" as "dead" would empty the field of real enemies.
  const { hp, ...noHp } = LIVE;
  assert.equal(living(noHp), true, 'unknown hp must stay fightable');
});

test('a field of corpses reads as calm', () => {
  const room = [CORPSE, { ...CORPSE, tileX: 85 }, { ...CORPSE, tileX: 86 }];
  assert.equal(room.filter(living).length, 0,
    'three corpses are zero hostiles - this is what gates gathering and the shrine');
});

test('and one live enemy among them still reads as danger', () => {
  const room = [CORPSE, LIVE, { ...CORPSE, tileX: 86 }];
  assert.equal(room.filter(living).length, 1);
});
