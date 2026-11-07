'use strict';
// Duels: the rules (lib/fight.js), then how a room runs them, limits them and moves the winner's song up.
const assert = require('assert');
const F = require('../lib/fight.js');
const { Room } = require('../lib/room.js');
let n = 0; const ok = (s) => { n++; console.log('  ok  ' + s); };

// ================= the rules =================
const fresh = () => ({ hp: { a: 100, b: 100 }, streak: { a: 0, b: 0 } });

// The wheel: strike beats feint, feint beats guard, guard beats strike.
assert.strictEqual(F.winnerOf('strike', 'feint'), 'a');
assert.strictEqual(F.winnerOf('feint', 'guard'), 'a');
assert.strictEqual(F.winnerOf('guard', 'strike'), 'a');
assert.strictEqual(F.winnerOf('feint', 'strike'), 'b');
assert.strictEqual(F.winnerOf('guard', 'feint'), 'b');
assert.strictEqual(F.winnerOf('strike', 'guard'), 'b');
for (const m of F.MOVES) assert.strictEqual(F.winnerOf(m, m), 'draw');
ok('strike beats feint, feint beats guard, guard beats strike; the same move is a draw');
for (const x of F.MOVES) for (const y of F.MOVES) {
  if (x !== y) assert.notStrictEqual(F.winnerOf(x, y, true), F.winnerOf(x, y, false));
}
assert.strictEqual(F.winnerOf('strike', 'guard', true), 'a');
ok('Plot Twist flips every result');

let r = F.resolveRound(fresh(), 'strike', 'feint', null);
assert.deepStrictEqual([r.outcome, r.hp.a, r.hp.b, r.streak.a, r.streak.b], ['a', 100, 80, 1, 0]);
ok('a round win deals 20 and starts a streak');
r = F.resolveRound({ hp: { a: 100, b: 80 }, streak: { a: 2, b: 0 } }, 'strike', 'feint', null);
assert.strictEqual(r.hp.b, 50); assert.strictEqual(r.fire, 'a');
ok('two wins in a row set you on fire: the next hit does 30');
r = F.resolveRound({ hp: { a: 50, b: 50 }, streak: { a: 2, b: 0 } }, 'strike', 'strike', null);
assert.deepStrictEqual([r.outcome, r.hp.a, r.hp.b, r.streak.a], ['draw', 42, 42, 0]);
ok('a draw is a clash: both take 8 and streaks reset');
r = F.resolveRound({ hp: { a: 5, b: 3 }, streak: { a: 0, b: 0 } }, 'guard', 'guard', null);
assert.deepStrictEqual([r.hp.a, r.hp.b], [1, 1]);
ok('a clash can never knock anyone out');
r = F.resolveRound({ hp: { a: 3, b: 9 }, streak: { a: 0, b: 0 } }, 'guard', 'guard', 'feedback');
assert.deepStrictEqual([r.hp.a, r.hp.b], [1, 1]);
r = F.resolveRound(fresh(), 'guard', 'guard', 'feedback');
assert.deepStrictEqual([r.hp.a, r.hp.b], [75, 75]);
ok('Feedback Squeal makes a draw cost 25');
r = F.resolveRound(fresh(), 'strike', 'feint', 'encore'); assert.strictEqual(r.hp.b, 60);
ok('Encore doubles the damage');
r = F.resolveRound({ hp: { a: 60, b: 90 }, streak: { a: 0, b: 0 } }, 'strike', 'feint', 'underdog'); assert.strictEqual(r.hp.b, 60); assert.strictEqual(r.underdog, 'a');
r = F.resolveRound({ hp: { a: 90, b: 60 }, streak: { a: 0, b: 0 } }, 'strike', 'feint', 'underdog'); assert.strictEqual(r.hp.b, 40); assert.strictEqual(r.underdog, null);
ok('Underdog Spotlight boosts only the player with less health');
r = F.resolveRound({ hp: { a: 70, b: 90 }, streak: { a: 0, b: 0 } }, 'strike', 'feint', 'waterbreak');
assert.deepStrictEqual([r.hp.a, r.hp.b], [85, 90]);
r = F.resolveRound({ hp: { a: 98, b: 90 }, streak: { a: 0, b: 0 } }, 'strike', 'feint', 'waterbreak'); assert.strictEqual(r.hp.a, 100); assert.strictEqual(r.delta.a, 2);
ok('Water Break heals the round winner (never above 100) and hurts nobody');
r = F.resolveRound(fresh(), 'strike', 'feint', 'hype'); assert.strictEqual(r.hp.b, 70); assert.strictEqual(r.fire, 'a');
ok('Hype Train sets the round winner on fire');
r = F.resolveRound(fresh(), 'strike', 'guard', 'twist'); assert.strictEqual(r.outcome, 'a'); assert.strictEqual(r.reversed, true);
ok('a flipped wheel decides the round');

