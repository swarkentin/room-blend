'use strict';
// The shared YouTube catalogue. It holds two things, and only two, because they are what other hosts can safely reuse:
//
//   song lookups   which video answers "this title by this artist". The expensive part: each is a YouTube search call from a limited daily quota.
//   video quality  in how many rooms a video played, and in how many it failed (blocked, removed, not embeddable).
//
// Neither is taken on a host's word. Both are built from votes, and a vote is one room reporting one play or failure:
//   - a room counts once per video however often it reports, so one host cannot steer everyone's results;
//   - a lookup is served only after at least CATALOG_QUORUM different rooms played the same video for it (default 2);
//   - a video that has failed in more rooms than it has played in is never served.
// Genre playlists, song lists and everything else a host discovers stay in that host's browser, so nobody can tag songs into a genre.
//
// A voter is currently the room. When hosts can sign in, the voter becomes the account, so one person with ten rooms still counts once.
const crypto = require('crypto');

const LIMITS = { keys: 40, qualityIds: 300, keyLen: 220 };
const ID_RE = /^[A-Za-z0-9_-]{3,20}$/;
const clean = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** An opaque, stable voter id for a room. It reveals neither the room code nor the host key. */
const voterFor = (code, hostKey) => crypto.createHash('sha256').update('rb-voter\n' + code + '\n' + hostKey).digest('hex').slice(0, 24);

/** @param {{store: any, quorum?: number}} deps */
function createCatalog({ store, quorum = 2 }) {
  const need = Math.max(1, Math.floor(quorum) || 2);
  const keys = (list) => (Array.isArray(list) ? list.slice(0, LIMITS.keys).map((k) => clean(k, LIMITS.keyLen)).filter(Boolean) : []);
  const ids = (list) => (Array.isArray(list) ? list.filter((x) => typeof x === 'string' && ID_RE.test(x)).slice(0, LIMITS.qualityIds) : []);
  return {
    quorum: need,
    /** Batch read. `searches` are song lookup keys, `quality` are video ids. Anything unconfirmed or unknown is simply absent. */
    async get(body) {
      const searchKeys = keys(body.searches), qualityIds = ids(body.quality);
      const [searches, quality] = await Promise.all([searchKeys.length ? store.getSearches(searchKeys, need) : {}, qualityIds.length ? store.getPlayback(qualityIds) : {}]);
      return { searches, quality };
    },
    /** One room's report: `ok` says whether the video played. With `key`, a good play also votes for that song lookup. */
    async feedback(body, voter) {
      if (typeof body.id !== 'string' || !ID_RE.test(body.id) || typeof body.ok !== 'boolean') return false;
      const key = body.key === undefined || body.key === null ? '' : clean(body.key, LIMITS.keyLen);
      await store.recordPlay(voter, body.id, body.ok, key || undefined);
      return true;
    },
    stats: () => store.stats(need),
  };
}

module.exports = { createCatalog, voterFor, LIMITS };
