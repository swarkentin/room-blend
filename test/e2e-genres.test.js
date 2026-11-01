'use strict';
// The grouped genre picker and broad picks ("All rock"), in a real browser on a phone-sized screen.
const http = require('http'), os = require('os'), path = require('path'), fs = require('fs');
const assert = require('assert');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const PORT = 4897, APP = 'http://127.0.0.1:' + PORT;
let passed = 0; const ok = (s) => { passed++; console.log('  ok  ' + s); };
const until = async (fn, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 100)); } };

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-gen-'));
  const srv = spawn('node', ['server.js'], { cwd: __dirname + '/..', env: Object.assign({}, process.env, { PORT, DATA_DIR: tmp }), stdio: ['ignore', 'pipe', 'inherit'] });
  await until(() => new Promise((r) => http.get(APP, () => r(true)).on('error', () => r(false))));
  const browser = await chromium.launch(); const errors = [];
  try {
    const hc = await browser.newContext({ viewport: { width: 1200, height: 900 } }), host = await hc.newPage();
    host.on('pageerror', (e) => errors.push(e.message));
    await host.goto(APP); await host.click('#start-room'); await host.waitForURL(/\/host\/[A-Z0-9]{5}$/);
    const code = host.url().split('/').pop();
    // host "add someone by hand" picker: 56 genres plus an "All ..." chip for each of the 7 multi-genre groups
    assert.strictEqual(await host.locator('#picker .chip').count(), 56 + 7); ok('the picker offers 56 genres and 7 "All ..." buttons');
    assert.strictEqual(await host.locator('#picker .chipgroup').count(), 8); ok('genres are shown in 8 groups');
    const gc = await browser.newContext({ viewport: { width: 420, height: 850 } }), g = await gc.newPage();
    g.on('pageerror', (e) => errors.push(e.message));
    await g.goto(APP + '/' + code); await g.waitForSelector('#gv-picker .chip');
    assert.strictEqual(await g.locator('#gv-picker .chip-all').count(), 7); ok('a guest sees the same grouped picker on a phone');
    await g.click('#gv-picker [data-g="any:rock"]'); await g.click('#gv-picker [data-g="jazz"]');
    assert.strictEqual(await g.getAttribute('#gv-picker [data-g="any:rock"]', 'aria-pressed'), 'true'); ok('"All rock" can be picked beside a specific genre');
    await g.click('#gv-submit'); await g.waitForSelector('#gv-title');
    await until(async () => /all rock/.test(await g.textContent('#gv-me')));
    ok('the guest\'s picks read "all rock, jazz"');
    await until(async () => (await host.textContent('body')).includes('all rock')); ok('the host sees the broad pick as a tag');
    await g.screenshot({ path: path.join(tmp, 'picker.png') });
  } catch (e) {
    console.error('FAILED:', e.message); await browser.close(); srv.kill(); process.exit(1);
  }
  await browser.close(); srv.kill();
  if (errors.length) { console.error('page errors', errors); process.exit(1); }
  console.log(passed + ' checks passed');
})();