assert.deepStrictEqual(F.verdict({ hp: { a: 0, b: 40 }, played: 3 }), { done: true, winner: 'b', reason: 'ko' });
assert.deepStrictEqual(F.verdict({ hp: { a: 60, b: 0 }, played: 4 }), { done: true, winner: 'a', reason: 'ko' });
assert.deepStrictEqual(F.verdict({ hp: { a: 60, b: 50 }, played: 5 }), { done: false });
assert.deepStrictEqual(F.verdict({ hp: { a: 60, b: 50 }, played: 6 }), { done: true, winner: 'a', reason: 'points' });
assert.deepStrictEqual(F.verdict({ hp: { a: 50, b: 50 }, played: 6 }), { done: false });
assert.deepStrictEqual(F.verdict({ hp: { a: 50, b: 50 }, played: 7 }), { done: false });
assert.deepStrictEqual(F.verdict({ hp: { a: 50, b: 50 }, played: 8 }), { done: true, winner: null, reason: 'coin' });
assert.deepStrictEqual(F.verdict({ hp: { a: 50, b: 40 }, played: 7 }), { done: true, winner: 'a', reason: 'points' });
ok('KO or most health after six rounds wins; a level score goes to sudden death, then the judges\' coin');

const always = (v) => () => v;
assert.strictEqual(F.rollChaos(always(0), { round: 1, chaosCount: 0, hp: { a: 80, b: 90 } }), null);
assert.strictEqual(F.rollChaos(always(0.99), { round: 3, chaosCount: 0, hp: { a: 80, b: 90 } }), null);
assert.strictEqual(F.rollChaos(always(0), { round: 3, chaosCount: 2, hp: { a: 80, b: 90 } }), null);
assert.strictEqual(F.rollChaos(always(0), { round: 7, chaosCount: 0, hp: { a: 80, b: 90 } }), null);
assert.ok(F.CHAOS_KEYS.includes(F.rollChaos(always(0), { round: 2, chaosCount: 0, hp: { a: 80, b: 90 } })));
for (let i = 0; i < 200; i++) {
  const k = F.rollChaos(Math.random, { round: 3, chaosCount: 0, hp: { a: 100, b: 100 } });
  assert.ok(k !== 'underdog' && k !== 'waterbreak', 'cards that would do nothing are not drawn');
}
ok('Chaos Cards: never in round 1 or sudden death, at most two a duel, never one that would do nothing');

assert.strictEqual(F.bumpPlaces(2, 3, 'points'), 2);
assert.strictEqual(F.bumpPlaces(2, 4, 'ko'), 3);
assert.strictEqual(F.bumpPlaces(0, 4, 'ko'), 4);
assert.strictEqual(F.bumpPlaces(0, 3, 'points'), 3);
assert.strictEqual(F.bumpPlaces(0, 1, 'forfeit'), 1);
assert.strictEqual(F.bumpTarget(5, 4, 2), 3);
assert.strictEqual(F.bumpTarget(5, 1, 2), 1);   // always ends ahead of the loser's request
assert.strictEqual(F.bumpTarget(1, -1, 4), 0);
assert.strictEqual(F.bumpTarget(2, 6, 1), 1);   // the loser was already behind: the win still earns its places
ok('a win climbs 2 places (3 for a KO, 4 for a flawless KO), and always ends ahead of the loser\'s song');

