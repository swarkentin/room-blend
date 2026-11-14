'use strict';
// A stand-in auth provider for browser tests only. It is NEVER enabled by AUTH_PROVIDER alone: it also needs ALLOW_FAKE_AUTH=1.
// Accounts live in memory; any password works for a new email and must match afterwards. Mimics the endpoints the host page uses,
// including Google's return trip with a one-time verifier.
const crypto = require('crypto');

function createFakeAuth(log) {
  const users = new Map(), sessions = new Map(), verifiers = new Map(); // email -> {id,email,name,password}; token -> user; verifier -> user
  const cookieOf = (req) => /(?:^|;\s*)neon-auth\.session_token=([\w-]+)/.exec(req.headers.cookie || '');
  const send = (res, status, body, extra) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(extra || {}) }); res.end(JSON.stringify(body)); };
  const readJson = (req) => new Promise((resolve) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(c).toString() || '{}')); } catch { resolve({}); } }); });
  const startSession = (res, user) => { const t = crypto.randomBytes(12).toString('hex'); sessions.set(t, user); return { 'Set-Cookie': `neon-auth.session_token=${t}; Path=/; HttpOnly; SameSite=Lax` }; };
  if (log) log.warn('auth.fake_enabled', { hint: 'ALLOW_FAKE_AUTH=1: a test-only auth provider is active. Never use in production.' });
  return {
    enabled: true, provider: 'fake',
    async userFromRequest(req) { const m = cookieOf(req); const u = m && sessions.get(m[1]); return u ? { id: u.id, email: u.email, name: u.name } : null; },
    async handle(req, res, url) {
      const p = url.pathname.replace(/^\/api\/auth/, '');
      if ((p === '/sign-up/email' || p === '/sign-in/email') && req.method === 'POST') {
        const b = await readJson(req), email = String(b.email || '').toLowerCase();
        if (!/^\S+@\S+$/.test(email) || !b.password) return send(res, 400, { message: 'Enter an email and a password.' }), true;
        let u = users.get(email);
        if (p === '/sign-up/email') { if (u) return send(res, 422, { message: 'That email already has an account.' }), true; u = { id: 'u-' + crypto.randomBytes(5).toString('hex'), email, name: b.name || email.split('@')[0], password: b.password }; users.set(email, u); }
        else if (!u || u.password !== b.password) return send(res, 401, { message: 'Invalid email or password' }), true;
        return send(res, 200, { user: { id: u.id, email: u.email, name: u.name } }, startSession(res, u)), true;
      }
      if (p === '/sign-in/social' && req.method === 'POST') {
        const b = await readJson(req), v = crypto.randomBytes(8).toString('hex');
        let u = users.get('google@example.test'); if (!u) { u = { id: 'u-google', email: 'google@example.test', name: 'Gina Google', password: '' }; users.set(u.email, u); }
        verifiers.set(v, u);
        return send(res, 200, { url: (() => { const back = new URL(String(b.callbackURL || '/'), 'http://x'); back.searchParams.set('neon_auth_session_verifier', v); return back.pathname + back.search; })(), redirect: true }), true;
      }
      if (p === '/get-session' && req.method === 'GET') {
        const v = url.searchParams.get('neon_auth_session_verifier'), vu = v && verifiers.get(v);
        if (vu) { verifiers.delete(v); return send(res, 200, { user: { id: vu.id, email: vu.email, name: vu.name } }, startSession(res, vu)), true; }
        const u = await this.userFromRequest(req);
        return send(res, 200, u ? { user: u } : null), true;
      }
      if (p === '/sign-out' && req.method === 'POST') { const m = cookieOf(req); if (m) sessions.delete(m[1]); return send(res, 200, { success: true }, { 'Set-Cookie': 'neon-auth.session_token=; Path=/; Max-Age=0' }), true; }
      return false;
    },
  };
}
module.exports = { createFakeAuth };
