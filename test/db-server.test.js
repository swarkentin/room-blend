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

  // each room is one voter
  const roomB = (await req('POST', '/api/rooms')).json, roomC = (await req('POST', '/api/rooms')).json;
  const asB = { 'x-room-code': roomB.code, 'x-host-key': roomB.hostKey }, asC = { 'x-room-code': roomC.code, 'x-host-key': roomC.hostKey };
  const KEY = 'pride and joy|stevie ray vaughan', good = 'abcDEF12345', other = 'mnOPQR13579';
  const fb = (headers, body) => req('POST', '/api/catalog/feedback', body, headers);

  assert.strictEqual((await fb(auth, { id: good, ok: true, key: KEY })).status, 200);
  assert.strictEqual((await fb(auth, { id: good, ok: true, key: KEY })).status, 200, 'the same room again');
  let got = (await req('POST', '/api/catalog/get', { searches: [KEY], quality: [good] }, auth)).json;
  assert.deepStrictEqual(got.searches, {}, 'one room is not enough to share a lookup');
  assert.deepStrictEqual(got.quality, { [good]: { successes: 1, failures: 0 } }, 'and counts once for quality however often it reports');
  assert.strictEqual((await fb(asB, { id: good, ok: true, key: KEY })).status, 200);
  got = (await req('POST', '/api/catalog/get', { searches: [KEY, 'unknown|song'], quality: [good, 'zzzzzzzzzzz'] }, asC)).json;
  assert.deepStrictEqual(got.searches, { [KEY]: [good] }, 'two different rooms confirm it, and a third room can use it');
  assert.deepStrictEqual(got.quality, { [good]: { successes: 2, failures: 0 } });
  ok('catalogue: a lookup is shared once two different rooms confirmed it');

  // a lone host cannot push a bad video, or bury a good one
  assert.strictEqual((await fb(asC, { id: other, ok: true, key: KEY })).status, 200);
  got = (await req('POST', '/api/catalog/get', { searches: [KEY] }, auth)).json;
  assert.deepStrictEqual(got.searches[KEY], [good], 'a video one room vouches for is not served');
  for (let i = 0; i < 5; i++) await fb(asC, { id: good, ok: false, key: KEY });
  got = (await req('POST', '/api/catalog/get', { quality: [good] }, auth)).json;
  assert.deepStrictEqual(got.quality[good], { successes: 2, failures: 1 }, 'a room that reports failure five times is still one vote');
  assert.deepStrictEqual((await req('POST', '/api/catalog/get', { searches: [KEY] }, auth)).json.searches[KEY], [good], 'one dissenting room does not unseat a video two rooms confirmed');
  ok('catalogue: one host cannot steer results');

  assert.strictEqual((await fb(auth, { id: 'no good', ok: true })).status, 400);
  assert.strictEqual((await fb(auth, { id: good, ok: 'yes' })).status, 400);
  assert.strictEqual((await fb(auth, { ok: true })).status, 400);
  assert.strictEqual((await req('POST', '/api/catalog/get', { searches: Array.from({ length: 500 }, (_, i) => 'k' + i), quality: ['bad id', 5, null] }, auth)).status, 200, 'oversized or junk read requests are bounded, not fatal');
  for (const gone of ['put', 'import', 'candidates', 'genre']) assert.strictEqual((await req(gone === 'candidates' || gone === 'genre' ? 'GET' : 'POST', '/api/catalog/' + gone, gone === 'put' || gone === 'import' ? { pools: [{ key: 'x', songs: [] }] } : undefined, auth)).status, 404, gone + ' is not offered: playlists and song lists stay in the host browser');
  const stats = (await req('GET', '/api/catalog/stats', undefined, auth)).json;
  assert.ok(stats.ratedVideos >= 2 && stats.confirmedLookups >= 1 && stats.playVotes >= 3);
  const huge = await req('POST', '/api/catalog/feedback', { id: good, ok: true, key: 'x'.repeat(100000) }, auth).catch((e) => ({ status: e.code }));
  assert.ok(huge.status === 413 || huge.status === 'ECONNRESET' || huge.status === 200, 'a huge body is refused or its key is cut to a safe length');
  ok('catalogue: bad input refused, playlists and song lists are not shared, stats');

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
  const realPut = store.recordPlay; store.recordPlay = async () => { throw new Error('database is asleep'); };
  assert.strictEqual((await req('POST', '/api/catalog/feedback', { id: 'abcDEF12345', ok: true }, auth)).status, 503, 'catalogue failures are a soft 503');
  store.recordPlay = realPut;
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
