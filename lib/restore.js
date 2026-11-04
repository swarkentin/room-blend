'use strict';
// Room restore receipts.
//
// A restart or redeploy wipes a server's memory, and on a free host its disk too. The host's browser keeps a signed receipt
// plus an encrypted room snapshot in IndexedDB. The server authenticates the receipt and decrypts the snapshot with a key
// derived from SESSION_SECRET, so no database or persistent disk is needed for recovery.
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
  const encryptionKey = crypto.createHmac('sha256', secret).update('room-blend-room-snapshot-v1').digest();
  const aad = (code, hostKey) => Buffer.from('room-snapshot|v1|' + code + '|' + hostKey);
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
    encryptSnapshot(code, hostKey, snapshot) {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
      cipher.setAAD(aad(code, hostKey));
      const body = Buffer.concat([cipher.update(JSON.stringify(snapshot), 'utf8'), cipher.final()]);
      return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
    },
    decryptSnapshot(code, hostKey, envelope) {
      if (typeof envelope !== 'string' || envelope.length > 8 * 1024 * 1024) return null;
      const parts = envelope.split('.');
      if (parts.length !== 4 || parts[0] !== 'v1') return null;
      try {
        const iv = Buffer.from(parts[1], 'base64url'), tag = Buffer.from(parts[2], 'base64url'), body = Buffer.from(parts[3], 'base64url');
        if (iv.length !== 12 || tag.length !== 16 || !body.length) return null;
        const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, iv);
        decipher.setAAD(aad(code, hostKey)); decipher.setAuthTag(tag);
        return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8'));
      } catch { return null; }
    },
  };
}

module.exports = { resolveSecret, create, DAY };
