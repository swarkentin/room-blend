'use strict';
// Storage for everything the server keeps beyond a single process: room identities and checkpoints, the shared YouTube catalogue
// (song lookups and playback quality, both built from votes) and the artist-genre cache.
//
// Two interchangeable backends, one interface:
//   memory     this file. Used when DATABASE_URL is not set (local development, tests). Nothing survives a restart.
//   postgres   lib/pgstore.js. Used when DATABASE_URL is set (Neon, or any Postgres 13+).
// test/store.contract.js runs one set of expectations against both, so they cannot drift apart.
//
// All timestamps are milliseconds since the epoch. All methods are async. Callers must treat every call as able to fail
// (a database can be asleep or unreachable) and keep the live room service working when it does.
//
// The catalogue is deliberately small and vote-based. A "voter" is an opaque id for one room (later: one account), and each voter counts
// once per video and once per song lookup, however many times it reports. That is what keeps one host from steering everyone's results.

const DAY = 86400000;
const VOTE_LIFE_MS = 90 * DAY; // a lookup vote stops counting after this long without being renewed
const VOTE_KEEP_MS = 180 * DAY; // and is deleted after this long
const PLAY_LOG_KEEP_MS = 365 * DAY; // a room's play log is deleted after a year

/**
 * @typedef {{code: string, hostKey: string, createdAt: number, touchedAt: number, name: string, discoverable: boolean, netKey: string, opts: Record<string, any>}} RoomRecord
 */

function createMemoryStore({ maxVideos = 100000, maxLookups = 50000, persistent = false } = {}) {
  const rooms = new Map(), artistGenres = new Map();
  const plays = new Map();    // videoId -> Map(voter -> { ok, at })
  const lookups = new Map();  // lookup key -> Map(videoId -> Map(voter -> at))
  const playLog = new Map();  // room hash -> Map(playedAt -> row)

  function trim(map, max) { while (map.size > max) map.delete(map.keys().next().value); }
  const live = (map, key, now) => { const r = map.get(key); return r && r.expiresAt > now ? r : undefined; };
  function tally(videoId) {
    let successes = 0, failures = 0;
    for (const v of (plays.get(videoId) || new Map()).values()) v.ok ? successes++ : failures++;
    return { successes, failures };
  }

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
    /** Removes rooms nobody has used for a while: anonymous rooms last touched before `unownedBefore`, owned rooms before `ownedBefore`. */
    async deleteExpiredRooms(unownedBefore, ownedBefore) {
      for (const [code, r] of rooms) if (r.touchedAt < (r.ownerUserId ? ownedBefore : unownedBefore)) rooms.delete(code);
    },

    // ----- shared YouTube catalogue: votes -----
    /**
     * One room's report that a video played (ok) or failed. A voter has one standing opinion per video: the latest report replaces the last.
     * With `key` (the song lookup the video answered), a successful play also votes for that lookup, and a failure withdraws the vote.
     */
    async recordPlay(voter, videoId, ok, key, now = Date.now()) {
      let m = plays.get(videoId); if (!m) { m = new Map(); plays.set(videoId, m); }
      m.set(voter, { ok, at: now });
      plays.delete(videoId); plays.set(videoId, m); // newest last, so trim() drops the stalest
      trim(plays, maxVideos);
      if (!key) return;
      let byVideo = lookups.get(key);
      if (ok) {
        if (!byVideo) { byVideo = new Map(); lookups.set(key, byVideo); }
        let voters = byVideo.get(videoId); if (!voters) { voters = new Map(); byVideo.set(videoId, voters); }
        voters.set(voter, now);
        trim(lookups, maxLookups);
      } else if (byVideo && byVideo.get(videoId)) {
        byVideo.get(videoId).delete(voter);
      }
    },
    /** Distinct rooms where each video played and failed. Unknown videos are absent. */
    async getPlayback(ids) {
      const out = {};
      for (const id of ids) if (plays.has(id)) out[id] = tally(id);
      return out;
    },
    /**
     * Confirmed answers for song lookups: videos that at least `quorum` different rooms played for that lookup recently, most-confirmed
     * first, leaving out any video that has failed in more rooms than it has played in. Lookups with no confirmed answer are absent.
     */
    async getSearches(keys, quorum, now = Date.now()) {
      const out = {};
      for (const key of keys) {
        const ranked = [];
        for (const [videoId, voters] of lookups.get(key) || []) {
          let n = 0; for (const at of voters.values()) if (at > now - VOTE_LIFE_MS) n++;
          const t = tally(videoId);
          if (n >= quorum && t.failures <= t.successes) ranked.push({ videoId, n });
        }
        if (ranked.length) out[key] = ranked.sort((a, b) => b.n - a.n || (a.videoId < b.videoId ? -1 : 1)).map((r) => r.videoId);
      }
      return out;
    },

    // ----- play log: what each room played, with no names and no guest ids -----
    /** Rows are keyed by (room, time). Writing a row again updates it, which is how votes that arrive after the song started get recorded. */
    async upsertPlays(roomHash, rows) {
      let m = playLog.get(roomHash); if (!m) { m = new Map(); playLog.set(roomHash, m); }
      for (const r of rows) m.set(r.at, { ...r, genres: r.genres.slice() });
    },
    /** A room's plays, oldest first. */
    async getPlays(roomHash, limit = 2000) {
      return [...(playLog.get(roomHash) || new Map()).values()].sort((a, b) => a.at - b.at).slice(-limit).map((r) => ({ ...r, genres: r.genres.slice() }));
    },

    // ----- artist genres (MusicBrainz answers) -----
    async getArtistGenres(key, now = Date.now()) { const r = live(artistGenres, key, now); return r ? r.genres.slice() : undefined; },
    async putArtistGenres(key, genres, ttlMs, now = Date.now()) { artistGenres.delete(key); artistGenres.set(key, { genres: genres.slice(), expiresAt: now + ttlMs }); trim(artistGenres, maxLookups); },

    async sweep(now = Date.now()) {
      for (const [k, v] of artistGenres) if (v.expiresAt <= now) artistGenres.delete(k);
      for (const [h, m] of playLog) { for (const [at] of m) if (at < now - PLAY_LOG_KEEP_MS) m.delete(at); if (!m.size) playLog.delete(h); }
      for (const [id, m] of plays) { for (const [voter, v] of m) if (v.at < now - VOTE_KEEP_MS) m.delete(voter); if (!m.size) plays.delete(id); }
      for (const [key, byVideo] of lookups) {
        for (const [id, voters] of byVideo) { for (const [voter, at] of voters) if (at < now - VOTE_KEEP_MS) voters.delete(voter); if (!voters.size) byVideo.delete(id); }
        if (!byVideo.size) lookups.delete(key);
      }
    },
    async stats(quorum = 2, now = Date.now()) {
      let successes = 0, failures = 0, votes = 0;
      for (const id of plays.keys()) { const t = tally(id); successes += t.successes; failures += t.failures; }
      for (const m of plays.values()) votes += m.size;
      let confirmed = 0;
      for (const key of lookups.keys()) if (Object.keys(await this.getSearches([key], quorum, now)).length) confirmed++;
      return { playLogRooms: playLog.size, confirmedLookups: confirmed, lookupsWithVotes: lookups.size, ratedVideos: plays.size, playVotes: votes, playSuccesses: successes, playFailures: failures, artists: artistGenres.size, rooms: rooms.size };
    },
    VOTE_LIFE_MS, VOTE_KEEP_MS,
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

module.exports = { createStore, createMemoryStore, VOTE_LIFE_MS, VOTE_KEEP_MS, PLAY_LOG_KEEP_MS };
