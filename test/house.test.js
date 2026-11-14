'use strict';
// House picks: a room can play with nobody in it, and the house is never a person.
const assert = require('assert');
const { Room } = require('../lib/room');
let n = 0; const ok = (s) => { n++; console.log('  ok  ' + s); };
const mk = () => new Room('HOUSE', 'h'.repeat(32));

// off by default
let r = mk();
assert.strictEqual(r.nowItem, null); assert.strictEqual(r.houseGuest(), null); assert.deepStrictEqual(r.house, { enabled: false, genres: [], artists: [], mode: 'alone' }); ok('off by default, and nothing plays with nobody in the room');

// start music with nobody
r.setHouse({ enabled: true, genres: ['jazz'] });
assert.ok(r.nowItem, 'music starts'); assert.ok(r.queue.length > 0); ok('turning house picks on starts music with no guest');
const Engine = require('../lib/engine');
assert.ok(r.nowItem.track.genres.some((g) => Engine.expandPick('jazz').includes(g)), 'the song suits the house picks: ' + r.nowItem.track.genres); ok('the first song suits the house picks');
assert.strictEqual(r.active().length, 0); assert.strictEqual(r.guests.size, 0); ok('and no fake guest is created');
const view = r.hostView();
assert.strictEqual(view.house.playing, true); assert.strictEqual(view.guests.length, 0); assert.ok(view.now.fits.every((f) => f.id !== 'house')); ok('the host view says the house is playing, lists no guests and no house fit');
for (let i = 0; i < 4; i++) r.advance();
assert.ok(r.history.length >= 4 && r.history.every((h) => h.fits.every((f) => f.id !== 'house'))); ok('house plays are recorded without the house as a listener');
assert.strictEqual(r.hostView().fairness.length, 0); ok('and there is no fairness row for it');

// a guest arrives: in the default mode the house steps aside
const g = r.addGuest('Ana', ['rock'], { immediate: true });
assert.ok(g); assert.strictEqual(r.houseGuest(), null); assert.strictEqual(r.hostView().house.playing, false); ok("a real guest arriving makes the house step aside ('alone' mode)");
assert.ok(r.queue.every((q) => q.fits.every((f) => f.id !== 'house'))); ok('guests are blended as before');
r.removeGuest ? r.removeGuest(g.id) : r.guests.delete(g.id); r.rebuild('guest left', false);
assert.ok(r.houseGuest(), 'house is back'); assert.ok(r.nowItem); ok('when the last guest leaves, the house plays again');

// 'always' mode: one more listener alongside guests
r.setHouse({ mode: 'always' });
const g2 = r.addGuest('Ben', ['blues'], { immediate: true });
assert.ok(g2 && r.houseGuest()); assert.strictEqual(r.blenders().length, 2); assert.strictEqual(r.active().length, 1); ok("in 'always' mode the house is blended in but still not counted as a person");
assert.ok(r.screenView().people === 1); ok('people counts exclude the house');

// the house asks the host's music source for its genres and artists
const w = mk(); w.setHouse({ enabled: true, genres: ['80s'], artists: ['Prince'] });
assert.ok(w.wantEras().some((e) => e.era === '80s')); assert.ok(w.wantArtists().some((a) => /prince/i.test(a.name)), 'wantArtists: ' + JSON.stringify(w.wantArtists())); ok('house genres, eras and artists are searched for like a guest\'s');

// limits and cleaning
const c = mk(); c.setHouse({ enabled: true, genres: ['jazz', 'rock', 'blues', 'pop', 'metal', 'nonsense'], artists: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], mode: 'weird' });
assert.ok(c.house.genres.length <= 4 && c.house.artists.length <= 6 && c.house.mode === 'alone' && !c.house.genres.includes('nonsense')); ok('picks are cleaned and limited like a guest\'s');
const e = mk(); e.setHouse({ enabled: true, genres: [], artists: [] });
assert.strictEqual(e.houseGuest(), null); assert.strictEqual(e.nowItem, null); ok('house on with nothing picked plays nothing');

// survives a restart
const s = mk(); s.setHouse({ enabled: true, genres: ['jazz'], mode: 'always' });
const t = mk(); assert.strictEqual(t.restoreSnapshot(JSON.parse(JSON.stringify(s.snapshot()))), true);
assert.deepStrictEqual(t.house, s.house); ok('house picks are saved with the room and restored');
const off = mk(); off.setHouse({ enabled: true, genres: ['jazz'] }); off.setHouse({ enabled: false });
assert.strictEqual(off.houseGuest(), null); assert.strictEqual(off.served.house, undefined); ok('turning it off removes it from the blend');
console.log(n + ' house checks passed');
