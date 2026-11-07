// Duels, on screen. Two parts:
//   createTV(...)    the big-screen overlay (cast view): who is fighting, the round clock, Chaos Cards, the move reveal, the result.
//   createPhone(...) a guest's panel: who they can challenge, their allowance, answering a challenge, and picking moves.
// The server decides everything (lib/fight.js, lib/room.js); this only draws what it is told and sends the guest's choices.
// The sentences are made by pure functions (tvLines, phoneLines) so they can be tested in Node.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FightUI = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MOVES = [
    { key: 'strike', label: 'Strike', beats: 'Feint' },
    { key: 'feint', label: 'Feint', beats: 'Guard' },
    { key: 'guard', label: 'Guard', beats: 'Strike' },
  ];
  var LABEL = { strike: 'Strike', feint: 'Feint', guard: 'Guard' };
  var WHEEL = 'Strike beats Feint. Feint beats Guard. Guard beats Strike.';
  // Constant markup (no user text): a starburst, a fake-out swoosh and a shield.
  var ICONS = {
    strike: '<svg viewBox="0 0 48 48" aria-hidden="true" focusable="false"><path d="M24 3l5.5 13L44 14l-9.5 11L43 36.5 28.5 34 24 46l-4.5-12L5 36.5 13.5 25 4 14l14.5 2z"/></svg>',
    feint: '<svg viewBox="0 0 48 48" aria-hidden="true" focusable="false"><path d="M7 33C11 15 29 9 38 19l5-5 1 16-16-2 5-5C25 17 17 21 14 34z"/></svg>',
    guard: '<svg viewBox="0 0 48 48" aria-hidden="true" focusable="false"><path d="M24 3.5l16 6V23c0 10-7 17-16 21.5C15 40 8 33 8 23V9.5z"/><path class="ic-cut" d="M24 12v26M14 20h20"/></svg>',
  };

  function clock(ms) {
    var s = Math.max(0, Math.ceil(ms / 1000));
    return Math.floor(s / 60) + ':' + (s % 60 < 10 ? '0' : '') + (s % 60);
  }
  function places(n) { return n === 1 ? 'a place' : n + ' places'; }
  function away(n) { return 'about ' + n + (n === 1 ? ' song' : ' songs') + ' away'; }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;   // names and song titles are guest text: textContent only
    return e;
  }

  /** What the big screen says, for the duel the server sent. */
  function tvLines(f) {
    var a = f.a.name, b = f.b.name, r = f.result, rv = f.reveal;
    if (f.phase === 'challenge') return { head: a + ' challenges ' + b + '!', sub: 'The winner’s song moves up the list. Waiting for ' + b + '…' };
    if (f.phase === 'intro') return { head: 'FIGHT!', sub: WHEEL };
    if (f.phase === 'pick') return { head: f.sudden ? 'Sudden death!' : 'Round ' + f.round, sub: 'Pick your move on your phone.' };
    if (f.phase === 'reveal' && rv) {
      if (rv.outcome === 'draw') return { head: 'CLASH!', sub: rv.text };
      return { head: (rv.outcome === 'a' ? a : b) + ' wins the round!', sub: rv.text };
    }
    if (f.phase === 'over' && r) {
      if (!r.winnerId) return { head: r.text, sub: '' };
      var w = r.winnerId === f.a.id ? a : b, bump = r.bump;
      var moved = bump && bump.places ? '“' + bump.title + '” moves up ' + places(bump.places) + ', now ' + away(bump.to) + '.' : 'Their song is already as high as it can go.';
      return {
        head: (r.reason === 'ko' ? 'K.O.! ' : '') + w + ' wins!',
        sub: (r.reason === 'forfeit' || r.reason === 'coin' ? r.text + ' ' : '') + moved + (r.flawless ? ' Flawless victory!' : ''),
      };
    }
    return { head: '', sub: '' };
  }

  /** What one phone says. f is the guest's view of the duel ({...public duel, you: "a"|"b"|null, picked}). */
  function phoneLines(l) {
    var you = l.you;
    if (!you) return { head: l.a.name + ' vs ' + l.b.name, sub: 'A duel is on the big screen.' };
    var me = l[you], foe = l[you === 'a' ? 'b' : 'a'], other = you === 'a' ? 'b' : 'a', rv = l.reveal, r = l.result;
    if (l.phase === 'challenge') return you === 'a'
      ? { head: 'Waiting for ' + foe.name + '…', sub: 'They have a few seconds to answer.' }
      : { head: foe.name + ' challenges you!', sub: 'Win, and your song moves up the line.' };
    if (l.phase === 'intro') return { head: 'Get ready!', sub: 'Pick a move when the round opens.' };
    if (l.phase === 'pick') return l.picked
      ? { head: 'Locked in: ' + LABEL[l.picked], sub: 'Waiting for ' + foe.name + '…' }
      : { head: l.sudden ? 'Sudden death! Pick!' : 'Round ' + l.round + '. Pick your move!', sub: WHEEL };
    if (l.phase === 'reveal' && rv) {
      var d = rv.delta[you];
      return {
        head: rv.outcome === 'draw' ? 'Clash!' : rv.outcome === you ? 'You won the round!' : foe.name + ' won the round.',
        sub: 'You played ' + LABEL[rv[you]] + '. ' + foe.name + ' played ' + LABEL[rv[other]] + '.' + (d < 0 ? ' You take ' + (-d) + '.' : d > 0 ? ' You heal ' + d + '.' : ''),
      };
    }
    if (l.phase === 'over' && r) {
      if (!r.winnerId) return { head: r.text, sub: '' };
      if (r.winnerId === me.id) return { head: 'You won!', sub: r.bump && r.bump.places ? 'Your song moves up ' + places(r.bump.places) + ', now ' + away(r.bump.to) + '.' : 'Your song is already as high as it can go.' };
      return { head: foe.name + ' won this one.', sub: 'Your song stays in the line.' };
    }
    return { head: '', sub: '' };
  }

  // ======================= the big screen =======================
  /**
   * opts.avatars  the avatar stage (public/avatars.js), told about the duel so the fighters walk to the ring
   * opts.view     the cast view element, which gets class "has-fight" while a duel is on
   * opts.color    guest color index -> CSS color
   * opts.avatarsVisible  are the avatars (and their health bars) on screen? If not, the strip shows the bars itself.
   */
  function createTV(rootEl, opts) {
    opts = opts || {};
    var cur = null, recvAt = 0, lastSig = '', timer = null, active = false;
    rootEl.hidden = true;
    rootEl.className = 'tvf';
    rootEl.setAttribute('role', 'status'); rootEl.setAttribute('aria-live', 'polite');

    function fighterCell(cls) {
      var cell = el('div', 'tvf-fighter ' + cls);
      var name = el('div', 'tvf-fname'), song = el('div', 'tvf-fsong'), state = el('div', 'tvf-fstate');
      var bar = el('div', 'tvf-fhp'), fill = el('i'), num = el('b'); bar.appendChild(fill); bar.appendChild(num);
      cell.appendChild(name); cell.appendChild(song); cell.appendChild(state); cell.appendChild(bar);
      return { cell: cell, name: name, song: song, state: state, bar: bar, fill: fill, num: num };
    }
    var A = fighterCell('is-a'), B = fighterCell('is-b');
    var mid = el('div', 'tvf-mid'), chip = el('div', 'tvf-chip'), clockBar = el('div', 'tvf-clock'), clockFill = el('i');
    clockBar.appendChild(clockFill); mid.appendChild(chip); mid.appendChild(clockBar);
    var strip = el('div', 'tvf-strip'); strip.appendChild(A.cell); strip.appendChild(mid); strip.appendChild(B.cell);

    var chaos = el('div', 'tvf-chaos'), chaosKicker = el('div', 'tvf-chaos-kicker', 'CHAOS CARD'), chaosTitle = el('div', 'tvf-chaos-title'), chaosText = el('div', 'tvf-chaos-text');
    chaos.appendChild(chaosKicker); chaos.appendChild(chaosTitle); chaos.appendChild(chaosText);
    var head = el('div', 'tvf-head'), sub = el('div', 'tvf-sub');
    function moveCard(cls) {
      var c = el('div', 'tvf-move ' + cls), icon = el('span', 'tvf-move-icon'), label = el('span', 'tvf-move-label'), who = el('span', 'tvf-move-who');
      c.appendChild(icon); c.appendChild(label); c.appendChild(who);
      return { c: c, icon: icon, label: label, who: who };
    }
    var MA = moveCard('is-a'), MB = moveCard('is-b');
    var moves = el('div', 'tvf-moves'); moves.appendChild(MA.c); moves.appendChild(MB.c);
    var center = el('div', 'tvf-center'); center.appendChild(chaos); center.appendChild(head); center.appendChild(sub); center.appendChild(moves);
    rootEl.appendChild(strip); rootEl.appendChild(center);

    function paint(cell, side, f, colorIdx) {
      var s = f[side];
      cell.cell.style.setProperty('--fc', opts.color ? opts.color(colorIdx) : '#7c9cff');
      cell.name.textContent = s.name;
      cell.song.textContent = s.song ? '♪ ' + s.song.title : '';
      cell.song.title = s.song ? s.song.title + ' — ' + s.song.artist : '';
      cell.state.textContent = f.phase === 'pick' ? (s.locked ? 'Locked in' : 'Choosing…') : '';
      cell.fill.style.width = Math.max(0, Math.min(100, s.hp)) + '%';
      cell.num.textContent = String(Math.round(s.hp));
      cell.bar.setAttribute('data-tone', s.hp > 50 ? 'ok' : s.hp > 25 ? 'low' : 'crit');
    }

    function render(f) {
      rootEl.hidden = false;
      rootEl.setAttribute('data-phase', f.phase);
      rootEl.classList.toggle('no-avatars', !(opts.avatarsVisible && opts.avatarsVisible()));
      paint(A, 'a', f, f.a.color); paint(B, 'b', f, f.b.color);
      chip.textContent = f.phase === 'challenge' ? 'DUEL' : f.sudden ? 'SUDDEN DEATH' : 'ROUND ' + Math.max(1, f.round) + ' / ' + f.maxRounds;
      var t = tvLines(f);
      head.textContent = t.head; sub.textContent = t.sub;
      head.className = 'tvf-head' + (f.phase === 'intro' ? ' is-fight' : '') + (f.phase === 'over' && f.result && f.result.winnerId ? ' is-win' : '');
      var showChaos = !!f.chaos && (f.phase === 'pick' || f.phase === 'reveal');
      chaos.hidden = !showChaos;
      if (showChaos) { chaosTitle.textContent = f.chaos.title; chaosText.textContent = f.chaos.text; }
      var rv = f.reveal, showMoves = f.phase === 'reveal' && !!rv;
      moves.hidden = !showMoves;
      if (showMoves) {
        [[MA, 'a'], [MB, 'b']].forEach(function (p) {
          var m = rv[p[1]], d = rv.delta[p[1]];
          p[0].icon.innerHTML = ICONS[m]; p[0].label.textContent = LABEL[m];   // ICONS are constant markup
          p[0].who.textContent = f[p[1]].name + (d ? '  ' + (d > 0 ? '+' : '−') + Math.abs(d) : '');
          p[0].c.className = 'tvf-move is-' + p[1] + (rv.outcome === p[1] ? ' is-winner' : rv.outcome === 'draw' ? ' is-draw' : ' is-loser');
        });
      }
    }

    function tick() {
      if (!cur) return;
      var left = Math.max(0, cur.leftMs - (Date.now() - recvAt));
      clockFill.style.width = (cur.phase === 'over' ? 0 : Math.min(100, left / Math.max(1, cur.phaseMs) * 100)) + '%';
    }
    function start() { if (!timer) timer = setInterval(tick, 100); }
    function stop() { if (timer) { clearInterval(timer); timer = null; } }

    /** Call with every update from the server: the public duel, or null. */
    function update(f) {
      if (!f) {
        if (active) {
          active = false; cur = null; lastSig = ''; rootEl.hidden = true; stop();
          if (opts.view) opts.view.classList.remove('has-fight');
          if (opts.avatars) opts.avatars.setFight(null);
        }
        return;
      }
      active = true; cur = f; recvAt = Date.now();
      var sig = [f.id, f.phase, f.round, f.a.hp, f.b.hp, f.a.locked, f.b.locked, f.chaos && f.chaos.key, f.result ? 1 : 0, opts.avatarsVisible && opts.avatarsVisible() ? 1 : 0].join('|');
      if (sig !== lastSig) { lastSig = sig; render(f); }
      start(); tick();
      if (opts.view) opts.view.classList.add('has-fight');
      if (opts.avatars) opts.avatars.setFight(f);
    }
    return { update: update };
  }

  // ======================= a guest's phone =======================
  /**
   * rootEl is an empty <section>. opts.post(action, body) sends a duel action ("challenge", "respond", "pick")
   * and resolves to {ok, status, data}. opts.color maps a guest color index to a CSS color.
   */
  function createPhone(rootEl, opts) {
    opts = opts || {};
    var fs = null, recvAt = 0, picking = '', answering = false, rosterSig = '', liveKey = '', seenDuel = '', msgT = null, timer = null;

    rootEl.className = 'panel duel-panel'; rootEl.hidden = true;
    var title = el('h2', null, 'Duels'), quota = el('span', 'meta');
    var headRow = el('div', 'sec-h'); headRow.appendChild(title); headRow.appendChild(quota);
    var intro = el('p', 'hint', 'Challenge a guest who has a song waiting. Win, and your song moves up the line by 2 to 4 places. Lose, and you keep your song in the line.');
    var notReady = el('p', 'hint duel-notready');

    var roster = el('ul', 'duel-roster'), msg = el('p', 'hint duel-msg'); msg.setAttribute('role', 'status');

    // A challenge for you.
    var incoming = el('div', 'duel-card duel-incoming'); incoming.hidden = true;
    var inHead = el('div', 'duel-head'), inSub = el('div', 'duel-sub'), inClock = el('div', 'duel-clock');
    var inBtns = el('div', 'duel-btns');
    var accept = el('button', 'btn primary', 'Accept'), decline = el('button', 'btn', 'Decline');
    accept.type = 'button'; decline.type = 'button';
    inBtns.appendChild(accept); inBtns.appendChild(decline);
    incoming.appendChild(inHead); incoming.appendChild(inSub); incoming.appendChild(inClock); incoming.appendChild(inBtns);

    // The duel you are in, or the one you are watching.
    var live = el('div', 'duel-card duel-live'); live.hidden = true;
    var liveChip = el('div', 'duel-chip'), liveBar = el('div', 'duel-timer'), liveFill = el('i'); liveBar.appendChild(liveFill);
    function hpRow(cls) {
      var r = el('div', 'duel-hp ' + cls), n = el('span', 'duel-hp-name'), bar = el('div', 'duel-hp-bar'), f = el('i'), v = el('b');
      bar.appendChild(f); r.appendChild(n); r.appendChild(bar); r.appendChild(v);
      return { r: r, n: n, f: f, v: v, bar: bar };
    }
    var meHp = hpRow('is-me'), foeHp = hpRow('is-foe');
    var chaos = el('div', 'duel-chaos'), chaosT = el('strong'), chaosX = el('span'); chaos.appendChild(chaosT); chaos.appendChild(chaosX); chaos.hidden = true;
    var liveHead = el('div', 'duel-head'), liveSub = el('div', 'duel-sub');
    var movesEl = el('div', 'duel-moves'), moveBtns = {};
    MOVES.forEach(function (m) {
      var b = el('button', 'duel-move'); b.type = 'button';
      var ic = el('span', 'duel-move-icon'); ic.innerHTML = ICONS[m.key];   // constant markup
      b.appendChild(ic); b.appendChild(el('span', 'duel-move-label', m.label)); b.appendChild(el('span', 'duel-move-beats', 'beats ' + m.beats));
      b.addEventListener('click', function () { pick(m.key); });
      moveBtns[m.key] = b; movesEl.appendChild(b);
    });
    movesEl.hidden = true;
    live.appendChild(liveChip); live.appendChild(liveBar); live.appendChild(meHp.r); live.appendChild(foeHp.r); live.appendChild(chaos); live.appendChild(liveHead); live.appendChild(liveSub); live.appendChild(movesEl);

    rootEl.appendChild(headRow); rootEl.appendChild(intro); rootEl.appendChild(notReady); rootEl.appendChild(incoming); rootEl.appendChild(live); rootEl.appendChild(roster); rootEl.appendChild(msg);

    function say(text, ms) {
      msg.textContent = text; clearTimeout(msgT);
      if (ms) msgT = setTimeout(function () { msg.textContent = ''; }, ms);
    }
    function send(action, body) {
      return Promise.resolve(opts.post ? opts.post(action, body) : { ok: false }).then(function (r) {
        if (!r || !r.ok) say((r && r.data && r.data.error) || 'That did not go through. Try again.', 7000);
        return r;
      }, function () { say('You seem to be offline. Try again.', 7000); return { ok: false }; });
    }
    function pick(move) {
      if (picking || !fs || !fs.live || fs.live.phase !== 'pick' || fs.live.picked) return;
      picking = move; paintMoves(fs.live);   // lock the button at once; the server's answer follows
      send('pick', { move: move }).then(function (r) { if (!r.ok) picking = ''; paintMoves(fs && fs.live); });
    }
    accept.addEventListener('click', function () { if (answering) return; answering = true; send('respond', { accept: true }).then(function () { answering = false; }); });
    decline.addEventListener('click', function () { if (answering) return; answering = true; send('respond', { accept: false }).then(function () { answering = false; }); });

    function paintMoves(l) {
      var open = !!l && l.you && l.phase === 'pick';
      movesEl.hidden = !open;
      if (!open) return;
      var chosen = l.picked || picking;
      MOVES.forEach(function (m) {
        var b = moveBtns[m.key];
        b.disabled = !!chosen;
        b.setAttribute('aria-pressed', chosen === m.key ? 'true' : 'false');
        b.classList.toggle('is-chosen', chosen === m.key);
      });
    }

    function paintRoster(f) {
      var rows = f.roster || [], sig = JSON.stringify([rows, f.left]);
      if (sig === rosterSig) return;
      rosterSig = sig;
      roster.replaceChildren();
      rows.forEach(function (p) {
        var li = el('li', 'duel-row'), who = el('div', 'duel-who'), dot = el('i', 'duel-dot');
        dot.style.background = opts.color ? opts.color(p.color) : '#7c9cff';
        who.appendChild(dot); who.appendChild(el('strong', null, p.name));
        if (p.song) who.appendChild(el('span', 'duel-song', '♪ ' + p.song.title));
        var b = el('button', 'btn small', 'Challenge'); b.type = 'button';
        var blocked = !p.can || f.left < 1;
        b.disabled = blocked;
        b.setAttribute('aria-label', 'Challenge ' + p.name + ' to a duel');
        b.addEventListener('click', function () {
          b.disabled = true;
          send('challenge', { targetId: p.id }).then(function (r) { if (r.ok) say('Challenge sent to ' + p.name + '.', 4000); else b.disabled = false; });
        });
        li.appendChild(who); li.appendChild(b);
        if (blocked) li.appendChild(el('div', 'duel-why', p.can ? 'You have no challenges left for now.' : p.reason));
        roster.appendChild(li);
      });
      if (!rows.length) roster.appendChild(el('li', 'duel-row duel-empty', 'Nobody else has a song waiting yet.'));
    }

    function paintLive(l) {
      var me = l.you ? l[l.you] : l.a, foe = l.you ? l[l.you === 'a' ? 'b' : 'a'] : l.b;
      liveChip.textContent = l.phase === 'challenge' ? 'DUEL' : l.sudden ? 'SUDDEN DEATH' : 'ROUND ' + Math.max(1, l.round) + ' / ' + l.maxRounds;
      [[meHp, me], [foeHp, foe]].forEach(function (p) {
        p[0].n.textContent = p[1].name; p[0].f.style.width = Math.max(0, Math.min(100, p[1].hp)) + '%'; p[0].v.textContent = String(Math.round(p[1].hp));
        p[0].bar.setAttribute('data-tone', p[1].hp > 50 ? 'ok' : p[1].hp > 25 ? 'low' : 'crit');
        p[0].r.style.setProperty('--fc', opts.color ? opts.color(p[1].color) : '#7c9cff');
      });
      var showChaos = !!l.chaos && (l.phase === 'pick' || l.phase === 'reveal');
      chaos.hidden = !showChaos;
      if (showChaos) { chaosT.textContent = l.chaos.title + ': '; chaosX.textContent = l.chaos.text; }
      var t = phoneLines(l);
      liveHead.textContent = t.head; liveSub.textContent = t.sub;
      paintMoves(l);
      // A buzz when it is time to pick, and when you win.
      var key = l.id + ':' + l.phase + ':' + l.round;
      if (key !== liveKey) {
        liveKey = key;
        if (l.you && typeof navigator !== 'undefined' && navigator.vibrate) {
          if (l.phase === 'pick') navigator.vibrate(40);
          else if (l.phase === 'over' && l.result && l.result.winnerId === me.id) navigator.vibrate([60, 40, 60]);
        }
        if (l.phase !== 'pick') picking = '';
      }
    }

    function tick() {
      if (!fs || fs.enabled === false) return;
      var sinceMs = Date.now() - recvAt;
      if (fs.left < 1 && fs.resetInMs) quota.textContent = '0 of ' + fs.perWindow + ' left · next in ' + clock(fs.resetInMs - sinceMs);
      var l = fs.live;
      if (!l) return;
      var left = Math.max(0, l.leftMs - sinceMs);
      inClock.textContent = 'Answer in ' + Math.ceil(left / 1000) + ' s';
      liveFill.style.width = (l.phase === 'over' ? 0 : Math.min(100, left / Math.max(1, l.phaseMs) * 100)) + '%';
    }

    /** Call with every update from the server: its `fights` part. */
    function update(f) {
      fs = f || null; recvAt = Date.now();
      if (!fs || fs.enabled === false) { rootEl.hidden = true; return; }
      rootEl.hidden = false;
      var l = fs.live, mode = !l ? (fs.ready ? 'idle' : 'notready') : l.you === 'b' && l.phase === 'challenge' ? 'incoming' : 'live';
      quota.textContent = fs.left + ' of ' + fs.perWindow + ' challenge' + (fs.perWindow === 1 ? '' : 's') + ' left';
      intro.hidden = mode !== 'idle' && mode !== 'notready';
      notReady.hidden = mode !== 'notready'; notReady.textContent = mode === 'notready' ? fs.notReady : '';
      roster.hidden = mode !== 'idle';
      incoming.hidden = mode !== 'incoming';
      live.hidden = mode !== 'live';
      if (mode === 'idle') paintRoster(fs);
      if (l && mode === 'incoming') {
        var foe = l.a;
        inHead.textContent = foe.name + ' challenges you!';
        inSub.textContent = (foe.song ? '♪ ' + foe.song.title + '  vs  ' : '') + (l.b.song ? '♪ ' + l.b.song.title : '') + '. The winner’s song moves up the line.';
        accept.disabled = decline.disabled = false;
      }
      if (l && mode === 'live') paintLive(l);
      // A duel you are in must not sit below the fold: buzz (when challenged) and bring the panel into view, once per duel.
      if (l && l.you && l.id !== seenDuel) {
        seenDuel = l.id;
        try {
          if (l.you === 'b' && navigator.vibrate) navigator.vibrate([120, 80, 120]);
          var calm = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
          if (rootEl.scrollIntoView) rootEl.scrollIntoView({ block: 'center', behavior: calm ? 'auto' : 'smooth' });
        } catch (e) { /* a missing nicety, never an error */ }
      }
      if (!l) { picking = ''; liveKey = ''; seenDuel = ''; }
      tick();
    }
    timer = setInterval(tick, 250);
    function destroy() { clearInterval(timer); clearTimeout(msgT); }
    return { update: update, destroy: destroy };
  }

  return { MOVES: MOVES, LABEL: LABEL, ICONS: ICONS, clock: clock, tvLines: tvLines, phoneLines: phoneLines, createTV: createTV, createPhone: createPhone };
});
