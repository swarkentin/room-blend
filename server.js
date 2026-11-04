'use strict';
// Room Blend server. No dependencies: Node 22+ only.
//   PORT                 default 3000
//   SPOTIFY_CLIENT_ID    from your Spotify developer app (public value, PKCE needs no secret)
//   PUBLIC_URL           optional. Address friends should open, e.g. https://roomblend.example.com.
//                        Default: whatever address the host's browser used.
//   TRUST_PROXY          set to 1 when running behind a proxy/platform (Render, Fly, Cloudflare...) so
//                        per-visitor limits use the real client IP
//   MAX_ROOMS            total rooms kept at once (default 2000)
//   ROOMS_PER_IP_HOUR    new rooms one visitor may start per hour (default 8)
//   DATA_DIR             where room identities are kept across restarts (default ./data)
//   SESSION_SECRET       signs the receipts a host's browser uses to restore its room after a restart (set it on Render)
//   RESTORE_DAYS         how long after the host last opened a room it can still be restored (default 30)
//   MUSICBRAINZ_SEARCH_DISABLED=1 to keep artist/song searches local (offline or test use)
//   LOG_LEVEL            debug, info (default), warn, error or silent. JSON lines; info to stdout, warn and error to stderr
//   STATUS_KEY           secret for GET /status?key=... (counts, timings, memory). Without it /status answers only on this machine
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Engine = require('./lib/engine');
const { Room, rid } = require('./lib/room');
const L = require('./lib/log');
const { createClient } = require('./lib/musicbrainz');
const Restore = require('./lib/restore');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const TRUST_PROXY = /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || '');
const ROOMS_PER_IP_HOUR = Number(process.env.ROOMS_PER_IP_HOUR || 8);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const ROOM_TTL_MS = 24 * 3600 * 1000;
const MAX_ROOMS = Number(process.env.MAX_ROOMS || 2000);

const CLIENT_CONFIG = {
  clientId: process.env.SPOTIFY_CLIENT_ID || '',
  publicUrl: PUBLIC_URL, // empty = use the address in the browser
  apiBase: process.env.SPOTIFY_API_BASE || 'https://api.spotify.com/v1',
  accountsBase: process.env.SPOTIFY_ACCOUNTS_BASE || 'https://accounts.spotify.com',
  sdkUrl: process.env.SPOTIFY_SDK_URL || 'https://sdk.scdn.co/spotify-player.js',
  ytApiBase: process.env.YOUTUBE_API_BASE || 'https://www.googleapis.com/youtube/v3',
  ytIframeUrl: process.env.YOUTUBE_IFRAME_URL || 'https://www.youtube.com/iframe_api',
  // Override the browser-side YouTube request spacing in tests; production defaults to 2 seconds.
  ytApiIntervalMs: Number.isFinite(Number(process.env.YOUTUBE_API_INTERVAL_MS)) && process.env.YOUTUBE_API_INTERVAL_MS !== '' && Number(process.env.YOUTUBE_API_INTERVAL_MS) >= 0 ? Number(process.env.YOUTUBE_API_INTERVAL_MS) : 2000,
  genres: Engine.GENRES,
  genreGroups: Engine.GENRE_GROUPS,
  genreAliases: Engine.GENRE_ALIASES,
  genreAliasGroups: Engine.GENRE_ALIAS_GROUPS,
  genreSynonyms: Engine.GENRE_SYNONYMS,
  genreLegacy: Engine.LEGACY_GROUPS,
  beatMs: Number(process.env.BEAT_MS) || 60000,
};

// Restore receipts (see lib/restore.js): lets a host's browser bring its room back after a restart or redeploy wipes the server.
let restorer = null;
function getRestorer() {
  if (!restorer) {
    const { secret, source } = Restore.resolveSecret({ envSecret: process.env.SESSION_SECRET, dataDir: DATA_DIR });
    restorer = Restore.create(secret, Number(process.env.RESTORE_DAYS || 30));
    if (source === 'memory') L.warn('restore.secret_ephemeral', { hint: 'Set SESSION_SECRET (or use a persistent DATA_DIR) so hosts can restore rooms after a restart' });
    else L.info('restore.ready', { secret: source, days: restorer.days });
  }
  return restorer;
}
const hostViewOf = (room) => Object.assign(room.hostView(), { restoreToken: getRestorer().issue(room.code, room.hostKey) });

