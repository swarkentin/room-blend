'use strict';
// Songs supplied by the host's music service, by genre (Spotify genre search, YouTube playlists).
const assert = require('assert');
const { Room } = require('../lib/room.js');
const E = require('../lib/engine.js');
const P = require('../public/pools.js');
const GM = require('../public/genremap.js');
let n = 0; const ok = (s) => { n++; console.log('  ok  ' + s); };
const T0 = 1_000_000;
const mk = () => { const r = new Room('ABCDE', 'k', T0); r.opts.settle = 0; return r; };
const add = (r, name, genres) => { const g = r.addGuest(name, genres, { immediate: true }, T0); g.connected = true; return g; };
// a fake service result: n songs for a query, tagged as the host would tag them
const songs = (prefix, count, tags, idPrefix = 'svc:') => Array.from({ length: count }, (_, i) => ({ title: prefix + ' Song ' + i, artist: prefix + ' Artist ' + (i % 15), genres: tags, id: idPrefix + prefix.replace(/\W/g, '') + i }));

// ---- compound genre names ----
assert.deepStrictEqual(GM.classifyAll('blues rock'), ['blues', 'rock']);
assert.deepStrictEqual(GM.classifyAll('classic rock'), ['classic rock']);
assert.deepStrictEqual(GM.classifyAll('lo-fi hip hop'), ['lo-fi', 'hip hop']);
assert.deepStrictEqual(GM.classifyAll('country pop'), ['country', 'pop']);
ok('a compound name such as "blues rock" stands for both genres; "classic rock" stays one');
for (const g of E.GENRES) assert.strictEqual(P.tagsFor(P.MAIN[g])[0], g, g + ' main name tags as itself');
ok('every one of the 62 genres has a search name that tags as itself');
assert.ok(P.BRIDGES.every((b) => P.tagsFor(b).length >= 2)); ok('every compound search name names two genres');
for (const [name, want] of [['anime soundtrack', ['soundtrack', 'j-pop']], ['orchestral soundtrack', ['soundtrack', 'classical']], ['bollywood pop', ['bollywood', 'pop']], ['desi hip hop', ['bollywood', 'hip hop']], ['japanese rock', ['j-pop', 'rock']], ['brazilian jazz', ['brazilian', 'jazz']], ['brazilian funk', ['brazilian', 'funk']]]) assert.deepStrictEqual(GM.classifyAll(name), want, name);
assert.strictEqual(P.MAIN.brazilian, 'mpb'); assert.ok(P.queries('soundtrack', 3, ['classical'])[1].q === 'orchestral soundtrack' && P.queries('j-pop', 2).length === 2);
ok('soundtrack, Bollywood, J-pop and Brazilian have compound searches that name two genres, led by a partner genre');
const q = P.queries('blues', 3, ['rock']);
assert.strictEqual(q[0].q, 'blues'); assert.strictEqual(q[1].q, 'blues rock'); assert.ok(q.every((x) => x.tags[0] === 'blues'));
assert.deepStrictEqual(P.queries('christmas').map((x) => x.q), ['christmas']);
ok('a genre is searched by its own name, then compound names; those shared with another guest come first');

