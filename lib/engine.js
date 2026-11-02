'use strict';
// Room blend engine. Pure functions: no I/O, no clock, no randomness (jitter is seeded).
//
// A person is a taste vector over canonical genres. A genre graph says which genres sit
// close together, so "rock + blues" lands on blues rock instead of an empty intersection.
// For every candidate song we score each person's fit, then score the room as a blend of
// the least-happy person and the average. If nothing scores above a threshold the room
// has no real overlap, and slots rotate between people by who has been served least.

// Genres are listed in groups so the picker can show them in sensible sections.
const GENRE_GROUPS = [
  ['Rock', ['rock', 'classic rock', 'hard rock', 'alternative', 'indie', 'grunge', 'punk', 'pop punk', 'new wave', 'metal', 'emo', 'shoegaze', 'post-rock']],
  ['Roots', ['blues', 'country', 'folk', 'americana', 'singer-songwriter']],
  ['Jazz and soul', ['jazz', 'swing', 'bossa nova', 'soul', 'r&b', 'funk', 'disco', 'gospel', 'neo soul']],
  ['Pop', ['pop', 'dance pop', 'synth pop', 'k-pop', 'hyperpop']],
  ['Electronic', ['electronic', 'house', 'techno', 'edm', 'dubstep', 'drum and bass', 'idm', 'ambient', 'downtempo', 'chillout', 'lo-fi', 'trip hop', 'synthwave', 'chillwave']],
  ['Hip hop', ['hip hop', 'trap']],
  ['World', ['reggae', 'ska', 'dancehall', 'latin', 'reggaeton', 'afrobeats', 'amapiano']],
  ['Classical', ['classical']],
  ['Holiday', ['christmas', 'halloween']],
];
// Holiday genres are seasonal. A song tagged with one is only played when someone in the room has picked that holiday,
// and there is no "All holiday" broad pick, so a holiday has to be asked for by name.
const HOLIDAYS = ['christmas', 'halloween'];
const GENRES = GENRE_GROUPS.flatMap((g) => g[1]);

// Friendly shortcuts for concepts that span several canonical genres. These are picks,
// not song tags: keeping them as expansions lets the catalogue and similarity graph stay
// compact while guests can still choose the music they mean.
const GENRE_ALIASES = {
  '70s': ['classic rock', 'disco', 'funk', 'soul', 'country', 'folk'],
  '80s': ['classic rock', 'new wave', 'synth pop', 'dance pop', 'pop', 'funk'],
  '90s': ['alternative', 'grunge', 'hip hop', 'pop', 'r&b', 'dance pop'],
  '00s': ['alternative', 'hip hop', 'pop', 'r&b', 'house', 'emo'],
  '2010s': ['indie', 'pop', 'hip hop', 'edm', 'dance pop', 'electronic'],
  '2020s': ['pop', 'hip hop', 'r&b', 'dance pop', 'electronic', 'hyperpop'],
  rap: ['hip hop'],
  drill: ['hip hop', 'trap'],
  phonk: ['trap', 'hip hop'],
  'korean pop': ['k-pop'],
  'japanese pop': ['pop', 'k-pop'],
  'indie rock': ['indie', 'alternative', 'rock'],
  'classic r&b': ['r&b', 'soul'],
  'modern r&b': ['r&b', 'neo soul'],
  'latin pop': ['latin', 'pop'],
  'christian music': ['gospel'],
};
const GENRE_ALIAS_GROUPS = [
  ['Eras', ['70s', '80s', '90s', '00s', '2010s', '2020s']],
  ['More styles', ['rap', 'drill', 'phonk', 'korean pop', 'japanese pop', 'indie rock', 'classic r&b', 'modern r&b', 'latin pop', 'christian music']],
];

