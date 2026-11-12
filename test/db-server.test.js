'use strict';
// The server with a database behind it (a named in-memory store stands in for Postgres, so no database is needed to run this):
// rooms and their encrypted checkpoints survive a restart, and hosts share one YouTube catalogue.
process.env.DATABASE_URL = 'memory://db-server-test';
process.env.SESSION_SECRET = 'test-secret-for-db-server-0123456789abcdef';
const http = require('http');
const assert = require('assert');
const App = require('../server.js');
const { rooms, store } = App;

let base, passed = 0;
const ok = (n) => { passed++; console.log('  ok  ' + n); };
function req(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined || body === null ? null : JSON.stringify(body);
    const r = http.request(base + p, { method, headers: Object.assign(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}, headers) }, (res) => {
      const c = []; res.on('data', (d) => c.push(d));
      res.on('end', () => { const t = Buffer.concat(c).toString(); let j = null; try { j = JSON.parse(t); } catch (e) { /* not json */ } resolve({ status: res.statusCode, json: j, text: t }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  await new Promise((r) => App.server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + App.server.address().port;
  assert.strictEqual(App.CLIENT_CONFIG.catalog, true, 'browsers are told the shared catalogue exists');
  assert.strictEqual(store.persistent, true);
  assert.strictEqual(await App.startDb(), true);
  console.log('Database-backed server tests against ' + base);

  // ---------- rooms survive a restart, complete ----------
  const made = (await req('POST', '/api/rooms')).json, { code, hostKey } = made, H = { 'x-host-key': hostKey };
  assert.strictEqual((await req('POST', `/api/rooms/${code}/host/room`, { name: 'Friday patio', discoverable: false }, H)).status, 200);
  const joined = (await req('POST', `/api/rooms/${code}/guests`, { name: 'Persistent guest', genres: ['rock', 'blues'] })).json;
  assert.ok(joined.guestId);
  const second = (await req('POST', '/api/rooms')).json; // a room nobody joined
  assert.strictEqual(await App.flushRooms(), true);
  const row = (await store.loadRooms(0)).find((r) => r.code === code);
  assert.ok(row && row.hostKey === hostKey && row.name === 'Friday patio' && row.discoverable === false);
  assert.ok(typeof row.snapshot === 'string' && row.snapshot.startsWith('v1.'), 'a checkpoint was saved');
  assert.ok(!row.snapshot.includes('Persistent guest') && !row.snapshot.includes(joined.guestKey), 'the stored checkpoint is encrypted');
  ok('rooms are saved with an encrypted checkpoint');

  const guestKeyBefore = rooms.get(code).guests.get(joined.guestId).key;
  const playingBefore = rooms.get(code).nowItem && rooms.get(code).nowItem.track.id, queueBefore = rooms.get(code).queue.map((x) => x.track.id);
  await App.restartForTest();
  assert.ok(rooms.has(code) && rooms.has(second.code), 'rooms come back after a restart');
  const back = rooms.get(code);
  assert.strictEqual(back.recoveryNeeded, false, 'no help from the host browser is needed');
  assert.strictEqual(back.name, 'Friday patio');
  assert.strictEqual(back.guests.get(joined.guestId).key, guestKeyBefore, 'guests keep their identity');
  assert.deepStrictEqual(back.guests.get(joined.guestId).genres.slice().sort(), ['blues', 'rock']);
  assert.strictEqual(back.nowItem && back.nowItem.track.id, playingBefore, 'what was playing is still playing');
  assert.deepStrictEqual(back.queue.map((x) => x.track.id), queueBefore, 'the queue is intact');
  const state = await req('GET', `/api/rooms/${code}/events?key=${hostKey}`.replace('/events', '/host/snapshot'), undefined, H);
  assert.strictEqual(state.status, 200, 'the host key still works');
  assert.strictEqual((await req('POST', `/api/rooms/${code}/guests/${joined.guestId}/here`, {}, { 'x-guest-id': joined.guestId, 'x-guest-key': guestKeyBefore })).status, 200, 'the guest key still works');
  ok('a restart restores rooms, guests and playback without the host browser');

  // an unreadable checkpoint (secret changed) falls back to the host's browser instead of losing the room
  await store.saveSnapshot(second.code, 'v1.AAAA.BBBB.CCCC', 9999);
  await App.restartForTest();
  assert.strictEqual(rooms.get(second.code).recoveryNeeded, true);
  assert.strictEqual(rooms.get(second.code).hostKey, second.hostKey);
  ok('an unreadable checkpoint leaves the room waiting for its host browser');

  // expired rooms are not revived, deleted rooms leave the database
  await store.upsertRoom({ code: 'STALE', hostKey: 's'.repeat(16), createdAt: 1, touchedAt: Date.now() - 2 * 86400000, name: '', discoverable: true, netKey: '', opts: {} });
  await App.restartForTest();
  assert.ok(!rooms.has('STALE'));
  rooms.delete(second.code);
  await App.flushRooms();
  assert.ok(!(await store.loadRooms(0)).some((r) => r.code === second.code), 'a removed room is removed from the database');
  ok('expired rooms stay gone; removed rooms leave the database');

  // ---------- the shared catalogue ----------
  const auth = { 'x-room-code': code, 'x-host-key': hostKey };
  assert.strictEqual((await req('POST', '/api/catalog/get', { pools: ['x'] })).status, 403, 'no credentials');
  assert.strictEqual((await req('POST', '/api/catalog/get', { pools: ['x'] }, { 'x-room-code': code, 'x-host-key': 'wrong' })).status, 403, 'wrong host key');
  assert.strictEqual((await req('POST', '/api/catalog/get', { pools: ['x'] }, { 'x-room-code': 'ZZZZZ', 'x-host-key': hostKey })).status, 403, 'unknown room');
  assert.strictEqual((await req('GET', '/api/catalog/stats', undefined, { 'x-room-code': code, 'x-guest-id': joined.guestId, 'x-host-key': joined.guestKey })).status, 403, 'a guest cannot use it');
  ok('only a host can use the shared catalogue');

  const songs = [
    { id: 'abcDEF12345', title: 'Pride and Joy', artist: 'Stevie Ray Vaughan', quality: 2.5 },
    { id: 'bad id!', title: 'Rejected', artist: 'Nobody' },
    { id: 'ghIJKL67890', title: '', artist: 'No title' },
    { id: 'mnOPQR13579', title: 'Crossfire\u0000\n', artist: 'Stevie Ray Vaughan', genres: ['blues', 'not-a-genre', 'rock'], quality: 1e9 },
  ];
  const put = await req('POST', '/api/catalog/put', { pools: [{ key: 'texas blues', songs, tags: ['blues', 'made-up'] }], searches: [{ key: 'pride and joy|stevie ray vaughan', ids: ['abcDEF12345', '!!', 'mnOPQR13579'] }] }, auth);
  assert.strictEqual(put.status, 200);
  assert.deepStrictEqual(put.json, { pools: 1, searches: 1 });
  let got = (await req('POST', '/api/catalog/get', { pools: ['texas blues', 'unknown pool'], searches: ['pride and joy|stevie ray vaughan'], quality: ['abcDEF12345'] }, auth)).json;
  assert.deepStrictEqual(got.pools['texas blues'].map((s) => s.id), ['abcDEF12345', 'mnOPQR13579'], 'junk songs are dropped, order kept');
  assert.ok(!('unknown pool' in got.pools));
  assert.deepStrictEqual(got.searches['pride and joy|stevie ray vaughan'], ['abcDEF12345', 'mnOPQR13579'], 'junk ids are dropped');
  const crossfire = got.pools['texas blues'][1];
  assert.strictEqual(crossfire.title, 'Crossfire', 'control characters are removed');
  assert.ok(crossfire.quality <= 20, 'quality is bounded');
  assert.deepStrictEqual(crossfire.genres.slice().sort(), ['blues', 'rock'], 'only real genres, and the pool tags are added');
  assert.deepStrictEqual(got.pools['texas blues'][0].genres, ['blues'], 'pool tags reach songs without genres');
  ok('catalogue: shared pools and lookups, validated on the way in');

  assert.strictEqual((await req('POST', '/api/catalog/feedback', { id: 'abcDEF12345', ok: true, song: { title: 'Pride and Joy', artist: 'Stevie Ray Vaughan', genres: ['blues'] } }, auth)).status, 200);
  assert.strictEqual((await req('POST', '/api/catalog/feedback', { id: 'abcDEF12345', ok: true }, auth)).status, 200);
  assert.strictEqual((await req('POST', '/api/catalog/feedback', { id: 'abcDEF12345', ok: false }, auth)).status, 200);
  assert.strictEqual((await req('POST', '/api/catalog/feedback', { id: 'no good', ok: true }, auth)).status, 400);
  assert.strictEqual((await req('POST', '/api/catalog/feedback', { id: 'abcDEF12345', ok: 'yes' }, auth)).status, 400);
  got = (await req('POST', '/api/catalog/get', { quality: ['abcDEF12345', 'zzzzzzzzzzz'], pools: ['texas blues'] }, auth)).json;
  assert.deepStrictEqual(got.quality, { abcDEF12345: { successes: 2, failures: 1 } });
  assert.strictEqual(got.pools['texas blues'][0].s, 2, 'a pool read carries the community tally');
  ok('catalogue: playback feedback counts for every host');

  const cand = (await req('GET', '/api/catalog/candidates?title=Pride%20And%20Joy&artist=Stevie%20Ray%20Vaughan', undefined, auth)).json;
  assert.strictEqual(cand.songs[0].id, 'abcDEF12345');
  const genre = (await req('GET', '/api/catalog/genre?g=blues&limit=5', undefined, auth)).json;
  assert.ok(genre.songs.length >= 1 && genre.songs.every((s) => s.genres.includes('blues')));
  assert.deepStrictEqual((await req('GET', '/api/catalog/genre?g=not-a-genre', undefined, auth)).json.songs, []);
  const stats = (await req('GET', '/api/catalog/stats', undefined, auth)).json;
  assert.ok(stats.songs >= 2 && stats.pools >= 1 && stats.playbackSuccesses >= 2);
  assert.strictEqual((await req('GET', '/api/catalog/nothing', undefined, auth)).status, 404);
  ok('catalogue: candidate search, genre samples and stats');

  const big = { pools: Array.from({ length: 200 }, (_, i) => ({ key: 'p' + i, songs: [{ id: 'imp' + String(i).padStart(5, '0'), title: 'T', artist: 'A', genres: ['rock'] }] })), quality: [{ id: 'abcDEF12345', successes: 9999, failures: 0 }] };
  const imp = (await req('POST', '/api/catalog/import', big, auth)).json;
  assert.strictEqual(imp.pools, 60, 'an import is capped');
  assert.strictEqual((await req('POST', '/api/catalog/get', { quality: ['abcDEF12345'] }, auth)).json.quality.abcDEF12345.successes, 2 + 50, 'one browser cannot swamp the play record');
  assert.strictEqual((await req('POST', '/api/catalog/put', { pools: [] }, auth)).status, 200);
  const huge = await req('POST', '/api/catalog/put', { pools: [{ key: 'x', songs: [{ id: 'abcDEF12345', title: 'x'.repeat(600000), artist: 'a' }] }] }, auth).catch((e) => ({ status: e.code }));
  assert.ok(huge.status === 413 || huge.status === 'ECONNRESET', 'oversized bodies are refused (the server may hang up mid-upload)');
  ok('catalogue: imports are capped, oversized requests refused');

  // ---------- artist genres are looked up once, for everyone ----------
  let lookups = 0;
  App.musicBrainz.lookupArtist = async () => { lookups++; return [{ genre: 'metal', count: 9 }, { genre: 'rock', count: 4 }]; };
  const a1 = await req('GET', '/api/musicbrainz/artist-genres?artist=Tool');
  const a2 = await req('GET', '/api/musicbrainz/artist-genres?artist=TOOL');
  assert.deepStrictEqual(a1.json.genres, [{ genre: 'metal', count: 9 }, { genre: 'rock', count: 4 }]);
  await new Promise((r) => setTimeout(r, 50));
  const a3 = await req('GET', '/api/musicbrainz/artist-genres?artist=tool');
  assert.deepStrictEqual(a3.json.genres, a1.json.genres, 'the stored answer has the same shape');
  assert.ok(lookups <= 2 && lookups >= 1 && (await req('GET', '/api/musicbrainz/artist-genres?artist=tool')).status === 200);
  const before = lookups; await req('GET', '/api/musicbrainz/artist-genres?artist=Tool'); assert.strictEqual(lookups, before, 'a known artist is not looked up again');
  assert.ok(a2.status === 200);
  ok('artist genres are fetched once and then served from storage');

  // ---------- storage trouble never takes rooms down ----------
  const realPut = store.putPool; store.putPool = async () => { throw new Error('database is asleep'); };
  assert.strictEqual((await req('POST', '/api/catalog/put', { pools: [{ key: 'x', songs }] }, auth)).status, 503, 'catalogue failures are a soft 503');
  store.putPool = realPut;
  const realUpsert = store.upsertRoom; store.upsertRoom = async () => { throw new Error('database is asleep'); };
  const third = await req('POST', '/api/rooms');
  assert.strictEqual(third.status, 200, 'rooms can still be made');
  assert.strictEqual(await App.flushRooms(), false, 'the flush reports failure and leaves the room alone');
  assert.ok(rooms.has(third.json.code));
  store.upsertRoom = realUpsert;
  assert.strictEqual(await App.flushRooms(), true, 'and catches up when the database is back');
  assert.ok((await store.loadRooms(0)).some((r) => r.code === third.json.code));
  ok('a failing database degrades the catalogue, never the rooms');

  console.log(passed + ' database-server checks passed');
  App.server.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