assert.deepStrictEqual(F.cleanOpts(null), { enabled: true, perWindow: 2, windowMin: 15 });
assert.deepStrictEqual(F.cleanOpts({ enabled: false, perWindow: 99, windowMin: 1 }), { enabled: false, perWindow: 6, windowMin: 5 });
ok('host settings are clamped');

// ================= a room running duels =================
const T0 = 10_000_000;
let t = T0;
function mkRoom() {
  const room = new Room('DUEL1', 'k'.repeat(32), T0);
  room.opts.settle = 0;
  room.rand = () => 0.99; // no Chaos Cards, and auto-picks are always guard
  return room;
}
function guest(room, name, genre, ...songs) {
  const g = room.addGuest(name, [genre], { immediate: true }, T0);
  g.connected = true; g.lostAt = null;
  songs.forEach((s, i) => assert.ok(room.addRequest(g.id, s, name + ' Band ' + i).ok));
  return g;
}
const clear = (room) => { // run the clock until the ring is free again
  for (let i = 0; i < 40 && room.fight; i++) { t = room.fight.deadline; room.tickFight(t); }
  assert.strictEqual(room.fight, null);
};
// Plays one round: both pick, the reveal runs its course, and the clock moves to the next round or the end.
const round = (room, a, b, am, bm) => {
  assert.strictEqual(room.fight.phase, 'pick');
  assert.ok(room.pickMove(a.id, am, t).ok); assert.ok(room.pickMove(b.id, bm, t).ok);
  assert.strictEqual(room.fight.phase, 'reveal', 'both picks in: the round is revealed straight away');
  t = room.fight.deadline; room.tickFight(t);
};
const accepted = (room, a, b) => {
  assert.ok(room.challenge(a.id, b.id, t).ok);
  assert.ok(room.respondToFight(b.id, true, t).ok);
  assert.strictEqual(room.fight.phase, 'intro');
  t = room.fight.deadline; room.tickFight(t);
  assert.strictEqual(room.fight.phase, 'pick');
};

{ // who may fight
  t = T0; const room = mkRoom();
  const a = guest(room, 'Ana', 'rock', 'Song A'), b = guest(room, 'Bo', 'jazz', 'Song B'), c = guest(room, 'Cy', 'pop');
  assert.ok(!room.challenge(a.id, a.id, t).ok);
  assert.match(room.challenge(a.id, c.id, t).error, /no song waiting/);
  assert.match(room.challenge(c.id, a.id, t).error, /Request a song first/);
  b.connected = false; assert.match(room.challenge(a.id, b.id, t).error, /not here/); b.connected = true;
  const m = room.addGuest('Host Pal', ['rock'], { immediate: true, manual: true }, T0); room.addRequest(m.id, 'M Song', 'M Band');
  assert.match(room.challenge(a.id, m.id, t).error, /no phone/);
  room.setFightOpts({ enabled: false }, t); assert.match(room.challenge(a.id, b.id, t).error, /turned off/);
  assert.deepStrictEqual(room.fightGuestView(a.id), { enabled: false });
  room.setFightOpts({ enabled: true }, t);
  assert.ok(room.challenge(a.id, b.id, t).ok);
  assert.match(room.challenge(b.id, a.id, t).error, /ring is busy/);
  ok('both fighters need a waiting request, an active phone and a free ring; the host can switch duels off');
}

