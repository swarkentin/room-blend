'use strict';
// Karaoke Brawl: the rules of a duel between two guests who both have a song request waiting.
//
// A duel is a few quick rounds of rock-paper-scissors on the guests' phones, shown on the TV / cast view.
// Both players secretly pick Strike, Feint or Guard. The TV reveals both moves at once. This file is pure rules:
// no clocks, no timers and no room state, so every rule can be tested on its own. lib/room.js runs the clock.
//
//   Strike beats Feint, Feint beats Guard, Guard beats Strike.
//   A round win deals damage. A draw is a clash that hurts both a little (but never knocks anyone out).
//   Win rounds in a row and you are "on fire": the next hit lands harder.
//   From round 2 a Chaos Card may be announced before the picks, so players can plan around it.
//   KO, or the most health after the last round, wins. The winner's song moves up the request list.

/** @typedef {'a'|'b'} Side */

const MOVES = ['strike', 'feint', 'guard'];
const MOVE_LABELS = { strike: 'Strike', feint: 'Feint', guard: 'Guard' };
/** Each move beats the one it maps to. */
const BEATS = { strike: 'feint', feint: 'guard', guard: 'strike' };

// How long each stage of a duel lasts (milliseconds).
const TIMES = { challengeMs: 20000, introMs: 3500, pickMs: 6000, revealMs: 3500, outroMs: 7000, declinedMs: 4500 };

const HP_MAX = 100;
const DAMAGE = 20;        // a round win
const CLASH = 8;          // a draw hurts both
const FIRE_BONUS = 10;    // extra damage once you are on fire (two round wins in a row)
const HEAL = 15;          // Water Break
const FEEDBACK = 25;      // Feedback Squeal: a draw hurts a lot
const MAX_ROUNDS = 6;
const MAX_SUDDEN = 2;     // extra rounds when the score is level
const CHAOS_CHANCE = 0.3;
const MAX_CHAOS = 2;
const MISS_LIMIT = 2;     // pick nothing this many rounds running and you walk off

// Abuse limits that do not depend on the host's settings.
const COOLDOWN_MS = 90 * 1000;          // after a duel, you cannot start another this soon
const SHIELD_MS = 180 * 1000;           // after a duel, nobody can challenge you this soon
const DECLINE_SHIELD_MS = 90 * 1000;    // someone who just said no is left alone
const ROOM_CAP_FACTOR = 3;              // the whole room gets this many times one guest's allowance per window

/** Chaos Cards: announced before the picks of a round, so they are a twist to plan around, never a punishment. */
const CHAOS = {
  twist: { title: 'Plot Twist', text: 'The wheel is flipped! Strike now loses to Guard, Guard loses to Feint, Feint loses to Strike.' },
  encore: { title: 'Encore!', text: 'Double damage this round.' },
  waterbreak: { title: 'Water Break', text: 'Nobody takes damage. The round winner heals 15.' },
  feedback: { title: 'Feedback Squeal', text: 'A draw hurts both of you three times as much.' },
  underdog: { title: 'Underdog Spotlight', text: 'Whoever has less health hits 50% harder this round.' },
  hype: { title: 'Hype Train', text: 'Whoever wins this round is on fire and hits for +10.' },
};
const CHAOS_KEYS = Object.keys(CHAOS);

const clampInt = (v, lo, hi, dflt) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };

/** The host's settings, clamped. */
function cleanOpts(o) {
  const x = o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  return {
    enabled: x.enabled !== false,
    perWindow: clampInt(x.perWindow, 1, 6, 2),   // challenges one guest may declare per window
    windowMin: clampInt(x.windowMin, 5, 120, 15), // the window, in minutes
  };
}

/** @param {string} a @param {string} b @param {boolean} [reversed] @returns {Side|'draw'} */
function winnerOf(a, b, reversed) {
  if (a === b) return 'draw';
  const aWins = BEATS[a] === b;
  return aWins !== !!reversed ? 'a' : 'b';
}

/**
 * One round. Takes health and streaks going in; returns what happened.
 * @param {{hp: {a: number, b: number}, streak: {a: number, b: number}}} input
 * @param {string} aMove @param {string} bMove @param {string|null} chaos
 */
function resolveRound(input, aMove, bMove, chaos) {
  const hp = { a: input.hp.a, b: input.hp.b }, streak = { a: input.streak.a, b: input.streak.b };
  const delta = { a: 0, b: 0 };
  const reversed = chaos === 'twist';
  const outcome = winnerOf(aMove, bMove, reversed);
  /** @type {Side|null} */ let fire = null;
  /** @type {Side|null} */ let underdog = null;
  if (outcome === 'draw') {
    if (chaos === 'waterbreak') { delta.a = 5; delta.b = 5; }
    else { const d = chaos === 'feedback' ? FEEDBACK : CLASH; delta.a = -d; delta.b = -d; }
    streak.a = 0; streak.b = 0;
  } else {
    const w = outcome, l = w === 'a' ? 'b' : 'a';
    if (chaos === 'waterbreak') delta[w] = HEAL;
    else {
      let dmg = DAMAGE;
      if (streak[w] >= 2 || chaos === 'hype') { dmg += FIRE_BONUS; fire = w; }
      if (chaos === 'underdog' && hp[w] < hp[l]) { dmg = Math.round(dmg * 1.5); underdog = w; }
      if (chaos === 'encore') dmg *= 2;
      delta[l] = -dmg;
    }
    streak[w] += 1; streak[l] = 0;
  }
  for (const s of /** @type {Side[]} */ (['a', 'b'])) {
    let next = hp[s] + delta[s];
    if (outcome === 'draw' && delta[s] < 0) next = Math.max(1, next); // a clash never knocks anyone out
    next = Math.min(HP_MAX, Math.max(0, next));
    delta[s] = next - hp[s];
    hp[s] = next;
  }
  return { outcome, delta, hp, streak, fire, underdog, reversed };
}