// ---- a room whose songs come from the service ----
{
  const r = mk(); const a = add(r, 'Ana', ['rock']), b = add(r, 'Bo', ['blues']);
  const before = r.catalog.tracks.length; assert.ok(before > 4000);
  r.addExtras('rock', songs('Rock', 30, ['rock']), { pool: true });
  r.addExtras('rock', songs('Bridge', 20, ['blues', 'rock']), { pool: true });
  r.addExtras('blues', songs('Blues', 30, ['blues']), { pool: true });
  assert.ok(r.poolMode);
  const nonHoliday = r.catalog.tracks.filter((t) => !t.genres.some((g) => E.HOLIDAYS.includes(g)));
  assert.ok(nonHoliday.every((t) => t.id.startsWith('x')), 'only the service songs are in the catalogue');
  assert.strictEqual(nonHoliday.length, 80); ok('once the service supplies songs the room plays from them alone (80 songs, built-in list set aside apart from holidays)');
  const q0 = r.queue.slice(); // the song already playing when the service answered is left alone
  assert.ok(q0.length >= 4 && q0.every((x) => x.track.nid && x.track.nid.startsWith('svc:'))); ok('every queued song carries the service\'s own id, so playing needs no lookup');
  assert.strictEqual(q0[0].mode, 'blend'); assert.ok(q0[0].track.genres.includes('blues') && q0[0].track.genres.includes('rock')); ok('the first song is a blues rock bridge song both guests share');
  const hv = r.hostView(); assert.ok(hv.queue[0].track.nid && hv.poolMode === true); ok('the host view includes the id; guests never see it');
  assert.ok(!JSON.stringify(r.guestView(a.id)).includes('svc:')); 
}

// ---- aliases must request every genre they represent ----
{
  const r = mk(); add(r, 'Ana', ['phonk', '90s', 'techno', 'metal']);
  assert.deepStrictEqual(r.wantGenres(), ['trap', 'hip hop', 'alternative', 'grunge', 'pop', 'r&b', 'dance pop', 'techno', 'metal']);
  ok('provider requests every canonical genre represented by a guest\'s picks');
}

// ---- thin genres fall back to the built-in list; holidays always keep their famous songs ----
{
  const r = mk(); add(r, 'Ana', ['jazz']); add(r, 'Bo', ['christmas']);
  r.addExtras('jazz', songs('Jazz', 5, ['jazz']), { pool: true });
  assert.ok(r.catalog.tracks.filter((t) => t.id.startsWith('c') && t.genres[0] === 'jazz').length > 25, 'jazz was thin, so built-in jazz is available');
  assert.ok(r.catalog.tracks.some((t) => t.id.startsWith('c') && t.genres[0] === 'christmas')); ok('a thin genre falls back to the built-in songs, and holidays always include them');
  assert.ok(!r.catalog.tracks.some((t) => t.id.startsWith('c') && t.genres[0] === 'ska' )); ok('genres nobody asked about stay out');
  r.addExtras('jazz', songs('More Jazz', 30, ['jazz']), { pool: true });
  assert.ok(!r.catalog.tracks.some((t) => t.id.startsWith('c') && t.genres[0] === 'jazz')); ok('a full pool replaces the built-in songs for that genre');
}

// ---- a service that returns nothing leaves the built-in list in charge ----
{
  const r = mk(); add(r, 'Ana', ['rock']);
  r.addExtras('rock', [], { pool: false });
  assert.ok(!r.poolMode && r.catalog.tracks.length > 4000); ok('an empty search does not switch the room to service songs');
}

// ---- merging, limits, reset ----
{
  const r = mk(); add(r, 'Ana', ['rock']);
  r.addExtras('rock', [{ title: 'Same', artist: 'Band', genres: ['rock'], id: 'svc:1' }], { pool: true });
  r.addExtras('blues', [{ title: 'Same', artist: 'Band', genres: ['blues'], id: 'svc:2' }], { pool: true });
  const s = r.extra.filter((t) => t.title === 'Same'); assert.strictEqual(s.length, 1); assert.deepStrictEqual(s[0].genres, ['rock', 'blues']); assert.strictEqual(s[0].nid, 'svc:1');
  ok('the same song found under two genres becomes one song with both tags');
  r.addExtras('rock', [{ title: 'Bad Id', artist: 'X', genres: ['rock'], id: 'javascript:alert(1)//' }, { title: 'No Genre Known', artist: 'Y', genres: ['polka'], id: 'svc:3' }, { artist: 'no title' }, null], { pool: true });
  assert.ok(!r.extra.find((t) => t.title === 'Bad Id').nid); assert.deepStrictEqual(r.extra.find((t) => t.title === 'No Genre Known').genres, ['rock']);
  ok('unsafe ids are dropped and unknown genres fall back to the genre searched');
  r.clearExtras();
  assert.ok(!r.poolMode && r.extra.length === 0 && r.catalog.tracks.length > 4000); ok('switching to a source that does not supply songs restores the built-in list');
}

