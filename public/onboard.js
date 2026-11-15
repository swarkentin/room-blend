// "Get going": a short checklist at the top of a new host page, so the first minute is obvious.
//   1. Choose music (done when the source is ready)   2. Invite friends (done when someone joins)   3. Music playing.
// It tucks itself away once everything is done (or when dismissed) and stays away in this browser. Mounts into #onboard-mount;
// the host page feeds it through RoomBlendOnboard.update(st, { sourceReady, sourceName }).
(function () {
  'use strict';
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  var KEY = 'rb-onboarded';
  function seen() { try { return localStorage.getItem(KEY) === '1'; } catch (e) { return false; } }
  function remember() { try { localStorage.setItem(KEY, '1'); } catch (e) { /* ignore */ } }
  var box = null, built = null, lastSig = '';

  function build() {
    var root = el('section', 'onboard'); root.setAttribute('aria-label', 'Get going');
    var head = el('div', 'onboard-head'); head.appendChild(el('h2', null, 'Get going in three steps'));
    var close = el('button', 'btn small', 'Hide'); close.type = 'button'; close.setAttribute('aria-label', 'Hide the setup steps');
    close.addEventListener('click', function () { remember(); root.hidden = true; });
    head.appendChild(close); root.appendChild(head);
    var ol = el('ol', 'onboard-steps'); root.appendChild(ol);
    var rows = [];
    function row(title, hint, actionLabel, action) {
      var li = el('li'), mark = el('span', 'ob-mark'); mark.setAttribute('aria-hidden', 'true');
      var txt = el('div'); var t = el('strong', null, title), hi = el('p', null, hint);
      txt.append(t, hi); li.append(mark, txt);
      var b = null;
      if (actionLabel) { b = el('button', 'btn small', actionLabel); b.type = 'button'; b.addEventListener('click', action); li.appendChild(b); }
      ol.appendChild(li); rows.push({ li: li, t: t, hint: hi, b: b }); return rows[rows.length - 1];
    }
    row('Choose the music', 'Pick where songs come from below. Quickest: My music files, a folder on this computer with no sign-in.', 'Open music source', function () { var d = document.querySelector('.source-settings'); if (d) { d.open = true; d.scrollIntoView({ block: 'center', behavior: 'smooth' }); } });
    row('Invite friends', 'Have them scan the QR code at the top, or send them the link. They pick genres on their phone.', 'Copy link', function () { var c = document.getElementById('jc'); if (c) c.click(); });
    row('Let the music play', 'It starts as soon as someone joins. Nobody here yet? Turn on House picks to start right away.', 'House picks', function () { var d = document.getElementById('house'); if (d) { d.open = true; d.scrollIntoView({ block: 'center', behavior: 'smooth' }); } });
    return { root: root, rows: rows };
  }

  function update(st, info) {
    if (!box || seen()) return;
    if (!built) { built = build(); box.appendChild(built.root); }
    var guests = (st.guests || []).filter(function (g) { return g.status !== 'arriving'; }).length;
    var done = [!!info.sourceReady, guests > 0, !!st.now && (st.mode !== 'waiting')];
    var sig = done.join() + '|' + info.sourceName;
    if (sig === lastSig) return; lastSig = sig;
    var first = done.indexOf(false);
    built.rows.forEach(function (r, i) {
      r.li.classList.toggle('done', !!done[i]); r.li.classList.toggle('next', i === first);
      if (r.b) r.b.hidden = !!done[i] || i !== first && i !== 1;
    });
    built.rows[0].t.textContent = done[0] ? 'Music: ' + info.sourceName : 'Choose the music';
    built.rows[1].t.textContent = done[1] ? guests + (guests === 1 ? ' person has joined' : ' people have joined') : 'Invite friends';
    built.rows[2].t.textContent = done[2] ? 'Music is playing' : 'Let the music play';
    if (done.every(Boolean)) { remember(); setTimeout(function () { if (built) built.root.hidden = true; }, 6000); }
  }
  function scan() { var m = document.getElementById('onboard-mount'); if (m && m !== box) { box = m; built = null; lastSig = ''; } }
  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  scan();
  window.RoomBlendOnboard = { update: update };
})();
