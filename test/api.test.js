'use strict';
// Server API tests: rooms, guests, host controls, SSE, auth, limits. No network beyond localhost.
const http = require('http');
const assert = require('assert');
const { server } = require('../server.js');
const { GENRES } = require('../lib/engine.js');
const GenreMap = require('../public/genremap.js');

let base, passed = 0;
const ok = (n) => { passed++; console.log('  ok  ' + n); };

function req(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined || body === null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const r = http.request(base + path, { method, headers: Object.assign(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}, headers) }, (res) => {
      const c = []; res.on('data', (d) => c.push(d));
      res.on('end', () => { const t = Buffer.concat(c).toString(); let j = null; try { j = JSON.parse(t); } catch (e) { /* */ } resolve({ status: res.statusCode, json: j, text: t, headers: res.headers }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
function sse(path) {
  const events = []; const waiters = []; let buf = '';
  const r = http.get(base + path, (res) => {
    res.setEncoding('utf8');
    res.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n\n')) >= 0) { const b = buf.slice(0, i); buf = buf.slice(i + 2); const m = /data: (.*)/.exec(b); if (m) { events.push(JSON.parse(m[1])); waiters.slice().forEach((w) => w()); } } });
  });
  r.on('error', () => {});
  return { events, close: () => r.destroy(), last: () => events[events.length - 1],
    waitFor(pred, ms = 4000) { return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const check = () => { for (let i = events.length - 1; i >= 0; i--) if (pred(events[i])) { done(); resolve(events[i]); return true; } return false; };
      const iv = setInterval(() => { if (Date.now() - t0 > ms) { done(); reject(new Error('timeout waiting for state; last=' + JSON.stringify(events[events.length - 1]).slice(0, 300))); } }, 50);
      const done = () => { clearInterval(iv); const k = waiters.indexOf(check); if (k >= 0) waiters.splice(k, 1); };
      if (!check()) waiters.push(check); }); } };
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
  console.log('API tests against ' + base);

  // genre map
  assert.strictEqual(GenreMap.classify('indie rock'), 'indie');
  assert.strictEqual(GenreMap.classify('modern country rock'), 'country');
  assert.ok(GenreMap.fromArtists([['trap', 'rap'], ['hip hop'], ['southern hip hop']], 4).includes('hip hop'));
  assert.ok(GenreMap.fromArtists([['zzzz unknown']], 4).length === 0);
  assert.ok(GenreMap.fromArtists([['blues rock', 'classic rock'], ['blues'], ['rock']], 4).every((g) => GENRES.includes(g)));
  ok('genre map maps Spotify genres to the canonical list');

  // static + config
  assert.strictEqual((await req('GET', '/')).status, 200);
  assert.strictEqual((await req('GET', '/host/ABCDE')).status, 200);
  assert.strictEqual((await req('GET', '/r/ABCDE')).status, 200);
  assert.strictEqual((await req('GET', '/callback?code=x')).status, 200);
  assert.strictEqual((await req('GET', '/..%2fserver.js')).status === 200, false);
  assert.strictEqual((await req('GET', '/nope.js')).status, 404);
  const cfg = await req('GET', '/config.js'); assert.ok(cfg.text.includes('window.CONFIG') && cfg.text.includes('"genres"'));
  assert.ok(!/secret/i.test(cfg.text)); ok('static routes, SPA fallback, traversal refused, config has no secrets');
  assert.ok((await req('GET', '/')).headers['content-security-policy']); ok('CSP header is set');
  const adminPage = await req('GET', '/admin');
  assert.strictEqual(adminPage.status, 200); assert.ok(adminPage.text.includes('Room Blend admin')); ok('private admin dashboard is available to local administrators');
  const adminStats = await req('GET', '/admin/status');
  assert.strictEqual(adminStats.status, 200); assert.ok(adminStats.json && adminStats.json.lifetimeCounters); ok('admin status includes current and lifetime counters');

  // rooms
  const mk = await req('POST', '/api/rooms'); const { code, hostKey } = mk.json;
  assert.ok(/^[A-Z0-9]{5}$/.test(code) && hostKey.length >= 20); ok('room created: ' + code);
  assert.strictEqual((await req('GET', '/api/rooms/' + code)).status, 200);
  assert.strictEqual((await req('GET', '/api/rooms/ZZZZZ')).status, 404); ok('lookup works, unknown room 404');
  assert.strictEqual((await req('GET', '/api/rooms/' + code + '/events?key=wrong')).status, 401); ok('stream refuses a wrong key');
  assert.strictEqual((await req('POST', '/api/rooms/' + code + '/host/advance', {}, { 'x-host-key': 'nope' })).status, 401); ok('host actions need the host key');

  const H = { 'x-host-key': hostKey };
  const host = sse(`/api/rooms/${code}/events?key=${hostKey}`);
  await host.waitFor((s) => s.guests && s.guests.length === 0); ok('host stream opens with room state');

  // guests
  assert.strictEqual((await req('POST', `/api/rooms/${code}/guests`, { name: 'X', genres: ['polka'] })).status, 400); ok('unknown genres rejected');
  const cfgRes = await req('GET', '/config.js'); assert.ok(/genreGroups/.test(cfgRes.text || JSON.stringify(cfgRes.json || '')) , 'config lists genre groups'); ok('config lists the genre groups');
  assert.strictEqual((await req('POST', `/api/rooms/${code}/guests`, { name: 'X', genres: ['any:nope'] })).status, 400); ok('unknown broad picks rejected');
  const broadG = await req('POST', `/api/rooms/${code}/guests`, { name: 'Broad', genres: ['any:rock', 'blues'] });
  assert.strictEqual(broadG.status, 200); ok('a broad pick ("all rock") is accepted');
  await req('DELETE', `/api/rooms/${code}/guests/${broadG.json.guestId}`, null, { 'x-guest-id': broadG.json.guestId, 'x-guest-key': broadG.json.guestKey });
  const a = (await req('POST', `/api/rooms/${code}/guests`, { name: ' Maya<b> ', genres: ['indie', 'folk', 'indie', 'rock', 'blues', 'jazz'] })).json;
  const A = { 'x-guest-id': a.guestId, 'x-guest-key': a.guestKey };
  const ga = sse(`/api/rooms/${code}/events?gid=${a.guestId}&gkey=${a.guestKey}`);
  const s1 = await host.waitFor((s) => s.guests.length === 1);
  assert.strictEqual(s1.guests[0].name.includes('<'), false); assert.deepStrictEqual(s1.guests[0].genres, ['indie', 'folk', 'rock', 'blues']);
  ok('guest joins; name cleaned, genres deduped and capped at 4');
  const b = (await req('POST', `/api/rooms/${code}/guests`, { name: 'Sam', genres: ['hip hop', 'soul'] })).json;
  const B = { 'x-guest-id': b.guestId, 'x-guest-key': b.guestKey };
  const gb = sse(`/api/rooms/${code}/events?gid=${b.guestId}&gkey=${b.guestKey}`);
  const st = await host.waitFor((s) => s.guests.length === 2 && s.now && s.queue.length > 0, 8000);
  assert.ok(st.now.track.title && st.now.fits.length); ok('a room with two guests plans a queue');

  const gs = await ga.waitFor((s) => s.now && s.me);
  const blob = JSON.stringify(gs);
  assert.ok(!blob.includes('Sam'));
  assert.ok(!('guests' in gs) && !('fairness' in gs)); ok('guest view hides other guests and their tastes');

  // vote
  await req('POST', `/api/rooms/${code}/vote`, { v: 'down' }, A);
  const sv = await host.waitFor((s) => s.now && s.now.votes && s.now.votes.down === 1); ok('votes reach the host');
  assert.strictEqual((await req('POST', `/api/rooms/${code}/vote`, { v: 'up' }, { 'x-guest-id': a.guestId, 'x-guest-key': 'bad' })).status, 401); ok('vote needs the guest key');

  // advance and player events
  const first = sv.now.track.id, second = sv.queue[0].track.id;
  await req('POST', `/api/rooms/${code}/host/advance`, {}, H);
  const s2 = await host.waitFor((s) => s.now && s.now.track.id !== first);
  assert.strictEqual(s2.now.track.id, second); ok('advance moves to the next queued song');
  await req('POST', `/api/rooms/${code}/host/player`, { event: 'ended', trackId: first }, H);
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(host.last().now.track.id, second); ok('a stale ended event is ignored');
  await req('POST', `/api/rooms/${code}/host/player`, { event: 'ended', trackId: second }, H);
  const s3 = await host.waitFor((s) => s.now && s.now.track.id !== second); ok('ended event advances');
  const third = s3.now.track.id;
  await req('POST', `/api/rooms/${code}/host/player`, { event: 'unplayable', trackId: third }, H);
  const s4 = await host.waitFor((s) => s.now && s.now.track.id !== third); ok('unplayable track is skipped');
  assert.ok(!s4.queue.some((q) => q.track.id === third) && s4.now.track.id !== third);

  // sit out, edit, host controls
  await req('PATCH', `/api/rooms/${code}/guests/${b.guestId}`, { sit: true, genres: ['soul'] }, B);
  await host.waitFor((s) => s.guests.some((g) => g.id === b.guestId && g.status === 'sitting')); ok('guest can edit and sit out');
  await req('PATCH', `/api/rooms/${code}/guests/${b.guestId}`, { sit: false }, B);
  await req('POST', `/api/rooms/${code}/host/guests/${b.guestId}`, { sit: true }, H);
  await host.waitFor((s) => s.guests.some((g) => g.id === b.guestId && g.hostSit)); ok('host can sit a guest out');
  await req('POST', `/api/rooms/${code}/host/guests`, { name: 'Pat', genres: ['country'] }, H);
  const sp = await host.waitFor((s) => s.guests.some((g) => g.name === 'Pat' && g.manual)); ok('host can add someone by hand');
  const pat = sp.guests.find((g) => g.name === 'Pat');
  await req('POST', `/api/rooms/${code}/host/guests/${pat.id}`, { remove: true }, H);
  await host.waitFor((s) => !s.guests.some((g) => g.name === 'Pat')); ok('host can remove a guest');
  await req('POST', `/api/rooms/${code}/host/opts`, { lambda: 0.9, tau: 0.4, settle: 0 }, H);
  await host.waitFor((s) => s.opts.lambda === 0.9 && s.opts.tau === 0.4 && s.opts.settle === 0); ok('tuning options apply');
  await req('POST', `/api/rooms/${code}/host/opts`, { lambda: 99, tau: -5, settle: 9999 }, H);
  const so = await host.waitFor((s) => s.opts.lambda <= 1); assert.ok(so.opts.tau >= 0 && so.opts.settle <= 60); ok('tuning options are clamped');

  // extras: host supplies extra tracks for a genre
  await req('POST', `/api/rooms/${code}/host/extras`, { genre: 'jazz', tracks: [{ title: 'So What', artist: 'Miles Davis' }, { title: 'x', artist: '' }, { title: 'So What', artist: 'Miles Davis' }] }, H);
  ok('extras accepted');
  assert.strictEqual((await req('POST', `/api/rooms/${code}/host/extras`, { genre: 'polka', tracks: [{ title: 'a', artist: 'b' }] }, H)).status, 200); ok('extras with bad genre do not crash');

  // leave + reconnect
  await req('DELETE', `/api/rooms/${code}/guests/${a.guestId}`, null, A);
  await host.waitFor((s) => !s.guests.some((g) => g.id === a.guestId)); ok('guest can leave');
  gb.close();
  await host.waitFor((s) => { const g = s.guests.find((x) => x.id === b.guestId); return g && g.connected === false; }); ok('a dropped guest shows as reconnecting');

  // limits
  const big = await req('POST', `/api/rooms/${code}/guests`, 'x'.repeat(40000)).catch(() => ({ status: 0 }));
  assert.ok(big.status === 413 || big.status === 0); ok('oversized body refused');
  assert.strictEqual((await req('POST', `/api/rooms/${code}/guests`, '{bad')).status, 400); ok('bad JSON is 400');

  // joining: names, nearby, short links, previews, screen
  await req('POST', `/api/rooms/${code}/host/room`, { name: 'Maya\'s <b>"Friday"</b> room', discoverable: true }, H);
  const info = (await req('GET', '/api/rooms/' + code)).json; assert.ok(info.name.includes('Friday') && !info.name.includes('<')); ok('a room name is stored and cleaned');
  const near = (await req('GET', '/api/nearby')).json.rooms.find((r) => r.code === code);
  assert.ok(near && near.name === info.name && typeof near.people === 'number'); ok('rooms on the same network are listed while their host is connected');
  assert.ok(!('hostKey' in near) && Object.keys(near).sort().join() === 'code,name,people'); ok('the nearby list reveals only code, name and headcount');
  await req('POST', `/api/rooms/${code}/host/room`, { discoverable: false }, H);
  assert.ok(!(await req('GET', '/api/nearby')).json.rooms.some((r) => r.code === code)); ok('turning discovery off hides the room');
  await req('POST', `/api/rooms/${code}/host/room`, { discoverable: true }, H);
  const sh = await req('GET', '/' + code.toLowerCase()); assert.strictEqual(sh.status, 200);
  assert.ok(sh.text.includes('og:title') && sh.text.includes('Friday') && !sh.text.includes('<b>')); ok('a short link serves a rich link preview with the escaped room name');
  assert.ok(!(await req('GET', '/r/ZZZZZ')).text.includes('og:title')); ok('unknown rooms get no preview');
  assert.strictEqual((await req('GET', '/screen/' + code)).status, 200); ok('the big-screen page is served');
  const scr = sse(`/api/rooms/${code}/events?screen=1`);
  const sv2 = await scr.waitFor((x) => x.role === 'screen' && x.next); const sj = JSON.stringify(sv2);
  assert.ok(!sj.includes(a.guestId) && !sj.includes('genres') && !sj.includes('hostKey') && !sj.includes('fits')); ok('the screen view carries no guest details'); scr.close();
  assert.ok(!(await req('GET', '/')).headers['content-security-policy'].includes('cdnjs')); ok('no third-party scripts are allowed (the QR code is built in)');

  // host-supplied library
  const lib = [{ id: 'a1', title: 'One', artist: 'X', genres: ['rock'] }, { id: 'a2', title: 'Two', artist: 'Y', genres: ['blues'] }, { id: 'a3', title: 'Three', artist: 'Z', genres: ['rock', 'blues'] },
    { id: 'a4', title: '', artist: 'Q', genres: ['rock'] }, { id: 'a5', title: 'No genre', artist: 'Q', genres: ['polka'] }, { id: 'a1', title: 'Dup', artist: 'Q', genres: ['rock'] }];
  assert.strictEqual((await req('POST', `/api/rooms/${code}/host/library`, { provider: 'local', label: 'x', tracks: [{ id: 'z', title: 't', genres: ['polka'] }] }, H)).status, 400); ok('a library with no usable songs is refused');
  assert.strictEqual((await req('POST', `/api/rooms/${code}/host/library`, { provider: 'local', label: 'x', tracks: lib }, { 'x-host-key': 'bad' })).status, 401); ok('setting a library needs the host key');
  const lr = await req('POST', `/api/rooms/${code}/host/library`, { provider: 'local', label: 'My files', tracks: lib }, H);
  assert.strictEqual(lr.json.accepted, 3); assert.strictEqual(lr.json.dropped, 3); ok('library accepted; empty titles, unknown genres and duplicates dropped');
  const ls = await host.waitFor((x) => x.source && x.source.kind === 'library' && x.catalogSize === 3);
  assert.ok(ls.queue.every((q) => /^L/.test(q.track.id)) && (!ls.now || /^L/.test(ls.now.track.id))); assert.deepStrictEqual(ls.wantGenres, []); ok('the room now plays only from the library');
  const bigLib = Array.from({ length: 12000 }, (_, i) => ({ id: 't' + i, title: 'Song number ' + i, artist: 'Artist ' + (i % 500), genres: [['rock', 'jazz', 'pop', 'metal'][i % 4]] }));
  const t0 = Date.now(); const bl = await req('POST', `/api/rooms/${code}/host/library`, { provider: 'subsonic', label: 'Server', tracks: bigLib }, H);
  assert.strictEqual(bl.json.accepted, 12000); await host.waitFor((x) => x.catalogSize === 12000); assert.ok(Date.now() - t0 < 4000); ok('a 12,000-song library is accepted and planned quickly');
  // a refresh keeps the song that is playing and swaps in the new list
  await req('POST', `/api/rooms/${code}/host/opts`, { settle: 0, tau: 0.1, lambda: 1 }, H);
  await req('POST', `/api/rooms/${code}/host/guests`, { name: 'Rf', genres: ['rock'] }, H);
  const nowBefore = (await host.waitFor((x) => x.now && x.catalogSize === 12000)).now.track.id;
  const lib2 = bigLib.slice(0, 5000).concat([{ id: 'fresh1', title: 'Fresh Song', artist: 'New Artist', genres: ['rock'] }]);
  const rf = await req('POST', `/api/rooms/${code}/host/library`, { provider: 'subsonic', label: 'Server', tracks: lib2, refresh: true }, H);
  assert.strictEqual(rf.json.accepted, 5001); assert.strictEqual(rf.json.synced, true);
  const after = await host.waitFor((x) => x.catalogSize === 5001);
  assert.strictEqual(after.now.track.id, nowBefore); assert.ok(after.queue.length > 0); ok('a library refresh keeps the current song and fills the queue from the new list');
  const rf2 = await req('POST', `/api/rooms/${code}/host/library`, { provider: 'local', label: 'Other', tracks: lib2, refresh: true }, H);
  assert.strictEqual(rf2.json.synced, false); ok('a refresh from a different source is treated as a new source, not a sync');
  await req('DELETE', `/api/rooms/${code}/host/library`, null, H);
  const cs = await host.waitFor((x) => x.source && x.source.kind === 'curated' && x.catalogSize >= 350); ok('clearing the library returns to the built-in list');

  // multi-tenant: rooms are isolated
  const mk2 = (await req('POST', '/api/rooms')).json;
  const H2 = { 'x-host-key': mk2.hostKey };
  assert.strictEqual((await req('POST', `/api/rooms/${code}/host/advance`, {}, H2)).status, 401); ok('another room\'s host key does nothing here');
  assert.strictEqual((await req('POST', `/api/rooms/${mk2.code}/vote`, { v: 'up' }, A)).status, 401); ok('a guest key from one room is useless in another');
  assert.strictEqual((await req('GET', `/api/rooms/${mk2.code}/events?gid=${a.guestId}&gkey=${a.guestKey}`)).status, 401);
  const h2 = sse(`/api/rooms/${mk2.code}/events?key=${mk2.hostKey}`);
  const w2 = await h2.waitFor((s) => s.guests && s.guests.length === 0); ok('a second room starts empty and separate');
  assert.ok(!JSON.stringify(w2).includes(b.guestId)); h2.close();
  assert.strictEqual((await req('GET', '/healthz')).text, 'ok'); ok('health check responds');
  const cfg2 = await req('GET', '/config.js'); assert.ok(!cfg2.text.includes('redirectUri')); ok('config does not hard-code an address');
  let blocked = 0; for (let i = 0; i < 12; i++) { const r = await req('POST', '/api/rooms'); if (r.status === 429) blocked++; }
  assert.ok(blocked >= 1); ok('one visitor cannot start unlimited rooms');

  host.close(); ga.close();
  console.log('\n' + passed + ' checks passed');
  process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e.stack || e.message); process.exit(1); });