// ---- the holiday rule still holds for service songs ----
{
  const r = mk(); add(r, 'Ana', ['pop']);
  r.addExtras('pop', songs('Pop', 30, ['pop']), { pool: true });
  r.addExtras('christmas', songs('Xmas', 30, ['christmas', 'pop']), { pool: true });
  const all = r.queue.slice();
  assert.ok(all.every((x) => !x.track.genres.includes('christmas'))); ok('service songs tagged christmas are held back until someone picks Christmas');
  add(r, 'Bo', ['christmas']); r.tick(T0 + 1000);
  assert.ok(r.queue.some((x) => x.track.genres.includes('christmas'))); ok('and play once a Christmas fan arrives');
}
// ---- artists guests named that the room's songs do not have ----
{
  const r = mk(); const g = add(r, 'Ana', ['rock']);
  r.addExtras('rock', songs('Rock', 30, ['rock']), { pool: true });
  r.updateGuest(g.id, { artists: ['Queen', 'Zed Obscure', 'Rock Artist 3'] });
  const want = r.wantArtists().map((x) => x.name);
  assert.ok(want.includes('Zed Obscure') && want.includes('Queen') && !want.includes('Rock Artist 3')); ok('named artists the room already has are not looked up; the others are');
  assert.deepStrictEqual(r.wantArtists().find((x) => x.name === 'Zed Obscure'), { name: 'Zed Obscure', genre: 'rock' }); ok('a lookup carries the genre of the guest who named the artist');
  r.addExtras('rock', [{ title: 'Z1', artist: 'Zed Obscure', id: 'svc:z1' }, { title: 'Z2', artist: 'Zed Obscure feat. Someone', id: 'svc:z2' }, { title: 'Other', artist: 'Not Zed', id: 'svc:z3' }], { pool: false, artist: 'Zed Obscure' });
  assert.deepStrictEqual(r.extra.filter((t) => /^Z\d|Other/.test(t.title)).map((t) => t.title).sort(), ['Z1', 'Z2']); ok("an artist lookup keeps only that artist's songs");
  assert.ok(!r.wantArtists().some((x) => x.name === 'Zed Obscure')); ok('and the artist is not asked for again');
  assert.ok(r.poolMode);
  assert.ok(r.search('zed obscure').artists.some((a) => a.name === 'Zed Obscure')); ok('the new songs are searchable by guests');
  const q0 = r.queue.map((q) => q.track.id).join();
  r.addExtras('rock', [], { pool: false, artist: 'Queen' });
  assert.strictEqual(r.queue.map((q) => q.track.id).join(), q0); assert.ok(!r.wantArtists().some((x) => x.name === 'Queen')); ok('an artist the service does not have is marked as asked and does not reshuffle the queue');
  assert.ok(r.queue.some((x) => /^Z\d$/.test(x.track.title)), 'a guest who named Zed Obscure hears them: ' + r.queue.map((x) => x.track.title).join()); ok('a guest who named the artist hears their songs in the queue');
  r.clearExtras(); r.addExtras('rock', songs('Rock', 30, ['rock']), { pool: true });
  assert.ok(r.wantArtists().some((x) => x.name === 'Zed Obscure')); ok('switching music source asks again, since the new source has not been searched');
}
{
  const r = mk(); const g = add(r, 'Ana', ['rock']); r.updateGuest(g.id, { artists: ['Zed Obscure'] });
  r.setLibrary('files', 'Mine', [{ id: '1', title: 'T', artist: 'A', genres: ['rock'] }, { id: '2', title: 'U', artist: 'B', genres: ['rock'] }]);
  assert.deepStrictEqual(r.wantArtists(), []); ok("with the host's own complete library no lookups are asked for");
}
console.log('\n' + n + ' checks passed');