const rooms = new Map();
const subs = new Map(); // code -> Set of {res, role, guestId}
const musicBrainz = createClient();
const artistLookups = new Set();
let saveTimer = null;

// ---------- persistence: only room identities, so a restart keeps codes and host keys ----------
function loadRooms() {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'rooms.json'), 'utf8'));
    for (const r of d.rooms || []) {
      if (Date.now() - r.touchedAt > ROOM_TTL_MS) continue;
      const room = new Room(r.code, r.hostKey, r.createdAt);
      room.touchedAt = r.touchedAt;
      room.name = r.name || ''; room.discoverable = r.discoverable !== false; room.netKey = r.netKey || '';
      if (r.opts) Object.assign(room.opts, r.opts);
      rooms.set(room.code, room);
    }
  } catch { /* first run */ }
}
function writeRooms() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const out = { rooms: [...rooms.values()].map((r) => ({ code: r.code, hostKey: r.hostKey, createdAt: r.createdAt, touchedAt: r.touchedAt, opts: r.opts, name: r.name, discoverable: r.discoverable, netKey: r.netKey })) };
    fs.writeFileSync(path.join(DATA_DIR, 'rooms.json.tmp'), JSON.stringify(out));
    fs.renameSync(path.join(DATA_DIR, 'rooms.json.tmp'), path.join(DATA_DIR, 'rooms.json'));
    return true;
  } catch (e) { L.count('errors.save'); L.error('save.failed', { message: e.message }); return false; }
}
function saveRooms() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeRooms, 500);
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  for (let i = 0; i < 50; i++) {
    let c = '';
    for (let k = 0; k < 5; k++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
  throw new Error('no free code');
}

// ---------- helpers ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const origin = (u) => { try { return new URL(u).origin; } catch { return ''; } };
const API_O = origin(CLIENT_CONFIG.apiBase), ACC_O = origin(CLIENT_CONFIG.accountsBase), SDK_O = origin(CLIENT_CONFIG.sdkUrl), YT_O = origin(CLIENT_CONFIG.ytIframeUrl);
const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': [
    "default-src 'self'",
    `script-src 'self' ${SDK_O} ${YT_O}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data: https://i.scdn.co",
    `connect-src 'self' ${API_O} ${ACC_O} https: http:`, // https/http: hosts may connect their own music server
    `frame-src ${SDK_O} ${YT_O} https://www.youtube-nocookie.com`,
    "media-src 'self' blob: data: https: http:",
  ].join('; '),
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY });
  res.end(body);
}
function readBody(req, limit = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Object.assign(new Error('bad json'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function clientIp(req) {
  if (TRUST_PROXY) {
    const xf = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (xf.length) return xf[xf.length - 1]; // the entry added by our own proxy
  }
  return req.socket.remoteAddress || '?';
}

// Rooms started from the same network (same Wi-Fi, same public address) can find each other.
function netKeyOf(ip) {
  ip = String(ip || '').replace(/^::ffff:/, '');
  // Everything on one private network (home or office LAN, or this machine) is "the same Wi-Fi".
  // Phones on a LAN each have their own 192.168.x.x address and share no public one, so match them as a group.
  if (/^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) || ip === '::1' || /^(fe80|fc|fd)/i.test(ip)) return 'lan';
  if (ip.includes(':')) { const parts = ip.split(':'); return 'v6:' + parts.slice(0, 4).join(':'); } // /64
  return 'v4:' + ip;
}
const escHtml = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// New-room limit per IP
const made = new Map();
function roomLimited(ip) {
  const now = Date.now(), list = (made.get(ip) || []).filter((t) => now - t < 3600000);
  if (list.length >= ROOMS_PER_IP_HOUR) { made.set(ip, list); return true; }
  list.push(now); made.set(ip, list); return false;
}
setInterval(() => { const cut = Date.now() - 3600000; for (const [k, l] of made) if (!l.some((t) => t > cut)) made.delete(k); }, 600000).unref();

// Token bucket per IP: 60 requests burst, 20 per second refill.
const buckets = new Map();
function limited(ip) {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b) { b = { tokens: 60, at: now }; buckets.set(ip, b); }
  b.tokens = Math.min(60, b.tokens + ((now - b.at) / 1000) * 20); b.at = now;
  if (b.tokens < 1) return true;
  b.tokens -= 1; return false;
}
setInterval(() => { const cut = Date.now() - 600000; for (const [k, b] of buckets) if (b.at < cut) buckets.delete(k); }, 60000).unref();

// ---------- live updates (Server-Sent Events) ----------
const pending = new Set();
let notifyTimer = null;
function notify(code) {
  pending.add(code);
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => { notifyTimer = null; const codes = [...pending]; pending.clear(); codes.forEach(push); }, 60);
}

