// The landing page's "explain it and let me try it" half: how it works in three steps, a live demo of the blend, what you need.
// Mounts into #landing-more (drawn by landing() in app.js). Guests never see this: they arrive through the QR code, not the landing page.
// The demo asks POST /api/demo/blend, which runs the real engine on a throwaway room; nothing is stored.
(function () {
  'use strict';
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  var PEOPLE = [
    { name: 'Maya', genres: ['rock', 'blues'], on: true },
    { name: 'Dev', genres: ['blues', 'jazz'], on: true },
    { name: 'Sam', genres: ['hip hop', 'r&b'], on: false },
    { name: 'Ana', genres: ['country', 'folk'], on: false },
  ];
  var YOU_CHOICES = ['rock', 'pop', 'jazz', 'blues', 'hip hop', 'country', 'electronic', 'classical', 'metal', 'folk', 'r&b', 'reggae'];

  function steps() {
    var sec = el('section', 'land-sec'); sec.setAttribute('aria-labelledby', 'how-h');
    var h = el('h2', null, 'How it works'); h.id = 'how-h'; sec.appendChild(h);
    var ol = el('ol', 'how');
    [['Start a room', 'Pick where the music comes from: a folder of your own music, YouTube or Spotify. Setup takes about a minute.'],
     ['Friends scan the QR code', 'They choose a few genres on their phone. No app, no account, nothing to install.'],
     ['The music blends', 'Room Blend plays what the room has in common. When there is nothing in common, it takes turns so everyone gets their songs.']]
      .forEach(function (s, i) {
        var li = el('li'); li.append(el('span', 'how-n', String(i + 1)), el('div', null)); li.lastChild.append(el('strong', null, s[0]), el('p', null, s[1])); ol.appendChild(li);
      });
    sec.appendChild(ol); return sec;
  }

  function demo() {
    var sec = el('section', 'land-sec demo'); sec.id = 'demo'; sec.setAttribute('aria-labelledby', 'demo-h');
    var h = el('h2', null, 'Try it: who is in the room?'); h.id = 'demo-h';
    sec.append(h, el('p', 'hint', 'Tap people in and out, or add your own taste. The songs below are what Room Blend would line up, live.'));
    var people = PEOPLE.map(function (p) { return { name: p.name, genres: p.genres.slice(), on: p.on }; });
    var you = [];
    var row = el('div', 'demo-people'); row.setAttribute('role', 'group'); row.setAttribute('aria-label', 'People in the room');
    var btns = people.map(function (p) {
      var b = el('button', 'demo-person'); b.type = 'button'; b.setAttribute('aria-pressed', String(p.on));
      b.append(el('strong', null, p.name), el('span', null, p.genres.join(' · ')));
      b.addEventListener('click', function () { p.on = !p.on; b.setAttribute('aria-pressed', String(p.on)); run(); });
      row.appendChild(b); return b;
    });
    var fs = el('fieldset', 'demo-you'); fs.appendChild(el('legend', null, 'You: pick up to 4 genres'));
    var chips = el('div', 'chips');
    YOU_CHOICES.forEach(function (g) {
      var c = el('button', 'chip', g); c.type = 'button'; c.setAttribute('aria-pressed', 'false');
      c.addEventListener('click', function () {
        var i = you.indexOf(g);
        if (i >= 0) you.splice(i, 1); else if (you.length < 4) you.push(g);
        Array.prototype.forEach.call(chips.children, function (x) { var on = you.indexOf(x.textContent) >= 0; x.setAttribute('aria-pressed', String(on)); x.disabled = !on && you.length >= 4; });
        run();
      });
      chips.appendChild(c);
    });
    fs.appendChild(chips);
    var out = el('div', 'demo-out'); out.setAttribute('aria-live', 'polite');
    sec.append(row, fs, out);

    var token = 0, timer = null;
    function run() { clearTimeout(timer); timer = setTimeout(go, 150); }
    async function go() {
      var mine = ++token;
      var list = people.filter(function (p) { return p.on; }).map(function (p) { return { name: p.name, genres: p.genres }; });
      if (you.length) list.push({ name: 'You', genres: you.slice() });
      if (!list.length) { out.replaceChildren(el('p', 'hint', 'Nobody is in the room yet. Tap someone above.')); return; }
      var r;
      try { var res = await fetch('/api/demo/blend', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ people: list }) }); r = res.ok ? await res.json() : null; } catch (e) { r = null; }
      if (mine !== token) return;
      if (!r) { out.replaceChildren(el('p', 'hint', 'The demo could not load. Start a room to see the real thing.')); return; }
      draw(r, list);
    }
    function draw(r, list) {
      var head = el('p', 'demo-line');
      if (list.length === 1) head.textContent = 'Just ' + list[0].name + ' so far, so it follows their taste.';
      else if (r.shared && r.shared.length) head.textContent = 'Everyone here likes ' + r.shared.join(' and ') + '. Songs from the overlap play first.';
      else head.textContent = 'No genre everyone shares, so it takes turns: ' + list.map(function (p) { return p.name; }).join(', ') + '. Songs that fit several people come first.';
      var ol = el('ol', 'demo-songs');
      (r.queue || []).slice(0, 6).forEach(function (q) {
        var li = el('li'); var t = el('div', 'demo-song'); t.append(el('strong', null, q.title), el('span', null, q.artist));
        var why = q.mode === 'rotate' && q.owner ? q.owner + "'s turn" : (q.fits && q.fits.length > 1 && q.fits.every(function (f) { return f.fit >= 0.5; }) ? 'Fits everyone' : 'Fits ' + (q.fits || []).filter(function (f) { return f.fit >= 0.5; }).map(function (f) { return f.name; }).join(' and '));
        li.append(t, el('span', 'demo-why' + (q.mode === 'rotate' ? ' turn' : ''), why));
        ol.appendChild(li);
      });
      out.replaceChildren(head, ol);
    }
    go();
    return sec;
  }

  function needs() {
    var sec = el('section', 'land-sec'); sec.setAttribute('aria-labelledby', 'need-h');
    var h = el('h2', null, 'What you need'); h.id = 'need-h'; sec.appendChild(h);
    var g = el('div', 'need');
    [['A way to play music', 'The quickest is a folder of your own music files: no sign-in. YouTube needs a free Google key (no Premium). Spotify needs Premium. A Navidrome or Subsonic server works too.'],
     ['A screen or speaker', 'Run the host page on a laptop or phone connected to speakers, or put the TV view on a big screen.'],
     ['Friends with phones', 'They scan the QR code. That is all. Guests never sign in.']]
      .forEach(function (n) { var c = el('div', 'need-card'); c.append(el('strong', null, n[0]), el('p', null, n[1])); g.appendChild(c); });
    sec.appendChild(g); return sec;
  }

  function mount() {
    var box = document.getElementById('landing-more'); if (!box || box.getAttribute('data-ready')) return;
    box.setAttribute('data-ready', '1');
    var cta = el('section', 'land-sec land-cta'); cta.append(el('h2', null, 'Ready? Start the music in about a minute.'));
    var go = el('button', 'btn primary big', 'Start a room'); go.type = 'button';
    go.addEventListener('click', function () { var b = document.getElementById('start-room'); if (b) b.click(); });
    cta.appendChild(go);
    box.append(steps(), demo(), needs(), cta);
  }
  new MutationObserver(mount).observe(document.documentElement, { childList: true, subtree: true });
  mount();
})();