{ // a full duel: a knockout moves the winner's song up
  t = T0; const room = mkRoom();
  for (let i = 1; i <= 4; i++) room.addRequest('', 'Host Song ' + i, 'Host Band', true);
  const b = guest(room, 'Bo', 'jazz', 'Bo Song'), a = guest(room, 'Ana', 'rock', 'Ana Song');
  const titles = () => room.requestQueue.map((x) => x.title);
  const before = titles();
  assert.strictEqual(before[before.length - 1], 'Ana Song');
  accepted(room, a, b);
  const pub = JSON.stringify(room.fightPublic(t));
  assert.ok(!/strike|feint|guard/.test(pub), 'the TV never sees moves before the reveal');
  assert.strictEqual(room.fightGuestView(a.id).live.picked, null);
  room.pickMove(a.id, 'strike', t);
  assert.strictEqual(room.fightGuestView(a.id).live.picked, 'strike', 'you can see your own locked-in move');
  assert.strictEqual(room.fightGuestView(b.id).live.picked, null, 'but never your opponent\'s');
  assert.strictEqual(room.fightPublic(t).a.locked, true); assert.strictEqual(room.fightPublic(t).b.locked, false);
  assert.ok(!/"strike"/.test(JSON.stringify(room.fightPublic(t))));
  assert.match(room.pickMove(a.id, 'guard', t).error, /already locked/);
  assert.ok(room.pickMove(b.id, 'feint', t).ok);
  assert.strictEqual(room.fight.phase, 'reveal');
  assert.strictEqual(room.fightPublic(t).reveal.a, 'strike');
  assert.strictEqual(room.fightPublic(t).b.hp, 80);
  t = room.fight.deadline; room.tickFight(t);
  round(room, a, b, 'strike', 'feint'); // 60
  round(room, a, b, 'strike', 'feint'); // on fire: 30
  assert.strictEqual(room.fight.hp.b, 30);
  assert.ok(room.pickMove(a.id, 'strike', t).ok); assert.ok(room.pickMove(b.id, 'feint', t).ok);
  assert.strictEqual(room.fight.pending.reason, 'ko');
  t = room.fight.deadline; room.tickFight(t);
  assert.strictEqual(room.fight.phase, 'over');
  const res = room.fightPublic(t).result;
  assert.deepStrictEqual([res.winnerId, res.loserId, res.reason, res.flawless], [a.id, b.id, 'ko', true]);
  const after = titles();
  assert.strictEqual(after.indexOf('Ana Song'), Math.max(0, before.length - 1 - 4), 'a flawless knockout climbs 4 places');
  assert.strictEqual(after.length, before.length, 'nobody\'s song is removed');
  assert.ok(res.bump.to < res.bump.from && res.bump.places === 4, JSON.stringify(res.bump));
  assert.deepStrictEqual(before.filter((x) => x !== 'Ana Song'), after.filter((x) => x !== 'Ana Song'), 'every other song keeps its order');
  assert.ok(room.log[0].includes('Ana beat Bo'));
  clear(room);
  ok('a flawless knockout: 4 rounds, the winner\'s song climbs 4 places, nobody else\'s moves more than one, and the ring clears');
}

{ // winning on points, ending ahead of the loser's song
  t = T0; const room = mkRoom();
  const b = guest(room, 'Bo', 'jazz', 'Bo Song'), a = guest(room, 'Ana', 'rock', 'Ana Song');
  accepted(room, a, b);
  round(room, a, b, 'strike', 'feint');   // b 80
  round(room, a, b, 'guard', 'guard');    // clash: 92 / 72
  round(room, a, b, 'feint', 'strike');   // a loses: 92 -> 72, b streak 1
  round(room, a, b, 'strike', 'strike');  // clash 64 / 64
  round(room, a, b, 'strike', 'feint');   // b 44
  assert.strictEqual(room.fight.round, 6);
  assert.ok(room.pickMove(a.id, 'feint', t).ok); assert.ok(room.pickMove(b.id, 'strike', t).ok); // b wins: a 44
  assert.strictEqual(room.fight.hp.a, room.fight.hp.b);
  t = room.fight.deadline; room.tickFight(t);
  assert.ok(room.fight.sudden, 'a level score after six rounds goes to sudden death');
  assert.strictEqual(room.fight.chaos, null);
  round(room, a, b, 'strike', 'feint');
  assert.strictEqual(room.fight.phase, 'over');
  assert.strictEqual(room.fight.result.reason, 'points');
  assert.strictEqual(room.fight.result.winnerId, a.id);
  const q = room.requestQueue.map((x) => x.title);
  assert.ok(q.indexOf('Ana Song') < q.indexOf('Bo Song'));
  clear(room);
  ok('level after six rounds: sudden death decides it, and the winner\'s song ends up ahead of the loser\'s');
}