// A broad pick ("any:rock") means "I like this whole family". It stands for every genre in the group.
const groupId = (name) => 'any:' + name.toLowerCase().replace(/\s+/g, '-');
const GROUPS = Object.fromEntries(GENRE_GROUPS.filter((g) => g[1].length > 1 && g[0] !== 'Holiday').map((g) => [groupId(g[0]), g[1]]));
const isPick = (x) => typeof x === 'string' && (GENRES.includes(x) || Object.prototype.hasOwnProperty.call(GROUPS, x) || Object.prototype.hasOwnProperty.call(GENRE_ALIASES, x));
// Genres a pick stands for, and a person's taste vector from their ordered picks (first counts most).
const expandPick = (x) => (GROUPS[x] || GENRE_ALIASES[x] || [x]);
/** @param {string[]} picks @param {number[]} [weights] @returns {Taste} */
function tasteFromPicks(picks, weights = [4, 3, 2, 1]) {
  /** @type {Taste} */
  const t = {};
  picks.forEach((x, i) => {
    const w = weights[i] || 1, gs = expandPick(x);
    for (const g of gs) t[g] = (t[g] || 0) + w / gs.length;
  });
  return t;
}

// Neighbouring genres and how close they feel (0..1). The transitive closure fills in the rest.
/** @type {Array<[string, string, number]>} Hand-written genre links with a closeness from 0 to 1. */
const EDGES = [
  // rock family
  ['rock', 'classic rock', 0.8], ['rock', 'hard rock', 0.7], ['rock', 'alternative', 0.7], ['rock', 'grunge', 0.7], ['rock', 'indie', 0.6], ['rock', 'punk', 0.55], ['rock', 'metal', 0.5], ['rock', 'blues', 0.5], ['rock', 'pop', 0.4], ['rock', 'americana', 0.4],
  ['classic rock', 'hard rock', 0.7], ['classic rock', 'blues', 0.6], ['classic rock', 'americana', 0.5], ['classic rock', 'country', 0.4], ['classic rock', 'folk', 0.4], ['classic rock', 'singer-songwriter', 0.4],
  ['hard rock', 'metal', 0.7], ['hard rock', 'grunge', 0.6], ['hard rock', 'blues', 0.4],
  ['alternative', 'indie', 0.8], ['alternative', 'grunge', 0.7], ['alternative', 'new wave', 0.6], ['alternative', 'emo', 0.6], ['alternative', 'punk', 0.5], ['alternative', 'pop punk', 0.5],
  ['indie', 'singer-songwriter', 0.6], ['indie', 'folk', 0.5], ['indie', 'lo-fi', 0.5], ['indie', 'synth pop', 0.5], ['indie', 'emo', 0.5], ['indie', 'pop', 0.4],
  ['grunge', 'punk', 0.5], ['grunge', 'metal', 0.4],
  ['punk', 'pop punk', 0.8], ['punk', 'new wave', 0.5], ['punk', 'ska', 0.4], ['punk', 'metal', 0.4],
  ['pop punk', 'emo', 0.7], ['pop punk', 'pop', 0.4],
  ['new wave', 'synth pop', 0.7], ['new wave', 'electronic', 0.4],
  // roots
  ['blues', 'jazz', 0.5], ['blues', 'soul', 0.6], ['blues', 'r&b', 0.5], ['blues', 'country', 0.4], ['blues', 'folk', 0.4], ['blues', 'gospel', 0.4],
  ['country', 'americana', 0.8], ['country', 'folk', 0.7], ['country', 'singer-songwriter', 0.6], ['country', 'pop', 0.4],
  ['folk', 'americana', 0.8], ['folk', 'singer-songwriter', 0.8], ['americana', 'singer-songwriter', 0.6],
  // jazz and soul
  ['jazz', 'swing', 0.7], ['jazz', 'soul', 0.6], ['jazz', 'bossa nova', 0.6], ['jazz', 'funk', 0.4], ['jazz', 'lo-fi', 0.4], ['jazz', 'classical', 0.3], ['jazz', 'r&b', 0.3],
  ['bossa nova', 'latin', 0.5], ['bossa nova', 'folk', 0.3],
  ['soul', 'r&b', 0.8], ['soul', 'funk', 0.7], ['soul', 'gospel', 0.6], ['soul', 'hip hop', 0.5], ['soul', 'pop', 0.4], ['soul', 'reggae', 0.4],
  ['r&b', 'hip hop', 0.6], ['r&b', 'pop', 0.6], ['r&b', 'afrobeats', 0.5], ['r&b', 'dance pop', 0.4], ['r&b', 'trap', 0.4],
  ['funk', 'disco', 0.7], ['funk', 'hip hop', 0.4], ['funk', 'reggae', 0.3],
  ['disco', 'dance pop', 0.6], ['disco', 'house', 0.6], ['disco', 'pop', 0.5],
  // pop
  ['pop', 'dance pop', 0.8], ['pop', 'synth pop', 0.7], ['pop', 'k-pop', 0.6], ['pop', 'electronic', 0.5], ['pop', 'hip hop', 0.5], ['pop', 'latin', 0.5],
  ['dance pop', 'edm', 0.6], ['dance pop', 'k-pop', 0.6], ['dance pop', 'synth pop', 0.6], ['dance pop', 'house', 0.5], ['dance pop', 'reggaeton', 0.4],
  ['synth pop', 'electronic', 0.6],
  // electronic
  ['electronic', 'house', 0.8], ['electronic', 'edm', 0.8], ['electronic', 'techno', 0.7], ['electronic', 'drum and bass', 0.6], ['electronic', 'ambient', 0.6], ['electronic', 'lo-fi', 0.5],
  ['house', 'techno', 0.7], ['house', 'edm', 0.7], ['techno', 'edm', 0.5], ['techno', 'drum and bass', 0.4],
  ['ambient', 'lo-fi', 0.6], ['ambient', 'classical', 0.4], ['lo-fi', 'hip hop', 0.5],
  // hip hop
  ['hip hop', 'trap', 0.8], ['hip hop', 'reggae', 0.3], ['hip hop', 'afrobeats', 0.4], ['trap', 'edm', 0.3], ['trap', 'reggaeton', 0.4],
  // world
  ['reggae', 'dancehall', 0.8], ['reggae', 'ska', 0.7], ['reggae', 'latin', 0.4], ['dancehall', 'reggaeton', 0.6], ['dancehall', 'afrobeats', 0.6], ['reggaeton', 'latin', 0.8], ['afrobeats', 'pop', 0.4],
  // modern and electronic additions
  ['idm', 'electronic', 0.7], ['idm', 'ambient', 0.6], ['idm', 'downtempo', 0.6], ['idm', 'techno', 0.5], ['idm', 'drum and bass', 0.4],
  ['downtempo', 'ambient', 0.6], ['downtempo', 'chillout', 0.8], ['downtempo', 'trip hop', 0.7], ['downtempo', 'lo-fi', 0.5], ['downtempo', 'electronic', 0.5], ['downtempo', 'chillwave', 0.5],
  ['chillout', 'ambient', 0.6], ['chillout', 'lo-fi', 0.6], ['chillout', 'house', 0.4],
  ['trip hop', 'hip hop', 0.5], ['trip hop', 'electronic', 0.5], ['trip hop', 'ambient', 0.4], ['trip hop', 'alternative', 0.4], ['trip hop', 'soul', 0.4],
  ['synthwave', 'synth pop', 0.8], ['synthwave', 'electronic', 0.6], ['synthwave', 'new wave', 0.6], ['synthwave', 'chillwave', 0.5],
  ['chillwave', 'indie', 0.5], ['chillwave', 'synth pop', 0.6], ['chillwave', 'lo-fi', 0.5], ['chillwave', 'electronic', 0.5],
  ['dubstep', 'edm', 0.8], ['dubstep', 'electronic', 0.6], ['dubstep', 'drum and bass', 0.6], ['dubstep', 'trap', 0.4],
  ['hyperpop', 'pop', 0.6], ['hyperpop', 'dance pop', 0.6], ['hyperpop', 'synth pop', 0.6], ['hyperpop', 'electronic', 0.5], ['hyperpop', 'edm', 0.4], ['hyperpop', 'trap', 0.4],
  ['shoegaze', 'indie', 0.7], ['shoegaze', 'alternative', 0.7], ['shoegaze', 'post-rock', 0.6], ['shoegaze', 'ambient', 0.4], ['shoegaze', 'grunge', 0.4],
  ['post-rock', 'ambient', 0.5], ['post-rock', 'indie', 0.5], ['post-rock', 'alternative', 0.5], ['post-rock', 'electronic', 0.4],
  ['neo soul', 'soul', 0.8], ['neo soul', 'r&b', 0.8], ['neo soul', 'jazz', 0.5], ['neo soul', 'hip hop', 0.5], ['neo soul', 'funk', 0.5], ['neo soul', 'lo-fi', 0.4],
  ['amapiano', 'afrobeats', 0.7], ['amapiano', 'house', 0.6], ['amapiano', 'dancehall', 0.4],
  // holidays: only a few close neighbours, because holiday songs carry their own style tags
  ['christmas', 'pop', 0.45], ['christmas', 'gospel', 0.5], ['christmas', 'swing', 0.5], ['christmas', 'jazz', 0.45], ['christmas', 'classical', 0.45], ['christmas', 'soul', 0.4], ['christmas', 'country', 0.35], ['christmas', 'folk', 0.35], ['christmas', 'classic rock', 0.35],
  ['halloween', 'metal', 0.5], ['halloween', 'hard rock', 0.45], ['halloween', 'punk', 0.4], ['halloween', 'new wave', 0.45], ['halloween', 'synthwave', 0.4], ['halloween', 'classical', 0.35], ['halloween', 'alternative', 0.4], ['halloween', 'classic rock', 0.35],
];

