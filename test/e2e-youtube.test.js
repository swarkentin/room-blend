'use strict';
// Browser test for the YouTube source against a FAKE YouTube (Data API search + IFrame player API).
// It proves the wiring. It does not prove the real YouTube accepts a given key or allows a given video.
const http = require('http');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const { openSourceSettings, chooseSource } = require('./helpers/source-settings');

const APP_PORT = 4895, YT_PORT = 4896, APP = 'http://127.0.0.1:' + APP_PORT, YT = 'http://127.0.0.1:' + YT_PORT, TEST_API_INTERVAL_MS = 100;
const GOOD = 'AIzaFakeKey_0123456789abcdefghijklmnopqrs'; // 39 characters
let passed = 0; const ok = (s) => { passed++; console.log('  ok  ' + s); };
const until = async (fn, ms = 10000, what = 'condition') => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + what); await new Promise((r) => setTimeout(r, 100)); } };
const cacheRecords = (page) => page.evaluate(async () => {
  const databases = await indexedDB.databases();
  if (!databases.some((item) => item.name === 'room-blend-youtube')) return null;
  const request = indexedDB.open('room-blend-youtube');
  const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  if (!db.objectStoreNames.contains('entries')) { db.close(); throw new Error('The app YouTube cache database is missing its entries object store'); }
  return await new Promise((resolve, reject) => { const tx = db.transaction('entries', 'readonly'), r = tx.objectStore('entries').getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
});

const cacheRecord = async (page, id) => {
  const records = await cacheRecords(page);
  return records && records.find((record) => record.id === id);
};

const log = { searches: [], badKey: 0, params: [], plSearches: [], chSearches: [], handles: [], plItems: 0, videoCalls: 0, rateLimited: 0, apiRequests: 0, apiAt: [] };
let quotaOut = false, rateLimitQuotaOut = false, poolOn = false, rateLimitVideoSearches = 0;
// a playlist of song videos for "jazz songs": three good ones, 14 filler songs, and entries that must be filtered out
const VIDEOS = {}, PLITEMS = [];
const addVid = (id, title, channel, dur, emb = true) => { VIDEOS[id] = { id, snippet: { title, channelTitle: channel }, contentDetails: { duration: dur }, status: { embeddable: emb, privacyStatus: 'public' } }; PLITEMS.push({ snippet: { title, resourceId: { videoId: id } } }); };
addVid('plA1', 'Dave Brubeck - Take Five (Official Audio)', 'Dave Brubeck', 'PT5M24S');
addVid('plA2', 'Nina Simone - Feeling Good', 'NinaSimoneVEVO', 'PT2M55S');
addVid('plA3', 'Jazz Classics Full Album 2 hours', 'Jazz Radio', 'PT2H0M0S');
addVid('plA4', 'Ella Fitzgerald - Cheek to Cheek (Live)', 'Ella', 'PT4M0S');
addVid('plA5', 'Blocked Artist - Blocked Song', 'Blocked', 'PT3M0S', false);
addVid('plA6', 'So What', 'Miles Davis - Topic', 'PT9M22S');
addVid('plA7', 'Dave Brubeck - Take Five (Cover Version)', 'Fan Covers', 'PT5M24S');
addVid('plA8', 'Nina Simone - Feeling Good (Official Remix)', 'Remix Channel', 'PT2M55S');
addVid('plA9', 'Ella Fitzgerald - Cheek to Cheek (Lyric Video)', 'Fan Lyrics', 'PT4M0S');
for (let i = 0; i < 14; i++) addVid('plB' + i, 'Pool Artist ' + i + ' - Pool Tune ' + i + ' (Official Video)', 'Pool Artist ' + i, 'PT3M30S');
const CHAN = 'UCdjcrocs0123456789abcde', CITEMS = [['chC1', 'Sock Hop Anthem', 'Some melodic #dawless #jungle played on the #mc707 #minifreak.\n\n#synth #electronicmusic #vibes #junglemusic #dub #idm #club #music'], ['chC2', 'DJ Crocs n Socks - Slide Into Friday', '#techno #technomusic #synth'], ['chC3', 'Night Drive (Remix)', 'Late one.']].map(([id, title, description]) => { VIDEOS[id] = { id, snippet: { title, description, channelTitle: 'DJ Crocs n Socks' }, contentDetails: { duration: id === 'chC3' ? 'PT12M5S' : 'PT3M20S' }, status: { embeddable: true, privacyStatus: 'public' } }; return { snippet: { title, resourceId: { videoId: id } } }; });
const ZITEMS = [['plZ1', 'Zed Obscure - Zed Song One'], ['plZ2', 'Zed Obscure - Zed Song Two'], ['plZ3', 'Someone Else - Not Zed']].map(([id, title]) => { VIDEOS[id] = { id, snippet: { title, channelTitle: title.split(' - ')[0] }, contentDetails: { duration: 'PT3M10S' }, status: { embeddable: true, privacyStatus: 'public' } }; return { snippet: { title, resourceId: { videoId: id } } }; });
PLITEMS.push({ snippet: { title: 'Private video', resourceId: { videoId: 'plPriv' } } });
const SMALLITEMS = PLITEMS.slice(0, 6);
const IFRAME_API = `
window.__ytLog = [];
window.__ytCurrentTime = 35; window.__ytDuration = 180;
window.YT = { Player: function (id, opts) {
  var self = this; window.__ytPlayer = self; window.__ytOpts = opts;
  setTimeout(function () { opts.events.onReady({}); }, 20);
  self.loadVideoById = function (v) { window.__ytLog.push(v); if (window.__ytBlock) return;
    if (window.__ytFail === 'all' || (window.__ytFail === 'first' && !/_a$/.test(v))) { setTimeout(function () { opts.events.onError({ data: 150 }); }, 30); return; } setTimeout(function () { opts.events.onStateChange({ data: 1 }); }, 30); };
  self.pauseVideo = function () { window.__ytPaused = true; }; self.playVideo = function () { window.__ytPaused = false; }; self.stopVideo = function () {};
  self.getCurrentTime = function () { return window.__ytCurrentTime; }; self.getDuration = function () { return window.__ytDuration; };
} };
setTimeout(function () { if (window.onYouTubeIframeAPIReady) window.onYouTubeIframeAPIReady(); }, 10);`;
const yt = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' }); res.end(body); };
  if (u.pathname === '/iframe_api') return send(200, 'application/javascript', IFRAME_API);
  if (u.pathname.startsWith('/youtube/v3/')) { log.apiRequests++; log.apiAt.push(Date.now()); }
  if (u.pathname.startsWith('/youtube/v3/') && u.searchParams.get('key') !== GOOD) { log.badKey++; return send(400, 'application/json', JSON.stringify({ error: { code: 400, errors: [{ reason: 'keyInvalid' }] } })); }
  if (u.pathname.startsWith('/youtube/v3/') && rateLimitQuotaOut) {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Retry-After': '60' });
    return res.end(JSON.stringify({ error: { code: 429, errors: [{ reason: 'userRateLimitExceeded' }] } }));
  }
  if (u.pathname.startsWith('/youtube/v3/') && quotaOut) return send(403, 'application/json', JSON.stringify({ error: { code: 403, errors: [{ reason: 'quotaExceeded' }] } }));
  if (u.pathname === '/youtube/v3/channels') {
    const h = u.searchParams.get('forHandle'); log.handles.push(h);
    return send(200, 'application/json', JSON.stringify({ items: h === '@djcrocsnsocks' ? [{ contentDetails: { relatedPlaylists: { uploads: 'UU' + CHAN.slice(2) } } }] : [] }));
  }
  if (u.pathname === '/youtube/v3/search' && u.searchParams.get('type') === 'channel') {
    const q = u.searchParams.get('q'); log.chSearches.push(q);
    return send(200, 'application/json', JSON.stringify({ items: q === 'DJ Crocs & Socks' ? [{ id: { channelId: 'UCother00000000000000000a' }, snippet: { channelTitle: 'Totally Different' } }, { id: { channelId: CHAN }, snippet: { channelTitle: 'DJ Crocs n Socks' } }] : [] }));
  }
  if (u.pathname === '/youtube/v3/search' && u.searchParams.get('type') === 'playlist') {
    const q = u.searchParams.get('q'); log.plSearches.push(q);
    if (poolOn && q === 'Zed Obscure greatest hits songs') return send(200, 'application/json', JSON.stringify({ items: [{ id: { playlistId: 'PLzed' }, snippet: { title: 'Zed Obscure Greatest Hits' } }] }));
    if (poolOn && q === 'blues songs') return send(200, 'application/json', JSON.stringify({ items: [{ id: { playlistId: 'PLsmall' }, snippet: { title: 'Blues Songs' } }] }));
    if (poolOn && (q === 'jazz songs' || q === 'gospel blues songs')) return send(200, 'application/json', JSON.stringify({ items: [{ id: { playlistId: 'PLjazz' }, snippet: { title: 'Best Jazz Songs' } }] }));
    return send(200, 'application/json', JSON.stringify({ items: [] }));
  }
  if (u.pathname === '/youtube/v3/playlistItems') { log.plItems++; const id = u.searchParams.get('playlistId'); return send(200, 'application/json', JSON.stringify({ items: id === 'UU' + CHAN.slice(2) ? CITEMS : id === 'PLzed' ? ZITEMS : id === 'PLsmall' ? SMALLITEMS : PLITEMS })); }
  if (u.pathname === '/youtube/v3/videos') { log.videoCalls++; return send(200, 'application/json', JSON.stringify({ items: u.searchParams.get('id').split(',').map((i) => VIDEOS[i]).filter(Boolean) })); }
  if (u.pathname === '/youtube/v3/search') {
    if (u.searchParams.get('key') !== GOOD) { log.badKey++; return send(400, 'application/json', JSON.stringify({ error: { code: 400, errors: [{ reason: 'keyInvalid' }] } })); }
    if (u.searchParams.get('type') === 'video' && rateLimitVideoSearches > 0) {
      rateLimitVideoSearches--; log.rateLimited++;
      res.writeHead(429, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Retry-After': '2' });
      return res.end(JSON.stringify({ error: { code: 429, errors: [{ reason: 'userRateLimitExceeded' }] } }));
    }
    const q = u.searchParams.get('q'); log.searches.push(q);
    if (/Nowhere/.test(q)) return send(200, 'application/json', JSON.stringify({ items: [] }));
    const n = log.searches.length; log.params.push(u.search);
    return send(200, 'application/json', JSON.stringify({ items: [
      { id: { videoId: 'vid' + n + '_c' }, snippet: { title: q + ' (cover)', channelTitle: 'Someone' } },
      { id: { videoId: 'vid' + n }, snippet: { title: q + ' (Official Video)', channelTitle: 'ArtistVEVO' } },
      { id: { videoId: 'vid' + n + '_b' }, snippet: { title: q + ' lyrics', channelTitle: 'Fan' } },
      { id: { videoId: 'vid' + n + '_wrong' }, snippet: { title: 'A Completely Different Song', channelTitle: 'Someone Else' } },
      { id: { videoId: 'vid' + n + '_a' }, snippet: { title: q + ' (Official Audio)', channelTitle: 'Artist - Topic' } }] }));
  }
  send(404, 'text/plain', 'no');
});

(async () => {
  await new Promise((r) => yt.listen(YT_PORT, '127.0.0.1', r));
  const srv = spawn('node', ['server.js'], { cwd: __dirname + '/..', env: Object.assign({}, process.env, { PORT: APP_PORT, SPOTIFY_CLIENT_ID: '', DATA_DIR: path.join(os.tmpdir(), 'rb-yt-' + Date.now()), YOUTUBE_API_BASE: YT + '/youtube/v3', YOUTUBE_IFRAME_URL: YT + '/iframe_api', YOUTUBE_API_INTERVAL_MS: String(TEST_API_INTERVAL_MS) }), stdio: ['ignore', 'ignore', 'inherit'] });
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

    assert.strictEqual((await host.$$('.src')).length, 5); ok('YouTube is offered alongside the other sources');
    await chooseSource(host, 'youtube');
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

    rateLimitVideoSearches = 1;
    const addDetails = host.locator('details:has(#add-form)');
    if (!(await addDetails.evaluate((el) => el.open))) await addDetails.locator('summary').click();
    await host.fill('#g-name', 'Maya'); await host.click('#picker [data-g="rock"]');
    const limitedResponse = host.waitForResponse((r) => r.url().includes('/youtube/v3/search') && r.status() === 429);
    await host.click('#add-form button[type=submit]'); await limitedResponse;
    await host.waitForFunction(() => /rate limiting requests/.test(document.querySelector('#sp-status') && document.querySelector('#sp-status').textContent || ''), null, { timeout: 5000 });
    const t1 = await until(async () => { const t = await nowTitle(); return t && t !== 'Nothing yet' ? t : ''; }, 12000, 'first song');
    const id1 = await until(() => host.evaluate(() => window.__ytLog[0]), 8000, 'a video was loaded');
    const cachedSearches = await until(async () => { const rows = await cacheRecords(host); return rows && rows.filter((entry) => entry.kind === 'search').length ? rows : null; }, 8000, 'IndexedDB cache write after a song lookup');
    assert.ok(cachedSearches.filter((entry) => entry.kind === 'search').every((entry) => entry.expiresAt > Date.now())); ok('song lookups are cached in IndexedDB with an expiry');
    assert.ok(!cachedSearches.some((entry) => entry.kind === 'search' && entry.value.some((id) => /_(c|b|wrong)$/.test(id)))); ok('covers, lyric uploads and unrelated songs are excluded before results are cached');
    assert.strictEqual(log.rateLimited, 1); ok('a YouTube 429 is retried rather than leaving playback stopped');
    assert.ok(/^vid\d+$/.test(id1)); ok('a song was looked up and loaded into the player: ' + t1 + ' -> ' + id1);
    assert.ok(log.searches[0].includes(t1.split(' (')[0])); ok('the search used the song title and artist');

    await host.click('#tv-mode');
    assert.strictEqual(await host.isVisible('#tv-cast-progress'), true); ok('the cast view shows progress and duration from the YouTube player');
    assert.strictEqual(await host.isVisible('#host-media'), false); ok('YouTube keeps seeking in its own embedded player');
    const castPlayerRatio = await host.evaluate(() => {
      const box = document.querySelector('#yt-holder').getBoundingClientRect();
      return box.width / box.height;
    });
    assert.ok(Math.abs(castPlayerRatio - 16 / 9) < 0.02); ok('TV / cast view keeps the YouTube player in a widescreen frame');
    assert.strictEqual(await host.evaluate(() => getComputedStyle(document.querySelector('.tv-cast-orb.orb-one')).animationName), 'cast-drift-one'); ok('TV / cast view animates a slow ambient background');
    await host.emulateMedia({ reducedMotion: 'reduce' });
    assert.strictEqual(await host.evaluate(() => getComputedStyle(document.querySelector('.tv-cast-orb.orb-one')).animationName), 'none'); ok('TV / cast background motion respects reduced-motion preferences');
    await host.emulateMedia({ reducedMotion: 'no-preference' });
    const titleSizing = await host.evaluate(() => {
      const title = document.querySelector('#tv-cast-title');
      const regularSize = parseFloat(getComputedStyle(title).fontSize);
      title.classList.add('is-extra-long');
      const longSize = parseFloat(getComputedStyle(title).fontSize);
      const lineClamp = getComputedStyle(title).webkitLineClamp;
      title.classList.remove('is-extra-long');
      return { regularSize, longSize, lineClamp };
    });
    assert.ok(titleSizing.longSize < titleSizing.regularSize && titleSizing.lineClamp === '2'); ok('long TV / cast titles shrink and clamp so the artist and queue stay visible');
    await host.click('#tv-cast-exit');

    // let the guest finish settling in (4 s) so the queue is stable, then end whatever is playing
    await new Promise((r) => setTimeout(r, 5500));
    const t2 = await nowTitle();
    await host.evaluate(() => window.__ytOpts.events.onStateChange({ data: 0 }));
    await until(async () => (await nowTitle()) !== t2, 10000, 'advance after video ends');
    ok('when the video ends, the next song starts: ' + await nowTitle());
    await until(() => host.evaluate(() => window.__ytLog.length >= 2), 8000, 'second video loaded');

    // repeats are remembered, so they cost no quota
    const cached = (await cacheRecords(host)).filter((entry) => entry.kind === 'search').length;
    assert.ok(cached >= 2); ok('looked-up songs are remembered in the browser (' + cached + ' so far), so repeats cost no search quota');

    // The search keeps multiple acceptable fallbacks without admitting poor matches.
    assert.ok(!/videoCategoryId/.test(log.params[0]) && /maxResults=8/.test(log.params[0])); ok('the search has no category filter and asks for several candidates');
    assert.ok(/^vid\d+$/.test(id1)); ok('the official video is chosen ahead of a cover');

    await new Promise((r) => setTimeout(r, 600));
    // a video that is unavailable: the next candidate is tried before giving up on the song
    await host.evaluate(() => { window.__ytFail = 'first'; window.__ytLog.length = 0; });
    await host.evaluate(() => window.__ytOpts.events.onStateChange({ data: 0 }));
    await until(() => host.evaluate(() => window.__ytLog.length >= 2 && /_a$/.test(window.__ytLog[window.__ytLog.length - 1])), 10000, 'fallback video').catch(async (e) => { console.log('LOG', await host.evaluate(() => JSON.stringify(window.__ytLog)), await nowTitle()); throw e; });
    const fallbackIds = await host.evaluate(() => window.__ytLog.slice());
    const failedQuality = await until(() => cacheRecord(host, 'quality:' + fallbackIds[0]), 8000, 'failed playback feedback');
    assert.strictEqual(failedQuality.value.failures, 1); ok('failed playback is recorded so the video is demoted in future rankings');
    ok('when the first video is unavailable, the next acceptable candidate plays (' + fallbackIds.join(', ') + ')');
    await host.evaluate(() => { window.__ytFail = 'all'; });
    await new Promise((r) => setTimeout(r, 600));
    const tBefore = await nowTitle();
    await host.evaluate(() => window.__ytOpts.events.onStateChange({ data: 0 }));
    await until(async () => (await nowTitle()) !== tBefore, 15000, 'skip when every candidate fails');
    ok('when no candidate plays, the song is skipped');
    await host.evaluate(() => { window.__ytFail = ''; });
    await new Promise((r) => setTimeout(r, 1500));

    // an embedding error skips the song
    const before = await nowTitle();
    await host.evaluate(() => { window.__ytBlock = false; });
    await host.evaluate(() => window.__ytOpts.events.onError({ data: 150 }));
    await until(async () => (await nowTitle()) !== before, 10000, 'skip after embed error');
    ok('a video that cannot be embedded is skipped');

    // ---- songs by genre: playlists are read, filtered and played by their own id ----
    poolOn = true;
    const searchesBefore = log.searches.length, poolsBefore = log.plSearches.length;
    // Reuse the addDetails locator from the first guest setup.
    if (!(await addDetails.evaluate((el) => el.open))) await addDetails.locator('summary').click();
    await host.fill('#g-name', 'Ben'); await host.click('#picker [data-g="jazz"]'); await host.click('#add-form button[type=submit]');
    await until(() => log.plItems >= 1 && log.videoCalls >= 1, 12000, 'playlist read');
    assert.ok(log.plSearches.includes('jazz songs')); ok('a jazz guest makes the host look for a jazz playlist: ' + log.plSearches.slice(-2).join(' | '));
    assert.deepStrictEqual(log.plSearches.slice(poolsBefore).filter((q) => q.indexOf('jazz') === 0), ['jazz songs']); ok('a full first playlist avoids the second costly playlist search');
    assert.ok(log.plItems === 1 && log.videoCalls === 1); ok('reading the playlist took one call for its songs and one for their details (about 2 quota units, not 100 per song)');
    const stored = await until(() => cacheRecord(host, 'pool:jazz'), 8000, 'pool cached');
    const titles = stored.value.map((t) => t.artist + ' - ' + t.title);
    assert.strictEqual(stored.value.length, 17); assert.ok(stored.expiresAt - stored.at >= 29 * 86400000); ok('17 usable songs were kept and successful pools are cached for 30 days');
    try {
      await host.waitForFunction(() => /17 tracks/.test(document.querySelector('#yt-catalogue-status') && document.querySelector('#yt-catalogue-status').textContent || ''), null, { timeout: 8000 });
    } catch (error) {
      const diagnostics = await host.evaluate(async () => {
        const node = document.querySelector('#yt-catalogue-status');
        const provider = window.Providers && window.Providers.get('youtube');
        let cacheInfo;
        try { cacheInfo = provider && await provider.cacheInfo(); } catch (e) { cacheInfo = { error: e.message }; }
        let indexedDb = null;
        try {
          const request = indexedDB.open('room-blend-youtube');
          const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
          indexedDb = await new Promise((resolve, reject) => {
            const tx = db.transaction('entries', 'readonly'), req = tx.objectStore('entries').getAll();
            req.onsuccess = () => resolve(req.result.filter((x) => x.expiresAt > Date.now()).map((x) => ({
              id: x.id, kind: x.kind, count: Array.isArray(x.value) ? x.value.length : null,
              at: x.at, usedAt: x.usedAt, expiresAt: x.expiresAt,
            })));
            req.onerror = () => reject(req.error);
            tx.oncomplete = () => db.close();
          });
        } catch (e) { indexedDb = { error: e.message }; }
        return {
          statusExists: !!node,
          statusConnected: !!(node && node.isConnected),
          statusText: node && node.textContent,
          providerPresent: !!provider,
          providerCacheInfo: cacheInfo,
          indexedDb,
          roomStatus: document.querySelector('#sp-status') && document.querySelector('#sp-status').textContent,
          sourceText: document.querySelector('#sp') && document.querySelector('#sp').textContent,
        };
      });
      console.error('CATALOGUE STATUS DEBUG:', JSON.stringify(diagnostics, null, 2));
      error.message += '\\nCatalogue status diagnostics: ' + JSON.stringify(diagnostics);
      throw error;
    }
    ok('the host catalogue coverage count refreshes when discovery adds a pool');
    assert.ok(titles.includes('Dave Brubeck - Take Five') && titles.includes('Nina Simone - Feeling Good') && titles.includes('Miles Davis - So What')); ok('artist and title are read from "Artist - Song (Official Audio)" and from a "- Topic" channel');
    assert.ok(!titles.some((t) => /Full Album|Cheek to Cheek|Blocked|Private|Cover|Remix|Lyrics/.test(t))); ok('hour-long uploads, live versions, covers, remixes, lyric videos, videos that cannot be embedded and private videos were filtered out');
    const orderedPool = await host.evaluate(async () => window.Providers.get('youtube').extras('jazz', []));
    assert.strictEqual(orderedPool[0].id, 'plA2'); ok('official artist-channel uploads rank ahead of less authoritative playlist entries');
    await host.evaluate(async () => { window.__ytFail = 'all'; });
    assert.strictEqual(await host.evaluate(async () => window.Providers.get('youtube').play({ title: 'Take Five', artist: 'Dave Brubeck', nid: 'plA1' })), null);
    await host.evaluate(() => { window.__ytFail = ''; });
    const qualityPool = await host.evaluate(async () => window.Providers.get('youtube').extras('jazz', []));
    assert.strictEqual(qualityPool[qualityPool.length - 1].id, 'plA1'); ok('a playlist video that fails playback is demoted in future catalogue ordering');
    await host.waitForFunction(() => /Pool Tune|Take Five|Feeling Good|So What/.test([...document.querySelectorAll('#queue .qrow')].map((e) => e.textContent).join(' ') + document.querySelector('#now-title').textContent), null, { timeout: 12000 }); ok('the queue now holds songs from the playlist');
    await host.evaluate(() => { window.__ytLog.length = 0; });
    for (let i = 0; i < 8 && !(await host.evaluate(() => window.__ytLog.some((v) => /^pl/.test(v)))); i++) { await host.click('#btn-next'); await new Promise((r) => setTimeout(r, 900)); }
    assert.ok(await host.evaluate(() => window.__ytLog.some((v) => /^pl/.test(v)))); ok('a playlist song is loaded straight into the player by its video id: ' + (await host.evaluate(() => window.__ytLog.filter((v) => /^pl/.test(v))[0])));
    assert.ok(!log.searches.slice(searchesBefore).some((q) => /Pool Tune|Take Five|Feeling Good|So What/.test(q))); ok('it needed no title search');
    const fallbackStart = log.plSearches.length;
    const fallbackTracks = await host.evaluate(async () => window.Providers.get('youtube').extras('blues', ['gospel']));
    assert.ok(fallbackTracks.length >= 12); assert.deepStrictEqual(log.plSearches.slice(fallbackStart).filter((q) => /^(blues|gospel blues)/.test(q)), ['blues songs', 'gospel blues songs']); ok('a small first playlist triggers the shared-genre fallback search');
    // ---- an artist a guest names that the room does not have: one playlist search, only that artist's songs kept ----
    const codeNow = host.url().split('/').pop();
    const zoe = await host.evaluate(async (c) => { const r = await fetch('/api/rooms/' + c + '/guests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Zoe', genres: ['jazz'], artists: ['Zed Obscure'] }) }); return r.ok ? r.json() : null; }, codeNow);
    assert.ok(zoe && zoe.guestId);
    await until(() => log.plSearches.includes('Zed Obscure greatest hits songs'), 14000, 'artist playlist search'); ok('a guest naming an artist makes the host search YouTube playlists for "Zed Obscure greatest hits"');
    const found = await until(() => cacheRecord(host, 'pool:Zed Obscure greatest hits'), 8000, 'artist pool cached');
    assert.ok(found && found.value.length === 3); ok('three songs were read from it and cached for 30 days');
    await until(() => host.evaluate(() => /Zed Song/.test([...document.querySelectorAll('#queue .qrow')].map((e) => e.textContent).join(' ') + document.querySelector('#now-title').textContent)), 10000, 'zed in lineup'); ok('Zoe, who named Zed Obscure, has their songs in the lineup');
    const seen = await host.evaluate(async ({ c, z }) => { const f = async (q) => (await fetch('/api/rooms/' + c + '/search?q=' + encodeURIComponent(q), { headers: { 'x-guest-id': z.guestId, 'x-guest-key': z.guestKey } })).json(); return { zed: await f('zed song'), zedArtist: await f('zed obscure'), other: await f('not zed') }; }, { c: codeNow, z: zoe });
    assert.strictEqual(seen.zed.songs.filter((song) => song.source !== 'musicbrainz').length, 2); assert.ok(seen.zedArtist.artists.some((a) => a.name === 'Zed Obscure' && a.songs === 2)); assert.ok(!seen.other.songs.some((x) => x.source !== 'musicbrainz' && /Not Zed/.test(x.title)) && !seen.other.artists.some((a) => a.source !== 'musicbrainz' && /Someone Else/.test(a.name))); ok("the room has Zed Obscure's two songs and not the other artist's song from that playlist")

    // Era picks retain their decade signal instead of becoming only generic genre searches.
    const eraGuest = await host.evaluate(async (c) => {
      const r = await fetch('/api/rooms/' + c + '/guests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Era Fan', genres: ['80s'] }) });
      return r.ok ? r.json() : null;
    }, codeNow);
    assert.ok(eraGuest && eraGuest.guestId);
    await until(() => log.plSearches.includes('80s classic rock songs') && log.plSearches.includes('80s new wave songs'), 20000, 'era-specific playlist searches');
    ok('an 80s pick triggers decade-qualified searches for representative genres');

    const emptyArtist = await host.evaluate(async () => window.Providers.get('youtube').artistTracks('No Such Artist', 'rock'));
    assert.deepStrictEqual(emptyArtist, []);
    const emptyPool = await cacheRecord(host, 'pool:No Such Artist greatest hits');
    assert.ok(emptyPool && emptyPool.value.length === 0 && emptyPool.expiresAt - emptyPool.at <= 13 * 3600000); ok('empty playlist discoveries are negatively cached for only 12 hours');
    const emptySearchPlayback = await host.evaluate(async () => window.Providers.get('youtube').play({ title: 'Nowhere', artist: 'Artist' }));
    assert.strictEqual(emptySearchPlayback, null);
    const emptySearch = await cacheRecord(host, 'search:nowhere|artist');
    assert.ok(emptySearch && emptySearch.value.length === 0 && emptySearch.expiresAt - emptySearch.at <= 7 * 3600000); ok('empty video lookups expire after 6 hours and can be retried');

    // ---- a smaller artist with no "greatest hits" playlist: their own channel's uploads are read instead ----
    const dj = await host.evaluate(async (c) => { const r = await fetch('/api/rooms/' + c + '/guests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Dee', genres: ['jazz'], artists: ['DJ Crocs & Socks'] }) }); return r.ok ? r.json() : null; }, codeNow);
    assert.ok(dj && dj.guestId);
    await until(() => log.chSearches.includes('DJ Crocs & Socks'), 14000, 'artist channel search'); ok('no playlist found, so the host looks for the artist\'s own YouTube channel');
    const djRec = await until(() => cacheRecord(host, 'pool:channel:dj crocs & socks'), 8000, 'channel pool cached'), djPool = { tracks: djRec.value };
    assert.ok(djPool && djPool.tracks.length === 3 && djPool.tracks.every((t) => t.artist === 'DJ Crocs & Socks')); ok('the channel whose name matches (not "Totally Different") gave three songs, credited to the artist as named');
    assert.ok(djPool.tracks.some((t) => t.title === 'Sock Hop Anthem') && djPool.tracks.some((t) => t.title === 'Slide Into Friday')); ok('a title with "Artist - " in front loses it; plain titles stay as they are');
    const djSeen = await until(() => host.evaluate(async ({ c, g }) => { const r = await (await fetch('/api/rooms/' + c + '/search?q=' + encodeURIComponent('slide into friday'), { headers: { 'x-guest-id': g.guestId, 'x-guest-key': g.guestKey } })).json(); return r.songs.some((x) => x.source !== 'musicbrainz' && /Slide Into Friday/.test(x.title)) ? r : null; }, { c: codeNow, g: dj }), 10000, 'dj songs in room'); ok('the artist\'s songs are in the room, even though their genre is not the genre the guest picked');

    // ---- an @handle names one exact channel: looked up directly, never searched by name ----
    const chBefore = log.chSearches.length;
    const dj2 = await host.evaluate(async (c) => { const r = await fetch('/api/rooms/' + c + '/guests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Dex', genres: ['jazz'], artists: ['@djcrocsnsocks'] }) }); return r.ok ? r.json() : null; }, codeNow);
    assert.ok(dj2 && dj2.guestId);
    await until(() => log.handles.includes('@djcrocsnsocks'), 14000, 'handle lookup'); ok('an @handle is looked up as that exact channel');
    const handleRec = await until(() => cacheRecord(host, 'pool:handle:djcrocsnsocks'), 8000, 'handle pool cached');
    assert.strictEqual(handleRec.value.length, 3); assert.ok(handleRec.value.every((t) => t.artist === '@djcrocsnsocks')); assert.ok(handleRec.value.some((t) => t.title === 'Night Drive (Remix)')); ok('its uploads become songs credited to the handle as typed, including a 12-minute remix that other lookups would skip');
    const gOf = (t) => (t.genres || []).join(',');
    const hop = handleRec.value.find((t) => t.title === 'Sock Hop Anthem'), slide = handleRec.value.find((t) => t.title === 'Slide Into Friday'), drive = handleRec.value.find((t) => t.title === 'Night Drive (Remix)');
    assert.deepStrictEqual(hop.genres, ['drum and bass', 'electronic'], gOf(hop)); ok('a song tagged #jungle #junglemusic #synth #electronicmusic (plus single stray #dub #idm #club) is drum and bass and electronic');
    assert.strictEqual(slide.genres[0], 'techno', gOf(slide)); ok('a song tagged #techno is techno');
    assert.deepStrictEqual(drive.genres, ['drum and bass'], gOf(drive)); ok('a song with no clues takes the genre most of the artist\'s songs point to');
    assert.ok(handleRec.value.every((t) => !(t.genres || []).includes('jazz'))); ok('none of them is called jazz just because a jazz guest named the artist');
    assert.strictEqual(log.chSearches.length, chBefore); assert.ok(!log.plSearches.some((q) => /^@djcrocsnsocks/.test(q))); ok('no channel or playlist name search is spent on a handle');
    const dexSeen = await host.evaluate(async ({ c, g }) => (await (await fetch('/api/rooms/' + c + '/search?q=' + encodeURIComponent('sock hop'), { headers: { 'x-guest-id': g.guestId, 'x-guest-key': g.guestKey } })).json()), { c: codeNow, g: dj2 });
    assert.ok(dexSeen.songs.some((x) => x.source !== 'musicbrainz' && x.artist === '@djcrocsnsocks' && /Sock Hop/.test(x.title))); ok('the room holds the handle\'s songs, so the guest\'s pick matches them');

    // Keep a broad set of genre pools and merge updates made by another host tab.
    const cacheWriter = await ctx.newPage();
    await cacheWriter.goto(APP);
    await cacheWriter.evaluate(() => new Promise((resolve, reject) => {
      const dbRequest = indexedDB.open('room-blend-youtube', 2);
      dbRequest.onupgradeneeded = () => dbRequest.result.createObjectStore('entries', { keyPath: 'id' });
      dbRequest.onerror = () => reject(dbRequest.error || new Error('Could not open YouTube cache in second tab'));
      dbRequest.onsuccess = () => {
        const db = dbRequest.result, tx = db.transaction('entries', 'readwrite'), store = tx.objectStore('entries'), now = Date.now();
        for (let i = 0; i < 100; i++) store.put({ id: 'pool:other-tab-pool-' + i, kind: 'pool', value: [], at: now, usedAt: now, expiresAt: now + 30 * 86400000 });
        store.put({ id: 'search:cross tab cached|artist', kind: 'search', value: ['plA1'], at: now, usedAt: now, expiresAt: now + 30 * 86400000 });
        tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
      };
    }));
    await cacheWriter.close();
    const beforeCrossTabCache = log.searches.length;
    const crossTabPlayback = await host.evaluate(async () => window.Providers.get('youtube').play({ title: 'Cross tab cached', artist: 'Artist' }));
    assert.strictEqual(crossTabPlayback, true); assert.strictEqual(log.searches.length, beforeCrossTabCache); ok('a song cached by another tab plays without a new video search');
    const cacheProbeStart = log.plSearches.length;
    await host.evaluate(async () => window.Providers.get('youtube').extras('trip hop', []));
    const poolSnapshot = await cacheRecords(host);
    assert.ok(poolSnapshot.filter((entry) => entry.kind === 'pool').length > 100 && poolSnapshot.some((entry) => entry.id === 'pool:other-tab-pool-0')); ok('the IndexedDB cache retains more than 80 genre pools and preserves pools written by another tab');
    assert.ok(log.plSearches.slice(cacheProbeStart).includes('trip hop songs')); ok('a new genre pool is added without discarding the existing cache');

    // Exhausted quota is persisted for the Pacific day, but cached pools remain usable.
    const beforeQuota = log.apiRequests;
    const quotaStart = Date.now();
    rateLimitQuotaOut = true;
    const quotaPlayback = await host.evaluate(async () => window.Providers.get('youtube').play({ title: 'Uncached under quota limit', artist: 'No Cache' }));
    assert.strictEqual(quotaPlayback, null);
    await host.waitForFunction(() => /searches are paused until midnight Pacific/.test(document.querySelector('#sp').textContent), null, { timeout: 10000 });
    assert.ok(Date.now() - quotaStart < 10000 && log.apiRequests <= beforeQuota + 4); ok('a 60-second Retry-After pauses lookups quickly instead of blocking playback');
    assert.strictEqual(await host.evaluate(() => localStorage.getItem('rb-yt-quota-day') !== null), true); ok('quota exhaustion is saved in browser storage');
    const beforeCached = log.apiRequests;
    const cachedJazz = await host.evaluate(async () => window.Providers.get('youtube').extras('jazz', []));
    assert.strictEqual(cachedJazz.length, 17); assert.strictEqual(log.apiRequests, beforeCached); ok('cached genre songs remain available after quota exhaustion');
    const beforeBlocked = log.apiRequests;
    await host.evaluate(async () => window.Providers.get('youtube').extras('hip hop', []));
    assert.strictEqual(log.apiRequests, beforeBlocked); ok('uncached lookups stop locally after quota exhaustion');
    const skipped = await host.evaluate(async () => window.Providers.get('youtube').play({ title: 'Uncached after quota', artist: 'No Cache' }));
    assert.strictEqual(skipped, null); assert.strictEqual(log.apiRequests, beforeBlocked); ok('songs needing new lookups are skipped so quota exhaustion cannot stall the queue');
    const cachedVideo = await host.evaluate(async () => window.Providers.get('youtube').play({ title: 'Take Five', artist: 'Dave Brubeck' }));
    assert.strictEqual(cachedVideo, true); assert.strictEqual(log.apiRequests, beforeBlocked); ok('a song found in any cached playlist is matched and played by video ID while Search API quota is paused, without a title search');
    const cachedSearch = await cacheRecord(host, 'search:take five|dave brubeck');
    assert.ok(cachedSearch && cachedSearch.value.includes('plA1')); ok('the cross-pool match is promoted into the direct song lookup cache for future instant reuse');
    rateLimitQuotaOut = false;
    await host.reload(); await host.waitForSelector('#sp');
    assert.ok(/searches are paused until midnight Pacific/.test(await host.textContent('#sp'))); ok('the host sees the quota pause after reloading');
    const afterReload = log.apiRequests;
    await host.evaluate(async () => window.Providers.get('youtube').extras('hip hop', []));
    assert.strictEqual(log.apiRequests, afterReload); ok('the quota fuse survives a host-page reload');
    assert.ok(log.apiAt.slice(1).every((at, i) => at - log.apiAt[i] >= TEST_API_INTERVAL_MS - 20)); ok('YouTube Data API requests respect the configured pacing interval across the test session');
    poolOn = false;

    // switching away hides the player; removing the key forgets it
    await openSourceSettings(host);
    await chooseSource(host, 'spotify');
    assert.strictEqual(await host.isVisible('#yt-dock'), false); ok('choosing another source hides the player');
    await chooseSource(host, 'youtube');
    await host.click('#yt-forget');
    await host.waitForSelector('#yt-key');
    assert.strictEqual(await host.evaluate(() => localStorage.getItem('rb-yt-key')), null); ok('Remove key forgets the key');

    // the server never receives the key
    assert.ok(toApp.length > 10 && !toApp.some((x) => x.includes('AIzaFakeKey'))); ok('the API key never reaches the Room Blend server (' + toApp.length + ' requests checked)');
    assert.deepStrictEqual(errors, [], 'page errors: ' + errors.join(' | ')); ok('no page errors');
  } finally { await browser.close(); srv.kill(); yt.close(); }
  console.log('\n' + passed + ' checks passed'); process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e.stack || e.message); process.exit(1); });
