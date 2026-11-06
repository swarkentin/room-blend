'use strict';
// Genre map and bridge graph: the classifier, the genre links, and the crossover songs that let two different tastes blend.
// These cases come from an audit of the 62 genres; each one used to be wrong.
const assert = require('assert');
const E = require('../lib/engine.js'), GM = require('../public/genremap.js');
const tracks = require('../lib/catalog.js');
let n = 0; const ok = (s) => { n++; console.log('  ok  ' + s); };

// ---------- classifier ----------
for (const g of E.GENRES) assert.strictEqual(GM.classify(g), g, g + ' should classify as itself');
ok('every canonical genre name classifies as itself');

const named = {
  // an unanchored "k-pop" / "k-rock" matched inside "folk-pop" and "folk-rock"
  'folk-pop': 'folk', 'folk-rock': 'classic rock', 'folk rock': 'classic rock', 'k-pop': 'k-pop', 'kpop': 'k-pop', 'k-pop girl group': 'k-pop', 'korean r&b': 'k-pop',
  // a bare "wave" sent these to electronic
  'permanent wave': 'alternative', 'dark wave': 'new wave', 'cold wave': 'new wave', 'ethereal wave': 'new wave', 'new romantic': 'new wave', 'dance rock': 'new wave',
  // an earlier, broader rule used to win
  'liquid funk': 'drum and bass', 'neurofunk': 'drum and bass', 'dub techno': 'techno', 'dub': 'reggae', 'happy hardcore': 'techno', 'afroswing': 'afrobeats',
  'baroque pop': 'indie', 'industrial rock': 'rock', 'industrial metal': 'metal', 'industrial': 'techno', 'tropical house': 'house', 'tropical': 'latin', 'future funk': 'chillwave',
  // used to return nothing
  'regional mexican': 'latin', 'corridos tumbados': 'latin', 'sad sierreno': 'latin', 'norteno': 'latin', 'bolero': 'latin', 'balada': 'latin', 'timba': 'latin', 'dembow': 'reggaeton',
  'mellow gold': 'classic rock', 'british invasion': 'classic rock', 'jam band': 'classic rock', 'neo mellow': 'singer-songwriter', 'cantautore': 'singer-songwriter',
  'madchester': 'alternative', 'krautrock': 'alternative', 'gabber': 'techno', 'ebm': 'techno', '2-step': 'house', 'eurobeat': 'dance pop', 'pluggnb': 'trap', 'hyphy': 'hip hop',
  // "axé" never matched: \b does not work after an accented letter
  'axé': 'brazilian', 'axe music': 'brazilian', 'ccm': 'gospel', 'stomp and holler': 'folk', 'exotica': 'chillout',
  'cantopop': 'pop', 'mandopop': 'pop', 'schlager': 'pop', 'soukous': 'afrobeats', 'mbalax': 'afrobeats', 'calypso': 'dancehall', 'zouk': 'dancehall', 'chillstep': 'downtempo',
};
for (const [name, want] of Object.entries(named)) assert.strictEqual(GM.classify(name), want, name);
ok('micro-genres that were misrouted or unclassified now map to the right genre (' + Object.keys(named).length + ' cases)');
assert.deepStrictEqual(GM.fromTag('Folk-Rock'), ['classic rock']); assert.deepStrictEqual(GM.fromTag('Alternative Folk-Rock'), ['classic rock']);
assert.deepStrictEqual(GM.fromTag('Folk/Rock'), ['folk', 'rock']); assert.deepStrictEqual(GM.fromTag('K-Pop'), ['k-pop']);
ok('file tags such as "Folk-Rock" are no longer read as K-pop');

