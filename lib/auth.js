'use strict';
// Who is signed in. Room Blend does not run its own accounts: it asks an auth provider, and everything about rooms and ownership only
// ever sees the small interface below. Accounts are optional and for hosts only. Guests never sign in.
//
//   enabled                 false when no provider is configured. Everything account-related is then switched off.
//   userFromRequest(req)    the signed-in user for this request, { id, email?, name? }, or null. Never throws.
//   handle(req, res, url)   serves /api/auth/* (sign in, sign up, sign out, OAuth callbacks). Returns false when it is not an auth request.
//
// Providers (AUTH_PROVIDER):
//   (unset)   no accounts.
//   neon      Neon Auth (managed Better Auth) on the same Neon project. Set NEON_AUTH_BASE_URL to its Auth URL from the Neon console.
//             The browser talks to /api/auth/* on THIS server, which forwards to Neon Auth. That keeps the session cookie on our own
//             domain, because Neon Auth does not yet support a frontend and backend on different domains. Add this site's address to the
//             project's trusted domains in the Neon console, or Neon Auth will refuse the forwarded requests.
const crypto = require('crypto');

const DISABLED = Object.freeze({ enabled: false, provider: '', async userFromRequest() { return null; }, async handle() { return false; } });
const FORWARD_BODY_LIMIT = 64 * 1024;
const UPSTREAM_TIMEOUT_MS = 8000;
const SESSION_CACHE_MS = 30 * 1000;

/** @param {{ baseUrl: string, publicOrigin?: string, trustProxy?: boolean, fetch?: typeof fetch, log?: any }} cfg */
function createNeonAuth({ baseUrl, publicOrigin, trustProxy, fetch: doFetch = fetch, log }) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const cache = new Map(); // hash of the session cookie -> { at, user }

  // The address the browser sees, which is what Neon Auth must be told is the origin of the request.
  function originOf(req) {
    if (publicOrigin) return publicOrigin;
    const proto = (trustProxy && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()) || (req.socket && req.socket.encrypted ? 'https' : 'http');
    return proto + '://' + (req.headers.host || 'localhost');
  }
  const sessionCookie = (req) => String(req.headers.cookie || '');
  const timeout = () => AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);

  async function userFromRequest(req) {
    const cookie = sessionCookie(req);
    if (!/neon-auth|better-auth/i.test(cookie)) return null; // nothing that looks like a session: do not bother the provider
    const key = crypto.createHash('sha256').update(cookie).digest('hex');
    const hit = cache.get(key), now = Date.now();
    if (hit && now - hit.at < SESSION_CACHE_MS) return hit.user;
    let user = null;
    try {
      const r = await doFetch(base + '/get-session', { headers: { cookie, origin: originOf(req), accept: 'application/json' }, signal: timeout() });
      if (r.ok) {
        /** @type {any} */
        const j = await r.json().catch(() => null);
        if (j && j.user && typeof j.user.id === 'string' && j.user.id) user = { id: j.user.id.slice(0, 80), email: typeof j.user.email === 'string' ? j.user.email.slice(0, 200) : '', name: typeof j.user.name === 'string' ? j.user.name.slice(0, 100) : '' };
      }
    } catch (e) {
      if (log) log.warn('auth.session_check_failed', { message: String(e && e.message).slice(0, 100) });
      return null; // not cached: try again next time
    }
    cache.set(key, { at: now, user });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return user;
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []; let size = 0;
      req.on('data', (c) => { size += c.length; if (size > FORWARD_BODY_LIMIT) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  async function handle(req, res, url) {
    if (!url.pathname.startsWith('/api/auth/')) return false;
    const target = base + url.pathname.slice('/api/auth'.length) + url.search;
    const method = req.method || 'GET';
    const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req);
    const headers = { origin: originOf(req), accept: String(req.headers.accept || 'application/json') };
    for (const h of ['cookie', 'content-type', 'user-agent']) if (req.headers[h]) headers[h] = String(req.headers[h]);
    if (req.headers['x-forwarded-for'] && trustProxy) headers['x-forwarded-for'] = String(req.headers['x-forwarded-for']);
    let up;
    try { up = await doFetch(target, { method, headers, body, redirect: 'manual', signal: timeout() }); }
    catch (e) {
      if (log) log.warn('auth.upstream_failed', { message: String(e && e.message).slice(0, 100) });
      res.writeHead(502, { 'Content-Type': 'application/json' }); res.end('{"error":"Sign-in is unavailable right now."}');
      return true;
    }
    const out = {};
    const type = up.headers.get('content-type'); if (type) out['Content-Type'] = type;
    const loc = up.headers.get('location'); if (loc) out.Location = loc; // an OAuth redirect: the browser follows it, not us
    // A cookie set by the provider must belong to THIS site. Cookies with a Domain attribute would be refused by the browser, so drop it.
    const cookies = (up.headers.getSetCookie ? up.headers.getSetCookie() : []).map((c) => c.replace(/;\s*domain=[^;]*/ig, ''));
    if (cookies.length) out['Set-Cookie'] = cookies;
    out['Cache-Control'] = 'no-store';
    res.writeHead(up.status, out);
    res.end(Buffer.from(await up.arrayBuffer()));
    return true;
  }

  return { enabled: true, provider: 'neon', userFromRequest, handle };
}

/** @param {Record<string, string | undefined>} env */
function createAuth(env = process.env, log) {
  const provider = String(env.AUTH_PROVIDER || '').trim().toLowerCase();
  if (!provider) return DISABLED;
  if (provider === 'neon') {
    const baseUrl = String(env.NEON_AUTH_BASE_URL || '').trim();
    if (!/^https:\/\//i.test(baseUrl)) { if (log) log.error('auth.misconfigured', { hint: 'AUTH_PROVIDER=neon needs NEON_AUTH_BASE_URL (an https:// address from the Neon console). Accounts are off.' }); return DISABLED; }
    return createNeonAuth({ baseUrl, publicOrigin: String(env.PUBLIC_URL || '').replace(/\/+$/, '') || undefined, trustProxy: /^(1|true|yes)$/i.test(env.TRUST_PROXY || ''), log });
  }
  if (provider === 'fake' && String(env.ALLOW_FAKE_AUTH || '') === '1') return require('./auth-fake').createFakeAuth(log); // browser tests only
  if (log) log.error('auth.misconfigured', { hint: 'Unknown AUTH_PROVIDER "' + provider.slice(0, 30) + '". Accounts are off.' });
  return DISABLED;
}

module.exports = { createAuth, createNeonAuth, DISABLED };
