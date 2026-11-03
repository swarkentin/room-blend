// Music source: the host's own files. Tags are read in the browser; nothing is uploaded except
// title / artist / genre text. Audio plays from the files on this computer.
//
// There are two ways to choose a folder:
//  - File System Access API (Chrome, Edge, Opera): showDirectoryPicker. The browser's prompt says the site
//    may "view files", and the folder handle is kept in this browser's IndexedDB, so after a reload the host
//    can reopen the same folder with one click.
//  - <input webkitdirectory> (every browser): the prompt says "upload", which is only the browser's standard
//    wording; the files are still just read here. The folder has to be picked again after a reload.
(function () {
  'use strict';
  var P = window.Providers, el = P.el, GM = window.GenreMap, Tags = window.Tags;
  var AUDIO = /\.(mp3|m4a|aac|flac|ogg|oga|opus|wav)$/i;
  var FSA = typeof window.showDirectoryPicker === 'function';
  var audio = null, files = new Map(), entries = [], url = null, lastPaint = 0;
  // remembered: the saved folder handle (FSA only). memTried: we have already asked IndexedDB for it.
  var S = { phase: 'idle', done: 0, total: 0, found: 0, untagged: 0, defaultGenre: '', accepted: 0, error: '', cur: null, remembered: null, memTried: false };

  function fnv(str) { var h = 0x811c9dc5; for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(36); }
  function revoke() { if (url) { URL.revokeObjectURL(url); url = null; } }
  function pause() { return new Promise(function (r) { setTimeout(r, 0); }); }

  // ---------- the remembered folder (File System Access API only) ----------
  var DB_NAME = 'rb-local', DB_STORE = 'handles', DB_KEY = 'music-folder';
  function idb(run) {
    return new Promise(function (resolve, reject) {
      var open;
      try { open = indexedDB.open(DB_NAME, 1); } catch (e) { reject(e); return; }
      open.onupgradeneeded = function () { open.result.createObjectStore(DB_STORE); };
      open.onerror = function () { reject(open.error); };
      open.onsuccess = function () {
        var db = open.result;
        try {
          var tx = db.transaction(DB_STORE, 'readwrite'), req = run(tx.objectStore(DB_STORE));
          tx.oncomplete = function () { db.close(); resolve(req.result); };
          tx.onerror = tx.onabort = function () { db.close(); reject(tx.error); };
        } catch (e) { db.close(); reject(e); }
      };
    });
  }
  // Storage can be blocked (private windows, site data off). Remembering is a convenience, so failures are ignored.
  function rememberFolder(h) { return idb(function (s) { return s.put(h, DB_KEY); }).catch(function () {}); }
  function forgetFolder() { return idb(function (s) { return s.delete(DB_KEY); }); }
  function recallFolder() { return idb(function (s) { return s.get(DB_KEY); }).then(function (h) { return h && h.kind === 'directory' ? h : null; }).catch(function () { return null; }); }
  // A saved handle keeps its folder but not its permission. Asking needs a click, so this is only called from one.
  async function canRead(h) {
    try {
      var o = { mode: 'read' };
      if ((await h.queryPermission(o)) === 'granted') return true;
      return (await h.requestPermission(o)) === 'granted';
    } catch (e) { return false; }
  }
  async function walk(dir, prefix, out, ctx) {
    for await (var entry of dir.values()) {
      if (entry.name.charAt(0) === '.') continue;
      if (entry.kind === 'directory') await walk(entry, prefix + entry.name + '/', out, ctx);
      else if (AUDIO.test(entry.name)) {
        out.push({ name: entry.name, rel: prefix + entry.name, handle: entry });
        S.found = out.length;
        if (Date.now() - lastPaint > 120) { lastPaint = Date.now(); ctx.rerender(); await pause(); }
      }
    }
  }
  async function openFolder(h, ctx) {
    if (!(await canRead(h))) { S.error = 'Room Blend was not given permission to read that folder.'; ctx.rerender(); return; }
    S.phase = 'listing'; S.found = 0; S.error = ''; ctx.rerender();
    var items = [];
    try { await walk(h, h.name + '/', items, ctx); }
    catch (e) { S.phase = 'idle'; S.error = 'That folder could not be read. It may have been moved or deleted. Choose it again.'; ctx.rerender(); return; }
    S.remembered = h; rememberFolder(h);
    await scan(items, ctx);
  }
  async function chooseFolder(ctx) {
    var h;
    try { h = await window.showDirectoryPicker({ id: 'room-blend-music', mode: 'read', startIn: 'music' }); }
    catch (e) {
      if (e && e.name === 'AbortError') return; // the host closed the picker
      S.error = e && e.name === 'SecurityError'
        ? 'Your browser does not let sites read that folder directly (it blocks places like Documents and Downloads). Choose a folder inside it, or use the older folder picker.'
        : 'Your browser could not open that folder. Try the older folder picker.';
      ctx.rerender(); return;
    }
    await openFolder(h, ctx);
  }

  // ---------- scanning ----------
  // items: [{ name, rel, file }] from an <input>, or [{ name, rel, handle }] from a directory handle.
  async function scan(items, ctx) {
    if (!items.length) { S.phase = 'idle'; S.error = 'No songs found. Choose a folder with mp3, m4a, flac, ogg, opus or wav files.'; ctx.rerender(); return; }
    audio = audio || P.makeAudio(); audio.unlock(); audio.onended = function () { ctx.ended(); };
    S.phase = 'scanning'; S.done = 0; S.total = items.length; S.error = ''; ctx.rerender();
    var out = new Array(items.length), next = 0, last = 0;
    async function worker() {
      while (next < items.length) {
        var i = next++, it = items[i];
        try {
          var f = it.file || await it.handle.getFile();
          var t = await Tags.read(Tags.fileReader(f), it.name);
          out[i] = { ref: it.file || it.handle, id: 'f' + fnv(it.rel + '|' + f.size), title: t.title, artist: t.artist, genres: GM.fromTag(t.genre, 3) };
        } catch (e) { /* a file that cannot be opened is left out */ }
        S.done++;
        if (Date.now() - last > 120) { last = Date.now(); ctx.rerender(); await pause(); }
      }
    }
    var ws = []; for (var k = 0; k < 8; k++) ws.push(worker());
    await Promise.all(ws);
    out = out.filter(Boolean);
    if (!out.length) { S.phase = 'idle'; S.error = 'None of those files could be opened.'; ctx.rerender(); return; }
    entries = out; files = new Map();
    var seen = {};
    entries.forEach(function (e) { var id = e.id, n = 1; while (seen[id]) id = e.id + '_' + (n++); e.id = id; seen[id] = 1; files.set(id, e.ref); });
    await publish(ctx);
  }

  function fromInput(list) {
    return Array.prototype.filter.call(list, function (f) { return AUDIO.test(f.name) && f.name.charAt(0) !== '.'; })
      .map(function (f) { return { name: f.name, rel: f.webkitRelativePath || f.name, file: f }; });
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

  // ---------- controls ----------
  // cls: 'primary' or 'small'. The input is a real <input type=file> inside its label, so it works in every browser.
  function pick(label, id, attrs, ctx, cls) {
    var input = el('input', Object.assign({ type: 'file', id: id, multiple: 'multiple', class: 'file-in' }, attrs));
    input.addEventListener('change', function () { if (input.files && input.files.length) scan(fromInput(input.files), ctx); });
    return el('label', { class: 'btn' + (cls ? ' ' + cls : ''), for: id }, [label, input]);
  }
  function folderInput(label, id, ctx, cls) { return pick(label, id, { webkitdirectory: '', directory: '' }, ctx, cls); }
  function button(label, id, cls, fn) { return el('button', { class: 'btn' + (cls ? ' ' + cls : ''), type: 'button', id: id, text: label, onclick: fn }); }
  function forgetButton(ctx) {
    return button('Forget this folder', 'loc-forget', 'small', async function () {
      try {
        await forgetFolder();
        S.remembered = null;
        S.error = '';
      } catch (e) {
        S.error = 'Room Blend could not forget that folder. Check browser storage settings and try again.';
      }
      ctx.rerender();
    });
  }

  var p = {
    id: 'local', name: 'My music files', blurb: 'A folder on this computer. Nothing leaves it but song names.', kind: 'library',
    render: function (ctx) {
      var box = el('div'), st = ctx.st(), remote = st && st.source && st.source.provider === 'local';
      if (FSA && !S.memTried) { S.memTried = true; recallFolder().then(function (h) { if (h && !S.remembered) { S.remembered = h; ctx.rerender(); } }); }
      if (S.phase === 'listing') {
        box.appendChild(el('p', { class: 'state', role: 'status', text: 'Looking for songs… ' + S.found + ' found' }));
        return box;
      }
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
        box.appendChild(el('div', { class: 'row' }, [FSA ? button('Choose a different folder', 'loc-fsa2', '', function () { chooseFolder(ctx); }) : folderInput('Choose a different folder', 'loc-dir2', ctx)]
          .concat(FSA && S.remembered ? [forgetButton(ctx)] : [])));
        return box;
      }
      if (remote) box.appendChild(el('p', { class: 'state', text: 'Your files are still in the room, but this tab needs the folder again to play them.' }));
      else box.appendChild(el('p', { class: 'state', text: 'Pick the folder where your music lives. Song tags are read here in your browser.' }));
      // Say what the browser's own prompt means before the host meets it. Its wording is alarming and applies to every site.
      box.appendChild(el('p', { class: 'hint', text: FSA
        ? 'Your browser will ask to let this site view the folder. That only lets Room Blend read the song tags here.'
        : 'Your browser may say it will "upload" the folder. That is only its standard wording: Room Blend just reads the song tags here.' }));
      if (FSA) {
        var someFiles = pick('or choose files', 'loc-files', { accept: 'audio/*,.flac,.opus,.m4a' }, ctx);
        box.appendChild(el('div', { class: 'row' }, S.remembered
          ? [button('Reopen "' + S.remembered.name + '"', 'loc-reopen', 'primary', function () { openFolder(S.remembered, ctx); }), button('Choose a different folder', 'loc-fsa', '', function () { chooseFolder(ctx); }), someFiles, forgetButton(ctx)]
          : [button('Choose music folder', 'loc-fsa', 'primary', function () { chooseFolder(ctx); }), someFiles]));
        box.appendChild(el('div', { class: 'row' }, [folderInput('Use the older folder picker', 'loc-dir', ctx, 'small'), el('span', { class: 'hint', text: 'Works in any browser. It says "upload" but sends nothing, and it cannot remember the folder.' })]));
      } else {
        box.appendChild(el('div', { class: 'row' }, [folderInput('Choose music folder', 'loc-dir', ctx, 'primary'), pick('or choose files', 'loc-files', { accept: 'audio/*,.flac,.opus,.m4a' }, ctx)]));
      }
      if (S.error) box.appendChild(el('p', { class: 'hint', role: 'status', text: S.error }));
      box.appendChild(el('p', { class: 'hint', text: 'Songs stay on your computer. Only titles, artists and genres are sent to the room. Songs need a genre tag to be matched to your guests.' }));
      return box;
    },
    activate: function (ctx) { if (S.phase === 'ready') publish(ctx); },
    ready: function () { return S.phase === 'ready' && files.size > 0; },
    play: async function (track) {
      var ref = files.get(track.nativeId);
      if (!ref) return null;
      var f;
      try { f = typeof ref.getFile === 'function' ? await ref.getFile() : ref; } // a handle reads the file now
      catch (e) { return null; } // moved or deleted since the scan: skip it
      revoke();
      url = URL.createObjectURL(f);
      var ok = await audio.play(url);
      return ok ? true : null; // a file the browser cannot decode is skipped
    },
    lastError: function () { return 'A song could not be played by this browser, so it was skipped.'; },
    pause: function () { audio && audio.pause(); }, resume: function () { audio && audio.resume(); }, stop: function () { audio && audio.stop(); revoke(); },
    reset: function () { revoke(); entries = []; files = new Map(); S.phase = 'idle'; },
  };
  P.register(p);
})();