function enrichGuestGenres(code, room, guest) {
  const key = `${code}:${guest.id}`;
  if (artistLookups.has(key) || !guest.lookupGenres || guest.genres.length) return;
  artistLookups.add(key);
  const task = (async () => {
    while (rooms.get(code) === room && room.guests.get(guest.id) === guest && guest.lookupGenres && !guest.genres.length) {
      const artists = [...new Set([...guest.artists, ...guest.songs.map((song) => song.artist)].map((name) => String(name).trim()).filter(Boolean))].slice(0, 5);
      if (!artists.length) return;
      const signature = artists.map(Engine.normKey).join('|');
      guest.genreLookupStatus = 'pending';
      notify(code);
      const found = {};
      let failed = false;
      for (const artist of artists) {
        if (!guest.lookupGenres || guest.genres.length) break;
        try {
          found[Engine.normKey(artist)] = await musicBrainz.lookupArtist(artist);
        } catch (e) {
          failed = true;
          L.warn('musicbrainz.lookup_failed', { message: String(e && e.message || e).slice(0, 100) });
        }
      }
      const current = [...new Set([...guest.artists, ...guest.songs.map((song) => song.artist)].map((name) => String(name).trim()).filter(Boolean))].slice(0, 5);
      const currentSignature = current.map(Engine.normKey).join('|');
      if (currentSignature !== signature) continue;
      if (rooms.get(code) !== room || room.guests.get(guest.id) !== guest || !guest.lookupGenres || guest.genres.length) return;
      guest.artistGenres = found;
      const hasTags = Object.values(found).some((tags) => tags.length);
      guest.genreLookupStatus = failed ? (hasTags ? 'partial' : 'unavailable') : hasTags ? 'ready' : 'no-match';
      room.rebuild(null, false);
      notify(code);
      return;
    }
  })().catch((e) => {
    guest.genreLookupStatus = 'unavailable';
    L.warn('musicbrainz.lookup_failed', { message: String(e && e.message || e).slice(0, 100) });
    if (rooms.get(code) === room && room.guests.get(guest.id) === guest) notify(code);
  }).finally(() => artistLookups.delete(key));
  return task;
}
function push(code) {
  const room = rooms.get(code), set = subs.get(code);
  if (!room || !set) return;
  for (const s of set) {
    const view = s.role === 'host' ? hostViewOf(room) : s.role === 'screen' ? room.screenView() : room.guestView(s.guestId);
    s.res.write(`data: ${JSON.stringify(view)}\n\n`);
  }
}

