// Music source: a Subsonic-compatible server. That covers Navidrome (open source, the usual choice),
// Gonic, Airsonic-Advanced, Funkwhale and others. The host's browser talks to the server directly.
(function () {
  'use strict';
  var P = window.Providers, el = P.el, GM = window.GenreMap;
  var audio = null, base = '', user = '', pass = '', tracksById = new Map();
  var S = { synced: 0, syncing: false, phase: 'idle', done: 0, error: '', untagged: 0, accepted: 0, defaultGenre: '', total: 0 };
  var entries = [];

  // ---- MD5 (Subsonic token auth needs it; the browser's crypto has none) ----
  function md5(str) {
    var bytes = new TextEncoder().encode(str), n = bytes.length;
    var words = new Uint32Array((((n + 8) >>> 6) + 1) * 16);
    for (var i = 0; i < n; i++) words[i >> 2] |= bytes[i] << ((i % 4) * 8);
    words[n >> 2] |= 0x80 << ((n % 4) * 8);
    words[words.length - 2] = (n * 8) >>> 0; words[words.length - 1] = Math.floor(n / 0x20000000);
    var K = [], R = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    for (i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
    var a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    for (var off = 0; off < words.length; off += 16) {
      var A = a0, B = b0, C = c0, D = d0, F, g;
      for (i = 0; i < 64; i++) {
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        F = (F + A + K[i] + words[off + g]) >>> 0;
        A = D; D = C; C = B;
        var r = R[(i >> 4) * 4 + (i % 4)];
        B = (B + ((F << r) | (F >>> (32 - r)))) >>> 0;
      }
      a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
    }
    var hex = '';
    [a0, b0, c0, d0].forEach(function (w) { for (var k = 0; k < 4; k++) hex += ('0' + ((w >>> (k * 8)) & 255).toString(16)).slice(-2); });
    return hex;
  }

  function salt() { var a = new Uint8Array(8); crypto.getRandomValues(a); return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  function auth() { var s = salt(); return 'u=' + encodeURIComponent(user) + '&t=' + md5(pass + s) + '&s=' + s + '&v=1.16.1&c=RoomBlend'; }
  function endpoint(name, params) { return base + '/rest/' + name + '.view?' + auth() + '&f=json' + (params ? '&' + params : ''); }
  async function call(name, params) {
    var r;
    try { r = await fetch(endpoint(name, params)); } catch (e) { throw new Error(netMessage()); }
    if (!r.ok) throw new Error('The server answered ' + r.status + '.');
    var j = await r.json(), res = j && j['subsonic-response'];
    if (!res) throw new Error('That does not look like a Subsonic or Navidrome server.');
    if (res.status !== 'ok') throw new Error(res.error && res.error.message ? res.error.message : 'The server refused the request.');
    return res;
  }
  function netMessage() {
    var local = /^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(base);
    if (location.protocol === 'https:' && /^http:/.test(base) && !local) return 'This page is secure (https) but your music server is not, so the browser blocks it. Give the server an https address, or run Room Blend on your own computer.';
    return 'Could not reach the server. Check the address, and that it allows requests from this page (CORS).';
  }
  function genresOf(s) {
    var names = [];
    if (Array.isArray(s.genres)) s.genres.forEach(function (g) { if (g && g.name) names.push(g.name); });
    if (s.genre) names.push(s.genre);
    var out = [];
    names.forEach(function (n) { GM.fromTag(n, 3).forEach(function (g) { if (out.indexOf(g) < 0 && out.length < 3) out.push(g); }); });
    return out;
  }

  async function loadAll(progress) {
    var songs = [], off = 0, step = 500;
    for (;;) { // Navidrome and most servers return every song for an empty search
      var res = await call('search3', 'query=&artistCount=0&albumCount=0&songCount=' + step + '&songOffset=' + off);
      var got = (res.searchResult3 && res.searchResult3.song) || [];
      songs = songs.concat(got); progress(songs.length);
      if (got.length < step || songs.length >= 20000) break;
      off += step;
    }
    if (songs.length) return songs;
    // Fallback: walk the albums.
    var albums = [];
    for (off = 0; ; off += step) {
      var a = await call('getAlbumList2', 'type=alphabeticalByName&size=' + step + '&offset=' + off);
      var list = (a.albumList2 && a.albumList2.album) || [];
      albums = albums.concat(list);
      if (list.length < step || albums.length >= 5000) break;
    }
    var i = 0;
    async function w() { while (i < albums.length && songs.length < 20000) { var al = albums[i++]; try { var r = await call('getAlbum', 'id=' + encodeURIComponent(al.id)); songs = songs.concat((r.album && r.album.song) || []); progress(songs.length); } catch (e) { /* skip */ } } }
    await Promise.all([w(), w(), w(), w(), w(), w()]);
    return songs;
  }

  async function connect(ctx, url, u, pw) {
    base = String(url || '').trim().replace(/\/+$/, '').replace(/\/rest$/, '');
    if (!/^https?:\/\//i.test(base)) base = 'https://' + base;
    user = u; pass = pw;
    S.phase = 'loading'; S.error = ''; S.done = 0; ctx.rerender();
    try {
      await call('ping');
      audio = audio || P.makeAudio(); audio.unlock(); audio.onended = function () { ctx.ended(); };
      var songs = await loadAll(function (n) { S.done = n; });
      entries = songs.map(function (s) { return { id: String(s.id), title: s.title || '', artist: s.artist || '', genres: genresOf(s) }; });
      try { localStorage.setItem('rb-sub', JSON.stringify({ url: base, user: user })); sessionStorage.setItem('rb-sub-pw', pass); } catch (e) { /* ignore */ }
      await publish(ctx);
      autoSync(ctx);
    } catch (e) { S.phase = 'idle'; S.error = e.message; ctx.rerender(); }
  }

  // Re-reads the whole library from the server and sends the new list. The song playing and the queue stay.
  async function sync(ctx) {
    if (S.phase !== 'ready' || S.syncing) return;
    S.syncing = true; ctx.rerender();
    try {
      var songs = await loadAll(function () {});
      entries = songs.map(function (s) { return { id: String(s.id), title: s.title || '', artist: s.artist || '', genres: genresOf(s) }; });
      await publish(ctx, true);
    } catch (e) { S.error = 'Could not sync: ' + e.message; }
    S.syncing = false; ctx.rerender();
  }
  var syncTimer = null;
  function autoSync(ctx) { if (syncTimer) clearInterval(syncTimer); syncTimer = setInterval(function () { sync(ctx); }, 15 * 60 * 1000); }

  async function publish(ctx, refresh) {
    S.untagged = entries.filter(function (e) { return !e.genres.length; }).length;
    var tracks = entries.map(function (e) { return { id: e.id, title: e.title, artist: e.artist, genres: e.genres.length ? e.genres : (S.defaultGenre ? [S.defaultGenre] : []) }; });
    S.phase = 'ready';
    var r = await ctx.uploadLibrary('subsonic', 'Music server', tracks, !!refresh);
    if (!r.ok) { S.accepted = 0; S.error = 'No songs had a genre Room Blend recognises. Pick a genre for them below.'; } else { S.accepted = r.data.accepted; S.error = ''; S.synced = Date.now(); }
    ctx.rerender(); ctx.changed();
  }

  var saved = (function () { try { return JSON.parse(localStorage.getItem('rb-sub') || 'null') || {}; } catch (e) { return {}; } })();
  var form = { url: saved.url || '', user: saved.user || '', pw: (function () { try { return sessionStorage.getItem('rb-sub-pw') || ''; } catch (e) { return ''; } })() };
  var p = {
    id: 'subsonic', name: 'Navidrome / Subsonic', blurb: 'Your own open-source music server.', kind: 'library',
    md5: md5,
    render: function (ctx) {
      var box = el('div');
      if (S.phase === 'loading') {
        box.appendChild(el('p', { class: 'state', role: 'status', text: 'Loading your library… ' + S.done + ' songs so far' }));
        return box;
      }
      if (S.phase === 'ready') {
        box.appendChild(P.state('dot-ok', 'Playing from your music server.', S.accepted + ' songs in the room.' + (S.untagged ? ' ' + S.untagged + (S.defaultGenre ? ' without a genre are counted as ' + S.defaultGenre + '.' : ' have no recognised genre and are left out.') : '')));
        if (S.untagged) {
          var sel = el('select', { id: 'sub-default', 'aria-label': 'Genre for songs without one' }, [el('option', { value: '', text: 'Leave them out' })].concat(ctx.genres.map(function (g) { return el('option', { value: g, text: 'Count them as ' + g, selected: g === S.defaultGenre ? 'selected' : false }); })));
          sel.addEventListener('change', function () { S.defaultGenre = sel.value; publish(ctx); });
          box.appendChild(el('div', { class: 'row' }, [sel]));
        }
        if (S.error) box.appendChild(el('p', { class: 'hint', text: S.error }));
        box.appendChild(el('p', { class: 'hint', id: 'sub-synced', text: 'Synced ' + (S.synced ? new Date(S.synced).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'just now') + '. New songs on your server are picked up automatically every 15 minutes.' }));
        box.appendChild(el('div', { class: 'row' }, [el('button', { class: 'btn small', type: 'button', id: 'sub-sync', text: S.syncing ? 'Syncing…' : 'Sync now', disabled: S.syncing ? 'disabled' : false, onclick: function () { sync(ctx); } }), el('button', { class: 'btn small', type: 'button', text: 'Disconnect', onclick: function () { S.phase = 'idle'; entries = []; pass = ''; if (syncTimer) clearInterval(syncTimer); try { sessionStorage.removeItem('rb-sub-pw'); } catch (e) { /* ignore */ } ctx.clearLibrary(); ctx.rerender(); } })]));
        return box;
      }
      var st = ctx.st();
      var u = el('input', { type: 'text', id: 'sub-url', placeholder: 'https://music.example.com', value: form.url, autocomplete: 'off', 'aria-label': 'Server address' });
      var n = el('input', { type: 'text', id: 'sub-user', placeholder: 'Username', value: form.user, autocomplete: 'username', 'aria-label': 'Username' });
      var w = el('input', { type: 'password', id: 'sub-pass', placeholder: 'Password', value: form.pw, autocomplete: 'current-password', 'aria-label': 'Password' });
      u.addEventListener('input', function () { form.url = u.value; }); n.addEventListener('input', function () { form.user = n.value; }); w.addEventListener('input', function () { form.pw = w.value; });
      var go = function () { if (!u.value || !n.value) { S.error = 'Enter the server address and username.'; ctx.rerender(); return; } connect(ctx, u.value, n.value, w.value); };
      box.appendChild(el('p', { class: 'state', text: st && st.source && st.source.provider === 'subsonic' ? 'Your library is still in the room. Sign in again to play it.' : 'Connect a Navidrome, Gonic or other Subsonic server. Your password stays in this browser tab.' }));
      box.appendChild(el('div', { class: 'stack' }, [u, n, w]));
      box.appendChild(el('div', { class: 'row' }, [el('button', { class: 'btn primary', id: 'sub-go', type: 'button', text: 'Connect and load library', onclick: go })]));
      if (S.error) box.appendChild(el('p', { class: 'hint', role: 'status', text: S.error }));
      box.appendChild(el('p', { class: 'hint', text: 'Only song titles, artists and genres are sent to the room. Songs play straight from your server to this tab.' }));
      return box;
    },
    activate: function (ctx) { if (S.phase === 'ready') publish(ctx); },
    ready: function () { return S.phase === 'ready' && !!audio; },
    play: async function (track) {
      var id = track.nativeId;
      if (track.request) {
        try {
          var found = await call('search3', 'query=' + encodeURIComponent(track.title + ' ' + track.artist) + '&artistCount=0&albumCount=0&songCount=10');
          var candidates = (found.searchResult3 && found.searchResult3.song) || [];
          var ranked = window.Match.rank(track, candidates, function (song) { return { title: song.title, channel: song.artist }; }, window.Match.scoreVideo)
            .filter(function (x) { return window.Match.acceptable(x.s); });
          id = ranked.length ? String(ranked[0].item.id) : '';
        } catch (e) { S.error = e.message; return null; }
        if (!id) return null;
      }
      var ok = await audio.play(base + '/rest/stream.view?' + auth() + '&id=' + encodeURIComponent(id));
      return ok ? true : null;
    },
    lastError: function () { return 'A song could not be played from your server, so it was skipped.'; },
    pause: function () { audio && audio.pause(); }, resume: function () { audio && audio.resume(); }, stop: function () { audio && audio.stop(); },
    canSeek: function () { return !!audio; }, progress: function () { return audio ? audio.progress() : null; }, seek: function (seconds) { return audio && audio.seek(seconds); },
  };
  P.register(p);
})();
