'use strict';
// Room restore: a host's browser brings its room back after the server forgot it (restart, redeploy, free-plan sleep).
const SECRET = 'test-secret-for-restore-0123456789abcdef';
process.env.SESSION_SECRET = SECRET;
const http = require('http');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Restore = require('../lib/restore.js');
const { server, rooms } = require('../server.js');
const { Room } = require('../lib/room.js');

let base, passed = 0;
const ok = (n) => { passed++; console.log('  ok  ' + n); };

function req(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined || body === null ? null : JSON.stringify(body);
    const r = http.request(base + p, { method, headers: Object.assign(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}, headers) }, (res) => {
      const c = []; res.on('data', (d) => c.push(d));
      res.on('end', () => { const t = Buffer.concat(c).toString(); let j = null; try { j = JSON.parse(t); } catch (e) { /* not json */ } resolve({ status: res.statusCode, json: j }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
// The first state a host's event stream sends (what the host page receives right after it connects).
function hostState(code, key) {
  return new Promise((resolve, reject) => {
    const r = http.get(base + '/api/rooms/' + code + '/events?key=' + encodeURIComponent(key), (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { buf += d; const m = /data: (.*)\n\n/.exec(buf); if (m) { r.destroy(); resolve(JSON.parse(m[1])); } });
    });
    r.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
    setTimeout(() => reject(new Error('no host state')), 3000).unref();
  });
}

(async () => {
  // ---------- the signing module ----------
  const R = Restore.create(SECRET, 30), now = Date.now(), DAY = Restore.DAY;
  const t = R.issue('ABCDE', 'k'.repeat(32), now);
  assert.ok(R.verify('ABCDE', 'k'.repeat(32), t, now));
  assert.ok(!R.verify('ABCDF', 'k'.repeat(32), t, now), 'bound to the room code');
  assert.ok(!R.verify('ABCDE', 'j'.repeat(32), t, now), 'bound to the host key');
  assert.ok(!Restore.create('another-secret-another-secret', 30).verify('ABCDE', 'k'.repeat(32), t, now), 'bound to the server secret');
  const [exp, mac] = t.split('.');
  assert.ok(!R.verify('ABCDE', 'k'.repeat(32), exp + '.' + mac.slice(0, -1) + (mac.endsWith('A') ? 'B' : 'A'), now), 'a changed signature fails');
  assert.ok(!R.verify('ABCDE', 'k'.repeat(32), (Number(exp) + 1000) + '.' + mac, now), 'a later expiry cannot be forged');
  for (const bad of [undefined, null, '', 'x', '123', '123.', '.abc', 12345, {}, exp + '.' + mac + 'x']) assert.ok(!R.verify('ABCDE', 'k'.repeat(32), bad, now), 'malformed: ' + JSON.stringify(bad));
  assert.ok(R.verify('ABCDE', 'k'.repeat(32), t, now + 29 * DAY), 'still good within the window');
  assert.ok(!R.verify('ABCDE', 'k'.repeat(32), t, now + 31 * DAY), 'expires after the window');
  assert.strictEqual(R.issue('ABCDE', 'k'.repeat(32), now), R.issue('ABCDE', 'k'.repeat(32), now + 1000), 'one receipt per day');
  assert.ok(R.verify('ABCDE', 'k'.repeat(32), R.issue('ABCDE', 'k'.repeat(32), now + 20 * DAY), now + 45 * DAY), 'a fresh receipt extends the window');
  const sample = { schema: 1, name: 'Private room state', guests: [{ id: 'g12345678', key: 'a'.repeat(32), name: 'Guest' }] };
  const encrypted = R.encryptSnapshot('ABCDE', 'k'.repeat(32), sample);
  assert.ok(!encrypted.includes('Private room state') && !encrypted.includes('a'.repeat(32)), 'snapshot content is opaque');
  assert.deepStrictEqual(R.decryptSnapshot('ABCDE', 'k'.repeat(32), encrypted), sample);
  assert.strictEqual(R.decryptSnapshot('ABCDF', 'k'.repeat(32), encrypted), null, 'ciphertext is bound to the room code');
  assert.strictEqual(R.decryptSnapshot('ABCDE', 'j'.repeat(32), encrypted), null, 'ciphertext is bound to the host key');
  const tamperedParts = encrypted.split('.'); tamperedParts[3] = (tamperedParts[3][0] === 'A' ? 'B' : 'A') + tamperedParts[3].slice(1);
  assert.strictEqual(R.decryptSnapshot('ABCDE', 'k'.repeat(32), tamperedParts.join('.')), null, 'tampering is detected');
  ok('room snapshots are encrypted, authenticated and bound to their room and host');

  const sourceRoom = new Room('ABCDE', 'k'.repeat(32));
  const guest = sourceRoom.addGuest('Restored guest', ['rock'], { immediate: true });
  sourceRoom.vote(guest.id, 'up');
  const restoredRoom = new Room('ABCDE', 'k'.repeat(32));
  assert.ok(restoredRoom.restoreSnapshot(sourceRoom.snapshot()));
  assert.strictEqual(restoredRoom.guests.get(guest.id).key, guest.key);
  assert.strictEqual(restoredRoom.guests.get(guest.id).connected, false, 'presence does not survive a restart');
  assert.strictEqual(restoredRoom.guests.get(guest.id).lostAt > 0, true, 'a reconnect grace period starts');
  assert.strictEqual(restoredRoom.nowItem.track.id, sourceRoom.nowItem.track.id);
  assert.strictEqual(restoredRoom.voteCounts(sourceRoom.nowItem.track.id).up, 1);
  ok('room snapshots restore guest identity, picks, playback, votes and cold presence');

  const discoveryRoom = new Room('ABCDG', 'd'.repeat(32));
  discoveryRoom.addGuest('Discovery guest', ['rock'], { immediate: true });
  discoveryRoom.addExtras('rock', [{ id: 'video-123', title: 'Discovered song', artist: 'Discovery artist', genres: ['rock'] }], { pool: true, source: 'youtube' });
  const discoveryRestored = new Room('ABCDG', 'd'.repeat(32));
  assert.ok(discoveryRestored.restoreSnapshot(discoveryRoom.snapshot()));
  assert.strictEqual(discoveryRestored.poolMode, true);
  assert.ok(discoveryRestored.searched.has('rock'));
  assert.ok(discoveryRestored.extra.some((t) => t.title === 'Discovered song' && t.nid === 'video-123'));
  assert.ok(discoveryRestored.catalog.tracks.some((t) => t.title === 'Discovered song'));
  assert.strictEqual(discoveryRestored.served[discoveryRoom.active()[0].id], discoveryRoom.served[discoveryRoom.active()[0].id]);
  ok('catalogue pools, discovery progress and fairness counters survive recovery');



  const libraryRoom = new Room('ABCDF', 'z'.repeat(32));
  libraryRoom.addGuest('Library guest', ['rock'], { immediate: true });
  const libraryTracks = [{ id: 'song-1', title: 'Library song', artist: 'Artist', genres: ['rock'] }, { id: 'song-2', title: 'Next song', artist: 'Artist', genres: ['rock'] }];
  libraryRoom.setLibrary('local', 'My music files', libraryTracks);
  const playingId = libraryRoom.nowItem.track.id;
  const libraryRestored = new Room('ABCDF', 'z'.repeat(32));
  assert.ok(libraryRestored.restoreSnapshot(libraryRoom.snapshot()));
  assert.strictEqual(libraryRestored.library, null, 'the host-owned 20,000-track library is not copied into the snapshot');
  assert.strictEqual(libraryRestored.libraryNeedsReconnect, true);
  assert.strictEqual(libraryRestored.nowItem.track.id, playingId, 'the current track survives while the provider reconnects');
  libraryRestored.setLibrary('local', 'My music files', libraryTracks, true);
  assert.strictEqual(libraryRestored.nowItem.track.id, playingId, 'reconnecting the same library keeps the current track');
  ok('large host libraries are reloaded by the provider without losing current playback');



  ok('receipts are bound to code, host key and secret, and expire');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-secret-'));
  assert.strictEqual(Restore.resolveSecret({ envSecret: SECRET, dataDir: dir }).source, 'env');
  assert.strictEqual(fs.readdirSync(dir).length, 0, 'an env secret writes nothing');
  const a = Restore.resolveSecret({ envSecret: 'short', dataDir: dir }), b = Restore.resolveSecret({ envSecret: '', dataDir: dir });
  assert.strictEqual(a.source, 'file');
  assert.strictEqual(a.secret, b.secret, 'the file secret is reused on the next start');
  assert.strictEqual(Restore.resolveSecret({ envSecret: '', dataDir: path.join(dir, 'session-secret', 'nope') }).source, 'memory', 'an unwritable folder falls back to memory');
  assert.strictEqual(Restore.resolveSecret({ envSecret: '', dataDir: '' }).source, 'memory');
  fs.rmSync(dir, { recursive: true, force: true });
  ok('the secret comes from the environment, then a file, then memory');

  // ---------- the API ----------
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
  console.log('Restore API tests against ' + base);

  const made = await req('POST', '/api/rooms');
  assert.strictEqual(made.status, 200);
  const { code, hostKey } = made.json;
  const H = { 'x-host-key': hostKey };
  assert.strictEqual((await req('POST', `/api/rooms/${code}/host/room`, { name: 'Friday patio', discoverable: false }, H)).status, 200);
  assert.strictEqual((await req('POST', `/api/rooms/${code}/host/opts`, { tau: 0.7, doze: 45, settle: 0 }, H)).status, 200);
  const joined = await req('POST', `/api/rooms/${code}/guests`, { name: 'Persistent guest', genres: ['rock'] });
  assert.strictEqual(joined.status, 200);
  const guestHeaders = { 'x-guest-id': joined.json.guestId, 'x-guest-key': joined.json.guestKey };
  assert.strictEqual((await req('POST', `/api/rooms/${code}/vote`, { v: 'up' }, guestHeaders)).status, 200);
  assert.strictEqual((await req('GET', `/api/rooms/${code}/host/snapshot`)).status, 401, 'guests cannot fetch room snapshots');
  const checkpoint = await req('GET', `/api/rooms/${code}/host/snapshot`, undefined, H);
  assert.strictEqual(checkpoint.status, 200);
  assert.ok(typeof checkpoint.json.snapshot === 'string');
  assert.ok(!checkpoint.json.snapshot.includes('Persistent guest') && !checkpoint.json.snapshot.includes(joined.json.guestKey), 'the checkpoint contains no readable guest data');
  const before = await hostState(code, hostKey);
  assert.ok(/^\d+\.[A-Za-z0-9_-]{43}$/.test(before.restoreToken), 'the host view carries a receipt');
  assert.strictEqual(before.name, 'Friday patio');
  const guestView = await req('GET', `/api/rooms/${code}`);
  assert.ok(!JSON.stringify(guestView.json).includes(before.restoreToken), 'guests never see the receipt');
  ok('the host gets a receipt and guests do not');

  // What the host page stores, then a restart that forgets the room.
  const receipt = { hostKey, token: before.restoreToken, name: before.name, discoverable: before.discoverable, opts: before.opts, snapshot: checkpoint.json.snapshot };
  rooms.delete(code);
  assert.strictEqual((await req('GET', `/api/rooms/${code}`)).status, 404);

  assert.strictEqual((await req('POST', `/api/rooms/${code}/restore`, Object.assign({}, receipt, { token: 'nope' }))).status, 403);
  assert.strictEqual((await req('POST', `/api/rooms/${code}/restore`, Object.assign({}, receipt, { hostKey: 'f'.repeat(32) }))).status, 403, 'a receipt does not move to another host key');
  assert.strictEqual((await req('POST', `/api/rooms/${code === 'AAAAA' ? 'BBBBB' : 'AAAAA'}/restore`, receipt)).status, 403, 'a receipt does not move to another code');
  const old = Restore.create(SECRET, 30).issue(code, hostKey, Date.now() - 40 * DAY);
  assert.strictEqual((await req('POST', `/api/rooms/${code}/restore`, Object.assign({}, receipt, { token: old }))).status, 403, 'an expired receipt is refused');
  assert.strictEqual((await req('GET', `/api/rooms/${code}`)).status, 404, 'refused restores create nothing');
  ok('bad, moved and expired receipts are refused');

  const badSnapshot = await req('POST', `/api/rooms/${code}/restore`, Object.assign({}, receipt, { snapshot: 'v1.invalid' }));
  assert.strictEqual(badSnapshot.status, 400, 'a damaged encrypted snapshot is refused');
  assert.strictEqual((await req('GET', `/api/rooms/${code}`)).status, 404, 'a damaged snapshot does not create a partial room');

  const back = await req('POST', `/api/rooms/${code}/restore`, receipt);
  assert.strictEqual(back.status, 200);
  assert.strictEqual(back.json.restored, true);
  const room = await req('GET', `/api/rooms/${code}`);
  assert.strictEqual(room.status, 200);
  assert.strictEqual(room.json.name, 'Friday patio');
  const after = await hostState(code, hostKey);
  assert.strictEqual(after.discoverable, false);
  assert.strictEqual(after.opts.tau, 0.7);
  assert.strictEqual(after.opts.doze, 45);
  assert.ok(after.guests.some((g) => g.id === joined.json.guestId && g.name === 'Persistent guest'), 'the guest identity and name are restored');
  const restoredGuest = rooms.get(code).guests.get(joined.json.guestId);
  assert.strictEqual(restoredGuest.key, joined.json.guestKey, 'the guest credential is restored');
  assert.strictEqual(restoredGuest.connected, false, 'restored guests start disconnected');
  assert.strictEqual(rooms.get(code).voteCounts(rooms.get(code).nowItem.track.id).up, 1, 'the current vote is restored');
  assert.strictEqual((await req('PATCH', `/api/rooms/${code}/guests/${joined.json.guestId}`, { sit: true }, guestHeaders)).status, 200, 'the existing guest credential reconnects');
  assert.strictEqual((await req('POST', `/api/rooms/${code}/host/advance`, {}, H)).status, 200, 'the same host key still runs the room');
  ok('an encrypted checkpoint restores guest identities, credentials, picks, votes and the room state');

  // A persistent DATA_DIR can restore the room identity before the host reconnects.
  const diskSkeleton = new Room(code, hostKey);
  diskSkeleton.name = 'Friday patio'; diskSkeleton.recoveryNeeded = true;
  rooms.set(code, diskSkeleton);
  const skeletonView = await hostState(code, hostKey);
  assert.strictEqual(skeletonView.recoveryNeeded, true, 'the host is told that disk-loaded live state needs recovery');
  const diskBack = await req('POST', `/api/rooms/${code}/restore`, receipt);
  assert.strictEqual(diskBack.status, 200);
  assert.strictEqual(diskBack.json.restored, true, 'a valid snapshot hydrates an existing disk-loaded room');
  assert.strictEqual(rooms.get(code).recoveryNeeded, false);
  assert.ok(rooms.get(code).guests.has(joined.json.guestId));
  ok('disk-loaded room identities are hydrated from the host snapshot');

  const again = await req('POST', `/api/rooms/${code}/restore`, receipt);
  assert.strictEqual(again.status, 200);
  assert.strictEqual(again.json.restored, false, 'restoring twice changes nothing');
  assert.strictEqual((await hostState(code, hostKey)).name, 'Friday patio');
  ok('restoring a room that exists is harmless');

  const other = 'g'.repeat(32);
  const stolen = Restore.create(SECRET, 30).issue(code, other);
  assert.strictEqual((await req('POST', `/api/rooms/${code}/restore`, { hostKey: other, token: stolen })).status, 409, 'a code now in use by another host is not taken over');
  assert.strictEqual((await req('POST', `/api/rooms/${code}/host/advance`, {}, { 'x-host-key': other })).status, 401);
  ok('a restore cannot take over a room another host runs');

  // Hostile or junk input never throws or creates rooms.
  const sizeBefore = rooms.size;
  for (const body of [{}, { hostKey: 5, token: 5 }, { hostKey: 'short', token: before.restoreToken }, { hostKey: hostKey, token: before.restoreToken, opts: 'x' }]) {
    const r = await req('POST', `/api/rooms/ZZZZZ/restore`, body);
    assert.ok(r.status === 403 || r.status === 400, 'junk refused: ' + r.status);
  }
  assert.strictEqual(rooms.size, sizeBefore);
  ok('junk input is refused');

  console.log(`restore: ${passed} checks passed`);
  server.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
