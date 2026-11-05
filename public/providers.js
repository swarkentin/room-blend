// Music sources ("providers"). The host's browser talks to their own music service; the Room Blend
// server only ever sees song titles, artists and genres, never credentials, files or audio.
//
// A provider is a plain object:
//   id, name, blurb
//   kind        'curated' (songs come from the service, by genre; the built-in list is the fallback)
//               | 'library' (plays the host's own catalogue, which is sent to the server as metadata)
//   render(ctx) -> DOM node for the setup / status panel
//   ready()     -> true when it can play right now
//   play(track) -> Promise<true | false | null>   (null = this song is not available here)
//   pause(), resume(), stop()
//   optional: canExtras() / extras(genre) -> more songs per genre (curated providers only)
//   optional: artistTracks(name, genre) -> songs by an artist a guest named (the room only keeps that artist's songs)
//
// ctx (supplied by app.js): code, genres, st() latest server state, rerender(), status(text), ended(),
//   uploadLibrary(provider, label, tracks), clearLibrary()
(function () {
  'use strict';
  var C = window.CONFIG || {}, SP = window.Spotify_;
  var registry = [];

  function el(tag, props, kids) {
    var e = document.createElement(tag), k;
    if (props) for (k in props) {
      if (k === 'class') e.className = props[k];
      else if (k === 'text') e.textContent = props[k];
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), props[k]);
      else if (props[k] !== false && props[k] != null) e.setAttribute(k, props[k]);
    }
    (kids || []).forEach(function (c) { if (c != null) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function state(dot, strong, text) { return el('p', { class: 'state' }, [el('span', { class: dot }), el('strong', { text: strong + ' ' }), document.createTextNode(text || '')]); }

  // One <audio> element shared by the library providers.
  var SILENCE = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
  function makeAudio(analyze) {
    var a = new Audio(); a.preload = 'auto';
    var audioContext = null, analyser = null, source = null, frequencyData = null;
    function setupAnalyser() {
      if (!analyze || analyser) return;
      var Context = window.AudioContext || window.webkitAudioContext;
      if (!Context) return;
      try {
        audioContext = new Context();
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 256; analyser.smoothingTimeConstant = 0.72;
        source = audioContext.createMediaElementSource(a);
        source.connect(analyser); analyser.connect(audioContext.destination);
        frequencyData = new Uint8Array(analyser.frequencyBinCount);
      } catch (e) {
        analyser = null;
      }
    }
    var api = {
      onended: function () {},
      unlock: function () {
        setupAnalyser();
        if (audioContext && audioContext.state === 'suspended') audioContext.resume();
        try { a.src = SILENCE; var p = a.play(); if (p && p.catch) p.catch(function () {}); } catch (e) { /* ignore */ }
      },
      play: function (url) {
        return new Promise(function (resolve) {
          var done = false, t;
          function fin(v) { if (done) return; done = true; clearTimeout(t); a.removeEventListener('playing', ok); a.removeEventListener('error', bad); resolve(v); }
          function ok() { fin(true); } function bad() { fin(false); }
          a.addEventListener('playing', ok); a.addEventListener('error', bad);
          t = setTimeout(function () { fin(false); }, 12000);
          a.src = url; var p = a.play(); if (p && p.catch) p.catch(function () { fin(false); });
        });
      },
      pause: function () { a.pause(); }, resume: function () { var p = a.play(); if (p && p.catch) p.catch(function () {}); }, stop: function () { a.pause(); a.removeAttribute('src'); a.load(); },
      progress: function () { return { currentTime: a.currentTime, duration: a.duration, paused: a.paused }; },
      seek: function (seconds) {
        if (!Number.isFinite(seconds) || !Number.isFinite(a.duration)) return false;
        a.currentTime = Math.max(0, Math.min(a.duration, seconds)); return true;
      },
      levels: function (count) {
        if (!analyser || !frequencyData || a.paused) return null;
        analyser.getByteFrequencyData(frequencyData);
        var out = [], bins = frequencyData.length;
        for (var i = 0; i < count; i++) {
          var start = Math.floor(Math.pow(i / count, 2) * bins);
          var end = Math.max(start + 1, Math.floor(Math.pow((i + 1) / count, 2) * bins));
          var peak = 0;
          for (var bin = start; bin < Math.min(end, bins); bin++) peak = Math.max(peak, frequencyData[bin]);
          out.push(peak / 255);
        }
        return out;
      },
    };
    a.addEventListener('ended', function () { api.onended(); });
    api.el = a;
    return api;
  }

  // ---------- Spotify ----------
  var HOST_SCOPES = ['streaming', 'user-read-email', 'user-read-private', 'user-modify-playback-state', 'user-read-playback-state'];
  var spotify = (function () {
    var on = false, busy = false, note = '';
    function ownAppBox(open) {
      var redirect = location.origin + '/callback', own = SP.ownClient();
      var input = el('input', { type: 'text', id: 'own-id', placeholder: 'Client ID (32 characters)', value: own, autocomplete: 'off', spellcheck: 'false' });
      var msg = el('p', { class: 'hint', role: 'status' });
      return el('details', { class: 'own', open: open ? 'open' : false }, [
        el('summary', { text: own ? 'Using your own Spotify app' : 'Play through Spotify with your own free app (2 minutes)' }),
        el('ol', { class: 'steps' }, [
          el('li', null, [document.createTextNode('Go to '), el('a', { href: 'https://developer.spotify.com/dashboard', target: '_blank', rel: 'noopener', text: 'developer.spotify.com/dashboard' }), document.createTextNode(' and choose Create app. Pick the Web API and Web Playback SDK.')]),
          el('li', null, [document.createTextNode('Set the redirect URI to exactly: '), el('code', { text: redirect })]),
          el('li', { text: 'Copy the Client ID from the app settings and paste it here. There is no secret to share.' }),
        ]),
        el('div', { class: 'row' }, [input, el('button', { class: 'btn primary', type: 'button', id: 'own-save', text: 'Save and connect', onclick: function () {
          if (!SP.setOwnClient(input.value)) { msg.textContent = 'That does not look like a Client ID. It is 32 letters and numbers.'; return; }
          location.reload();
        } }), own ? el('button', { class: 'btn small', type: 'button', text: 'Stop using it', onclick: function () { SP.setOwnClient(''); location.reload(); } }) : null]),
        el('p', { class: 'hint', text: 'Needs Spotify Premium. The Client ID stays in this browser. Because it is your own app, friends do not need to be added to anything.' }),
        msg,
      ]);
    }
    var p = {
      id: 'spotify', name: 'Spotify', blurb: 'Plays through your Premium account.', kind: 'curated',
      render: function (ctx) {
        var box = el('div'), connected = SP && SP.clientId() && SP.connected() && SP.hasScopes(HOST_SCOPES);
        if (!SP.clientId()) {
          box.appendChild(state('dot-off', 'Not connected.', 'Songs are picked from a built-in list and found on Spotify.'));
          box.appendChild(ownAppBox(true));
        } else if (!connected) {
          box.appendChild(el('p', { class: 'state', text: 'Connect a Spotify Premium account to play through this browser.' }));
          box.appendChild(el('div', { class: 'row' }, [el('button', { class: 'btn primary', id: 'sp-connect', type: 'button', text: 'Connect Spotify', onclick: function () { SP.login(HOST_SCOPES, location.pathname); } })]));
          box.appendChild(ownAppBox(false));
        } else if (!on) {
          box.appendChild(state('dot-ok', 'Spotify connected.', note || 'Start the music to play through this browser.'));
          box.appendChild(el('div', { class: 'row' }, [el('button', { class: 'btn primary', id: 'sp-start', type: 'button', text: busy ? 'Starting…' : 'Start the music', disabled: busy ? 'disabled' : false, onclick: function () { p.start(ctx); } }),
            el('button', { class: 'btn small', type: 'button', text: 'Disconnect', onclick: function () { SP.logout(); location.reload(); } })]));
        } else {
          box.appendChild(state('dot-ok', 'Playing through this browser.', note || 'Keep this tab open.'));
        }
        return box;
      },
      start: async function (ctx) {
        busy = true; note = ''; ctx.rerender();
        try {
          var ready = new Promise(function (res, rej) { p._onReady = res; setTimeout(function () { rej(new Error('The player did not come online. Is this a Premium account?')); }, 15000); });
          await SP.startPlayer({
            ready: function () { if (p._onReady) p._onReady(); },
            ended: function () { ctx.ended(); },
            error: function (kind, m) { note = kind === 'account_error' ? 'Spotify Premium is needed to play here.' : (m || 'Spotify reported a problem.'); ctx.rerender(); },
          });
          await ready; await SP.transfer();
          on = true; busy = false; note = ''; ctx.rerender(); ctx.changed();
        } catch (e) { busy = false; note = e.message; ctx.rerender(); }
      },
      ready: function () { return on; },
      lastError: function () { return note; },
      play: async function (track) {
        var uri = track.nid || await SP.resolveUri(track);
        if (!uri) { note = '"' + track.title + '" is not on Spotify here, so it was skipped.'; return null; }
        var ok = await SP.play(uri);
        if (!ok) note = 'Could not start playback. Check that Spotify is not playing somewhere else.';
        return ok;
      },
      pause: function () { return SP.pause(); }, resume: function () { return SP.resume(); }, stop: function () { return SP.pause(); },
      canSeek: function () { return on; }, progress: function () { return SP.progress(); }, seek: function (seconds) { return SP.seek(seconds); },
      canExtras: function () { return !!(SP.clientId() && SP.connected()); },
      pool: true, // the room's songs come from Spotify's own genre search; the built-in list is only a fallback
      extras: function (genre, partners) { return SP.searchGenre(genre, partners); },
      artistTracks: function (name, genre) { return SP.searchArtist(name, genre); },
    };
    return p;
  })();

  registry.push(spotify);

  window.Providers = {
    list: registry,
    register: function (p) { registry.push(p); },
    // An unknown id (for example a source this browser remembered that no longer exists) falls back to Spotify, the first source.
    get: function (id) { for (var i = 0; i < registry.length; i++) if (registry[i].id === id) return registry[i]; return registry[0]; },
    el: el, state: state, makeAudio: makeAudio,
  };
})();
