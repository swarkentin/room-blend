'use strict';
// Mood logic for the TV view's little guest avatars.
const assert = require('assert');
const A = require('../public/avatars.js');
let n = 0; const ok = (s) => { n++; console.log('  ok  ' + s); };

assert.strictEqual(A.mood({ fit: 0.95 }).key, 'thrilled'); ok('a great fit for the song now playing is thrilled');
assert.strictEqual(A.mood({ fit: 0.6 }).key, 'happy'); ok('a decent fit is happy');
assert.strictEqual(A.mood({ fit: 0.4 }).key, 'meh'); ok('a middling fit is meh');
assert.strictEqual(A.mood({ fit: 0.1 }).key, 'grumpy'); ok('a poor fit is grumpy');
assert.strictEqual(A.mood({}).key, 'waiting'); ok('nothing played yet means waiting');
assert.strictEqual(A.mood({ fit: null, avg: 0, songs: 0 }).key, 'waiting'); ok('an average over no songs is ignored');
assert.strictEqual(A.mood({ fit: null, avg: 0.9, songs: 4 }).key, 'thrilled'); ok('between songs, mood follows how the room has treated them');
// Being served badly over time drags down a guest who happens to like the current song.
assert.strictEqual(A.mood({ fit: 0.8, avg: 0.1, songs: 6 }).key, 'happy'); ok('a long run of poor songs takes the edge off a good one');
assert.strictEqual(A.mood({ fit: 0.8, avg: 0.8, songs: 1 }).score, 0.8); ok('one song of history is not enough to count');
const r = A.mood({ fit: 1, resting: true, restLabel: 'Stepped away' });
assert.deepStrictEqual([r.key, r.label], ['resting', 'Stepped away']); ok('guests sitting out rest, whatever the song');

assert.strictEqual(A.isWeenArtist('Ween'), true); ok('Ween artist credit matches case-insensitively');
assert.strictEqual(A.isWeenArtist('WEEN'), true); ok('uppercase Ween artist credit matches');
assert.strictEqual(A.isWeenArtist('Ween, Gene Ween'), true); ok('Ween matches a multi-artist credit');
assert.strictEqual(A.isWeenArtist('Between the Buried and Me'), false); ok('Ween does not match inside another artist name');
assert.strictEqual(A.isWeenArtist('Queen'), false); ok('similar artist names do not trigger the Ween effect');
console.log(n + ' avatar checks passed');
