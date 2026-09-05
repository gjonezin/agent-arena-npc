/**
 * An errand that stops making progress stops.
 *
 * Measured live 2026-08-31, three separate connections: Sir Qwen closed to 105
 * tiles of the copper seam, wedged at tile (55,73), and issued the SAME step -
 * go_to 3928,5080 - seventy-nine times. The server answered "ok - got there"
 * every time and the body never moved. With no progress check, the errand
 * spent its whole 250-beat budget standing still: about twenty-nine minutes of
 * a character doing literally nothing, which is how the user noticed.
 *
 * The lesson is in what the guard keys on. "Did the walk succeed?" is
 * unanswerable here - the server says yes and is wrong. The only trustworthy
 * signal is the DISTANCE falling, which is measured on our side from our own
 * position, and cannot be faked by a reply.
 *
 * This guard existed as seamBest/seamStuck and was deleted on 2026-08-27 as
 * dead code. It was genuinely dead - never wired to anything - which is why
 * deleting it looked safe and why the wedge went unnoticed for four days.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const STALL = 12;
const PROGRESS_PX = 48;

/** The rule, in isolation: does this beat count as progress? */
function step(state, distance) {
  if (null === state.best || distance < state.best - PROGRESS_PX) {
    return { best: distance, stuck: 0 };
  }
  return { best: state.best, stuck: state.stuck + 1 };
}
const walking = (state) => state.stuck < STALL;

test('a walk that closes distance keeps going', () => {
  let s = { best: null, stuck: 0 };
  for (const d of [9000, 8000, 7000, 6000, 5000]) {
    s = step(s, d);
  }
  assert.equal(s.stuck, 0);
  assert.ok(walking(s), 'real progress must never trip the guard');
});

test('THE WEDGE: the same distance forever ends the walk', () => {
  // 105 tiles at 64px, held flat - exactly what the log showed.
  let s = { best: null, stuck: 0 };
  let beats = 0;
  while (walking(s) && beats < 250) {
    s = step(s, 6720);
    beats += 1;
  }
  assert.ok(beats < 250, 'the walk must not spend its whole budget standing still');
  assert.equal(beats, STALL + 1, 'it gives up one beat after the stall budget');
});

test('and it costs beats, not half an hour', () => {
  // The measured failure was 250 beats at roughly 7s each.
  const beatsBefore = 250;
  const beatsNow = STALL + 1;
  assert.ok(beatsNow < beatsBefore / 15,
    `${beatsNow} beats against ${beatsBefore} - the point of the guard`);
});

test('a detour is not a wedge: small wobbles are tolerated', () => {
  // Rounding a corner can hold or briefly worsen the straight-line distance.
  let s = { best: null, stuck: 0 };
  s = step(s, 9000);
  for (const d of [9010, 9005, 8990, 9001]) {
    s = step(s, d);
  }
  assert.ok(walking(s), 'four beats of wobble must not end the errand');
  s = step(s, 8000);
  assert.equal(s.stuck, 0, 'and real progress clears the count');
});

test('CONTROL: progress must beat the threshold, not merely differ', () => {
  // A body drifting one pixel closer each beat is wedged, not walking.
  let s = { best: null, stuck: 0 };
  s = step(s, 9000);
  for (let i = 1; i <= STALL; i += 1) {
    s = step(s, 9000 - i);
  }
  assert.ok(!walking(s), 'a pixel of drift per beat is not progress');
});
