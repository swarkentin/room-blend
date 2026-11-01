'use strict';
// Browser test for the YouTube source against a FAKE YouTube (Data API search + IFrame player API).
// It proves the wiring. It does not prove the real YouTube accepts a given key or allows a given video.
const http = require('http');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const APP_PORT = 4895, YT_PORT = 4896, APP = 'http://127.0.0.1:' + APP_PORT, YT = 'http://127.0.0.1:' + YT_PORT;
const GOOD = 'AIzaFakeKey_0123456789abcdefghijklmnopqrs'; // 39 characters
let passed = 0; const ok = (s) => { passed++; console.log('  ok  ' + s); };
const until = async (fn, ms = 10000, what = 'condition') => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + what); await new Promise((r) => setTimeout(r, 100)); } };

const log = { searches: [], badKey: 0 };
let quotaOut = false;
const IFRAME_API = `
window.__ytLog = [];
window.YT = { Player: function (id, opts) {
  var self = this; window.__ytPlayer = self; window.__ytOpts = opts;
  setTimeout(function () { opts.events.onReady({}); }, 20);
  self.loadVideoById = function (v) { window.__ytLog.push(v); if (window.__ytBlock) return; setTimeout(function () { opts.events.onStateChange({ data: 1 }); }, 30); };
  self.pauseVideo = function () { window.__ytPaused = true; }; self.playVideo = function () { window.__ytPaused = false; }; self.stopVideo = function () {};
} };
setTimeout(function () { if (window.onYouTubeIframeAPIReady) window.onYouTubeIframeAPIReady(); }, 10);`;
const yt = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' }); res.end(body); };
  if (u.pathname === '/iframe_api') return send(200, 'application/javascript', IFRAME_API);
  if (u.pathname === '/youtube/v3/search') {
    if (u.searchParams.get('key') !== GOOD) { log.badKey++; return send(400, 'application/json', JSON.stringify({ error: { code: 400, errors: [{ reason: 'keyInvalid' }] } })); }
    if (quotaOut) return send(403, 'application/json', JSON.stringify({ error: { code: 403, errors: [{ reason: 'quotaExceeded' }] } }));
    const q = u.searchParams.get('q'); log.searches.push(q);
    if (/Nowhere/.test(q)) return send(200, 'application/json', JSON.stringify({ items: [] }));
    return send(200, 'application/json', JSON.stringify({ items: [{ id: { videoId: 'vid' + log.searches.length } }] }));
  }
  send(404, 'text/plain', 'no');
});