// ---------- API ----------
async function api(req, res, url) {
  const ip = clientIp(req);
  if (limited(ip)) { L.count('limits.requests'); L.warn('rate.limited', { kind: 'requests', visitor: L.visitorTag(ip) }); return sendJson(res, 429, { error: 'slow down' }); }
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // after "api"
  const m = req.method;

  if (parts[0] === 'rooms' && parts.length === 1 && m === 'POST') {
    if (rooms.size >= MAX_ROOMS) { L.count('limits.full'); L.warn('limit.rooms_full', { rooms: rooms.size, max: MAX_ROOMS }); return sendJson(res, 503, { error: 'The service is full right now. Try again later.' }); }
    if (roomLimited(ip)) { L.count('limits.new_rooms'); L.warn('rate.limited', { kind: 'new_rooms', visitor: L.visitorTag(ip) }); return sendJson(res, 429, { error: 'You have started a lot of rooms. Try again in a while.' }); }
    const code = newCode(), hostKey = rid(16);
    const nr = new Room(code, hostKey);
    nr.netKey = netKeyOf(ip);
    rooms.set(code, nr);
    saveRooms();
    L.count('rooms.created');
    L.info('room.created', { room: L.roomTag(code), rooms: rooms.size });
    return sendJson(res, 200, { code, hostKey });
  }

  if (parts[0] === 'nearby' && m === 'GET') {
    const key = netKeyOf(ip), out = [];
    for (const r of rooms.values()) {
      if (r.netKey !== key || !r.discoverable) continue;
      if (![...(subs.get(r.code) || [])].some((x) => x.role === 'host')) continue; // only rooms whose host is here now
      out.push({ code: r.code, name: r.name, people: r.active().length });
    }
    return sendJson(res, 200, { rooms: out.slice(0, 5) });
  }
  const code = (parts[1] || '').toUpperCase();

  // POST /api/rooms/:code/restore  -> a host's browser brings back a room the server forgot (restart, redeploy, sleep).
  // The signed receipt proves this server issued that host key for that code, so nobody can claim a code they were never given.
  if (parts[0] === 'rooms' && parts[2] === 'restore' && parts.length === 3 && m === 'POST') {
    const body = await readBody(req, 9 * 1024 * 1024);
    const hostKey = typeof body.hostKey === 'string' ? body.hostKey : '';
    if (!/^[A-HJ-NP-Z2-9]{5}$/.test(code) || !/^[A-Za-z0-9_-]{16,64}$/.test(hostKey) || !getRestorer().verify(code, hostKey, body.token)) {
      L.count('rooms.restore_refused');
      return sendJson(res, 403, { error: 'This room cannot be restored.' });
    }
    const existing = rooms.get(code);
    if (existing) {
      if (safeEq(existing.hostKey, hostKey)) return sendJson(res, 200, { ok: true, restored: false });
      return sendJson(res, 409, { error: 'That room code is in use.' });
    }
    if (rooms.size >= MAX_ROOMS) { L.count('limits.full'); return sendJson(res, 503, { error: 'The service is full right now. Try again later.' }); }
    const nr = new Room(code, hostKey);
    nr.netKey = netKeyOf(ip);
    if (body.snapshot !== undefined) {
      const snapshot = getRestorer().decryptSnapshot(code, hostKey, body.snapshot);
      if (!snapshot || !nr.restoreSnapshot(snapshot)) {
        L.count('rooms.restore_snapshot_refused');
        return sendJson(res, 400, { error: 'The saved room state is invalid or could not be decrypted.' });
      }
    } else {
      nr.setInfo({ name: body.name, discoverable: body.discoverable });
      if (body.opts && typeof body.opts === 'object') nr.setOpts(body.opts);
    }
    rooms.set(code, nr);
    saveRooms();
    L.count('rooms.restored');
    L.info('room.restored', { room: L.roomTag(code), rooms: rooms.size });
    return sendJson(res, 200, { ok: true, restored: true });
  }

  const room = rooms.get(code);
  if (parts[0] !== 'rooms' || !room) return sendJson(res, 404, { error: 'room not found' });
  room.touchedAt = Date.now();
  const isHost = () => safeEq(req.headers['x-host-key'] || url.searchParams.get('key') || '', room.hostKey);
  const guestFor = () => {
    const id = req.headers['x-guest-id'] || url.searchParams.get('gid') || '';
    const key = req.headers['x-guest-key'] || url.searchParams.get('gkey') || '';
    const g = room.guests.get(id);
    return g && safeEq(key, g.key) ? g : null;
  };

  // GET /api/rooms/:code  -> does it exist (for the join page)
  if (parts.length === 2 && m === 'GET') return sendJson(res, 200, { code: room.code, name: room.name, people: room.active().length });

  // GET /api/rooms/:code/events  -> SSE
  if (parts[2] === 'events' && m === 'GET') {
    let role = null, guest = null;
    if (isHost()) role = 'host';
    else if ((guest = guestFor())) role = 'guest';
    else if (url.searchParams.get('screen') === '1') role = 'screen';
    if (!role) return sendJson(res, 401, { error: 'unknown key' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...SECURITY });
    const sub = { res, role, guestId: guest && guest.id };
    if (!subs.has(code)) subs.set(code, new Set());
    subs.get(code).add(sub);
    if (guest) room.setConnected(guest.id, true);
    res.write(`retry: 2000\ndata: ${JSON.stringify(role === 'host' ? hostViewOf(room) : role === 'screen' ? room.screenView() : room.guestView(guest.id))}\n\n`);
    const ka = setInterval(() => res.write(': keepalive\n\n'), 15000);
    req.on('close', () => {
      clearInterval(ka); subs.get(code)?.delete(sub);
      if (guest) { room.setConnected(guest.id, false); notify(code); }
    });
    if (guest || role === 'host') notify(code);
    return;
  }

  const body = m === 'GET' ? {} : await readBody(req, parts[2] === 'host' && parts[3] === 'library' ? 6 * 1024 * 1024 : parts[2] === 'host' && parts[3] === 'extras' ? 256 * 1024 : undefined);

  // Guests
  if (parts[2] === 'guests' && parts.length === 3 && m === 'POST') {
    const g = room.addGuest(body.name, body.genres, { onNet: !!room.netKey && netKeyOf(clientIp(req)) === room.netKey, since: body.since, artists: body.artists, songs: body.songs, lookupGenres: body.lookupGenres });
    if (!g) return sendJson(res, 400, { error: 'pick a genre, an artist or a song' });
    g.connected = false; g.lostAt = Date.now(); // becomes connected when its event stream opens
    enrichGuestGenres(code, room, g);
    notify(code);
    return sendJson(res, 200, { guestId: g.id, guestKey: g.key, since: g.sinceAt });
  }
  if (parts[2] === 'guests' && parts.length === 4) {
    const gid = parts[3];
    const g = guestFor();
    if (!g || g.id !== gid) return sendJson(res, 401, { error: 'unknown guest' });
    if (m === 'PATCH') { room.updateGuest(gid, { name: body.name, genres: body.genres, sit: body.sit, artists: body.artists, songs: body.songs, lookupGenres: body.lookupGenres }); enrichGuestGenres(code, room, g); notify(code); return sendJson(res, 200, { ok: true }); }
    if (m === 'DELETE') { room.removeGuest(gid, 'left'); notify(code); return sendJson(res, 200, { ok: true }); }
  }
  // POST /api/rooms/:code/guests/:id/here  -> "I am still here" (about once a minute from the guest page)
  if (parts[2] === 'guests' && parts.length === 5 && parts[4] === 'here' && m === 'POST') {
    const g = guestFor();
    if (!g || g.id !== parts[3]) return sendJson(res, 401, { error: 'unknown guest' });
    const onNet = g.joinedOnNet && room.netKey ? netKeyOf(clientIp(req)) === room.netKey : null;
    const idle = Number(body.idleSec); room.beat(g.id, { onNet, idleSec: Number.isFinite(idle) && idle > 0 ? Math.min(idle, 86400) : 0, hidden: body.hidden === true ? true : body.hidden === false ? false : undefined });
    notify(code);
    return sendJson(res, 200, { ok: true, away: g.away, ask: !!g.askAt });
  }
  // GET /api/rooms/:code/search?q=  -> artists and songs in this room's music that someone can name. Open to anyone who has the
  // room code, because the join page uses it before the guest exists; the per-visitor request limit above still applies.
  if (parts[2] === 'search' && parts[3] === 'album' && parts.length === 5 && m === 'GET') {
    const id = parts[4];
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return sendJson(res, 400, { error: 'invalid album id' });
    try {
      return sendJson(res, 200, { songs: (await musicBrainz.albumTracks(id)).slice(0, 5) });
    } catch (e) {
      L.warn('musicbrainz.album_failed', { message: String(e && e.message || e).slice(0, 100) });
      return sendJson(res, 503, { error: 'MusicBrainz album tracks are unavailable right now' });
    }
  }
  if (parts[2] === 'search' && parts.length === 3 && m === 'GET') {
    L.count('picks.searches');
    const result = room.search(url.searchParams.get('q') || '');
    if (Engine.normKey(url.searchParams.get('q') || '').length < 2) return sendJson(res, 200, { ...result, albums: [] });
    if (process.env.MUSICBRAINZ_SEARCH_DISABLED === '1') {
      return sendJson(res, 200, { ...result, albums: [], lookupUnavailable: true });
    }
    try {
      const external = await musicBrainz.search(url.searchParams.get('q') || '');
      const artists = new Map(result.artists.map((artist) => [Engine.normKey(artist.name), artist]));
      for (const artist of external.artists) if (!artists.has(Engine.normKey(artist.name))) artists.set(Engine.normKey(artist.name), artist);
      const songs = new Map(result.songs.map((song) => [Engine.songKey(song.title, song.artist), song]));
      for (const song of external.songs) if (!songs.has(Engine.songKey(song.title, song.artist))) songs.set(Engine.songKey(song.title, song.artist), song);
      const albums = new Map();
      for (const album of external.albums) {
        const key = Engine.normKey(album.title + ' ' + album.artist);
        if (!albums.has(key)) albums.set(key, album);
      }
      return sendJson(res, 200, {
        artists: [...artists.values()].slice(0, 8),
        songs: [...songs.values()].slice(0, 8),
        albums: [...albums.values()].slice(0, 8),
      });
    } catch (e) {
      L.warn('musicbrainz.search_failed', { message: String(e && e.message || e).slice(0, 100) });
      return sendJson(res, 200, { ...result, albums: [], lookupUnavailable: true });
    }
  }
  if (parts[2] === 'vote' && m === 'POST') {
    const g = guestFor();
    if (!g) return sendJson(res, 401, { error: 'unknown guest' });
    room.vote(g.id, body.v); notify(code);
    return sendJson(res, 200, { ok: true });
  }

  // Host-only
  if (parts[2] === 'host') {
    if (!isHost()) return sendJson(res, 401, { error: 'not the host' });
    const act = parts[3];
    if (act === 'advance' && m === 'POST') { room.advance(); }
    else if (act === 'opts' && m === 'POST') { room.setOpts(body); saveRooms(); }
    else if (act === 'room' && m === 'POST') { room.setInfo(body); saveRooms(); }
    else if (act === 'snapshot' && m === 'GET') {
      const snapshot = getRestorer().encryptSnapshot(code, room.hostKey, room.snapshot());
      return sendJson(res, 200, { version: room.version, snapshot });
    }
    else if (act === 'guests' && parts.length === 4 && m === 'POST') {
      const g = room.addGuest(body.name, body.genres, { manual: true });
      if (!g) return sendJson(res, 400, { error: 'pick at least one genre' });
    }
    else if (act === 'guests' && parts.length === 5 && m === 'POST') {
      const id = parts[4];
      if (body.remove) room.removeGuest(id, 'was removed by the host');
      else room.updateGuest(id, { hostSit: !!body.sit, ...(body.genres ? { genres: body.genres } : {}), ...(body.name ? { name: body.name } : {}) });
    }
    else if (act === 'player' && m === 'POST') {
      if (body.trackId && room.nowItem && body.trackId !== room.nowItem.track.id) { /* stale report: ignore */ }
      else if (body.event === 'ended') room.advance();
      else if (body.event === 'unplayable') room.skipUnplayable();
    }
    else if (act === 'library' && m === 'POST') {
      const r = room.setLibrary(body.provider, body.label, body.tracks, body.refresh === true);
      if (!r.accepted) return sendJson(res, 400, { error: 'no usable songs: each needs a title and a recognised genre', ...r });
      notify(code); return sendJson(res, 200, { ok: true, ...r });
    }
    else if (act === 'library' && m === 'DELETE') { room.clearLibrary(); }
    else if (act === 'extras' && m === 'POST') { if (body.reset === true) room.clearExtras(); else room.addExtras(body.genre, body.tracks, { pool: body.pool === true, source: body.source, artist: typeof body.artist === 'string' ? body.artist : undefined }); }
    else if (act === 'reset' && m === 'POST') { L.info('room.reset', { room: L.roomTag(code) }); rooms.set(code, Object.assign(new Room(code, room.hostKey), { opts: room.opts })); subs.get(code)?.forEach((s) => s.res.end()); }
    else return sendJson(res, 404, { error: 'unknown action' });
    notify(code);
    return sendJson(res, 200, { ok: true });
  }
  return sendJson(res, 404, { error: 'not found' });
}

