// Spotify access from the browser: Authorization Code with PKCE (no client secret anywhere),
// plus a small API helper and the web player used by the host.
window.Spotify_ = (function () {
  var C = window.CONFIG;
  var LS = 'rb-sp', PK = 'rb-pkce';

  function rand(n) {
    var a = new Uint8Array(n); crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~'[b % 66]; }).join('');
  }
  function b64url(buf) {
    var s = ''; new Uint8Array(buf).forEach(function (b) { s += String.fromCharCode(b); });
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  // Which Spotify app to use. Hosts may bring their own (stored in this browser only); guests use the service's.
  function ownId() { try { return (localStorage.getItem('rb-own-client') || '').trim(); } catch (e) { return ''; } }
  function onHostPage() { return location.pathname.indexOf('/host/') === 0 || (function () { try { return (JSON.parse(sessionStorage.getItem(PK) || '{}').host === true); } catch (e) { return false; } })(); }
  function clientId() { return (onHostPage() && ownId()) || C.clientId || ''; }
  function setOwnClient(id) {
    id = String(id || '').trim();
    if (id && !/^[a-f0-9]{32}$/i.test(id)) return false;
    try { if (id) localStorage.setItem('rb-own-client', id); else localStorage.removeItem('rb-own-client'); localStorage.removeItem(LS); } catch (e) { /* ignore */ }
    return true;
  }
  function load() { try { return JSON.parse(localStorage.getItem(LS) || 'null'); } catch (e) { return null; } }
  function save(t) { try { localStorage.setItem(LS, JSON.stringify(t)); } catch (e) { /* private mode */ } }

  function hasScopes(needed) {
    var t = load(); if (!t) return false;
    var have = (t.scope || '').split(' ');
    return needed.every(function (s) { return have.indexOf(s) >= 0; });
  }

  async function login(scopes, returnTo) {
    var verifier = rand(96), state = rand(16);
    var digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    var cid = clientId();
    sessionStorage.setItem(PK, JSON.stringify({ verifier: verifier, state: state, returnTo: returnTo, cid: cid, host: onHostPage() }));
    var q = new URLSearchParams({
      client_id: cid, response_type: 'code', redirect_uri: location.origin + '/callback',
      code_challenge_method: 'S256', code_challenge: b64url(digest), state: state, scope: scopes.join(' '),
    });
    location.href = C.accountsBase + '/authorize?' + q.toString();
  }

  async function tokenRequest(params) {
    var r = await fetch(C.accountsBase + '/api/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(Object.assign({ client_id: params.cid || clientId() }, (function () { var q = Object.assign({}, params); delete q.cid; return q; })())).toString(),
    });
    if (!r.ok) throw new Error('token ' + r.status);
    return r.json();
  }

  // On /callback: swap the code for tokens, then go back to where login started.
  async function handleCallback() {
    var p = new URLSearchParams(location.search), saved = {};
    try { saved = JSON.parse(sessionStorage.getItem(PK) || '{}'); } catch (e) { /* none */ }
    sessionStorage.removeItem(PK);
    if (p.get('error')) throw new Error(p.get('error'));
    if (!p.get('code') || !saved.verifier || p.get('state') !== saved.state) throw new Error('Login was interrupted. Try connecting again.');
    var t = await tokenRequest({ grant_type: 'authorization_code', code: p.get('code'), redirect_uri: location.origin + '/callback', code_verifier: saved.verifier, cid: saved.cid });
    save({ cid: saved.cid, access: t.access_token, refresh: t.refresh_token, exp: Date.now() + t.expires_in * 1000, scope: t.scope || '' });
    return saved.returnTo || '/';
  }

  async function token() {
    var t = load(); if (!t) return null;
    if (Date.now() < t.exp - 60000) return t.access;
    if (!t.refresh) { localStorage.removeItem(LS); return null; }
    try {
      var n = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh, cid: t.cid });
      save({ cid: t.cid, access: n.access_token, refresh: n.refresh_token || t.refresh, exp: Date.now() + n.expires_in * 1000, scope: n.scope || t.scope });
      return n.access_token;
    } catch (e) { localStorage.removeItem(LS); return null; }
  }

  // JSON helper with one retry after a rate limit. Resolves {ok, status, data}.
  async function api(method, path, body, retried) {
    var tk = await token();
    if (!tk) return { ok: false, status: 401, data: null };
    var r = await fetch(C.apiBase + path, {
      method: method, headers: Object.assign({ Authorization: 'Bearer ' + tk }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 429 && !retried) {
      var wait = Math.min(10, Number(r.headers.get('Retry-After') || 1));
      await new Promise(function (res) { setTimeout(res, wait * 1000); });
      return api(method, path, body, true);
    }
    var data = null;
    if (r.status !== 204) { try { data = await r.json(); } catch (e) { data = null; } }
    return { ok: r.ok, status: r.status, data: data };
  }

  function logout() { try { localStorage.removeItem(LS); } catch (e) { /* ignore */ } }

  // ---------- host-side helpers ----------
  var norm = function (s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); };

  // Finds a Spotify track for "title by artist". Cached per browser.
  async function resolveUri(track) {
    var ck = 'rb-uri-' + track.id;
    try { var c = localStorage.getItem(ck); if (c) return c; } catch (e) { /* ignore */ }
    var r = await api('GET', '/search?type=track&limit=5&q=' + encodeURIComponent('track:' + track.title + ' artist:' + track.artist));
    var items = r.ok && r.data && r.data.tracks ? r.data.tracks.items || [] : [];
    var want = norm(track.artist);
    var pick = items.find(function (t) { return (t.artists || []).some(function (a) { return norm(a.name) === want; }); }) || items[0];
    if (!pick) return null;
    try { localStorage.setItem(ck, pick.uri); } catch (e) { /* ignore */ }
    return pick.uri;
  }

  // Best-effort genre search. Returns [{title, artist}]. May return nothing if Spotify ignores the filter.
  async function searchGenre(genre) {
    var out = [];
    for (var off = 0; off < 20; off += 10) {
      var r = await api('GET', '/search?type=track&limit=10&offset=' + off + '&q=' + encodeURIComponent('genre:"' + genre + '"'));
      var items = r.ok && r.data && r.data.tracks ? r.data.tracks.items || [] : [];
      items.forEach(function (t) { if (t && t.name && t.artists && t.artists[0]) out.push({ title: t.name, artist: t.artists[0].name }); });
      if (items.length < 10) break;
    }
    return out;
  }

  // Top artists -> Spotify genres per artist (the list response already carries genres).
  async function topArtistGenres() {
    var r = await api('GET', '/me/top/artists?limit=20&time_range=medium_term');
    if (!r.ok || !r.data) return null;
    return (r.data.items || []).map(function (a) { return a.genres || []; });
  }

  // ---------- web player (host) ----------
  var player = null, deviceId = null;
  var handlers = { ended: function () {}, error: function () {}, ready: function () {} };
  var currentUri = null, endedFor = null;

  function loadSdk() {
    return new Promise(function (resolve, reject) {
      if (window.Spotify && window.Spotify.Player) return resolve();
      window.onSpotifyWebPlaybackSDKReady = resolve;
      var s = document.createElement('script'); s.src = C.sdkUrl; s.async = true;
      s.onerror = function () { reject(new Error('Could not load the Spotify player.')); };
      document.head.appendChild(s);
    });
  }

  async function startPlayer(h) {
    Object.assign(handlers, h);
    await loadSdk();
    player = new window.Spotify.Player({ name: 'Room Blend', getOAuthToken: function (cb) { token().then(function (t) { cb(t); }); }, volume: 0.8 });
    player.addListener('ready', function (e) { deviceId = e.device_id; handlers.ready(deviceId); });
    player.addListener('not_ready', function () { deviceId = null; });
    ['initialization_error', 'authentication_error', 'account_error', 'playback_error'].forEach(function (k) {
      player.addListener(k, function (e) { handlers.error(k, e && e.message); });
    });
    player.addListener('player_state_changed', function (st) {
      if (!st || !currentUri) return;
      // A finished track shows up as paused at 0 with the track in "previous".
      var done = st.paused && st.position === 0 && st.track_window && (st.track_window.previous_tracks || []).some(function (t) { return t.uri === currentUri; });
      if (done && endedFor !== currentUri) { endedFor = currentUri; handlers.ended(currentUri); }
    });
    // Must run inside a user gesture on phones and some browsers.
    if (player.activateElement) { try { await player.activateElement(); } catch (e) { /* ignore */ } }
    var ok = await player.connect();
    if (!ok) throw new Error('The Spotify player could not connect.');
  }

  async function transfer() {
    if (!deviceId) return false;
    var r = await api('PUT', '/me/player', { device_ids: [deviceId], play: false });
    return r.ok;
  }

  async function play(uri) {
    if (!deviceId) return false;
    currentUri = uri; endedFor = null;
    var r = await api('PUT', '/me/player/play?device_id=' + encodeURIComponent(deviceId), { uris: [uri] });
    return r.ok;
  }

  return {
    connected: function () { return !!load(); }, clientId: clientId, ownClient: ownId, setOwnClient: setOwnClient, hasScopes: hasScopes, login: login, handleCallback: handleCallback, logout: logout,
    api: api, resolveUri: resolveUri, searchGenre: searchGenre, topArtistGenres: topArtistGenres,
    startPlayer: startPlayer, transfer: transfer, play: play,
    pause: function () { return player && player.pause(); }, resume: function () { return player && player.resume(); },
    ready: function () { return !!deviceId; },
  };
})();
