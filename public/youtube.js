// YouTube source: plays each queued song in YouTube's official embedded player, in the host's browser.
// No Premium account is needed. The host brings a free Google API key, used only to look each song up
// (YouTube Data API search). The key stays in this browser. The Room Blend server never sees it.
//
// Songs come from YouTube playlists, one per genre in the room (see poolQuery). Search requests have a separate
// daily limit (typically 100 calls per project); playlist-item and video-detail requests use the much larger quota.
// Search results and discovered pools are cached in the host's browser, never on the Room Blend server.
// YouTube requires the player to stay visible, so it sits in a corner of the page. Free YouTube may play ads between songs.
(function () {
  'use strict';
  var P = window.Providers, C = window.CONFIG || {}, el = P.el, state = P.state;
  var KEY = 'rb-yt-key', LEGACY_CACHE = 'rb-yt-cache', LEGACY_POOLS = 'rb-yt-pools', CACHE_MAX = 3000, QUOTA_DAY = 'rb-yt-quota-day', API_NEXT = 'rb-yt-api-next';
  var DB_NAME = 'room-blend-youtube', DB_VERSION = 1, DB_STORE = 'entries', DB_MIGRATION = 'rb-yt-idb-migrated';
  var cacheDbPromise = null, cacheMemory = Object.create(null), cacheWarning = '';
  var SEARCH_DAILY_LIMIT = 90, DISCOVERY_DAILY_LIMIT = 65, SEARCH_BUDGET_KEY = 'rb-yt-search-budget';
  var on = false, paused = true, busy = false, note = '', player = null, dock = null, cur = null, waiter = null, rctx = null;
  var apiQueue = Promise.resolve(), apiRetryMs = 1000, playbackAttempt = 0;
  var quotaPausedDay = '', API_INTERVAL_MS = Number.isFinite(Number(C.ytApiIntervalMs)) && Number(C.ytApiIntervalMs) >= 0 ? Number(C.ytApiIntervalMs) : 2000, MAX_RETRY_WAIT_MS = 5000, MIN_GENRE_TRACKS = 12;

  function lsGet(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  function apiKey() { return lsGet(KEY).trim(); }
  function keyLooksRight(k) { return /^[A-Za-z0-9_-]{30,60}$/.test(k); }

  function storedObject(key) {
    try { return JSON.parse(lsGet(key) || '{}') || {}; } catch (e) { return {}; }
  }
  function openCacheDb() {
    if (!window.indexedDB) { cacheWarning = 'Persistent browser storage is unavailable; discoveries will only be cached until this tab closes.'; return Promise.resolve(null); }
    if (!cacheDbPromise) cacheDbPromise = new Promise(function (resolve, reject) {
      var request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = function () {
        var db = request.result;
        if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE, { keyPath: 'id' });
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error('Could not open the browser cache')); };
      request.onblocked = function () { reject(new Error('The browser cache is blocked by another tab')); };
    }).then(async function (db) {
      if (lsGet(DB_MIGRATION) !== '1') {
        var oldSearch = storedObject(LEGACY_CACHE), oldPools = storedObject(LEGACY_POOLS), now = Date.now();
        await new Promise(function (resolve, reject) {
          var tx = db.transaction(DB_STORE, 'readwrite'), store = tx.objectStore(DB_STORE);
          Object.keys(oldSearch).forEach(function (key) {
            var value = oldSearch[key], empty = !Array.isArray(value) || value.length === 0;
            store.put({ id: 'search:' + key, kind: 'search', value: value, at: now, usedAt: now, expiresAt: now + (empty ? 6 : 30) * 86400000 });
          });
          Object.keys(oldPools).forEach(function (key) {
            var pool = oldPools[key], tracks = pool && Array.isArray(pool.tracks) ? pool.tracks : [], at = pool && pool.at || now;
            if (now - at >= (tracks.length ? 30 : 0.5) * 86400000) return;
            store.put({ id: 'pool:' + key, kind: 'pool', value: tracks, at: at, usedAt: pool.usedAt || at, expiresAt: at + (tracks.length ? 30 : 0.5) * 86400000 });
          });
          tx.oncomplete = resolve; tx.onerror = function () { reject(tx.error || new Error('Could not migrate the browser cache')); }; tx.onabort = function () { reject(tx.error || new Error('Browser cache migration was interrupted')); };
        });
        lsDel(LEGACY_CACHE); lsDel(LEGACY_POOLS); lsSet(DB_MIGRATION, '1');
      }
      return db;
    }).catch(function () {
      var now = Date.now(), oldSearch = storedObject(LEGACY_CACHE), oldPools = storedObject(LEGACY_POOLS);
      Object.keys(oldSearch).forEach(function (key) {
        var value = oldSearch[key], ttl = Array.isArray(value) && value.length ? 30 : 0.25;
        cacheMemory['search:' + key] = { value: value, usedAt: now, expiresAt: now + ttl * 86400000 };
      });
      Object.keys(oldPools).forEach(function (key) {
        var pool = oldPools[key], tracks = pool && Array.isArray(pool.tracks) ? pool.tracks : [], at = pool && pool.at || now;
        var ttl = tracks.length ? 30 : 0.5;
        if (now - at < ttl * 86400000) cacheMemory['pool:' + key] = { value: tracks, usedAt: now, expiresAt: at + ttl * 86400000 };
      });
      cacheWarning = 'Persistent browser storage is unavailable; discoveries will only be cached until this tab closes.';
      if (rctx) rctx.status(cacheWarning);
      return null;
    });
    return cacheDbPromise;
  }
  async function cacheGet(id) {
    var local = cacheMemory[id];
    if (local && local.expiresAt > Date.now()) { local.usedAt = Date.now(); return local.value; }
    if (local) delete cacheMemory[id];
    var db = await openCacheDb();
    if (!db) return undefined;
    return new Promise(function (resolve) {
      var tx = db.transaction(DB_STORE, 'readwrite'), store = tx.objectStore(DB_STORE), request = store.get(id);
      request.onsuccess = function () {
        var record = request.result;
        if (!record) return resolve(undefined);
        if (record.expiresAt <= Date.now()) { store.delete(id); return resolve(undefined); }
        record.usedAt = Date.now(); store.put(record); resolve(record.value);
      };
      request.onerror = function () { resolve(undefined); };
    });
  }
  async function cachePut(id, value, kind, ttlDays) {
    var now = Date.now(), record = { id: id, kind: kind, value: value, at: now, usedAt: now, expiresAt: now + ttlDays * 86400000 };
    var db = await openCacheDb();
    if (!db) { cacheMemory[id] = record; return false; }
    try {
      await new Promise(function (resolve, reject) {
        var tx = db.transaction(DB_STORE, 'readwrite'), store = tx.objectStore(DB_STORE);
        store.put(record);
        var all = store.getAll();
        all.onsuccess = function () {
          var matching = all.result.filter(function (x) { return x.kind === kind; });
          var limit = kind === 'pool' ? 400 : CACHE_MAX;
          if (matching.length > limit) matching.sort(function (a, b) { return a.usedAt - b.usedAt; }).slice(0, matching.length - limit).forEach(function (x) { store.delete(x.id); });
        };
        tx.oncomplete = resolve; tx.onerror = function () { reject(tx.error); }; tx.onabort = function () { reject(tx.error); };
      });
      return true;
    } catch (error) {
      cacheMemory[id] = record;
      cacheWarning = 'The browser could not persist some cache entries; playback can continue, but they may need to be discovered again.';
      if (rctx) rctx.status(cacheWarning);
      return false;
    }
  }

  function retryAfterMs(response) {
    var value = response.headers && response.headers.get('Retry-After');
    if (!value) return 0;
    var seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    var date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
  }

  function wait(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

  function pacificDay() {
    var parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    var date = {};
    parts.forEach(function (part) { date[part.type] = part.value; });
    return date.year + '-' + date.month + '-' + date.day;
  }
  function quotaPaused() {
    var today = pacificDay(), stored = lsGet(QUOTA_DAY);
    if (quotaPausedDay === today || stored === today) { quotaPausedDay = today; return true; }
    if (stored) lsDel(QUOTA_DAY);
    quotaPausedDay = '';
    return false;
  }
  function clearQuotaFuse() { quotaPausedDay = ''; lsDel(QUOTA_DAY); }
  // Search.list's 100-request daily limit is shared by API keys in the same Google Cloud project.
  // Use one conservative browser-wide counter so switching keys cannot accidentally reset the local guard.
  // Hold back 25 calls for playback lookups and leave a safety margin below Google's project cap.
  function searchBudget() {
    var value = storedObject(SEARCH_BUDGET_KEY), today = pacificDay();
    if (value.day !== today) value = { day: today, count: 0, discovery: 0 };
    return { key: SEARCH_BUDGET_KEY, value: value };
  }
  function reserveSearch(purpose) {
    var budget = searchBudget(), value = budget.value;
    if (value.count >= SEARCH_DAILY_LIMIT || (purpose === 'discovery' && value.discovery >= DISCOVERY_DAILY_LIMIT)) {
      var e = new Error(purpose === 'discovery'
        ? 'YouTube discovery has used its daily search allowance. Playback lookups are being preserved; cached songs remain available.'
        : 'The host browser has reached its conservative daily YouTube search limit. Cached songs remain available until the quota resets at midnight Pacific time.');
      e.budgetLimited = true; e.quotaExceeded = true;
      throw e;
    }
    value.count++;
    if (purpose === 'discovery') value.discovery++;
    lsSet(budget.key, JSON.stringify(value));
  }
  function searchBudgetStatus() {
    var v = searchBudget().value;
    return Math.max(0, SEARCH_DAILY_LIMIT - v.count) + ' of ' + SEARCH_DAILY_LIMIT + ' YouTube searches left today (' + Math.max(0, DISCOVERY_DAILY_LIMIT - v.discovery) + ' reserved discovery searches available).';
  }
  function quotaError() {
    var e = new Error('YouTube searches are paused until midnight Pacific time after the daily quota or repeated rate limits; cached songs can still play.');
    e.quotaExceeded = true;
    return e;
  }
  function pauseForQuota() {
    quotaPausedDay = pacificDay();
    lsSet(QUOTA_DAY, quotaPausedDay);
    lsDel(API_NEXT);
    note = quotaError().message;
    if (rctx) rctx.status(note);
  }
  function requestCancelled() {
    var e = new Error('YouTube request cancelled.');
    e.cancelled = true;
    return e;
  }
  async function requestApi(url, isCurrent, searchPurpose) {
    async function run() {
      while (true) {
        if (isCurrent && !isCurrent()) throw requestCancelled();
        if (quotaPaused()) throw quotaError();
        var delay = Number(lsGet(API_NEXT)) - Date.now();
        if (delay > 0) { await wait(Math.min(delay, 1000)); continue; }
        lsSet(API_NEXT, String(Date.now() + API_INTERVAL_MS));
        if (quotaPaused()) throw quotaError();
        if (searchPurpose) reserveSearch(searchPurpose);
        var r;
        try { r = await fetch(url); }
        catch (e) { throw new Error('Could not reach YouTube. Check the internet connection.'); }
        var j = null; try { j = await r.json(); } catch (e) { /* not json */ }
        if (isCurrent && !isCurrent()) throw requestCancelled();
        var reason = j && j.error && j.error.errors && j.error.errors[0] && j.error.errors[0].reason || '';
        if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') pauseForQuota();
        if (r.status === 429 || reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded') {
          var retryMs = Math.min(300000, Math.max(retryAfterMs(r), apiRetryMs));
          lsSet(API_NEXT, String(Math.max(Number(lsGet(API_NEXT)) || 0, Date.now() + retryMs)));
        }
        return { response: r, json: j, reason: reason };
      }
    }
    if (navigator.locks && navigator.locks.request) return navigator.locks.request('room-blend-youtube-api', { mode: 'exclusive' }, run);
    return run();
  }

  window.addEventListener('storage', function (event) {
    if (event.key === KEY && event.newValue !== event.oldValue) { quotaPausedDay = ''; note = ''; }
    if (event.key === QUOTA_DAY && quotaPaused()) {
      note = quotaError().message;
      if (rctx) rctx.status(note);
    }
  });

  // Serialize API requests so a rate limit pauses all callers instead of causing a retry storm.
  function yapi(path, params, isCurrent, searchPurpose) {
    var qs = Object.keys(params).map(function (k) { return k + '=' + encodeURIComponent(params[k]); }).join('&');
    var rateLimitAttempts = 0, maxRateLimitRetries = 1;
    var request = apiQueue.then(async function () {
      while (true) {
        if (isCurrent && !isCurrent()) throw requestCancelled();
        if (quotaPaused()) throw quotaError();
        var result = await requestApi(C.ytApiBase + path + '?' + qs + '&key=' + encodeURIComponent(apiKey()), isCurrent, path === '/search' ? (searchPurpose || 'playback') : '');
        var r = result.response, j = result.json, reason = result.reason;
        if (r.ok) { apiRetryMs = 1000; return j || {}; }
        if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') throw quotaError();
        if (r.status === 429 || reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded') {
          var delay = Math.max(retryAfterMs(r), apiRetryMs);
          if (rateLimitAttempts >= maxRateLimitRetries || delay > MAX_RETRY_WAIT_MS) {
            if (r.status === 429 || (r.status === 403 && reason === 'rateLimitExceeded')) { pauseForQuota(); throw quotaError(); }
            var limited = new Error('YouTube is still rate limiting requests. Skipping this song so playback can continue.');
            limited.skipTrack = true;
            note = limited.message;
            if (rctx) rctx.status(note);
            throw limited;
          }
          rateLimitAttempts++;
          apiRetryMs = Math.min(MAX_RETRY_WAIT_MS, apiRetryMs * 2);
          note = 'YouTube is rate limiting requests. Retrying in ' + Math.ceil(delay / 1000) + ' seconds; playback will resume automatically.';
          if (rctx) rctx.status(note);
          var remaining = delay;
          while (remaining > 0) {
            var slice = Math.min(1000, remaining);
            await wait(slice); remaining -= slice;
            if (isCurrent && !isCurrent()) throw requestCancelled();
          }
          continue;
        }
        if (r.status === 400 || reason === 'keyInvalid' || reason === 'API_KEY_INVALID') throw new Error('YouTube did not accept the API key. Check that the YouTube Data API v3 is enabled for it.');
        if (r.status === 403) throw new Error('YouTube refused the key. It may be restricted to websites, or the YouTube Data API v3 is not enabled for it.');
        throw new Error('YouTube search failed (' + r.status + ').');
      }
    });
    apiQueue = request.then(function () {}, function () {});
    return request;
  }

  // Finds embeddable videos for a song by title and artist (used for songs from the built-in list).
  // Returns a list of video ids, best first (empty when YouTube has nothing).
  // One search costs the same however many results it returns, so we ask for several and keep them as fallbacks.
  async function search(track, isCurrent) {
    var ck = (track.title + '|' + track.artist).toLowerCase(), hit = await cacheGet('search:' + ck);
    if (hit !== undefined) return Array.isArray(hit) ? hit : (hit ? [hit] : []);
    var M = window.Match, q = M.cleanTitle(track.title) + ' ' + M.cleanArtist(track.artist);
    var j = await yapi('/search', { part: 'snippet', type: 'video', videoEmbeddable: 'true', videoSyndicated: 'true', maxResults: 8, q: q }, isCurrent);
    var items = (j.items || []).filter(function (it) { return it && it.id && it.id.videoId; });
    // Best match first. Videos that clearly are not this song (a different title) go last rather than being dropped.
    var ranked = M.rank(track, items, function (it) { return { title: (it.snippet || {}).title, channel: (it.snippet || {}).channelTitle }; }, M.scoreVideo)
      .map(function (x) { return x.item.id.videoId; });
    await cachePut('search:' + ck, ranked, 'search', ranked.length ? 30 : 0.25);
    return ranked;
  }

  // ---------- songs by genre (playlist reads and video details use 1 quota unit per request; search has its own daily call cap) ----------
  async function poolGet(k) { return await cacheGet('pool:' + k); }
  async function poolPut(k, tracks) { return await cachePut('pool:' + k, tracks, 'pool', tracks.length ? 30 : 0.5); }
  function seconds(iso) { var m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || ''); return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0; }
  // "Artist - Song (Official Video)" on a channel, or "Song" on the artist's "Artist - Topic" channel.
  function parseVideo(v) {
    var M = window.Match, title = M.cleanTitle(v.title);
    var ch = String(v.channel || '').replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').trim();
    var m = /^(.+?)\s+[-\u2013\u2014|:]\s+(.+)$/.exec(title);
    var artist = m ? m[1] : ch, song = m ? m[2] : title;
    artist = M.cleanArtist(artist.replace(/\s+(feat\.?|ft\.?|featuring)\s+.*$/i, ''));
    song = M.cleanTitle(song);
    return artist && song && artist.length < 80 && song.length < 100 ? { title: song, artist: artist } : null;
  }
  async function playlistFor(q) {
    var j = await yapi('/search', { part: 'snippet', type: 'playlist', maxResults: 5, q: q + ' songs' }, null, 'discovery');
    var items = (j.items || []).filter(function (it) { return it && it.id && it.id.playlistId; });
    var good = items.filter(function (it) { return !/\b(hours?|mix|study|sleep|full albums?)\b/i.test((it.snippet || {}).title || ''); });
    return ((good[0] || items[0] || {}).id || {}).playlistId || '';
  }
  // Songs for one query ("blues rock"): the best matching playlist, read and filtered to single, embeddable songs.
  async function poolQuery(q) {
    var hit = await poolGet(q.q);
    if (hit !== undefined) return hit;
    var M = window.Match, pl = await playlistFor(q.q), ids = [], token = '';
    if (!pl) { await poolPut(q.q, []); return []; }
    for (var page = 0; page < 2; page++) {
      var p = { part: 'snippet', maxResults: 50, playlistId: pl }; if (token) p.pageToken = token;
      var j = await yapi('/playlistItems', p);
      (j.items || []).forEach(function (it) { var id = it.snippet && it.snippet.resourceId && it.snippet.resourceId.videoId; if (id && !/^(Private|Deleted) video$/.test(it.snippet.title)) ids.push(id); });
      token = j.nextPageToken || ''; if (!token) break;
    }
    var out = [], seen = {};
    for (var i = 0; i < ids.length; i += 50) {
      var v = await yapi('/videos', { part: 'snippet,contentDetails,status', id: ids.slice(i, i + 50).join(',') });
      (v.items || []).forEach(function (it) {
        var st = it.status || {}, sn = it.snippet || {}, d = seconds((it.contentDetails || {}).duration);
        if (st.embeddable !== true || st.privacyStatus !== 'public' || d < 60 || d > 600 || M.isBad(sn.title)) return;
        var t = parseVideo({ title: sn.title, channel: sn.channelTitle });
        if (!t || seen[it.id]) return;
        seen[it.id] = 1; out.push({ title: t.title, artist: t.artist, id: it.id });
      });
    }
    await poolPut(q.q, out);
    return out;
  }

  // A video that would not play goes to the back of the song's list, so next time the others are tried first.
  async function demote(track, id) {
    var ck = (track.title + '|' + track.artist).toLowerCase(), hit = await cacheGet('search:' + ck);
    if (Array.isArray(hit) && hit.indexOf(id) >= 0) await cachePut('search:' + ck, hit.filter(function (x) { return x !== id; }).concat(id), 'search', 30);
  }

  function loadApi() {
    return new Promise(function (resolve, reject) {
      if (window.YT && window.YT.Player) return resolve();
      var prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = function () { if (prev) prev(); resolve(); };
      var s = document.createElement('script'); s.src = C.ytIframeUrl; s.async = true;
      s.onerror = function () { reject(new Error('Could not load the YouTube player. Check the internet connection.')); };
      document.head.appendChild(s);
    });
  }

  function makeDock() {
    if (dock) return dock;
    dock = el('div', { id: 'yt-dock', role: 'region', 'aria-label': 'YouTube player' }, [
      el('div', { class: 'hint', text: 'YouTube player. Keep it visible.' }),
      el('div', { id: 'yt-holder' }),
    ]);
    dock.setAttribute('style', 'position:fixed;right:12px;bottom:12px;z-index:60;padding:8px;border-radius:12px;background:Canvas;color:CanvasText;border:1px solid rgba(128,128,128,.4);box-shadow:0 6px 24px rgba(0,0,0,.25)');
    document.body.appendChild(dock);
    return dock;
  }

  function stateChange(e) {
    var s = e && e.data;
    if (s === 1) { paused = false; if (waiter) waiter(true); }
    else if (s === 2) paused = true;
    else if (s === 0) { paused = true; if (cur && !waiter) { cur = null; if (rctx) rctx.ended(); } }
  }
  function playerError(e) {
    var code = e && e.data;
    note = code === 101 || code === 150 ? 'The owner of that video does not allow embedding, so it was skipped.' : 'YouTube could not play that video, so it was skipped.';
    if (waiter) waiter(null);
    else if (cur && rctx) { cur = null; rctx.ended(); }
  }

  // Loads one video. true: playing. null: this video cannot be played (try another). false: timed out.
  function tryVideo(id) {
    return new Promise(function (resolve) {
      var done = false, timer;
      function fin(v) { if (done) return; done = true; clearTimeout(timer); waiter = null; resolve(v); }
      timer = setTimeout(function () { note = 'YouTube did not start the song. Press play on the YouTube player in the corner.'; fin(false); }, 15000);
      waiter = fin; cur = id; note = '';
      try { player.loadVideoById(id); } catch (e) { note = 'The YouTube player is not ready.'; fin(false); }
    });
  }

  var yt = {
    id: 'youtube', name: 'YouTube', blurb: 'Free. Plays in YouTube\'s own player.', kind: 'curated',
    render: function (ctx) {
      rctx = ctx;
      if (dock) dock.hidden = !on;
      var box = el('div'), k = apiKey(), quotaNote = quotaPaused() ? quotaError().message : '';
      if (!k) {
        box.appendChild(state('dot-off', 'Needs a free Google API key.', 'No YouTube account or Premium is needed. The key is only used to look songs up, and it stays in this browser.'));
        var input = el('input', { type: 'text', id: 'yt-key', placeholder: 'API key (starts with AIza)', autocomplete: 'off', spellcheck: 'false' });
        var msg = el('p', { class: 'hint', id: 'yt-msg', role: 'status' });
        box.appendChild(el('ol', { class: 'steps' }, [
          el('li', { text: 'Open console.cloud.google.com and create a project (free, no card needed for this).' }),
          el('li', { text: 'Go to APIs & Services, then Library. Search for "YouTube Data API v3" and press Enable.' }),
          el('li', { text: 'Go to Credentials, then Create credentials, then API key. Copy it.' }),
          el('li', { text: 'Under the key\'s restrictions, restrict it to the YouTube Data API v3 only. Do not restrict it to websites: Room Blend sends no referrer, so a website restriction would block it.' }),
          el('li', { text: 'Paste the key here.' }),
        ]));
        box.appendChild(el('div', { class: 'row' }, [input, el('button', { class: 'btn primary', type: 'button', id: 'yt-save', text: 'Save key', onclick: function () {
          var v = input.value.trim();
          if (!keyLooksRight(v)) { msg.textContent = 'That does not look like an API key. It is 39 letters and numbers.'; return; }
          if (v !== apiKey()) clearQuotaFuse();
          lsSet(KEY, v); ctx.rerender();
        } })]));
        box.appendChild(msg);
        box.appendChild(el('p', { class: 'hint', text: 'YouTube Search has a separate daily limit (typically 100 requests). Room Blend conservatively allows 90 per key per Pacific day, reserving 25 for playback lookups and using at most 65 for discovery. Playlist reads and video details use a much larger quota. Successful discoveries stay in this browser for 30 days; empty searches are retried after 12 hours. ' + cacheWarning }));
      } else if (!on) {
        box.appendChild(state('dot-ok', 'Key saved.', note || quotaNote || cacheWarning || ('Start the music to play through this browser. ' + searchBudgetStatus())));
        box.appendChild(el('div', { class: 'row' }, [
          el('button', { class: 'btn primary', type: 'button', id: 'yt-start', text: busy ? 'Starting…' : 'Start the music', disabled: busy ? 'disabled' : false, onclick: function () { yt.start(ctx); } }),
          el('button', { class: 'btn small', type: 'button', id: 'yt-forget', text: 'Remove key', onclick: function () { clearQuotaFuse(); lsDel(KEY); ctx.rerender(); } }),
        ]));
      } else {
        box.appendChild(state('dot-ok', 'Playing through YouTube.', note || quotaNote || cacheWarning || 'Keep this tab open and the player visible. Free YouTube may play an ad between songs.'));
        box.appendChild(el('div', { class: 'row' }, [el('button', { class: 'btn small', type: 'button', id: 'yt-forget', text: 'Remove key', onclick: function () { yt.stop(); on = false; clearQuotaFuse(); lsDel(KEY); ctx.rerender(); } })]));
      }
      return box;
    },
    start: async function (ctx) {
      busy = true; note = ''; ctx.rerender();
      try {
        await loadApi();
        makeDock().hidden = false;
        await new Promise(function (resolve, reject) {
          var t = setTimeout(function () { reject(new Error('The YouTube player did not start.')); }, 15000);
          player = new window.YT.Player('yt-holder', {
            width: 240, height: 240, playerVars: { playsinline: 1, rel: 0, origin: location.origin },
            events: { onReady: function () { clearTimeout(t); resolve(); }, onStateChange: stateChange, onError: playerError },
          });
        });
        on = true; busy = false; ctx.rerender(); ctx.changed();
      } catch (e) { busy = false; note = e.message; if (dock) dock.hidden = true; ctx.rerender(); }
    },
    pool: true, // the room's songs come from YouTube playlists for each genre; the built-in list is only a fallback
    canExtras: function () { return on; },
    cacheInfo: async function () { var db = await openCacheDb(); if (!db) return { mode: 'memory', warning: cacheWarning }; return new Promise(function (resolve) { var tx = db.transaction(DB_STORE, 'readonly'), req = tx.objectStore(DB_STORE).getAll(); req.onsuccess = function () { var rows = req.result.filter(function (x) { return x.expiresAt > Date.now(); }); resolve({ mode: 'indexeddb', pools: rows.filter(function (x) { return x.kind === 'pool'; }).length, searches: rows.filter(function (x) { return x.kind === 'search'; }).length, warning: cacheWarning }); }; req.onerror = function () { resolve({ mode: 'indexeddb', warning: cacheWarning }); }; }); },
    extras: async function (genre, partners) {
      var out = [], seen = {};
      try {
        var qs = window.Pools.queries(genre, 4, partners);
        for (var i = 0; i < qs.length; i++) {
          var got = await poolQuery(qs[i]);
          got.forEach(function (t) { if (!seen[t.id]) { seen[t.id] = 1; out.push({ title: t.title, artist: t.artist, id: t.id, genres: qs[i].tags }); } });
          if (out.length >= MIN_GENRE_TRACKS) break;
        }
      } catch (e) { note = e.message; if (rctx) rctx.status(e.message); }
      return out;
    },
    // Era-qualified searches keep decade picks meaningful after the room expands them into genres.
    // Each query is cached like every other playlist, and tags only the genre it actually searched.
    eraTracks: async function (era, genre) {
      try {
        var got = await poolQuery({ q: era + ' ' + genre, tags: [genre] });
        return got.map(function (t) { return { title: t.title, artist: t.artist, id: t.id, genres: [genre] }; });
      } catch (e) { note = e.message; if (rctx) rctx.status(e.message); return []; }
    },
    // A named artist: one playlist search ("<artist> greatest hits"); the room keeps only that artist's songs.
    artistTracks: async function (name, genre) {
      try {
        var got = await poolQuery({ q: name + ' greatest hits', tags: [genre] });
        return got.map(function (t) { return { title: t.title, artist: t.artist, id: t.id, genres: [genre] }; });
      } catch (e) { note = e.message; if (rctx) rctx.status(e.message); return []; }
    },
    ready: function () { return on; },
    lastError: function () { return note; },
    play: async function (track) {
      var attempt = ++playbackAttempt, isCurrent = function () { return attempt === playbackAttempt && on; };
      var ids;
      if (track.nid) ids = [track.nid]; // found by genre: already a known, embeddable video
      else { try { ids = await search(track, isCurrent); } catch (e) { if (!e.cancelled) note = e.message; return e.quotaExceeded || e.skipTrack ? null : false; } }
      if (!isCurrent()) return false;
      if (!ids.length) { note = '"' + track.title + '" was not found on YouTube, so it was skipped.'; return null; }
      var tries = ids.slice(0, 4);
      for (var i = 0; i < tries.length; i++) {
        var r = await tryVideo(tries[i]);
        if (r === true) return true;
        if (r === false) return false;
        await demote(track, tries[i]); // null: this video is unavailable or not embeddable, try the next one
      }
      note = '"' + track.title + '" has no playable video on YouTube, so it was skipped.';
      return null;
    },
    pause: function () { paused = true; try { player.pauseVideo(); } catch (e) { /* ignore */ } },
    resume: function () { paused = false; try { player.playVideo(); } catch (e) { /* ignore */ } },
    stop: function () { playbackAttempt++; on = false; paused = true; try { if (player) player.stopVideo(); } catch (e) { /* ignore */ } cur = null; if (dock) dock.hidden = true; },
    progress: function () {
      try {
        if (!player || typeof player.getDuration !== 'function' || typeof player.getCurrentTime !== 'function') return null;
        return { currentTime: player.getCurrentTime(), duration: player.getDuration(), paused: paused || !on };
      } catch (e) { return null; }
    },
  };
  P.register(yt);
})();
