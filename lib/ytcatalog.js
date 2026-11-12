'use strict';
// The shared YouTube catalogue: what every host's browser learns about songs, kept in one place.
//
// A host's browser used to keep its own pools, song lookups and playback record, so every host paid the YouTube quota again and
// a video that failed for one host was tried again by the next. Now browsers read and write here (through /api/catalog/*, host
// authenticated), and the browser's IndexedDB stays as a fast local layer in front.
//
// Everything in here arrives from browsers, so every field is validated and bounded before it reaches the store: a shared catalogue
// that anyone can fill with junk is worse than none.
const { MAX_SONG_GENRES } = require('./store');

const DAY = 86400000;
const LIMITS = { keys: 40, poolSongs: 600, searchIds: 12, importPools: 60, importSearches: 400, importQuality: 1500, qualityIds: 300, keyLen: 220, text: 160, playbackTally: 50 };
const ID_RE = /^[A-Za-z0-9_-]{3,20}$/;
const clean = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const ttl = (days, fallback) => Math.round(Math.min(90, Math.max(1 / 24, Number.isFinite(Number(days)) ? Number(days) : fallback)) * DAY);

/** @param {{store: any, genres: string[]}} deps */
function createCatalog({ store, genres: allowed }) {
  const allowedSet = new Set(allowed);
  const genreList = (list, extra) => {
    const out = [];
    for (const g of [...(Array.isArray(list) ? list : []), ...(Array.isArray(extra) ? extra : [])]) if (typeof g === 'string' && allowedSet.has(g) && !out.includes(g)) out.push(g);
    return out.slice(0, MAX_SONG_GENRES);
  };
  function song(raw, tags) {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !ID_RE.test(raw.id)) return null;
    const title = clean(raw.title, LIMITS.text), artist = clean(raw.artist, LIMITS.text);
    if (!title || !artist) return null;
    const quality = Math.min(20, Math.max(-20, Number(raw.quality) || 0));
    return { id: raw.id, title, artist, genres: genreList(raw.genres, tags), quality };
  }
  const songs = (list, tags) => (Array.isArray(list) ? list.slice(0, LIMITS.poolSongs).map((s) => song(s, tags)).filter(Boolean) : []);
  const key = (k) => { const v = clean(k, LIMITS.keyLen); return v ? v : ''; };
  const ids = (list, max = LIMITS.searchIds) => (Array.isArray(list) ? list.filter((x) => typeof x === 'string' && ID_RE.test(x)).slice(0, max) : []);
  const keys = (list) => (Array.isArray(list) ? list.slice(0, LIMITS.keys).map(key).filter(Boolean) : []);

  return {
    /** Batch read: pools by key, song lookups by key, playback record by video id. Missing or expired entries are simply absent. */
    async get(body) {
      const poolKeys = keys(body.pools), searchKeys = keys(body.searches), qualityIds = ids(body.quality, LIMITS.qualityIds);
      const [pools, searches, quality] = await Promise.all([
        poolKeys.length ? store.getPools(poolKeys) : {}, searchKeys.length ? store.getSearches(searchKeys) : {}, qualityIds.length ? store.getPlayback(qualityIds) : {},
      ]);
      return { pools, searches, quality };
    },
    /** Batch write of discoveries. `tags` on a pool are the genres its query stands for, and are added to every song in it. */
    async put(body) {
      let pools = 0, searches = 0;
      for (const p of (Array.isArray(body.pools) ? body.pools : []).slice(0, LIMITS.keys)) {
        const k = key(p && p.key); if (!k) continue;
        const list = songs(p.songs, genreList(p.tags));
        await store.putPool(k, list, ttl(p.ttlDays, list.length ? 30 : 0.5)); pools++;
      }
      for (const s of (Array.isArray(body.searches) ? body.searches : []).slice(0, LIMITS.keys)) {
        const k = key(s && s.key); if (!k) continue;
        const list = ids(s.ids);
        await store.putSearch(k, list, ttl(s.ttlDays, list.length ? 30 : 0.25)); searches++;
      }
      return { pools, searches };
    },
    /** One playback outcome. A successful play also files the song (with genres) so other hosts can find it. */
    async feedback(body) {
      if (typeof body.id !== 'string' || !ID_RE.test(body.id) || typeof body.ok !== 'boolean') return false;
      await store.addPlayback(body.id, body.ok ? 1 : 0, body.ok ? 0 : 1);
      if (body.ok && body.song) { const s = song({ ...body.song, id: body.id }); if (s) await store.putSongs([s]); }
      return true;
    },
    async candidates(title, artist) { return store.candidates(clean(title, LIMITS.text), clean(artist, LIMITS.text), 40); },
    async genre(genre, limit) {
      if (!allowedSet.has(genre)) return [];
      return store.genreSongs(genre, Math.min(100, Math.max(1, Math.floor(Number(limit)) || 40)));
    },
    /** A host's browser hands over what it already learned, once. Capped so one browser cannot dominate the playback record. */
    async importBulk(body) {
      let pools = 0, searches = 0, quality = 0;
      for (const p of (Array.isArray(body.pools) ? body.pools : []).slice(0, LIMITS.importPools)) {
        const k = key(p && p.key); if (!k) continue;
        const list = songs(p.songs, genreList(p.tags));
        if (list.length) { await store.putPool(k, list, ttl(p.ttlDays, 30)); pools++; }
      }
      for (const s of (Array.isArray(body.searches) ? body.searches : []).slice(0, LIMITS.importSearches)) {
        const k = key(s && s.key), list = ids(s && s.ids);
        if (k && list.length) { await store.putSearch(k, list, ttl(s.ttlDays, 30)); searches++; }
      }
      for (const r of (Array.isArray(body.quality) ? body.quality : []).slice(0, LIMITS.importQuality)) {
        if (!r || typeof r.id !== 'string' || !ID_RE.test(r.id)) continue;
        const cap = (n) => Math.min(LIMITS.playbackTally, Math.max(0, Math.floor(Number(n)) || 0));
        const s = cap(r.successes), f = cap(r.failures);
        if (s || f) { await store.addPlayback(r.id, s, f); quality++; }
      }
      return { pools, searches, quality };
    },
    stats: () => store.stats(),
  };
}

module.exports = { createCatalog, LIMITS };
