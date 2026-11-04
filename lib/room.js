'use strict';
const crypto = require('node:crypto');
const Engine = require('./engine');
const L = require('./log');
const CURATED = require('./catalog');

const WEIGHTS = [4, 3, 2, 1];
const COLORS = 6;
const QUEUE_LEN = 5;
// A locked phone drops its connection, so a guest is only removed after a long grace period.
const DISCONNECT_GRACE_MS = Number(process.env.DISCONNECT_GRACE_MS) || 180000;
// Presence signals from the guest's page (a heartbeat about once a minute).
const DOZE_DEFAULT_MIN = Number(process.env.DOZE_DEFAULT_MIN) || 30;                              // a locked / backgrounded phone stays counted this long
const OFF_NET_BEATS = 2;                                   // heartbeats from outside the room's network before "away"
const AWAY_REMOVE_MS = Number(process.env.AWAY_REMOVE_MS) || 15 * 60 * 1000; // away from the network this long: gone
const IDLE_ASK_S = Number(process.env.IDLE_ASK_S) || 3600; // no touch for this long: ask "still here?"
const IDLE_CLEAR_S = Math.min(120, IDLE_ASK_S);          // a touch this recent counts as an answer
const IDLE_ANSWER_MS = Number(process.env.IDLE_ANSWER_MS) || 5 * 60 * 1000; // unanswered this long: set to sit out
const MAX_LIBRARY = 20000;

const rid = (bytes = 8) => crypto.randomBytes(bytes).toString('hex');
const pct = (v) => Math.round(v * 100);

