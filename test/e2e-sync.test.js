'use strict';
// "Spotify: my songs": the host's saved songs become the catalogue and stay in sync. Fake Spotify + real Chromium.
const http = require('http');
const assert = require('assert');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const SP_PORT = 4873, APP_PORT = 4872;
const APP = 'http://127.0.0.1:' + APP_PORT, SP = 'http://127.0.0.1:' + SP_PORT;
let passed = 0; const ok = (s) => { passed++; console.log('  ok  ' + s); };
const log = { plays: [], libCalls: 0, scopes: '' };
const SAVED = [
  { id: 'sp1', name: 'Saved Rock', artists: [{ id: 'A1', name: 'Band A' }] }, { id: 'sp2', name: 'Saved Blues', artists: [{ id: 'A2', name: 'Band B' }] },
  { id: 'sp3', name: 'Saved Indie', artists: [{ id: 'A3', name: 'Band C' }] }, { id: 'sp4', name: 'No Genre Artist', artists: [{ id: 'A4', name: 'Band D' }] },
  { id: 'spL', name: 'Local File', is_local: true, artists: [{ id: 'A1', name: 'Band A' }] },
];
const ARTISTS = { A1: ['modern rock', 'hard rock'], A2: ['electric blues', 'blues rock'], A3: ['indie rock'], A4: [], A5: ['neo soul'] };
const SDK = `window.Spotify = { Player: function (o) { var L = {}, self = this;
  this.addListener = function (k, f) { (L[k] = L[k] || []).push(f); }; this.emit = function (k, v) { (L[k] || []).forEach(function (f) { f(v); }); };
  this.connect = function () { setTimeout(function () { self.emit('ready', { device_id: 'dev1' }); }, 20); return Promise.resolve(true); };
  this.activateElement = function () { return Promise.resolve(); }; this.pause = function () { return Promise.resolve(); }; this.resume = function () { return Promise.resolve(); }; } };
if (window.onSpotifyWebPlaybackSDKReady) window.onSpotifyWebPlaybackSDKReady();`;
const fake = http.createServer((req, res) => {
  const u = new URL(req.url, SP), cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
  const json = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json', ...cors }); res.end(o === undefined ? '' : JSON.stringify(o)); };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (u.pathname === '/spotify-player.js') { res.writeHead(200, { 'Content-Type': 'text/javascript', ...cors }); return res.end(SDK); }
  if (u.pathname === '/authorize') {
    log.scopes = u.searchParams.get('scope');
    const back = new URL(u.searchParams.get('redirect_uri')); back.searchParams.set('code', 'C'); back.searchParams.set('state', u.searchParams.get('state'));
    res.writeHead(302, { Location: back.toString() }); return res.end();
  }
  if (u.pathname === '/api/token') { let b = ''; req.on('data', (d) => b += d); req.on('end', () => json(200, { access_token: 'tok', refresh_token: 'ref', expires_in: 3600, scope: log.scopes })); return; }
  if (u.pathname === '/v1/me/tracks') {
    log.libCalls++; const off = Number(u.searchParams.get('offset') || 0);
    return json(200, { total: SAVED.length, items: SAVED.slice(off, off + 50).map((t) => ({ track: t })) });
  }
  if (u.pathname === '/v1/artists') { return json(200, { artists: u.searchParams.get('ids').split(',').map((id) => ({ id, genres: ARTISTS[id] || [] })) }); }
  if (u.pathname === '/v1/me/player' && req.method === 'PUT') return json(204);
  if (u.pathname === '/v1/me/player/play' && req.method === 'PUT') { let b = ''; req.on('data', (d) => b += d); req.on('end', () => { log.plays.push(JSON.parse(b).uris[0]); json(204); }); return; }
  json(404, { error: 'unhandled ' + u.pathname });
});
const until = async (fn, ms = 10000, what = 'condition') => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + what); await new Promise((r) => setTimeout(r, 100)); } };

(async () => {
  await new Promise((r) => fake.listen(SP_PORT, '127.0.0.1', r));
  const srv = spawn('node', ['server.js'], { cwd: __dirname + '/..', env: Object.assign({}, process.env, { PORT: APP_PORT, SPOTIFY_CLIENT_ID: 'fakeid', DATA_DIR: require('os').tmpdir() + '/rb-sync-' + Date.now(),
    SPOTIFY_API_BASE: SP + '/v1', SPOTIFY_ACCOUNTS_BASE: SP, SPOTIFY_SDK_URL: SP + '/spotify-player.js' }), stdio: ['ignore', 'pipe', 'inherit'] });
  await until(() => new Promise((r) => http.get(APP, () => r(true)).on('error', () => r(false))), 8000, 'server up');
  const browser = await chromium.launch(); const errors = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } }), host = await ctx.newPage();
    host.on('pageerror', (e) => errors.push(e.message)); await host.route(/^https:\/\//, (r) => r.abort());
    await host.goto(APP + '/'); await host.click('#start-room'); await host.waitForURL(/\/host\/[A-Z0-9]{5}$/);
    const code = host.url().split('/').pop();
    await host.click('[data-src="spotify-lib"]'); await host.click('#spl-connect');
    await host.waitForURL(/\/host\/[A-Z0-9]{5}$/); await host.waitForSelector('#spl-start');
    assert.ok(/user-library-read/.test(log.scopes)); ok('connecting asks Spotify for permission to read saved songs');
    await host.click('#spl-start');
    await host.waitForFunction(() => /Playing your Spotify library/.test(document.querySelector('#sp').textContent), null, { timeout: 15000 });
    const panel = await host.textContent('#sp');
    assert.ok(/3 songs in the room/.test(panel) && /1 left out/.test(panel)); ok('saved songs are read: 3 with genres, 1 without a genre left out, the local file ignored');
    assert.ok(/songs you save in spotify appear here automatically/i.test(panel)); ok('the host is told new saves appear automatically');
    await host.fill('#g-name', 'Maya'); await host.click('#picker [data-g="rock"]'); await host.click('#add-form button[type=submit]');
    await until(() => log.plays.length >= 1, 12000, 'first song plays through Spotify');
    assert.ok(/^spotify:track:sp[123]$/.test(log.plays[0])); ok('a saved song plays through the host\'s Spotify by id: ' + log.plays[0]);
    const played = log.plays.length;
    SAVED.push({ id: 'sp5', name: 'Saved Soul', artists: [{ id: 'A5', name: 'Band E' }] });
    await host.click('#spl-sync');
    await host.waitForFunction(() => /4 songs in the room/.test(document.querySelector('#sp').textContent), null, { timeout: 10000 });
    assert.strictEqual(log.plays.length, played); ok('Sync now picks up a newly saved song (4 songs) without interrupting the one playing');
  } catch (e) { console.error('FAILED:', e.message); await browser.close(); srv.kill(); fake.close(); process.exit(1); }
  await browser.close(); srv.kill(); fake.close();
  if (errors.length) { console.error('page errors', errors); process.exit(1); }
  console.log(passed + ' checks passed');
})();
