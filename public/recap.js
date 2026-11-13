// "Night in review": the host's recap panel and shareable summary. Reads GET /api/rooms/:code/host/recap.
// Mounts itself into #recap-mount when the host page renders it (see public/app.js). No dependencies.
(function () {
  'use strict';
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }
  function song(s) { return s.title + (s.artist ? ' - ' + s.artist : ''); }

  /** Short plain-text summary of a recap object. Exposed for tests. */
  function summaryText(r, code) {
    if (!r || !r.songs) return 'Nothing played yet in my Room Blend room.';
    var lines = ['Night in review - Room Blend' + (code ? ' (room ' + code + ')' : '')];
    lines.push(plural(r.songs, 'song') + (r.minutes ? ' over ' + plural(r.minutes, 'minute') : '') + ', up to ' + plural(r.peakListeners, 'listener') + ' at once.');
    if (r.genres && r.genres.length) lines.push('Genre mix: ' + r.genres.slice(0, 4).map(function (g) { return g.genre + ' ' + g.share + '%'; }).join(', ') + '.');
    if (r.topVoted && r.topVoted.length) lines.push('Crowd favourite: ' + song(r.topVoted[0]) + '.');
    if (r.leastLiked && r.leastLiked.length) lines.push('Least liked: ' + song(r.leastLiked[0]) + '.');
    return lines.join('\n');
  }

  function mount(box) {
    var H = window.RoomBlendHost; if (!H || box.getAttribute('data-ready')) return;
    box.setAttribute('data-ready', '1');
    var det = el('details', 'panel secondary recap'); det.id = 'recap';
    det.appendChild(el('summary', null, 'Night in review'));
    var body = el('div', 'recap-body'); det.appendChild(body);
    var data = null, timer = null;

    function list(title, rows, fmt) {
      var d = el('div', 'recap-list'); d.appendChild(el('h3', null, title));
      if (!rows || !rows.length) { d.appendChild(el('p', 'hint', 'No votes yet.')); return d; }
      var ol = el('ol'); rows.slice(0, 3).forEach(function (s) { ol.appendChild(el('li', null, song(s) + fmt(s))); }); d.appendChild(ol); return d;
    }
    function render(msg) {
      body.textContent = '';
      if (msg) body.appendChild(el('p', 'hint', msg));
      var r = data && data.recap;
      if (r && !r.songs) body.appendChild(el('p', 'hint recap-empty', 'Nothing played yet. Your recap appears once the first song has played.'));
      if (r && r.songs) {
        var st = el('div', 'recap-stats');
        [[r.songs, r.songs === 1 ? 'song' : 'songs'], [r.minutes, r.minutes === 1 ? 'minute' : 'minutes'], [r.peakListeners, 'peak listeners']].forEach(function (x) {
          var c = el('div', 'recap-stat'); c.appendChild(el('b', null, String(x[0]))); c.appendChild(el('span', null, x[1])); st.appendChild(c);
        });
        body.appendChild(st);
        var g = el('div', 'recap-list'); g.appendChild(el('h3', null, 'Genre mix'));
        if (r.genres.length) r.genres.slice(0, 6).forEach(function (x) {
          var row = el('div', 'recap-bar'); row.appendChild(el('span', null, x.genre));
          var track = el('i'); var fill = el('u'); fill.style.width = Math.max(2, Math.min(100, x.share)) + '%'; track.appendChild(fill); row.appendChild(track);
          row.appendChild(el('span', null, x.share + '%')); g.appendChild(row);
        }); else g.appendChild(el('p', 'hint', 'No genres recorded.'));
        body.appendChild(g);
        body.appendChild(list('Best liked', r.topVoted, function (s) { return ' (+' + (s.up - s.down) + ')'; }));
        body.appendChild(list('Least liked', r.leastLiked, function (s) { return ' (' + (s.up - s.down) + ')'; }));
      }
      var row = el('div', 'row recap-actions');
      var copy = el('button', 'btn small', 'Copy summary'); copy.type = 'button'; copy.id = 'recap-copy';
      copy.onclick = function () {
        var text = summaryText(r, H.code);
        var done = function (t) { copy.textContent = t; setTimeout(function () { copy.textContent = 'Copy summary'; }, 1800); };
        var fallback = function () { var ta = el('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); var ok = false; try { ok = document.execCommand('copy'); } catch (e) { /* ignore */ } ta.remove(); done(ok ? 'Copied' : 'Copy failed'); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { done('Copied'); }, fallback); else fallback();
      };
      row.appendChild(copy);
      if (navigator.share) {
        var sh = el('button', 'btn small', 'Share'); sh.type = 'button'; sh.id = 'recap-share';
        sh.onclick = function () { navigator.share({ title: 'Night in review', text: summaryText(r, H.code) }).catch(function () { /* cancelled */ }); };
        row.appendChild(sh);
      }
      var refresh = el('button', 'btn small', 'Refresh'); refresh.type = 'button'; refresh.id = 'recap-refresh'; refresh.onclick = load;
      row.appendChild(refresh);
      body.appendChild(row);
    }
    function load() {
      fetch('/api/rooms/' + H.code + '/host/recap', { headers: H.headers }).then(function (res) {
        if (!res.ok) throw new Error('status ' + res.status); return res.json();
      }).then(function (j) { data = j; render(); }, function () { render(data ? 'Could not refresh the recap.' : 'Could not load the recap.'); });
    }
    det.addEventListener('toggle', function () {
      clearInterval(timer);
      if (det.open) { load(); timer = setInterval(load, 60000); }
    });
    box.appendChild(det);
  }

  function scan() { var b = document.getElementById('recap-mount'); if (b) mount(b); }
  scan();
  new MutationObserver(scan).observe(document.getElementById('app') || document.body, { childList: true, subtree: true });
  window.RoomBlendRecap = { summaryText: summaryText };
})();
