// Music source: the host's own files. Tags are read in the browser; nothing is uploaded except
// title / artist / genre text. Audio plays from the files on this computer.
(function () {
  'use strict';
  var P = window.Providers, el = P.el, GM = window.GenreMap, Tags = window.Tags;
  var AUDIO = /\.(mp3|m4a|aac|flac|ogg|oga|opus|wav)$/i;
  var audio = null, files = new Map(), entries = [], url = null;
  var S = { phase: 'idle', done: 0, total: 0, untagged: 0, defaultGenre: '', accepted: 0, error: '', cur: null };

  function fnv(str) { var h = 0x811c9dc5; for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(36); }

  async function scan(list, ctx) {
    var arr = Array.prototype.filter.call(list, function (f) { return AUDIO.test(f.name) && f.name.charAt(0) !== '.'; });
    if (!arr.length) { S.phase = 'idle'; S.error = 'No songs found. Choose a folder with mp3, m4a, flac, ogg, opus or wav files.'; ctx.rerender(); return; }
    audio = audio || P.makeAudio(); audio.unlock(); audio.onended = function () { ctx.ended(); };
    S.phase = 'scanning'; S.done = 0; S.total = arr.length; S.error = ''; ctx.rerender();
    var out = new Array(arr.length), next = 0, last = 0;
    async function worker() {
      while (next < arr.length) {
        var i = next++, f = arr[i];
        var t = await Tags.read(Tags.fileReader(f), f.name);
        var rel = f.webkitRelativePath || f.name;
        out[i] = { file: f, id: 'f' + fnv(rel + '|' + f.size), title: t.title, artist: t.artist, genres: GM.fromTag(t.genre, 3) };
        S.done++;
        if (Date.now() - last > 120) { last = Date.now(); ctx.rerender(); await new Promise(function (r) { setTimeout(r, 0); }); }
      }
    }
    var ws = []; for (var k = 0; k < 8; k++) ws.push(worker());
    await Promise.all(ws);
    entries = out; files = new Map();
    var seen = {};
    entries.forEach(function (e) { var id = e.id, n = 1; while (seen[id]) id = e.id + '_' + (n++); e.id = id; seen[id] = 1; files.set(id, e.file); });
    await publish(ctx);
  }

  async function publish(ctx) {
    S.untagged = entries.filter(function (e) { return !e.genres.length; }).length;
    var tracks = entries.map(function (e) {
      return { id: e.id, title: e.title, artist: e.artist, genres: e.genres.length ? e.genres : (S.defaultGenre ? [S.defaultGenre] : []) };
    });
    S.phase = 'ready'; S.error = '';
    var r = await ctx.uploadLibrary('local', 'My files', tracks);
    if (!r.ok) { S.accepted = 0; S.error = 'None of those songs have a genre tag Room Blend recognises. Pick a genre for them below.'; }
    else S.accepted = r.data.accepted;
    ctx.rerender(); ctx.changed();
  }

  function pick(label, id, attrs, ctx, primary) {
    var input = el('input', Object.assign({ type: 'file', id: id, multiple: 'multiple', class: 'file-in' }, attrs));
    input.addEventListener('change', function () { if (input.files && input.files.length) scan(input.files, ctx); });
    return el('label', { class: 'btn' + (primary ? ' primary' : ''), for: id }, [label, input]);
  }

  var p = {
    id: 'local', name: 'My music files', blurb: 'A folder on this computer. Nothing leaves it but song names.', kind: 'library',
    render: function (ctx) {
      var box = el('div'), st = ctx.st(), remote = st && st.source && st.source.provider === 'local';
      if (S.phase === 'scanning') {
        box.appendChild(el('p', { class: 'state', role: 'status', text: 'Reading song tags… ' + S.done + ' of ' + S.total }));
        box.appendChild(el('progress', { max: String(S.total), value: String(S.done), class: 'prog' }));
        return box;
      }
      if (S.phase === 'ready') {
        box.appendChild(P.state('dot-ok', 'Playing from your files.', S.accepted + ' songs in the room.' + (S.untagged ? ' ' + S.untagged + (S.defaultGenre ? ' without a genre tag are counted as ' + S.defaultGenre + '.' : ' have no genre tag you could match, so they are left out.') : '')));
        if (S.untagged) {
          var sel = el('select', { id: 'loc-default', 'aria-label': 'Genre for songs without a tag' }, [el('option', { value: '', text: 'Leave them out' })].concat(ctx.genres.map(function (g) { return el('option', { value: g, text: 'Count them as ' + g, selected: g === S.defaultGenre ? 'selected' : false }); })));
          sel.addEventListener('change', function () { S.defaultGenre = sel.value; publish(ctx); });
          box.appendChild(el('div', { class: 'row' }, [sel]));
        }
        if (S.error) box.appendChild(el('p', { class: 'hint', text: S.error }));
        box.appendChild(el('div', { class: 'row' }, [pick('Choose a different folder', 'loc-dir2', { webkitdirectory: '', directory: '' }, ctx)]));
        return box;
      }
      if (remote) box.appendChild(el('p', { class: 'state', text: 'Your files are still in the room, but this tab needs the folder again to play them.' }));
      else box.appendChild(el('p', { class: 'state', text: 'Pick the folder where your music lives. Song tags are read here in your browser.' }));
      box.appendChild(el('div', { class: 'row' }, [pick('Choose music folder', 'loc-dir', { webkitdirectory: '', directory: '' }, ctx, true), pick('or choose files', 'loc-files', { accept: 'audio/*,.flac,.opus,.m4a' }, ctx)]));
      if (S.error) box.appendChild(el('p', { class: 'hint', role: 'status', text: S.error }));
      box.appendChild(el('p', { class: 'hint', text: 'Songs stay on your computer. Only titles, artists and genres are sent to the room. Songs need a genre tag to be matched to your guests.' }));
      return box;
    },
    activate: function (ctx) { if (S.phase === 'ready') publish(ctx); },
    ready: function () { return S.phase === 'ready' && files.size > 0; },
    play: async function (track) {
      var f = files.get(track.nativeId);
      if (!f) return null;
      if (url) URL.revokeObjectURL(url);
      url = URL.createObjectURL(f);
      var ok = await audio.play(url);
      return ok ? true : null; // a file the browser cannot decode is skipped
    },
    lastError: function () { return 'A song could not be played by this browser, so it was skipped.'; },
    pause: function () { audio && audio.pause(); }, resume: function () { audio && audio.resume(); }, stop: function () { audio && audio.stop(); },
    reset: function () { entries = []; files = new Map(); S.phase = 'idle'; },
  };
  P.register(p);
})();
