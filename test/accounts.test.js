'use strict';
// Optional host accounts: keeping a room, "My rooms", reclaiming on another device, and one account counting as one catalogue voter.
// A fake auth provider stands in for Neon Auth: the cookie "neon-auth=<id>" signs that user in.
process.env.DATABASE_URL = 'memory://accounts-test';
process.env.SESSION_SECRET = 'test-secret-for-accounts-0123456789abcdef';
process.env.OWNED_ROOM_DAYS = '30';
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
const as = (id) => ({ cookie: 'neon-auth=' + id });
const fakeAuth = { enabled: true, provider: 'fake', async userFromRequest(r) { const m = /neon-auth=([\w-]+)/.exec(r.headers.cookie || ''); return m ? { id: m[1], email: m[1] + '@x.test', name: m[1] } : null; }, async handle() { return false; } };
const newRoom = async () => { const r = (await req('POST', '/api/rooms')).json; return { code: r.code, H: { 'x-host-key': r.hostKey }, hostKey: r.hostKey }; };

(async () => {
  await new Promise((r) => App.server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + App.server.address().port;
  console.log('Host account tests against ' + base);
  assert.strictEqual(await App.startDb(), true);

  // ---- off by default ----
  assert.strictEqual(App.CLIENT_CONFIG.auth, false);
  assert.strictEqual((await req('GET', '/api/me')).status, 404);
  const r0 = await newRoom();
  assert.strictEqual((await req('POST', `/api/rooms/${r0.code}/host/claim`, {}, { ...r0.H, ...as('ann') })).status, 404);
  ok('without a provider, accounts are simply absent');

  App.setAuthForTest(fakeAuth);
  assert.strictEqual(App.CLIENT_CONFIG.auth, true);
  assert.strictEqual((await req('GET', '/api/me')).json.user, null);
  assert.strictEqual((await req('GET', '/api/me', null, as('ann'))).json.user.id, 'ann');
  assert.strictEqual((await req('GET', '/api/me/rooms')).status, 401);

  // ---- claim ----
  const a = await newRoom();
  const c = (code, H, who, method = 'POST', extra = {}) => req(method, `/api/rooms/${code}/host/claim`, method === 'POST' ? {} : undefined, { ...H, ...(who ? as(who) : {}), ...extra });
  assert.strictEqual((await c(a.code, a.H, null)).status, 401, 'signed-out host cannot claim');
  assert.strictEqual((await c(a.code, { 'x-host-key': 'wrong' }, 'ann')).status, 401, 'a guess at the host key is refused');
  assert.strictEqual((await c(a.code, a.H, 'ann', 'POST', { origin: 'https://evil.example' })).status, 403, 'cross-site claims are refused');
  assert.strictEqual(rooms.get(a.code).ownerUserId, null);
  const claimed = await c(a.code, a.H, 'ann');
  assert.strictEqual(claimed.status, 200); assert.strictEqual(claimed.json.owned, true);
  assert.strictEqual((await c(a.code, a.H, 'ann', 'POST', { origin: base })).status, 200, 'same-origin and idempotent');
  assert.strictEqual((await c(a.code, a.H, 'bob')).status, 409, 'a room belongs to one account');
  assert.strictEqual((await c(a.code, a.H, 'bob', 'DELETE')).status, 409, 'and only its owner can release it');
  ok('claiming needs the host key and a session, and is exclusive');

  // ---- my rooms ----
  const a2 = await newRoom(); await c(a2.code, a2.H, 'ann');
  const bobs = await newRoom(); await c(bobs.code, bobs.H, 'bob');
  const mine = (await req('GET', '/api/me/rooms', null, as('ann'))).json.rooms;
  assert.deepStrictEqual(mine.map((r) => r.code).sort(), [a.code, a2.code].sort());
  assert.ok(mine.every((r) => r.expiresAt > Date.now() + 29 * 86400000), 'kept rooms show their longer life');
  ok('"My rooms" lists only the signed-in account\'s rooms');

  // ---- reclaim ----
  const rc = (code, who, body = {}, extra = {}) => req('POST', `/api/me/rooms/${code}/reclaim`, body, { ...(who ? as(who) : {}), ...extra });
  assert.strictEqual((await rc(a.code, null)).status, 401);
  assert.strictEqual((await rc(a.code, 'bob')).status, 404, 'someone else\'s room looks absent');
  assert.strictEqual((await rc(a.code, 'ann', {}, { origin: 'https://evil.example' })).status, 403);
  const same = (await rc(a.code, 'ann')).json;
  assert.strictEqual(same.hostKey, a.hostKey, 'a plain reclaim returns the existing key');
  assert.strictEqual((await req('GET', `/api/rooms/${a.code}/host/snapshot`, undefined, { 'x-host-key': same.hostKey })).status, 200);
  const rot = (await rc(a.code, 'ann', { rotate: true })).json;
  assert.ok(rot.hostKey && rot.hostKey !== a.hostKey);
  assert.strictEqual((await req('GET', `/api/rooms/${a.code}/host/snapshot`, undefined, a.H)).status, 401, 'the old key stops working');
  assert.strictEqual((await req('GET', `/api/rooms/${a.code}/host/snapshot`, undefined, { 'x-host-key': rot.hostKey })).status, 200);
  assert.strictEqual(await App.flushRooms(), true);
  await App.restartForTest();
  assert.strictEqual(rooms.get(a.code).hostKey, rot.hostKey, 'the new key survives a restart');
  assert.strictEqual(rooms.get(a.code).ownerUserId, 'ann', 'so does ownership');
  assert.strictEqual(rooms.get(a.code).recoveryNeeded, false, 'and the checkpoint was re-encrypted under the new key');
  ok('reclaim returns the key; rotating replaces it durably');

  // ---- longer life for kept rooms ----
  const anon = await newRoom();
  assert.strictEqual(await App.flushRooms(), true);
  const old = Date.now() - 2 * 86400000;
  for (const r of await store.loadRooms(0)) if ([a.code, anon.code].includes(r.code)) await store.upsertRoom({ ...r, touchedAt: old });
  await App.restartForTest();
  assert.ok(rooms.has(a.code), 'a kept room outlives the 24-hour limit');
  assert.ok(!rooms.has(anon.code), 'an anonymous room does not');
  ok('kept rooms live 30 days; anonymous rooms 24 hours');

  // ---- release ----
  assert.strictEqual((await c(a.code, { 'x-host-key': rot.hostKey }, 'ann', 'DELETE')).json.owned, false);
  assert.strictEqual(rooms.get(a.code).ownerUserId, null);
  assert.strictEqual((await req('GET', '/api/me/rooms', null, as('ann'))).json.rooms.some((r) => r.code === a.code), false);
  ok('releasing a room removes it from the account');

  // ---- catalogue: one account is one voter ----
  const v = 'abcDEF12345', key = 'some song|some artist';
  const fb = (room, who) => req('POST', '/api/catalog/feedback', { id: v, ok: true, key }, { 'x-room-code': room.code, 'x-host-key': room.hostKey, ...(who ? as(who) : {}) });
  const lookup = async (room) => (await req('POST', '/api/catalog/get', { searches: [key] }, { 'x-room-code': room.code, 'x-host-key': room.hostKey })).json.searches[key];
  const k1 = await newRoom(), k2 = await newRoom(), k3 = await newRoom();
  for (const r of [k1, k2]) await c(r.code, r.H, 'carol');
  await c(k3.code, k3.H, 'dave');
  await fb(k1); await fb(k2);
  assert.strictEqual(await lookup(k1), undefined, 'two rooms of one account are one voter: no quorum');
  await fb(k3);
  assert.deepStrictEqual(await lookup(k1), [v], 'a second account confirms it');
  ok('catalogue votes count per account, not per room');

  console.log(`\n${passed} account tests passed`);
  App.server.close(); setTimeout(() => process.exit(0), 50).unref();
})().catch((e) => { console.error(e); process.exit(1); });
