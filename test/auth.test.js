'use strict';
// lib/auth.js against a fake upstream (an injected fetch), so no Neon account is needed.
const http = require('http');
const assert = require('assert');
const { createAuth, createNeonAuth, DISABLED } = require('../lib/auth');

let passed = 0;
const ok = (n) => { passed++; console.log('  ok  ' + n); };
const BASE = 'https://ep-test.neonauth.example.com/neondb/auth';

(async () => {
  console.log('Auth provider tests');
  // ---- configuration ----
  assert.strictEqual(createAuth({}), DISABLED);
  assert.strictEqual(createAuth({ AUTH_PROVIDER: 'neon' }), DISABLED, 'no base URL: off');
  assert.strictEqual(createAuth({ AUTH_PROVIDER: 'neon', NEON_AUTH_BASE_URL: 'http://insecure.example' }), DISABLED, 'http is refused');
  assert.strictEqual(createAuth({ AUTH_PROVIDER: 'nope' }), DISABLED);
  assert.strictEqual(createAuth({ AUTH_PROVIDER: 'neon', NEON_AUTH_BASE_URL: BASE }).enabled, true);
  assert.strictEqual(await DISABLED.userFromRequest({}), null);
  ok('configuration: off unless fully configured');

  // ---- session lookup ----
  const calls = [];
  let sessionReply = () => new Response(JSON.stringify({ user: { id: 'u1', email: 'a@b.c', name: 'Ann' } }), { status: 200 });
  const fake = async (url, init) => { calls.push({ url, init }); return sessionReply(url, init); };
  const a = createNeonAuth({ baseUrl: BASE + '/', publicOrigin: 'https://rb.example.com', fetch: fake });
  const withCookie = { headers: { cookie: '__Secure-neon-auth.session_token=abc', host: 'x' } };
  assert.strictEqual(await a.userFromRequest({ headers: { cookie: 'theme=dark' } }), null);
  assert.strictEqual(calls.length, 0, 'a cookie that is not a session never reaches the provider');
  const u = await a.userFromRequest(withCookie);
  assert.deepStrictEqual(u, { id: 'u1', email: 'a@b.c', name: 'Ann' });
  assert.strictEqual(calls[0].url, BASE + '/get-session');
  assert.strictEqual(calls[0].init.headers.cookie, withCookie.headers.cookie);
  assert.strictEqual(calls[0].init.headers.origin, 'https://rb.example.com');
  await a.userFromRequest(withCookie);
  assert.strictEqual(calls.length, 1, 'answers are cached briefly');
  ok('session lookup forwards the cookie, sets the origin, caches');

  sessionReply = () => { throw new Error('down'); };
  const b = createNeonAuth({ baseUrl: BASE, fetch: fake });
  assert.strictEqual(await b.userFromRequest(withCookie), null, 'provider failure means signed out, never a throw');
  sessionReply = () => new Response('{"user":null}', { status: 200 });
  assert.strictEqual(await b.userFromRequest(withCookie), null, 'failures are not cached');
  sessionReply = () => new Response('nonsense', { status: 200 });
  assert.strictEqual(await createNeonAuth({ baseUrl: BASE, fetch: fake }).userFromRequest(withCookie), null);
  ok('failures and junk answers mean signed out');

  // ---- proxy ----
  let seen;
  const upstream = async (url, init) => {
    seen = { url, init };
    const h = new Headers({ 'content-type': 'application/json', location: 'https://accounts.example/oauth' });
    h.append('set-cookie', '__Secure-neon-auth.session_token=tok; Path=/; Domain=neonauth.example.com; HttpOnly; Secure');
    h.append('set-cookie', 'other=1; Path=/; domain=neonauth.example.com');
    return new Response('{"ok":true}', { status: 302, headers: h });
  };
  const p = createNeonAuth({ baseUrl: BASE, publicOrigin: 'https://rb.example.com', fetch: upstream });
  const srv = http.createServer(async (req, res) => { const handled = await p.handle(req, res, new URL(req.url, 'http://x')); if (!handled) { res.writeHead(404); res.end(); } });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const hit = (path, opts = {}) => new Promise((resolve, reject) => {
    const r = http.request({ port, host: '127.0.0.1', path, ...opts }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ res, text: Buffer.concat(c).toString() })); });
    r.on('error', reject); if (opts.body) r.write(opts.body); r.end();
  });
  const body = JSON.stringify({ email: 'a@b.c', password: 'pw' });
  const out = await hit('/api/auth/sign-in/email?x=1', { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'c=1', 'user-agent': 'ua', 'x-evil': 'no' }, body });
  assert.strictEqual(seen.url, BASE + '/sign-in/email?x=1');
  assert.strictEqual(seen.init.body.toString(), body, 'the body is forwarded');
  assert.strictEqual(seen.init.redirect, 'manual', 'redirects are not followed');
  assert.strictEqual(seen.init.headers.origin, 'https://rb.example.com');
  assert.strictEqual(seen.init.headers.cookie, 'c=1');
  assert.ok(!('x-evil' in seen.init.headers), 'only chosen headers go upstream');
  assert.strictEqual(out.res.statusCode, 302);
  assert.strictEqual(out.res.headers.location, 'https://accounts.example/oauth');
  const sc = out.res.headers['set-cookie'];
  assert.strictEqual(sc.length, 2, 'every Set-Cookie arrives');
  assert.ok(sc.every((c) => !/domain=/i.test(c)) && /HttpOnly/.test(sc[0]), 'Domain is stripped, other attributes kept');
  assert.strictEqual(out.res.headers['cache-control'], 'no-store');
  ok('proxy: forwards, keeps every cookie, strips Domain, leaves redirects to the browser');

  assert.strictEqual((await hit('/other')).res.statusCode, 404, 'only /api/auth/* is proxied');
  const down = createNeonAuth({ baseUrl: BASE, fetch: async () => { throw new Error('boom'); } });
  const srv2 = http.createServer((req, res) => down.handle(req, res, new URL(req.url, 'http://x')));
  await new Promise((r) => srv2.listen(0, '127.0.0.1', r));
  const dn = await new Promise((resolve) => http.get({ port: srv2.address().port, host: '127.0.0.1', path: '/api/auth/get-session' }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }));
  assert.strictEqual(dn, 502);
  ok('an unreachable provider gives a clean 502');

  srv.close(); srv2.close();
  console.log(`\n${passed} auth tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
