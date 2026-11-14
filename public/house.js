// House picks: music the host chooses up front, so the room can play before anyone has joined (no fake guests needed).
// The house blends like one more listener but is never shown as a person. It steps aside when real guests arrive, or (mode "always")
// stays as one more listener. Mounts into #house-mount on the host page; the room view arrives through RoomBlendHouse.update(st).
(function () {
  'use strict';
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  var C = window.CONFIG || {}, state = null, ui = null;

  function build(box) {
    var H = window.RoomBlendHost, UI = window.RoomBlendUI;
    if (!H || !UI || !UI.chipPicker) return null;
    var det = el('details', 'panel secondary house'); det.id = 'house';
    var sum = el('summary', null, 'House picks'); var badge = el('span', 'house-badge', ''); sum.appendChild(badge); det.appendChild(sum);
    var body = el('div', 'house-body'); det.appendChild(body);
    body.appendChild(el('p', 'hint', 'Pick music for the room before anyone joins, so there is no need to add a pretend guest. Guests who arrive take over; the house is never counted as a listener.'));

    var on = el('input'); on.type = 'checkbox'; on.id = 'house-on';
    var onLabel = el('label', 'house-on'); onLabel.setAttribute('for', 'house-on'); onLabel.append(on, document.createTextNode(' Play house picks'));
    body.appendChild(onLabel);

    var fs = el('fieldset'); fs.appendChild(el('legend', null, 'House genres, moods and eras, up to 4'));
    var pickerBox = el('div', 'chips'); pickerBox.id = 'house-picker'; fs.appendChild(pickerBox); body.appendChild(fs);

    var artistsBox = el('fieldset'); artistsBox.appendChild(el('legend', null, 'House artists, up to 6 (optional)'));
    var artistInput = el('input'); artistInput.type = 'text'; artistInput.placeholder = 'Add an artist'; artistInput.maxLength = 60; artistInput.setAttribute('aria-label', 'Add an artist');
    var addBtn = el('button', 'btn', 'Add'); addBtn.type = 'button';
    var artistList = el('div', 'house-artists');
    var row = el('div', 'row'); row.append(artistInput, addBtn); artistsBox.append(row, artistList); body.appendChild(artistsBox);

    var modeLabel = el('label', 'house-mode', 'When guests are here: ');
    var mode = el('select'); [['alone', 'step aside (play only while the room is empty)'], ['always', 'keep playing as one more listener']].forEach(function (o) { var op = el('option', null, o[1]); op.value = o[0]; mode.appendChild(op); });
    modeLabel.appendChild(mode); body.appendChild(modeLabel);

    var save = el('button', 'btn primary', 'Save house picks'); save.type = 'button';
    var status = el('p', 'hint'); status.setAttribute('role', 'status');
    body.append(save, status);
    box.appendChild(det);

    var u = { det: det, badge: badge, on: on, mode: mode, picked: [], artists: [], dirty: false, shown: '', status: status };
    function dirty() { u.dirty = true; status.textContent = ''; }
    function renderArtists() {
      artistList.replaceChildren();
      u.artists.forEach(function (a, i) {
        var b = el('button', 'chip', a + ' ×'); b.type = 'button'; b.setAttribute('aria-label', 'Remove ' + a);
        b.addEventListener('click', function () { u.artists.splice(i, 1); renderArtists(); dirty(); });
        artistList.appendChild(b);
      });
      addBtn.disabled = u.artists.length >= 6;
    }
    function addArtist() {
      var v = artistInput.value.replace(/\s+/g, ' ').trim().slice(0, 60);
      if (!v || u.artists.length >= 6 || u.artists.some(function (a) { return a.toLowerCase() === v.toLowerCase(); })) { artistInput.value = ''; return; }
      u.artists.push(v); artistInput.value = ''; renderArtists(); dirty();
    }
    addBtn.addEventListener('click', addArtist);
    artistInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); addArtist(); } });
    on.addEventListener('change', dirty); mode.addEventListener('change', dirty);

    // The shared chip picker marks chips by what is in `picked`; to show a saved pick it is "clicked" on, the way a host would.
    u.rebuildPicker = function (genres) {
      pickerBox.replaceChildren(); u.picked = [];
      UI.chipPicker(pickerBox, u.picked, dirty);
      genres.forEach(function (g) { var b = pickerBox.querySelector('button[data-g="' + String(g).replace(/"/g, '') + '"]'); if (b) b.click(); });
      u.dirty = false;
    };
    u.renderArtists = renderArtists;
    u.rebuildPicker([]); renderArtists();

    save.addEventListener('click', async function () {
      save.disabled = true; status.textContent = 'Saving…';
      try {
        var r = await fetch('/api/rooms/' + H.code + '/host/house', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, H.headers), body: JSON.stringify({ enabled: on.checked, genres: u.picked.slice(), artists: u.artists.slice(), mode: mode.value }) });
        if (!r.ok) throw new Error('save failed');
        u.dirty = false; status.textContent = on.checked ? (u.picked.length || u.artists.length ? 'House picks are on.' : 'Pick at least one genre or artist for the house to play.') : 'House picks are off.';
      } catch (e) { status.textContent = 'Could not save. Try again.'; }
      save.disabled = false;
    });
    return u;
  }

  function sync() {
    if (!ui || !state || !state.house) return;
    var h = state.house, sig = JSON.stringify([h.enabled, h.genres, h.artists, h.mode]);
    ui.badge.textContent = h.enabled ? (h.playing ? ' · playing' : ' · on') : ' · off';
    ui.badge.className = 'house-badge' + (h.enabled ? ' on' : '');
    if (sig === ui.shown || ui.dirty) return;   // never overwrite what the host is in the middle of editing
    ui.shown = sig; ui.on.checked = !!h.enabled; ui.mode.value = h.mode || 'alone';
    ui.artists = (h.artists || []).slice(); ui.rebuildPicker(h.genres || []);
    ui.renderArtists();
  }

  function scan() {
    var m = document.getElementById('house-mount');
    if (!m || m.getAttribute('data-ready')) return;
    var u = build(m); if (!u) return;
    m.setAttribute('data-ready', '1'); ui = u; sync();
  }
  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  scan();
  window.RoomBlendHouse = { update: function (st) { state = st; scan(); sync(); } };
})();