// ---------- static files ----------
function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/config.js') {
    res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-store', ...SECURITY });
    return res.end(`window.CONFIG = ${JSON.stringify(CLIENT_CONFIG)};`);
  }
  // single-page routes (a bare 5-character code is a short join link)
  const short = /^\/([A-Za-z0-9]{5})$/.exec(p), joinCode = short ? short[1].toUpperCase() : (/^\/r\/([A-Za-z0-9]{5})$/.exec(p) || [])[1];
  if (p === '/' || p.startsWith('/host/') || p.startsWith('/r/') || p.startsWith('/screen/') || p === '/callback' || short) {
    const room = joinCode && rooms.get(joinCode.toUpperCase());
    return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8', (err, html) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      if (room) {
        const label = room.name ? `Join ${room.name} on Room Blend` : 'Join the music on Room Blend';
        const desc = 'Pick the genres you like. The music adapts to everyone in the room. No sign-up.';
        html = html.replace('<title>Room Blend</title>', `<title>${escHtml(label)}</title>\n<meta name="description" content="${escHtml(desc)}">\n<meta property="og:type" content="website">\n<meta property="og:site_name" content="Room Blend">\n<meta property="og:title" content="${escHtml(label)}">\n<meta property="og:description" content="${escHtml(desc)}">\n<meta name="twitter:card" content="summary">`);
      }
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache', ...SECURITY });
      res.end(html);
    });
  }
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...SECURITY });
    res.end(data);
  });
}