/** @type {Record<string, number>} */
const IDX = Object.fromEntries(GENRES.map((g, i) => [g, i]));
const N = GENRES.length;
/** @type {number[][]} Similarity between genres by index, 0 to 1. */
const SIM = Array.from({ length: N }, (_, i) => Array.from({ length: N }, (_, j) => (i === j ? 1 : 0)));
for (const [a, b, v] of EDGES) {
  SIM[IDX[a]][IDX[b]] = Math.max(SIM[IDX[a]][IDX[b]], v);
  SIM[IDX[b]][IDX[a]] = SIM[IDX[a]][IDX[b]];
}
for (let k = 0; k < N; k++) for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
  const v = SIM[i][k] * SIM[k][j];
  if (v > SIM[i][j]) SIM[i][j] = v;
}

// Sharpen: with 44 genres, long chains of weak links would make everything look "a bit related".
// Squaring-ish keeps close neighbours close and lets distant genres drop to zero, so they rotate.
for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (i !== j) { const v = Math.pow(SIM[i][j], 1.75); SIM[i][j] = v < 0.2 ? 0 : v; }

const sim = (a, b) => SIM[IDX[a]][IDX[b]];

let catalogSeq = 0;
// ---------- artist and song picks ----------
// A guest can name artists and songs they care about. They are matched by plain-text keys, so the same song
// found through Spotify, YouTube or the host's own files lines up.
const normKey = (s) => String(s == null ? '' : s).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
/** Keys an artist credit answers to: the whole credit, and each name in "A feat. B", "A, B", "A x B". */
function artistKeys(credit) {
  const whole = normKey(credit);
  const out = new Set(whole ? [whole] : []);
  for (const part of String(credit == null ? '' : credit).split(/\s*(?:,|;|\bfeat\.?|\bft\.?|\bfeaturing\b|\bwith\b|\bx\b)\s*/i)) { const k = normKey(part); if (k) out.add(k); }
  return out;
}
const songKey = (title, artist) => normKey(title) + '|' + normKey(artist);
/** @param {Catalog} catalog */
function trackKeys(catalog) {
  if (!catalog.keys) catalog.keys = catalog.tracks.map((t) => ({ artists: artistKeys(t.artist), song: songKey(t.title, t.artist) }));
  return catalog.keys;
}

