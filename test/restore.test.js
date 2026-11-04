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
  assert.strictEqual((await req('POST', `/api/rooms/${code}/host/opts`, { tau: 0.7, doze: 45 }, H)).status, 200);
  const before = await hostState(code, hostKey);
  assert.ok(/^\d+\.[A-Za-z0-9_-]{43}$/.test(before.restoreToken), 'the host view carries a receipt');
  assert.strictEqual(before.name, 'Friday patio');
  const guestView = await req('GET', `/api/rooms/${code}`);
  assert.ok(!JSON.stringify(guestView.json).includes(before.restoreToken), 'guests never see the receipt');
  ok('the host gets a receipt and guests do not');

  // What the host page stores, then a restart that forgets the room.
  const receipt = { hostKey, token: before.restoreToken, name: before.name, discoverable: before.discoverable, opts: before.opts };
  rooms.delete(code);
  assert.strictEqual((await req('GET', `/api/rooms/${code}`)).status, 404);

  assert.strictEqual((await req('POST', `/api/rooms/${code}/restore`, Object.assign({}, receipt, { token: 'nope' }))).status, 403);
  assert.strictEqual((await req('POST', `/api/rooms/${code}/restore`, Object.assign({}, receipt, { hostKey: 'f'.repeat(32) }))).status, 403, 'a receipt does not move to another host key');
  assert.strictEqual((await req('POST', `/api/rooms/${code === 'AAAAA' ? 'BBBBB' : 'AAAAA'}/restore`, receipt)).status, 403, 'a receipt does not move to another code');
  const old = Restore.create(SECRET, 30).issue(code, hostKey, Date.now() - 40 * DAY);
  assert.strictEqual((await req('POST', `/api/rooms/${code}/restore`, Object.assign({}, receipt, { token: old }))).status, 403, 'an expired receipt is refused');
  assert.strictEqual((await req('GET', `/api/rooms/${code}`)).status, 404, 'refused restores create nothing');
  ok('bad, moved and expired receipts are refused');

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
  assert.strictEqual((await req('POST', `/api/rooms/${code}/host/advance`, {}, H)).status, 200, 'the same host key still runs the room');
  ok('a valid receipt brings back the same room, name, settings and host key');

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
