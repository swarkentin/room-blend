// Reads title / artist / album / genre from audio files without any library.
// Supports ID3v2 (2.2, 2.3, 2.4) and ID3v1 (MP3), FLAC, Ogg Vorbis / Opus, and MP4 / M4A.
// Works in the browser and in Node. A "reader" is { size, read(start, length) -> Promise<Uint8Array> }.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Tags = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var td = {
    latin1: function (b) { var s = ''; for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s; },
    utf8: function (b) { return new TextDecoder('utf-8').decode(b); },
    utf16: function (b, be) {
      if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
      if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
      return new TextDecoder(be ? 'utf-16be' : 'utf-16le').decode(b);
    },
  };
  function clean(s) { return String(s).replace(/\u0000+$/g, '').replace(/\u0000/g, ' / ').replace(/\s+/g, ' ').trim(); }
  function str(b, off, len) { var s = ''; for (var i = off; i < off + len && i < b.length; i++) s += String.fromCharCode(b[i]); return s; }
  function u32be(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
  function u32le(b, o) { return ((b[o + 3] << 24) | (b[o + 2] << 16) | (b[o + 1] << 8) | b[o]) >>> 0; }
  function syncsafe(b, o) { return (b[o] & 0x7f) * 0x200000 + (b[o + 1] & 0x7f) * 0x4000 + (b[o + 2] & 0x7f) * 0x80 + (b[o + 3] & 0x7f); }

  // ---------- ID3v2 ----------
  function decodeId3Text(b) {
    if (!b.length) return '';
    var enc = b[0], body = b.subarray(1);
    if (enc === 0) return clean(td.latin1(body));
    if (enc === 1) return clean(td.utf16(body, false));
    if (enc === 2) return clean(td.utf16(body, true));
    return clean(td.utf8(body));
  }
  async function id3v2(reader) {
    var head = await reader.read(0, 10);
    if (head.length < 10 || str(head, 0, 3) !== 'ID3') return null;
    var ver = head[3], flags = head[5], size = syncsafe(head, 6);
    var data = await reader.read(10, Math.min(size, 768 * 1024));
    var pos = 0, out = {};
    if (flags & 0x40 && data.length >= 4) pos = ver === 4 ? syncsafe(data, 0) : u32be(data, 0) + 4; // extended header
    var idLen = ver === 2 ? 3 : 4, hdr = ver === 2 ? 6 : 10;
    var map = ver === 2 ? { TT2: 'title', TP1: 'artist', TAL: 'album', TCO: 'genre' } : { TIT2: 'title', TPE1: 'artist', TALB: 'album', TCON: 'genre' };
    while (pos + hdr <= data.length) {
      var id = str(data, pos, idLen);
      if (!/^[A-Z0-9]+$/.test(id)) break; // padding
      var fsize = ver === 2 ? (data[pos + 3] << 16) | (data[pos + 4] << 8) | data[pos + 5] : ver === 4 ? syncsafe(data, pos + 4) : u32be(data, pos + 4);
      var start = pos + hdr, end = start + fsize;
      if (fsize <= 0 || end > data.length) break;
      if (map[id] && !out[map[id]]) out[map[id]] = decodeId3Text(data.subarray(start, end));
      pos = end;
    }
    return out;
  }
  async function id3v1(reader) {
    if (reader.size < 128) return null;
    var b = await reader.read(reader.size - 128, 128);
    if (str(b, 0, 3) !== 'TAG') return null;
    var f = function (o, l) { return clean(td.latin1(b.subarray(o, o + l))); };
    return { title: f(3, 30), artist: f(33, 30), album: f(63, 30), genre: b[127] < 255 ? '(' + b[127] + ')' : '' };
  }

  // ---------- Vorbis comments (FLAC, Ogg) ----------
  function vorbisComments(b, o) {
    var out = {};
    var vl = u32le(b, o); o += 4 + vl;
    var n = u32le(b, o); o += 4;
    for (var i = 0; i < n && o + 4 <= b.length; i++) {
      var l = u32le(b, o); o += 4;
      if (o + l > b.length) break;
      var kv = td.utf8(b.subarray(o, o + l)); o += l;
      var eq = kv.indexOf('=');
      if (eq < 0) continue;
      var k = kv.slice(0, eq).toLowerCase(), v = clean(kv.slice(eq + 1));
      if (k === 'genre') out.genre = out.genre ? out.genre + ' / ' + v : v;
      else if ((k === 'title' || k === 'artist' || k === 'album') && !out[k]) out[k] = v;
      else if (k === 'albumartist' && !out.albumartist) out.albumartist = v;
    }
    return out;
  }
  async function flac(reader) {
    var pos = 4;
    for (var guard = 0; guard < 64 && pos + 4 <= reader.size; guard++) {
      var h = await reader.read(pos, 4);
      var last = h[0] & 0x80, type = h[0] & 0x7f, len = (h[1] << 16) | (h[2] << 8) | h[3];
      if (type === 4) { var d = await reader.read(pos + 4, Math.min(len, 512 * 1024)); return vorbisComments(d, 0); }
      pos += 4 + len;
      if (last) break;
    }
    return null;
  }
  function indexOf(b, needle) {
    outer: for (var i = 0; i + needle.length <= b.length; i++) { for (var j = 0; j < needle.length; j++) if (b[i + j] !== needle[j]) continue outer; return i; }
    return -1;
  }
  async function ogg(reader) {
    var b = await reader.read(0, 256 * 1024);
    var tags = [[0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73], [0x03, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73]]; // OpusTags, \x03vorbis
    for (var i = 0; i < tags.length; i++) { var at = indexOf(b, tags[i]); if (at >= 0) return vorbisComments(b, at + tags[i].length); }
    return null;
  }

  // ---------- MP4 / M4A ----------
  async function boxes(reader, start, end) {
    var list = [], pos = start;
    while (pos + 8 <= end && list.length < 200) {
      var h = await reader.read(pos, 16);
      if (h.length < 8) break;
      var size = u32be(h, 0), type = str(h, 4, 4), hl = 8;
      if (size === 1 && h.length >= 16) { size = u32be(h, 8) * 4294967296 + u32be(h, 12); hl = 16; }
      else if (size === 0) size = end - pos;
      if (size < hl) break;
      list.push({ type: type, start: pos + hl, end: Math.min(pos + size, end) });
      pos += size;
    }
    return list;
  }
  async function mp4(reader) {
    var top = await boxes(reader, 0, reader.size);
    var moov = top.filter(function (x) { return x.type === 'moov'; })[0];
    if (!moov) return null;
    var udta = (await boxes(reader, moov.start, moov.end)).filter(function (x) { return x.type === 'udta'; })[0];
    if (!udta) return null;
    var meta = (await boxes(reader, udta.start, udta.end)).filter(function (x) { return x.type === 'meta'; })[0];
    if (!meta) return null;
    var ilst = (await boxes(reader, meta.start + 4, meta.end)).filter(function (x) { return x.type === 'ilst'; })[0]; // meta is a full box: 4 bytes version/flags
    if (!ilst) return null;
    var out = {}, items = await boxes(reader, ilst.start, ilst.end);
    for (var i = 0; i < items.length; i++) {
      var it = items[i], key = it.type;
      var name = key === '©nam' ? 'title' : key === '©ART' ? 'artist' : key === 'aART' ? 'albumartist' : key === '©alb' ? 'album' : key === '©gen' ? 'genre' : key === 'gnre' ? 'gnre' : null;
      if (!name) continue;
      var data = (await boxes(reader, it.start, it.end)).filter(function (x) { return x.type === 'data'; })[0];
      if (!data) continue;
      var d = await reader.read(data.start + 8, Math.min(data.end - data.start - 8, 2048)); // skip type + locale
      if (name === 'gnre') { if (d.length >= 2) out.genre = out.genre || '(' + ((d[0] << 8 | d[1]) - 1) + ')'; }
      else if (!out[name]) out[name] = clean(td.utf8(d));
    }
    return out;
  }

  // ---------- public ----------
  function fromFilename(name) {
    var base = String(name || '').replace(/^.*[\\/]/, '').replace(/\.[A-Za-z0-9]{2,5}$/, '').replace(/_/g, ' ').trim();
    base = base.replace(/^\d{1,3}\s*[-.)]\s*/, '');
    var m = /^(.+?)\s+-\s+(.+)$/.exec(base);
    return m ? { artist: m[1].trim(), title: m[2].trim() } : { title: base };
  }

  // Returns { title, artist, album, genre } with whatever could be found. Never throws.
  async function read(reader, filename) {
    var tags = null;
    try {
      var magic = await reader.read(0, 12);
      var m4 = str(magic, 0, 3), m8 = str(magic, 4, 4);
      if (m4 === 'ID3') tags = await id3v2(reader);
      else if (str(magic, 0, 4) === 'fLaC') tags = await flac(reader);
      else if (str(magic, 0, 4) === 'OggS') tags = await ogg(reader);
      else if (m8 === 'ftyp') tags = await mp4(reader);
      if (!tags || !tags.genre) {
        var v1 = await id3v1(reader).catch(function () { return null; });
        if (v1) { tags = tags || {}; ['title', 'artist', 'album', 'genre'].forEach(function (k) { if (!tags[k] && v1[k]) tags[k] = v1[k]; }); }
      }
    } catch (e) { tags = tags || null; }
    tags = tags || {};
    var fb = fromFilename(filename);
    return {
      title: tags.title || fb.title || '',
      artist: tags.artist || tags.albumartist || fb.artist || '',
      album: tags.album || '',
      genre: tags.genre || '',
    };
  }

  function bufferReader(buf) { // for Node tests
    return { size: buf.length, read: function (s, l) { return Promise.resolve(new Uint8Array(buf.buffer, buf.byteOffset + s, Math.max(0, Math.min(l, buf.length - s)))); } };
  }
  function fileReader(file) {
    return { size: file.size, read: function (s, l) { return file.slice(s, Math.min(s + l, file.size)).arrayBuffer().then(function (a) { return new Uint8Array(a); }); } };
  }

  return { read: read, bufferReader: bufferReader, fileReader: fileReader, fromFilename: fromFilename };
});
