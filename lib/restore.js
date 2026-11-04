'use strict';
// Room restore receipts.
//
// A restart or redeploy wipes a server's memory, and on a free host its disk too. So the host's own browser keeps a signed receipt
// for its room, and hands it back when the server has forgotten the room. The server checks the signature and rebuilds the room with
// the same code and host key. The only thing the server has to remember is one secret (an environment variable, which survives
// restarts and redeploys on every host), so no database and no disk are needed.
//
// A receipt proves "this server issued this host key for this code". It does not let anyone claim a code they were never given,
// and it stops working RESTORE_DAYS after the host last opened the room (the host page gets a fresh one each day it is open).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DAY = 24 * 3600 * 1000;

// Where the signing secret comes from, best first:
//   env     SESSION_SECRET, set on the host (survives everything; use this on Render)
//   file    DATA_DIR/session-secret, made on first start (survives restarts when DATA_DIR is a real disk)
//   memory  a fresh random secret (receipts stop working at the next restart; the server says so in its log)
function resolveSecret({ envSecret, dataDir }) {
  if (typeof envSecret === 'string' && envSecret.trim().length >= 16) return { secret: envSecret.trim(), source: 'env' };
  const file = dataDir ? path.join(dataDir, 'session-secret') : '';
  if (file) {
    try {
      const s = fs.readFileSync(file, 'utf8').trim();
      if (s.length >= 32) return { secret: s, source: 'file' };
    } catch { /* none yet */ }
    const fresh = crypto.randomBytes(32).toString('hex');
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(file, fresh, { mode: 0o600 });
      return { secret: fresh, source: 'file' };
    } catch { return { secret: fresh, source: 'memory' }; }
  }
  return { secret: crypto.randomBytes(32).toString('hex'), source: 'memory' };
}

function create(secret, days = 30) {
  const keep = Math.max(1, Math.floor(Number(days) || 30));
  const mac = (code, hostKey, expDay) => crypto.createHmac('sha256', secret).update(`room-restore|${code}|${hostKey}|${expDay}`).digest('base64url');
  return {
    days: keep,
    // Expiry is counted in whole days, so a receipt only changes once a day and the browser has little to store.
    issue(code, hostKey, at = Date.now()) {
      const expDay = Math.floor(at / DAY) + keep;
      return `${expDay}.${mac(code, hostKey, expDay)}`;
    },
    verify(code, hostKey, token, at = Date.now()) {
      if (typeof token !== 'string' || typeof code !== 'string' || typeof hostKey !== 'string') return false;
      const m = /^(\d{1,7})\.([A-Za-z0-9_-]{43})$/.exec(token);
      if (!m) return false;
      const expDay = Number(m[1]);
      if (expDay < Math.floor(at / DAY)) return false;
      const want = Buffer.from(mac(code, hostKey, expDay)), got = Buffer.from(m[2]);
      return want.length === got.length && crypto.timingSafeEqual(want, got);
    },
  };
}

module.exports = { resolveSecret, create, DAY };
