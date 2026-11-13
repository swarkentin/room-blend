'use strict';
// Postgres backend for lib/store.js. Built for Neon's free tier, but any Postgres 13+ works.
//
// Neon notes:
//   - Use the pooled connection string (host contains "-pooler") for the app. It tolerates many short-lived connections.
//   - The compute scales to zero after ~5 idle minutes, so the first query after a quiet spell can take a second. Calls here
//     retry once on connection errors, and the server keeps serving rooms from memory while the database wakes.
//   - `pg` is loaded lazily, so servers and tests that do not use a database never need it installed.
const { VOTE_LIFE_MS, VOTE_KEEP_MS, PLAY_LOG_KEEP_MS } = require('./store');

// Ordered, append-only. Never edit a migration that has shipped: add a new one.
const MIGRATIONS = [
  {
    name: 'rooms, catalogue votes and artist genres',
    sql: `
      CREATE TABLE rooms (
        code             TEXT PRIMARY KEY,
        host_key         TEXT NOT NULL,
        created_at       BIGINT NOT NULL,
        touched_at       BIGINT NOT NULL,
        name             TEXT NOT NULL DEFAULT '',
        discoverable     BOOLEAN NOT NULL DEFAULT TRUE,
        net_key          TEXT NOT NULL DEFAULT '',
        opts             JSONB NOT NULL DEFAULT '{}',
        snapshot         TEXT,
        snapshot_version INTEGER NOT NULL DEFAULT 0,
        snapshot_at      BIGINT NOT NULL DEFAULT 0
      );
      CREATE INDEX rooms_touched_idx ON rooms (touched_at);

      -- One standing opinion per room per video: did it play there or fail there?
      CREATE TABLE yt_play_votes (
        video_id TEXT   NOT NULL,
        voter    TEXT   NOT NULL,
        ok       BOOLEAN NOT NULL,
        at       BIGINT NOT NULL,
        PRIMARY KEY (video_id, voter)
      );
      CREATE INDEX yt_play_votes_at_idx ON yt_play_votes (at);

      -- One vote per room for "this video answers this song lookup", cast when it played successfully.
      CREATE TABLE yt_lookup_votes (
        key      TEXT   NOT NULL,
        video_id TEXT   NOT NULL,
        voter    TEXT   NOT NULL,
        at       BIGINT NOT NULL,
        PRIMARY KEY (key, video_id, voter)
      );
      CREATE INDEX yt_lookup_votes_at_idx ON yt_lookup_votes (at);

      CREATE TABLE artist_genres (
        name_key   TEXT PRIMARY KEY,
        genres     TEXT[] NOT NULL,
        fetched_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL
      );
      CREATE INDEX artist_genres_expires_idx ON artist_genres (expires_at);
    `,
  },
  {
    name: 'room play log',
    sql: `
      -- What each room played. Keyed by an opaque room hash (not the room code), and holds no guest names or ids.
      CREATE TABLE room_plays (
        room_hash TEXT    NOT NULL,
        played_at BIGINT  NOT NULL,
        track_id  TEXT    NOT NULL,
        title     TEXT    NOT NULL,
        artist    TEXT    NOT NULL,
        genres    TEXT[]  NOT NULL DEFAULT '{}',
        mode      TEXT    NOT NULL,
        present   INTEGER NOT NULL DEFAULT 0,
        up        INTEGER NOT NULL DEFAULT 0,
        down      INTEGER NOT NULL DEFAULT 0,
        skips     INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (room_hash, played_at)
      );
      CREATE INDEX room_plays_at_idx ON room_plays (played_at);
    `,
  },
];

const MIGRATION_LOCK = 727001; // arbitrary constant; serialises migrations when two instances start together

// Errors worth one retry: Neon waking from scale-to-zero, or an idle connection the platform closed.
const retryable = (e) => !!e && (/^(08|57P0|53)/.test(String(e.code || '')) || /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|Connection terminated|timeout exceeded when trying to connect/i.test(String(e.message || '')));

