(function () {
  'use strict';
  var key = new URLSearchParams(location.search).get('key') || '';
  var error = document.getElementById('error');
  function card(label, value) {
    var e = document.createElement('div'); e.className = 'card';
    var l = document.createElement('span'); l.className = 'label'; l.textContent = label;
    var v = document.createElement('span'); v.className = 'value'; v.textContent = value;
    e.append(l, v); return e;
  }
  function render(s) {
    var r = s.rooms || {}, connections = s.liveConnections || {};
    var current = document.getElementById('current'); current.replaceChildren();
    current.append(
      card('Rooms', r.total + ' / ' + r.max),
      card('Guests in rooms', s.guestsInRooms || 0),
      card('Hosts connected', r.withHostConnected || 0),
      card('Live connections', Object.values(connections).reduce(function (a, n) { return a + n; }, 0)),
      card('Service-song rooms', r.usingServiceSongs || 0),
      card('Own-library rooms', r.usingOwnLibrary || 0)
    );
    document.getElementById('lifetime').textContent = JSON.stringify(s.lifetimeCounters || {}, null, 2);
    document.getElementById('process').textContent = JSON.stringify({ uptimeSec: s.uptimeSec, node: s.node, memoryMB: s.memoryMB, eventLoopLagMs: s.eventLoopLagMs, currentCounters: s.counters, timers: s.timers, topGenres: s.topGenres, topSources: s.topSources }, null, 2);
    document.getElementById('updated').textContent = 'Updated ' + new Date().toLocaleString();
  }
  async function load() {
    try {
      var response = await fetch('/admin/status', { headers: { 'x-status-key': key }, cache: 'no-store' });
      if (!response.ok) throw new Error(response.status === 404 ? 'Not found or invalid admin key.' : 'Request failed (' + response.status + ').');
      render(await response.json()); error.hidden = true;
    } catch (e) { error.textContent = e.message; error.hidden = false; }
  }
  load(); setInterval(load, 15000);
}());
