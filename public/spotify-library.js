// Music source: the host's own Spotify library. Their saved songs become the catalogue, so the room plays
// songs the host actually owns and likes, in any genre. Re-read automatically while the room runs.
// Only titles, artists and genres go to Room Blend. Playing happens through the host's Spotify, in this tab.
(function () {
  'use strict';
  var P = window.Providers, el = P.el, SP = window.Spotify_, GM = window.GenreMap;
  var SCOPES = ['streaming', 'user-read-email', 'user-read-private', 'user-modify-playback-state', 'user-read-playback-state', 'user-library-read'];
  var MAX_SONGS = 3000;
  var S = { phase: 'idle', done: 0, total: 0, error: '', accepted: 0, untagged: 0, synced: 0, syncing: false };
  var playerOn = false, timer = null;

  async function fetchSaved(progress) {
    var songs = [], off = 0;
    for (;;) {
      var r = await SP.api('GET', '/me/tracks?limit=50&offset=' + off);
      if (!r.ok || !r.data) throw new Error(r.status === 401 || r.status === 403 ? 'Spotify did not allow reading your saved songs. Disconnect and connect again.' : 'Spotify did not answer (' + r.status + ').');
      var items = r.data.items || [];
      items.forEach(function (it) {
        var t = it && it.track;
        if (t && t.id && !t.is_local && t.name && t.artists && t.artists[0]) songs.push({ id: t.id, title: t.name, artist: t.artists[0].name, artistId: t.artists[0].id });
      });
      S.total = r.data.total || songs.length; progress(songs.length);
      off += 50;
      if (!items.length || off >= (r.data.total || 0) || songs.length >= MAX_SONGS) break;
    }
    return songs;
  }

  async function genresForArtists(ids) {
    var out = {};
    for (var i = 0; i < ids.length; i += 50) {
      var r = await SP.api('GET', '/artists?ids=' + ids.slice(i, i + 50).join(','));
      if (r.ok && r.data) (r.data.artists || []).forEach(function (a) { if (a) out[a.id] = GM.fromArtists([a.genres || []], 3); });
    }
    return out;
  }

  async function sync(ctx, first) {
    if (S.syncing || (!first && S.phase !== 'ready')) return;
    S.syncing = true; S.error = ''; if (first) S.phase = 'loading'; ctx.rerender();
    try {
      var songs = await fetchSaved(function (n) { S.done = n; });
      var ids = []; songs.forEach(function (s) { if (s.artistId && ids.indexOf(s.artistId) < 0) ids.push(s.artistId); });
      var byArtist = await genresForArtists(ids);
      var tracks = songs.map(function (s) { return { id: s.id, title: s.title, artist: s.artist, genres: byArtist[s.artistId] || [] }; });
      S.untagged = tracks.filter(function (t) { return !t.genres.length; }).length;
      var r = await ctx.uploadLibrary('spotify-lib', 'Spotify library', tracks, !first);
      if (!r.ok) { S.error = songs.length ? 'None of your saved songs had a genre Room Blend recognises.' : 'You have no saved songs yet. Like some songs in Spotify first.'; S.phase = first ? 'idle' : S.phase; }
      else { S.accepted = r.data.accepted; S.synced = Date.now(); S.phase = 'ready'; if (first) ctx.changed(); }
    } catch (e) { S.error = e.message; S.phase = first ? 'idle' : S.phase; }
    S.syncing = false; ctx.rerender();
  }

  async function start(ctx) {
    S.phase = 'loading'; S.error = ''; S.done = 0; ctx.rerender();
    try {
      var ready = new Promise(function (res, rej) { p._onReady = res; setTimeout(function () { rej(new Error('The player did not come online. Is this a Premium account?')); }, 15000); });
      await SP.startPlayer({
        ready: function () { if (p._onReady) p._onReady(); },
        ended: function () { ctx.ended(); },
        error: function (kind, m) { S.error = kind === 'account_error' ? 'Spotify Premium is needed to play here.' : (m || 'Spotify reported a problem.'); ctx.rerender(); },
      });
      await ready; await SP.transfer(); playerOn = true;
      S.syncing = false; await sync(ctx, true);
      if (timer) clearInterval(timer);
      timer = setInterval(function () { sync(ctx, false); }, 30 * 60 * 1000);
    } catch (e) { S.phase = 'idle'; S.error = e.message; ctx.rerender(); }
  }

  var p = {
    id: 'spotify-lib', name: 'Spotify: my songs', blurb: 'Your saved songs, kept in sync.', kind: 'library',
    render: function (ctx) {
      var box = el('div');
      if (!SP.clientId()) {
        box.appendChild(P.state('dot-off', 'Set up Spotify first.', 'Choose the Spotify card and add your free Spotify app (2 minutes). Then come back here.'));
        return box;
      }
      if (!SP.connected() || !SP.hasScopes(SCOPES)) {
        box.appendChild(el('p', { class: 'state', text: 'Connect a Spotify Premium account. Room Blend reads your saved songs and the genres of their artists.' }));
        box.appendChild(el('div', { class: 'row' }, [el('button', { class: 'btn primary', id: 'spl-connect', type: 'button', text: 'Connect Spotify', onclick: function () { SP.login(SCOPES, location.pathname); } })]));
        return box;
      }
      if (S.phase === 'loading') { box.appendChild(el('p', { class: 'state', role: 'status', text: 'Reading your saved songs… ' + S.done + (S.total ? ' of ' + S.total : '') })); return box; }
      if (S.phase === 'ready') {
        box.appendChild(P.state('dot-ok', 'Playing your Spotify library.', S.accepted + ' songs in the room.' + (S.untagged ? ' ' + S.untagged + ' left out because Spotify lists no genre for their artist.' : '')));
        if (S.error) box.appendChild(el('p', { class: 'hint', text: S.error }));
        box.appendChild(el('p', { class: 'hint', id: 'spl-synced', text: 'Synced ' + (S.synced ? new Date(S.synced).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'just now') + '. Songs you save in Spotify appear here automatically every 30 minutes.' }));
        box.appendChild(el('div', { class: 'row' }, [el('button', { class: 'btn small', id: 'spl-sync', type: 'button', text: S.syncing ? 'Syncing…' : 'Sync now', disabled: S.syncing ? 'disabled' : false, onclick: function () { sync(ctx, false); } })]));
        return box;
      }
      box.appendChild(el('p', { class: 'state', text: 'Spotify is connected. Start to play songs you have saved, matched across everyone in the room.' }));
      box.appendChild(el('div', { class: 'row' }, [el('button', { class: 'btn primary', id: 'spl-start', type: 'button', text: 'Start with my songs', onclick: function () { start(ctx); } })]));
      if (S.error) box.appendChild(el('p', { class: 'hint', role: 'status', text: S.error }));
      box.appendChild(el('p', { class: 'hint', text: 'Only song titles, artists and genres are sent to the room. Needs Spotify Premium.' }));
      return box;
    },
    activate: function (ctx) { if (S.phase === 'ready') sync(ctx, false); },
    ready: function () { return playerOn && S.phase === 'ready'; },
    lastError: function () { return S.error || 'A song could not be played, so it was skipped.'; },
    play: async function (track) {
      var ok = await SP.play('spotify:track:' + track.nativeId);
      if (!ok) S.error = 'Could not start playback. Check that Spotify is not playing somewhere else.';
      return ok ? true : null;
    },
    pause: function () { return SP.pause(); }, resume: function () { return SP.resume(); }, stop: function () { return SP.pause(); },
  };
  P.register(p);
})();
