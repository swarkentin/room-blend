'use strict';
// Browser test for the shared YouTube catalogue, against a FAKE YouTube. Hosts have separate browsers (so separate IndexedDB).
// What is shared is song lookups and video quality, and only once different rooms agree; playlists stay in each host's browser.
const http = require('http');
const assert = require('assert');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const { chooseSource } = require('./helpers/source-settings');

const APP_PORT = 4897, YT_PORT = 4898, APP = 'http://127.0.0.1:' + APP_PORT, YT = 'http://127.0.0.1:' + YT_PORT;
const GOOD = 'AIzaFakeKey_0123456789abcdefghijklmnopqrs';
let passed = 0; const ok = (s) => { passed++; console.log('  ok  ' + s); };
const until = async (fn, ms = 10000, what = 'condition') => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + what); await new Promise((r) => setTimeout(r, 100)); } };

const VIDEOS = {}, PLITEMS = [];
const addVid = (id, title, channel, dur) => { VIDEOS[id] = { id, snippet: { title, channelTitle: channel }, contentDetails: { duration: dur }, status: { embeddable: true, privacyStatus: 'public' } }; PLITEMS.push({ snippet: { title, resourceId: { videoId: id } } }); };
addVid('plA1', 'Dave Brubeck - Take Five (Official Audio)', 'Dave Brubeck', 'PT5M24S');
addVid('plA2', 'Nina Simone - Feeling Good', 'NinaSimoneVEVO', 'PT2M55S');
for (let i = 0; i < 14; i++) addVid('plB' + i, 'Pool Artist ' + i + ' - Pool Tune ' + i + ' (Official Video)', 'Pool Artist ' + i, 'PT3M30S');
const log = { plSearches: [], plItems: 0, videoCalls: 0, searches: [] };
const slug = (q) => q.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 14).padEnd(6, 'x');
const IFRAME_API = `
window.__ytLog = [];
window.YT = { Player: function (id, opts) {
  var self = this; setTimeout(function () { opts.events.onReady({}); }, 20);
  self.loadVideoById = function (v) { window.__ytLog.push(v);
    if (window.__ytFail === 'all') { setTimeout(function () { opts.events.onError({ data: 150 }); }, 30); return; } setTimeout(function () { opts.events.onStateChange({ data: 1 }); }, 30); };
  self.pauseVideo = function () {}; self.playVideo = function () {}; self.stopVideo = function () {};
  self.getCurrentTime = function () { return 35; }; self.getDuration = function () { return 180; };
} };
setTimeout(function () { if (window.onYouTubeIframeAPIReady) window.onYouTubeIframeAPIReady(); }, 10);`;
const yt = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' }); res.end(body); };
  if (u.pathname === '/iframe_api') return send(200, 'application/javascript', IFRAME_API);
  if (u.pathname === '/youtube/v3/search' && u.searchParams.get('type') === 'playlist') {
    const q = u.searchParams.get('q'); log.plSearches.push(q);
    return send(200, 'application/json', JSON.stringify({ items: q === 'jazz songs' ? [{ id: { playlistId: 'PLjazz' }, snippet: { title: 'Best Jazz Songs' } }] : [] }));
  }
  if (u.pathname === '/youtube/v3/playlistItems') { log.plItems++; return send(200, 'application/json', JSON.stringify({ items: PLITEMS })); }
  if (u.pathname === '/youtube/v3/videos') { log.videoCalls++; return send(200, 'application/json', JSON.stringify({ items: u.searchParams.get('id').split(',').map((i) => VIDEOS[i]).filter(Boolean) })); }
  if (u.pathname === '/youtube/v3/search') {
    const q = u.searchParams.get('q'); log.searches.push(q);
    return send(200, 'application/json', JSON.stringify({ items: [{ id: { videoId: 'sv_' + slug(q) }, snippet: { title: q + ' (Official Audio)', channelTitle: 'Artist - Topic' } }] }));
  }
  send(404, 'text/plain', 'no');
});

// Calls the shared catalogue the way the page does: as the room's host.
const catalog = (page, method, path, body) => page.evaluate(async ([method, path, body]) => {
  const h = window.RoomBlendHost;
  const r = await fetch('/api/catalog/' + path, { method, headers: { 'Content-Type': 'application/json', 'x-room-code': h.code, 'x-host-key': h.headers['x-host-key'] }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
}, [method, path, body]);

async function startHost(browser, errors, toApp) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } }); // a new context is a new IndexedDB: a different host
  const page = await ctx.newPage();
  page.on('request', (r) => { if (r.url().startsWith(APP)) toApp.push(r.url() + ' ' + (r.postData() || '') + JSON.stringify(r.headers())); });
  page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/fonts|ERR_|Failed to load resource|qrcode|400|403/.test(m.text())) errors.push(m.text()); });
  await page.route(/^https:\/\//, (r) => r.abort());
  await page.goto(APP); await page.click('#start-room'); await page.waitForURL(/\/host\/[A-Z0-9]{5}$/);
  await chooseSource(page, 'youtube');
  await page.fill('#yt-key', GOOD); await page.click('#yt-save');
  await page.waitForSelector('#yt-start');
  return page;
}
const play = async (page) => { await page.click('#yt-start'); await page.waitForFunction(() => /Playing through YouTube/.test(document.querySelector('#sp').textContent), null, { timeout: 10000 }); };

