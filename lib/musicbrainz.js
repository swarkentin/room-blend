'use strict';
const GenreMap = require('../public/genremap');
const Engine = require('./engine');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @typedef {{id?: unknown, name?: unknown, score?: unknown, aliases?: Array<{name?: unknown}>}} MbArtist
 * @typedef {{name?: unknown, artist?: {name?: unknown}, joinphrase?: unknown}} MbCreditPart
 * @typedef {{title?: unknown, score?: unknown, id?: unknown, 'artist-credit'?: Array<MbCreditPart>}} MbRecording
 * @typedef {{title?: unknown, score?: unknown, id?: unknown, 'artist-credit'?: Array<MbCreditPart>}} MbReleaseGroup
 * @typedef {{artists?: MbArtist[], recordings?: MbRecording[], 'release-groups'?: MbReleaseGroup[], genres?: Array<{name?: unknown, count?: unknown}>, releases?: Array<{id?: unknown}> , media?: Array<{tracks?: Array<{title?: unknown, recording?: MbRecording, 'artist-credit'?: Array<MbCreditPart>}>}>}} MbSearchResponse
 */

function createClient({ fetchImpl = globalThis.fetch, intervalMs = 1100, now = Date.now, timeoutMs = 5000 } = {}) {
  const cache = new Map();
  const pending = new Map();
  const searchCache = new Map();
  const pendingSearches = new Map();
  let queue = Promise.resolve();
  let nextRequestAt = 0;

  /** @param {URL} url @returns {Promise<MbSearchResponse>} */
  async function request(url) {
    /** @type {() => void} */
    let release = () => {};
    const previous = queue;
    queue = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      for (let attempt = 0; ; attempt++) {
        const delay = Math.max(0, nextRequestAt - now());
        if (delay) await wait(delay);
        nextRequestAt = now() + intervalMs;
        if (typeof fetchImpl !== 'function') throw new Error('Fetch is unavailable for MusicBrainz lookups');
        const response = await fetchImpl(url, {
          headers: { 'User-Agent': 'RoomBlend/0.1.0 (https://github.com/swarkentin/room-blend)' },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.status === 503 && attempt === 0) {
          if (response.body) await response.body.cancel();
          continue;
        }
        if (!response.ok) throw new Error(`MusicBrainz returned HTTP ${response.status}`);
        return await response.json();
      }
    } finally {
      release();
    }
  }

  async function lookupArtist(name) {
    const key = Engine.normKey(name);
    if (!key) return [];
    if (cache.has(key)) return cache.get(key);
    if (pending.has(key)) return pending.get(key);

    const task = (async () => {
      // Search only resolves the artist identity. MusicBrainz does not include
      // entity tags/genres in search results; those require an MBID lookup.
      const url = new URL('https://musicbrainz.org/ws/2/artist/');
      url.search = new URLSearchParams({ query: `artist:"${String(name).replace(/["\\\\]/g, ' ')}"`, fmt: 'json', limit: '25' }).toString();
      const data = await request(url);
      const artist = (data.artists || [])
        .filter((a) => {
          const exact = Engine.normKey(a.name) === key || (Array.isArray(a.aliases) && a.aliases.some((alias) => Engine.normKey(alias.name) === key));
          return exact && Number(a.score) >= 80 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(a.id || ''));
        })
        .sort((a, b) => Number(b.score) - Number(a.score))[0];
      if (!artist) return [];

      // Request MusicBrainz's curated genre list, not arbitrary folksonomy tags
      // (which can include moods, eras, locations, jokes and unrelated metadata).
      const detailUrl = new URL(`https://musicbrainz.org/ws/2/artist/${artist.id}`);
      detailUrl.search = new URLSearchParams({ inc: 'genres', fmt: 'json' }).toString();
      const detail = await request(detailUrl);
      const votes = new Map();
      for (const genre of Array.isArray(detail.genres) ? detail.genres : []) {
        const count = Number(genre.count);
        if (!(count > 0) || typeof genre.name !== 'string') continue;
        for (const canonical of GenreMap.classifyAll(genre.name, 3)) {
          if (Engine.HOLIDAYS.includes(canonical)) continue;
          votes.set(canonical, (votes.get(canonical) || 0) + count);
        }
      }
      return [...votes].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([genre, count]) => ({ genre, count }));
    })();
    pending.set(key, task);
    try {
      const genres = await task;
      cache.set(key, genres);
      if (cache.size > 5000) cache.delete(cache.keys().next().value);
      return genres;
    } finally {
      pending.delete(key);
    }
  }

  function creditName(credit) {
    if (!Array.isArray(credit)) return '';
    return credit.map((part) => String(part.name || (part.artist && part.artist.name) || '') + String(part.joinphrase || '')).join('').trim();
  }

  async function searchEntity(entity, query, artist) {
    const url = new URL(`https://musicbrainz.org/ws/2/${entity}/`);
    const escaped = (value) => String(value).replace(/["\\]/g, ' ');
    const fieldQuery = entity === 'recording'
      ? (artist ? `recording:"${escaped(query)}" AND artist:"${escaped(artist)}"` : `(recording:"${escaped(query)}" OR artist:"${escaped(query)}")`)
      : `${entity === 'artist' ? 'artist' : 'releasegroup'}:"${escaped(query)}"`;
    url.search = new URLSearchParams({ query: fieldQuery, fmt: 'json', limit: '8' }).toString();
    return request(url);
  }

  async function search(query, artist) {
    const q = String(query || '').trim().replace(/\s+/g, ' ');
    const a = String(artist || '').trim().replace(/\s+/g, ' ');
    const key = Engine.normKey(q) + (a ? '|' + Engine.normKey(a) : '');
    if (Engine.normKey(q).length < 2) return { artists: [], songs: [], albums: [] };
    if (searchCache.has(key)) return searchCache.get(key);
    if (pendingSearches.has(key)) return pendingSearches.get(key);

    const task = (async () => {
      if (a) {
        const recordingData = await searchEntity('recording', q, a);
        const minScore = (result) => Number(result.score) >= 65;
        const songs = (recordingData.recordings || [])
          .filter((recording) => typeof recording.title === 'string' && minScore(recording))
          .map((recording) => ({ title: recording.title, artist: creditName(recording['artist-credit']), source: 'musicbrainz' }))
          .filter((song) => song.artist);
        return { artists: [], songs, albums: [] };
      }
      const [artistData, recordingData, albumData] = await Promise.all([
        searchEntity('artist', q),
        searchEntity('recording', q),
        searchEntity('release-group', q),
      ]);
      const minScore = (result) => Number(result.score) >= 65;
      const artists = (artistData.artists || [])
        .filter((artist) => typeof artist.name === 'string' && minScore(artist))
        .map((artist) => ({ name: artist.name, songs: 0, source: 'musicbrainz' }));
      const songs = (recordingData.recordings || [])
        .filter((recording) => typeof recording.title === 'string' && minScore(recording))
        .map((recording) => ({ title: recording.title, artist: creditName(recording['artist-credit']), source: 'musicbrainz' }))
        .filter((song) => song.artist);
      const albums = (albumData['release-groups'] || [])
        .filter((album) => typeof album.title === 'string' && typeof album.id === 'string' && minScore(album))
        .map((album) => ({ id: album.id, title: album.title, artist: creditName(album['artist-credit']) }))
        .filter((album) => album.artist);
      return { artists, songs, albums };
    })();
    pendingSearches.set(key, task);
    try {
      const result = await task;
      searchCache.set(key, result);
      if (searchCache.size > 1000) searchCache.delete(searchCache.keys().next().value);
      return result;
    } finally {
      pendingSearches.delete(key);
    }
  }

  async function albumTracks(id) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id || ''))) return [];
    const groupUrl = new URL(`https://musicbrainz.org/ws/2/release-group/${id}`);
    groupUrl.search = new URLSearchParams({ inc: 'releases', fmt: 'json' }).toString();
    const group = await request(groupUrl);
    const release = (group.releases || []).find((item) => typeof item.id === 'string');
    if (!release) return [];

    const releaseUrl = new URL(`https://musicbrainz.org/ws/2/release/${release.id}`);
    releaseUrl.search = new URLSearchParams({ inc: 'recordings+artist-credits', fmt: 'json' }).toString();
    const data = await request(releaseUrl);
    const fallbackArtist = creditName(data['artist-credit']);
    const out = [], seen = new Set();
    for (const medium of data.media || []) for (const track of medium.tracks || []) {
      const title = typeof track.title === 'string' ? track.title : track.recording && track.recording.title;
      const artist = creditName((track.recording && track.recording['artist-credit']) || track['artist-credit']) || fallbackArtist;
      if (typeof title !== 'string' || !artist) continue;
      const key = Engine.songKey(title, artist);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ title, artist });
      if (out.length >= 5) return out;
    }
    return out;
  }

  return { lookupArtist, search, albumTracks };
}

module.exports = { createClient };
