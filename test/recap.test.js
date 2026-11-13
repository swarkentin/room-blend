'use strict';
// The play log rows and the recap built from them (lib/recap.js), with stand-in rooms.
const assert = require('assert');
const { roomHash, playRows, mergeRows, recap } = require('../lib/recap');
let passed = 0; const ok = (n) => { passed++; console.log('  ok  ' + n); };

const H = 3600000, t0 = 1_800_000_000_000;
const entry = (i, over = {}) => ({ track: { id: 'id' + i, title: 'Song ' + i, artist: 'Artist ' + (i % 3), genres: i % 2 ? ['rock'] : ['rock', 'blues'] }, mode: 'blend', present: 2 + (i % 4), at: t0 + i * 4 * 60000, ...over });
const room = (history, votes = {}) => ({ history, voteCounts: (id) => ({ up: 0, down: 0, skip: 0, ...(votes[id] || {}) }) });

// hash
assert.strictEqual(roomHash('ABCDE', 5), roomHash('ABCDE', 5));
assert.notStrictEqual(roomHash('ABCDE', 5), roomHash('ABCDE', 6), 'a reused code gets a new log');
assert.ok(/^[0-9a-f]{24}$/.test(roomHash('ABCDE', 5)) && !roomHash('ABCDE', 5).includes('abcde'));
ok('rooms are filed under an opaque hash, not the code');

// rows
const history = Array.from({ length: 10 }, (_, i) => entry(i));
const rows = playRows(room(history, { id9: { up: 3, down: 1, skip: 2 } }), 4);
assert.deepStrictEqual(rows.map((r) => r.trackId), ['id6', 'id7', 'id8', 'id9'], 'the most recent plays, oldest first');
assert.deepStrictEqual({ up: rows[3].up, down: rows[3].down, skips: rows[3].skips, present: rows[3].present }, { up: 3, down: 1, skips: 2, present: 3 });
assert.deepStrictEqual(Object.keys(rows[0]).sort(), ['artist', 'at', 'down', 'genres', 'mode', 'present', 'skips', 'title', 'trackId', 'up'], 'rows hold nothing about guests');
assert.strictEqual(playRows(room([{ track: { id: 'x' }, at: 'bad' }, { nope: 1 }, entry(1, { present: undefined })]), 10).length, 1, 'malformed history entries are skipped');
assert.strictEqual(playRows(room([entry(1, { present: undefined })]))[0].present, 0, 'plays from before the count was kept read as 0');
assert.strictEqual(playRows(room([entry(1, { track: { id: 'i', title: 'x'.repeat(500), artist: 'a', genres: ['rock', 7, null] } })]))[0].title.length, 160);
assert.deepStrictEqual(playRows(room([entry(1, { track: { id: 'i', title: 't', artist: 'a', genres: ['rock', 7, null] } })]))[0].genres, ['rock']);
ok('log rows: recent plays with votes, bounded, no guest data');

// merge
const merged = mergeRows([{ at: 1, up: 0 }, { at: 2, up: 0 }], [{ at: 2, up: 5 }, { at: 3, up: 0 }]);
assert.deepStrictEqual(merged.map((r) => [r.at, r.up]), [[1, 0], [2, 5], [3, 0]], 'live rows win, result is ordered');
ok('stored and live rows merge, live votes win');

// recap
const all = playRows(room(history, { id1: { up: 4 }, id2: { up: 1, down: 3 }, id3: { up: 2, skip: 1 }, id4: { down: 2 } }), 400);
const r = recap(all);
assert.strictEqual(r.songs, 10); assert.strictEqual(r.minutes, 36); assert.strictEqual(r.peakListeners, 5); assert.strictEqual(r.blended, 10); assert.strictEqual(r.requests, 0);
assert.deepStrictEqual(r.genres[0], { genre: 'rock', plays: 10, share: 100 }); assert.deepStrictEqual(r.genres[1], { genre: 'blues', plays: 5, share: 50 });
assert.deepStrictEqual(r.votes, { up: 7, down: 5 }); assert.strictEqual(r.skippedByGuests, 1);
assert.deepStrictEqual(r.topVoted.map((x) => x.title), ['Song 1', 'Song 3'], 'best net votes first');
assert.deepStrictEqual(r.leastLiked.map((x) => x.title), ['Song 4', 'Song 2'], 'worst first');
assert.ok(r.avgListeners > 2 && r.avgListeners < 5);
ok('recap: totals, genre shares, votes, best and least liked');

const empty = recap([]);
assert.deepStrictEqual({ s: empty.songs, f: empty.from, m: empty.minutes, g: empty.genres, tv: empty.topVoted }, { s: 0, f: null, m: 0, g: [], tv: [] });
const recent = recap(all, { since: t0 + 5 * 4 * 60000 });
assert.strictEqual(recent.songs, 5, 'a recent window only counts recent plays');
const withRequests = recap([{ ...all[0], mode: 'request' }, { ...all[1], mode: 'weird' }, all[2]]);
assert.deepStrictEqual([withRequests.requests, withRequests.blended], [1, 1]);
ok('recap: empty rooms, recent windows, requests');

console.log(passed + ' recap checks passed');