{ // Chaos Cards are announced before the picks, from round 2
  t = T0; const room = mkRoom();
  const b = guest(room, 'Bo', 'jazz', 'Bo Song'), a = guest(room, 'Ana', 'rock', 'Ana Song');
  room.rand = () => 0;
  assert.ok(room.challenge(a.id, b.id, t).ok); room.respondToFight(b.id, true, t);
  t = room.fight.deadline; room.tickFight(t);
  assert.strictEqual(room.fight.chaos, null, 'round 1 is always plain');
  round(room, a, b, 'guard', 'guard');
  const view = room.fightPublic(t);
  assert.strictEqual(view.round, 2); assert.ok(view.chaos && view.chaos.title && view.chaos.text);
  assert.ok(room.fightGuestView(b.id).live.chaos);
  room.pickMove(a.id, 'strike', t); room.pickMove(b.id, 'strike', t);
  assert.strictEqual(room.fightPublic(t).reveal.chaos, room.fight.chaos);
  ok('a Chaos Card is announced to the TV and both phones before the picks of round 2');
}

{ // a missed pick is made for you; two in a row and you walk off
  t = T0; const room = mkRoom();
  const b = guest(room, 'Bo', 'jazz', 'Bo Song'), a = guest(room, 'Ana', 'rock', 'Ana Song');
  accepted(room, a, b);
  room.pickMove(b.id, 'strike', t);
  assert.strictEqual(room.tickFight(t + 1000), false, 'the clock does nothing before the deadline');
  t = room.fight.deadline; assert.strictEqual(room.tickFight(t), true);
  assert.strictEqual(room.fight.phase, 'reveal');
  assert.deepStrictEqual(room.fightPublic(t).reveal.auto, { a: true, b: false });
  t = room.fight.deadline; room.tickFight(t);
  room.pickMove(b.id, 'strike', t);
  t = room.fight.deadline; room.tickFight(t);
  assert.strictEqual(room.fight.phase, 'over');
  assert.deepStrictEqual([room.fight.result.reason, room.fight.result.winnerId], ['forfeit', b.id]);
  assert.strictEqual(room.fight.result.bump.places <= 1, true, 'a walk-off earns one place at most');
  clear(room);
  ok('a missed pick is made for you; missing two rounds running forfeits, for one place only');
}

{ // both phones idle: nobody wins
  t = T0; const room = mkRoom();
  const b = guest(room, 'Bo', 'jazz', 'Bo Song'), a = guest(room, 'Ana', 'rock', 'Ana Song');
  const order = room.requestQueue.map((x) => x.title);
  accepted(room, a, b);
  for (let i = 0; i < 2; i++) { t = room.fight.deadline; room.tickFight(t); if (room.fight.phase === 'reveal') { t = room.fight.deadline; room.tickFight(t); } }
  assert.strictEqual(room.fight.phase, 'over');
  assert.deepStrictEqual([room.fight.result.reason, room.fight.result.winner], ['abandoned', null]);
  assert.deepStrictEqual(room.requestQueue.map((x) => x.title), order);
  ok('if neither fighter answers, the duel is off and nothing moves');
}

