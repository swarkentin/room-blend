'use strict';
// The host page has a collapsed "Share your room" help panel with per-app steps and a copyable invite; guests never see it.
const http = require('http'), os = require('os'), path = require('path'), fs = require('fs');
const assert = require('assert');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const PORT = 4912, APP = 'http://127.0.0.1:' + PORT;
let passed = 0; const ok = (s) => { passed++; console.log('  ok  ' + s); };
const until = async (fn, ms = 10000, what = 'x') => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + what); await new Promise((r) => setTimeout(r, 100)); } };

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-share-'));
  const env = Object.assign({}, process.env, { PORT, DATA_DIR: tmp }); delete env.DATABASE_URL;
  const srv = spawn('node', ['server.js'], { cwd: __dirname + '/..', env, stdio: ['ignore', 'ignore', 'inherit'] });
  await until(() => new Promise((r) => http.get(APP, () => r(true)).on('error', () => r(false))), 8000, 'server up');
  const browser = await chromium.launch(); const errors = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: APP }).catch(() => {});
    const host = await ctx.newPage(); host.on('pageerror', (e) => errors.push(e.message));
    await host.goto(APP); await host.click('#start-room'); await host.waitForURL(/\/host\/[A-Z0-9]{5}$/);
    const code = host.url().split('/').pop();
    await host.waitForSelector('#share > summary');
    assert.strictEqual(await host.$eval('#share', (d) => d.open), false); ok('the panel exists and is collapsed by default');
    await host.focus('#share > summary'); await host.keyboard.press('Enter');
    assert.strictEqual(await host.$eval('#share', (d) => d.open), true); ok('it opens from the keyboard');
    const text = await host.textContent('#share');
    for (const app of ['Discord', 'Zoom', 'Google Meet', 'Microsoft Teams']) assert.ok(text.includes(app), app);
    for (const id of ['discord', 'zoom', 'meet', 'teams']) {
      await host.click('#share-' + id + ' > summary');
      assert.ok((await host.$$('#share-' + id + ' ol li')).length >= 3, id + ' steps');
      assert.ok(/^https:\/\//.test(await host.getAttribute('#share-' + id + ' a', 'href')), id + ' help link');
    }
    assert.ok(/Last checked: \d{4}-\d{2}-\d{2}/.test(text)); ok('each app shows steps and an official help link, with a last-checked line');
    await host.click('#share-copy-invite');
    await until(async () => /copied/i.test(await host.textContent('#share .share-actions')), 4000, 'copied');
    const clip = await host.evaluate(() => navigator.clipboard.readText()).catch(() => null);
    if (clip) { assert.ok(clip.includes(APP + '/' + code) && clip.includes(code), clip); ok('Copy invite message puts the join link and code on the clipboard'); }
    else ok('Copy invite message reports success (clipboard read not permitted here)');
    const guest = await ctx.newPage(); guest.on('pageerror', (e) => errors.push(e.message));
    await guest.goto(APP + '/' + code); await guest.waitForSelector('body');
    await new Promise((r) => setTimeout(r, 800));
    assert.strictEqual((await guest.$$('#share, #share-mount')).length, 0); ok('the guest page does not contain the panel');
  } catch (e) { console.error('FAILED:', e.message); await browser.close(); srv.kill(); process.exit(1); }
  await browser.close(); srv.kill();
  if (errors.length) { console.error('page errors', errors); process.exit(1); }
  console.log(passed + ' checks passed');
})();