// A catalogue is a list of tracks {id, title, artist, genres[]} plus per-taste fit caches.
/** @param {Track[]} tracks @returns {Catalog} */
function makeCatalog(tracks) {
  return { version: ++catalogSeq, tracks, cache: new Map() };
}

function normalise(taste) {
  let sum = 0;
  const out = {};
  for (const g in taste) if (taste[g] > 0 && IDX[g] !== undefined) sum += taste[g];
  if (!sum) return out;
  for (const g in taste) if (taste[g] > 0 && IDX[g] !== undefined) out[g] = taste[g] / sum;
  return out;
}

function rawFit(taste, track) {
  let total = 0;
  for (const g in taste) {
    let best = 0;
    for (const tg of track.genres) { const s = sim(g, tg); if (s > best) best = s; }
    total += taste[g] * best;
  }
  return total;
}

// Fit scaled so 1.0 means "as good as this catalogue gets for this person".
function relFits(taste, catalog) {
  const key = JSON.stringify(taste);
  let hit = catalog.cache.get(key);
  if (hit) return hit;
  const t = normalise(taste);
  const raws = catalog.tracks.map((tr) => rawFit(t, tr));
  const mx = Math.max(...raws, 0) || 1;
  hit = raws.map((v) => v / mx);
  catalog.cache.set(key, hit);
  return hit;
}