(async () => {
  await new Promise((r) => yt.listen(YT_PORT, '127.0.0.1', r));
  const srv = spawn('node', ['server.js'], { cwd: __dirname + '/..', env: Object.assign({}, process.env, { PORT: APP_PORT, SPOTIFY_CLIENT_ID: '', DATABASE_URL: 'memory://e2e-catalog', SESSION_SECRET: 'e2e-catalog-secret-0123456789abcdef', MUSICBRAINZ_SEARCH_DISABLED: '1', YOUTUBE_API_BASE: YT + '/youtube/v3', YOUTUBE_IFRAME_URL: YT + '/iframe_api', YOUTUBE_API_INTERVAL_MS: '50' }), stdio: ['ignore', 'ignore', 'inherit'] });
  await until(() => new Promise((r) => http.get(APP, () => r(true)).on('error', () => r(false))), 8000, 'server up');
  const browser = await chromium.launch();
  const errors = [], toApp = [];
  try {
    const song = { title: 'Take Five', artist: 'Dave Brubeck' }, KEY = 'take five|dave brubeck';
    const playSong = (page, t) => page.evaluate((t) => window.Providers.get('youtube').play(t), t);
    const loaded = (page) => page.evaluate(() => window.__ytLog.slice());

    // ---- hosts A and B each pay for the same lookup, and play it ----
    const a = await startHost(browser, errors, toApp);
    assert.strictEqual(await a.evaluate(() => window.CONFIG.catalog), true); ok('the server tells browsers the shared catalogue exists');
    await play(a);
    assert.strictEqual(await playSong(a, song), true);
    const idA = (await loaded(a)).pop();
    assert.strictEqual(log.searches.length, 1); ok('host A found the song with a YouTube search: ' + idA);
    const afterA = await catalog(a, 'POST', 'get', { searches: [KEY], quality: [idA] });
    assert.deepStrictEqual(afterA.searches, {}); assert.deepStrictEqual(afterA.quality[idA], { successes: 1, failures: 0 }); ok('one room is not enough to share a lookup, but its play is counted');

    const b = await startHost(browser, errors, toApp);
    await play(b);
    assert.strictEqual(await playSong(b, song), true);
    assert.strictEqual(log.searches.length, 2); ok('host B had to search too, since no lookup was confirmed yet');
    const confirmed = await until(async () => { const j = await catalog(b, 'POST', 'get', { searches: [KEY] }); return j.searches[KEY] ? j : null; }, 8000, 'lookup confirmed');
    assert.deepStrictEqual(confirmed.searches[KEY], [idA]); ok('a second room playing the same video confirms the lookup');

    // ---- host C, a brand new browser, uses it without any YouTube search ----
    const c = await startHost(browser, errors, toApp);
    await play(c);
    assert.strictEqual(await playSong(c, song), true);
    assert.strictEqual(log.searches.length, 2); assert.deepStrictEqual(await loaded(c), [idA]); ok('host C played the confirmed video with no YouTube search quota spent');

    // ---- quality: a video that fails is ranked down for everyone ----
    await c.evaluate(() => { window.__ytFail = 'all'; });
    assert.strictEqual(await playSong(c, { title: 'Feeling Good', artist: 'Nina Simone', nid: 'badVid12345' }), null);
    await c.evaluate(() => { window.__ytFail = ''; });
    const q = await until(async () => { const j = await catalog(a, 'POST', 'get', { quality: ['badVid12345'] }); return j.quality.badVid12345 ? j.quality : null; }, 8000, 'failure counted');
    assert.deepStrictEqual(q.badVid12345, { successes: 0, failures: 1 }); ok('a failed play is counted for every host');

    // ---- playlists and song lists are NOT shared ----
    const before = log.plSearches.length;
    assert.ok((await a.evaluate(() => window.Providers.get('youtube').extras('jazz', []))).length >= 12);
    assert.ok((await b.evaluate(() => window.Providers.get('youtube').extras('jazz', []))).length >= 12);
    assert.ok(log.plSearches.length > before && log.plItems >= 2); ok('each host reads its own genre playlists: they are not shared');
    assert.deepStrictEqual(await catalog(a, 'POST', 'get', { pools: ['jazz'] }), { searches: {}, quality: {} }); ok('the server holds no playlists');
    await c.waitForFunction(() => /Shared by all hosts: \d+ confirmed song lookups/.test(document.querySelector('#yt-catalogue-status').textContent), null, { timeout: 8000 }); ok('the YouTube panel shows what the shared catalogue holds');

    // ---- the server stays unaware of the key ----
    assert.ok(toApp.length > 10 && !toApp.some((x) => x.includes('AIzaFakeKey'))); ok('the API key never reaches the Room Blend server (' + toApp.length + ' requests checked)');
    assert.deepStrictEqual(errors, [], 'page errors: ' + errors.join(' | ')); ok('no page errors');
  } finally { await browser.close(); srv.kill(); yt.close(); }
  console.log('\n' + passed + ' checks passed'); process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e.stack || e.message); process.exit(1); });
