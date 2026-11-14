'use strict';
// Era picks follow real release years: a song's decade comes from MusicBrainz, never from its genre.
const assert = require('assert');
const { Room } = require('../lib/room.js');
const E = require('../lib/engine.js');
const { createClient } = require('../lib/musicbrainz.js');
let n = 0; const ok = (s) => { n++; console.log('  ok  ' + s); };
const T0 = 1_000_000;
const mk = () => { const r = new Room('ABCDE', 'k', T0); r.opts.settle = 0; return r; };
const song = (title, artist, genres, eras) => Object.assign({ title, artist, genres, id: 'svc:' + title.replace(/\W/g, '') }, eras ? { eras } : {});

assert.deepStrictEqual([1949, 1950, 1959, 1960, 1999, 2000, 2009, 2010, 2019, 2020, 2026].map(E.eraOfYear), ['', '50s', '50s', '60s', '90s', '00s', '00s', '2010s', '2010s', '2020s', '2020s']);
ok('release years map to decades; before 1950 has no era pick');

// A 50s pick plays the songs dated to the 50s, not just any swing.
{
  const r = mk(); const g = r.addGuest('Ana', ['50s'], { immediate: true }, T0); g.connected = true;
  const swing = [];
  for (let i = 0; i < 12; i++) swing.push(song('Fifties ' + i, 'Old Artist ' + i, ['swing'], ['50s']));
  for (let i = 0; i < 12; i++) swing.push(song('Nineties ' + i, 'New Artist ' + i, ['swing'], ['90s']));
  for (let i = 0; i < 12; i++) swing.push(song('Unknown ' + i, 'Mystery ' + i, ['swing']));
  r.addExtras('swing', swing, { pool: true });
  const first = r.queue.slice(0, 5).map((q) => q.track.title);
  assert.ok(first.length && first.every((t) => t.startsWith('Fifties')), 'queue is ' + first.join(', '));
  ok('with an 50s pick the next songs are the ones dated to the 50s, ahead of other decades and undated songs');
  const unk = r.queue.map((q) => q.track.title).filter((t) => t.startsWith('Nineties'));
  assert.strictEqual(unk.length, 0); ok('songs dated to another decade are held back while enough of the picked decade exists');
}

// Dating songs later (tagEras) changes what plays.
{
  const r = mk(); const g = r.addGuest('Bo', ['70s'], { immediate: true }, T0); g.connected = true;
  const all = [];
  for (let i = 0; i < 14; i++) all.push(song('Disco ' + i, 'Band ' + i, ['disco']));
  r.addExtras('disco', all, { pool: true });
  const n1 = r.tagEras(all.slice(0, 7).map((s) => ({ title: s.title, artist: s.artist, eras: ['70s'] })).concat(all.slice(7).map((s) => ({ title: s.title, artist: s.artist, eras: ['00s'] }))));
  assert.strictEqual(n1, 14);
  assert.ok(r.queue.slice(0, 5).every((q) => Number(q.track.title.split(' ')[1]) < 7), r.queue.map((q) => q.track.title).join());
  ok('dating songs afterwards re-plans the queue toward the picked decade');
  assert.strictEqual(r.tagEras([{ title: 'Disco 0', artist: 'Band 0', eras: ['1970s', 'bogus'] }]), 0); ok('made-up decades are ignored');
}

// A named artist's songs that nothing could tag stay untagged, not given the guest's genre.
{
  const r = mk(); const g = r.addGuest('Cy', ['classical'], { immediate: true }, T0); g.connected = true;
  r.addExtras('classical', [song('Sober', 'Tool', [])], { pool: true, artist: 'Tool' });
  const t = r.extra.find((x) => x.artist === 'Tool');
  assert.ok(t && t.genres.length === 0); ok('an artist lookup with no tags leaves the songs untagged instead of using the guest genre');
}

// MusicBrainz year lookup: matching title and artist, earliest, no guessing.
(async () => {
  const mb = createClient({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ recordings: [
    { title: 'Hound Dog', score: 100, 'first-release-date': '1956-07-13', 'artist-credit': [{ name: 'Elvis Presley' }] },
    { title: 'Hound Dog', score: 100, 'first-release-date': '1969-01-01', 'artist-credit': [{ name: 'Elvis Presley' }] },
    { title: 'Hound Dog', score: 100, 'first-release-date': '1953-02-01', 'artist-credit': [{ name: 'Big Mama Thornton' }] },
    { title: 'Hound Dog Blues', score: 100, 'first-release-date': '1940', 'artist-credit': [{ name: 'Elvis Presley' }] },
  ] }) }), intervalMs: 0 });
  if (!mb.lookupSongYear) throw new Error('no lookupSongYear');
  assert.strictEqual(await mb.lookupSongYear('Hound Dog', 'Elvis Presley'), 1956);
  ok('the year is the earliest recording with the same title and credited artist');
  console.log(n + ' checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
