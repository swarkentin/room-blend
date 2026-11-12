'use strict';
// Storage for everything the server keeps beyond a single process: room identities and checkpoints, and the shared YouTube catalogue
// (songs, genre pools, song lookups, playback quality) plus the artist-genre cache.
//
// Two interchangeable backends, one interface:
//   memory     this file. Used when DATABASE_URL is not set (local development, tests). Nothing survives a restart.
//   postgres   lib/pgstore.js. Used when DATABASE_URL is set (Neon, or any Postgres 13+).
// test/store.contract.js runs one set of expectations against both, so they cannot drift apart.
//
// All timestamps are milliseconds since the epoch. All methods are async. Callers must treat every call as able to fail
// (a database can be asleep or unreachable) and keep the live room service working when it does.

const STOP_WORDS = new Set(['the', 'and', 'feat', 'official', 'video', 'audio', 'lyrics', 'remastered', 'remaster']);

/** Words used to find a song again later. Plain lowercase letters and digits, any script, no stop words. */
function tokensOf(...parts) {
  const out = new Set();
  for (const w of parts.join(' ').toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}]+/u)) {
    if (w.length >= 2 && w.length <= 30 && !STOP_WORDS.has(w)) out.add(w);
    if (out.size >= 24) break;
  }
  return [...out];
}

/** How a playback record moves a song up or down. Must match qualityAdjustment() in public/youtube.js. */
const playbackAdjustment = (successes, failures) => Math.min(5, successes || 0) * 0.04 - (failures || 0) * 1.25;

const MAX_SONG_GENRES = 4;
const mergeGenres = (a, b) => [...new Set([...(a || []), ...(b || [])])].slice(0, MAX_SONG_GENRES);

/**
 * @typedef {{id: string, title: string, artist: string, genres: string[], quality: number}} Song
 * @typedef {{code: string, hostKey: string, createdAt: number, touchedAt: number, name: string, discoverable: boolean, netKey: string, opts: Record<string, any>}} RoomRecord
 */

