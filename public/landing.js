// The live demo of the blend, on its own page (/demo), mounted into #demo-mount. Guests never see this: they arrive by QR code.
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

  function demo() {
    var sec = el('section', 'demo'); sec.setAttribute('aria-labelledby', 'demo-h');
    var h = el('h2', null, 'Who is in the room?'); h.id = 'demo-h';
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

  // The demo lives on its own page (/demo): the landing page stays short. app.js calls this with the page's container.
  function mount(box) {
    if (!box || box.getAttribute('data-ready')) return;
    box.setAttribute('data-ready', '1');
    box.appendChild(demo());
  }
  function scan() { var b = document.getElementById('demo-mount'); if (b) mount(b); }
  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  scan();
})();
