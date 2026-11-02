(function () {
  'use strict';
  var C = window.CONFIG, SP = window.Spotify_;
  var app = document.getElementById('app');
  var COLORS = ['var(--g1)', 'var(--g2)', 'var(--g3)', 'var(--g4)', 'var(--g5)', 'var(--g6)'];

  // ---------- helpers ----------
  function h(tag, props, kids) {
    var e = document.createElement(tag), k;
    if (props) for (k in props) {
      if (k === 'class') e.className = props[k];
      else if (k === 'text') e.textContent = props[k];
      else if (k === 'style') e.style.cssText = props[k];
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), props[k]);
      else if (props[k] !== false && props[k] != null) e.setAttribute(k, props[k]);
    }
    (kids || []).forEach(function (c) { if (c != null) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function $(id) { return document.getElementById(id); }
  function pct(v) { return Math.round(v * 100); }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  async function http(method, url, body, headers, keepalive) {
    var r = await fetch(url, { keepalive: !!keepalive, method: method, headers: Object.assign(body ? { 'Content-Type': 'application/json' } : {}, headers || {}), body: body ? JSON.stringify(body) : undefined });
    var data = null; try { data = await r.json(); } catch (e) { /* none */ }
    return { ok: r.ok, status: r.status, data: data };
  }
  function copy(text, el) {
    function fb() { el.textContent = 'Select and copy it'; }
    try { navigator.clipboard.writeText(text).then(function () { el.textContent = 'Copied'; setTimeout(function () { el.textContent = 'Copy'; }, 1500); }, fb); } catch (e) { fb(); }
  }
  function gl(g) { return /^any:/.test(g) ? 'all ' + g.slice(4).replace(/-/g, ' ') : g; }
  // What a guest named, as counts only. The host never sees the names themselves.
  function namedLine(g) {
    var a = g.artistCount || 0, n = g.songCount || 0;
    if (!a && !n) return null;
    var parts = []; if (a) parts.push(a + (a === 1 ? ' artist' : ' artists')); if (n) parts.push(n + (n === 1 ? ' song' : ' songs'));
    return h('div', { class: 'hint gnamed', text: 'Named ' + parts.join(' and ') + (g.genres.length ? '' : '. Genres guessed from these.') });
  }
  function tagList(genres) { return genres.map(function (g) { return h('span', { class: 'tag', text: gl(g) }); }); }
  function chipPicker(container, picked, onChange) {
    var groups = (C.genreGroups || [['Genres', C.genres]]).slice();
    (C.genreAliasGroups || []).forEach(function (grp) { groups.push(grp); });
    var aliasNames = C.genreAliases || {};
    var search = h('input', { type: 'search', class: 'genre-search', placeholder: 'Search genres, eras, or styles', 'aria-label': 'Search genres, eras, or styles' });
    var status = h('p', { class: 'hint genre-search-status', role: 'status', 'aria-live': 'polite' });
    container.appendChild(h('div', { class: 'genre-search-box' }, [search, status]));
    function sync() {
      Array.prototype.forEach.call(container.querySelectorAll('button'), function (c) {
        var g = c.getAttribute('data-g'), on = picked.indexOf(g) >= 0;
        c.setAttribute('aria-pressed', on ? 'true' : 'false'); c.disabled = !on && picked.length >= 4;
      });
      if (onChange) onChange();
    }
    function chip(g, label) {
      return h('button', { class: 'chip', type: 'button', 'data-g': g, 'aria-pressed': 'false', text: label || g, onclick: function () {
        var i = picked.indexOf(g); if (i >= 0) picked.splice(i, 1); else if (picked.length < 4) picked.push(g); sync();
      } });
    }
    groups.forEach(function (grp) {
      var isAliasGroup = grp === (C.genreAliasGroups || []).filter(function (x) { return x[0] === grp[0]; })[0];
      var all = !isAliasGroup && grp[1].length > 1 && grp[0] !== 'Holiday' ? chip('any:' + grp[0].toLowerCase().replace(/\s+/g, '-'), 'All ' + grp[0].toLowerCase()) : null;
      if (all) all.classList.add('chip-all');
      var buttons = (all ? [all] : []).concat(grp[1].map(function (g) { return chip(g); }));
      container.appendChild(h('div', { class: 'chipgroup', 'data-genre-group': grp[0] }, [h('div', { class: 'chipgroup-name', text: grp[0] }), h('div', { class: 'chips' }, buttons), grp[0] === 'Holiday' ? h('div', { class: 'hint', text: 'Holiday songs play only while someone in the room has picked that holiday.' }) : null].filter(Boolean)));
    });
    function filter() {
      var q = search.value.trim().toLowerCase(), shown = 0;
      Array.prototype.forEach.call(container.querySelectorAll('.chipgroup'), function (group) {
        var matches = 0;
        Array.prototype.forEach.call(group.querySelectorAll('button'), function (button) {
          var g = button.getAttribute('data-g'), text = (button.textContent + ' ' + (aliasNames[g] || []).join(' ')).toLowerCase();
          var visible = !q || text.indexOf(q) >= 0;
          button.hidden = !visible; if (visible) matches++;
        });
        group.hidden = !!q && !matches; if (matches) shown += matches;
      });
      status.textContent = q ? (shown ? shown + ' matching genres' : 'No matching genres') : '';
    }
    search.addEventListener('input', filter);
    sync();
    return sync;
  }
  function fitMeters(fits, people) {
    var box = h('div', { class: 'fits' });
    fits.forEach(function (f) {
      var p = people[f.id]; if (!p) return;
      var c = COLORS[p.color % COLORS.length];
      box.appendChild(h('span', { class: 'fit', title: p.name + ': ' + pct(f.fit) + '% fit' }, [
        h('span', { class: 'dot', style: 'background:' + c }),
        h('span', { class: 'meter' }, [h('span', { style: 'width:' + pct(f.fit) + '%;background:' + c })]),
        h('span', { class: 'pct', text: String(pct(f.fit)) }),
      ]));
    });
    return box;
  }
  function spotifySearchUrl(t) { return 'https://open.spotify.com/search/' + encodeURIComponent(t.title + ' ' + t.artist); }
  function setBodyClass() { document.body.style.padding = ''; }

  // ---------- landing ----------
  function codeFrom(text) {
    var t = String(text || '').trim();
    var m = /(?:\/(?:r|host|screen)\/)?\b([A-Za-z0-9]{5})\/?(?:[?#].*)?$/.exec(t);
    return m ? m[1].toUpperCase() : '';
  }
  function landing() {
    var hostRooms = [], guestRooms = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k.indexOf('rb-host-') === 0) hostRooms.push(k.slice(8));
        else if (k.indexOf('rb-guest-') === 0) guestRooms.push(k.slice(9));
      }
    } catch (e) { /* ignore */ }
    var codeIn = h('input', { class: 'code-input', id: 'join-code', maxlength: '60', placeholder: 'CODE', 'aria-label': 'Room code or link', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', inputmode: 'text' });
    var msg = h('p', { class: 'hint', role: 'status' });
    var nearby = h('div', { class: 'card', id: 'nearby', hidden: 'hidden' });
    var mine = h('div', { class: 'card', id: 'mine', hidden: 'hidden' });
    app.replaceChildren(h('div', { class: 'wrap' }, [h('div', { class: 'hero' }, [
      h('h1', { text: 'Music that fits the whole room.' }),
      h('p', { class: 'lead', text: 'Everyone picks the genres they like. Room Blend finds the songs in the overlap, and takes turns when there is none. No accounts for guests.' }),
      nearby, mine,
      h('form', { class: 'card', id: 'join-form' }, [
        h('h2', { text: 'Join a room' }),
        h('p', { class: 'hint', text: 'Type the 5-letter code, or paste the link. Or just scan the QR code on the host\'s screen.' }),
        codeIn,
        h('div', { class: 'row' }, [h('button', { class: 'btn', type: 'submit', text: 'Join' })]),
        msg,
      ]),
      h('div', { class: 'card' }, [
        h('h2', { text: 'Run the music' }),
        h('p', { class: 'hint', text: 'Play from Spotify, your own files, or a music server. Friends join with a QR code on their phones.' }),
        h('div', { class: 'row' }, [h('button', { class: 'btn primary', id: 'start-room', type: 'button', text: 'Start a room', onclick: async function () {
          var r = await http('POST', '/api/rooms');
          if (!r.ok) { msg.textContent = (r.data && r.data.error) || 'Could not start a room. Try again in a moment.'; return; }
          lsSet('rb-host-' + r.data.code, r.data.hostKey); location.href = '/host/' + r.data.code;
        } })]),
      ]),
    ])]));

    async function go(code) {
      if (!code) return;
      var r = await http('GET', '/api/rooms/' + code);
      if (!r.ok) { msg.textContent = 'No room with code ' + code + '. Check the letters and try again.'; return; }
      location.href = '/r/' + code;
    }
    $('join-form').addEventListener('submit', function (e) { e.preventDefault(); go(codeFrom(codeIn.value)); });
    codeIn.addEventListener('input', function () {
      var c = codeFrom(codeIn.value);
      if (/^[A-Za-z0-9]{5}$/.test(codeIn.value.trim()) || (codeIn.value.length > 8 && c)) go(c); // joins as soon as the code is complete
    });

    // Rooms on the same Wi-Fi, started by someone who is here now.
    http('GET', '/api/nearby').then(function (r) {
      var rooms = r.ok && r.data ? r.data.rooms : [];
      if (!rooms.length) return;
      nearby.hidden = false;
      nearby.replaceChildren.apply(nearby, [h('h2', { text: 'Playing near you' }), h('p', { class: 'hint', text: 'Rooms on this Wi-Fi. Tap one to join.' })].concat(rooms.map(function (x) {
        return h('a', { class: 'roomlink', href: '/r/' + x.code }, [
          h('span', { class: 'rl-name', text: x.name || 'Room ' + x.code }),
          h('span', { class: 'rl-meta', text: x.people + (x.people === 1 ? ' person' : ' people') + ' · ' + x.code }),
          h('span', { class: 'btn small primary', text: 'Join' }),
        ]);
      })));
    });

    // Rooms this browser already belongs to or runs.
    var codes = hostRooms.map(function (c) { return { c: c, host: true }; }).concat(guestRooms.map(function (c) { return { c: c, host: false }; }));
    Promise.all(codes.map(function (x) { return http('GET', '/api/rooms/' + x.c).then(function (r) { return r.ok ? Object.assign({ name: r.data.name }, x) : null; }); })).then(function (list) {
      list = list.filter(Boolean);
      codes.forEach(function (x) { /* tidy up rooms that no longer exist */ });
      if (!list.length) return;
      mine.hidden = false;
      mine.replaceChildren.apply(mine, [h('h2', { text: 'Your rooms' })].concat(list.map(function (x) {
        return h('a', { class: 'roomlink', href: (x.host ? '/host/' : '/r/') + x.c }, [
          h('span', { class: 'rl-name', text: x.name || 'Room ' + x.c }),
          h('span', { class: 'rl-meta', text: (x.host ? 'You are the host' : 'You are a guest') + ' · ' + x.c }),
          h('span', { class: 'btn small', text: x.host ? 'Open' : 'Rejoin' }),
        ]);
      })));
    });
  }

  // ---------- host ----------
  function hostView(code) {
    var key = lsGet('rb-host-' + code);
    if (!key) {
      app.replaceChildren(h('div', { class: 'wrap' }, [h('div', { class: 'hero' }, [
        h('h1', { text: 'This browser did not start room ' + code }),
        h('p', { class: 'lead', text: 'Only the browser that started a room can run it. Open the room on that device, or start a new one.' }),
        h('div', { class: 'row' }, [h('a', { class: 'btn primary', href: '/', text: 'Start a new room' })]),
      ])]));
      return;
    }
    var H = { 'x-host-key': key };
    var post = function (p, body) { return http('POST', '/api/rooms/' + code + '/host/' + p, body || {}, H); };
    var joinUrl = (C.publicUrl || location.origin) + '/' + code;
    var S = { st: null, prov: null, reup: 0, srcSig: '', playing: null, status: '', busy: false, extrasBusy: false, tried: {}, paused: false };
    var addPicked = [];

    app.replaceChildren(h('div', { class: 'wrap' }, []));
    var wrap = app.firstChild;
    wrap.innerHTML =
      '<header class="roomhead">' +
        '<div class="rh-left"><small>Room code</small><div class="roomcode" id="rc"></div>' +
          '<input type="text" id="room-name" class="roomname" maxlength="30" placeholder="Name your room (optional)" aria-label="Room name" autocomplete="off">' +
          '<label class="disc"><input type="checkbox" id="disc"> Show to people on this Wi-Fi so they can tap to join</label></div>' +
        '<div class="joinbox"><div id="qr" role="img" aria-label="QR code to join this room"></div><div><small>Friends scan, or open</small><div class="link" id="jl"></div>' +
        '<div class="row" style="margin-top:8px"><button class="btn small" id="jc" type="button">Copy</button><button class="btn small" id="js" type="button" hidden>Share</button>' +
        '<a class="btn small" id="jtv" target="_blank" rel="noopener" title="Open a separate join-code display without music playback">QR screen</a>' +
        '<button class="btn small" id="tv-mode" type="button" aria-pressed="false">TV / cast view</button></div></div></div>' +
      '</header>' +
      '<div id="sp" class="sp"></div>' +
      '<main class="grid">' +
        '<section class="stage" aria-label="Now playing">' +
          '<div class="now" id="now"><div class="now-head"><span class="label">Now playing</span><span id="mode-badge" class="badge"><i></i><span id="mode-text">Waiting for guests</span></span></div>' +
          '<h2 class="now-title" id="now-title">Nothing yet</h2><p class="now-artist" id="now-artist">Waiting for the first guest.</p>' +
          '<div class="tags" id="now-genres"></div><p class="why" id="now-why"></p><div class="fits" id="now-fits"></div><p class="why" id="now-votes" style="margin:10px 0 0"></p>' +
          '<div class="controls" style="margin-top:16px"><button class="btn primary" type="button" id="btn-next">Next song</button>' +
          '<button class="btn" type="button" id="btn-pause" hidden>Pause</button></div></div>' +
          '<div class="panel" style="margin-top:28px"><div class="sec-h"><h2>Up next</h2><span class="meta"><span id="q-meta"></span> <button class="btn small" type="button" id="copy-queue">Copy list</button></span></div>' +
          '<p class="overlap" id="overlap"></p><ol class="queue" id="queue"></ol></div>' +
        '</section>' +
        '<section class="room" aria-label="In the room"><div class="sec-h"><h2>In the room</h2><span class="meta" id="room-count"></span></div>' +
          '<ul class="guests" id="guests"></ul>' +
          '<form class="add" id="add-form" autocomplete="off"><h3>Add someone by hand</h3><div><label for="g-name">Name</label><input type="text" id="g-name" maxlength="20" placeholder="Guest name"></div>' +
          '<fieldset><legend>Favourite genres, up to 4</legend><div class="chips" id="picker"></div></fieldset>' +
          '<div class="row"><button class="btn primary" type="submit">Add to the room</button></div><p class="hint" id="add-hint"></p></form>' +
        '</section>' +
        '<aside class="side" aria-label="Tuning and results">' +
          '<div class="panel"><div class="sec-h"><h2>Tuning</h2></div>' +
          '<div class="slider"><label for="s-lambda"><span>Protect the least-happy guest</span><output id="o-lambda"></output></label><input type="range" id="s-lambda" min="0" max="100" step="5"><p class="hint">0% chases the room average. 100% only counts whoever likes the song least.</p></div>' +
          '<div class="slider"><label for="s-tau"><span>Blend only above overlap</span><output id="o-tau"></output></label><input type="range" id="s-tau" min="0.2" max="0.9" step="0.05"><p class="hint">Below this, songs rotate between guests instead.</p></div>' +
          '<div class="slider"><label for="s-settle"><span>New guest counts after</span><output id="o-settle"></output></label><input type="range" id="s-settle" min="0" max="30" step="1"><p class="hint">Stops a passer-by from reshuffling the room.</p></div><div class="slider"><label for="s-doze"><span>Keep a guest counted after their phone locks</span><output id="o-doze"></output></label><input type="range" id="s-doze" min="5" max="120" step="5"><p class="hint">A locked phone cannot say it is still here, so it is trusted for this long, then they are dropped until they open the page again.</p></div></div>' +
          '<div class="panel"><div class="sec-h"><h2>Fairness so far</h2><span class="meta" id="f-meta"></span></div><div id="fairness"></div></div>' +
          '<div class="panel"><div class="sec-h"><h2>Room log</h2></div><ol class="log" id="log"></ol></div>' +
          '<div class="panel"><div class="sec-h"><h2>Session notes</h2></div><p class="hint">Copy the notes to share what worked.</p>' +
          '<div class="row" style="margin-top:10px"><button class="btn" type="button" id="copy-notes">Copy session notes</button><span class="hint" id="copy-state" role="status"></span></div>' +
          '<textarea class="notes" id="notes" readonly hidden aria-label="Session notes"></textarea></div>' +
        '</aside>' +
      '</main>';

    var tvCastView = h('div', { class: 'tv-cast', id: 'tv-cast-view', hidden: 'hidden' }, [
      h('div', { class: 'tv-cast-join' }, [
        h('div', { id: 'tv-cast-qr', role: 'img', 'aria-label': 'QR code to join this room' }),
        h('p', { class: 'tv-cast-label', text: 'Scan to join' }),
        h('p', { class: 'tv-cast-code', id: 'tv-cast-code', text: code }),
      ]),
      h('div', { class: 'tv-cast-main' }, [
        h('p', { class: 'tv-cast-label', id: 'tv-cast-room', text: 'Now playing' }),
        h('h1', { id: 'tv-cast-title', text: 'Waiting for the first guest' }),
        h('p', { class: 'tv-cast-artist', id: 'tv-cast-artist' }),
        h('p', { class: 'tv-cast-meta', id: 'tv-cast-meta' }),
        h('div', { class: 'tags', id: 'tv-cast-genres' }),
        h('div', { class: 'tv-cast-next-wrap' }, [h('h2', { text: 'Coming up' }), h('ol', { id: 'tv-cast-next', class: 'tv-cast-next' })]),
      ]),
      h('button', { class: 'btn tv-cast-exit', id: 'tv-cast-exit', type: 'button', text: 'Exit TV view' }),
    ]);
    wrap.appendChild(tvCastView);

    var base = C.publicUrl || location.origin;
    $('rc').textContent = code; $('jl').textContent = joinUrl.replace(/^https?:\/\//, '');
    $('jc').addEventListener('click', function () { copy(joinUrl, $('jc')); });
    $('jtv').setAttribute('href', '/screen/' + code);
    try { $('tv-cast-qr').innerHTML = window.QR.svg(joinUrl, { ecc: 'M', label: 'QR code to join room ' + code }); } catch (e) { $('tv-cast-qr').hidden = true; }
    function setTvMode(on) {
      document.body.classList.toggle('tv-cast-mode', on);
      tvCastView.hidden = !on;
      $('tv-mode').setAttribute('aria-pressed', on ? 'true' : 'false');
      $('tv-mode').textContent = on ? 'Exit TV view' : 'TV / cast view';
    }
    $('tv-mode').addEventListener('click', function () { setTvMode(!document.body.classList.contains('tv-cast-mode')); });
    $('tv-cast-exit').addEventListener('click', function () { setTvMode(false); });
    if (navigator.share) {
      $('js').hidden = false;
      $('js').addEventListener('click', function () { navigator.share({ title: ($('room-name').value || 'Room ' + code) + ' on Room Blend', text: 'Join the music. Pick your genres and it fits everyone.', url: joinUrl }).catch(function () { /* dismissed */ }); });
    }
    try { $('qr').innerHTML = window.QR.svg(joinUrl, { ecc: 'M', label: 'QR code to join room ' + code }); } catch (e) { $('qr').hidden = true; }
    var nameTimer = null;
    $('room-name').addEventListener('input', function () { clearTimeout(nameTimer); nameTimer = setTimeout(function () { post('room', { name: $('room-name').value }); }, 400); });
    $('disc').addEventListener('change', function () { post('room', { discoverable: $('disc').checked }); });

    chipPicker($('picker'), addPicked);
    $('add-form').addEventListener('submit', async function (e) {
      e.preventDefault();
      if (!addPicked.length) { $('add-hint').textContent = 'Pick at least one genre first.'; return; }
      var r = await post('guests', { name: $('g-name').value, genres: addPicked.slice() });
      if (!r.ok) { $('add-hint').textContent = 'Could not add them.'; return; }
      addPicked.length = 0; $('g-name').value = ''; $('add-hint').textContent = '';
      Array.prototype.forEach.call($('picker').querySelectorAll('button'), function (c) { c.setAttribute('aria-pressed', 'false'); c.disabled = false; });
    });
    $('btn-next').addEventListener('click', function () { post('advance'); });
    $('btn-pause').addEventListener('click', function () {
      if (S.paused) { S.prov.resume(); S.paused = false; $('btn-pause').textContent = 'Pause'; } else { S.prov.pause(); S.paused = true; $('btn-pause').textContent = 'Resume'; }
    });
    function slider(id, key, scale) {
      $(id).addEventListener('input', function () { outputs(Object.assign({}, S.st && S.st.opts, (function () { var o = {}; o[key] = Number($(id).value) / scale; return o; })())); });
      $(id).addEventListener('change', function () { var o = {}; o[key] = Number($(id).value) / scale; post('opts', o); });
    }
    function outputs(o) { $('o-lambda').textContent = pct(o.lambda) + '%'; $('o-tau').textContent = Number(o.tau).toFixed(2); $('o-settle').textContent = o.settle + ' s'; if ($('o-doze')) $('o-doze').textContent = (o.doze || 30) + ' min'; }
    slider('s-lambda', 'lambda', 100); slider('s-tau', 'tau', 1); slider('s-settle', 'settle', 1); slider('s-doze', 'doze', 1);
    $('copy-queue').addEventListener('click', function () {
      var st = S.st, lines = [];
      if (st && st.now) lines.push('Now: ' + st.now.track.title + ' - ' + st.now.track.artist);
      if (st) st.queue.forEach(function (q, i) { lines.push((i + 1) + '. ' + q.track.title + ' - ' + q.track.artist); });
      if (!lines.length) { $('copy-state').textContent = 'Nothing to copy yet.'; return; }
      var text = lines.join('\n');
      function fb() { $('notes').value = text; $('notes').hidden = false; $('notes').select(); $('copy-state').textContent = 'Select and copy the list below.'; }
      try { navigator.clipboard.writeText(text).then(function () { $('copy-state').textContent = 'Queue copied.'; }, fb); } catch (e) { fb(); }
    });
    $('copy-notes').addEventListener('click', function () {
      var text = notesText(S.st);
      function fb() { $('notes').value = text; $('notes').hidden = false; $('notes').select(); $('copy-state').textContent = 'Select and copy the notes below.'; }
      try { navigator.clipboard.writeText(text).then(function () { $('copy-state').textContent = 'Copied.'; $('notes').hidden = true; }, fb); } catch (e) { fb(); }
    });

    function notesText(st) {
      if (!st) return '';
      var names = {}; st.guests.forEach(function (g) { names[g.id] = g.name; });
      var lines = ['Room Blend session ' + code,
        'Settings: protect least-happy ' + pct(st.opts.lambda) + '%, blend threshold ' + st.opts.tau.toFixed(2) + ', settle ' + st.opts.settle + ' s',
        'Guests: ' + (st.guests.length ? st.guests.map(function (g) { return g.name + ' (' + (g.genres.length ? g.genres : g.inferred || []).map(gl).join(', ') + ')'; }).join('; ') : 'none'), 'Played:'];
      st.history.forEach(function (x, i) {
        lines.push((i + 1) + '. ' + x.track.title + ' - ' + x.track.artist + ' | ' + x.mode + (x.owner && names[x.owner] ? ' (' + names[x.owner] + ')' : '') + ' | room ' + pct(x.room) + ' | ' +
          x.fits.filter(function (f) { return names[f.id]; }).map(function (f) { return names[f.id] + ' ' + pct(f.fit) + '%'; }).join(', ') +
          (x.votes && (x.votes.up || x.votes.down) ? ' | guests: ' + x.votes.up + ' good, ' + x.votes.down + ' bad' : ''));
      });
      return lines.join('\n');
    }

    // Free hosts (Render) put an idle server to sleep after 15 minutes and forget live rooms. A light request from the host page every 5 minutes keeps it awake while a room is open.
    setInterval(function () { try { fetch('/healthz', { cache: 'no-store' }).catch(function () {}); } catch (e) { /* ignore */ } }, 300000);

    // ----- music source (provider) -----
    var Pv = window.Providers; Pv.finish();
    var ctx = {
      code: code, genres: C.genres,
      st: function () { return S.st; },
      rerender: function () { renderSource(); },
      status: function (m) { S.status = m; renderSource(); },
      ended: function () { post('player', { event: 'ended', trackId: S.playing }); },
      uploadLibrary: function (provider, label, tracks, refresh) { return post('library', { provider: provider, label: label, tracks: tracks, refresh: !!refresh }); },
      clearLibrary: function () { return http('DELETE', '/api/rooms/' + code + '/host/library', null, H); },
      changed: function () { S.playing = null; maybePlay(); maybeExtras(); },
    };
    var firstChoice = lsGet('rb-source');
    S.prov = Pv.get(firstChoice || (SP && SP.clientId() && SP.connected() ? 'spotify' : 'manual'));
    if (S.prov.unavailable) S.prov = Pv.get('manual');

    function choose(id) {
      var prev = S.prov, next = Pv.get(id);
      if (prev === next) return;
      try { prev.stop(); } catch (e) { /* ignore */ }
      S.prov = next; S.status = ''; S.playing = null; S.reup = 0; S.tried = {};
      if (prev.pool) post('extras', { reset: true });
      if (!next.unavailable) lsSet('rb-source', id);
      if (next.kind !== 'library' && S.st && S.st.source && S.st.source.kind === 'library') ctx.clearLibrary();
      if (next.kind === 'library' && next.activate) next.activate(ctx);
      renderSource();
    }

    function renderSource() {
      var box = $('sp'), P = S.prov;
      var picker = h('div', { class: 'srcs', role: 'group', 'aria-label': 'Music source' }, Pv.list.map(function (x) {
        return h('button', { class: 'src', type: 'button', 'data-src': x.id, 'aria-pressed': x === P ? 'true' : 'false', title: x.blurb, onclick: function () { choose(x.id); } }, [
          h('span', { class: 'src-name', text: x.name }), h('span', { class: 'src-blurb', text: x.blurb }),
        ]);
      }));
      var body = h('div', { class: 'srcbody', id: 'sp-body' }, [P.render(ctx)]);
      box.replaceChildren.apply(box, [h('h3', { text: 'Where is your music?' }), picker, body].concat(S.status ? [h('p', { class: 'hint', role: 'status', id: 'sp-status', text: S.status })] : []));
      $('btn-pause').hidden = !(P.ready() && P.kind !== 'manual');
    }

    function trackFor(st) {
      var t = st.now.track;
      return Object.assign({}, t, { nativeId: st.source && st.source.kind === 'library' ? t.id.slice(1) : t.id });
    }
    async function maybePlay() {
      var st = S.st, P = S.prov;
      if (!st || !st.now || !P.ready() || S.playing === st.now.track.id) return;
      var src = st.source || { kind: 'curated' };
      if (P.kind === 'library' ? !(src.kind === 'library' && src.provider === P.id) : src.kind !== 'curated') return;
      var track = trackFor(st);
      S.playing = track.id;
      var r = await P.play(track);
      if (S.playing !== track.id) return;
      if (r === null) { S.status = P.lastError ? P.lastError() : 'That song could not be played, so it was skipped.'; renderSource(); post('player', { event: 'unplayable', trackId: track.id }); return; }
      if (!r) { S.playing = null; S.status = P.lastError ? P.lastError() : 'Could not start playback.'; renderSource(); }
      else if (S.status) { S.status = ''; renderSource(); }
    }

    // Genres the guests picked (broad picks spread out), so a search can prefer songs two of them can share.
    function partnersOf(st) {
      var out = [];
      function add(x) { if (out.indexOf(x) < 0) out.push(x); }
      (st.guests || []).forEach(function (g) {
        (g.genres || []).forEach(function (p) {
          var grp = /^any:/.test(p) ? (C.genreGroups || []).filter(function (x) { return 'any:' + x[0].toLowerCase().replace(/\s+/g, '-') === p; })[0] : null;
           (grp ? grp[1] : (C.genreAliases && C.genreAliases[p]) || [p]).forEach(add);
        });
      });
      return out;
    }

    async function maybeExtras() {
      var st = S.st, P = S.prov;
      if (!st || !P.canExtras || !P.canExtras() || S.extrasBusy || (st.source && st.source.kind === 'library')) return;
      var todo = (st.wantGenres || []).filter(function (g) { return !S.tried[g]; });
      var arts = P.artistTracks ? (st.wantArtists || []).filter(function (a) { return !S.tried['a:' + a.name.toLowerCase()]; }) : [];
      if (!todo.length && !arts.length) return;
      S.extrasBusy = true;
      try {
        for (var i = 0; i < todo.length; i++) {
          S.tried[todo[i]] = true;
          var tracks = []; try { tracks = await P.extras(todo[i], partnersOf(st)) || []; } catch (e) { tracks = []; }
          // pool: the service now supplies the songs (only once it has actually returned some, otherwise the built-in list stays)
          await post('extras', { genre: todo[i], tracks: tracks, pool: !!P.pool && tracks.length > 0, source: P.id });
        }
        // Artists guests named that the room's songs do not have: look each one up once. Only that artist's songs are kept.
        for (var j = 0; j < arts.length; j++) {
          S.tried['a:' + arts[j].name.toLowerCase()] = true;
          var found = []; try { found = await P.artistTracks(arts[j].name, arts[j].genre) || []; } catch (e) { found = []; }
          await post('extras', { genre: arts[j].genre, artist: arts[j].name, tracks: found, pool: false, source: P.id });
        }
      } finally { S.extrasBusy = false; }
    }

    // ----- rendering -----
    function render(st) {
      S.st = st;
      $('tv-cast-room').textContent = st.name || 'Now playing';
      $('tv-cast-title').textContent = st.now ? st.now.track.title : 'Waiting for the first guest';
      $('tv-cast-artist').textContent = st.now ? st.now.track.artist : '';
      $('tv-cast-meta').textContent = st.guests.filter(function (g) { return g.status === 'active'; }).length + ' listening · ' + (st.now ? (st.now.mode === 'rotate' ? 'taking turns' : 'blending everyone’s taste') : 'waiting for guests');
      $('tv-cast-genres').replaceChildren.apply($('tv-cast-genres'), st.now ? tagList(st.now.track.genres || []) : []);
      var tvNext = $('tv-cast-next'); tvNext.replaceChildren();
      st.queue.slice(0, 3).forEach(function (item) {
        tvNext.appendChild(h('li', null, [document.createTextNode(item.track.title + ' '), h('span', { text: item.track.artist })]));
      });
      if (!st.queue.length) tvNext.appendChild(h('li', { class: 'tv-cast-empty', text: 'Songs will appear here.' }));
      if (document.activeElement !== $('room-name') && $('room-name').value !== st.name) $('room-name').value = st.name || '';
      $('disc').checked = st.discoverable !== false;
      var people = {}; st.guests.forEach(function (g) { people[g.id] = g; });
      if (document.activeElement !== $('s-lambda')) $('s-lambda').value = Math.round(st.opts.lambda * 100);
      if (document.activeElement !== $('s-tau')) $('s-tau').value = st.opts.tau;
      if (document.activeElement !== $('s-settle')) $('s-settle').value = st.opts.settle;
      if (document.activeElement !== $('s-doze')) $('s-doze').value = st.opts.doze || 30;
      outputs(st.opts);

      var it = st.now, badge = $('mode-badge');
      if (!it) {
        $('now-title').textContent = 'Nothing yet';
        $('now-artist').textContent = st.guests.length ? 'Building the first queue.' : 'Waiting for the first guest.';
        $('now-genres').replaceChildren(); $('now-why').textContent = ''; $('now-votes').textContent = ''; $('now-fits').replaceChildren();
        $('mode-text').textContent = 'Waiting for guests'; badge.className = 'badge';
      } else {
        $('now-title').textContent = it.track.title; $('now-artist').textContent = it.track.artist;
        $('now-genres').replaceChildren.apply($('now-genres'), tagList(it.track.genres));
        $('now-why').textContent = it.why;
        $('now-votes').textContent = it.votes && (it.votes.up || it.votes.down) ? 'Guests on their phones: ' + it.votes.up + ' good, ' + it.votes.down + ' bad.' : '';
        $('now-fits').replaceChildren.apply($('now-fits'), Array.prototype.slice.call(fitMeters(it.fits, people).childNodes));
        $('mode-text').textContent = it.mode === 'blend' ? 'Blending' : 'Rotating';
        badge.className = 'badge' + (it.mode === 'rotate' ? ' rotate' : '');
      }

      var q = $('queue'); q.replaceChildren();
      var active = st.guests.filter(function (g) { return g.status === 'active'; });
      if (!active.length) {
        $('overlap').textContent = ''; $('q-meta').textContent = '';
        q.appendChild(h('li', { class: 'empty', text: 'Nobody is in the blend yet. Share the link above, or add someone by hand.' }));
      } else {
        $('overlap').replaceChildren(document.createTextNode('Best overlap for this room is '), h('strong', { text: st.bestRoom.toFixed(2) }),
          document.createTextNode(', against a blend threshold of ' + st.opts.tau.toFixed(2) + '. '), h('strong', { text: st.mode === 'rotate' ? 'Songs are rotating between guests.' : 'Songs are blending.' }));
        $('q-meta').textContent = st.queue.length + ' lined up';
        st.queue.forEach(function (x, i) {
          var o = people[x.owner];
          q.appendChild(h('li', { class: 'qrow' }, [
            h('span', { class: 'pos', text: String(i + 1) }),
            h('div', null, [h('div', { class: 'qtitle' }, [document.createTextNode(x.track.title + ' '), h('span', { text: x.track.artist })]), h('div', { class: 'tags' }, tagList(x.track.genres))]),
            h('div', { class: 'qside' }, [
              h('span', { class: 'modetag' + (x.mode === 'rotate' ? ' rotate' : '') }, [h('i'), document.createTextNode(x.mode === 'blend' ? 'Blend' : 'Turn: ' + (o ? o.name : 'guest'))]),
              x.isNew ? h('span', { class: 'new', text: 'New' }) : null,
              S.prov.ready() ? null : h('a', { class: 'listen', href: spotifySearchUrl(x.track), target: '_blank', rel: 'noopener', text: 'Find it' }),
            ]),
            fitMeters(x.fits, people),
          ]));
        });
      }

      $('room-count').textContent = active.length + ' of ' + st.guests.length + ' counting';
      var ul = $('guests'); ul.replaceChildren();
      if (!st.guests.length) ul.appendChild(h('li', { class: 'empty', text: 'The room is empty.' }));
      st.guests.forEach(function (g) {
        var out = g.status !== 'active';
        var stat = g.status === 'arriving' ? 'Arriving, counts in ' + g.arriveIn + ' s' : g.away === 'network' ? 'Away: left the Wi-Fi' : g.away === 'idle' ? 'Quiet: no answer to "still here?"' : g.hostSit ? 'Sat out by you' : g.status === 'sitting' ? 'Sitting out' : (!g.connected && !g.manual ? (g.dozing ? 'Phone locked, still counted' : 'Reconnecting…') : 'In the blend');
        ul.appendChild(h('li', { class: 'guest' + (out ? ' out' : '') }, [
          h('span', { class: 'swatch', style: 'background:' + COLORS[g.color % COLORS.length] }),
          h('div', null, [h('div', { class: 'gname', text: g.name + (g.manual ? ' (added by you)' : '') }), h('div', { class: 'gstate', text: stat }), h('div', { class: 'tags' }, tagList(g.genres.length ? g.genres : g.inferred || [])), namedLine(g)]),
          h('div', { class: 'gactions' }, [
            g.status === 'arriving' ? null : h('button', { class: 'btn small', type: 'button', text: g.hostSit ? 'Bring back' : 'Sit out', onclick: function () { post('guests/' + g.id, { sit: !g.hostSit }); } }),
            h('button', { class: 'btn small', type: 'button', text: 'Remove', onclick: function () { post('guests/' + g.id, { remove: true }); } }),
          ]),
        ]));
      });

      var fb = $('fairness'); fb.replaceChildren();
      $('f-meta').textContent = st.history.length + (st.history.length === 1 ? ' song played' : ' songs played');
      if (!st.guests.length) fb.appendChild(h('p', { class: 'hint', text: 'Fairness shows once guests are in.' }));
      st.fairness.forEach(function (f) {
        var p = people[f.id]; if (!p) return;
        fb.appendChild(h('div', { class: 'frow' }, [
          h('div', { class: 'fname' }, [h('span', { class: 'swatch', style: 'background:' + COLORS[p.color % COLORS.length] + ';margin-top:0' }), document.createTextNode(p.name)]),
          h('div', { class: 'fbar' }, [h('span', { style: 'width:' + pct(f.avg) + '%;background:' + COLORS[p.color % COLORS.length] })]),
          h('div', { class: 'fmeta', text: f.songs ? 'Average fit ' + pct(f.avg) + '% over ' + f.songs + (f.songs === 1 ? ' song, ' : ' songs, ') + f.own + ' own turn' + (f.own === 1 ? '' : 's') : 'Not heard yet' }),
        ]));
      });
      var lg = $('log'); lg.replaceChildren();
      st.log.forEach(function (m) { lg.appendChild(h('li', { text: m })); });
      if (!st.log.length) lg.appendChild(h('li', { text: 'Nothing has happened yet.' }));

      var sig = JSON.stringify(st.source || {});
      if (sig !== S.srcSig) { S.srcSig = sig; renderSource(); }
      if (S.prov.kind === 'library' && S.prov.ready() && S.prov.activate && st.source && st.source.kind === 'curated' && S.reup < 1) { S.reup++; S.prov.activate(ctx); }
      maybePlay(); maybeExtras();
    }

    renderSource();
    var es;
    function connect() {
      es = new EventSource('/api/rooms/' + code + '/events?key=' + encodeURIComponent(key));
      es.onmessage = function (m) { try { render(JSON.parse(m.data)); } catch (e) { console.error(e); } };
      es.onerror = function () {
        if (es.readyState === EventSource.CLOSED) {
          http('GET', '/api/rooms/' + code).then(function (r) {
            if (r.status === 404) { lsDel('rb-host-' + code); app.replaceChildren(h('div', { class: 'wrap' }, [h('div', { class: 'hero' }, [h('h1', { text: 'This room has ended' }), h('p', { class: 'lead', text: 'Rooms close after a day of nobody using them.' }), h('a', { class: 'btn primary', href: '/', text: 'Start a new room' })])])); }
          });
        }
      };
    }
    connect();
  }

  // ---------- guest ----------
  function guestView(code) {
    var regKey = 'rb-guest-' + code;
    var reg = null; try { reg = JSON.parse(lsGet(regKey) || 'null'); } catch (e) { reg = null; }
    var params = new URLSearchParams(location.search);
    var es = null, st = null, findOpen = Object.create(null);

    app.replaceChildren(h('div', { class: 'wrap guest-wrap' }, [
      h('header', { class: 'top' }, [h('div', null, [h('h1', { id: 'gv-title-h', text: 'Room ' + code }), h('p', { id: 'g-sub', text: 'Pick genres, or name artists and songs you like. The room\'s music shifts to fit everyone who is here.' })])]),
      h('section', { class: 'gcol', id: 'gform-sec' }),
      h('section', { class: 'gcol', id: 'glive-sec', hidden: 'hidden' }),
    ]));

    http('GET', '/api/rooms/' + code).then(function (r) {
      if (r.status === 404) return roomGone();
      if (r.ok && r.data && r.data.name && $('gv-title-h')) { $('gv-title-h').textContent = r.data.name; document.title = r.data.name + ' on Room Blend'; }
    });
    function showForm(editing, note) {
      var picked = reg ? reg.genres.slice() : [];
      var nameIn = h('input', { type: 'text', id: 'gv-name', maxlength: '20', placeholder: 'First name or nickname', autocomplete: 'given-name', value: reg ? reg.name : (lsGet('rb-name') || '') });
      var picker = h('div', { class: 'chips', id: 'gv-picker' });
      var hint = h('p', { class: 'hint', id: 'gv-hint', role: 'status', text: note || '' });
      var named = { artists: reg && reg.artists ? reg.artists.slice() : [], songs: reg && reg.songs ? reg.songs.slice() : [] };
      var np = editing ? null : namedPicker(named, function () { hint.textContent = ''; });
      var lookupInput = editing ? null : h('input', { type: 'checkbox', id: 'gv-mb-lookup-join', checked: reg && reg.lookupGenres ? 'checked' : null });
      var lookupChoice = lookupInput ? h('label', { class: 'hint' }, [lookupInput, ' Use MusicBrainz to improve artist genre guesses. Up to five names from your artist and song picks are sent to MusicBrainz.']) : null;
      var importBox = null;
      if (C.clientId && !editing) {
        importBox = h('div', { class: 'import' }, [
          h('button', { class: 'btn', type: 'button', id: 'gv-import', text: 'Fill in from my Spotify', onclick: function () { lsSet('rb-name', nameIn.value); SP.login(['user-top-read'], '/r/' + code + '?import=1'); } }),
          h('p', { class: 'hint', text: 'Optional. Reads your top artists once and picks genres for you. You can change them.' }),
        ]);
      }
      var form = h('form', { class: 'add', id: 'gv-form', autocomplete: 'off' }, [
        h('h3', { text: editing ? 'Change your genres' : 'Join the room' }),
        h('div', null, [h('label', { for: 'gv-name', text: 'Your name (optional)' }), nameIn]),
        importBox,
        np ? h('fieldset', null, [h('legend', { text: 'Artists and songs you want to hear' }), h('p', { class: 'hint', text: 'Optional. Not sure about genres? Start here. Up to 5 of each, and only you can see them.' }), np.el]) : null,
        lookupChoice,
        h('fieldset', null, [h('legend', { text: 'Favourite genres, up to 4 (first pick counts most)' }), picker]),
        h('div', { class: 'row' }, [h('button', { class: 'btn primary', type: 'submit', id: 'gv-submit', text: editing ? 'Save' : 'Join the room' }), editing ? h('button', { class: 'btn', type: 'button', text: 'Cancel', onclick: function () { showLive(); } }) : null]),
        hint,
      ]);
      $('gform-sec').replaceChildren(form); $('gform-sec').hidden = false; $('glive-sec').hidden = true;
      chipPicker(picker, picked);
      if (!editing && params.get('import') === '1') runImport(picked, picker, hint);
      form.addEventListener('submit', async function (e) {
        e.preventDefault();
        var hasNamed = np ? named.artists.length + named.songs.length : (reg ? (reg.artists || []).length + (reg.songs || []).length : 0);
        if (!picked.length && !hasNamed) { hint.textContent = 'Pick a genre, or name an artist or song, to join.'; return; }
        var name = nameIn.value.trim() || 'Guest'; lsSet('rb-name', name);
        if (editing && reg) {
          var r = await http('PATCH', '/api/rooms/' + code + '/guests/' + reg.id, { name: name, genres: picked }, { 'x-guest-id': reg.id, 'x-guest-key': reg.key });
          if (!r.ok) { hint.textContent = 'Could not save. Try again.'; return; }
          reg.name = name; reg.genres = picked.slice(); lsSet(regKey, JSON.stringify(reg)); showLive();
        } else {
          var j = await http('POST', '/api/rooms/' + code + '/guests', { name: name, genres: picked, artists: named.artists, songs: named.songs, lookupGenres: !!(lookupInput && lookupInput.checked), since: (reg && reg.since) || undefined });
          if (j.status === 404) { return roomGone(); }
          if (!j.ok) { hint.textContent = 'Could not join. Try again.'; return; }
          reg = { id: j.data.guestId, key: j.data.guestKey, name: name, genres: picked.slice(), artists: named.artists.slice(), songs: named.songs.slice(), lookupGenres: !!(lookupInput && lookupInput.checked), since: (reg && reg.since) || j.data.since || Date.now() }; lsSet(regKey, JSON.stringify(reg));
          history.replaceState(null, '', '/r/' + code); showLive();
        }
      });
    }

    async function runImport(picked, picker, hint) {
      history.replaceState(null, '', '/r/' + code);
      hint.textContent = 'Reading your Spotify…';
      try {
        var lists = await SP.topArtistGenres();
        if (!lists) { hint.textContent = 'Could not read your Spotify taste. This app may only allow a few listed people. Pick your genres by hand instead.'; return; }
        var gs = window.GenreMap.fromArtists(lists, 4);
        if (!gs.length) { hint.textContent = 'Spotify did not return genres for your top artists. Pick them by hand.'; return; }
        picked.length = 0; gs.forEach(function (g) { picked.push(g); });
        Array.prototype.forEach.call(picker.querySelectorAll('button'), function (c) { var on = picked.indexOf(c.getAttribute('data-g')) >= 0; c.setAttribute('aria-pressed', on ? 'true' : 'false'); c.disabled = !on && picked.length >= 4; });
        hint.textContent = 'Picked from your top artists. Change them if you like, then join.';
      } catch (e) { hint.textContent = 'Could not read your Spotify taste. Pick your genres by hand.'; }
    }

    function roomGone() {
      if (es) es.close();
      app.replaceChildren(h('div', { class: 'wrap' }, [h('div', { class: 'hero' }, [h('h1', { text: 'This room has ended' }), h('p', { class: 'lead', text: 'The code may be wrong, or the host closed the room.' }), h('a', { class: 'btn primary', href: '/', text: 'Back' })])]));
    }

    function showLive() {
      $('gform-sec').hidden = true; $('glive-sec').hidden = false;
      $('glive-sec').replaceChildren(
        h('div', { class: 'now' }, [
          h('div', { class: 'now-head' }, [h('span', { class: 'label', id: 'gv-count', text: 'Connecting…' }), h('span', { id: 'gv-mode', class: 'badge' }, [h('i'), h('span', { id: 'gv-mode-text', text: 'Waiting' })])]),
          h('h2', { class: 'now-title', id: 'gv-title', text: 'Waiting for the music' }), h('p', { class: 'now-artist', id: 'gv-artist' }),
          h('p', { class: 'why', id: 'gv-why' }),
          h('div', { class: 'controls' }, [h('span', { class: 'label', text: 'Your call' }), h('button', { class: 'btn small', type: 'button', id: 'gv-good', 'aria-pressed': 'false', text: 'Good pick', onclick: function () { vote('up'); } }), h('button', { class: 'btn small', type: 'button', id: 'gv-bad', 'aria-pressed': 'false', text: 'Bad pick', onclick: function () { vote('down'); } })]),
        ]),
        h('div', null, [h('div', { class: 'sec-h' }, [h('h2', { text: 'Up next' })]), h('ol', { class: 'gnext', id: 'gv-next' })]),
        picksSection(),
        h('div', { id: 'gv-played-sec' }, [
          h('div', { class: 'sec-h' }, [h('h2', { text: 'Played while you were here' }), h('span', { class: 'meta', id: 'gv-played-n' })]),
          h('p', { class: 'hint', id: 'gv-played-msg', role: 'status' }),
          h('ol', { class: 'played', id: 'gv-played' }),
        ]),
        h('details', { class: 'saved', id: 'gv-saved' }, [h('summary', { id: 'gv-saved-sum', text: 'Songs I saved' }), h('ol', { class: 'played', id: 'gv-saved-list' }), h('div', { class: 'row' }, [h('button', { class: 'btn small', type: 'button', id: 'gv-saved-copy', text: 'Copy my list', onclick: function () { copy(savedList().map(function (x) { return x.title + ' - ' + x.artist; }).join('\n'), $('gv-saved-copy')); } })])]),
        h('div', { class: 'ask', id: 'gv-ask', role: 'alert', hidden: 'hidden' }, [
          h('p', { text: 'Still here? Tap to keep your picks in the mix.' }),
          h('button', { class: 'btn primary', type: 'button', id: 'gv-here', text: 'I\'m still here', onclick: function () { touch(true); } }),
        ]),
        h('p', { class: 'hint', id: 'gv-me' }),
        h('div', { class: 'gbtns' }, [
          h('button', { class: 'btn', type: 'button', id: 'gv-sit', 'aria-pressed': 'false', text: 'Sit out for now', onclick: function () { patch({ sit: !(st && st.me && st.me.sit) }); } }),
          h('button', { class: 'btn', type: 'button', id: 'gv-edit', text: 'Change my genres', onclick: function () { showForm(true); } }),
          h('button', { class: 'btn', type: 'button', id: 'gv-leave', text: 'Leave the room', onclick: leave }),
        ])
      );
      if (st) renderLive(st);
      connect(); startBeats();
    }

    var auth = function () { return { 'x-guest-id': reg.id, 'x-guest-key': reg.key }; };

    // Artists and songs a guest names. They count as a perfect match for that guest, but never override what the room shares.
    // One picker serves the join form (before the guest exists) and the room view (after), over a holder with artists and songs lists.
    var MAX_ARTISTS = 5, MAX_SONGS = 5;
    function songKeyOf(x) { return (x.title + '|' + x.artist).toLowerCase().replace(/[^a-z0-9|]+/g, ' ').trim(); }
    function namedPicker(holder, onChange, keepOne) {
      var input = h('input', { type: 'search', class: 'genre-search', id: 'gv-q', maxlength: '60', placeholder: 'Search by artist, song or album', autocomplete: 'off', 'aria-label': 'Search for an artist, song or album' });
      var results = h('div', { id: 'gv-results', 'aria-live': 'polite' });
      var chosen = h('div', { class: 'chips', id: 'gv-chosen' });
      var msg = h('p', { class: 'hint search-status', id: 'gv-picks-msg', role: 'status' });
      var timer = null, seq = 0, last = null;
      input.addEventListener('input', function () {
        clearTimeout(timer);
        var q = input.value.trim(), mine = ++seq;
        last = null; results.replaceChildren(); results.setAttribute('aria-busy', 'false');
        msg.classList.remove('is-loading'); msg.textContent = '';
        if (q.length < 2) return;
        results.setAttribute('aria-busy', 'true');
        msg.classList.add('is-loading');
        msg.textContent = 'Searching the room and MusicBrainz. This may take a few seconds.';
        timer = setTimeout(function () { run(mine); }, 250);
      });
      async function run(mine) {
        var q = input.value.trim();
        if (q.length < 2 || mine !== seq) return;
        var r;
        try { r = await http('GET', '/api/rooms/' + code + '/search?q=' + encodeURIComponent(q), null, reg ? auth() : {}); }
        catch (e) {
          if (mine === seq) {
            results.setAttribute('aria-busy', 'false');
            msg.classList.remove('is-loading'); msg.textContent = 'Search is not available right now.';
          }
          return;
        }
        if (mine !== seq) return; // a newer search is already on its way
        results.setAttribute('aria-busy', 'false');
        msg.classList.remove('is-loading');
        if (!r.ok) { msg.textContent = 'Search is not available right now.'; return; }
        last = r.data; draw();
      }
      function draw() {
        results.replaceChildren();
        if (!last) return;
        var a = last.artists || [], t = last.songs || [], albums = last.albums || [];
        var typed = input.value.trim().replace(/\s+/g, ' ');
        var haveA = holder.artists.map(function (x) { return x.toLowerCase(); }), haveS = holder.songs.map(songKeyOf);
        var canTyped = !a.length && !t.length && !albums.length && typed.length >= 2 && holder.artists.length < MAX_ARTISTS && haveA.indexOf(typed.toLowerCase()) < 0;
        msg.textContent = last.lookupUnavailable ? 'MusicBrainz search is unavailable; showing matches from the room.' : '';
        if (!a.length && !t.length && !albums.length) {
          msg.textContent += (msg.textContent ? ' ' : '') + 'Nothing in the room or MusicBrainz matches.';
          if (canTyped) msg.textContent += ' You can still add this name as an artist.';
        }
        if (canTyped) results.appendChild(h('div', { class: 'rrow' }, [h('span', { class: 'rname', text: typed }), h('button', { class: 'btn small', type: 'button', id: 'gv-add-typed', text: 'Add artist', onclick: function () { addArtist(typed); } })]));
        a.forEach(function (x) {
          var on = haveA.indexOf(x.name.toLowerCase()) >= 0;
          results.appendChild(h('div', { class: 'rrow' }, [h('span', { class: 'rname', text: x.name }), h('span', { class: 'hint', text: x.source === 'musicbrainz' ? 'MusicBrainz artist' : x.songs + (x.songs === 1 ? ' song here' : ' songs here') }),
            h('button', { class: 'btn small', type: 'button', text: on ? 'Added' : 'Add artist', disabled: on || holder.artists.length >= MAX_ARTISTS ? 'disabled' : null, onclick: function () { addArtist(x.name); } })]));
        });
        t.forEach(function (x) {
          var on = haveS.indexOf(songKeyOf(x)) >= 0;
          results.appendChild(h('div', { class: 'rrow' }, [h('span', { class: 'rname' }, [document.createTextNode(x.title + ' '), h('span', { text: x.artist })]), x.source === 'musicbrainz' ? h('span', { class: 'hint', text: 'MusicBrainz song' }) : null,
            h('button', { class: 'btn small', type: 'button', text: on ? 'Added' : 'Add song', disabled: on || holder.songs.length >= MAX_SONGS ? 'disabled' : null, onclick: function () { addSong(x); } })]));
        });
        albums.forEach(function (x) {
          var roomLeft = holder.songs.length < MAX_SONGS;
          results.appendChild(h('div', { class: 'rrow' }, [
            h('span', { class: 'rname' }, [document.createTextNode(x.title + ' '), h('span', { text: x.artist })]),
            h('span', { class: 'hint', text: 'MusicBrainz album' }),
            h('button', { class: 'btn small', type: 'button', text: roomLeft ? 'Add album tracks' : 'Song limit reached', disabled: !roomLeft ? 'disabled' : null, onclick: function (event) { addAlbum(x, event.currentTarget); } }),
          ]));
        });
      }
      function change() { showChosen(); draw(); if (onChange) onChange(); }
      function addArtist(name) { holder.artists = holder.artists.concat([name]).slice(0, MAX_ARTISTS); change(); }
      function addSong(x) { holder.songs = holder.songs.concat([{ title: x.title, artist: x.artist }]).slice(0, MAX_SONGS); change(); }
      async function addAlbum(album, button) {
        button.disabled = true; button.textContent = 'Loading tracks…';
        var r;
        try { r = await http('GET', '/api/rooms/' + code + '/search/album/' + encodeURIComponent(album.id), null, reg ? auth() : {}); }
        catch (e) {
          button.disabled = false; button.textContent = 'Add album tracks';
          msg.textContent = 'Could not load this album’s tracks. Try again.';
          return;
        }
        if (!r.ok || !r.data || !Array.isArray(r.data.songs)) {
          button.disabled = false; button.textContent = 'Add album tracks';
          msg.textContent = 'Could not load this album’s tracks. Try again.';
          return;
        }
        var existing = holder.songs.map(songKeyOf), added = [];
        r.data.songs.forEach(function (song) {
          var key = songKeyOf(song);
          if (existing.indexOf(key) < 0 && added.length + holder.songs.length < MAX_SONGS) { added.push(song); existing.push(key); }
        });
        if (!added.length) { button.disabled = false; button.textContent = 'Add album tracks'; msg.textContent = r.data.songs.length ? 'Your five-song limit is full, or these album tracks are already picked.' : 'No tracklist is available for this album.'; return; }
        holder.songs = holder.songs.concat(added);
        change();
        msg.textContent = 'Added ' + added.length + ' track' + (added.length === 1 ? '' : 's') + ' from ' + album.title + '.';
      }
      // A guest who named no genres needs at least one artist or song to go on.
      function lastOne() {
        if (keepOne && keepOne() && holder.artists.length + holder.songs.length === 1) { msg.textContent = 'Add a genre before removing your last artist or song.'; return true; }
        return false;
      }
      function showChosen() {
        var chips = [];
        holder.artists.forEach(function (n) { chips.push(h('button', { class: 'chip', type: 'button', 'aria-pressed': 'true', 'aria-label': 'Remove artist ' + n, text: n + ' ×', onclick: function () { if (lastOne()) return; holder.artists = holder.artists.filter(function (x) { return x !== n; }); change(); } })); });
        holder.songs.forEach(function (x) { chips.push(h('button', { class: 'chip', type: 'button', 'aria-pressed': 'true', 'aria-label': 'Remove song ' + x.title, text: x.title + ' ×', onclick: function () { if (lastOne()) return; holder.songs = holder.songs.filter(function (q) { return songKeyOf(q) !== songKeyOf(x); }); change(); } })); });
        chosen.replaceChildren.apply(chosen, chips);
      }
      showChosen();
      return { el: h('div', { class: 'picker' }, [chosen, input, results, msg]), refresh: function () { showChosen(); draw(); } };
    }

    // The same picker inside the room, high on the page where a guest can see it.
    function picksSection() {
      var meta = h('span', { class: 'meta', id: 'gv-picks-n' });
      var holder = { get artists() { return reg.artists || []; }, set artists(v) { reg.artists = v; }, get songs() { return reg.songs || []; }, set songs(v) { reg.songs = v; } };
      function count() { var n = holder.artists.length + holder.songs.length; meta.textContent = n ? n + ' added' : ''; }
      var lookupInput = h('input', { type: 'checkbox', id: 'gv-mb-lookup-live', checked: reg.lookupGenres ? 'checked' : null, onchange: function () { reg.lookupGenres = lookupInput.checked; lsSet(regKey, JSON.stringify(reg)); patch({ lookupGenres: reg.lookupGenres }); } });
      var pk = namedPicker(holder, function () { lsSet(regKey, JSON.stringify(reg)); patch({ artists: reg.artists, songs: reg.songs }); count(); }, function () { return !(reg.genres && reg.genres.length); });
      picksSection.refresh = function () { lookupInput.checked = !!reg.lookupGenres; pk.refresh(); count(); };
      count();
      return h('div', { id: 'gv-picks' }, [
        h('div', { class: 'sec-h' }, [h('h2', { text: 'Artists and songs you want to hear' }), meta]),
        h('p', { class: 'hint', text: 'Songs by these artists play when they fit the room, and on your turn when it rotates. Only you can see them.' }),
        h('label', { class: 'hint' }, [lookupInput, ' Use MusicBrainz to improve artist genre guesses. Up to five names from your artist and song picks are sent to MusicBrainz.']),
        pk.el,
      ]);
    }

    // Presence: tell the room we are still here about once a minute, and how long since we touched the page.
    var lastTouch = Date.now(), lastBeat = 0, beatTimer = null;
    function beat() {
      if (!reg) return;
      lastBeat = Date.now();
      http('POST', '/api/rooms/' + code + '/guests/' + reg.id + '/here', { idleSec: Math.round((Date.now() - lastTouch) / 1000), hidden: document.visibilityState === 'hidden' }, auth(), true).catch(function () { /* offline: the connection handles it */ });
    }
    function touch(force) {
      lastTouch = Date.now();
      var needs = st && st.me && (st.me.away || st.me.ask);
      if (force || (needs && Date.now() - lastBeat > 2000)) beat();
    }
    ['pointerdown', 'keydown', 'touchstart', 'scroll'].forEach(function (ev) { window.addEventListener(ev, function () { touch(false); }, { passive: true }); });
    // Going to the background (phone locked, app switched) is not leaving: say so, and the room keeps this guest for the host's doze time.
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') touch(true); else beat(); });
    function startBeats() { if (!beatTimer) beatTimer = setInterval(beat, C.beatMs || 60000); }
    function vote(v) { var mine = st && st.now && st.now.myVote; http('POST', '/api/rooms/' + code + '/vote', { v: mine === v ? null : v }, auth()); }
    function patch(p) { http('PATCH', '/api/rooms/' + code + '/guests/' + reg.id, p, auth()); }

    // ----- songs I heard: save them, find them, and let them widen my picks -----
    function savedList() { try { return JSON.parse(lsGet('rb-saved') || '[]') || []; } catch (e) { return []; } }
    function songKey(t) { return (t.title + '|' + t.artist).toLowerCase(); }
    function isSaved(t) { var k = songKey(t); return savedList().some(function (x) { return songKey(x) === k; }); }
    function toggleSaved(t) {
      var k = songKey(t), list = savedList(), i = list.findIndex(function (x) { return songKey(x) === k; });
      if (i >= 0) list.splice(i, 1); else list.unshift({ title: t.title, artist: t.artist, genres: t.genres || [], at: Date.now(), room: code });
      lsSet('rb-saved', JSON.stringify(list.slice(0, 500)));
      if (st) renderPlayed(st);
    }
    function findLinks(t) {
      var q = encodeURIComponent(t.title + ' ' + t.artist), key = songKey(t), details;
      details = h('details', {
        class: 'find',
        open: findOpen[key] ? 'open' : null,
        ontoggle: function () { findOpen[key] = details.open; },
      }, [h('summary', { text: 'Find it', onclick: function () { findOpen[key] = !details.open; } }), h('span', { class: 'findlinks' }, [
        h('a', { href: 'https://open.spotify.com/search/' + q, target: '_blank', rel: 'noopener', text: 'Spotify' }),
        h('a', { href: 'https://music.apple.com/search?term=' + q, target: '_blank', rel: 'noopener', text: 'Apple Music' }),
        h('a', { href: 'https://music.youtube.com/search?q=' + q, target: '_blank', rel: 'noopener', text: 'YouTube Music' }),
      ])]);
      return details;
    }
    // Adds the first genre of the song that is not already in my picks. At four picks the last (least weight) makes room.
    function widen(t) {
      var msg = $('gv-played-msg'), add = (t.genres || []).filter(function (g) { return reg.genres.indexOf(g) < 0; })[0];
      if (!add) { msg.textContent = 'Its genres are already in your picks.'; return; }
      var picks = reg.genres.slice(); if (picks.length >= 4) picks.pop(); picks.push(add);
      reg.genres = picks; lsSet(regKey, JSON.stringify(reg)); patch({ genres: picks });
      msg.textContent = 'Added ' + add + ' to your picks. The room will start to include it.';
    }
    function songRow(t, withMore) {
      var saved = isSaved(t);
      return h('li', { class: 'prow' }, [
        h('div', { class: 'ptxt' }, [h('div', { class: 'qtitle' }, [document.createTextNode(t.title + ' '), h('span', { text: t.artist })]), h('div', { class: 'tags' }, tagList(t.genres || []))]),
        h('div', { class: 'pact' }, [
          h('button', { class: 'btn small heart', type: 'button', 'aria-pressed': saved ? 'true' : 'false', 'aria-label': (saved ? 'Remove ' : 'Save ') + t.title, text: saved ? '♥ Saved' : '♡ Save', onclick: function () { toggleSaved(t); } }),
          withMore ? h('button', { class: 'btn small', type: 'button', text: 'More like this', onclick: function () { widen(t); } }) : null,
          findLinks(t),
        ]),
      ]);
    }
    function renderPlayed(s) {
      var ol = $('gv-played'); if (!ol) return;
      var list = s.played || [];
      $('gv-played-n').textContent = list.length ? list.length + (list.length === 1 ? ' song' : ' songs') : '';
      ol.replaceChildren.apply(ol, list.length ? list.map(function (t) { return songRow(t, true); }) : [h('li', { class: 'prow' }, [h('span', { class: 'hint', text: 'Songs will show up here as they play.' })])]);
      var sv = savedList(), sl = $('gv-saved-list');
      $('gv-saved-sum').textContent = 'Songs I saved' + (sv.length ? ' (' + sv.length + ')' : '');
      sl.replaceChildren.apply(sl, sv.length ? sv.map(function (t) { return songRow(t, false); }) : [h('li', { class: 'prow' }, [h('span', { class: 'hint', text: 'Tap Save on a song you like. Your list stays on this phone.' })])]);
      $('gv-saved-copy').hidden = !sv.length;
    }
    async function leave() {
      if (es) es.close(); es = null;
      await http('DELETE', '/api/rooms/' + code + '/guests/' + reg.id, null, auth());
      if (beatTimer) { clearInterval(beatTimer); beatTimer = null; }
      lsDel(regKey); reg = null; st = null; showForm(false, 'You left the room. Join again any time.');
    }

    function renderLive(s) {
      st = s;
      if (!$('gv-title')) return;
      $('gv-count').textContent = s.people + (s.people === 1 ? ' person' : ' people') + ' in the room';
      var it = s.now;
      if (!it) { $('gv-title').textContent = 'Waiting for the music'; $('gv-artist').textContent = ''; $('gv-why').textContent = ''; $('gv-mode-text').textContent = 'Waiting'; $('gv-mode').className = 'badge'; }
      else {
        $('gv-title').textContent = it.track.title; $('gv-artist').textContent = it.track.artist;
        $('gv-mode-text').textContent = it.mode === 'rotate' ? 'Rotating' : 'Blending'; $('gv-mode').className = 'badge' + (it.mode === 'rotate' ? ' rotate' : '');
        $('gv-why').textContent = (typeof it.fit === 'number' ? 'This one fits you ' + it.fit + '%. ' : '') + it.why;
      }
      $('gv-good').setAttribute('aria-pressed', it && it.myVote === 'up' ? 'true' : 'false');
      $('gv-bad').setAttribute('aria-pressed', it && it.myVote === 'down' ? 'true' : 'false');
      var ol = $('gv-next'); ol.replaceChildren();
      (s.next || []).forEach(function (n) { ol.appendChild(h('li', { class: 'nextrow' }, [document.createTextNode(n.title + ' '), h('span', { text: n.artist + (n.mine ? ' (your turn)' : '') })])); });
      if (!s.next || !s.next.length) ol.appendChild(h('li', { class: 'nextrow' }, [h('span', { text: 'Nothing lined up yet.' })]));
      var me = s.me;
      if (me && reg && typeof me.lookupGenres === 'boolean' && me.lookupGenres !== !!reg.lookupGenres) { reg.lookupGenres = me.lookupGenres; lsSet(regKey, JSON.stringify(reg)); if (picksSection.refresh) picksSection.refresh(); }
      if (me && Array.isArray(me.artists) && reg) { var ch = JSON.stringify([me.artists, me.songs]) !== JSON.stringify([reg.artists || [], reg.songs || []]); if (ch) { reg.artists = me.artists; reg.songs = me.songs; lsSet(regKey, JSON.stringify(reg)); if (picksSection.refresh) picksSection.refresh(); } }
      renderPlayed(s);
      $('gv-ask').hidden = !(me && me.ask && !me.away);
      $('gv-sit').setAttribute('aria-pressed', me && me.sit ? 'true' : 'false');
      $('gv-sit').textContent = me && me.sit ? 'Rejoin the blend' : 'Sit out for now';
      var meMessage = me ? (me.status === 'arriving' ? 'You are in. Your picks count in a few seconds.' : me.away === 'network' ? 'You seem to have left the Wi-Fi, so songs are chosen without you. Open this page when you are back.' : me.away === 'idle' ? 'Songs are chosen without you because you did not answer. Tap anywhere to rejoin the blend.' : me.hostSit ? 'The host has sat you out for now.' : me.sit ? 'You are sitting out, so songs are chosen without you.' : (me.genres.length ? 'Your picks: ' + me.genres.map(gl).join(', ') + '.' : me.inferred && me.inferred.length ? 'Starting you on ' + me.inferred.map(gl).join(', ') + ', guessed from what you named. Change my genres lets you steer it.' : 'The songs you named play as the room\'s music finds them.')) : '';
      if (me && me.lookupGenres && !me.genres.length) {
        if (me.genreLookupStatus === 'pending') meMessage += ' Checking MusicBrainz tags…';
        else if (me.genreLookupStatus === 'no-match') meMessage += ' MusicBrainz had no useful genre tags; the room’s music is used when possible.';
        else if (me.genreLookupStatus === 'unavailable') meMessage += ' MusicBrainz was unavailable; this guess uses the room’s music.';
        else if (me.genreLookupStatus === 'partial') meMessage += ' MusicBrainz could not check all names; some artist tags are used.';
      }
      $('gv-me').textContent = meMessage;
    }

    function connect() {
      if (es) es.close();
      es = new EventSource('/api/rooms/' + code + '/events?gid=' + encodeURIComponent(reg.id) + '&gkey=' + encodeURIComponent(reg.key));
      es.onmessage = function (m) { try { renderLive(JSON.parse(m.data)); } catch (e) { console.error(e); } };
      es.onerror = async function () {
        if (es.readyState !== EventSource.CLOSED) return;
        // Server restarted or dropped us: check the room, then rejoin quietly with the same picks.
        var r = await http('GET', '/api/rooms/' + code);
        if (r.status === 404) return roomGone();
        var j = await http('POST', '/api/rooms/' + code + '/guests', { name: reg.name, genres: reg.genres, since: reg.since, artists: reg.artists, songs: reg.songs, lookupGenres: !!reg.lookupGenres });
        if (j.ok) { reg.id = j.data.guestId; reg.key = j.data.guestKey; lsSet(regKey, JSON.stringify(reg)); connect(); }
        else setTimeout(connect, 3000);
      };
    }

    if (reg) { showLive(); } else showForm(false);
  }

  // ---------- big screen (TV / projector) ----------
  function screenView(code) {
    var joinUrl = (C.publicUrl || location.origin) + '/' + code;
    document.body.classList.add('tv-body');
    app.replaceChildren(h('div', { class: 'tv' }, [
      h('div', { class: 'tv-join' }, [
        h('div', { id: 'tv-qr', role: 'img', 'aria-label': 'QR code to join' }),
        h('p', { class: 'tv-scan', text: 'Scan to join and pick your music' }),
        h('p', { class: 'tv-url', text: joinUrl.replace(/^https?:\/\//, '') }),
        h('p', { class: 'tv-code', text: code }),
      ]),
      h('div', { class: 'tv-now' }, [
        h('p', { class: 'tv-label', id: 'tv-name', text: 'Now playing' }),
        h('h1', { id: 'tv-title', text: 'Waiting for the first guest' }),
        h('p', { class: 'tv-artist', id: 'tv-artist' }),
        h('p', { class: 'tv-meta', id: 'tv-meta' }),
        h('h2', { text: 'Up next' }), h('ol', { id: 'tv-next', class: 'tv-next' }),
      ]),
    ]));
    try { $('tv-qr').innerHTML = window.QR.svg(joinUrl, { ecc: 'M', label: 'QR code to join room ' + code }); } catch (e) { $('tv-qr').hidden = true; }
    function draw(st) {
      $('tv-name').textContent = st.name ? st.name : 'Now playing';
      $('tv-title').textContent = st.now ? st.now.title : 'Waiting for the first guest';
      $('tv-artist').textContent = st.now ? st.now.artist : '';
      $('tv-meta').textContent = st.people + (st.people === 1 ? ' person' : ' people') + ' in the room' + (st.now ? (st.now.mode === 'rotate' ? ' · taking turns' : ' · blending everyone\'s taste') : '');
      var ol = $('tv-next'); ol.replaceChildren();
      st.next.forEach(function (n) { ol.appendChild(h('li', null, [document.createTextNode(n.title + ' '), h('span', { text: n.artist })])); });
    }
    var es = new EventSource('/api/rooms/' + code + '/events?screen=1');
    es.onmessage = function (m) { try { draw(JSON.parse(m.data)); } catch (e) { console.error(e); } };
    es.onerror = function () { if (es.readyState === EventSource.CLOSED) { $('tv-title').textContent = 'This room has ended'; } };
  }

  // ---------- router ----------
  function route() {
    var p = location.pathname, m;
    if (p === '/callback') {
      app.replaceChildren(h('p', { class: 'boot', text: 'Finishing sign-in…' }));
      SP.handleCallback().then(function (to) { location.replace(to); }).catch(function (e) {
        app.replaceChildren(h('div', { class: 'wrap' }, [h('div', { class: 'hero' }, [h('h1', { text: 'Spotify sign-in did not finish' }), h('p', { class: 'lead', text: e.message || 'Try again.' }), h('a', { class: 'btn primary', href: '/', text: 'Back' })])]));
      });
    } else if ((m = p.match(/^\/host\/([A-Za-z0-9]{5})$/))) hostView(m[1].toUpperCase());
    else if ((m = p.match(/^\/screen\/([A-Za-z0-9]{5})$/))) screenView(m[1].toUpperCase());
    else if ((m = p.match(/^\/([A-Za-z0-9]{5})$/))) { history.replaceState(null, '', '/r/' + m[1].toUpperCase()); guestView(m[1].toUpperCase()); }
    else if ((m = p.match(/^\/r\/([A-Za-z0-9]{5})$/))) guestView(m[1].toUpperCase());
    else landing();
  }
  route();
})();