// ---------- the bridge graph ----------
const key = (a, b) => [a, b].sort().join('|'), seen = new Set();
for (const [a, b, w] of E.EDGES) {
  assert.ok(E.GENRES.includes(a) && E.GENRES.includes(b), 'edge names a genre that does not exist: ' + a + ', ' + b);
  assert.ok(w > 0 && w <= 1, 'edge weight out of range: ' + a + '-' + b);
  assert.ok(!seen.has(key(a, b)), 'duplicate edge: ' + a + '-' + b); seen.add(key(a, b));
  // The sharpening step zeroes anything under 0.2, and a direct 0.4 only just survives it. An edge that ends at zero does nothing.
  assert.ok(E.sim(a, b) > 0, 'edge has no effect after sharpening, give it at least 0.4: ' + a + '-' + b + ' ' + w);
}
ok('every one of the ' + E.EDGES.length + ' genre links names real genres and still counts after sharpening');

const co = {};
for (const t of tracks) for (let i = 0; i < t.genres.length; i++) for (let j = i + 1; j < t.genres.length; j++) { const k = key(t.genres[i], t.genres[j]); co[k] = (co[k] || 0) + 1; }
const unlinked = Object.entries(co).filter(([k, c]) => c >= 30 && E.sim(...k.split('|')) === 0);
assert.deepStrictEqual(unlinked, [], 'genre pairs that 30 or more songs are tagged with, but the graph treats as unrelated: ' + unlinked.map(([k, c]) => k + ' (' + c + ')').join(', '));
ok('every pair of genres that 30 or more catalogue songs cross has a link in the graph');

for (const [a, b] of [['hyperpop', 'k-pop'], ['hard rock', 'punk'], ['new wave', 'post-rock'], ['ambient', 'chillwave'], ['lo-fi', 'trip hop'], ['swing', 'blues'], ['afrobeats', 'bollywood']]) assert.ok(E.sim(a, b) > 0, a + ' and ' + b);
ok('genres the picker files together are no longer unrelated (hyperpop/k-pop, hard rock/punk, ambient/chillwave, swing/blues ...)');
for (const [a, b] of [['hip hop', 'country'], ['classical', 'metal'], ['k-pop', 'country'], ['edm', 'folk'], ['gospel', 'techno']]) assert.strictEqual(E.sim(a, b), 0, a + ' and ' + b + ' should stay unrelated');
ok('distant genres are still unrelated, so they still take turns');

// ---------- crossover songs ----------
const bridges = require('../lib/songs/zz-bridges.js').bridge;
const byName = new Map(tracks.map((t) => [(t.title + '|' + t.artist).toLowerCase(), t]));
for (const [title, artist, tags] of bridges) {
  const t = byName.get((title + '|' + artist).toLowerCase());
  assert.ok(t, 'bridge song missing from the catalogue: ' + title);
  assert.deepStrictEqual(t.genres, tags.split(','), title);
}
assert.strictEqual(new Set(tracks.map((t) => t.id)).size, tracks.length);
ok('all ' + bridges.length + ' crossover songs are in the catalogue with their bridge tags');

const cat = E.makeCatalog(tracks);
const room = (a, b) => E.buildQueue([{ id: 'a', taste: { [a]: 1 } }, { id: 'b', taste: { [b]: 1 } }], { catalog: cat, n: 3 });
for (const [a, b] of [['rock', 'blues'], ['j-pop', 'k-pop'], ['emo', 'indie'], ['idm', 'techno'], ['idm', 'drum and bass'], ['lo-fi', 'chillwave'], ['blues', 'folk'], ['brazilian', 'latin'], ['brazilian', 'singer-songwriter'], ['bollywood', 'dance pop'], ['post-rock', 'electronic'], ['soundtrack', 'synthwave']]) {
  const r = room(a, b);
  assert.ok(r.bestRoom >= 0.55 && r.mode === 'blend', a + ' + ' + b + ' should blend, got ' + r.mode + ' ' + r.bestRoom.toFixed(2));
}
ok('rooms that pair these genres blend on a song tagged with both');
for (const [a, b] of [['hip hop', 'country'], ['classical', 'metal'], ['k-pop', 'country'], ['gospel', 'techno']]) {
  const r = room(a, b);
  assert.ok(r.bestRoom < 0.55 && r.mode === 'rotate', a + ' + ' + b + ' should rotate, got ' + r.mode + ' ' + r.bestRoom.toFixed(2));
}
ok('rooms that pair distant genres still take turns');

console.log(n + ' checks passed');
