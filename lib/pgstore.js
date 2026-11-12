'use strict';
// Postgres backend for lib/store.js. Built for Neon's free tier, but any Postgres 13+ works.
//
// Neon notes:
//   - Use the pooled connection string (host contains "-pooler") for the app. It tolerates many short-lived connections.
//   - The compute scales to zero after ~5 idle minutes, so the first query after a quiet spell can take a second. Calls here
//     retry once on connection errors, and the server keeps serving rooms from memory while the database wakes.
//   - `pg` is loaded lazily, so servers and tests that do not use a database never need it installed.
const { tokensOf, mergeGenres, MAX_SONG_GENRES } = require('./store');

// Ordered, append-only. Never edit a migration that has shipped: add a new one.
const MIGRATIONS = [
  {
    name: 'rooms and shared youtube catalogue',
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

      CREATE TABLE yt_songs (
        video_id   TEXT PRIMARY KEY,
        title      TEXT NOT NULL,
        artist     TEXT NOT NULL,
        tokens     TEXT[] NOT NULL DEFAULT '{}',
        genres     TEXT[] NOT NULL DEFAULT '{}',
        quality    REAL NOT NULL DEFAULT 0,
        first_seen BIGINT NOT NULL,
        last_seen  BIGINT NOT NULL
      );
      CREATE INDEX yt_songs_tokens_idx ON yt_songs USING GIN (tokens);
      CREATE INDEX yt_songs_genres_idx ON yt_songs USING GIN (genres);
      CREATE INDEX yt_songs_last_seen_idx ON yt_songs (last_seen);

      CREATE TABLE yt_pools (
        key        TEXT PRIMARY KEY,
        video_ids  TEXT[] NOT NULL,
        fetched_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL
      );
      CREATE INDEX yt_pools_expires_idx ON yt_pools (expires_at);

      CREATE TABLE yt_searches (
        key        TEXT PRIMARY KEY,
        video_ids  TEXT[] NOT NULL,
        fetched_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL
      );
      CREATE INDEX yt_searches_expires_idx ON yt_searches (expires_at);

      CREATE TABLE yt_playback (
        video_id        TEXT PRIMARY KEY,
        successes       INTEGER NOT NULL DEFAULT 0,
        failures        INTEGER NOT NULL DEFAULT 0,
        last_success_at BIGINT NOT NULL DEFAULT 0,
        last_failure_at BIGINT NOT NULL DEFAULT 0
      );

      CREATE TABLE artist_genres (
        name_key   TEXT PRIMARY KEY,
        genres     TEXT[] NOT NULL,
        fetched_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL
      );
      CREATE INDEX artist_genres_expires_idx ON artist_genres (expires_at);
    `,
  },
];

const MIGRATION_LOCK = 727001; // arbitrary constant; serialises migrations when two instances start together
const CHUNK = 100;

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

  // Upserts songs in chunks. Existing songs keep their title and artist, gain genres (up to the cap) and keep the best quality.
  async function upsertSongs(list, now) {
    const byId = new Map();
    for (const s of list) { const have = byId.get(s.id); byId.set(s.id, have ? { ...have, genres: mergeGenres(have.genres, s.genres), quality: Math.max(have.quality, s.quality) } : s); }
    const rows = [...byId.values()];
    for (let i = 0; i < rows.length; i += CHUNK) {
      const part = rows.slice(i, i + CHUNK), params = [], values = [];
      part.forEach((s, k) => {
        const o = k * 7;
        values.push(`($${o + 1},$${o + 2},$${o + 3},$${o + 4}::text[],$${o + 5}::text[],$${o + 6}::real,$${o + 7}::bigint,$${o + 7}::bigint)`);
        params.push(s.id, s.title, s.artist, tokensOf(s.title, s.artist), mergeGenres([], s.genres), Number(s.quality) || 0, now);
      });
      await q(
        `INSERT INTO yt_songs (video_id, title, artist, tokens, genres, quality, first_seen, last_seen) VALUES ${values.join(',')}
         ON CONFLICT (video_id) DO UPDATE SET
           genres = (SELECT COALESCE(array_agg(g), '{}') FROM (SELECT DISTINCT g FROM unnest(yt_songs.genres || EXCLUDED.genres) AS g LIMIT ${MAX_SONG_GENRES}) x),
           quality = GREATEST(yt_songs.quality, EXCLUDED.quality),
           last_seen = EXCLUDED.last_seen`,
        params);
    }
  }
  const songOf = (r) => ({ id: r.video_id, title: r.title, artist: r.artist, genres: r.genres || [], quality: Number(r.quality) || 0 });

  async function idsFor(table, keys, now) {
    if (!keys.length) return new Map();
    const res = await q(`SELECT key, video_ids FROM ${table} WHERE key = ANY($1::text[]) AND expires_at > $2`, [keys, now]);
    return new Map(res.rows.map((r) => [r.key, r.video_ids]));
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

    // ----- shared YouTube catalogue -----
    async putSongs(list, now = Date.now()) { await upsertSongs(list, now); },
    async putPool(key, list, ttlMs, now = Date.now()) {
      await upsertSongs(list, now);
      await q(
        `INSERT INTO yt_pools (key, video_ids, fetched_at, expires_at) VALUES ($1,$2::text[],$3,$4)
         ON CONFLICT (key) DO UPDATE SET video_ids = EXCLUDED.video_ids, fetched_at = EXCLUDED.fetched_at, expires_at = EXCLUDED.expires_at`,
        [key, list.map((s) => s.id), now, now + ttlMs]);
    },
    async getPools(keys, now = Date.now()) {
      const pools = await idsFor('yt_pools', keys, now), out = {};
      const all = [...new Set([...pools.values()].flat())];
      const bySong = new Map();
      if (all.length) {
        const rows = (await q('SELECT s.video_id, s.title, s.artist, s.genres, s.quality, p.successes, p.failures FROM yt_songs s LEFT JOIN yt_playback p USING (video_id) WHERE s.video_id = ANY($1::text[])', [all])).rows;
        for (const r of rows) bySong.set(r.video_id, r.successes === null || r.successes === undefined ? songOf(r) : { ...songOf(r), s: num(r.successes), f: num(r.failures) });
      }
      for (const [k, ids] of pools) out[k] = ids.map((id) => bySong.get(id)).filter(Boolean);
      return out;
    },
    async putSearch(key, ids, ttlMs, now = Date.now()) {
      await q(
        `INSERT INTO yt_searches (key, video_ids, fetched_at, expires_at) VALUES ($1,$2::text[],$3,$4)
         ON CONFLICT (key) DO UPDATE SET video_ids = EXCLUDED.video_ids, fetched_at = EXCLUDED.fetched_at, expires_at = EXCLUDED.expires_at`,
        [key, ids, now, now + ttlMs]);
    },
    async getSearches(keys, now = Date.now()) { return Object.fromEntries(await idsFor('yt_searches', keys, now)); },
    async addPlayback(id, successes, failures, now = Date.now()) {
      await q(
        `INSERT INTO yt_playback (video_id, successes, failures, last_success_at, last_failure_at) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (video_id) DO UPDATE SET successes = yt_playback.successes + EXCLUDED.successes, failures = yt_playback.failures + EXCLUDED.failures,
           last_success_at = GREATEST(yt_playback.last_success_at, EXCLUDED.last_success_at), last_failure_at = GREATEST(yt_playback.last_failure_at, EXCLUDED.last_failure_at)`,
        [id, successes, failures, successes ? now : 0, failures ? now : 0]);
    },
    async getPlayback(ids) {
      if (!ids.length) return {};
      const res = await q('SELECT video_id, successes, failures FROM yt_playback WHERE video_id = ANY($1::text[])', [ids]);
      return Object.fromEntries(res.rows.map((r) => [r.video_id, { successes: num(r.successes), failures: num(r.failures) }]));
    },
    async candidates(title, artist, limit = 40) {
      const want = tokensOf(title, artist);
      if (!want.length) return [];
      const res = await q(
        `SELECT video_id, title, artist, genres, quality, cardinality(ARRAY(SELECT unnest(tokens) INTERSECT SELECT unnest($1::text[]))) AS n
         FROM yt_songs WHERE tokens && $1::text[] ORDER BY n DESC, quality DESC LIMIT $2`,
        [want, limit]);
      return res.rows.map(songOf);
    },
    async genreSongs(genre, limit = 40, rand = Math.random) {
      // Rank by quality and community playback record, keep a generous top slice, then sample it so rooms do not all hear the same songs.
      const res = await q(
        `SELECT s.video_id, s.title, s.artist, s.genres, s.quality,
                s.quality + LEAST(5, COALESCE(p.successes, 0)) * 0.04 - COALESCE(p.failures, 0) * 1.25 AS score
         FROM yt_songs s LEFT JOIN yt_playback p USING (video_id)
         WHERE $1 = ANY(s.genres) AND COALESCE(p.failures, 0) * 1.25 - LEAST(5, COALESCE(p.successes, 0)) * 0.04 <= 1
         ORDER BY score DESC LIMIT $2`,
        [genre, Math.max(limit * 5, 200)]);
      const rows = res.rows.map(songOf);
      for (let i = rows.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [rows[i], rows[j]] = [rows[j], rows[i]]; }
      return rows.slice(0, limit);
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
      for (const t of ['yt_pools', 'yt_searches', 'artist_genres']) await q(`DELETE FROM ${t} WHERE expires_at <= $1`, [now]);
      // Songs nobody has seen for six months and that never played successfully are not worth the free-tier storage.
      await q('DELETE FROM yt_songs s WHERE s.last_seen < $1 AND NOT EXISTS (SELECT 1 FROM yt_playback p WHERE p.video_id = s.video_id AND p.successes > 0)', [now - 180 * 86400000]);
    },
    async stats() {
      const res = await q(`SELECT
        (SELECT count(*) FROM yt_songs) AS songs, (SELECT count(*) FROM yt_pools WHERE expires_at > $1) AS pools,
        (SELECT count(*) FROM yt_searches WHERE expires_at > $1) AS searches, (SELECT count(*) FROM yt_playback) AS rated,
        (SELECT COALESCE(sum(successes), 0) FROM yt_playback) AS plays, (SELECT COALESCE(sum(failures), 0) FROM yt_playback) AS fails,
        (SELECT count(*) FROM artist_genres WHERE expires_at > $1) AS artists, (SELECT count(*) FROM rooms) AS rooms`, [Date.now()]);
      const r = res.rows[0];
      return { songs: num(r.songs), pools: num(r.pools), searches: num(r.searches), ratedVideos: num(r.rated), playbackSuccesses: num(r.plays), playbackFailures: num(r.fails), artists: num(r.artists), rooms: num(r.rooms) };
    },
    _migrations: MIGRATIONS,
  };
}

module.exports = { createPgStore, MIGRATIONS };
