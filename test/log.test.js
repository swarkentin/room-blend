'use strict';
// Logging and /status: useful events, nothing private, status not public, clean shutdown.
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');
let n = 0; const ok = (s) => { n++; console.log('  ok  ' + s); };
const PORT = 4890, DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-log-'));
const until = async (fn, ms = 6000, what = 'condition') => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + what); await new Promise((r) => setTimeout(r, 50)); } };
const req = (method, p, body, headers = {}) => new Promise((resolve, reject) => {
  const data = body ? JSON.stringify(body) : null;
  const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
    let b = ''; res.on('data', (c) => b += c); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) { /* text */ } resolve({ status: res.statusCode, json: j, text: b }); });
  });
  r.on('error', reject); if (data) r.write(data); r.end();
});
const start = (env) => {
  const child = spawn('node', ['server.js'], { cwd: __dirname + '/..', env: { ...process.env, PORT, DATA_DIR: DIR, ...env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const out = { lines: [], err: [] }; let ob = '', eb = '';
  child.stdout.on('data', (c) => { ob += c; const p = ob.split('\n'); ob = p.pop(); out.lines.push(...p.filter(Boolean)); });
  child.stderr.on('data', (c) => { eb += c; const p = eb.split('\n'); eb = p.pop(); out.err.push(...p.filter(Boolean)); });
  return { child, out };
};
const events = (o) => o.lines.map((l) => JSON.parse(l));

(async () => {
  let { child, out } = start({ LOG_LEVEL: 'info' });
  await until(async () => { try { return (await req('GET', '/healthz')).status === 200; } catch (e) { return false; } }, 8000, 'server up');
  const created = await req('POST', '/api/rooms'); const code = created.json.code, hostKey = created.json.hostKey;
  const join = await req('POST', `/api/rooms/${code}/guests`, { name: 'Zebediah Quill', genres: ['jazz', 'blues'] });
  const guestKey = join.json.guestKey;
  await req('POST', `/api/rooms/${code}/host/extras`, { genre: 'jazz', pool: true, source: 'spotify', tracks: [{ title: 'A', artist: 'B', id: 'spotify:track:1', genres: ['jazz'] }] }, { 'x-host-key': hostKey });
  await req('GET', `/api/rooms/ZZZZZ`); await req('GET', `/api/rooms/${code}/events`); // a 404 and a 401
  await req('POST', `/api/rooms/${code}/host/library`, { provider: 'files', label: 'Mine', tracks: [{ id: '1', title: 'T', artist: 'A', genres: ['rock'] }] }, { 'x-host-key': hostKey });
  await until(() => events(out).some((e) => e.event === 'library.set'), 4000, 'library event');
  const ev = events(out), names = ev.map((e) => e.event);
  for (const want of ['server.start', 'room.created', 'guest.joined', 'pool.started', 'pool.received', 'library.set']) assert.ok(names.includes(want), 'missing ' + want + ' in ' + names.join(','));
  ok('server start, room created, guest joined, songs received from the service and a library set are all logged as JSON lines');
  assert.ok(ev.every((e) => e.t && e.level && e.event)); ok('every line has a time, a level and an event name');
  const blob = out.lines.join('\n') + out.err.join('\n');
  for (const secret of [code, hostKey, guestKey, 'Zebediah', 'Quill', '127.0.0.1']) assert.ok(!blob.includes(secret), 'log leaks ' + secret);
  assert.ok(!/jazz|blues/.test(blob.replace(/"genre":"jazz"/g, ''))); ok('logs hold no room code, key, guest name, address or picked genres');
  assert.ok(ev.find((e) => e.event === 'room.created').room.length === 8); ok('a room is identified by a short hash that cannot be used to join it');
  assert.ok(!names.includes('http.request')); ok('routine requests stay out of the info level (debug only)');
  assert.ok(ev.some((e) => e.event === 'http.denied' && e.status === 401 && e.route === '/api/rooms/:code/events')); ok('a denied request is logged with its route, with the room code replaced by :code');

  // ---- /status
  const s = await req('GET', '/status');
  assert.strictEqual(s.status, 200); assert.strictEqual(s.json.rooms.total, 1); assert.strictEqual(s.json.guestsInRooms, 1);
  assert.ok(s.json.counters['rooms.created'] === 1 && s.json.counters['guests.joined'] === 1 && s.json.counters['http.4xx'] >= 2);
  assert.ok(s.json.topGenres.jazz === 1 && s.json.topSources.spotify >= 1 && s.json.memoryMB.rss > 0 && s.json.timers.api_ms.count > 3);
  ok('/status reports rooms, guests, connections, counters, timings, memory and the most-picked genres');
  assert.strictEqual((await req('GET', '/status', null, { 'x-forwarded-for': '203.0.113.9' })).status, 404); ok('/status is hidden from anything that came through a proxy or tunnel');
  assert.strictEqual((await req('GET', '/healthz')).text, 'ok'); ok('/healthz still just answers ok');

  // ---- rate limiting is visible
  for (let i = 0; i < 90; i++) await req('GET', '/api/rooms/ZZZZZ');
  await until(() => out.err.some((l) => /"event":"rate.limited"/.test(l)), 4000, 'rate limit warning');
  const rl = out.err.map((l) => JSON.parse(l)).find((e) => e.event === 'rate.limited');
  assert.ok(rl.level === 'warn' && rl.visitor.length === 8 && rl.kind === 'requests'); ok('a rate-limited visitor is logged as a warning on stderr, by a short hash');

  // ---- shutting down saves the rooms
  child.send({ type: 'shutdown' });
  await new Promise((r) => child.on('exit', r));
  assert.ok(events(out).some((e) => e.event === 'server.stop'));
  assert.ok(JSON.parse(fs.readFileSync(path.join(DIR, 'rooms.json'), 'utf8')).rooms.some((r) => r.code === code)); ok('stopping the server gracefully logs it and saves the rooms first');

  // ---- STATUS_KEY, and silence
  ({ child, out } = start({ LOG_LEVEL: 'silent', STATUS_KEY: 'sekret-1' }));
  await until(async () => { try { return (await req('GET', '/healthz')).status === 200; } catch (e) { return false; } }, 8000, 'server up again');
  assert.strictEqual((await req('GET', '/status')).status, 404);
  assert.strictEqual((await req('GET', '/status?key=wrong')).status, 404);
  assert.strictEqual((await req('GET', '/status?key=sekret-1', null, { 'x-forwarded-for': '203.0.113.9' })).status, 200); ok('with STATUS_KEY set, /status needs the key and then works from anywhere');
  assert.strictEqual((await req('GET', '/status', null, { 'x-status-key': 'sekret-1' })).json.rooms.total, 1); ok('the key can also be sent as a header');
  child.send({ type: 'shutdown' }); await new Promise((r) => child.on('exit', r));
  assert.strictEqual(out.lines.length, 0); ok('LOG_LEVEL=silent writes nothing');
  console.log('\n' + n + ' checks passed'); process.exit(0);
})().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
