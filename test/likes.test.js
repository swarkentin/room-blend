'use strict';
// Artist and song picks: they count as a perfect fit for the guest who named them, matched by plain text.
const assert = require('assert');
const E = require('../lib/engine.js');
let n = 0; const ok = (s) => { n++; console.log('  ok  ' + s); };
const trk = (id, title, artist, genres) => ({ id, title, artist, genres });
const person = (id, genres, extra = {}) => ({ id, taste: Object.fromEntries(genres.map((g, i) => [g, [4, 3, 2, 1][i]])), ...extra });

// ---- matching
const keys = (a) => [...E.artistKeys(a)].sort();
assert.deepStrictEqual(keys('Mark Ronson feat. Bruno Mars'), ['bruno mars', 'mark ronson', 'mark ronson feat bruno mars']);
assert.ok(E.artistKeys('Beyoncé').has('beyonce')); assert.ok(E.artistKeys('Simon & Garfunkel').has('simon and garfunkel'));
assert.ok(E.artistKeys('Earth, Wind & Fire').has('earth wind and fire')); assert.ok(!E.artistKeys('Heartless Bastards').has('heart'));
assert.strictEqual(E.songKey('  Hey Jude! ', 'The Beatles'), E.songKey('hey jude', 'the beatles'));
ok('artists match case, accents, "&" and "feat." credits, but not part of another name');

// ---- a named artist or song is a perfect fit for that guest only
const cat = E.makeCatalog([
  trk('r1', 'Rock One', 'Band A', ['rock']), trk('r2', 'Rock Two', 'Band B', ['rock']), trk('r3', 'Rock Three', 'Band C', ['rock']),
  trk('j1', 'Jazz One', 'Miles Test feat. Someone', ['jazz']), trk('j2', 'Jazz Two', 'Other Jazzer', ['jazz']),
]);
const fitsOf = (people) => { const q = E.buildQueue(people, { catalog: cat, n: 5 }).queue; return Object.fromEntries(q.map((x) => [x.track.id, x.fits[0].fit])); };
const plain = fitsOf([person('a', ['rock'])]), named = fitsOf([person('a', ['rock'], { artists: [E.normKey('Miles Test')] })]);
assert.ok(plain.j1 < 0.5); assert.strictEqual(named.j1, 1); assert.ok(named.j2 < 0.5);
ok('naming an artist makes their songs a perfect fit, even from a feat. credit, and nothing else changes');
const songOnly = fitsOf([person('a', ['rock'], { songs: [E.songKey('Jazz Two', 'Other Jazzer')] })]);
assert.strictEqual(songOnly.j2, 1); assert.ok(songOnly.j1 < 0.5); ok('naming a song lifts only that song');
const b = E.buildQueue([person('a', ['rock'], { artists: [E.normKey('Miles Test')] }), person('b', ['rock'])], { catalog: cat, n: 5 }).queue;
assert.strictEqual(b.find((x) => x.track.id === 'j1').fits.find((f) => f.id === 'b').fit < 0.5, true); ok("someone else's fit for that song is unchanged");

// ---- rotation: the namer's turn picks the named song among equals
const big = E.makeCatalog([
  ...[1, 2, 3, 4, 5, 6].map((i) => trk('c' + i, 'Piece ' + i, 'Composer ' + i, ['classical'])),
  ...[1, 2, 3, 4, 5, 6].map((i) => trk('m' + i, 'Riff ' + i, 'Shredder ' + i, ['metal'])),
]);
const turn = (artists, songs) => E.buildQueue([person('a', ['classical'], { artists, songs }), person('b', ['metal'])], { catalog: big, n: 4, served: { a: 0, b: 5 }, seed: 3 });
let r = turn([], [E.songKey('Piece 4', 'Composer 4')]);
assert.strictEqual(r.mode, 'rotate'); assert.strictEqual(r.queue[0].track.id, 'c4'); assert.strictEqual(r.queue[0].owner, 'a'); ok("on the namer's own turn the named song plays first");
r = turn([E.normKey('Composer 5')], []);
assert.strictEqual(r.queue[0].track.id, 'c5'); ok("on the namer's own turn a named artist's song plays first");
const none = turn([], []);
assert.ok(none.queue[0].owner === 'a'); ok('without picks the turn still goes to the same guest, so the pick only chooses among their songs');

// ---- a pick never overrides the room
const rockers = E.makeCatalog([
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => trk('r' + i, 'Rock ' + i, 'Rocker ' + i, ['rock'])),
  trk('k1', 'Twang', 'Cowboy Test', ['country']),
]);
const room = E.buildQueue([person('a', ['rock'], { songs: [E.songKey('Twang', 'Cowboy Test')] }), person('b', ['rock'])], { catalog: rockers, n: 5, seed: 2 });
assert.strictEqual(room.mode, 'blend'); assert.ok(!room.queue.some((x) => x.track.id === 'k1')); ok('in a room that agrees, one guest\'s off-genre song does not push into the queue');

// ---- holiday gating still wins
const xmas = E.makeCatalog([trk('x1', 'Jingle Test', 'Santa Test', ['christmas', 'pop']), ...[1, 2, 3, 4].map((i) => trk('p' + i, 'Pop ' + i, 'Popper ' + i, ['pop']))]);
const xr = E.buildQueue([person('a', ['pop'], { artists: [E.normKey('Santa Test')] })], { catalog: xmas, n: 5 });
assert.ok(!xr.queue.some((x) => x.track.id === 'x1')); ok('naming a holiday artist does not play holiday songs for a room with no holiday fan');
console.log('\n' + n + ' checks passed');
