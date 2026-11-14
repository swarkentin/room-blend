// Little animated guests for the TV / cast view: one avatar per listener, standing along the bottom of the screen.
// Their pose follows how the whole night has gone for them (not the song playing this second), they only wander now and then,
// and on a TV, where nobody can hover, each guest's stats pop up on their own in turn.
// Works in the browser (window.Avatars) and in Node (tests, for the mood logic).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Avatars = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LABELS = {
    thrilled: 'Loving the night',
    happy: 'Having a good time',
    meh: 'It is just okay',
    grumpy: 'Not feeling it',
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
   * How a guest is feeling overall: how well the room has served them across the songs they have heard (average fit),
   * not how well the song playing this second suits them. Only before they have heard a whole song does the current fit
   * stand in, so the first song does not leave them blank.
   * input: { fit, avg, songs, resting, restLabel }
   */
  function mood(input) {
    var i = input || {};
    if (i.resting) return { key: 'resting', label: i.restLabel || LABELS.resting, score: null };
    var fit = num(i.fit), avg = num(i.avg), heard = avg !== null && i.songs >= 1;
    var score = heard ? avg : fit;
    var key = score === null ? 'waiting' : score >= 0.72 ? 'thrilled' : score >= 0.5 ? 'happy' : score >= 0.3 ? 'meh' : 'grumpy';
    return { key: key, label: LABELS[key], score: score };
  }

  /** Colour band for a health bar: plenty, getting low, nearly out. */
  function hpTone(hp) { return hp > 50 ? 'ok' : hp > 25 ? 'low' : 'crit'; }

  /**
   * The short line above a fighter's name: what they are doing right now.
   * f is the public duel the server sends the TV; side is "a" (the challenger) or "b".
   */
  function fightStatus(f, side) {
    var me = f[side], r = f.result, rv = f.reveal;
    if (f.phase === 'challenge') return side === 'a' ? 'Challenger' : 'Challenged';
    if (f.phase === 'intro') return 'Ready?';
    if (f.phase === 'pick') return me.locked ? 'Locked in' : me.streak >= 2 ? 'On fire!' : 'Choosing…';
    if (f.phase === 'reveal') return rv && rv.fire === side ? 'On fire!' : rv && rv.underdog === side ? 'Underdog!' : '';
    if (f.phase === 'over') return r && r.winnerId ? (r.winnerId === me.id ? 'Winner!' : r.reason === 'ko' ? 'K.O.' : '') : '';
    return '';
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

  // ----- look: every guest gets their own random accessories, fixed by their id so they look the same all night -----
  var PALETTE = ['#ff5d73', '#ffb020', '#35c2a1', '#5b8cff', '#b46cff', '#ff7ac8', '#f4f4f0', '#2b2f3a'];
  function hash(str) { var h = 2166136261; str = String(str); for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function rng(seed) { var t = seed >>> 0; return function () { t = (t + 0x6D2B79F5) >>> 0; var r = Math.imul(t ^ (t >>> 15), 1 | t); r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r; return ((r ^ (r >>> 14)) >>> 0) / 4294967296; }; }
  var HATS = {
    'top hat': function (a, b) { return '<rect x="20" y="-6" width="20" height="13" rx="1.5" fill="' + a + '"/><rect x="14" y="4" width="32" height="3.6" rx="1.8" fill="' + a + '"/><rect x="20" y="1" width="20" height="3" fill="' + b + '"/>'; },
    'party hat': function (a, b) { return '<path d="M30 -10 L40 6.5 Q30 9.5 20 6.5 Z" fill="' + a + '"/><path d="M23.5 1.5 L36.5 1.5" stroke="' + b + '" stroke-width="1.8"/><circle cx="30" cy="-10" r="2.5" fill="' + b + '"/>'; },
    'beanie': function (a, b) { return '<path d="M15.5 10 Q15 -1 30 -1 Q45 -1 44.5 10 Z" fill="' + a + '"/><rect x="14.5" y="8" width="31" height="4.6" rx="2.3" fill="' + b + '"/><circle cx="30" cy="-2.5" r="3.2" fill="' + b + '"/>'; },
    'cowboy hat': function (a, b) { return '<ellipse cx="30" cy="6.5" rx="22" ry="3.6" fill="' + a + '"/><path d="M21 6 Q21 -4 30 -4 Q39 -4 39 6 Z" fill="' + a + '"/><rect x="21" y="2.8" width="18" height="2.4" fill="' + b + '"/>'; },
    'propeller cap': function (a, b) { return '<path d="M16.5 9 Q30 -3 43.5 9 Z" fill="' + a + '"/><rect x="29" y="-4" width="2" height="6" fill="#333"/><path class="av-prop" d="M19 -5 Q30 -9 41 -5 Q30 -3 19 -5 Z" fill="' + b + '"/>'; },
    'crown': function () { return '<path d="M17 8 L19 -2 L24 4 L30 -4.5 L36 4 L41 -2 L43 8 Z" fill="#ffcf3a" stroke="#c99700" stroke-width="1"/><circle cx="30" cy="3" r="1.8" fill="#ff5d73"/>'; },
    'chef hat': function () { return '<g fill="#fff" stroke="#cfd6e2" stroke-width=".8"><circle cx="21" cy="0" r="6"/><circle cx="30" cy="-3.5" r="7"/><circle cx="39" cy="0" r="6"/><rect x="19" y="2" width="22" height="6" rx="1"/></g>'; },
    'traffic cone': function () { return '<path d="M30 -10 L39 7 H21 Z" fill="#ff7a1a"/><path d="M25.8 0 H34.2" stroke="#fff" stroke-width="2.2"/><rect x="18" y="6" width="24" height="2.8" rx="1.4" fill="#ff7a1a"/>'; },
  };
  var FACES = {
    'sunglasses': function () { return '<rect x="18.2" y="14.8" width="10.6" height="7.2" rx="3" fill="#10131a"/><rect x="31.2" y="14.8" width="10.6" height="7.2" rx="3" fill="#10131a"/><path d="M28.8 17.4 H31.2" stroke="#10131a" stroke-width="1.5"/><path d="M20.5 17 L23 16.2" stroke="#fff" stroke-opacity=".5" stroke-width="1"/>'; },
    'round glasses': function (a) { return '<g fill="none" stroke="' + a + '" stroke-width="1.5"><circle cx="24.5" cy="19" r="5"/><circle cx="35.5" cy="19" r="5"/><path d="M29.5 18.6 H30.5"/></g>'; },
    'moustache': function () { return '<path d="M21.5 24.8 Q26 21.5 30 24.6 Q34 21.5 38.5 24.8 Q34.5 28.2 30 26 Q25.5 28.2 21.5 24.8 Z" fill="#3b2a20"/>'; },
    'monocle': function () { return '<circle cx="35.5" cy="19" r="5.4" fill="none" stroke="#e0b030" stroke-width="1.4"/><path d="M40.5 21.5 Q44 30 41 40" fill="none" stroke="#e0b030" stroke-width=".9"/>'; },
    'eyepatch': function () { return '<path d="M16 11.5 L44 26" stroke="#10131a" stroke-width="1.2"/><ellipse cx="24.5" cy="19" rx="4.6" ry="4" fill="#10131a"/>'; },
    'clown nose': function () { return '<circle cx="30" cy="22.5" r="3.2" fill="#ff3b3b"/><circle cx="29" cy="21.5" r="1" fill="#fff" fill-opacity=".6"/>'; },
  };
  var NECKS = {
    'bow tie': function (a, b) { return '<path d="M30 34.5 L22.5 30.5 V38.5 Z M30 34.5 L37.5 30.5 V38.5 Z" fill="' + a + '"/><circle cx="30" cy="34.5" r="2" fill="' + b + '"/>'; },
    'necktie': function (a) { return '<path d="M28 33 H32 L33.4 36.5 L30 53 L26.6 36.5 Z" fill="' + a + '"/>'; },
    'scarf': function (a, b) { return '<rect x="15" y="31" width="30" height="6.4" rx="3.2" fill="' + a + '"/><rect x="35" y="34" width="5.4" height="15" rx="2.7" fill="' + a + '"/><path d="M36.5 41 H39 M36.5 45 H39" stroke="' + b + '" stroke-width="1.4"/>'; },
    'medal': function (a) { return '<path d="M25.5 31.5 L30 39 L34.5 31.5" fill="none" stroke="' + a + '" stroke-width="2"/><circle cx="30" cy="42" r="3.6" fill="#ffcf3a" stroke="#c99700" stroke-width=".9"/>'; },
  };
  // Legs: each leg is a group so the walking and dancing animations (on .av-leg-l / .av-leg-r) move the trousers with it.
  var LEGS = {
    'bare': function (side) { return '<rect class="av-limb" x="' + side.x + '" y="52" width="7.5" height="26" rx="3.75"/>'; },
    'baggy jeans': function (side) { return '<rect x="' + (side.x - 3.2) + '" y="52" width="13.9" height="27" rx="4.5" fill="#3f5f9a"/><rect x="' + (side.x - 3.2) + '" y="74.5" width="13.9" height="4.5" rx="2" fill="#2f4a7c"/><path d="M' + (side.x + 3.75) + ' 56 V70" stroke="#5878b4" stroke-width="1" stroke-opacity=".7"/>'; },
    'shorts': function (side, a) { return '<rect class="av-limb" x="' + side.x + '" y="52" width="7.5" height="26" rx="3.75"/><rect x="' + (side.x - 1.6) + '" y="51" width="10.7" height="13" rx="3" fill="' + a + '"/>'; },
    'odd socks': function (side, a, b) { return '<rect class="av-limb" x="' + side.x + '" y="52" width="7.5" height="26" rx="3.75"/><rect x="' + (side.x - .3) + '" y="68" width="8.1" height="10" rx="2.5" fill="' + (side.left ? a : b) + '"/><path d="M' + (side.x - .3) + ' 71 H' + (side.x + 7.8) + '" stroke="#fff" stroke-opacity=".7" stroke-width="1.2"/>'; },
  };
  function pickFrom(r, obj) { var k = Object.keys(obj); return k[Math.floor(r() * k.length)]; }
  /** A guest's random look, fixed by their id: { hat, face, neck, legs, colors } (a missing piece is null). */
  function outfitFor(id) {
    var r = rng(hash('look:' + id)), col = function () { return PALETTE[Math.floor(r() * PALETTE.length)]; };
    var o = { hat: r() < 0.8 ? pickFrom(r, HATS) : null, face: r() < 0.5 ? pickFrom(r, FACES) : null, neck: r() < 0.4 ? pickFrom(r, NECKS) : null, legs: pickFrom(r, LEGS), colors: [col(), col()] };
    if (o.colors[0] === o.colors[1]) o.colors[1] = PALETTE[(PALETTE.indexOf(o.colors[0]) + 3) % PALETTE.length];
    return o;
  }
  function svgFor(o) {
    var a = o.colors[0], b = o.colors[1];
    var leg = function (cls, side) { return '<g class="av-leg ' + cls + '">' + LEGS[o.legs](side, a, b) + '</g>'; };
    return '<svg viewBox="0 0 60 84" aria-hidden="true" focusable="false">' +
    '<ellipse class="av-shadow" cx="30" cy="80" rx="16" ry="3.2"/>' +
    '<g class="av-legs">' + leg('av-leg-l', { x: 21, left: true }) + leg('av-leg-r', { x: 31.5, left: false }) + '</g>' +
    '<g class="av-figure">' +
      '<rect class="av-torso" x="16" y="32" width="28" height="28" rx="12"/>' +
      (o.neck ? '<g class="av-acc av-neck">' + NECKS[o.neck](a, b) + '</g>' : '') +
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
        (o.face ? '<g class="av-acc av-face-acc">' + FACES[o.face](a, b) + '</g>' : '') +
        '<path class="av-phones-band" d="M14.2 19 C14.2 3 45.8 3 45.8 19"/>' +
        '<rect class="av-phones-pad" x="11" y="15.5" width="6" height="11" rx="3"/><rect class="av-phones-pad" x="43" y="15.5" width="6" height="11" rx="3"/>' +
        (o.hat ? '<g class="av-acc av-hat">' + HATS[o.hat](a, b) + '</g>' : '') +
      '</g>' +
    '</g></svg>';
  }

  // ----- mood over the night: a tiny line of how happy the guest has been after each song -----
  function trendPath(trail, w, h) {
    var n = trail.length, pts = [];
    for (var i = 0; i < n; i++) { var v = Math.max(0, Math.min(1, +trail[i] || 0)); pts.push([n === 1 ? w / 2 : (i / (n - 1)) * w, h - 1.5 - v * (h - 3)]); }
    return pts;
  }
  /** SVG markup for a trail of 0..1 scores (numbers only, so it is safe to inject). */
  function trendSVG(trail, w, h) {
    if (!trail || trail.length < 2) return '';
    var pts = trendPath(trail, w, h), last = pts[pts.length - 1];
    return '<svg class="av-trend-svg" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" aria-hidden="true" focusable="false">' +
      '<line class="tr-mid" x1="0" x2="' + w + '" y1="' + (h / 2).toFixed(1) + '" y2="' + (h / 2).toFixed(1) + '"/>' +
      '<polyline class="tr-line" fill="none" points="' + pts.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ') + '"/>' +
      '<circle class="tr-dot" cx="' + last[0].toFixed(1) + '" cy="' + last[1].toFixed(1) + '" r="2.4"/></svg>';
  }
  /** Which way the night is going for a guest: up, down or steady, from their last few scores. */
  function trendDir(trail) {
    if (!trail || trail.length < 3) return 'steady';
    var k = Math.min(3, trail.length - 1), d = trail[trail.length - 1] - trail[trail.length - 1 - k];
    return d > 0.06 ? 'up' : d < -0.06 ? 'down' : 'steady';
  }

  function create(stage, opts) {
    opts = opts || {};
    var recs = new Map(), timer = null, avW = 0, enabled = opts.enabled !== false, fight = null;
    var spotT = null, spotRec = null, spotNext = 0;   // the guest whose card is showing on its own, and who is next

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
    function stopWalking(rec) {
      clearTimeout(rec.walkT); rec.el.classList.remove('is-walking'); rec.el.style.transition = 'none'; rec.walking = false;
      if (rec.faceAfter === true || rec.faceAfter === false) rec.el.classList.toggle('face-left', rec.faceAfter);   // a fighter ends the walk facing the other one
    }
    // fast: a fighter running to the ring or back, instead of a guest's easy stroll
    function walkTo(rec, x, fast) {
      var dist = Math.abs(x - rec.x), secs = fast ? Math.min(2.2, Math.max(0.9, dist / (avW * 3))) : Math.max(1.4, dist / (avW * 0.8));
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
        if (rec.fighting) return;   // the ring is theirs for now
        if (!spans.length) { rec.el.hidden = true; return; }
        rec.el.hidden = false;
        if (spanIndex(spans, rec.x) < 0) {   // the screen changed under them: step to the nearest free spot
          var best = spans[0][0], gap = Infinity;
          spans.forEach(function (s) { [s[0], s[1]].forEach(function (e) { if (Math.abs(e - rec.x) < gap) { gap = Math.abs(e - rec.x); best = e; } }); });
          stopWalking(rec); setX(rec, best, true);
        }
      });
      applyFight();
    }

    // On a TV nobody can hover, so each guest's card (mood, tags, stats) appears on its own, one guest at a time, in turn:
    // a few seconds on, a short pause, the next guest. Never during a duel, or while a hovering mouse already shows one.
    function hideSpot() { if (spotRec) { spotRec.el.classList.remove('is-spot'); spotRec = null; } }
    function spotlight() {
      clearTimeout(spotT);
      hideSpot();
      var show = opts.spotlight !== false ? opts.spotlightMs || 6500 : 0, gap = opts.spotlightGapMs || 4500;
      if (!show) return;
      var ok = enabled && !fight && visible() && !(typeof document !== 'undefined' && document.hidden);
      var list = [];
      recs.forEach(function (r) { if (r.placed && !r.hovered && !r.fighting) list.push(r); });
      if (!ok || !list.length) { spotT = setTimeout(spotlight, 2000); return; }
      var rec = list[spotNext++ % list.length];
      rec.el.classList.add('is-spot'); spotRec = rec; placeTip(rec);
      spotT = setTimeout(function () { hideSpot(); spotT = setTimeout(spotlight, gap); }, show);
    }

    // Now and then one guest takes a short stroll. Never while hovered, resting, or while someone else is already walking.
    function stroll() {
      schedule();
      if (!enabled || fight || reduced() || (typeof document !== 'undefined' && document.hidden) || !visible()) return;
      var cands = [], busy = false;
      recs.forEach(function (r) { if (r.walking) busy = true; else if (r.placed && !r.hovered && r.mood !== 'resting' && !r.dancing) cands.push(r); });
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
      var tr = e.mood && e.mood.trail;
      if (tr && tr.length >= 2) {
        var box = document.createElement('div'); box.className = 'av-tip-trend'; box.setAttribute('data-trend', trendDir(tr));
        box.innerHTML = trendSVG(tr, 120, 34);   // numbers only
        var cap = document.createElement('div'); cap.className = 'av-tip-trend-label';
        cap.textContent = { up: 'Getting happier', down: 'Cooling off', steady: 'Steady mood' }[trendDir(tr)] + ' · ' + tr.length + ' songs';
        box.appendChild(cap); tip.appendChild(box);
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
      var flip = document.createElement('div'); flip.className = 'av-flip'; var look = outfitFor(e.id); flip.innerHTML = svgFor(look);   // markup built from constants only, no user text
      el.setAttribute('data-look', [look.hat, look.face, look.neck, look.legs].filter(Boolean).join(', '));
      if (look.hat) el.classList.add('has-hat');   // the name tag rides higher so tall hats do not cover it
      var fx = document.createElement('div'); fx.className = 'av-fx'; fx.setAttribute('aria-hidden', 'true');
      fx.innerHTML = '<span class="fx-note n1">♪</span><span class="fx-note n2">♫</span><span class="fx-cloud"><i></i><i></i></span><span class="fx-z z1">z</span><span class="fx-z z2">Z</span>';
      var tip = document.createElement('div'); tip.className = 'av-tip'; tip.setAttribute('aria-hidden', 'true'); tip.setAttribute('data-place', 'top');
      // Above the head: what they are doing (during a duel), their name, and (during a duel) their health. User text goes in with textContent only.
      var hud = document.createElement('div'); hud.className = 'av-hud'; hud.setAttribute('aria-hidden', 'true');
      var statusEl = document.createElement('div'); statusEl.className = 'av-status';
      var nameEl = document.createElement('div'); nameEl.className = 'av-name';
      var hp = document.createElement('div'); hp.className = 'av-hp'; hp.setAttribute('data-tone', 'ok');
      var hpFill = document.createElement('i'), hpNum = document.createElement('b'); hp.appendChild(hpFill); hp.appendChild(hpNum);
      var trend = document.createElement('div'); trend.className = 'av-trend';   // happiness over the night, always showing once there are two songs
      hud.appendChild(statusEl); hud.appendChild(nameEl); hud.appendChild(trend); hud.appendChild(hp);
      el.appendChild(fx); el.appendChild(flip); el.appendChild(hud); el.appendChild(tip);
      var rec = { id: e.id, el: el, tip: tip, x: 0, placed: false, walking: false, hovered: false, mood: '', dancing: false, sig: '',
        nameEl: nameEl, nameText: '', trend: trend, trendSig: '', statusEl: statusEl, hp: hp, hpFill: hpFill, hpNum: hpNum,
        fighting: false, inRing: false, faceAfter: null, lastRound: 0, moveT: null };
      function over() { rec.hovered = true; placeTip(rec); }
      function out() { rec.hovered = false; }
      el.addEventListener('pointerenter', over); el.addEventListener('pointerleave', out);
      el.addEventListener('focus', over); el.addEventListener('blur', out);
      stage.appendChild(el); recs.set(e.id, rec);
      return rec;
    }

    // ----- duels -----
    // The two fighters walk to the middle of the floor, grow a little, and show their health. Everyone else cheers.
    function ringSpots() {
      var w = stage.getBoundingClientRect().width, gap = avW * 3.2, mid = w / 2;
      return { a: Math.max(0, mid - gap / 2 - avW / 2), b: Math.min(Math.max(0, w - avW), mid + gap / 2 - avW / 2) };
    }
    function clearMove(rec) {
      clearTimeout(rec.moveT);
      rec.el.classList.remove('mv-strike', 'mv-feint', 'mv-guard', 'is-hit', 'is-fire');
    }
    function release(rec) {   // a fighter goes back to the floor
      var wasInRing = rec.inRing;
      clearMove(rec);
      rec.fighting = false; rec.inRing = false; rec.lastRound = 0; rec.faceAfter = null;
      rec.el.classList.remove('is-fighting', 'in-ring', 'is-win', 'is-ko', 'is-lose');
      rec.statusEl.textContent = '';
      if (!wasInRing) return;
      var spans = freeSpans();
      if (!spans.length) return;
      var x = randomIn(spans, rec); if (x === null) x = spans[0][0];
      if (reduced()) setX(rec, x, true); else walkTo(rec, x, true);
    }
    function pop(rec, delta) {   // a number floating up from the fighter's head
      if (!delta) return;
      var p = document.createElement('span'); p.className = 'av-pop ' + (delta < 0 ? 'is-dmg' : 'is-heal');
      p.textContent = (delta > 0 ? '+' : '−') + Math.abs(delta);
      rec.el.appendChild(p); setTimeout(function () { p.remove(); }, 1700);
    }
    function applyFight() {
      if (!visible()) return;
      var any = stage.querySelector('.av'); if (any) avW = any.offsetWidth || avW;
      var f = fight;
      var ring = !!f && (f.phase === 'intro' || f.phase === 'pick' || f.phase === 'reveal' || (f.phase === 'over' && !!(f.result && f.result.winnerId)));
      var spots = f ? ringSpots() : null;
      recs.forEach(function (rec, id) {
        var side = f ? (id === f.a.id ? 'a' : id === f.b.id ? 'b' : null) : null;
        rec.el.classList.toggle('is-cheering', !!f && !side && ring);
        if (!side) { if (rec.fighting) release(rec); return; }
        if (!rec.fighting) { rec.fighting = true; stopWalking(rec); rec.el.classList.add('is-fighting'); }
        if (rec.fightId !== f.id) { rec.fightId = f.id; rec.lastRound = 0; }   // a new duel: its rounds count from 1 again
        if (!ring && rec.inRing) { release(rec); rec.fighting = true; rec.el.classList.add('is-fighting'); }
        if (ring && !rec.inRing) {
          rec.inRing = true; rec.faceAfter = side === 'b';
          rec.el.classList.add('in-ring');
          if (reduced()) { setX(rec, spots[side], true); stopWalking(rec); } else walkTo(rec, spots[side], true);
        }
        var me = f[side], won = f.phase === 'over' && f.result && f.result.winnerId;
        rec.hpFill.style.width = Math.max(0, Math.min(100, me.hp)) + '%';
        rec.hpNum.textContent = String(Math.round(me.hp));
        rec.hp.setAttribute('data-tone', hpTone(me.hp));
        rec.statusEl.textContent = fightStatus(f, side);
        rec.el.classList.toggle('is-win', !!won && f.result.winnerId === me.id);
        rec.el.classList.toggle('is-ko', !!won && f.result.winnerId !== me.id && f.result.reason === 'ko');
        rec.el.classList.toggle('is-lose', !!won && f.result.winnerId !== me.id && f.result.reason !== 'ko');
        var rv = f.phase === 'reveal' ? f.reveal : null;
        if (rv && rec.lastRound !== rv.round) {   // each round's reveal plays once
          rec.lastRound = rv.round;
          clearMove(rec);
          rec.el.classList.add('mv-' + rv[side]);
          if (rv.delta[side] < 0) rec.el.classList.add('is-hit');
          if (rv.fire === side) rec.el.classList.add('is-fire');
          pop(rec, rv.delta[side]);
          rec.moveT = setTimeout(function () { clearMove(rec); }, 2200);
        }
      });
    }
    /** The public duel the server sends the TV, or null when there is none. */
    function setFight(f) { fight = f || null; applyFight(); }

    /** entries: [{ id, name, color, requesting, genres: [label], stats: [[label, value]], mood: {fit, avg, songs, resting, restLabel} }] */
    function update(entries) {
      var seen = {};
      entries.forEach(function (e) {
        seen[e.id] = true;
        var rec = recs.get(e.id) || add(e), m = mood(e.mood);
        rec.mood = m.key;
        if (rec.nameText !== e.name) { rec.nameText = e.name; rec.nameEl.textContent = e.name; }
        rec.el.classList.toggle('has-req', !!e.requesting);   // a song is waiting: this guest can duel for it
        rec.el.setAttribute('data-mood', m.key);
        rec.dancing = !!e.dancing;
        rec.el.classList.toggle('is-dancing', rec.dancing);
        if (rec.dancing && rec.walking) stopWalking(rec);
        rec.el.style.setProperty('--av', e.color);
        rec.el.setAttribute('aria-label', e.name + ': ' + m.label);
        var trail = e.mood && e.mood.trail || [], tsig = trail.join(',');
        if (tsig !== rec.trendSig) { rec.trendSig = tsig; rec.trend.innerHTML = trendSVG(trail, 100, 22); rec.el.setAttribute('data-trend', trendDir(trail)); }
        var sig = JSON.stringify([e.name, e.color, e.genres, e.stats, m.label, trail]);
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
    spotT = setTimeout(spotlight, opts.spotlightFirstMs || 5000);
    return { update: update, layout: layout, setEnabled: setEnabled, setFight: setFight, spotlight: spotlight };
  }

  return { mood: mood, outfitFor: outfitFor, svgFor: svgFor, trendSVG: trendSVG, trendDir: trendDir, LOOKS: { hats: Object.keys(HATS), faces: Object.keys(FACES), necks: Object.keys(NECKS), legs: Object.keys(LEGS) }, create: create, LABELS: LABELS, isWeenArtist: isWeenArtist, hpTone: hpTone, fightStatus: fightStatus };
});
