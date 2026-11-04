'use strict';
// A server restart with no disk: the host's room comes back (same code, name, settings) and a guest's picks follow them to a new room. Real browsers.
const http = require('http'), os = require('os'), path = require('path'), fs = require('fs');
const assert = require('assert');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const PORT = 4897, APP = 'http://127.0.0.1:' + PORT;
let passed = 0; const ok = (s) => { passed++; console.log('  ok  ' + s); };
const until = async (fn, ms = 15000, what = 'x') => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + what); await new Promise((r) => setTimeout(r, 150)); } };
const getJson = (p) => new Promise((resolve) => http.get(APP + p, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(c).toString()); } catch (e) { /* none */ } resolve({ status: res.statusCode, json: j }); }); }).on('error', () => resolve({ status: 0, json: null })));

(async () => {
  const dirs = [];
  // Each start gets a brand new empty DATA_DIR, like a free host that loses its disk. Only SESSION_SECRET is kept.
  const start = async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-restore-')); dirs.push(dir);
    const p = spawn('node', ['server.js'], { cwd: __dirname + '/..', env: Object.assign({}, process.env, { PORT, DATA_DIR: dir, SESSION_SECRET: 'e2e-restore-secret-0123456789abcdef', LOG_LEVEL: 'silent', MUSICBRAINZ_SEARCH_DISABLED: '1' }), stdio: ['ignore', 'ignore', 'inherit'] });
    await until(async () => (await getJson('/healthz')).status === 200, 8000, 'server up');
    return p;
  };
  const stop = (p) => new Promise((r) => { p.once('exit', r); p.kill('SIGKILL'); });
  let srv = await start();
  const browser = await chromium.launch(); const errors = [];
  const ctx = async (vp) => { const c = await browser.newContext({ viewport: vp || { width: 420, height: 850 } }); const p = await c.newPage(); p.on('pageerror', (e) => errors.push(e.message)); return p; };
  try {
    const host = await ctx({ width: 1200, height: 900 });
    await host.goto(APP); await host.click('#start-room'); await host.waitForURL(/\/host\/[A-Z0-9]{5}$/);
    const code = host.url().split('/').pop();
    const renamed = host.waitForResponse((r) => r.url().endsWith('/api/rooms/' + code + '/host/room') && r.request().method() === 'POST');
    await host.fill('#room-name', 'Friday Night'); await renamed;
    await host.waitForFunction((c) => !!localStorage.getItem('rb-snap-' + c), code);
    ok('the host browser keeps a restore receipt for its room');

    const guest = await ctx(); await guest.goto(`${APP}/${code}`); await guest.waitForSelector('#gv-form');
    await guest.click('#gv-picker [data-g="rock"]'); await guest.click('#gv-submit'); await guest.waitForSelector('#gv-title');
    ok('a guest joins with rock');
    await until(async () => host.evaluate((code) => new Promise((resolve) => {
      const open = indexedDB.open('room-blend-room-state', 1);
      open.onerror = () => resolve(false);
      open.onsuccess = () => {
        const req = open.result.transaction('snapshots', 'readonly').objectStore('snapshots').get(code);
        req.onsuccess = () => resolve(!!(req.result && req.result.snapshot && req.result.version > 0));
        req.onerror = () => resolve(false);
      };
    }), code), 10000, 'encrypted room checkpoint');
    const saved = await host.evaluate((code) => new Promise((resolve) => {
      const open = indexedDB.open('room-blend-room-state', 1);
      open.onsuccess = () => {
        const req = open.result.transaction('snapshots', 'readonly').objectStore('snapshots').get(code);
        req.onsuccess = () => resolve(req.result);
      };
      open.onerror = () => resolve(null);
    }), code);
    assert.ok(!saved.snapshot.includes('Friday Night') && !saved.snapshot.includes('Guest') && !saved.snapshot.includes('rock'), 'the browser stores opaque ciphertext, not readable room data');
    ok('the host browser checkpoints encrypted room state in IndexedDB');

    await stop(srv); srv = await start();
    assert.strictEqual((await getJson('/api/rooms/' + code)).status, 404); ok('the restarted server has forgotten the room');

    await until(async () => { const r = await getJson('/api/rooms/' + code); return r.status === 200 && r.json.name === 'Friday Night'; }, 20000, 'room restored');
    ok('the host page brings back the same room code and name by itself');
    await until(() => guest.evaluate(() => /Guest|rock/i.test(document.body.textContent)) , 5000, 'guest page alive');
    await until(async () => (await host.textContent('#guests')).trim().length > 0 && /Guest|1/.test(await host.textContent('#guests')), 20000, 'guest rejoined');
    ok('the guest is rejoined to the restored room without doing anything');

    // Settings carry to a new room: same guest browser opens a different room and starts with rock selected.
    const host2 = await ctx({ width: 1200, height: 900 }); await host2.goto(APP); await host2.click('#start-room'); await host2.waitForURL(/\/host\/[A-Z0-9]{5}$/);
    const code2 = host2.url().split('/').pop();
    await guest.goto(`${APP}/${code2}`); await guest.waitForSelector('#gv-form');
    assert.strictEqual(await guest.getAttribute('#gv-picker [data-g="rock"]', 'aria-pressed'), 'true');
    ok('joining a new room starts from the genres picked last time');
    assert.deepStrictEqual(errors, [], errors.join(' | ')); ok('no page errors');
  } finally {
    await browser.close(); srv.kill();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
  console.log(`\n${passed} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
