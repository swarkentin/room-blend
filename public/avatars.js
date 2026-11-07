// Little animated guests for the TV / cast view: one avatar per listener, standing along the bottom of the screen.
// Their pose follows how well the music is treating them, they only wander now and then, and hovering one shows their stats.
// Works in the browser (window.Avatars) and in Node (tests, for the mood logic).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Avatars = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LABELS = {
    thrilled: 'Loving this one',
    happy: 'Enjoying it',
    meh: 'It is just okay',
    grumpy: 'Not feeling this',
    waiting: 'Waiting for music',
    resting: 'Taking a break',
  };

  function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }

  // Match Ween as an artist credit, not as an incidental substring (e.g. "between").
  function isWeenArtist(value) {
    return String(value || '').split(/\s*(?:,|&|;|\bfeat(?:uring)?\.?|\bwith\b)\s*/i)
      .some(function (artist) { return artist.trim().toLowerCase() === 'ween'; });
  }

  /**
   * How a guest is feeling, from how well the song now playing fits them (0 to 1) and how well the room has
   * served them so far (average fit over the songs they have heard).
   * input: { fit, avg, songs, resting, restLabel }
   */
  function mood(input) {
    var i = input || {};
    if (i.resting) return { key: 'resting', label: i.restLabel || LABELS.resting, score: null };
    var fit = num(i.fit), avg = num(i.avg), hist = avg !== null && i.songs >= 2;
    var score = fit !== null ? (hist ? 0.6 * fit + 0.4 * avg : fit) : hist ? avg : null;
    var key = score === null ? 'waiting' : score >= 0.72 ? 'thrilled' : score >= 0.5 ? 'happy' : score >= 0.3 ? 'meh' : 'grumpy';
    return { key: key, label: LABELS[key], score: score };
  }

  // Cut the interval [lo, hi] out of a list of [start, end] spans.
  function cut(spans, lo, hi) {
    var out = [];
    spans.forEach(function (s) {
      if (hi <= s[0] || lo >= s[1]) { out.push(s); return; }
      if (lo > s[0]) out.push([s[0], lo]);
      if (hi < s[1]) out.push([hi, s[1]]);
    });
    return out;
  }
  function spanIndex(spans, x) {
    for (var k = 0; k < spans.length; k++) if (x >= spans[k][0] - 0.5 && x <= spans[k][1] + 0.5) return k;
    return -1;
  }
  function overlaps(a, b, pad) {
    return a.left < b.right + pad && a.right > b.left - pad && a.top < b.bottom + pad && a.bottom > b.top - pad;
  }

  var SVG = '<svg viewBox="0 0 60 84" aria-hidden="true" focusable="false">' +
    '<ellipse class="av-shadow" cx="30" cy="80" rx="16" ry="3.2"/>' +
    '<g class="av-legs"><rect class="av-limb av-leg av-leg-l" x="21" y="52" width="7.5" height="26" rx="3.75"/><rect class="av-limb av-leg av-leg-r" x="31.5" y="52" width="7.5" height="26" rx="3.75"/></g>' +
    '<g class="av-figure">' +
      '<rect class="av-torso" x="16" y="32" width="28" height="28" rx="12"/>' +
      '<rect class="av-limb av-arm av-arm-l" x="9.5" y="35" width="6.5" height="22" rx="3.25"/><rect class="av-limb av-arm av-arm-r" x="44" y="35" width="6.5" height="22" rx="3.25"/>' +
      '<g class="av-head">' +
        '<circle class="av-face" cx="30" cy="20" r="15"/>' +
        '<g class="av-cheeks"><circle cx="20.5" cy="25" r="2.6"/><circle cx="39.5" cy="25" r="2.6"/></g>' +
        '<g class="av-eyes"><ellipse cx="24.5" cy="19" rx="2.1" ry="2.9"/><ellipse cx="35.5" cy="19" rx="2.1" ry="2.9"/></g>' +
        '<g class="av-eyes-closed"><path d="M21.8 19.5 Q24.5 22 27.2 19.5"/><path d="M32.8 19.5 Q35.5 22 38.2 19.5"/></g>' +
        '<g class="av-brows"><path d="M21 14.5 L27.5 16.8"/><path d="M39 14.5 L32.5 16.8"/></g>' +
        '<path class="av-m av-m-grin" d="M23.5 25 Q30 34 36.5 25 Z"/>' +
        '<path class="av-m av-m-smile" d="M24.5 25.5 Q30 30.5 35.5 25.5"/>' +
        '<path class="av-m av-m-flat" d="M25.5 27.5 H34.5"/>' +
        '<path class="av-m av-m-frown" d="M24.5 29.5 Q30 24 35.5 29.5"/>' +
        '<path class="av-phones-band" d="M14.2 19 C14.2 3 45.8 3 45.8 19"/>' +
        '<rect class="av-phones-pad" x="11" y="15.5" width="6" height="11" rx="3"/><rect class="av-phones-pad" x="43" y="15.5" width="6" height="11" rx="3"/>' +
      '</g>' +
    '</g></svg>';

  function create(stage, opts) {
    opts = opts || {};
    var recs = new Map(), timer = null, avW = 0, enabled = opts.enabled !== false;

    function reduced() { return !!(opts.reduced && opts.reduced()); }
    function visible() { return stage.getClientRects().length > 0; }
    function avoidRects() {
      var els = opts.avoid ? opts.avoid() : [];
      return els.filter(function (el) { return el && !el.hidden; }).map(function (el) { return el.getBoundingClientRect(); })
        .filter(function (r) { return r.width > 0 && r.height > 0; });
    }

    // Horizontal ranges (in stage pixels) where an avatar may stand without covering the QR code or the video.
    function freeSpans() {
      var sr = stage.getBoundingClientRect(), spans = [[0, Math.max(0, sr.width - avW)]];
      avoidRects().forEach(function (r) {
        if (r.bottom < sr.top - 8 || r.top > sr.bottom + 8) return;
        spans = cut(spans, r.left - sr.left - avW - 14, r.right - sr.left + 14);
      });
      return spans;
    }
    function crowded(x, self) {
      var hit = false;
      recs.forEach(function (r) { if (r !== self && r.placed && Math.abs(r.x - x) < avW * 1.05) hit = true; });
      return hit;
    }
    function randomIn(spans, self) {
      var total = spans.reduce(function (n, s) { return n + (s[1] - s[0]); }, 0);
      for (var t = 0; t < 16; t++) {
        var at = Math.random() * total, x = spans[0][0];
        for (var k = 0; k < spans.length; k++) { var len = spans[k][1] - spans[k][0]; if (at <= len || k === spans.length - 1) { x = spans[k][0] + Math.min(at, len); break; } at -= len; }
        if (!crowded(x, self)) return x;
      }
      return null;
    }

    function setX(rec, x, instant) {
      rec.x = x;
      if (instant) rec.el.style.transition = 'none';
      rec.el.style.transform = 'translateX(' + Math.round(x) + 'px)';
    }
    function stopWalking(rec) { clearTimeout(rec.walkT); rec.el.classList.remove('is-walking'); rec.el.style.transition = 'none'; rec.walking = false; }
    function walkTo(rec, x) {
      var dist = Math.abs(x - rec.x), secs = Math.max(1.4, dist / (avW * 0.8));
      rec.el.classList.toggle('face-left', x < rec.x);
      rec.el.style.transition = 'transform ' + secs.toFixed(2) + 's ease-in-out';
      rec.el.classList.add('is-walking'); rec.walking = true;
      setX(rec, x);
      clearTimeout(rec.walkT);
      rec.walkT = setTimeout(function () { stopWalking(rec); }, secs * 1000 + 80);
    }

    function place(rec) {
      var spans = freeSpans();
      if (!spans.length) { rec.el.hidden = true; return; }
      rec.el.hidden = false;
      var x = randomIn(spans, rec); if (x === null) x = spans[0][0];
      if (reduced()) { setX(rec, x, true); rec.placed = true; return; }
      // A new guest walks in from the near end of their stretch of floor.
      var k = spanIndex(spans, x), s = spans[Math.max(0, k)];
      rec.placed = true;
      setX(rec, x - s[0] < s[1] - x ? s[0] : s[1], true);
      void rec.el.offsetWidth;
      walkTo(rec, x);
    }

    function layout() {
      if (!visible()) return;
      var any = stage.querySelector('.av'); if (!any) return;
      avW = any.offsetWidth || avW;
      var spans = freeSpans();
      recs.forEach(function (rec) {
        if (!rec.placed) { place(rec); return; }
        if (!spans.length) { rec.el.hidden = true; return; }
        rec.el.hidden = false;
        if (spanIndex(spans, rec.x) < 0) {   // the screen changed under them: step to the nearest free spot
          var best = spans[0][0], gap = Infinity;
          spans.forEach(function (s) { [s[0], s[1]].forEach(function (e) { if (Math.abs(e - rec.x) < gap) { gap = Math.abs(e - rec.x); best = e; } }); });
          stopWalking(rec); setX(rec, best, true);
        }
      });
    }

    // Now and then one guest takes a short stroll. Never while hovered, resting, or while someone else is already walking.
    function stroll() {
      schedule();
      if (!enabled || reduced() || (typeof document !== 'undefined' && document.hidden) || !visible()) return;
      var cands = [], busy = false;
      recs.forEach(function (r) { if (r.walking) busy = true; else if (r.placed && !r.hovered && r.mood !== 'resting') cands.push(r); });
      if (busy || !cands.length) return;
      var rec = cands[Math.floor(Math.random() * cands.length)], spans = freeSpans(), k = spanIndex(spans, rec.x);
      if (k < 0) return;
      for (var t = 0; t < 10; t++) {
        var x = rec.x + (Math.random() < 0.5 ? -1 : 1) * avW * (1.5 + Math.random() * 3.5);
        if (spanIndex(spans, x) !== k || crowded(x, rec)) continue;
        walkTo(rec, Math.max(spans[k][0], Math.min(spans[k][1], x)));
        return;
      }
    }
    function schedule() { clearTimeout(timer); timer = setTimeout(stroll, 8000 + Math.random() * 9000); }

    function placeTip(rec) {
      var tip = rec.tip, avoid = avoidRects(), vw = window.innerWidth, choice = null;
      ['top', 'right', 'left'].forEach(function (p) {
        if (choice) return;
        tip.setAttribute('data-place', p);
        var r = tip.getBoundingClientRect();
        if (r.left >= 8 && r.right <= vw - 8 && r.top >= 8 && !avoid.some(function (a) { return overlaps(r, a, 6); })) choice = p;
      });
      tip.setAttribute('data-place', choice || 'top');
    }

    function fillTip(rec, e, m) {
      var tip = rec.tip; tip.replaceChildren();
      var name = document.createElement('div'); name.className = 'av-tip-name';
      var dot = document.createElement('span'); dot.className = 'av-tip-dot'; dot.style.background = e.color;
      name.appendChild(dot); name.appendChild(document.createTextNode(e.name));
      var feel = document.createElement('div'); feel.className = 'av-tip-mood'; feel.textContent = m.label;
      tip.appendChild(name); tip.appendChild(feel);
      if (e.genres && e.genres.length) {
        var tags = document.createElement('div'); tags.className = 'av-tip-tags';
        e.genres.forEach(function (g) { var t = document.createElement('span'); t.textContent = g; tags.appendChild(t); });
        tip.appendChild(tags);
      }
      var dl = document.createElement('dl'); dl.className = 'av-tip-stats';
      (e.stats || []).forEach(function (row) {
        var dt = document.createElement('dt'), dd = document.createElement('dd');
        dt.textContent = row[0]; dd.textContent = row[1]; dl.appendChild(dt); dl.appendChild(dd);
      });
      tip.appendChild(dl);
    }

    function add(e) {
      var el = document.createElement('div'); el.className = 'av'; el.tabIndex = 0; el.setAttribute('role', 'img');
      el.style.setProperty('--d', (-Math.random() * 4).toFixed(2) + 's');
      var flip = document.createElement('div'); flip.className = 'av-flip'; flip.innerHTML = SVG;   // constant markup, no user text
      var fx = document.createElement('div'); fx.className = 'av-fx'; fx.setAttribute('aria-hidden', 'true');
      fx.innerHTML = '<span class="fx-note n1">♪</span><span class="fx-note n2">♫</span><span class="fx-cloud"><i></i><i></i></span><span class="fx-z z1">z</span><span class="fx-z z2">Z</span>';
      var tip = document.createElement('div'); tip.className = 'av-tip'; tip.setAttribute('aria-hidden', 'true'); tip.setAttribute('data-place', 'top');
      el.appendChild(fx); el.appendChild(flip); el.appendChild(tip);
      var rec = { id: e.id, el: el, tip: tip, x: 0, placed: false, walking: false, hovered: false, mood: '', sig: '' };
      function over() { rec.hovered = true; placeTip(rec); }
      function out() { rec.hovered = false; }
      el.addEventListener('pointerenter', over); el.addEventListener('pointerleave', out);
      el.addEventListener('focus', over); el.addEventListener('blur', out);
      stage.appendChild(el); recs.set(e.id, rec);
      return rec;
    }

    /** entries: [{ id, name, color, genres: [label], stats: [[label, value]], mood: {fit, avg, songs, resting, restLabel} }] */
    function update(entries) {
      var seen = {};
      entries.forEach(function (e) {
        seen[e.id] = true;
        var rec = recs.get(e.id) || add(e), m = mood(e.mood);
        rec.mood = m.key;
        rec.el.setAttribute('data-mood', m.key);
        rec.el.classList.toggle('is-dancing', !!e.dancing);
        rec.el.style.setProperty('--av', e.color);
        rec.el.setAttribute('aria-label', e.name + ': ' + m.label);
        var sig = JSON.stringify([e.name, e.color, e.genres, e.stats, m.label]);
        if (sig !== rec.sig) { rec.sig = sig; fillTip(rec, e, m); }
      });
      recs.forEach(function (rec, id) {
        if (seen[id]) return;
        recs.delete(id); stopWalking(rec);
        rec.el.style.transition = 'opacity .5s ease'; rec.el.style.opacity = '0'; rec.el.style.pointerEvents = 'none';
        setTimeout(function () { rec.el.remove(); }, 600);
      });
      stage.hidden = !enabled || recs.size === 0;
      layout();
    }

    /** Show or hide all the avatars. Guests are still tracked while hidden, so turning it back on is instant. */
    function setEnabled(on) {
      enabled = !!on;
      if (!enabled) recs.forEach(function (rec) { stopWalking(rec); });
      stage.hidden = !enabled || recs.size === 0;
      if (enabled) layout();
    }

    if (typeof window !== 'undefined') {
      var rt = null;
      window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(layout, 150); });
    }
    schedule();
    return { update: update, layout: layout, setEnabled: setEnabled };
  }

  return { mood: mood, create: create, LABELS: LABELS, isWeenArtist: isWeenArtist };
});