function cleanName(n) {
  return typeof n === 'string' ? n.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 20) : '';
}
function cleanName2(n) { return typeof n === 'string' ? n.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 30) : ''; }
function cleanGenres(g) {
  const out = [];
  if (Array.isArray(g)) for (const x of g) if (Engine.isPick(x) && !out.includes(x) && out.length < 4) out.push(x);
  return out;
}
const MAX_ARTISTS = 5, MAX_SONGS = 5;
const cleanText = (x, max) => (typeof x === 'string' ? x.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max) : '');
// A pasted youtube.com/@handle link is the same artist as the handle itself, so the two match each other.
const youtubeHandle = (n) => { const m = /^https?:\/\/(?:www\.|m\.)?youtube\.com\/(@[\w.\-]{3,30})\/?(?:[?#].*)?$/i.exec(String(n).trim()); return m ? m[1] : n; };
// Artists a guest named (names, up to 5) and songs ({title, artist}, up to 5). Duplicates by plain-text key are dropped.
function cleanArtists(a) {
  const out = [], seen = new Set();
  if (Array.isArray(a)) for (const x of a) { const name = youtubeHandle(cleanText(typeof x === 'string' ? x : x && x.name, 80)).slice(0, 60), k = Engine.normKey(name); if (name && k && !seen.has(k) && out.length < MAX_ARTISTS) { seen.add(k); out.push(name); } }
  return out;
}
function cleanSongs(a) {
  const out = [], seen = new Set();
  if (Array.isArray(a)) for (const x of a) {
    if (!x || typeof x !== 'object') continue;
    const title = cleanText(x.title, 100), artist = cleanText(x.artist, 100), k = Engine.songKey(title, artist);
    if (title && artist && !seen.has(k) && out.length < MAX_SONGS) { seen.add(k); out.push({ title, artist }); }
  }
  return out;
}
const MAX_HISTORY = 400;  // songs a room remembers having played (no-repeat window, fairness window, and what the history lists draw from)
const MAX_SEARCHED_ARTISTS = 300; // artist look-ups a room remembers, so a long-lived room with many guests coming and going stays small
const VIEW_HISTORY = 60;   // songs shown in the host and guest history lists
const MAX_EXTRA = 3000; // songs one room may hold from its service
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

class Room {
  constructor(code, hostKey, now = Date.now()) {
    this.code = code;
    this.hostKey = hostKey;
    this.createdAt = now;
    this.touchedAt = now;
    this.guests = new Map();
    this.history = [];
    this.nowItem = null;
    this.queue = [];
    this.requestQueue = [];
    this.requestLimitEnabled = true;
    this.requestStreak = 0;
    this.lastRequestGuest = '';
    this.mode = 'empty';
    this.bestRoom = 0;
    this.log = [];
    this.seed = 0;
    this.nextColor = 0;
    this.served = {};
    this.votes = {}; // trackId -> {guestId: 'up'|'down'}
    this.opts = { lambda: 0.6, tau: 0.55, settle: 4, doze: DOZE_DEFAULT_MIN };
    this.extra = []; // songs the host's music service found for the genres in the room (each may carry the service's own id, nid)
    this.searched = new Set(); // genres the host has already asked its service about
    this.searchedArtists = new Set(); // named artists the host has already asked its service about (plain-text keys)
    this.poolMode = false; // true once the service supplies the songs; the built-in list is then only a fallback
    this.name = ''; // optional room name shown to guests
    this.discoverable = true; // listed for people on the same network
    this.netKey = '';
    this.library = null; // the host's own catalogue, when their music source has one
    this.libraryNeedsReconnect = false;
    this.recoveryNeeded = false;
    this.source = { kind: 'curated', provider: '', label: '', dropped: 0 };
    this.rebuildCatalog();
    this.version = 0;
  }

  // A bounded, JSON-safe snapshot of the live room. The host's own library is deliberately
  // excluded: the host browser reconnects its provider and sends a fresh catalogue after restore.
  snapshot() {
    const ownLibrary = !!this.library || this.libraryNeedsReconnect;
    return {
      schema: 1, version: this.version, createdAt: this.createdAt, touchedAt: this.touchedAt,
      name: this.name, discoverable: this.discoverable, opts: this.opts,
      guests: [...this.guests.values()],
      history: this.history.slice(-MAX_HISTORY),
      nowItem: this.nowItem,
      queue: this.queue.slice(0, QUEUE_LEN),
      requestQueue: this.requestQueue.slice(0, 100), requestLimitEnabled: this.requestLimitEnabled,
      requestStreak: this.requestStreak, lastRequestGuest: this.lastRequestGuest,
      mode: this.mode, bestRoom: this.bestRoom,
      log: this.log.slice(0, 14), seed: this.seed, nextColor: this.nextColor,
      served: this.served, votes: this.votes,
      extra: this.extra.slice(0, MAX_EXTRA),
      searched: [...this.searched],
      searchedArtists: [...this.searchedArtists],
      poolMode: this.poolMode,
      source: this.source,
      libraryNeedsReconnect: ownLibrary,
    };
  }

  // Hydrate only known room fields. Presence is always cold after a restart: guests get
  // a reconnect grace period, and no stale network/idle signal can remove them immediately.
  restoreSnapshot(data, now = Date.now()) {
    if (!data || data.schema !== 1 || !Array.isArray(data.guests) || data.guests.length > 40) return false;
    const guests = new Map();
    for (const raw of data.guests) {
      if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !/^g[0-9a-f]{8}$/.test(raw.id) ||
          typeof raw.key !== 'string' || !/^[a-f0-9]{32}$/.test(raw.key) || guests.has(raw.id)) continue;
      const genres = cleanGenres(raw.genres), artists = cleanArtists(raw.artists), songs = cleanSongs(raw.songs);
      if (!genres.length && !artists.length && !songs.length) continue;
      const manual = raw.manual === true, sit = raw.sit === true, hostSit = raw.hostSit === true;
      guests.set(raw.id, {
        id: raw.id, key: raw.key, name: cleanName(raw.name) || 'Guest', genres, artists, songs,
        lookupGenres: raw.lookupGenres === true,
        artistGenres: raw.artistGenres && typeof raw.artistGenres === 'object' && !Array.isArray(raw.artistGenres) ? raw.artistGenres : {},
        genreLookupStatus: ['idle', 'pending', 'ready', 'partial', 'unavailable', 'no-match'].includes(raw.genreLookupStatus) ? raw.genreLookupStatus : 'idle',
        color: Number.isInteger(raw.color) ? ((raw.color % COLORS) + COLORS) % COLORS : 0,
        status: sit || hostSit ? 'sitting' : 'active', arriveAt: 0,
        sit, hostSit, manual, connected: manual, lostAt: manual ? null : now,
        sinceAt: Math.min(now, Math.max(now - 86400000, Number(raw.sinceAt) || now)),
        joinedOnNet: false, hiddenAt: null, offBeats: 0, away: '', awaySince: null, askAt: null, lastBeat: now,
      });
    }
    this.createdAt = Number.isFinite(data.createdAt) ? data.createdAt : now;
    this.touchedAt = now;
    this.name = cleanName2(data.name);
    this.discoverable = data.discoverable !== false;
    if (data.opts && typeof data.opts === 'object' && !Array.isArray(data.opts)) {
      this.opts = { ...this.opts };
      this.setOptsWithoutRebuild(data.opts);
    }
    this.guests = guests;
    this.history = Array.isArray(data.history) ? data.history.slice(-MAX_HISTORY) : [];
    this.nowItem = data.nowItem && typeof data.nowItem === 'object' ? data.nowItem : null;
    this.queue = Array.isArray(data.queue) ? data.queue.slice(0, QUEUE_LEN) : [];
    this.requestQueue = Array.isArray(data.requestQueue) ? data.requestQueue.slice(0, 100).filter((r) => r && typeof r.id === 'string' && typeof r.title === 'string' && typeof r.artist === 'string' && r.title.trim() && r.artist.trim()).map((r) => ({ id: r.id.slice(0, 40), title: cleanText(r.title, 100), artist: cleanText(r.artist, 100), guestId: typeof r.guestId === 'string' && guests.has(r.guestId) ? r.guestId : '', requester: cleanName2(r.requester) || 'Guest', at: Number.isFinite(r.at) ? r.at : now, genres: cleanGenres(r.genres) })) : [];
    this.requestLimitEnabled = data.requestLimitEnabled !== false;
    this.requestStreak = Number.isInteger(data.requestStreak) ? Math.max(0, Math.min(2, data.requestStreak)) : 0;
    this.lastRequestGuest = typeof data.lastRequestGuest === 'string' ? data.lastRequestGuest : '';
    this.mode = typeof data.mode === 'string' ? data.mode : 'empty';
    this.bestRoom = Number.isFinite(data.bestRoom) ? data.bestRoom : 0;
    this.log = Array.isArray(data.log) ? data.log.filter((x) => typeof x === 'string').slice(0, 14) : [];
    this.seed = Number.isInteger(data.seed) && data.seed >= 0 ? data.seed : 0;
    this.nextColor = Number.isInteger(data.nextColor) && data.nextColor >= 0 ? data.nextColor : guests.size;
    this.served = {};
    if (data.served && typeof data.served === 'object' && !Array.isArray(data.served)) {
      for (const id of guests.keys()) if (Number.isFinite(data.served[id])) this.served[id] = Math.max(0, data.served[id]);
    }
    this.votes = {};
    if (data.votes && typeof data.votes === 'object' && !Array.isArray(data.votes)) {
      for (const [trackId, voters] of Object.entries(data.votes)) {
        if (!voters || typeof voters !== 'object' || Array.isArray(voters)) continue;
        const valid = {};
        for (const [id, vote] of Object.entries(voters)) if (guests.has(id) && (vote === 'up' || vote === 'down')) valid[id] = vote;
        if (Object.keys(valid).length) this.votes[trackId] = valid;
      }
    }
    this.extra = Array.isArray(data.extra) ? data.extra.slice(0, MAX_EXTRA).filter((t) =>
      t && typeof t.id === 'string' && typeof t.title === 'string' && typeof t.artist === 'string' &&
      Array.isArray(t.genres) && t.genres.some((g) => Engine.GENRES.includes(g))
    ).map((t) => ({ id: t.id.slice(0, 64), title: t.title.slice(0, 100), artist: t.artist.slice(0, 100),
      genres: cleanGenres(t.genres).slice(0, 3), ...(typeof t.nid === 'string' && /^[A-Za-z0-9:_-]{1,64}$/.test(t.nid) ? { nid: t.nid } : {}) })) : [];
    this.searched = new Set(Array.isArray(data.searched) ? data.searched.filter((g) => Engine.GENRES.includes(g)) : []);
    this.searchedArtists = new Set(Array.isArray(data.searchedArtists) ? data.searchedArtists.filter((x) => typeof x === 'string').slice(-MAX_SEARCHED_ARTISTS) : []);
    this.poolMode = data.poolMode === true;
    this.libraryNeedsReconnect = data.libraryNeedsReconnect === true;
    this.source = data.source && typeof data.source === 'object'
      ? (data.source.kind === 'library' ? { kind: 'curated', provider: String(data.source.provider || '').slice(0, 20), label: String(data.source.label || '').slice(0, 60), dropped: 0 } : data.source)
      : { kind: 'curated', provider: '', label: '', dropped: 0 };
    this.library = null;
    this.rebuildCatalog();
    this.version = Number.isInteger(data.version) && data.version >= 0 ? data.version : 0;
    this.recoveryNeeded = false;
    return true;
  }

  setOptsWithoutRebuild(o) {
    if (typeof o.doze === 'number') this.opts.doze = Math.min(240, Math.max(5, Math.round(o.doze)));
    if (typeof o.lambda === 'number') this.opts.lambda = Math.min(1, Math.max(0, o.lambda));
    if (typeof o.tau === 'number') this.opts.tau = Math.min(0.95, Math.max(0.1, o.tau));
    if (typeof o.settle === 'number') this.opts.settle = Math.min(60, Math.max(0, Math.round(o.settle)));
  }

  rebuildCatalog() {
    this.catalog = Engine.makeCatalog(this.library || (this.poolMode ? this.poolCatalog() : [...CURATED, ...this.extra]));
  }

  // The service's songs, plus built-in songs only where the service came back thin for a genre the host asked about
  // (so a room never goes quiet), and always for holidays, whose famous songs are the point.
  poolCatalog() {
    const MIN_POOL = 12, keyOf = (t) => norm(t.title) + '|' + norm(t.artist);
    const have = {};
    for (const t of this.extra) for (const g of t.genres) have[g] = (have[g] || 0) + 1;
    const seen = new Set(this.extra.map(keyOf));
    const fallback = CURATED.filter((t) => {
      const p = t.genres[0];
      const wanted = Engine.HOLIDAYS.includes(p) || (this.searched.has(p) && (have[p] || 0) < MIN_POOL);
      return wanted && !seen.has(keyOf(t));
    });
    return [...this.extra, ...fallback];
  }

  // Back to the built-in list (the host switched to a source that does not supply songs by genre).
  clearExtras() {
    if (!this.extra.length && !this.poolMode && !this.searched.size && !this.searchedArtists.size) return false;
    L.info('pool.cleared', { room: L.roomTag(this.code), songs: this.extra.length });
    this.extra = []; this.searched = new Set(); this.searchedArtists = new Set(); this.poolMode = false;
    this.rebuildCatalog();
    const ids = new Set(this.catalog.tracks.map((t) => t.id));
    this.queue = this.queue.filter((q) => ids.has(q.track.id));
    this.rebuild(null, true);
    return true;
  }

  // The host's music source supplies its own songs (local files, a Navidrome server...). Replaces the built-in list.
  // refresh = true: the host's service was re-read while the room runs. Keep the song that is playing and the queue.
  /** @param {string} provider @param {string} label @param {Track[]} tracks @param {boolean} [refresh] */
  setLibrary(provider, label, tracks, refresh = false) {
    const seen = new Set(), out = [];
    let dropped = 0;
    for (const t of Array.isArray(tracks) ? tracks.slice(0, MAX_LIBRARY) : []) {
      const id = t && typeof t.id === 'string' ? t.id.slice(0, 64) : '';
      const title = t && typeof t.title === 'string' ? t.title.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 100) : '';
      const artist = t && typeof t.artist === 'string' ? t.artist.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 100) : '';
      const genres = cleanGenres(t && t.genres).filter((x) => Engine.GENRES.includes(x)).slice(0, 3);
      if (!id || !title || !genres.length || seen.has(id)) { dropped++; continue; }
      seen.add(id);
      out.push({ id: 'L' + id, title, artist: artist || 'Unknown artist', genres });
    }
    if (!out.length) return { accepted: 0, dropped };
    const providerKey = String(provider || '').slice(0, 20);
    const same = (refresh && this.library && this.source.provider === providerKey) || (this.libraryNeedsReconnect && this.source.provider === providerKey);
    const before = same ? (this.library ? this.library.length : 0) : 0;
    this.libraryNeedsReconnect = false;
    this.library = out;
    this.source = { kind: 'library', provider: String(provider || '').slice(0, 20), label: String(label || '').slice(0, 60), dropped };
    this.rebuildCatalog();
    if (same) {
      const ids = new Set(out.map((t) => t.id));
      this.queue = this.queue.filter((q) => ids.has(q.track.id));
      this.addLog(`Synced ${this.source.label || this.source.provider}: ${out.length} songs (${out.length - before >= 0 ? '+' : ''}${out.length - before}).`);
      this.rebuild(null, true);
    } else {
      this.queue = []; this.nowItem = null;
      this.addLog(`Music source set to ${this.source.label || this.source.provider}: ${out.length} songs.`);
      this.rebuild(null, false);
    }
    L.tally('source', this.source.provider || 'library');
    L.info('library.set', { room: L.roomTag(this.code), provider: this.source.provider, songs: out.length, dropped, refresh: !!same });
    return { accepted: out.length, dropped, synced: !!same };
  }

  clearLibrary() {
    if (!this.library && !this.libraryNeedsReconnect) return false;
    this.library = null;
    this.libraryNeedsReconnect = false;
    this.source = { kind: 'curated', provider: '', label: '', dropped: 0 };
    this.rebuildCatalog();
    this.queue = []; this.nowItem = null;
    L.info('library.cleared', { room: L.roomTag(this.code) });
    this.addLog('Back to the built-in song list.');
    this.rebuild(null, false);
    return true;
  }

  addLog(msg) { this.log.unshift(msg); this.log = this.log.slice(0, 14); }
  bump(now = Date.now()) { this.version++; this.touchedAt = now; }

  active() { return [...this.guests.values()].filter((g) => g.status === 'active'); }
  // Infer from matching room songs and, when enabled, cached tags for the named artists.
  // Holidays are never guessed; they have to be asked for by name.
  inferredGenres(g) {
    if (!g.artists.length && !g.songs.length) return [];
    const wa = new Set(g.artists.map(Engine.normKey)), ws = new Set(g.songs.map((x) => Engine.songKey(x.title, x.artist)));
    const keys = Engine.trackKeys(this.catalog);
    /** @type {Record<string, number>} */
    const score = {};
    this.catalog.tracks.forEach((t, i) => {
      const k = keys[i];
      const w = ws.has(k.song) ? 2 : [...k.artists].some((a) => wa.has(a)) ? 1 : 0;
      if (!w) return;
      const gs = (t.genres || []).filter((x) => Engine.GENRES.includes(x) && !Engine.HOLIDAYS.includes(x));
      for (const x of gs) score[x] = (score[x] || 0) + w / gs.length;
    });
    const externalArtists = [...new Set([...g.artists, ...g.songs.map((x) => x.artist)].map(Engine.normKey))];
    for (const artist of externalArtists) {
      const tags = g.artistGenres && g.artistGenres[artist];
      const total = tags ? tags.reduce((sum, tag) => sum + tag.count, 0) : 0;
      if (!total) continue;
      for (const tag of tags) score[tag.genre] = (score[tag.genre] || 0) + 4 * tag.count / total;
    }
    return Object.entries(score).sort((a, b) => b[1] - a[1]).slice(0, 3).map((e) => e[0]);
  }

  /** @returns {Taste} */
  tasteOf(g) {
    if (g.genres.length) return Engine.tasteFromPicks(g.genres, WEIGHTS);
    const guess = this.inferredGenres(g);
    if (guess.length) return Engine.tasteFromPicks(guess, WEIGHTS);
    // Named only songs we do not hold yet: go along with the room until the host's music source finds them.
    /** @type {Taste} */
    const merged = {};
    for (const o of this.active()) if (o !== g && o.genres.length) for (const [k, v] of Object.entries(Engine.tasteFromPicks(o.genres, WEIGHTS))) merged[k] = (merged[k] || 0) + v;
    return merged;
  }

  // ---------- guests ----------
  /** @param {string} name @param {GenrePick[]} genres @param {any} [opts] @param {number} [nowArg] */
  addGuest(name, genres, opts = {}, nowArg) {
    const now = opts.now ?? nowArg ?? Date.now();
    const gs = cleanGenres(genres), artists = cleanArtists(opts.artists), songs = cleanSongs(opts.songs);
    // A guest needs something to go on: a genre, or at least one named artist or song.
    if (!gs.length && !artists.length && !songs.length) return null;
    if (this.guests.size >= 40) return null;
    const act = this.active();
    const mean = act.length ? act.reduce((s, g) => s + (this.served[g.id] || 0), 0) / act.length : 0;
    const settle = opts.immediate ? 0 : this.opts.settle;
    const id = 'g' + rid(4);
    const g = {
      id, key: rid(16), name: cleanName(name) || 'Guest', genres: gs, artists, songs,
      lookupGenres: opts.lookupGenres === true, artistGenres: {}, genreLookupStatus: 'idle',
      color: this.nextColor++ % COLORS, status: settle > 0 ? 'arriving' : 'active', arriveAt: now + settle * 1000,
      sit: false, hostSit: false, manual: !!opts.manual, connected: !!opts.manual, lostAt: null,
      sinceAt: Math.min(now, Math.max(now - 86400000, Number(opts.since) || (this.nowItem && this.history.length ? this.history[this.history.length - 1].at || now : now))), joinedOnNet: !!opts.onNet, hiddenAt: null, offBeats: 0, away: '', awaySince: null, askAt: null, lastBeat: now,
    };
    this.applySit(g);
    this.guests.set(id, g);
    this.served[id] = mean;
    this.addLog(`${g.name} joined${g.status === 'arriving' ? `. Counting in ${settle} s.` : '.'}`);
    L.count('guests.joined'); for (const x of gs) L.tally('genre', x);
    if (g.artists.length) L.count('picks.artists', g.artists.length);
    if (g.songs.length) L.count('picks.songs', g.songs.length);
    L.info('guest.joined', { room: L.roomTag(this.code), guests: this.guests.size, picks: gs.length, manual: !!opts.manual });
    if (g.status === 'active') this.rebuild(null, false); else this.bump(now);
    return g;
  }

  applySit(g) {
    if (g.status === 'arriving') return;
    g.status = g.sit || g.hostSit || g.away ? 'sitting' : 'active';
  }

  updateGuest(id, patch) {
    const g = this.guests.get(id);
    if (!g) return false;
    const msgs = [];
    if (patch.name !== undefined) { const n = cleanName(patch.name); if (n && n !== g.name) { g.name = n; } }
    if (patch.genres !== undefined) {
      const gs = cleanGenres(patch.genres);
      // Genres can be cleared only while the guest still has a named artist or song to go on.
      if ((gs.length || g.artists.length || g.songs.length) && gs.join('|') !== g.genres.join('|')) { g.genres = gs; msgs.push(`${g.name} changed their genres`); }
    }
    if (patch.artists !== undefined) {
      const a = cleanArtists(patch.artists);
      if ((a.length || g.genres.length || g.songs.length) && a.map(Engine.normKey).join('|') !== g.artists.map(Engine.normKey).join('|')) { g.artists = a; msgs.push(`${g.name} changed their artists`); L.count('picks.artist_edits'); }
    }
    if (patch.songs !== undefined) {
      const a = cleanSongs(patch.songs), key = (x) => x.map((q) => Engine.songKey(q.title, q.artist)).join('|');
      if ((a.length || g.genres.length || g.artists.length) && key(a) !== key(g.songs)) { g.songs = a; msgs.push(`${g.name} changed their songs`); L.count('picks.song_edits'); }
    }
    if (patch.lookupGenres !== undefined && !!patch.lookupGenres !== g.lookupGenres) {
      g.lookupGenres = patch.lookupGenres === true;
      g.artistGenres = {};
      g.genreLookupStatus = 'idle';
      msgs.push(`${g.name} ${g.lookupGenres ? 'enabled' : 'disabled'} external genre lookup`);
    }
    if (msgs.some((x) => x === `${g.name} changed their artists` || x === `${g.name} changed their songs`)) {
      g.artistGenres = {};
      g.genreLookupStatus = 'idle';
    }
    if (patch.sit !== undefined && !!patch.sit !== g.sit) { g.sit = !!patch.sit; msgs.push(`${g.name} ${g.sit ? 'sat out' : 'rejoined'}`); }
    if (patch.hostSit !== undefined && !!patch.hostSit !== g.hostSit) { g.hostSit = !!patch.hostSit; msgs.push(`${g.name} ${g.hostSit ? 'was sat out by the host' : 'was brought back'}`); }
    this.applySit(g);
    if (msgs.length) this.rebuild(msgs.join('. '), false); else this.bump();
    return true;
  }

  removeGuest(id, why = 'left') {
    const g = this.guests.get(id);
    if (!g) return false;
    this.guests.delete(id);
    this.requestQueue = this.requestQueue.filter((request) => request.guestId !== id);
    delete this.served[id];
    for (const t of Object.keys(this.votes)) delete this.votes[t][id];
    L.count('guests.removed');
    L.info('guest.removed', { room: L.roomTag(this.code), why: String(why), guests: this.guests.size });
    this.rebuild(`${g.name} ${why}`, false);
    return true;
  }

  setConnected(id, connected, now = Date.now()) {
    const g = this.guests.get(id);
    if (!g || g.manual) return;
    g.connected = connected;
    g.lostAt = connected ? null : now;
    this.bump(now);
  }

  // A guest's page checks in about once a minute. onNet: is it still on the room's network (null = not checked).
  // idleSec: seconds since the guest last touched the page. Returns true when something visible changed.
  // hidden: true when the page has gone to the background (phone locked, app switched), false when it is back.
  /** @param {string} id @param {{onNet?: boolean|null, idleSec?: number, hidden?: boolean}} [info] @param {number} [now] */
  beat(id, { onNet = null, idleSec = 0, hidden } = /** @type {any} */ ({}), now = Date.now()) {
    const g = this.guests.get(id);
    if (!g || g.manual) return false;
    g.lastBeat = now;
    if (hidden === true) g.hiddenAt = g.hiddenAt || now; else if (hidden === false) g.hiddenAt = null;
    const was = g.away;
    if (g.joinedOnNet && onNet !== null) {
      if (!onNet) { g.offBeats++; if (g.offBeats >= OFF_NET_BEATS && !g.away) { g.away = 'network'; g.awaySince = now; } }
      else { g.offBeats = 0; if (g.away === 'network') { g.away = ''; g.awaySince = null; } }
    }
    if (idleSec < IDLE_CLEAR_S) { g.askAt = null; if (g.away === 'idle') { g.away = ''; g.awaySince = null; } }
    else if (idleSec >= IDLE_ASK_S && !g.askAt && !g.away) g.askAt = now;
    if (was !== g.away) {
      const before = g.status;
      this.applySit(g);
      const why = g.away === 'network' ? `${g.name} seems to have left the Wi-Fi, so songs are chosen without them` : g.away === 'idle' ? `${g.name} did not answer, so songs are chosen without them` : `${g.name} is back`;
      if (before !== g.status || !g.away) this.rebuild(why, false); else this.bump(now);
      return true;
    }
    this.bump(now);
    return false;
  }

  // Called on a timer. Promotes arriving guests and drops guests who stayed disconnected.
  tick(now = Date.now()) {
    let changed = null;
    for (const g of this.guests.values()) {
      if (g.status === 'arriving' && now >= g.arriveAt) { g.status = 'active'; this.applySit(g); changed = changed || `${g.name} settled in and now counts`; }
    }
    for (const g of [...this.guests.values()]) {
      if (!g.manual && !g.connected && g.lostAt) {
        // A page that said it was going to the background (phone locked) is kept for the doze lease; a vanished one for a short grace.
        const lease = g.hiddenAt ? Math.max(DISCONNECT_GRACE_MS, this.dozeMs()) : DISCONNECT_GRACE_MS;
        if (now - (g.hiddenAt || g.lostAt) > lease) { this.removeGuest(g.id, 'left'); continue; }
      }
      if (g.away === 'network' && g.awaySince && now - g.awaySince > AWAY_REMOVE_MS) { this.removeGuest(g.id, 'left'); continue; }
      if (g.askAt && !g.away && now - g.askAt > IDLE_ANSWER_MS) {
        g.away = 'idle'; g.awaySince = now; g.askAt = null; this.applySit(g);
        changed = changed || `${g.name} did not answer "still here?", so songs are chosen without them`;
      }
    }
    if (changed) { this.rebuild(changed, false); return true; }
    return false;
  }

  // ---------- queue ----------
  rebuild(reason, keepQueue) {
    const act = this.active();
    const prevIds = this.queue.map((q) => q.track.id);
    const hist = this.history;
    const last = hist[hist.length - 1], prev = hist[hist.length - 2];
    const t0 = process.hrtime.bigint();
    const r = Engine.buildQueue(act.map((g) => ({ id: g.id, taste: this.tasteOf(g), artists: g.artists.map(Engine.normKey), songs: g.songs.map((x) => Engine.songKey(x.title, x.artist)) })), {
      catalog: this.catalog, lambda: this.opts.lambda, tau: this.opts.tau, n: QUEUE_LEN,
      recentIds: hist.map((x) => x.track.id), recentArtists: hist.slice(-10).map((x) => x.track.artist),
      served: this.served, seed: this.seed,
      lastPrimary: last ? last.track.genres[0] : null, prevPrimary: prev ? prev.track.genres[0] : null,
      keep: keepQueue ? this.queue : [],
    });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    L.observe('rebuild_ms', ms);
    L.debug('queue.rebuilt', { room: L.roomTag(this.code), ms, people: act.length, catalog: this.catalog.tracks.length, mode: r.mode });
    if (ms > 250) L.warn('queue.slow', { room: L.roomTag(this.code), ms, people: act.length, catalog: this.catalog.tracks.length });
    for (const q of r.queue) q.isNew = !keepQueue && prevIds.length > 0 && !prevIds.includes(q.track.id);
    this.queue = r.queue; this.mode = r.mode; this.bestRoom = r.bestRoom;
    if (reason) {
      const changed = r.queue.filter((q) => q.isNew).length;
      this.addLog(prevIds.length && r.queue.length ? `${reason}: ${changed} of ${r.queue.length} upcoming songs changed.` : `${reason}.`);
    }
    if (!this.nowItem && (this.queue.length || this.requestQueue.length)) this.advance(true); else this.bump();
  }

  // A room that stays open for days must not grow forever: forget the oldest plays, and the votes on songs no longer remembered.
  trimHistory() {
    this.history = this.history.slice(-MAX_HISTORY);
    const keep = new Set(this.history.map((h) => h.track.id));
    if (this.nowItem) keep.add(this.nowItem.track.id);
    for (const q of this.queue) keep.add(q.track.id);
    for (const id of Object.keys(this.votes)) if (!keep.has(id)) delete this.votes[id];
  }

  // Guest requests live outside the blend queue so catalogue rebuilds cannot erase them.
  addRequest(guestId, title, artist, host = false) {
    title = cleanText(title, 100); artist = cleanText(artist, 100);
    if (!title || !artist) return { ok: false, error: 'Enter both a song title and artist.' };
    const guest = host ? null : this.guests.get(guestId);
    if (!host && !guest) return { ok: false, error: 'Guest not found.' };
    const key = Engine.songKey(title, artist);
    const duplicate = this.requestQueue.some((r) => Engine.songKey(r.title, r.artist) === key) ||
      (this.nowItem && this.nowItem.request && Engine.songKey(this.nowItem.track.title, this.nowItem.track.artist) === key);
    if (duplicate) return { ok: false, error: 'That song is already requested.' };
    const outstanding = this.requestQueue.filter((r) => r.guestId === guestId).length +
      (this.nowItem && this.nowItem.request && this.nowItem.request.guestId === guestId ? 1 : 0);
    if (!host && this.requestLimitEnabled && outstanding >= 2) return { ok: false, error: 'You already have two requests waiting. One will free up when a request finishes or is removed.' };
    if (this.requestQueue.length >= 100) return { ok: false, error: 'The request queue is full right now.' };
    const request = { id: crypto.randomBytes(6).toString('hex'), title, artist, guestId: host ? '' : guestId, requester: host ? 'Host' : guest.name, at: Date.now(), genres: [] };
    this.requestQueue.push(request);
    if (!this.nowItem) this.advance(true); else this.bump();
    return { ok: true, request };
  }

  removeRequest(id) {
    const before = this.requestQueue.length;
    this.requestQueue = this.requestQueue.filter((r) => r.id !== id);
    if (this.requestQueue.length === before) return false;
    this.bump();
    return true;
  }

  // At most two consecutive requests; rotate between guests when possible.
  advance(silent = false, now = Date.now()) {
    let item;
    const useRequest = this.requestQueue.length > 0 && (this.requestStreak < 2 || this.queue.length === 0);
    if (useRequest) {
      let index = this.requestQueue.findIndex((r) => (r.guestId || '__host__') !== this.lastRequestGuest);
      if (index < 0) index = 0;
      const request = this.requestQueue.splice(index, 1)[0];
      item = { track: { id: 'request-' + request.id, title: request.title, artist: request.artist, genres: request.genres || [] },
        fits: [], mode: 'request', owner: request.guestId || null, room: 0, credit: {}, request };
      this.requestStreak++;
      this.lastRequestGuest = request.guestId || '__host__';
    } else {
      item = this.queue[0];
      this.requestStreak = 0;
    }
    if (!item) { this.nowItem = null; this.bump(); return false; }
    this.history.push({ track: item.track, fits: item.fits || [], mode: item.mode, owner: item.owner, room: item.room, request: item.request || null, at: now });
    if (this.history.length > MAX_HISTORY) this.trimHistory();
    this.nowItem = item;
    for (const id of Object.keys(item.credit || {})) if (this.served[id] !== undefined) this.served[id] += item.credit[id];
    this.seed++;
    L.count('songs.played'); L.count('songs.' + item.mode);
    L.debug('song.advanced', { room: L.roomTag(this.code), mode: item.mode, guests: this.guests.size });
    if (item.mode !== 'request') this.queue = this.queue.slice(1);
    this.rebuild(null, true);
    return true;
  }

  // The host's player could not find or play the current song: log it and move on.
  skipUnplayable() {
    if (!this.nowItem) return false;
    L.count('songs.unplayable');
    L.info('song.unplayable', { room: L.roomTag(this.code), pool: !!this.nowItem.track.nid });
    this.addLog(`Skipped "${this.nowItem.track.title}": could not be played from the host's music source.`);
    return this.advance();
  }

  dozeMs() { return (this.opts.doze || DOZE_DEFAULT_MIN) * 60000; }

  setOpts(o) {
    if (typeof o.doze === 'number') this.opts.doze = Math.min(240, Math.max(5, Math.round(o.doze)));
    if (typeof o.lambda === 'number') this.opts.lambda = Math.min(1, Math.max(0, o.lambda));
    if (typeof o.tau === 'number') this.opts.tau = Math.min(0.95, Math.max(0.1, o.tau));
    if (typeof o.settle === 'number') this.opts.settle = Math.min(60, Math.max(0, Math.round(o.settle)));
    if (typeof o.requestLimitEnabled === 'boolean') this.requestLimitEnabled = o.requestLimitEnabled;
    this.rebuild(null, false);
  }

  vote(guestId, v) {
    if (!this.nowItem) return false;
    const id = this.nowItem.track.id;
    const m = this.votes[id] || (this.votes[id] = {});
    if (v === 'up' || v === 'down') m[guestId] = v; else delete m[guestId];
    this.bump();
    return true;
  }

  voteCounts(trackId) {
    const m = this.votes[trackId] || {};
    let up = 0, down = 0;
    for (const v of Object.values(m)) { if (v === 'up') up++; else down++; }
    return { up, down };
  }

  // Genres in the room that the host has not searched Spotify for yet.
  wantGenres() {
    const want = new Set();
    if (this.library) return [];
    // A pick may be an alias (for example "90s" or "phonk").  Do not
    // truncate its expansion: every genre represented by every guest's pick
    // must reach the provider, otherwise the queue can never balance those
    // genres once the provider replaces the curated catalogue.
    for (const g of this.active()) for (const pick of g.genres) for (const x of Engine.expandPick(pick)) if (!this.searched.has(x)) want.add(x);
    return [...want];
  }

  // Era picks need era-qualified searches as well as their expanded genre searches.
  // Without these, an "80s" pick becomes ordinary rock/new-wave/pop searches and loses its decade signal.
  wantEras() {
    const eras = ['50s', '60s', '70s', '80s', '90s', '00s', '2010s', '2020s'];
    const want = new Map();
    if (this.library) return [];
    for (const g of this.active()) for (const pick of g.genres) {
      if (eras.includes(pick) && !want.has(pick)) want.set(pick, Engine.expandPick(pick).slice(0, 2));
    }
    return [...want].map(([era, genres]) => ({ era, genres }));
  }

  // Artists guests named that the room's songs do not have yet, for the host's browser to look up in its music source.
  // Each comes with the guest's first genre, which tags the songs found. Not asked when the host plays a complete library.
  /** @returns {Array<{name: string, genre: string}>} */
  wantArtists() {
    if (this.library) return [];
    // One existing song is not enough to satisfy an explicit artist request.
    // Keep discovering until the room has a useful seed of that artist's catalogue.
    const have = new Map();
    for (const k of Engine.trackKeys(this.catalog)) for (const a of k.artists) have.set(a, (have.get(a) || 0) + 1);
    const out = [], seen = new Set();
    for (const g of this.active()) for (const name of g.artists) {
      const k = Engine.normKey(name);
      if (!k || (have.get(k) || 0) >= 8 || this.searchedArtists.has(k) || seen.has(k)) continue;
      seen.add(k);
      // Tag the songs found with the guest's first genre, or a guess from their other picks, or the room's first genre.
      const lead = g.genres[0] || this.inferredGenres(g)[0] || (this.active().find((o) => o.genres.length) || { genres: [] }).genres[0];
      const genre = lead ? Engine.expandPick(lead)[0] : '';
      if (Engine.GENRES.includes(genre)) out.push({ name, genre });
    }
    return out.slice(0, 3);
  }

  // Songs the host's service found for a genre. Each is {title, artist, genres?, id?}: genres are the tags the search
  // implied ("blues rock" gives blues and rock) and id is the service's own id, so playing needs no second lookup.
  /** @param {string} genre @param {Track[]} tracks @param {{pool?: boolean, source?: string, artist?: string}} [opts] @returns {number} songs kept */
  addExtras(genre, tracks, opts = {}) {
    if (!Engine.GENRES.includes(genre)) return 0;
    if (opts.pool === true) {
      if (!this.poolMode) { L.tally('source', String(opts.source || 'pool').slice(0, 20)); L.info('pool.started', { room: L.roomTag(this.code), source: String(opts.source || '').slice(0, 20) }); }
      this.poolMode = true;
    }
    const wantKey = opts.artist ? Engine.normKey(cleanText(opts.artist, 60)) : '';
    if (wantKey) { this.searchedArtists.add(wantKey); if (this.searchedArtists.size > MAX_SEARCHED_ARTISTS) this.searchedArtists.delete(this.searchedArtists.values().next().value); } else this.searched.add(genre);
    const keyOf = (t) => norm(t.title) + '|' + norm(t.artist);
    const seen = new Map(this.extra.map((t) => [keyOf(t), t]));
    const curatedKeys = this.poolMode ? null : new Set(CURATED.map(keyOf));
    let added = 0;
    for (const t of (Array.isArray(tracks) ? tracks : []).slice(0, 160)) {
      if (!t || typeof t !== 'object') continue;
      const title = typeof t.title === 'string' ? t.title.slice(0, 100) : '';
      const artist = typeof t.artist === 'string' ? t.artist.slice(0, 100) : '';
      if (!title || !artist) continue;
      if (wantKey && !Engine.artistKeys(artist).has(wantKey)) continue; // an artist lookup only keeps that artist's songs
      const tags = [...new Set((Array.isArray(t.genres) ? t.genres : [genre]).filter((g) => Engine.GENRES.includes(g)))].slice(0, 3);
      if (!tags.length) tags.push(genre);
      const nid = typeof t.id === 'string' && /^[A-Za-z0-9:_-]{1,64}$/.test(t.id) ? t.id : '';
      const key = keyOf({ title, artist });
      const prior = seen.get(key);
      if (prior) { for (const g of tags) if (prior.genres.length < 3 && !prior.genres.includes(g)) prior.genres.push(g); if (nid && !prior.nid) prior.nid = nid; continue; }
      if (curatedKeys && curatedKeys.has(key)) continue;
      if (this.extra.length >= MAX_EXTRA) break;
      const x = { id: 'x' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 10), title, artist, genres: tags };
      if (nid) x.nid = nid;
      this.extra.push(x); seen.set(key, x);
      added++;
    }
    L.count('pool.posts'); L.count('pool.songs', added);
    if (wantKey) { L.count('picks.artist_lookups'); if (!added) L.count('picks.artist_lookups_empty'); }
    L.info('pool.received', { room: L.roomTag(this.code), genre, added, offered: Array.isArray(tracks) ? tracks.length : 0, total: this.extra.length, pool: this.poolMode });
    // When the service's songs arrive the upcoming songs are planned again (the one playing is left alone), so bridge songs
    // found for two guests are used from the next slot instead of after the old queue runs out.
    if (added || (this.poolMode && !wantKey)) { this.rebuildCatalog(); this.rebuild(null, !this.poolMode); } else this.bump();
    return added;
  }

  // Search the room's songs; the server adds external MusicBrainz results.
  /** @param {string} q @returns {{artists: Array<{name: string, songs: number}>, songs: Array<{title: string, artist: string}>}} */
  search(q) {
    const words = Engine.normKey(cleanText(q, 60)).split(' ').filter(Boolean);
    if (!words.length || Engine.normKey(words.join(' ')).length < 2) return { artists: [], songs: [] };
    const hit = (hay) => words.every((w) => hay.includes(w));
    const artists = new Map(), songs = [], seenSong = new Set();
    for (const t of this.catalog.tracks) {
      const a = Engine.normKey(t.artist), ti = Engine.normKey(t.title);
      if (hit(a)) { const e = artists.get(a) || { name: t.artist, songs: 0 }; e.songs++; artists.set(a, e); }
      if (hit(ti + ' ' + a)) { const k = Engine.songKey(t.title, t.artist); if (!seenSong.has(k) && songs.length < 8) { seenSong.add(k); songs.push({ title: t.title, artist: t.artist }); } }
    }
    const prefix = (e) => (Engine.normKey(e.name).startsWith(words[0]) ? 0 : 1);
    return { artists: [...artists.values()].sort((x, y) => prefix(x) - prefix(y) || y.songs - x.songs).slice(0, 8), songs };
  }

  // ---------- views ----------
  why() {
    const it = this.nowItem;
    if (!it) return '';
    let min = Infinity, minName = '', known = 0;
    for (const f of it.fits) {
      const g = this.guests.get(f.id);
      if (!g) continue;
      known++;
      if (f.fit < min) { min = f.fit; minName = g.name; }
    }
    if (!known) return 'Everyone who was here has left. Add a guest to pick up again.';
    if (it.mode === 'blend') {
      return known > 1
        ? `Blend pick. Room score ${it.room.toFixed(2)}. The least-happy guest, ${minName}, is at ${pct(min)}% fit.`
        : `Only one guest is in the blend, so this follows their taste. Room score ${it.room.toFixed(2)}.`;
    }
    const o = this.guests.get(it.owner);
    return `Rotation pick for ${o ? o.name : 'a guest'}. No song reaches a room score of ${this.opts.tau.toFixed(2)} for everyone, so slots take turns. This one scores ${it.room.toFixed(2)} for the room.`;
  }

  setInfo(o) {
    if (typeof o.name === 'string') this.name = cleanName2(o.name);
    if (typeof o.discoverable === 'boolean') this.discoverable = o.discoverable;
    this.bump();
  }

  // What a TV or projector shows: the same things guests see, with no personal details.
  screenView() {
    const it = this.nowItem;
    return {
      role: 'screen', code: this.code, name: this.name, people: this.active().length, mode: this.mode,
      now: it ? { title: it.track.title, artist: it.track.artist, mode: it.mode } : null,
      next: this.queue.slice(0, 4).map((q) => ({ title: q.track.title, artist: q.track.artist })),
    };
  }

  trackView(t) { return t.nid ? { id: t.id, title: t.title, artist: t.artist, genres: t.genres, nid: t.nid } : { id: t.id, title: t.title, artist: t.artist, genres: t.genres }; }

  hostView() {
    const it = this.nowItem;
    const hist = this.history.slice(-VIEW_HISTORY).map((h) => ({ track: this.trackView(h.track), mode: h.mode, requester: h.request && h.request.requester, owner: h.owner, room: h.room, fits: h.fits, votes: this.voteCounts(h.track.id) }));
    return {
      role: 'host', code: this.code, name: this.name, discoverable: this.discoverable, version: this.version, recoveryNeeded: this.recoveryNeeded, opts: this.opts, mode: this.mode, bestRoom: this.bestRoom,
      now: it ? { track: this.trackView(it.track), mode: it.mode, request: !!it.request, requester: it.request && it.request.requester, owner: it.owner, room: it.room, fits: it.fits, why: it.request ? 'Requested by ' + it.request.requester + '.' : this.why(), votes: this.voteCounts(it.track.id) } : null,
      queue: this.queue.map((q) => ({ track: this.trackView(q.track), mode: q.mode, owner: q.owner, room: q.room, fits: q.fits, isNew: !!q.isNew })),
      requests: this.requestQueue.map((r, i) => ({ ...r, position: i + 1 })), requestLimitEnabled: this.requestLimitEnabled,
      guests: [...this.guests.values()].map((g) => ({ id: g.id, name: g.name, genres: g.genres, inferred: g.genres.length ? [] : this.inferredGenres(g), picks: g.artists.length + g.songs.length, artistCount: g.artists.length, songCount: g.songs.length, color: g.color, status: g.status, sit: g.sit, hostSit: g.hostSit, away: g.away, dozing: !!g.hiddenAt && !g.connected, manual: g.manual, connected: g.connected, arriveIn: g.status === 'arriving' ? Math.max(1, Math.ceil((g.arriveAt - Date.now()) / 1000)) : 0 })),
      history: hist, log: this.log, wantGenres: this.wantGenres(), wantEras: this.wantEras(), wantArtists: this.wantArtists(), catalogSize: this.catalog.tracks.length, poolMode: this.poolMode, source: this.source,
      fairness: [...this.guests.values()].map((g) => {
        let sum = 0, cnt = 0, own = 0;
        for (const h of this.history) { for (const f of h.fits) if (f.id === g.id) { sum += f.fit; cnt++; } if (h.owner === g.id) own++; }
        return { id: g.id, avg: cnt ? sum / cnt : 0, songs: cnt, own };
      }),
    };
  }

  // Guests see the room, never other people's tastes or scores.
  guestView(guestId) {
    const me = this.guests.get(guestId);
    const it = this.nowItem;
    const myFit = (x) => { const f = x.fits.find((q) => q.id === guestId); return f ? pct(f.fit) : null; };
    const mine = this.votes[it && it.track.id] ? this.votes[it.track.id][guestId] || null : null;
    return {
      role: 'guest', code: this.code, name: this.name, version: this.version, mode: this.mode,
      people: this.active().length,
      me: me ? { id: me.id, name: me.name, genres: me.genres, inferred: me.genres.length ? [] : this.inferredGenres(me), artists: me.artists, songs: me.songs, lookupGenres: me.lookupGenres, genreLookupStatus: me.genreLookupStatus, status: me.status, sit: me.sit, hostSit: me.hostSit, away: me.away, ask: !!me.askAt, color: me.color } : null,
      now: it ? { track: { title: it.track.title, artist: it.track.artist }, mode: it.mode, request: !!it.request, fit: myFit(it), why: it.request ? 'Requested by ' + (it.request.requester || 'a guest') + '.' : this.guestWhy(it, guestId), myVote: mine } : null,
      next: this.queue.slice(0, 3).map((q) => ({ title: q.track.title, artist: q.track.artist, mode: q.mode, mine: q.owner === guestId })),
      requests: this.requestQueue.map((r, i) => ({ id: r.id, title: r.title, artist: r.artist, requester: r.requester, mine: r.guestId === guestId, position: i + 1 + Math.floor((this.requestStreak + i) / 2) })),
      myRequestCount: this.requestQueue.filter((r) => r.guestId === guestId).length + (it && it.request && it.request.guestId === guestId ? 1 : 0), requestLimitEnabled: this.requestLimitEnabled,
      // Everything that played since this guest arrived (or first arrived, when they rejoin), newest first.
      played: me ? this.history.filter((h) => (h.at || 0) >= me.sinceAt).slice(-VIEW_HISTORY).reverse().map((h) => ({
        id: h.track.id, title: h.track.title, artist: h.track.artist, genres: h.track.genres, mode: h.mode, requester: h.request && h.request.requester, at: h.at, fit: myFit(h), playing: !!it && h.track.id === it.track.id && h === this.history[this.history.length - 1],
      })) : [],
    };
  }

  guestWhy(it, guestId) {
    if (it.mode === 'blend') return 'Blended from what everyone here likes.';
    return it.owner === guestId ? 'This one is your turn.' : 'The room has little in common right now, so songs take turns.';
  }
}

module.exports = { DOZE_DEFAULT_MIN, Room, cleanName, cleanGenres, cleanArtists, cleanSongs, rid, DISCONNECT_GRACE_MS, IDLE_ASK_S, IDLE_ANSWER_MS, AWAY_REMOVE_MS };
