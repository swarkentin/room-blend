'use strict';
// A room's play log and the recap built from it ("what did we play tonight").
//
// The log is one row per song played: when, what, which genres, how many people were listening, and how the room voted. It holds no
// guest names or ids, and it is filed under an opaque hash of the room, not the room code. It exists for the host's recap now, and for
// learning which genre mixes work later (see docs/ROADMAP.md), which is why it is worth recording before anyone needs it.
const crypto = require('crypto');

/** Opaque, stable id for a room's log. Cannot be turned back into the room code, and a reused code gets a new log. */
const roomHash = (code, createdAt) => crypto.createHash('sha256').update('rb-room\n' + code + '\n' + createdAt).digest('hex').slice(0, 24);

/** Log rows for the room's most recent plays. Writing a row again updates its votes, so a few recent songs are rewritten each time. */
function playRows(room, last = 4) {
  return room.history.slice(-last).filter((h) => h && h.track && Number.isFinite(h.at)).map((h) => {
    const c = room.voteCounts(h.track.id);
    return {
      at: Math.floor(h.at), trackId: String(h.track.id).slice(0, 80), title: String(h.track.title || '').slice(0, 160), artist: String(h.track.artist || '').slice(0, 160),
      genres: Array.isArray(h.track.genres) ? h.track.genres.filter((g) => typeof g === 'string').slice(0, 6) : [], mode: String(h.mode || 'blend').slice(0, 20),
      present: Math.max(0, Math.floor(h.present) || 0), up: c.up || 0, down: c.down || 0, skips: c.skip || 0,
    };
  });
}

/** Rows from the database and from the live room, merged. A live row wins, because its votes are newer. */
function mergeRows(stored, live) {
  const byAt = new Map();
  for (const r of stored) byAt.set(r.at, r);
  for (const r of live) byAt.set(r.at, r);
  return [...byAt.values()].sort((a, b) => a.at - b.at);
}

/** Totals for a set of plays. `since` limits it to one session, for example the last night. */
function recap(rows, { since = 0 } = {}) {
  const plays = rows.filter((r) => r.at >= since);
  const genres = new Map(), by = { blend: 0, request: 0, other: 0 };
  let peak = 0, up = 0, down = 0, skipped = 0, present = 0;
  for (const r of plays) {
    for (const g of new Set(r.genres)) genres.set(g, (genres.get(g) || 0) + 1);
    by[r.mode === 'blend' || r.mode === 'request' ? r.mode : 'other']++;
    peak = Math.max(peak, r.present); present += r.present; up += r.up; down += r.down;
    if (r.skips > 0) skipped++;
  }
  const brief = (r) => ({ title: r.title, artist: r.artist, up: r.up, down: r.down, at: r.at });
  const scored = plays.filter((r) => r.up + r.down > 0).map((r) => ({ r, net: r.up - r.down }));
  return {
    songs: plays.length,
    from: plays.length ? plays[0].at : null, to: plays.length ? plays[plays.length - 1].at : null,
    minutes: plays.length > 1 ? Math.round((plays[plays.length - 1].at - plays[0].at) / 60000) : 0,
    peakListeners: peak, avgListeners: plays.length ? Math.round((present / plays.length) * 10) / 10 : 0,
    requests: by.request, blended: by.blend,
    genres: [...genres].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 8).map(([genre, n]) => ({ genre, plays: n, share: Math.round((n / plays.length) * 100) })),
    votes: { up, down }, skippedByGuests: skipped,
    topVoted: scored.filter((x) => x.net > 0).sort((a, b) => b.net - a.net || b.r.at - a.r.at).slice(0, 5).map((x) => brief(x.r)),
    leastLiked: scored.filter((x) => x.net < 0).sort((a, b) => a.net - b.net || b.r.at - a.r.at).slice(0, 5).map((x) => brief(x.r)),
  };
}

module.exports = { roomHash, playRows, mergeRows, recap };
