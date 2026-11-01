// Music sources ("providers"). The host's browser talks to their own music service; the Room Blend
// server only ever sees song titles, artists and genres, never credentials, files or audio.
//
// A provider is a plain object:
//   id, name, blurb
//   kind        'manual' | 'curated' (plays songs from the built-in list, found on the service)
//               | 'library' (plays the host's own catalogue, which is sent to the server as metadata)
//   render(ctx) -> DOM node for the setup / status panel
//   ready()     -> true when it can play right now
//   play(track) -> Promise<true | false | null>   (null = this song is not available here)
//   pause(), resume(), stop()
//   optional: canExtras() / extras(genre) -> more songs per genre (curated providers only)
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
  function makeAudio() {
    var a = new Audio(); a.preload = 'auto';
    var api = {
      onended: function () {},
      unlock: function () { try { a.src = SILENCE; var p = a.play(); if (p && p.catch) p.catch(function () {}); } catch (e) { /* ignore */ } },
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
    };
    a.addEventListener('ended', function () { api.onended(); });
    api.el = a;
    return api;
  }

  // ---------- Just show me the songs ----------
  var manual = {
    id: 'manual', name: 'Just show the songs', blurb: 'You play them yourself, from anything.', kind: 'manual',
    render: function () {
      return el('div', null, [state('dot-off', 'Manual mode.', 'Room Blend picks the songs and you play them yourself. Use "Find it" next to each song, or Copy list.')]);
    },
    ready: function () { return false; }, play: function () { return Promise.resolve(false); }, pause: function () {}, resume: function () {}, stop: function () {},
  };

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
        var uri = await SP.resolveUri(track);
        if (!uri) { note = '"' + track.title + '" is not on Spotify here, so it was skipped.'; return null; }
        var ok = await SP.play(uri);
        if (!ok) note = 'Could not start playback. Check that Spotify is not playing somewhere else.';
        return ok;
      },
      pause: function () { return SP.pause(); }, resume: function () { return SP.resume(); }, stop: function () { return SP.pause(); },
      canExtras: function () { return !!(SP.clientId() && SP.connected()); },
      extras: function (genre) { return SP.searchGenre(genre); },
    };
    return p;
  })();

  // ---------- Apple Music (designed for, not built) ----------
  var apple = {
    id: 'apple', name: 'Apple Music', blurb: 'Not available yet.', kind: 'curated', unavailable: true,
    render: function () {
      return el('div', null, [
        state('dot-off', 'Apple Music is not available yet.', 'It needs an Apple Developer account (paid) to issue the keys the web player requires, so it cannot be turned on without cost to whoever runs the service.'),
        el('p', { class: 'hint', text: 'Meanwhile, use Spotify, your own files, or a Navidrome / Subsonic server. See docs/PROVIDERS.md for how Apple Music will plug in.' }),
      ]);
    },
    ready: function () { return false; }, play: function () { return Promise.resolve(false); }, pause: function () {}, resume: function () {}, stop: function () {},
  };

  registry.push(spotify);

  window.Providers = {
    list: registry,
    register: function (p) { registry.push(p); },
    get: function (id) { for (var i = 0; i < registry.length; i++) if (registry[i].id === id) return registry[i]; return manual; },
    el: el, state: state, makeAudio: makeAudio,
    // Called once every provider script has loaded: fixes the order of the last two cards.
    finish: function () { if (registry.indexOf(apple) < 0) registry.push(apple, manual); },
  };
})();