function hash01(n) { const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453; return x - Math.floor(x); }
const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);

/*
 people: [{id, taste}] who count right now
 opts: catalog (required), lambda (weight on the least-happy person), tau (min room score to blend),
       n (slots), recentIds, recentArtists, served {personId: airtime so far},
       keep [queue items to leave in place], lastPrimary/prevPrimary (genres of the last two songs), seed
*/
/** @param {Person[]} people @param {BuildOptions} opts @returns {any} */
function buildQueue(people, opts) {
  const catalog = opts.catalog;
  const lambda = opts.lambda ?? 0.6;
  const tau = opts.tau ?? 0.55;
  const n = opts.n || 5;
  const artists = (opts.recentArtists || []).slice(-10);
  const served = {};
  const seed = opts.seed || 0;
  for (const p of people) served[p.id] = (opts.served && opts.served[p.id]) || 0;
  if (!people.length) return { mode: 'empty', bestRoom: 0, queue: [] };

  // Holiday songs need a holiday fan in the room. Everyone else is still served by the song's style tags.
  const wanted = new Set(HOLIDAYS.filter((h) => people.some((p) => (p.taste[h] || 0) > 0)));
  const seasonal = (t) => t.genres.some((g) => HOLIDAYS.includes(g) && !wanted.has(g));
  // Fit is scaled to the best song that is actually eligible, so a held-back holiday song cannot drag everyone's scores down.
  const held = catalog.tracks.map(seasonal);
  const keys = trackKeys(catalog);
  const fits = people.map((p) => {
    const f = relFits(p.taste, catalog);
    let mx = 0;
    for (let i = 0; i < f.length; i++) if (!held[i] && f[i] > mx) mx = f[i];
    const out = mx > 0 && mx < 1 ? f.map((v) => Math.min(1, v / mx)) : f.slice();
    // Named artists and songs count as a perfect fit for the person who named them.
    if ((p.artists && p.artists.length) || (p.songs && p.songs.length)) {
      const wa = new Set(p.artists || []), ws = new Set(p.songs || []);
      keys.forEach((k, i) => { if (ws.has(k.song) || [...k.artists].some((a) => wa.has(a))) out[i] = 1; });
    }
    return out;
  });
  const rows = catalog.tracks.map((t, ti) => {
    const f = people.map((_, k) => fits[k][ti]);
    const mn = Math.min(...f);
    return { t, ti, f, min: mn, mean: avg(f), U: lambda * mn + (1 - lambda) * avg(f) };
  }).filter((r) => !held[r.ti]);
  const rowById = new Map(rows.map((r) => [r.t.id, r]));
  // How much a song is wanted by name: 1 for a named song, 0.5 for a named artist, for whoever named it.
  const wantedBy = (r, k) => {
    const p = people[k], kk = keys[r.ti];
    if (p.songs && p.songs.includes(kk.song)) return 1;
    if (p.artists && p.artists.length && p.artists.some((a) => kk.artists.has(a))) return 0.5;
    return 0;
  };

  const used = new Set(opts.recentIds || []);
  const queue = [];
  // Keep independent genre coverage for every listener. A blended song counts
  // for each person whose selected genres include the song's primary genre.
  const selectedGenres = people.map((p) => Object.keys(p.taste).filter((g) => p.taste[g] > 0));
  const genreCounts = selectedGenres.map((genres) => Object.fromEntries(genres.map((g) => [g, 0])));
  let lastPrimary = opts.lastPrimary || null;
  let prev2 = opts.prevPrimary || null;
  const ids = people.map((p) => p.id);
  const open = rows.filter((r) => !used.has(r.t.id) && !artists.includes(r.t.artist));
  const bestRoomAll = open.length ? Math.max(...open.map((r) => r.U)) : 0;

  function take(r, mode, owner) {
    used.add(r.t.id); artists.push(r.t.artist);
    const credit = {};
    people.forEach((p, k) => {
      credit[p.id] = mode === 'blend' ? r.f[k] : (k === owner ? 1 : 0);
      served[p.id] += credit[p.id];
    });
    people.forEach((_, k) => {
      if (Object.prototype.hasOwnProperty.call(genreCounts[k], r.t.genres[0])) genreCounts[k][r.t.genres[0]]++;
    });
    prev2 = lastPrimary; lastPrimary = r.t.genres[0];
    queue.push({
      credit, track: r.t, mode, owner: owner >= 0 ? people[owner].id : null,
      fits: people.map((p, k) => ({ id: p.id, fit: r.f[k] })), room: r.U,
    });
  }

  // Songs already lined up stay put when the room has not changed; only new slots are filled.
  for (const kp of opts.keep || []) {
    if (queue.length >= n || used.has(kp.track.id)) continue;
    const row = rowById.get(kp.track.id);
    if (!row) continue;
    const ow = kp.mode === 'rotate' ? ids.indexOf(kp.owner) : -1;
    take(row, ow >= 0 ? 'rotate' : 'blend', ow);
  }

  while (queue.length < n) {
    const cand = rows.filter((r) => !used.has(r.t.id) && !artists.includes(r.t.artist));
    if (!cand.length) break;
    const bestU = Math.max(...cand.map((r) => r.U));
    const mode = bestU >= tau ? 'blend' : 'rotate';
    let owner = -1;
    if (mode === 'rotate') {
      let lowest = Infinity;
      people.forEach((p, k) => { if (served[p.id] < lowest - 1e-9) { lowest = served[p.id]; owner = k; } });
    }
    let best = null, bestScore = -Infinity;
    const slot = queue.length;
    for (const r of cand) {
      const prim = r.t.genres[0];
      const trans = lastPrimary ? sim(lastPrimary, prim) : 0.5;
      const pen = (prim === lastPrimary ? 0.06 : 0) + (prim === lastPrimary && prim === prev2 ? 0.08 : 0);
      const jitter = (hash01(r.ti + seed * 31 + slot * 7) - 0.5) * 0.04;
      // Named songs get their best chance on the namer's own turn; in a blend they only get a nudge, and only when
      // the room would nearly accept the song anyway, so one person's pick never overrides everyone else.
      let named = 0;
      if (mode === 'rotate') named = 0.12 * wantedBy(r, owner);
      else if (r.U >= tau - 0.1) { let sum = 0; for (let k = 0; k < people.length; k++) sum += wantedBy(r, k); named = 0.06 * (sum / people.length); }
      const balancedFor = [];
      people.forEach((_, k) => {
        if (!Object.prototype.hasOwnProperty.call(genreCounts[k], prim)) return;
        const leastServed = Math.min(...Object.values(genreCounts[k]));
        balancedFor.push(genreCounts[k][prim] === leastServed);
      });
      const genreBalance = balancedFor.length ? 0.35 * (balancedFor.filter(Boolean).length / balancedFor.length) : 0;
      const score = mode === 'blend'
        ? r.U + 0.08 * trans - pen + jitter + named + genreBalance
        : 0.75 * r.f[owner] + 0.25 * r.U + 0.15 * trans - pen + jitter + named + genreBalance;
      if (score > bestScore) { bestScore = score; best = r; }
    }
    take(best, mode, owner);
  }
  return { mode: queue.length ? queue[0].mode : 'empty', bestRoom: bestRoomAll, queue };
}

module.exports = { GENRES, GENRE_GROUPS, GENRE_ALIASES, GENRE_ALIAS_GROUPS, HOLIDAYS, GROUPS, groupId, isPick, expandPick, tasteFromPicks, normKey, artistKeys, songKey, trackKeys, sim, makeCatalog, normalise, relFits, buildQueue };