/** @param {{url: string, max?: number, pool?: any, log?: {warn: Function}}} opts  `pool` is for tests: anything with query()/connect()/end(). */
function createPgStore({ url, max = 5, pool: injected, log }) {
  let pool = injected || null;
  function getPool() {
    if (pool) return pool;
    let pg;
    // @ts-ignore pg ships no type declarations
    try { pg = require('pg'); } catch { throw new Error('DATABASE_URL is set but the "pg" package is not installed. Run `npm install`.'); }
    pool = new pg.Pool({
      connectionString: url, max,
      idleTimeoutMillis: 20000, connectionTimeoutMillis: 15000, // generous: covers a Neon cold start
      ssl: /localhost|127\.0\.0\.1|sslmode=disable/.test(url) ? undefined : { rejectUnauthorized: true },
    });
    // An idle client can be dropped by the platform. Without this handler that would crash the process.
    pool.on('error', (e) => { if (log) log.warn('db.idle_client_error', { message: String(e && e.message).slice(0, 120) }); });
    return pool;
  }
  async function q(text, params) {
    try { return await getPool().query(text, params); }
    catch (e) {
      if (!retryable(e)) throw e;
      if (log) log.warn('db.retry', { code: e.code || '', message: String(e.message).slice(0, 100) });
      await new Promise((r) => setTimeout(r, 400));
      return getPool().query(text, params);
    }
  }
  const num = (v) => Number(v) || 0;

  // Each migration runs in one transaction that first takes a transaction-level advisory lock, so two instances starting together
  // cannot both apply it. (Session-level locks are avoided on purpose: Neon's pooled connections do not support them.)
  async function migrate() {
    const applied = [];
    for (let i = 0; i < MIGRATIONS.length; i++) {
      const version = i + 1, client = await getPool().connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
        await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at BIGINT NOT NULL)');
        const done = (await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [version])).rowCount > 0;
        if (!done) {
          await client.query(MIGRATIONS[i].sql);
          await client.query('INSERT INTO schema_migrations (version, name, applied_at) VALUES ($1, $2, $3)', [version, MIGRATIONS[i].name, Date.now()]);
          applied.push(version);
        }
        await client.query('COMMIT');
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch { /* the connection is already gone */ }
        throw e;
      } finally { client.release(); }
    }
    return applied;
  }

  return {
    kind: 'postgres', persistent: true,
    async init() { const applied = await migrate(); return { applied }; },
    async close() { if (pool) { const p = pool; pool = null; await p.end(); } },
    async ping() { await q('SELECT 1'); return true; },

    // ----- rooms -----
    async upsertRoom(r) {
      await q(
        `INSERT INTO rooms (code, host_key, created_at, touched_at, name, discoverable, net_key, opts) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
         ON CONFLICT (code) DO UPDATE SET host_key = EXCLUDED.host_key, touched_at = EXCLUDED.touched_at, name = EXCLUDED.name,
           discoverable = EXCLUDED.discoverable, net_key = EXCLUDED.net_key, opts = EXCLUDED.opts`,
        [r.code, r.hostKey, r.createdAt, r.touchedAt, r.name || '', r.discoverable !== false, r.netKey || '', JSON.stringify(r.opts || {})]);
    },
    async saveSnapshot(code, envelope, version, now = Date.now()) {
      const res = await q('UPDATE rooms SET snapshot = $2, snapshot_version = $3, snapshot_at = $4 WHERE code = $1 AND snapshot_version <= $3', [code, envelope, Math.floor(version), now]);
      return res.rowCount > 0;
    },
    async loadRooms(since) {
      const res = await q('SELECT * FROM rooms WHERE touched_at >= $1', [since]);
      return res.rows.map((r) => ({
        code: r.code, hostKey: r.host_key, createdAt: num(r.created_at), touchedAt: num(r.touched_at), name: r.name, discoverable: r.discoverable, netKey: r.net_key,
        opts: r.opts || {}, snapshot: r.snapshot, snapshotVersion: num(r.snapshot_version), snapshotAt: num(r.snapshot_at),
      }));
    },
    async deleteRooms(codes) { if (codes.length) await q('DELETE FROM rooms WHERE code = ANY($1::text[])', [codes]); },

    // ----- shared YouTube catalogue: votes -----
    async recordPlay(voter, videoId, ok, key, now = Date.now()) {
      await q(
        `INSERT INTO yt_play_votes (video_id, voter, ok, at) VALUES ($1,$2,$3,$4)
         ON CONFLICT (video_id, voter) DO UPDATE SET ok = EXCLUDED.ok, at = EXCLUDED.at`,
        [videoId, voter, ok, now]);
      if (!key) return;
      if (ok) await q(
        `INSERT INTO yt_lookup_votes (key, video_id, voter, at) VALUES ($1,$2,$3,$4)
         ON CONFLICT (key, video_id, voter) DO UPDATE SET at = EXCLUDED.at`,
        [key, videoId, voter, now]);
      else await q('DELETE FROM yt_lookup_votes WHERE key = $1 AND video_id = $2 AND voter = $3', [key, videoId, voter]);
    },
    async getPlayback(ids) {
      if (!ids.length) return {};
      const res = await q(
        `SELECT video_id, count(*) FILTER (WHERE ok) AS successes, count(*) FILTER (WHERE NOT ok) AS failures
         FROM yt_play_votes WHERE video_id = ANY($1::text[]) GROUP BY video_id`, [ids]);
      return Object.fromEntries(res.rows.map((r) => [r.video_id, { successes: num(r.successes), failures: num(r.failures) }]));
    },
    async getSearches(keys, quorum, now = Date.now()) {
      if (!keys.length) return {};
      const res = await q(
        `SELECT key, video_id, count(*) AS n FROM yt_lookup_votes WHERE key = ANY($1::text[]) AND at > $2
         GROUP BY key, video_id HAVING count(*) >= $3 ORDER BY key, n DESC, video_id`,
        [keys, now - VOTE_LIFE_MS, quorum]);
      if (!res.rows.length) return {};
      const tallies = await this.getPlayback([...new Set(res.rows.map((r) => r.video_id))]);
      const out = {};
      for (const r of res.rows) { const t = tallies[r.video_id] || { successes: 0, failures: 0 }; if (t.failures <= t.successes) (out[r.key] = out[r.key] || []).push(r.video_id); }
      return out;
    },

    // ----- play log -----
    async upsertPlays(roomHash, rows) {
      for (const r of rows) {
        await q(
          `INSERT INTO room_plays (room_hash, played_at, track_id, title, artist, genres, mode, present, up, down, skips)
           VALUES ($1,$2,$3,$4,$5,$6::text[],$7,$8,$9,$10,$11)
           ON CONFLICT (room_hash, played_at) DO UPDATE SET present = EXCLUDED.present, up = EXCLUDED.up, down = EXCLUDED.down, skips = EXCLUDED.skips`,
          [roomHash, r.at, r.trackId, r.title, r.artist, r.genres, r.mode, r.present, r.up, r.down, r.skips]);
      }
    },
    async getPlays(roomHash, limit = 2000) {
      const res = await q('SELECT * FROM (SELECT * FROM room_plays WHERE room_hash = $1 ORDER BY played_at DESC LIMIT $2) t ORDER BY played_at', [roomHash, limit]);
      return res.rows.map((r) => ({ at: num(r.played_at), trackId: r.track_id, title: r.title, artist: r.artist, genres: r.genres || [], mode: r.mode, present: r.present, up: r.up, down: r.down, skips: r.skips }));
    },

    // ----- artist genres -----
    async getArtistGenres(key, now = Date.now()) {
      const res = await q('SELECT genres FROM artist_genres WHERE name_key = $1 AND expires_at > $2', [key, now]);
      return res.rows[0] ? res.rows[0].genres : undefined;
    },
    async putArtistGenres(key, genres, ttlMs, now = Date.now()) {
      await q(
        `INSERT INTO artist_genres (name_key, genres, fetched_at, expires_at) VALUES ($1,$2::text[],$3,$4)
         ON CONFLICT (name_key) DO UPDATE SET genres = EXCLUDED.genres, fetched_at = EXCLUDED.fetched_at, expires_at = EXCLUDED.expires_at`,
        [key, genres, now, now + ttlMs]);
    },

    async sweep(now = Date.now()) {
      await q('DELETE FROM artist_genres WHERE expires_at <= $1', [now]);
      await q('DELETE FROM yt_play_votes WHERE at < $1', [now - VOTE_KEEP_MS]);
      await q('DELETE FROM yt_lookup_votes WHERE at < $1', [now - VOTE_KEEP_MS]);
      await q('DELETE FROM room_plays WHERE played_at < $1', [now - PLAY_LOG_KEEP_MS]);
    },
    async stats(quorum = 2, now = Date.now()) {
      const res = await q(`SELECT
        (SELECT count(DISTINCT key) FROM (SELECT key FROM yt_lookup_votes WHERE at > $1 GROUP BY key, video_id HAVING count(*) >= $2) c) AS confirmed,
        (SELECT count(DISTINCT key) FROM yt_lookup_votes) AS lookups, (SELECT count(DISTINCT video_id) FROM yt_play_votes) AS rated,
        (SELECT count(*) FROM yt_play_votes) AS votes, (SELECT count(*) FROM yt_play_votes WHERE ok) AS plays,
        (SELECT count(*) FROM yt_play_votes WHERE NOT ok) AS fails,
        (SELECT count(*) FROM artist_genres WHERE expires_at > $3) AS artists, (SELECT count(*) FROM rooms) AS rooms, (SELECT count(DISTINCT room_hash) FROM room_plays) AS logrooms`, [now - VOTE_LIFE_MS, quorum, now]);
      const r = res.rows[0];
      return { playLogRooms: num(r.logrooms), confirmedLookups: num(r.confirmed), lookupsWithVotes: num(r.lookups), ratedVideos: num(r.rated), playVotes: num(r.votes), playSuccesses: num(r.plays), playFailures: num(r.fails), artists: num(r.artists), rooms: num(r.rooms) };
    },
    _migrations: MIGRATIONS,
  };
}

module.exports = { createPgStore, MIGRATIONS };
