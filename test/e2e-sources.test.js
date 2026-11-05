'use strict';
// Browser tests for the library sources: real audio files picked from a folder, and a fake Subsonic/Navidrome server.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const { spawn, execFileSync } = require('child_process');
const { chromium } = require('playwright');

const APP_PORT = 4890, SUB_PORT = 4891, APP = 'http://127.0.0.1:' + APP_PORT;
let passed = 0; const ok = (s) => { passed++; console.log('  ok  ' + s); };
const until = async (fn, ms = 10000, what = 'condition') => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + what); await new Promise((r) => setTimeout(r, 100)); } };

// ---- real audio files, 1.5 s each ----
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-music-'));
const music = path.join(dir, 'Music', 'Album');
fs.mkdirSync(music, { recursive: true });
const SONGS = [
  ['rock1.mp3', 'libmp3lame', 'Rock One', 'Band A', 'Rock'], ['rock2.ogg', 'libvorbis', 'Rock Two', 'Band A', 'Alternative & Punk'],
  ['blues1.flac', 'flac', 'Blues One', 'Band B', 'Blues'], ['blues2.mp3', 'libmp3lame', 'Blues Two', 'Band B', 'Blues; Soul'],
  ['jazz1.ogg', 'libvorbis', 'Jazz One', 'Band C', 'Jazz'], ['mystery.mp3', 'libmp3lame', 'Mystery', 'Band D', ''],
];
let ffmpegAvailable = true;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); } catch { ffmpegAvailable = false; }
if (ffmpegAvailable) {
  SONGS.forEach(([f, codec, title, artist, genre], i) => {
    const args = ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${300 + i * 60}:duration=1.5`, '-c:a', codec, '-metadata', `title=${title}`, '-metadata', `artist=${artist}`];
    if (genre) args.push('-metadata', `genre=${genre}`);
    execFileSync('ffmpeg', [...args, path.join(music, f)]);
  });
} else {
  console.log('  skip local-file format checks: ffmpeg is not installed (install ffmpeg to run these checks)');
}
fs.writeFileSync(path.join(music, 'notes.txt'), 'not music');

// A tiny PCM WAV keeps the Subsonic streaming test independent of ffmpeg.
function makeWav() {
  const sampleRate = 44100, samples = Math.floor(sampleRate * 1.5), dataSize = samples * 2;
  const b = Buffer.alloc(44 + dataSize);
  b.write('RIFF', 0); b.writeUInt32LE(36 + dataSize, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22); b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples; i++) b.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / sampleRate) * 5000), 44 + i * 2);
  return b;
}
const WAV = ffmpegAvailable ? fs.readFileSync(path.join(music, 'rock1.mp3')) : makeWav();
const AUDIO_TYPE = ffmpegAvailable ? 'audio/mpeg' : 'audio/wav';

// ---- fake Subsonic / Navidrome ----
const subLog = { pings: 0, bad: 0, streams: [], searches: 0 };
const SUB = [
  { id: 's1', title: 'Server Rock', artist: 'Net A', genre: 'Rock' }, { id: 's2', title: 'Server Blues', artist: 'Net B', genre: 'Blues' },
  { id: 's3', title: 'Server Jazz', artist: 'Net C', genres: [{ name: 'Jazz' }] }, { id: 's4', title: 'Server Folk', artist: 'Net D', genre: 'Folk' }, { id: 's5', title: 'Untagged', artist: 'Net E' },
];
const sub = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), cors = { 'Access-Control-Allow-Origin': '*' };
  const authOk = () => u.searchParams.get('u') === 'dj' && u.searchParams.get('t') === crypto.createHash('md5').update('secret' + u.searchParams.get('s')).digest('hex');
  const json = (o) => { res.writeHead(200, { 'Content-Type': 'application/json', ...cors }); res.end(JSON.stringify({ 'subsonic-response': o })); };
  if (!authOk()) { subLog.bad++; return json({ status: 'failed', error: { code: 40, message: 'Wrong username or password' } }); }
  if (u.pathname === '/rest/ping.view') { subLog.pings++; return json({ status: 'ok', version: '1.16.1' }); }
  if (u.pathname === '/rest/search3.view') { subLog.searches++; const off = Number(u.searchParams.get('songOffset') || 0); return json({ status: 'ok', searchResult3: { song: off === 0 ? SUB : [] } }); }
  if (u.pathname === '/rest/stream.view') { subLog.streams.push(u.searchParams.get('id')); res.writeHead(200, { 'Content-Type': AUDIO_TYPE, 'Content-Length': WAV.length, ...cors }); return res.end(WAV); }
  res.writeHead(404, cors); res.end();
});

(async () => {
  await new Promise((r) => sub.listen(SUB_PORT, '127.0.0.1', r));
  const srv = spawn('node', ['server.js'], { cwd: __dirname + '/..', env: Object.assign({}, process.env, { PORT: APP_PORT, SPOTIFY_CLIENT_ID: '', DATA_DIR: path.join(os.tmpdir(), 'rb-src-' + Date.now()) }), stdio: ['ignore', 'ignore', 'inherit'] });
  await until(() => new Promise((r) => http.get(APP, () => r(true)).on('error', () => r(false))), 8000, 'server up');
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const errors = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
    await ctx.addInitScript(() => { window.__audios = []; const A = window.Audio; window.Audio = function (...a) { const x = new A(...a); window.__audios.push(x); return x; }; });
    const host = await ctx.newPage();
    host.on('pageerror', (e) => errors.push(e.message)); host.on('console', (m) => { if (m.type() === 'error' && !/fonts|ERR_|Failed to load resource|qrcode/.test(m.text())) errors.push(m.text()); });
    await host.route(/^https:\/\//, (r) => r.abort());
    const chooseSource = async (id) => {
      const settings = host.locator('#sp details.source-settings');
      if (!(await settings.evaluate((el) => el.open))) await settings.locator('summary').click();
      await host.click('[data-src="' + id + '"]');
    };
    const addGuest = async (name, genres) => {
      const guestDetails = host.locator('details:has(#add-form)');
      if (!(await guestDetails.evaluate((el) => el.open))) await guestDetails.locator('summary').click();
      await host.fill('#g-name', name);
      for (const g of genres) await host.click(`#picker [data-g="${g}"]`);
      await host.click('#add-form button[type=submit]');
    };
    const nowTitle = () => host.textContent('#now-title');
    const playingSrc = () => host.evaluate(() => { const a = window.__audios[window.__audios.length - 1]; return a && !a.paused && a.currentTime > 0 ? a.src : ''; });

    // ===== local files =====
    await host.goto(APP); await host.click('#start-room'); await host.waitForURL(/\/host\/[A-Z0-9]{5}$/);
    if (ffmpegAvailable) {
      await chooseSource('local');
      await host.waitForSelector('#loc-dir', { state: 'attached' });
      await host.setInputFiles('#loc-dir', path.join(dir, 'Music'));
      await host.waitForFunction(() => /Playing from your files/.test(document.querySelector('#sp').textContent), null, { timeout: 20000 });
      const panel = await host.textContent('#sp');
      assert.ok(/5 songs in the room/.test(panel) && /1 have no genre tag/.test(panel)); ok('folder scanned: 5 tagged songs found, the untagged one left out, notes.txt ignored');
      const sourceSettings = host.locator('#sp details.source-settings');
      if (!(await sourceSettings.evaluate((el) => el.open))) await sourceSettings.locator('summary').click();
      await host.selectOption('#loc-default', 'jazz');
      await host.waitForFunction(() => /6 songs in the room/.test(document.querySelector('#sp').textContent)); ok('untagged songs can be counted as a chosen genre');
      if (!(await sourceSettings.evaluate((el) => el.open))) await sourceSettings.locator('summary').click();
      await host.selectOption('#loc-default', '');
      await host.waitForFunction(() => /5 songs in the room/.test(document.querySelector('#sp').textContent));
  
      await addGuest('Maya', ['rock']);
      const t1 = await until(async () => { const t = await nowTitle(); return /^(Rock|Blues|Jazz|Mystery)/.test(t) ? t : ''; }, 12000, 'first local song');
      assert.ok(/^Rock/.test(t1), 'a rock fan should hear rock first, got ' + t1); ok('a rock fan is played a rock file from the library: ' + t1);
      const src1 = await until(playingSrc, 12000, 'audio element playing');
      assert.ok(src1.startsWith('blob:')); ok('the browser is really playing the local file (blob audio, currentTime advancing)');
      await until(async () => (await nowTitle()) !== t1, 12000, 'advance on natural end');
      ok('when the file ends, the next song starts by itself: ' + await nowTitle());
      assert.ok(!(await host.textContent('#queue')).includes('Mr. Brightside')); ok('the queue comes only from the host\'s files, not the built-in list');
      const next = await host.textContent('#queue .qrow:first-child .listen').catch(() => '');
      ok('"Find it" links are hidden while playing from files: ' + (next === '' ? 'yes' : 'no'));
    }


    // ===== switch to Navidrome / Subsonic =====
    await chooseSource('subsonic');
    await host.fill('#sub-url', 'http://127.0.0.1:' + SUB_PORT); await host.fill('#sub-user', 'dj'); await host.fill('#sub-pass', 'wrong');
    await host.click('#sub-go');
    await host.waitForFunction(() => /Wrong username or password/.test(document.querySelector('#sp').textContent));
    ok('a wrong password shows the server\'s message');
    await host.fill('#sub-pass', 'secret'); await host.click('#sub-go');
    await host.waitForFunction(() => /Playing from your music server/.test(document.querySelector('#sp').textContent), null, { timeout: 15000 }).catch(async (e) => { console.log('PANEL:', (await host.textContent('#sp')).slice(0, 600), 'LOG', JSON.stringify(subLog), errors); throw e; });
    assert.ok(/4 songs in the room/.test(await host.textContent('#sp'))); assert.strictEqual(subLog.bad, 1); ok('Subsonic token login works (md5 salt/token verified by the server); 4 tagged songs loaded');
    // The local-file section is skipped without ffmpeg, so create the guest here too.
    if (!ffmpegAvailable) await addGuest('Maya', ['rock']);
    const t2 = await until(async () => { const t = await nowTitle(); return /^Server/.test(t) ? t : ''; }, 12000, 'first server song');
    ok('now playing from the server library: ' + t2);
    await until(() => subLog.streams.length >= 1, 8000, 'stream request');
    ok('the browser streams the song from the server by id: ' + subLog.streams[0]);
    await until(playingSrc, 8000, 'server audio playing');
    await until(async () => (await nowTitle()) !== t2, 12000, 'advance after server song');
    ok('server song ends and the next one starts');

    // ===== sync: a song added on the server appears without reconnecting, and the playing song is not interrupted =====
    const before = await nowTitle();
    SUB.push({ id: 's6', title: 'Server Soul', artist: 'Net F', genre: 'Soul' });
    const sourceSettings = host.locator('#sp details.source-settings');
    if (!(await sourceSettings.evaluate((el) => el.open))) await sourceSettings.locator('summary').click();
    await host.click('#sub-sync');
    await host.waitForFunction(() => /5 songs in the room/.test(document.querySelector('#sp').textContent), null, { timeout: 10000 });
    assert.strictEqual(await nowTitle(), before); ok('Sync now picks up a song added on the server (5 songs) and keeps the current song playing');
    assert.ok(/Synced/.test(await host.textContent('#sp'))); ok('the panel says when it last synced');

    // ===== switching to a curated source clears the library =====
    await chooseSource('spotify');
    await until(async () => (await host.textContent('#queue')).trim() && !/Server /.test(await host.textContent('#queue')), 8000, 'curated queue');
    ok('choosing Spotify (not connected) returns to the built-in list');
    assert.deepStrictEqual(errors, [], 'page errors: ' + errors.join(' | ')); ok('no page errors');
  } finally { await browser.close(); srv.kill(); sub.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  console.log('\n' + passed + ' checks passed'); process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e.stack || e.message); process.exit(1); });