{ // declining, timing out, leaving, and the host calling it off
  t = T0; let room = mkRoom();
  let a = guest(room, 'Ana', 'rock', 'Ana Song'), b = guest(room, 'Bo', 'jazz', 'Bo Song');
  const order = room.requestQueue.map((x) => x.title);
  assert.ok(room.challenge(a.id, b.id, t).ok);
  assert.match(room.respondToFight(a.id, true, t).error, /no challenge/, 'only the challenged guest can answer');
  assert.ok(room.respondToFight(b.id, false, t).ok);
  assert.strictEqual(room.fight.result.reason, 'declined');
  clear(room);
  assert.match(room.challenge(a.id, b.id, t + 1000).error, /just had a duel/, 'someone who said no is left alone for a bit');
  ok('a declined challenge costs the challenger one challenge and leaves the target alone for 90 seconds');

  assert.ok(room.challenge(a.id, b.id, t + F.DECLINE_SHIELD_MS + 1).ok);
  t += F.DECLINE_SHIELD_MS + 1;
  t = room.fight.deadline; room.tickFight(t);
  assert.strictEqual(room.fight.result.reason, 'expired');
  clear(room);
  ok('an unanswered challenge times out after 20 seconds');

  t = T0; room = mkRoom();
  a = guest(room, 'Ana', 'rock', 'Ana Song'); b = guest(room, 'Bo', 'jazz', 'Bo Song');
  accepted(room, a, b);
  room.removeGuest(b.id, 'left');
  assert.strictEqual(room.fight.result.reason, 'forfeit'); assert.strictEqual(room.fight.result.winnerId, a.id);
  assert.ok(!room.requestQueue.some((r) => r.guestId === b.id));
  clear(room);
  t = T0; room = mkRoom();
  a = guest(room, 'Ana', 'rock', 'Ana Song'); b = guest(room, 'Bo', 'jazz', 'Bo Song');
  assert.ok(room.challenge(a.id, b.id, t).ok); room.removeGuest(a.id, 'left');
  assert.deepStrictEqual([room.fight.result.reason, room.fight.result.winner], ['cancelled', null]);
  assert.strictEqual(room.fightQuota(a.id, t).used, 0, 'a cancelled challenge does not count against anyone');
  ok('someone leaving mid-duel cancels it before the first move and forfeits it after');

  t = T0; room = mkRoom();
  a = guest(room, 'Ana', 'rock', 'Ana Song'); b = guest(room, 'Bo', 'jazz', 'Bo Song');
  accepted(room, a, b);
  assert.ok(room.cancelFight(t)); assert.strictEqual(room.fight.result.reason, 'cancelled');
  assert.strictEqual(room.cancelFight(t), false);
  clear(room);
  t += F.SHIELD_MS + 1;
  assert.ok(room.challenge(a.id, b.id, t).ok); room.respondToFight(b.id, true, t);
  room.setFightOpts({ enabled: false }, t);
  assert.strictEqual(room.fight.result.reason, 'cancelled');
  ok('the host can call a duel off, or switch duels off while one is on');

  t = T0; room = mkRoom();
  a = guest(room, 'Ana', 'rock', 'Ana Song'); b = guest(room, 'Bo', 'jazz', 'Bo Song');
  assert.ok(room.challenge(a.id, b.id, t).ok);
  room.requestQueue = room.requestQueue.filter((r) => r.guestId !== b.id); // Bo's song started playing
  assert.ok(room.respondToFight(b.id, true, t).ok);
  assert.strictEqual(room.fight.result.reason, 'cancelled');
  assert.deepStrictEqual(order.length, 2);
  ok('if a song is no longer waiting when the challenge is accepted, the duel is off');
}

{ // the limits
  t = T0; const room = mkRoom();
  const [a, b, c, d] = ['Ana', 'Bo', 'Cy', 'Di'].map((nm, i) => guest(room, nm, ['rock', 'jazz', 'pop', 'blues'][i], nm + ' Song'));
  assert.strictEqual(room.fightOpts.perWindow, 2);
  assert.deepStrictEqual([room.fightGuestView(a.id, t).left, room.fightGuestView(a.id, t).perWindow, room.fightGuestView(a.id, t).windowMin], [2, 2, 15]);
  const decline = (from, to, at) => { t = at; assert.ok(room.challenge(from.id, to.id, t).ok); room.respondToFight(to.id, false, t); clear(room); };
  decline(a, b, T0); decline(a, c, T0 + 10_000);
  t = T0 + 20_000;
  const refused = room.challenge(a.id, d.id, t);
  assert.ok(!refused.ok); assert.match(refused.error, /used your 2 challenges/); assert.strictEqual(refused.retryAt, T0 + 15 * 60000);
  assert.strictEqual(room.fightGuestView(a.id, t).left, 0);
  assert.ok(room.fightGuestView(a.id, t).resetInMs > 0);
  assert.strictEqual(room.fightGuestView(a.id, t).roster.find((x) => x.id === d.id).can, false);
  ok('a guest may declare 2 challenges per 15 minutes; the refusal says when the next opens');
  assert.ok(room.challenge(b.id, d.id, t).ok, 'other guests have their own allowance'); clear(room);
  t = T0 + 15 * 60000; assert.ok(room.challenge(a.id, d.id, t).ok, 'the first challenge stops counting after the window');
  clear(room);
  ok('the allowance is per guest and rolls forward with time');

  room.setFightOpts({ perWindow: 1, windowMin: 30 }, t);
  assert.deepStrictEqual(room.fightOpts, { enabled: true, perWindow: 1, windowMin: 30 });
  const r2 = new Room('DUEL2', 'k'.repeat(32), T0); assert.strictEqual(r2.restoreSnapshot(room.snapshot()), true);
  assert.deepStrictEqual(r2.fightOpts, { enabled: true, perWindow: 1, windowMin: 30 });
  assert.strictEqual(r2.fight, null);
  ok('the host\'s duel settings survive a room snapshot');
}

