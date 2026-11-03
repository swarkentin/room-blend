'use strict';
// Browser test for "My music files" when the browser has the File System Access API (Chrome, Edge, Opera).
// The browser's private file system (OPFS) hands out real directory handles, so showDirectoryPicker is pointed at
// a folder there. That exercises the real code paths: walking the folder, reading tags from handles, playing from
// a handle, saving the handle in IndexedDB, and reopening it after a reload.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn, execFileSync } = require('child_process');
const { chromium } = require('playwright');

const PORT = 4902, APP = 'http://127.0.0.1:' + PORT;
let passed = 0; const ok = (s) => { passed++; console.log('  ok  ' + s); };
const until = async (fn, ms = 10000, what = 'condition') => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + what); await new Promise((r) => setTimeout(r, 100)); } };

// ---- real audio files, 1.5 s each, in a nested folder ----
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-fsa-'));
const SONGS = [
  ['rock1.mp3', 'libmp3lame', 'Rock One', 'Band A', 'Rock'], ['rock2.ogg', 'libvorbis', 'Rock Two', 'Band A', 'Alternative & Punk'],
  ['blues1.flac', 'flac', 'Blues One', 'Band B', 'Blues'], ['blues2.mp3', 'libmp3lame', 'Blues Two', 'Band B', 'Blues; Soul'],
  ['jazz1.ogg', 'libvorbis', 'Jazz One', 'Band C', 'Jazz'], ['mystery.mp3', 'libmp3lame', 'Mystery', 'Band D', ''],
];
SONGS.forEach(([f, codec, title, artist, genre], i) => {
  const args = ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${300 + i * 60}:duration=1.5`, '-c:a', codec, '-metadata', `title=${title}`, '-metadata', `artist=${artist}`];
  if (genre) args.push('-metadata', `genre=${genre}`);
  execFileSync('ffmpeg', [...args, path.join(dir, f)]);
});
const b64 = (f) => fs.readFileSync(path.join(dir, f)).toString('base64');
// Everything goes under Album/ (so the folder walk has to recurse), plus things that must be ignored.
const SEED = SONGS.map(([f]) => ({ path: 'Album/' + f, b64: b64(f) }))
  .concat([{ path: 'Album/notes.txt', b64: Buffer.from('not music').toString('base64') }, { path: 'Album/._rock1.mp3', b64: b64('rock1.mp3') }]);

(async () => {
  const srv = spawn('node', ['server.js'], { cwd: __dirname + '/..', env: Object.assign({}, process.env, { PORT, SPOTIFY_CLIENT_ID: '', DATA_DIR: path.join(os.tmpdir(), 'rb-fsa-data-' + Date.now()) }), stdio: ['ignore', 'ignore', 'inherit'] });
  await until(() => new Promise((r) => http.get(APP, () => r(true)).on('error', () => r(false))), 8000, 'server up');
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const errors = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
    await ctx.addInitScript(() => {
      window.__audios = []; const A = window.Audio; window.Audio = function (...a) { const x = new A(...a); window.__audios.push(x); return x; };
      // The native folder dialog cannot be driven, so the picker hands back the OPFS folder "Music".
      window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('Music');
    });
    const host = await ctx.newPage();
    host.on('pageerror', (e) => errors.push(e.message)); host.on('console', (m) => { if (m.type() === 'error' && !/fonts|ERR_|Failed to load resource|qrcode/.test(m.text())) errors.push(m.text()); });
    const panel = () => host.textContent('#sp');
    const nowTitle = () => host.textContent('#now-title');
    const playingSrc = () => host.evaluate(() => { const a = window.__audios[window.__audios.length - 1]; return a && !a.paused && a.currentTime > 0 ? a.src : ''; });
    const panelHas = (re, ms) => host.waitForFunction((s) => new RegExp(s).test(document.querySelector('#sp').textContent), re.source, { timeout: ms || 20000 });

    // ---- put the music in the browser's private file system ----
    await host.goto(APP);
    await host.evaluate(async (files) => {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry('Music', { recursive: true }).catch(() => {});
      const music = await root.getDirectoryHandle('Music', { create: true });
      for (const f of files) {
        const parts = f.path.split('/'), name = parts.pop(); let d = music;
        for (const p of parts) d = await d.getDirectoryHandle(p, { create: true });
        const w = await (await d.getFileHandle(name, { create: true })).createWritable();
        await w.write(Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))); await w.close();
      }
    }, SEED);

    await host.click('#start-room'); await host.waitForURL(/\/host\/[A-Z0-9]{5}$/);
    await host.click('[data-src="local"]');
    await host.waitForSelector('#loc-fsa', { state: 'attached' });
    assert.ok(/view the folder/.test(await panel())); ok('before the click, the panel says the browser will ask to "view" the folder, and that it only reads song tags');
    await host.waitForSelector('#loc-dir', { state: 'attached' }); ok('the older folder picker is still offered');
    assert.strictEqual(await host.locator('#loc-reopen').count(), 0); ok('nothing is offered for reopening before a folder has been chosen');

    // ---- choose the folder through a directory handle ----
    await host.click('#loc-fsa');
    await panelHas(/Playing from your files/);
    const p1 = await panel();
    assert.ok(/5 songs in the room/.test(p1) && /1 have no genre tag/.test(p1)); ok('the folder is walked: 5 tagged songs found in a subfolder; notes.txt and the ._ file are ignored; 1 untagged');
    assert.ok(await host.locator('#loc-forget').count() === 1); ok('a remembered folder can be forgotten');

    const addGuest = async (name, genres) => {
      await host.fill('#g-name', name);
      for (const g of genres) await host.click(`#picker [data-g="${g}"]`);
      await host.click('#add-form button[type=submit]');
    };
    await addGuest('Maya', ['rock']);
    const t1 = await until(async () => { const t = await nowTitle(); return /^(Rock|Blues|Jazz|Mystery)/.test(t) ? t : ''; }, 12000, 'first song');
    assert.ok(/^Rock/.test(t1), 'a rock fan should hear rock first, got ' + t1); ok('a rock fan is played a rock song: ' + t1);
    assert.ok((await until(playingSrc, 12000, 'audio playing')).startsWith('blob:')); ok('the browser plays the file read through its handle (blob audio, currentTime advancing)');
    assert.strictEqual(await host.isVisible('#host-media'), true); ok('local playback exposes a host-side seek control');
    await host.evaluate(() => {
      const seek = document.querySelector('#host-seek');
      seek.value = '0.8';
      seek.dispatchEvent(new Event('input', { bubbles: true }));
      seek.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await until(() => host.evaluate(() => { const a = window.__audios[window.__audios.length - 1]; return a && a.currentTime > 0.7 && a.currentTime < 1.2; }), 3000, 'local seek applied');
    ok('the host seek control moves the local audio position');
    await host.click('#tv-mode');
    assert.strictEqual(await host.isVisible('#tv-cast-progress'), true); ok('the cast view shows local song progress and duration');
    await host.click('#tv-cast-exit');

    // ---- a reload forgets the files but not the folder ----
    await host.reload(); await host.waitForSelector('#sp');
    await host.waitForSelector('#loc-reopen', { state: 'attached' });
    const label = (await host.textContent('#loc-reopen')).trim();
    assert.strictEqual(label, 'Reopen "Music"'); ok('after a reload the folder is remembered and offered by name: ' + label);
    assert.ok(/still in the room/.test(await panel())); ok('the panel explains the room keeps the songs but needs the folder again');
    await host.click('#loc-reopen');
    await panelHas(/Playing from your files/);
    assert.ok(/5 songs in the room/.test(await panel())); ok('one click reopens the folder and re-reads 5 songs, with no picker');
    assert.ok((await until(playingSrc, 12000, 'audio playing again')).startsWith('blob:')); ok('playback resumes from the reopened folder');

    // ---- the folder disappears ----
    await host.reload(); await host.waitForSelector('#loc-reopen', { state: 'attached' });
    await host.evaluate(async () => { await (await navigator.storage.getDirectory()).removeEntry('Music', { recursive: true }); });
    await host.click('#loc-reopen');
    await panelHas(/could not be read/, 8000);
    ok('a moved or deleted folder gives a clear message instead of failing silently');

    // ---- forgetting ----
    await host.click('#loc-forget');
    await host.waitForFunction(() => !document.querySelector('#loc-reopen') && document.querySelector('#loc-fsa'));
    assert.strictEqual((await host.textContent('#loc-fsa')).trim(), 'Choose music folder'); ok('"Forget this folder" goes back to a plain picker');
    await host.reload(); await host.waitForSelector('#loc-fsa', { state: 'attached' });
    await new Promise((r) => setTimeout(r, 500));
    assert.strictEqual(await host.locator('#loc-reopen').count(), 0); ok('the forgotten folder stays forgotten after a reload');
    assert.deepStrictEqual(errors, [], 'page errors: ' + errors.join(' | ')); ok('no page errors');
  } finally { await browser.close(); srv.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
  console.log('\n' + passed + ' checks passed'); process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e.stack || e.message); process.exit(1); });
