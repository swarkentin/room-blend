'use strict';
// Browser test for the shared YouTube catalogue, against a FAKE YouTube. Two hosts with separate browsers (so separate IndexedDB):
// the second one must find the first one's discoveries on the server instead of spending YouTube quota again.
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
const log = { plSearches: [], plItems: 0, videoCalls: 0 };
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
    // ---- host A discovers jazz and plays two songs ----
    const a = await startHost(browser, errors, toApp);
    assert.strictEqual(await a.evaluate(() => window.CONFIG.catalog), true); ok('the server tells browsers the shared catalogue exists');
    await play(a);
    const poolA = await a.evaluate(() => window.Providers.get('youtube').extras('jazz', []));
    assert.ok(poolA.length >= 12 && log.plSearches.includes('jazz songs') && log.plItems === 1 && log.videoCalls === 1); ok('host A paid for the jazz playlist once: ' + poolA.length + ' songs');
    const shared = await until(async () => { const j = await catalog(a, 'POST', 'get', { pools: ['jazz'] }); return j.pools && j.pools['jazz'] && j.pools['jazz'].length >= 12 ? j : null; }, 8000, 'pool reached the server');
    assert.ok(shared.pools['jazz'].every((s) => s.genres.includes('jazz'))); ok('the playlist reached the shared catalogue, tagged with the genre it stands for');

    await a.evaluate(() => { window.__ytFail = 'all'; });
    assert.strictEqual(await a.evaluate(() => window.Providers.get('youtube').play({ title: 'Take Five', artist: 'Dave Brubeck', nid: 'plA1' })), null);
    await a.evaluate(() => { window.__ytFail = ''; });
    assert.strictEqual(await a.evaluate(() => window.Providers.get('youtube').play({ title: 'Feeling Good', artist: 'Nina Simone', nid: 'plA2', genres: ['jazz'] })), true);
    const q = await until(async () => { const j = await catalog(a, 'POST', 'get', { quality: ['plA1', 'plA2'] }); return j.quality.plA1 && j.quality.plA2 ? j.quality : null; }, 8000, 'feedback reached the server');
    assert.deepStrictEqual(q.plA1, { successes: 0, failures: 1 }); assert.deepStrictEqual(q.plA2, { successes: 1, failures: 0 }); ok('a failed and a successful play were counted on the server');

    // ---- host B has an empty browser and a different room ----
    const searchesBefore = log.plSearches.length, itemsBefore = log.plItems, videosBefore = log.videoCalls;
    const b = await startHost(browser, errors, toApp);
    await play(b);
    const poolB = await b.evaluate(() => window.Providers.get('youtube').extras('jazz', []));
    assert.ok(poolB.length >= 12); ok('host B, with an empty browser, got ' + poolB.length + ' jazz songs');
    assert.strictEqual(log.plSearches.length, searchesBefore); assert.strictEqual(log.plItems, itemsBefore); assert.strictEqual(log.videoCalls, videosBefore); ok('and spent no YouTube quota to get them');
    assert.ok(poolB.findIndex((t) => t.id === 'plA1') > poolB.findIndex((t) => t.id === 'plA2'), 'host A\'s failed video ranks below host A\'s good one for host B'); ok('a video that failed for host A is ranked down for host B');
    const local = await b.evaluate(() => new Promise((resolve) => { const r = indexedDB.open('room-blend-youtube'); r.onsuccess = () => { const g = r.result.transaction('entries').objectStore('entries').get('pool:jazz'); g.onsuccess = () => resolve(!!g.result); }; }));
    assert.strictEqual(local, true); ok('the pool is now also cached in host B\'s own browser');
    const lookup = await b.evaluate(() => window.Providers.get('youtube').play({ title: 'Nina Simone', artist: 'Feeling Good' }));
    assert.ok(lookup === true || lookup === null);

    // ---- host C already has a local cache from before the server had a catalogue ----
    const c = await startHost(browser, errors, toApp);
    await c.waitForFunction(() => indexedDB.databases().then((d) => d.some((x) => x.name === 'room-blend-youtube')), null, { timeout: 8000 });
    await c.evaluate(() => new Promise((resolve, reject) => {
      const r = indexedDB.open('room-blend-youtube');
      r.onsuccess = () => {
        const tx = r.result.transaction('entries', 'readwrite'), s = tx.objectStore('entries'), now = Date.now(), exp = now + 86400000;
        s.put({ id: 'pool:garage rock', kind: 'pool', value: [{ title: 'Old Song', artist: 'Old Band', id: 'impA0000001', genres: ['rock'], quality: 1 }], at: now, usedAt: now, expiresAt: exp });
        s.put({ id: 'search:old song|old band', kind: 'search', value: ['impA0000001'], at: now, usedAt: now, expiresAt: exp });
        s.put({ id: 'quality:impA0000001', kind: 'quality', value: { successes: 3, failures: 0 }, at: now, usedAt: now, expiresAt: exp });
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
      };
    }));
    await play(c);
    const imported = await until(async () => { const j = await catalog(c, 'POST', 'get', { pools: ['garage rock'], searches: ['old song|old band'], quality: ['impA0000001'] }); return j.pools['garage rock'] && j.searches['old song|old band'] && j.quality.impA0000001 ? j : null; }, 8000, 'import reached the server');
    assert.deepStrictEqual(imported.searches['old song|old band'], ['impA0000001']);
    assert.deepStrictEqual(imported.quality.impA0000001, { successes: 3, failures: 0 }); ok('a browser\'s older local catalogue is handed to the server once');
    assert.strictEqual(await c.evaluate(() => localStorage.getItem('rb-yt-shared-import-v1')), 'done');
    await c.waitForFunction(() => /Shared by all hosts: \d+ songs/.test(document.querySelector('#yt-catalogue-status').textContent), null, { timeout: 8000 }); ok('the YouTube panel shows what the shared catalogue holds');

    // ---- the server stays unaware of the key ----
    assert.ok(toApp.length > 10 && !toApp.some((x) => x.includes('AIzaFakeKey'))); ok('the API key never reaches the Room Blend server (' + toApp.length + ' requests checked)');
    assert.deepStrictEqual(errors, [], 'page errors: ' + errors.join(' | ')); ok('no page errors');
  } finally { await browser.close(); srv.kill(); yt.close(); }
  console.log('\n' + passed + ' checks passed'); process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e.stack || e.message); process.exit(1); });
