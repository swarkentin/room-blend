'use strict';
const GenreMap = require('../public/genremap');
const Engine = require('./engine');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createClient({ fetchImpl = globalThis.fetch, intervalMs = 1100, now = Date.now, timeoutMs = 5000 } = {}) {
  const cache = new Map();
  const pending = new Map();
  let queue = Promise.resolve();
  let nextRequestAt = 0;

  async function request(url) {
    let release;
    const previous = queue;
    queue = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      for (let attempt = 0; ; attempt++) {
        const delay = Math.max(0, nextRequestAt - now());
        if (delay) await wait(delay);
        nextRequestAt = now() + intervalMs;
        const response = await fetchImpl(url, {
          headers: { 'User-Agent': 'RoomBlend/0.1.0 (https://github.com/swarkentin/room-blend)' },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.status === 503 && attempt === 0) {
          await response.body?.cancel();
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
      const url = new URL('https://musicbrainz.org/ws/2/artist/');
      url.search = new URLSearchParams({ query: `artist:"${String(name).replace(/["\\]/g, ' ')}"`, fmt: 'json', limit: '5' });
      const data = await request(url);
      const artist = (data.artists || [])
        .filter((a) => {
          const exact = Engine.normKey(a.name) === key || (a.aliases || []).some((alias) => Engine.normKey(alias.name) === key);
          return exact && Number(a.score) >= 90;
        })
        .sort((a, b) => Number(b.score) - Number(a.score))[0];
      const votes = new Map();
      for (const tag of artist && Array.isArray(artist.tags) ? artist.tags : []) {
        const count = Number(tag.count);
        if (!(count > 0) || typeof tag.name !== 'string') continue;
        for (const genre of GenreMap.classifyAll(tag.name, 3)) {
          if (Engine.HOLIDAYS.includes(genre)) continue;
          votes.set(genre, (votes.get(genre) || 0) + count);
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

  return { lookupArtist };
}

module.exports = { createClient };