function shuffle(list, rand = Math.random) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function createMemoryStore({ maxSongs = 50000, maxLookups = 20000, persistent = false } = {}) {
  const rooms = new Map(), songs = new Map(), pools = new Map(), searches = new Map(), playback = new Map(), artistGenres = new Map();

  function trim(map, max) { while (map.size > max) map.delete(map.keys().next().value); }
  function upsertSongs(list, now) {
    for (const s of list) {
      const have = songs.get(s.id);
      if (have) {
        have.genres = mergeGenres(have.genres, s.genres);
        have.quality = Math.max(have.quality, Number(s.quality) || 0);
        have.lastSeen = now;
        songs.delete(s.id); songs.set(s.id, have); // newest last, so trim() drops the stalest
      } else songs.set(s.id, { id: s.id, title: s.title, artist: s.artist, genres: mergeGenres([], s.genres), quality: Number(s.quality) || 0, tokens: tokensOf(s.title, s.artist), firstSeen: now, lastSeen: now });
    }
    trim(songs, maxSongs);
  }
  const pub = (r) => ({ id: r.id, title: r.title, artist: r.artist, genres: r.genres.slice(), quality: r.quality });
  // Pool songs also carry their community playback tally (s = good starts, f = failures) so a browser can rank a whole pool in one request.
  const withTally = (r) => { const p = playback.get(r.id); return p ? { ...pub(r), s: p.successes, f: p.failures } : pub(r); };
  const live = (map, key, now) => { const r = map.get(key); return r && r.expiresAt > now ? r : undefined; };

  return {
    kind: 'memory', persistent,
    async init() { return { applied: [] }; },
    async close() {},
    async ping() { return true; },

    // ----- rooms -----
    async upsertRoom(rec) { const have = rooms.get(rec.code) || {}; rooms.set(rec.code, { snapshot: null, snapshotVersion: 0, snapshotAt: 0, ...have, ...rec, opts: { ...(rec.opts || {}) } }); },
    async saveSnapshot(code, envelope, version, now = Date.now()) {
      const r = rooms.get(code);
      if (!r || Number(version) < r.snapshotVersion) return false;
      r.snapshot = envelope; r.snapshotVersion = Number(version); r.snapshotAt = now;
      return true;
    },
    /** Rooms touched at or after `since`, with their latest encrypted checkpoint. */
    async loadRooms(since) { return [...rooms.values()].filter((r) => r.touchedAt >= since).map((r) => ({ ...r, opts: { ...r.opts } })); },
    async deleteRooms(codes) { for (const c of codes) rooms.delete(c); },

    // ----- shared YouTube catalogue -----
    async putSongs(list, now = Date.now()) { upsertSongs(list, now); },
    /** Pools are ordered lists of songs. An empty list is a deliberate "nothing here" answer that expires sooner. */
    async putPool(key, list, ttlMs, now = Date.now()) {
      upsertSongs(list, now);
      pools.delete(key); pools.set(key, { ids: list.map((s) => s.id), expiresAt: now + ttlMs });
      trim(pools, maxLookups);
    },
    async getPools(keys, now = Date.now()) {
      const out = {};
      for (const k of keys) { const p = live(pools, k, now); if (p) out[k] = p.ids.map((id) => songs.get(id)).filter(Boolean).map(withTally); }
      return out;
    },
    async putSearch(key, ids, ttlMs, now = Date.now()) { searches.delete(key); searches.set(key, { ids: ids.slice(), expiresAt: now + ttlMs }); trim(searches, maxLookups); },
    async getSearches(keys, now = Date.now()) {
      const out = {};
      for (const k of keys) { const s = live(searches, k, now); if (s) out[k] = s.ids.slice(); }
      return out;
    },
    /** Adds plays to a video's tally. Atomic: two hosts reporting at once both count. */
    async addPlayback(id, successes, failures, now = Date.now()) {
      const p = playback.get(id) || { successes: 0, failures: 0, lastSuccessAt: 0, lastFailureAt: 0 };
      p.successes += successes; p.failures += failures;
      if (successes) p.lastSuccessAt = now;
      if (failures) p.lastFailureAt = now;
      playback.set(id, p);
    },
    async getPlayback(ids) {
      const out = {};
      for (const id of ids) { const p = playback.get(id); if (p) out[id] = { successes: p.successes, failures: p.failures }; }
      return out;
    },
    /** Songs sharing words with a title and artist, best overlap first. The caller ranks them properly. */
    async candidates(title, artist, limit = 40) {
      const want = new Set(tokensOf(title, artist));
      if (!want.size) return [];
      const hits = [];
      for (const s of songs.values()) {
        let n = 0;
        for (const t of s.tokens) if (want.has(t)) n++;
        if (n) hits.push({ s, n });
      }
      hits.sort((a, b) => b.n - a.n || b.s.quality - a.s.quality);
      return hits.slice(0, limit).map((h) => pub(h.s));
    },
    /** A random sample of well-rated songs for one genre, skipping songs that keep failing to play. */
    async genreSongs(genre, limit = 40, rand = Math.random) {
      const scored = [];
      for (const s of songs.values()) {
        if (!s.genres.includes(genre)) continue;
        const p = playback.get(s.id) || { successes: 0, failures: 0 };
        const adj = playbackAdjustment(p.successes, p.failures);
        if (adj < -1) continue;
        scored.push({ s, score: s.quality + adj });
      }
      scored.sort((a, b) => b.score - a.score);
      return shuffle(scored.slice(0, Math.max(limit * 5, 200)), rand).slice(0, limit).map((x) => pub(x.s));
    },

    // ----- artist genres (MusicBrainz answers) -----
    async getArtistGenres(key, now = Date.now()) { const r = live(artistGenres, key, now); return r ? r.genres.slice() : undefined; },
    async putArtistGenres(key, genres, ttlMs, now = Date.now()) { artistGenres.delete(key); artistGenres.set(key, { genres: genres.slice(), expiresAt: now + ttlMs }); trim(artistGenres, maxLookups); },

    async sweep(now = Date.now()) {
      for (const m of [pools, searches, artistGenres]) for (const [k, v] of m) if (v.expiresAt <= now) m.delete(k);
      const cut = now - 180 * 86400000;
      for (const [id, s] of songs) if (s.lastSeen < cut && !(playback.get(id) || {}).successes) songs.delete(id);
    },
    async stats() {
      let plays = 0, fails = 0;
      for (const p of playback.values()) { plays += p.successes; fails += p.failures; }
      return { songs: songs.size, pools: pools.size, searches: searches.size, ratedVideos: playback.size, playbackSuccesses: plays, playbackFailures: fails, artists: artistGenres.size, rooms: rooms.size };
    },
  };
}

/**
 * Picks the backend from the environment. DATABASE_URL (a Neon connection string, say) selects Postgres.
 * @param {Record<string, string | undefined>} env
 */
const named = new Map();
function createStore(env = process.env) {
  const url = String(env.DATABASE_URL || '').trim();
  if (!url) return createMemoryStore();
  // "memory://name" is for tests only: the server behaves exactly as with a database (checkpoints, restore, catalogue), backed by a
  // memory store that is shared by name within the process, so a test can "restart" the server and find its data again.
  if (/^memory:/i.test(url)) { if (!named.has(url)) named.set(url, createMemoryStore({ persistent: true })); return named.get(url); }
  return require('./pgstore').createPgStore({ url, max: Number(env.DATABASE_POOL_MAX) || 5 });
}

module.exports = { createStore, createMemoryStore, tokensOf, playbackAdjustment, mergeGenres, MAX_SONG_GENRES };