{ // breathing room after a duel, and no farming one opponent
  t = T0; const room = mkRoom();
  const [a, b, c] = ['Ana', 'Bo', 'Cy'].map((nm, i) => guest(room, nm, ['rock', 'jazz', 'pop'][i], nm + ' Song'));
  accepted(room, a, b);
  room.fight.hp.b = 20; // cut the duel short
  round(room, a, b, 'strike', 'feint');
  clear(room);
  const end = t;
  assert.match(room.challenge(a.id, c.id, end + 1000).error, /Catch your breath/);
  assert.match(room.challenge(c.id, b.id, end + 1000).error, /just had a duel/);
  assert.match(room.challenge(c.id, a.id, end + 1000).error, /just had a duel/);
  ok('after a duel both fighters get a breather: no starting another for 90 s, nobody can challenge them for 3 minutes');
  assert.ok(room.challenge(c.id, a.id, end + F.SHIELD_MS + 1).ok); clear(room);
  const later = end + F.SHIELD_MS + F.COOLDOWN_MS + 60_000;
  assert.match(room.challenge(a.id, b.id, later).error, /already fought/);
  assert.match(room.challenge(b.id, a.id, later).error, /already fought/);
  ok('the same two guests cannot fight again inside the window');
}

{ // the room as a whole gets a cap too
  t = T0; const room = mkRoom();
  room.setFightOpts({ perWindow: 1 }, t);
  const gs = [];
  for (let i = 0; i < 10; i++) gs.push(guest(room, 'G' + i, ['rock', 'jazz', 'pop', 'blues', 'soul'][i % 5], 'Song ' + i));
  for (let i = 0; i < 4; i++) { t = T0 + i * 1000; assert.ok(room.challenge(gs[i * 2].id, gs[i * 2 + 1].id, t).ok); room.respondToFight(gs[i * 2 + 1].id, false, t); clear(room); }
  t = T0 + 5000;
  assert.match(room.challenge(gs[8].id, gs[9].id, t).error, /ring needs a breather/);
  ok('with every guest inside their own allowance, the room still caps how many challenges fit in a window');
}

{ // what a phone and a TV are told
  t = T0; const room = mkRoom();
  const a = guest(room, 'Ana', 'rock', 'Ana Song'), b = guest(room, 'Bo', 'jazz', 'Bo Song'), c = guest(room, 'Cy', 'pop');
  const view = room.fightGuestView(a.id);
  assert.deepStrictEqual(view.roster.map((x) => x.name), ['Bo'], 'only guests with a song waiting can be challenged');
  assert.deepStrictEqual(view.roster[0].song, { title: 'Bo Song', artist: 'Bo Band 0' });
  assert.strictEqual(view.roster[0].can, true);
  assert.strictEqual(view.ready, true);
  assert.strictEqual(room.fightGuestView(c.id).ready, false);
  assert.match(room.fightGuestView(c.id).notReady, /Request a song first/);
  assert.ok(room.guestView(a.id).fights.enabled);
  assert.strictEqual(room.hostView().fight, null);
  assert.deepStrictEqual(room.hostView().fightOpts, { enabled: true, perWindow: 2, windowMin: 15 });
  assert.ok(room.challenge(a.id, b.id, t).ok);
  assert.strictEqual(room.hostView().fight.phase, 'challenge');
  assert.strictEqual(room.fightGuestView(b.id).live.you, 'b');
  assert.strictEqual(room.fightGuestView(c.id).live.you, null);
  assert.ok(room.fightPublic(t).leftMs <= F.TIMES.challengeMs);
  assert.ok(!('fight' in room.screenView()) && !('fights' in room.screenView()), 'the QR screen carries no duel details');
  ok('phones get their allowance, who can be challenged and the live duel; the TV gets the public duel');
}

console.log(n + ' duel checks passed');
