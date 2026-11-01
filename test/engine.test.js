'use strict';
const assert = require('assert');
const E = require('../lib/engine.js');
const tracks = require('../lib/catalog.js');
const catalog = E.makeCatalog(tracks);
let n = 0; const ok = (s) => { n++; console.log('  ok  ' + s); };
const person = (id, genres) => ({ id, taste: Object.fromEntries(genres.map((g, i) => [g, [4, 3, 2, 1][i]])) });
const prim = (q) => q.map((x) => x.track.genres[0]);

assert.ok(tracks.length >= 4500); assert.strictEqual(E.GENRES.length, 56); ok('catalogue has ' + tracks.length + ' tracks, 56 genres');
assert.strictEqual(new Set(E.GENRES).size, 56);
assert.ok(tracks.every((t) => t.genres.length && t.genres.every((g) => E.GENRES.includes(g))), 'every track uses known genres');
assert.strictEqual(new Set(tracks.map((t) => t.id)).size, tracks.length);
ok('every track tag is a known genre; ids are unique');
const per = {}; tracks.forEach((t) => { per[t.genres[0]] = (per[t.genres[0]] || 0) + 1; });
const thin = E.GENRES.filter((g) => (per[g] || 0) < 25);
assert.deepStrictEqual(thin, [], 'genres with fewer than 25 songs: ' + thin);
assert.ok(new Set(tracks.map((t) => (t.title + '|' + t.artist).toLowerCase())).size === tracks.length, 'no duplicate title and artist pairs'); ok('every genre has at least 25 songs as its main tag');
assert.strictEqual(tracks[0].id, 'c0'); assert.strictEqual(tracks[119].title, 'Nocturne Op. 9 No. 2'); ok('original song ids are unchanged');

const solo = (g) => ({ id: g, taste: { [g]: 4 } });
const modeOf = (a, b) => E.buildQueue([solo(a), solo(b)], { catalog, n: 5, seed: 1 }).mode;
for (const [a, b] of [['rock', 'blues'], ['jazz', 'soul'], ['indie', 'folk'], ['house', 'pop'], ['latin', 'reggae'], ['country', 'americana'], ['hip hop', 'r&b'], ['punk', 'pop punk'], ['reggaeton', 'latin'], ['k-pop', 'dance pop'], ['grunge', 'alternative'], ['techno', 'edm'], ['idm', 'ambient'], ['chillout', 'lo-fi'], ['shoegaze', 'indie'], ['neo soul', 'r&b'], ['dubstep', 'edm'], ['synthwave', 'synth pop'], ['downtempo', 'trip hop'], ['amapiano', 'afrobeats'], ['hyperpop', 'dance pop']]) assert.strictEqual(modeOf(a, b), 'blend', a + ' + ' + b + ' should blend');
ok('21 neighbouring genre pairs blend');
for (const [a, b] of [['metal', 'classical'], ['country', 'hip hop'], ['ambient', 'punk'], ['gospel', 'techno'], ['k-pop', 'americana'], ['bossa nova', 'metal'], ['idm', 'country'], ['hyperpop', 'classical'], ['post-rock', 'reggaeton']]) assert.strictEqual(modeOf(a, b), 'rotate', a + ' + ' + b + ' should rotate');
ok('9 distant genre pairs rotate');
let blends = 0, pairs = 0;
for (let i = 0; i < E.GENRES.length; i++) for (let j = i + 1; j < E.GENRES.length; j++) { pairs++; if (modeOf(E.GENRES[i], E.GENRES[j]) === 'blend') blends++; }
assert.ok(blends / pairs > 0.35 && blends / pairs < 0.65, 'blend rate ' + blends / pairs);
ok('about half of all ' + pairs + ' genre pairs blend (' + Math.round(100 * blends / pairs) + '%), the rest take turns');

// Broad picks: "all rock" stands for the whole family and overlaps with its sub-genres.
assert.ok(E.isPick('any:rock') && E.isPick('rock') && !E.isPick('any:nope') && !E.isPick('classical-ish'));
assert.ok(E.GROUPS['any:jazz-and-soul'].includes('gospel'));
const broad = { id: 'b', taste: E.tasteFromPicks(['any:rock']) };
assert.ok(Math.abs(Object.values(broad.taste).reduce((a, b) => a + b, 0) - 4) < 1e-9);
const mixed = E.buildQueue([broad, solo('grunge'), solo('metal')], { catalog, n: 6, seed: 2 });
assert.strictEqual(mixed.mode, 'blend'); ok('an "all rock" guest blends with grunge and metal guests');
const alone = E.buildQueue([broad], { catalog, n: 8, seed: 3 });
assert.ok(new Set(alone.queue.map((x) => x.track.genres[0])).size >= 4); ok('an "all rock" guest hears several rock sub-genres');

let r = E.buildQueue([person('a', ['rock']), person('b', ['blues'])], { catalog, n: 10, seed: 1 });
assert.strictEqual(r.mode, 'blend');
assert.ok(!prim(r.queue).some((g) => ['country', 'hip hop'].includes(g)));
ok('rock + blues blends and avoids country / hip hop');

r = E.buildQueue([person('a', ['metal']), person('b', ['classical'])], { catalog, n: 12, seed: 2 });
assert.strictEqual(r.mode, 'rotate');
const owners = r.queue.filter((x) => x.mode === 'rotate').map((x) => x.owner);
const ca = owners.filter((o) => o === 'a').length, cb = owners.filter((o) => o === 'b').length;
assert.ok(Math.abs(ca - cb) <= 2, `rotation uneven ${ca}/${cb}`);
ok('metal + classical rotates evenly (' + ca + '/' + cb + ')');

r = E.buildQueue([person('a', ['jazz'])], { catalog, n: 8, seed: 3 });
assert.ok(r.queue.length === 8 && new Set(r.queue.map((x) => x.track.id)).size === 8); ok('solo guest gets 8 distinct songs');

const keep = E.buildQueue([person('a', ['rock']), person('b', ['blues'])], { catalog, n: 6, seed: 4 });
const kept = E.buildQueue([person('a', ['rock']), person('b', ['blues'])], { catalog, n: 6, seed: 5, keep: keep.queue.slice(0, 3) });
assert.deepStrictEqual(kept.queue.slice(0, 3).map((x) => x.track.id), keep.queue.slice(0, 3).map((x) => x.track.id)); ok('kept songs stay in place');

const rec = new Set(r.queue.slice(0, 5).map((x) => x.track.id));
const r2 = E.buildQueue([person('a', ['jazz'])], { catalog, n: 5, seed: 3, recentIds: [...rec] });
assert.ok(!r2.queue.some((x) => rec.has(x.track.id))); ok('recently played songs are not repeated');

const a = E.buildQueue([person('a', ['pop']), person('b', ['metal'])], { catalog, n: 6, seed: 9 });
const b = E.buildQueue([person('a', ['pop']), person('b', ['metal'])], { catalog, n: 6, seed: 9 });
assert.deepStrictEqual(a.queue.map((x) => x.track.id), b.queue.map((x) => x.track.id)); ok('same seed gives the same queue');
console.log(n + ' checks passed');
