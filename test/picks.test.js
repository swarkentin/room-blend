'use strict';
// Artist and song picks over the API: stored, limited, private to the guest, searchable from the room's own songs.
const http = require('http');
const assert = require('assert');
const { server, musicBrainz } = require('../server.js');
let base, n = 0;
const ok = (s) => { n++; console.log('  ok  ' + s); };
const req = (method, path, body, headers = {}) => new Promise((resolve, reject) => {
  const data = body == null ? null : JSON.stringify(body);
  const r = http.request(base + path, { method, headers: Object.assign(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}, headers) }, (res) => {
    const c = []; res.on('data', (d) => c.push(d));
    res.on('end', () => { const t = Buffer.concat(c).toString(); let j = null; try { j = JSON.parse(t); } catch (e) { /* */ } resolve({ status: res.statusCode, json: j, text: t }); });
  });
  r.on('error', reject); if (data) r.write(data); r.end();
});
const snap = (path, headers) => new Promise((resolve, reject) => {
  const r = http.get(base + path, { headers }, (res) => { let b = ''; res.setEncoding('utf8'); res.on('data', (d) => { b += d; const m = /data: (.*)\n\n/.exec(b); if (m) { r.destroy(); resolve(JSON.parse(m[1])); } }); });
  r.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
});

(async () => {
  musicBrainz.search = async (q) => q.toLowerCase() === 'tool'
    ? {
      artists: [{ name: 'Tool', songs: 0, source: 'musicbrainz' }],
      songs: [{ title: 'Schism', artist: 'Tool', source: 'musicbrainz' }],
      albums: [{ id: '12345678-1234-1234-1234-123456789abc', title: 'Lateralus', artist: 'Tool' }],
    }
    : { artists: [], songs: [], albums: [] };
  musicBrainz.albumTracks = async () => [
    { title: 'The Grudge', artist: 'Tool' },
    { title: 'Eon Blue Apocalypse', artist: 'Tool' },
    { title: 'The Patient', artist: 'Tool' },
    { title: 'Mantra', artist: 'Tool' },
    { title: 'Schism', artist: 'Tool' },
    { title: 'Parabol', artist: 'Tool' },
  ];
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
  const mk = (await req('POST', '/api/rooms')).json, H = { 'x-host-key': mk.hostKey };
  const gH = (g) => ({ 'x-guest-id': g.guestId, 'x-guest-key': g.guestKey });

  // ---- joining with picks
  const a = (await req('POST', `/api/rooms/${mk.code}/guests`, { name: 'Ana', genres: ['rock'], artists: ['Fleetwood Mac', 'fleetwood  mac', '<b>Queen</b>', '', 5, 'A', 'B', 'C', 'D'], songs: [{ title: 'Bohemian Rhapsody', artist: 'Queen' }, { title: 'x' }, 'junk', { title: 'Bohemian Rhapsody!', artist: 'queen' }] })).json;
  const b = (await req('POST', `/api/rooms/${mk.code}/guests`, { name: 'Ben', genres: ['jazz'] })).json;
  assert.ok(a.guestId && b.guestId);
  let va = await snap(`/api/rooms/${mk.code}/events`, gH(a));
  assert.deepStrictEqual(va.me.artists, ['Fleetwood Mac', 'bQueen/b', 'A', 'B', 'C']); // markup characters are stripped, the duplicate and the empty and numeric entries are dropped
  assert.strictEqual(va.me.songs.length, 1); assert.deepStrictEqual(va.me.songs[0], { title: 'Bohemian Rhapsody', artist: 'Queen' });
  ok('picks are stored, capped at 5 artists and 5 songs, cleaned of markup, and duplicates and junk dropped');

  // ---- privacy
  const vb = await snap(`/api/rooms/${mk.code}/events`, gH(b));
  assert.deepStrictEqual(vb.me.artists, []); assert.deepStrictEqual(vb.me.songs, []); assert.ok(!JSON.stringify(vb).includes('Fleetwood'));
  const vh = await snap(`/api/rooms/${mk.code}/events`, H);
  const ha = vh.guests.find((g) => g.id === a.guestId);
  assert.strictEqual(ha.picks, 6); assert.ok(!('artists' in ha) && !('songs' in ha)); assert.ok(!JSON.stringify(vh.guests).includes('Fleetwood'));
  ok("another guest never sees your picks, and the host sees only how many you made");

  // ---- search
  // The join page searches before the guest exists, so the room code is enough. An unknown room is still a 404.
  const open = await req('GET', `/api/rooms/${mk.code}/search?q=queen`); assert.strictEqual(open.status, 200); assert.ok(open.json.artists.some((x) => /queen/i.test(x.name)));
  const nowhere = await req('GET', '/api/rooms/ZZZZZ/search?q=queen'); assert.strictEqual(nowhere.status, 404);
  ok('search works with just the room code (for the join page), and an unknown room is not found');
  const q = (await req('GET', `/api/rooms/${mk.code}/search?q=${encodeURIComponent('miles dav')}`, null, gH(b))).json;
  assert.ok(q.artists.length >= 1 && /davis/i.test(q.artists[0].name) && q.artists[0].songs >= 1);
  const t = (await req('GET', `/api/rooms/${mk.code}/search?q=${encodeURIComponent('so what')}`, null, gH(b))).json;
  assert.ok(t.songs.some((s) => /so what/i.test(s.title)) && t.songs.length <= 8 && t.artists.length <= 8);
  ok("search finds artists and songs in the room's own music, by part of a name, up to 8 each");
  const external = await req('GET', `/api/rooms/${mk.code}/search?q=tool`);
  assert.ok(external.json.artists.some((x) => x.name === 'Tool' && x.source === 'musicbrainz'));
  assert.ok(external.json.songs.some((x) => x.title === 'Schism' && x.source === 'musicbrainz'));
  assert.ok(external.json.albums.some((x) => x.title === 'Lateralus'));
  const album = await req('GET', `/api/rooms/${mk.code}/search/album/12345678-1234-1234-1234-123456789abc`);
  assert.strictEqual(album.status, 200); assert.strictEqual(album.json.songs.length, 5);
  assert.strictEqual((await req('GET', `/api/rooms/${mk.code}/search/album/not-an-id`)).status, 400);
  ok('search also includes MusicBrainz artists, recordings and albums; album selections return tracklists');
  for (const bad of ['', ' ', 'a', '%%%', 'x'.repeat(500)]) { const r = await req('GET', `/api/rooms/${mk.code}/search?q=${encodeURIComponent(bad)}`, null, gH(b)); assert.strictEqual(r.status, 200); assert.ok(r.json.artists.length <= 8); }
  assert.deepStrictEqual((await req('GET', `/api/rooms/${mk.code}/search?q=zzqxjv`, null, gH(b))).json, { artists: [], songs: [], albums: [] });
  ok('empty, too short, junk and very long searches are harmless; no match gives empty lists');

  // ---- editing
  const edit = await req('PATCH', `/api/rooms/${mk.code}/guests/${b.guestId}`, { artists: ['Miles Davis'], songs: [{ title: 'So What', artist: 'Miles Davis' }] }, gH(b));
  assert.strictEqual(edit.status, 200);
  let vb2 = await snap(`/api/rooms/${mk.code}/events`, gH(b));
  assert.deepStrictEqual(vb2.me.artists, ['Miles Davis']); assert.strictEqual(vb2.me.songs.length, 1); assert.deepStrictEqual(vb2.me.genres, ['jazz']);
  await req('PATCH', `/api/rooms/${mk.code}/guests/${b.guestId}`, { name: 'Ben' }, gH(b));
  vb2 = await snap(`/api/rooms/${mk.code}/events`, gH(b)); assert.deepStrictEqual(vb2.me.artists, ['Miles Davis']); ok('picks can be changed later, and changing something else leaves them alone');
  await req('PATCH', `/api/rooms/${mk.code}/guests/${b.guestId}`, { artists: [], songs: [] }, gH(b));
  vb2 = await snap(`/api/rooms/${mk.code}/events`, gH(b)); assert.deepStrictEqual(vb2.me.artists, []); assert.deepStrictEqual(vb2.me.songs, []); ok('picks can be cleared');
  assert.strictEqual((await req('PATCH', `/api/rooms/${mk.code}/guests/${a.guestId}`, { artists: ['X Y'] }, gH(b))).status, 401); ok("you cannot change someone else's picks");

  // ---- a guest can join with only a named artist or song; with nothing at all they are still refused
  assert.strictEqual((await req('POST', `/api/rooms/${mk.code}/guests`, { name: 'Zed' })).status, 400);
  assert.strictEqual((await req('POST', `/api/rooms/${mk.code}/guests`, { name: 'Zed', genres: [], artists: ['', '  '], songs: [{ title: 'x' }] })).status, 400);
  ok('a guest with no genre, artist or song is refused');
  const z = await req('POST', `/api/rooms/${mk.code}/guests`, { name: 'Zed', artists: ['Fleetwood Mac'] }); assert.strictEqual(z.status, 200);
  const vz = await snap(`/api/rooms/${mk.code}/events`, gH(z.json));
  assert.deepStrictEqual(vz.me.genres, []); assert.ok(vz.me.inferred.length >= 1 && vz.me.inferred.length <= 3, 'genres are guessed from the matching songs: ' + vz.me.inferred);
  const vh2 = await snap(`/api/rooms/${mk.code}/events`, H); const hz = vh2.guests.find((g) => g.id === z.json.guestId);
  assert.strictEqual(hz.artistCount, 1); assert.strictEqual(hz.songCount, 0); assert.ok(hz.inferred.length >= 1); assert.ok(!JSON.stringify(vh2.guests).includes('Fleetwood'));
  ok('a guest can join with only an artist: their genres are guessed from the matching songs, and the host sees counts only');
  await req('PATCH', `/api/rooms/${mk.code}/guests/${z.json.guestId}`, { artists: [] }, gH(z.json));
  const vz2 = await snap(`/api/rooms/${mk.code}/events`, gH(z.json)); assert.deepStrictEqual(vz2.me.artists, ['Fleetwood Mac']);
  ok('the last pick of a guest with no genres cannot be removed');
  const zs = await req('POST', `/api/rooms/${mk.code}/guests`, { name: 'Yan', artists: ['Zzyzx Nobody'] }); assert.strictEqual(zs.status, 200);
  ok('an artist the room has never heard of still lets a guest join');

  // ---- the queue uses them
  const solo = (await req('POST', '/api/rooms')).json;
  await req('POST', `/api/rooms/${solo.code}/host/opts`, { settle: 0 }, { 'x-host-key': solo.hostKey });
  const s1 = (await req('POST', `/api/rooms/${solo.code}/guests`, { name: 'Sol', genres: ['classical'], artists: ['Queen'] })).json;
  await new Promise((r) => setTimeout(r, 1500));
  const vs = await snap(`/api/rooms/${solo.code}/events`, gH(s1));
  assert.ok(vs.now && vs.next.length >= 1); const lineup = [vs.now.track, ...vs.next].map((x) => x.artist);
  assert.ok(lineup.includes('Queen'), 'a classical fan who named Queen hears Queen soon: ' + lineup.join(' | ')); ok('a named artist shows up in the lineup even when it is outside the genres picked');
  const st = (await req('GET', '/status')).json; assert.ok(st.counters['picks.artists'] >= 6 && st.counters['picks.searches'] >= 4); assert.ok(!JSON.stringify(st).includes('Fleetwood')); ok('/status counts picks and searches without naming any');
  console.log('\n' + n + ' checks passed');
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e.stack || e.message); process.exit(1); });
