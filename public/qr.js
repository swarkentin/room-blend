// Minimal QR code generator (byte mode, error correction L or M, versions 1-10: up to 213 bytes).
// No dependencies and no network, so the join code always shows. Works in the browser and in Node.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QR = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // [ecPerBlock, [blocks, dataPerBlock], [blocks, dataPerBlock] | null]  per version 1..10
  var TABLE = {
    L: [[7, [1, 19]], [10, [1, 34]], [15, [1, 55]], [20, [1, 80]], [26, [1, 108]], [18, [2, 68]], [20, [2, 78]], [24, [2, 97]], [30, [2, 116]], [18, [2, 68], [2, 69]]],
    M: [[10, [1, 16]], [16, [1, 28]], [26, [1, 44]], [18, [2, 32]], [24, [2, 43]], [16, [4, 27]], [18, [4, 31]], [22, [2, 38], [2, 39]], [22, [3, 36], [2, 37]], [26, [4, 43], [1, 44]]],
  };
  var ALIGN = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

  // GF(256) with polynomial 0x11d
  var EXP = new Array(512), LOG = new Array(256);
  (function () { var x = 1; for (var i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; } for (i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; })();
  function mul(a, b) { return a && b ? EXP[LOG[a] + LOG[b]] : 0; }
  function rsGen(n) { var g = [1]; for (var i = 0; i < n; i++) { var next = new Array(g.length + 1).fill(0); for (var j = 0; j < g.length; j++) { next[j] ^= g[j]; next[j + 1] ^= mul(g[j], EXP[i]); } g = next; } return g; }
  function rsRem(data, n) {
    var g = rsGen(n), r = new Array(n).fill(0);
    for (var i = 0; i < data.length; i++) { var f = data[i] ^ r[0]; r.shift(); r.push(0); if (f) for (var j = 0; j < n; j++) r[j] ^= mul(g[j + 1], f); }
    return r;
  }

  function utf8(s) { return Array.prototype.slice.call(new TextEncoder().encode(s)); }

  function layout(ver, ecc) {
    var t = TABLE[ecc][ver - 1], blocks = [];
    for (var k = 1; k < t.length; k++) for (var i = 0; i < t[k][0]; i++) blocks.push(t[k][1]);
    return { ec: t[0], blocks: blocks, data: blocks.reduce(function (a, b) { return a + b; }, 0) };
  }

  function bch(value, poly, bits) { // remainder-based BCH
    var v = value << (bits === 15 ? 10 : 12), pl = Math.floor(Math.log2(poly));
    for (var i = Math.floor(Math.log2(v)); i >= pl; i--) if (v & (1 << i)) v ^= poly << (i - pl);
    return v;
  }

  function encode(text, ecc) {
    ecc = ecc === 'L' ? 'L' : 'M';
    var bytes = utf8(text), ver = 0, lay;
    for (var v = 1; v <= 10; v++) { lay = layout(v, ecc); var cap = lay.data - (v < 10 ? 2 : 3); if (bytes.length <= cap) { ver = v; break; } }
    if (!ver) throw new Error('Text too long for the QR generator (max 213 bytes).');
    lay = layout(ver, ecc);
    // bit stream: mode 0100, length (8 bits for v1-9, 16 for v10), data, terminator, pad
    var bits = [];
    function put(val, n) { for (var i = n - 1; i >= 0; i--) bits.push((val >> i) & 1); }
    put(4, 4); put(bytes.length, ver < 10 ? 8 : 16); bytes.forEach(function (b) { put(b, 8); });
    var total = lay.data * 8;
    for (var z = 0; z < 4 && bits.length < total; z++) bits.push(0);
    while (bits.length % 8) bits.push(0);
    var cw = [];
    for (var i = 0; i < bits.length; i += 8) { var x = 0; for (var j = 0; j < 8; j++) x = (x << 1) | bits[i + j]; cw.push(x); }
    for (var pad = 0; cw.length < lay.data; pad++) cw.push(pad % 2 ? 0x11 : 0xec);
    // split into blocks, add EC, interleave
    var dblocks = [], eblocks = [], pos = 0;
    lay.blocks.forEach(function (n) { var d = cw.slice(pos, pos + n); pos += n; dblocks.push(d); eblocks.push(rsRem(d, lay.ec)); });
    var out = [], maxd = Math.max.apply(null, lay.blocks);
    for (i = 0; i < maxd; i++) dblocks.forEach(function (d) { if (i < d.length) out.push(d[i]); });
    for (i = 0; i < lay.ec; i++) eblocks.forEach(function (e) { out.push(e[i]); });
    var stream = []; out.forEach(function (b) { for (var k = 7; k >= 0; k--) stream.push((b >> k) & 1); });
    var rem = ver >= 2 && ver <= 6 ? 7 : 0; for (i = 0; i < rem; i++) stream.push(0);
    return { ver: ver, stream: stream, ecc: ecc };
  }

  function build(enc, mask) {
    var n = enc.ver * 4 + 17, m = [], fn = [];
    for (var r = 0; r < n; r++) { m.push(new Array(n).fill(0)); fn.push(new Array(n).fill(false)); }
    function set(r, c, v) { if (r < 0 || c < 0 || r >= n || c >= n) return; m[r][c] = v ? 1 : 0; fn[r][c] = true; }
    function finder(r0, c0) { for (var dr = -1; dr <= 7; dr++) for (var dc = -1; dc <= 7; dc++) { var on = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6 && (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4)); set(r0 + dr, c0 + dc, on); } }
    finder(0, 0); finder(0, n - 7); finder(n - 7, 0);
    for (var i = 8; i < n - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    var al = ALIGN[enc.ver - 1];
    al.forEach(function (ar) { al.forEach(function (ac) {
      if ((ar === 6 && ac === 6) || (ar === 6 && ac === al[al.length - 1]) || (ar === al[al.length - 1] && ac === 6)) return;
      for (var dr = -2; dr <= 2; dr++) for (var dc = -2; dc <= 2; dc++) set(ar + dr, ac + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
    }); });
    set(n - 8, 8, true); // dark module
    // reserve format areas
    for (i = 0; i < 9; i++) { if (!fn[8][i]) set(8, i, 0); if (!fn[i][8]) set(i, 8, 0); }
    for (i = 0; i < 8; i++) { set(8, n - 1 - i, 0); set(n - 1 - i, 8, 0); }
    set(n - 8, 8, true);
    if (enc.ver >= 7) for (i = 0; i < 6; i++) for (var j = 0; j < 3; j++) { set(i, n - 11 + j, 0); set(n - 11 + j, i, 0); }
    // place data, zig-zag
    var idx = 0, up = true;
    for (var c = n - 1; c > 0; c -= 2) {
      if (c === 6) c--;
      for (var k = 0; k < n; k++) {
        var rr = up ? n - 1 - k : k;
        for (var d = 0; d < 2; d++) {
          var cc = c - d;
          if (fn[rr][cc]) continue;
          var bit = idx < enc.stream.length ? enc.stream[idx++] : 0;
          if (MASKS[mask](rr, cc)) bit ^= 1;
          m[rr][cc] = bit;
        }
      }
      up = !up;
    }
    // format info
    var fmt = ((enc.ecc === 'L' ? 1 : 0) << 3) | mask;
    var f = ((fmt << 10) | bch(fmt, 0x537, 15)) ^ 0x5412;
    function fb(i) { return (f >> i) & 1; }
    for (i = 0; i <= 5; i++) m[i][8] = fb(i);
    m[7][8] = fb(6); m[8][8] = fb(7); m[8][7] = fb(8);
    for (i = 9; i < 15; i++) m[8][14 - i] = fb(i);
    for (i = 0; i < 8; i++) m[8][n - 1 - i] = fb(i);
    for (i = 8; i < 15; i++) m[n - 15 + i][8] = fb(i);
    m[n - 8][8] = 1;
    if (enc.ver >= 7) {
      var vi = (enc.ver << 12) | bch(enc.ver, 0x1f25, 18);
      for (i = 0; i < 18; i++) { var b = (vi >> i) & 1, a = Math.floor(i / 3), bb = i % 3 + n - 11; m[a][bb] = b; m[bb][a] = b; }
    }
    return m;
  }
  var MASKS = [
    function (r, c) { return (r + c) % 2 === 0; }, function (r) { return r % 2 === 0; }, function (r, c) { return c % 3 === 0; }, function (r, c) { return (r + c) % 3 === 0; },
    function (r, c) { return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; }, function (r, c) { return ((r * c) % 2) + ((r * c) % 3) === 0; },
    function (r, c) { return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0; }, function (r, c) { return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0; },
  ];
  function penalty(m) {
    var n = m.length, p = 0, r, c, run, i;
    for (var pass = 0; pass < 2; pass++) {
      for (r = 0; r < n; r++) {
        run = 1;
        for (c = 1; c < n; c++) {
          var a = pass ? m[c][r] : m[r][c], b = pass ? m[c - 1][r] : m[r][c - 1];
          if (a === b) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1;
        }
      }
    }
    for (r = 0; r < n - 1; r++) for (c = 0; c < n - 1; c++) { var v = m[r][c]; if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) p += 3; }
    var pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    for (r = 0; r < n; r++) for (c = 0; c <= n - 11; c++) {
      var h1 = true, h2 = true, v1 = true, v2 = true;
      for (i = 0; i < 11; i++) { if (m[r][c + i] !== pat1[i]) h1 = false; if (m[r][c + i] !== pat2[i]) h2 = false; if (m[c + i][r] !== pat1[i]) v1 = false; if (m[c + i][r] !== pat2[i]) v2 = false; }
      if (h1) p += 40; if (h2) p += 40; if (v1) p += 40; if (v2) p += 40;
    }
    var dark = 0; m.forEach(function (row) { row.forEach(function (x) { dark += x; }); });
    p += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
    return p;
  }

  // Returns a square matrix of 0/1 (1 = dark), without the quiet zone.
  function matrix(text, ecc) {
    var enc = encode(String(text), ecc), best = null, bp = Infinity;
    for (var k = 0; k < 8; k++) { var m = build(enc, k), p = penalty(m); if (p < bp) { bp = p; best = m; } }
    return best;
  }

  // SVG string with a 4-module quiet zone. `dark` / `light` are CSS colours.
  function svg(text, opts) {
    opts = opts || {};
    var m = matrix(text, opts.ecc), n = m.length, q = 4, d = '';
    for (var r = 0; r < n; r++) { var c = 0; while (c < n) { if (m[r][c]) { var s = c; while (c < n && m[r][c]) c++; d += 'M' + (s + q) + ' ' + (r + q) + 'h' + (c - s) + 'v1h-' + (c - s) + 'z'; } else c++; } }
    var size = n + q * 2;
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size + '" shape-rendering="crispEdges" role="img" aria-label="' + (opts.label || 'QR code') + '">' +
      '<rect width="' + size + '" height="' + size + '" fill="' + (opts.light || '#fff') + '"/><path d="' + d + '" fill="' + (opts.dark || '#000') + '"/></svg>';
  }

  return { matrix: matrix, svg: svg };
});