(async () => {
  await new Promise((r) => yt.listen(YT_PORT, '127.0.0.1', r));
  const srv = spawn('node', ['server.js'], { cwd: __dirname + '/..', env: Object.assign({}, process.env, { PORT: APP_PORT, SPOTIFY_CLIENT_ID: '', DATA_DIR: path.join(os.tmpdir(), 'rb-yt-' + Date.now()), YOUTUBE_API_BASE: YT + '/youtube/v3', YOUTUBE_IFRAME_URL: YT + '/iframe_api' }), stdio: ['ignore', 'pipe', 'inherit'] });
  await until(() => new Promise((r) => http.get(APP, () => r(true)).on('error', () => r(false))), 8000, 'server up');
  const browser = await chromium.launch();
  const errors = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
    const host = await ctx.newPage();
    const toApp = []; host.on('request', (r) => { if (r.url().startsWith(APP)) toApp.push(r.url() + ' ' + (r.postData() || '') + JSON.stringify(r.headers())); });
    host.on('pageerror', (e) => errors.push(e.message)); host.on('console', (m) => { if (m.type() === 'error' && !/fonts|ERR_|Failed to load resource|qrcode|400|403/.test(m.text())) errors.push(m.text()); });
    await host.route(/^https:\/\//, (r) => r.abort());
    await host.goto(APP); await host.click('#start-room'); await host.waitForURL(/\/host\/[A-Z0-9]{5}$/);
    const nowTitle = () => host.textContent('#now-title');

    assert.strictEqual((await host.$$('.src')).length, 7); ok('YouTube is offered alongside the other sources');
    await host.click('[data-src="youtube"]');
    assert.ok(/free Google API key/.test(await host.textContent('#sp'))); ok('without a key it explains how to get a free one');
    assert.ok(/not.*restrict it to websites/i.test(await host.textContent('#sp')) || /Do not restrict it to websites/.test(await host.textContent('#sp'))); ok('it warns against a website restriction, since Room Blend sends no referrer');
    await host.fill('#yt-key', 'short'); await host.click('#yt-save');
    assert.ok(/does not look like an API key/.test(await host.textContent('#yt-msg'))); ok('an obviously wrong key is refused');

    await host.fill('#yt-key', GOOD); await host.click('#yt-save');
    await host.waitForSelector('#yt-start');
    assert.strictEqual(await host.evaluate(() => localStorage.getItem('rb-yt-key')), GOOD); ok('the key is saved in this browser only');
    assert.ok(!(await host.evaluate(() => document.cookie)).includes('AIza')); ok('the key is not in a cookie');

    await host.click('#yt-start');
    await host.waitForFunction(() => /Playing through YouTube/.test(document.querySelector('#sp').textContent), null, { timeout: 10000 });
    assert.strictEqual(await host.isVisible('#yt-dock'), true); ok('the player dock is visible while it plays (YouTube requires that)');

    await host.fill('#g-name', 'Maya'); await host.click('#picker [data-g="rock"]'); await host.click('#add-form button[type=submit]');
    const t1 = await until(async () => { const t = await nowTitle(); return t && t !== 'Nothing yet' ? t : ''; }, 12000, 'first song');
    const id1 = await until(() => host.evaluate(() => window.__ytLog[0]), 8000, 'a video was loaded');
    assert.ok(/^vid\d+$/.test(id1)); ok('a song was looked up and loaded into the player: ' + t1 + ' -> ' + id1);
    assert.ok(log.searches[0].includes(t1.split(' (')[0])); ok('the search used the song title and artist');

    // let the guest finish settling in (4 s) so the queue is stable, then end whatever is playing
    await new Promise((r) => setTimeout(r, 5500));
    const t2 = await nowTitle();
    await host.evaluate(() => window.__ytOpts.events.onStateChange({ data: 0 }));
    await until(async () => (await nowTitle()) !== t2, 10000, 'advance after video ends');
    ok('when the video ends, the next song starts: ' + await nowTitle());
    await until(() => host.evaluate(() => window.__ytLog.length >= 2), 8000, 'second video loaded');

    // repeats are remembered, so they cost no quota
    const cached = await host.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('rb-yt-cache') || '{}')).length);
    assert.ok(cached >= 2); ok('looked-up songs are remembered in the browser (' + cached + ' so far), so repeats cost no search quota');

    // an embedding error skips the song
    const before = await nowTitle();
    await host.evaluate(() => { window.__ytBlock = false; });
    await host.evaluate(() => window.__ytOpts.events.onError({ data: 150 }));
    await until(async () => (await nowTitle()) !== before, 10000, 'skip after embed error');
    ok('a video that cannot be embedded is skipped');

    // quota exhausted: a clear message, and playback does not crash
    await new Promise((r) => setTimeout(r, 1500));
    quotaOut = true;
    await host.evaluate(() => window.__ytOpts.events.onStateChange({ data: 0 }));
    await host.waitForFunction(() => /allowance is used up/.test(document.querySelector('#sp').textContent), null, { timeout: 10000 });
    ok('when the free daily allowance is used up, the host is told plainly');
    quotaOut = false;

    // switching away hides the player; removing the key forgets it
    await host.click('[data-src="manual"]');
    assert.strictEqual(await host.isVisible('#yt-dock'), false); ok('choosing another source hides the player');
    await host.click('[data-src="youtube"]');
    await host.click('#yt-forget');
    await host.waitForSelector('#yt-key');
    assert.strictEqual(await host.evaluate(() => localStorage.getItem('rb-yt-key')), null); ok('Remove key forgets the key');

    // the server never receives the key
    assert.ok(toApp.length > 10 && !toApp.some((x) => x.includes('AIzaFakeKey'))); ok('the API key never reaches the Room Blend server (' + toApp.length + ' requests checked)');
    assert.deepStrictEqual(errors, [], 'page errors: ' + errors.join(' | ')); ok('no page errors');
  } finally { await browser.close(); srv.kill(); yt.close(); }
  console.log('\n' + passed + ' checks passed'); process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e.stack || e.message); process.exit(1); });
