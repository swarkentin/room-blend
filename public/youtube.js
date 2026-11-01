// YouTube source: plays each queued song in YouTube's official embedded player, in the host's browser.
// No Premium account is needed. The host brings a free Google API key, used only to look each song up
// (YouTube Data API search). The key stays in this browser. The Room Blend server never sees it.
//
// Limits worth knowing: the free quota is 10,000 units a day and one search costs 100, so about 100 new
// songs a day. Results are remembered in this browser, so repeats cost nothing. YouTube requires the
// player to stay visible, so it sits in a corner of the page. Free YouTube may play ads between songs.
(function () {
  'use strict';
  var P = window.Providers, C = window.CONFIG || {}, el = P.el, state = P.state;
  var KEY = 'rb-yt-key', CACHE = 'rb-yt-cache', CACHE_MAX = 3000;
  var on = false, busy = false, note = '', player = null, dock = null, cur = null, waiter = null, rctx = null, cache = null;

  function lsGet(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  function apiKey() { return lsGet(KEY).trim(); }
  function keyLooksRight(k) { return /^[A-Za-z0-9_-]{30,60}$/.test(k); }

  function cacheGet(k) {
    if (!cache) { try { cache = JSON.parse(lsGet(CACHE) || '{}') || {}; } catch (e) { cache = {}; } }
    return cache[k];
  }
  function cachePut(k, v) {
    cacheGet(k);
    cache[k] = v;
    var keys = Object.keys(cache);
    if (keys.length > CACHE_MAX) keys.slice(0, keys.length - CACHE_MAX).forEach(function (x) { delete cache[x]; });
    lsSet(CACHE, JSON.stringify(cache));
  }
  function cleanTitle(t) { return String(t || '').replace(/\s*\((live|remaster(ed)?[^)]*|[^)]*version)\)/ig, '').trim(); }

  // Finds an embeddable music video. Returns a video id, or null when YouTube has nothing for it.
  async function search(track) {
    var ck = (track.title + '|' + track.artist).toLowerCase(), hit = cacheGet(ck);
    if (hit !== undefined) return hit || null;
    var q = cleanTitle(track.title) + ' ' + track.artist;
    var url = C.ytApiBase + '/search?part=snippet&type=video&videoEmbeddable=true&videoSyndicated=true&videoCategoryId=10&maxResults=1&q=' + encodeURIComponent(q) + '&key=' + encodeURIComponent(apiKey());
    var r;
    try { r = await fetch(url); } catch (e) { throw new Error('Could not reach YouTube. Check the internet connection.'); }
    var j = null; try { j = await r.json(); } catch (e) { /* not json */ }
    if (!r.ok) {
      var reason = j && j.error && j.error.errors && j.error.errors[0] && j.error.errors[0].reason || '';
      if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') throw new Error('Today\'s free YouTube search allowance is used up. It renews at midnight Pacific time. Songs already looked up still play.');
      if (r.status === 400 || reason === 'keyInvalid' || reason === 'API_KEY_INVALID') throw new Error('YouTube did not accept the API key. Check that the YouTube Data API v3 is enabled for it.');
      if (r.status === 403) throw new Error('YouTube refused the key. It may be restricted to websites, or the YouTube Data API v3 is not enabled for it.');
      throw new Error('YouTube search failed (' + r.status + ').');
    }
    var id = j && j.items && j.items[0] && j.items[0].id && j.items[0].id.videoId || '';
    cachePut(ck, id);
    return id || null;
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
    if (s === 1 && waiter) waiter(true);
    else if (s === 0 && cur && !waiter) { cur = null; if (rctx) rctx.ended(); }
  }
  function playerError(e) {
    var code = e && e.data;
    note = code === 101 || code === 150 ? 'The owner of that video does not allow embedding, so it was skipped.' : 'YouTube could not play that video, so it was skipped.';
    if (waiter) waiter(null);
    else if (cur && rctx) { cur = null; rctx.ended(); }
  }

  var yt = {
    id: 'youtube', name: 'YouTube', blurb: 'Free. Plays in YouTube\'s own player.', kind: 'curated',
    render: function (ctx) {
      rctx = ctx;
      if (dock) dock.hidden = !on;
      var box = el('div'), k = apiKey();
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
          lsSet(KEY, v); ctx.rerender();
        } })]));
        box.appendChild(msg);
        box.appendChild(el('p', { class: 'hint', text: 'The free allowance is about 100 new song lookups a day. Songs already looked up are remembered, so repeats cost nothing.' }));
      } else if (!on) {
        box.appendChild(state('dot-ok', 'Key saved.', note || 'Start the music to play through this browser.'));
        box.appendChild(el('div', { class: 'row' }, [
          el('button', { class: 'btn primary', type: 'button', id: 'yt-start', text: busy ? 'Starting…' : 'Start the music', disabled: busy ? 'disabled' : false, onclick: function () { yt.start(ctx); } }),
          el('button', { class: 'btn small', type: 'button', id: 'yt-forget', text: 'Remove key', onclick: function () { lsDel(KEY); ctx.rerender(); } }),
        ]));
      } else {
        box.appendChild(state('dot-ok', 'Playing through YouTube.', note || 'Keep this tab open and the player visible. Free YouTube may play an ad between songs.'));
        box.appendChild(el('div', { class: 'row' }, [el('button', { class: 'btn small', type: 'button', id: 'yt-forget', text: 'Remove key', onclick: function () { yt.stop(); on = false; lsDel(KEY); ctx.rerender(); } })]));
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
    ready: function () { return on; },
    lastError: function () { return note; },
    play: async function (track) {
      var id;
      try { id = await search(track); } catch (e) { note = e.message; return false; }
      if (!id) { note = '"' + track.title + '" was not found on YouTube, so it was skipped.'; return null; }
      return new Promise(function (resolve) {
        var done = false, timer;
        function fin(v) { if (done) return; done = true; clearTimeout(timer); waiter = null; resolve(v); }
        timer = setTimeout(function () { note = 'YouTube did not start the song. Press play on the YouTube player in the corner.'; fin(false); }, 15000);
        waiter = fin; cur = id; note = '';
        try { player.loadVideoById(id); } catch (e) { note = 'The YouTube player is not ready.'; fin(false); }
      });
    },
    pause: function () { try { player.pauseVideo(); } catch (e) { /* ignore */ } },
    resume: function () { try { player.playVideo(); } catch (e) { /* ignore */ } },
    stop: function () { try { if (player) player.stopVideo(); } catch (e) { /* ignore */ } cur = null; if (dock) dock.hidden = true; },
  };
  P.register(yt);
})();