// A request path without anything that identifies a room or guest, so it can be counted and logged.
function routeOf(p) {
  return p.replace(/^\/api\/rooms\/[A-Za-z0-9]{5}(?=\/|$)/, '/api/rooms/:code').replace(/\/guests\/g[0-9a-f]+/, '/guests/:id')
    .replace(/^\/(r|host|screen)\/[A-Za-z0-9]{5}$/, '/$1/:code').replace(/^\/[A-Za-z0-9]{5}$/, '/:code');
}

// /status: counts, timings and memory for whoever runs the server. It is not public: with STATUS_KEY set it needs the key
// (?key= or the x-status-key header); without one it answers only to a request made on this machine and not through a proxy or tunnel.
function statusAllowed(req, url) {
  const key = process.env.STATUS_KEY || '';
  if (key) return safeEq(req.headers['x-status-key'] || url.searchParams.get('key') || '', key);
  const a = req.socket.remoteAddress || '';
  const local = a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
  return local && !req.headers['x-forwarded-for'] && !req.headers['forwarded'] && !req.headers['cf-connecting-ip'];
}
let lagMs = 0, lagLast = Date.now();
setInterval(() => { const now = Date.now(); lagMs = Math.max(0, now - lagLast - 1000); lagLast = now; }, 1000).unref();
function statusView() {
  let guests = 0, withHost = 0, pooled = 0, library = 0;
  for (const [code, r] of rooms) {
    guests += r.guests.size;
    if ([...(subs.get(code) || [])].some((x) => x.role === 'host')) withHost++;
    if (r.poolMode) pooled++; else if (r.library) library++;
  }
  const sse = { host: 0, guest: 0, screen: 0 };
  for (const set of subs.values()) for (const s of set) sse[s.role] = (sse[s.role] || 0) + 1;
  const mem = process.memoryUsage(), snap = L.snapshot();
  return {
    ok: true, node: process.version, uptimeSec: snap.uptimeSec,
    rooms: { total: rooms.size, max: MAX_ROOMS, withHostConnected: withHost, usingServiceSongs: pooled, usingOwnLibrary: library },
    guestsInRooms: guests, liveConnections: sse,
    memoryMB: { rss: Math.round(mem.rss / 1048576), heapUsed: Math.round(mem.heapUsed / 1048576) },
    eventLoopLagMs: lagMs,
    counters: snap.counters, timers: snap.timers, topGenres: snap.topGenres, topSources: snap.topSources,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const t0 = process.hrtime.bigint();
  if (url.pathname !== '/healthz') {
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6, s = res.statusCode, route = routeOf(url.pathname);
      L.count('http.requests'); L.count('http.' + Math.floor(s / 100) + 'xx');
      if (route.startsWith('/api/')) L.observe('api_ms', ms);
      const f = { method: req.method, route, status: s, ms };
      if (s >= 500) L.error('http.error', f); else if (s === 401 || s === 403 || s === 413) L.info('http.denied', f); else L.debug('http.request', f);
    });
  }
  try {
    if (url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); return res.end('ok'); }
    if (url.pathname === '/status') {
      if (!statusAllowed(req, url)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
      return sendJson(res, 200, statusView());
    }
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    return serveStatic(req, res, url);
  } catch (e) {
    if (!res.headersSent) sendJson(res, e.status || 500, { error: e.status ? e.message : 'server error' });
    if (!e.status) { L.count('errors.unhandled'); L.error('request.failed', { route: routeOf(url.pathname), message: String(e && e.message), stack: String(e && e.stack || '').split('\n').slice(1, 4).join(' | ') }); }
  }
});

