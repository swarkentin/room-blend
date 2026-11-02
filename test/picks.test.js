'use strict';
// Artist and song picks over the API: stored, limited, private to the guest, searchable from the room's own songs.
const http = require('http');
const assert = require('assert');
const { server } = require('../server.js');
let base, n = 0;
const ok = (s) => { n++; console.log('  ok  ' + s); };
const req = (method, path, body, headers = {}) => new Promise((resolve, reject) => {
  const data = body == null ? null : JSON.stringify(body);
  const r = http.request(base + path, { method, headers: Object.assign(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}, headers) }, (res) => {
    const c = []; res.on('data', (d) => c.push(d));
    res.on('end', () => { const t = Buffer.concat(c).toString(); let j = null; try { j = JSON.parse(t); } catch (e) { /* */ } resolve({ status: res.statusCode, json: j, text: t }); });
  });
  r.on('error', reject); if (data) r.write(data); r.end();
});
const snap = (path, headers) => new Promise((resolve, reject) => {
  const r = http.get(base + path, { headers }, (res) => { let b = ''; res.setEncoding('utf8'); res.on('data', (d) => { b += d; const m = /data: (.*)\n\n/.exec(b); if (m) { r.destroy(); resolve(JSON.parse(m[1])); } }); });
  r.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
  const mk = (await req('POST', '/api/rooms')).json, H = { 'x-host-key': mk.hostKey };
  const gH = (g) => ({ 'x-guest-id': g.guestId, 'x-guest-key': g.guestKey });

  // ---- joining with picks
  const a = (await req('POST', `/api/rooms/${mk.code}/guests`, { name: 'Ana', genres: ['rock'], artists: ['Fleetwood Mac', 'fleetwood  mac', '<b>Queen</b>', '', 5, 'A', 'B', 'C', 'D'], songs: [{ title: 'Bohemian Rhapsody', artist: 'Queen' }, { title: 'x' }, 'junk', { title: 'Bohemian Rhapsody!', artist: 'queen' }] })).json;
  const b = (await req('POST', `/api/rooms/${mk.code}/guests`, { name: 'Ben', genres: ['jazz'] })).json;
  assert.ok(a.guestId && b.guestId);
  let va = await snap(`/api/rooms/${mk.code}/events`, gH(a));
  assert.deepStrictEqual(va.me.artists, ['Fleetwood Mac', 'bQueen/b', 'A', 'B', 'C']); // markup characters are stripped, the duplicate and the empty and numeric entries are dropped
  assert.strictEqual(va.me.songs.length, 1); assert.deepStrictEqual(va.me.songs[0], { title: 'Bohemian Rhapsody', artist: 'Queen' });
  ok('picks are stored, capped at 5 artists and 5 songs, cleaned of markup, and duplicates and junk dropped');

  // ---- privacy
  const vb = await snap(`/api/rooms/${mk.code}/events`, gH(b));
  assert.deepStrictEqual(vb.me.artists, []); assert.deepStrictEqual(vb.me.songs, []); assert.ok(!JSON.stringify(vb).includes('Fleetwood'));
  const vh = await snap(`/api/rooms/${mk.code}/events`, H);
  const ha = vh.guests.find((g) => g.id === a.guestId);
  assert.strictEqual(ha.picks, 6); assert.ok(!('artists' in ha) && !('songs' in ha)); assert.ok(!JSON.stringify(vh.guests).includes('Fleetwood'));
  ok("another guest never sees your picks, and the host sees only how many you made");

  // ---- search
  const noAuth = await req('GET', `/api/rooms/${mk.code}/search?q=queen`); assert.strictEqual(noAuth.status, 401);
  const wrong = await req('GET', `/api/rooms/${mk.code}/search?q=queen`, null, { 'x-guest-id': a.guestId, 'x-guest-key': 'nope' }); assert.strictEqual(wrong.status, 401);
  ok('search needs a guest key');
  const q = (await req('GET', `/api/rooms/${mk.code}/search?q=${encodeURIComponent('miles dav')}`, null, gH(b))).json;
  assert.ok(q.artists.length >= 1 && /davis/i.test(q.artists[0].name) && q.artists[0].songs >= 1);
  const t = (await req('GET', `/api/rooms/${mk.code}/search?q=${encodeURIComponent('so what')}`, null, gH(b))).json;
  assert.ok(t.songs.some((s) => /so what/i.test(s.title)) && t.songs.length <= 8 && t.artists.length <= 8);
  ok("search finds artists and songs in the room's own music, by part of a name, up to 8 each");
  for (const bad of ['', ' ', 'a', '%%%', 'x'.repeat(500)]) { const r = await req('GET', `/api/rooms/${mk.code}/search?q=${encodeURIComponent(bad)}`, null, gH(b)); assert.strictEqual(r.status, 200); assert.ok(r.json.artists.length <= 8); }
  assert.deepStrictEqual((await req('GET', `/api/rooms/${mk.code}/search?q=zzqxjv`, null, gH(b))).json, { artists: [], songs: [] });
  ok('empty, too short, junk and very long searches are harmless; no match gives empty lists');

  // ---- editing
  const edit = await req('PATCH', `/api/rooms/${mk.code}/guests/${b.guestId}`, { artists: ['Miles Davis'], songs: [{ title: 'So What', artist: 'Miles Davis' }] }, gH(b));
  assert.strictEqual(edit.status, 200);
  let vb2 = await snap(`/api/rooms/${mk.code}/events`, gH(b));
  assert.deepStrictEqual(vb2.me.artists, ['Miles Davis']); assert.strictEqual(vb2.me.songs.length, 1); assert.deepStrictEqual(vb2.me.genres, ['jazz']);
  await req('PATCH', `/api/rooms/${mk.code}/guests/${b.guestId}`, { name: 'Ben' }, gH(b));
  vb2 = await snap(`/api/rooms/${mk.code}/events`, gH(b)); assert.deepStrictEqual(vb2.me.artists, ['Miles Davis']); ok('picks can be changed later, and changing something else leaves them alone');
  await req('PATCH', `/api/rooms/${mk.code}/guests/${b.guestId}`, { artists: [], songs: [] }, gH(b));
  vb2 = await snap(`/api/rooms/${mk.code}/events`, gH(b)); assert.deepStrictEqual(vb2.me.artists, []); assert.deepStrictEqual(vb2.me.songs, []); ok('picks can be cleared');
  assert.strictEqual((await req('PATCH', `/api/rooms/${mk.code}/guests/${a.guestId}`, { artists: ['X Y'] }, gH(b))).status, 401); ok("you cannot change someone else's picks");

  // ---- a guest with no genres is still refused, picks or not
  assert.strictEqual((await req('POST', `/api/rooms/${mk.code}/guests`, { name: 'Zed', artists: ['Queen'] })).status, 400); ok('picks do not replace choosing at least one genre');

  // ---- the queue uses them
  const solo = (await req('POST', '/api/rooms')).json;
  await req('POST', `/api/rooms/${solo.code}/host/opts`, { settle: 0 }, { 'x-host-key': solo.hostKey });
  const s1 = (await req('POST', `/api/rooms/${solo.code}/guests`, { name: 'Sol', genres: ['classical'], artists: ['Queen'] })).json;
  await new Promise((r) => setTimeout(r, 1500));
  const vs = await snap(`/api/rooms/${solo.code}/events`, gH(s1));
  assert.ok(vs.now && vs.next.length >= 1); const lineup = [vs.now.track, ...vs.next].map((x) => x.artist);
  assert.ok(lineup.includes('Queen'), 'a classical fan who named Queen hears Queen soon: ' + lineup.join(' | ')); ok('a named artist shows up in the lineup even when it is outside the genres picked');
  const st = (await req('GET', '/status')).json; assert.ok(st.counters['picks.artists'] >= 6 && st.counters['picks.searches'] >= 4); assert.ok(!JSON.stringify(st).includes('Fleetwood')); ok('/status counts picks and searches without naming any');
  console.log('\n' + n + ' checks passed');
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e.stack || e.message); process.exit(1); });