/**
 * Is the duel over? `played` is rounds played so far. A level score after the last round goes to sudden death,
 * and a level score after that is settled by the judges' coin (winner: null, reason: "coin"; the caller flips it).
 * @param {{hp: {a: number, b: number}, played: number}} f
 * @returns {{done: false} | {done: true, winner: Side|null, reason: 'ko'|'points'|'coin'}}
 */
function verdict(f) {
  if (f.hp.a <= 0) return { done: true, winner: 'b', reason: 'ko' };
  if (f.hp.b <= 0) return { done: true, winner: 'a', reason: 'ko' };
  if (f.played >= MAX_ROUNDS) {
    if (f.hp.a !== f.hp.b) return { done: true, winner: f.hp.a > f.hp.b ? 'a' : 'b', reason: 'points' };
    if (f.played >= MAX_ROUNDS + MAX_SUDDEN) return { done: true, winner: null, reason: 'coin' };
  }
  return { done: false };
}

/**
 * Maybe announce a Chaos Card for the coming round. Never in round 1, never in sudden death, at most MAX_CHAOS per duel.
 * Cards that would do nothing right now (Underdog at equal health, Water Break at full health) are not drawn.
 * @param {() => number} rand @param {{round: number, chaosCount: number, hp: {a: number, b: number}}} ctx @returns {string|null}
 */
function rollChaos(rand, ctx) {
  if (ctx.round < 2 || ctx.round > MAX_ROUNDS || ctx.chaosCount >= MAX_CHAOS) return null;
  if (rand() >= CHAOS_CHANCE) return null;
  const pool = CHAOS_KEYS.filter((k) => {
    if (k === 'underdog') return ctx.hp.a !== ctx.hp.b;
    if (k === 'waterbreak') return ctx.hp.a < HP_MAX || ctx.hp.b < HP_MAX;
    return true;
  });
  return pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))];
}

/**
 * How many request places the winner climbs. 2 for a win; +1 for a knockout; +1 for never losing a round.
 * Walking off earns a single place, so throwing a duel on purpose for a friend is not worth much.
 */
function bumpPlaces(winsByLoser, winnerWins, reason) {
  if (reason === 'forfeit') return 1;
  let places = 2;
  if (reason === 'ko') places++;
  if (winsByLoser === 0 && winnerWins >= 3) places++;
  return Math.min(4, places);
}

/**
 * Where a request lands after its owner wins: at least `places` spots earlier, and always ahead of the loser's
 * earliest waiting request. Only the winner's song moves, so every other song slips back at most one place.
 * Returns the new index (equal to `from` when nothing can move).
 * @param {number} from index of the winner's request @param {number} loserFirst index of the loser's earliest request, or -1
 * @param {number} places
 */
function bumpTarget(from, loserFirst, places) {
  let to = Math.max(0, from - places);
  if (loserFirst >= 0 && loserFirst < from) to = Math.min(to, loserFirst);
  return to;
}

/** A fresh duel waiting for the challenged guest to answer. */
function create(id, a, b, now) {
  return {
    id, phase: 'challenge', deadline: now + TIMES.challengeMs, phaseMs: TIMES.challengeMs,
    a: { id: a.id, name: a.name, color: a.color }, b: { id: b.id, name: b.name, color: b.color },
    song: { a: a.song || null, b: b.song || null },
    hp: { a: HP_MAX, b: HP_MAX }, streak: { a: 0, b: 0 }, wins: { a: 0, b: 0 },
    played: 0, round: 0, sudden: false, chaos: null, chaosCount: 0,
    picks: { a: null, b: null }, missed: { a: 0, b: 0 },
    reveal: null, pending: null, result: null,
  };
}

module.exports = {
  MOVES, MOVE_LABELS, BEATS, TIMES, CHAOS, CHAOS_KEYS,
  HP_MAX, DAMAGE, CLASH, FIRE_BONUS, HEAL, FEEDBACK, MAX_ROUNDS, MAX_SUDDEN, CHAOS_CHANCE, MAX_CHAOS, MISS_LIMIT,
  COOLDOWN_MS, SHIELD_MS, DECLINE_SHIELD_MS, ROOM_CAP_FACTOR,
  cleanOpts, winnerOf, resolveRound, verdict, rollChaos, bumpPlaces, bumpTarget, create,
};