// Clock: promote arriving guests, drop guests who stayed disconnected, expire idle rooms.
const clock = setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.touchedAt > ROOM_TTL_MS && !(subs.get(code) && subs.get(code).size)) { L.count('rooms.expired'); L.info('room.expired', { room: L.roomTag(code), ageHours: (now - room.createdAt) / 3600000, rooms: rooms.size - 1 }); rooms.delete(code); subs.delete(code); saveRooms(); continue; }
    if (room.tick(now)) notify(code);
    else if ([...room.guests.values()].some((g) => g.status === 'arriving' || (!g.connected && !g.manual))) notify(code);
  }
}, 1000);
clock.unref();

if (require.main === module) {
  const level = L.configure();
  loadRooms();
  getRestorer(); // logs now whether hosts will be able to restore rooms after a restart
  server.listen(PORT, '0.0.0.0', () => {
    L.info('server.start', { port: PORT, node: process.version, rooms: rooms.size, logLevel: level, trustProxy: TRUST_PROXY, publicUrl: !!PUBLIC_URL, ownSpotifyApp: !CLIENT_CONFIG.clientId });
    // A person running this in a terminal gets a plain sentence as well as the JSON line.
    if (process.stdout.isTTY) console.log(`Room Blend listening on port ${PORT}${PUBLIC_URL ? ' (' + PUBLIC_URL + ')' : ''}${TRUST_PROXY ? ', trusting proxy' : ''}. Hosts ${CLIENT_CONFIG.clientId ? 'can use the built-in Spotify app or their own' : 'bring their own Spotify app, or run manual mode'}.`);
  });
  // Crashes are logged before the process exits (a platform or Docker restarts it). Stopping saves the rooms first.
  process.on('uncaughtException', (e) => { L.error('process.crash', { message: String(e && e.message), stack: String(e && e.stack || '').split('\n').slice(1, 4).join(' | ') }); writeRooms(); process.exit(1); });
  process.on('unhandledRejection', (e) => { L.error('process.unhandled_rejection', { message: e instanceof Error ? e.message : String(e) }); });
  const stop = (sig) => { L.info('server.stop', { signal: sig, rooms: rooms.size }); clearTimeout(saveTimer); writeRooms(); server.close(); setTimeout(() => process.exit(0), 300).unref(); };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}
module.exports = { server, rooms, CLIENT_CONFIG, musicBrainz };
