'use strict';
// Mood logic for the TV view's little guest avatars.
const assert = require('assert');
const A = require('../public/avatars.js');
let n = 0; const ok = (s) => { n++; console.log('  ok  ' + s); };

// Mood is the whole night so far, not the song playing this second.
assert.strictEqual(A.mood({ fit: 0.95 }).key, 'thrilled'); ok('before any song is finished, the song now playing stands in (great fit is thrilled)');
assert.strictEqual(A.mood({ fit: 0.6 }).key, 'happy'); ok('a decent first fit is happy');
assert.strictEqual(A.mood({ fit: 0.4 }).key, 'meh'); ok('a middling first fit is meh');
assert.strictEqual(A.mood({ fit: 0.1 }).key, 'grumpy'); ok('a poor first fit is grumpy');
assert.strictEqual(A.mood({}).key, 'waiting'); ok('nothing played yet means waiting');
assert.strictEqual(A.mood({ fit: null, avg: 0, songs: 0 }).key, 'waiting'); ok('an average over no songs is ignored');
assert.strictEqual(A.mood({ fit: null, avg: 0.9, songs: 4 }).key, 'thrilled'); ok('between songs, mood follows how the room has treated them');
assert.strictEqual(A.mood({ fit: 0.05, avg: 0.9, songs: 6 }).key, 'thrilled'); ok('one song they hate does not make a happy guest grumpy');
assert.strictEqual(A.mood({ fit: 0.95, avg: 0.1, songs: 6 }).key, 'grumpy'); ok('one song they love does not cheer a guest the night has treated badly');
assert.strictEqual(A.mood({ fit: 0.8, avg: 0.8, songs: 1 }).score, 0.8); ok('one finished song is enough to count');
assert.strictEqual(A.mood({ fit: 0.2, avg: 0.8, songs: 3 }).score, 0.8); ok('the current song does not move the score once there is history');
const r = A.mood({ fit: 1, resting: true, restLabel: 'Stepped away' });
assert.deepStrictEqual([r.key, r.label], ['resting', 'Stepped away']); ok('guests sitting out rest, whatever the song');

assert.strictEqual(A.isWeenArtist('Ween'), true); ok('Ween artist credit matches case-insensitively');
assert.strictEqual(A.isWeenArtist('WEEN'), true); ok('uppercase Ween artist credit matches');
assert.strictEqual(A.isWeenArtist('Ween, Gene Ween'), true); ok('Ween matches a multi-artist credit');
assert.strictEqual(A.isWeenArtist('Between the Buried and Me'), false); ok('Ween does not match inside another artist name');
assert.strictEqual(A.isWeenArtist('Queen'), false); ok('similar artist names do not trigger the Ween effect');

// Every guest gets their own look, fixed by their id.
assert.deepStrictEqual(A.outfitFor('guest-1'), A.outfitFor('guest-1')); ok('a guest keeps the same look every time');
const kinds = { hat: new Set(), face: new Set(), neck: new Set(), legs: new Set() };
for (let i = 0; i < 300; i++) { const o = A.outfitFor('g' + i); for (const k in kinds) kinds[k].add(o[k]); }
assert.ok(kinds.hat.size >= 8 && kinds.face.size >= 6 && kinds.neck.size >= 4 && kinds.legs.size >= 4); ok('hats, face pieces, neckwear and trousers all vary across guests');
assert.ok(kinds.hat.has(null) && kinds.face.has(null) && kinds.neck.has(null)); ok('some guests go without, so the room is not uniform');
assert.ok(A.LOOKS.legs.includes('baggy jeans') && A.LOOKS.hats.includes('party hat')); ok('the fun pieces are there (baggy jeans, party hat)');
assert.ok(A.svgFor(A.outfitFor('x')).startsWith('<svg') && !/<script|on\w+=/i.test(A.svgFor(A.outfitFor('x')))); ok('the drawing is plain, script-free SVG');
// Mood over the night.
assert.strictEqual(A.trendSVG([0.5], 100, 22), '', 'one point is not a trend'); ok('a graph needs at least two songs');
assert.ok(/polyline/.test(A.trendSVG([0.2, 0.9, 0.4], 100, 22))); ok('two or more songs draw a line');
assert.ok(!/NaN|undefined/.test(A.trendSVG([0.2, 'x', null, 5, -3], 100, 22))); ok('junk scores are clamped, never NaN');
assert.strictEqual(A.trendDir([0.3, 0.4, 0.6, 0.8]), 'up'); assert.strictEqual(A.trendDir([0.8, 0.7, 0.5, 0.3]), 'down'); assert.strictEqual(A.trendDir([0.5, 0.5, 0.52]), 'steady'); ok('the direction of the night is up, down or steady');
console.log(n + ' avatar checks passed');
