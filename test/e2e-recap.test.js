'use strict';
// The host page shows a "Night in review" recap and a copyable summary, including the empty state.
const http = require('http'), os = require('os'), path = require('path'), fs = require('fs');
const assert = require('assert');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const PORT = 4902, APP = 'http://127.0.0.1:' + PORT;
let passed = 0; const ok = (s) => { passed++; console.log('  ok  ' + s); };
const until = async (fn, ms = 10000, what = 'x') => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + what); await new Promise((r) => setTimeout(r, 100)); } };

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-recap-'));
  const env = Object.assign({}, process.env, { PORT, DATA_DIR: tmp }); delete env.DATABASE_URL;
  const srv = spawn('node', ['server.js'], { cwd: __dirname + '/..', env, stdio: ['ignore', 'ignore', 'inherit'] });
  await until(() => new Promise((r) => http.get(APP, () => r(true)).on('error', () => r(false))), 8000, 'server up');
  const browser = await chromium.launch(); const errors = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: APP }).catch(() => {});
    const host = await ctx.newPage(); host.on('pageerror', (e) => errors.push(e.message));
    await host.goto(APP); await host.click('#start-room'); await host.waitForURL(/\/host\/[A-Z0-9]{5}$/);
    await host.waitForSelector('#recap > summary');
    await host.click('#recap > summary');
    await until(async () => /Nothing played yet/.test(await host.textContent('#recap')), 8000, 'empty state');
    ok('with nothing played, the panel says so instead of showing zeros');
    assert.ok(/Nothing played yet/.test(await host.evaluate(() => window.RoomBlendRecap.summaryText({ songs: 0 }, 'ABCDE')))); ok('the empty summary is a plain sentence');

    await host.locator('details:has(#add-form) > summary').click();
    await host.fill('#g-name', 'Pat'); await host.click('#picker [data-g="blues"]'); await host.click('#add-form button[type=submit]');
    await until(async () => (await host.textContent('#now-title')).trim().length > 0 && (await host.$('#btn-next')), 12000, 'first song');
    const titleOf = async () => (await host.textContent('#now-title')).trim();
    for (let i = 0; i < 2; i++) { const t = await titleOf(); await host.click('#btn-next'); await until(async () => (await titleOf()) !== t, 8000, 'next song'); }
    await host.click('#recap-refresh');
    await until(async () => (await host.$$('#recap .recap-stat')).length === 3, 8000, 'stats');
    const nums = await host.$$eval('#recap .recap-stat b', (e) => e.map((x) => Number(x.textContent)));
    assert.ok(nums[0] >= 2, 'songs ' + nums); assert.ok(nums[2] >= 1, 'peak ' + nums);
    assert.ok((await host.$$('#recap .recap-bar')).length >= 1); ok('after songs play, the panel shows songs, minutes, peak listeners and the genre mix (' + nums.join('/') + ')');
    await host.click('#recap-copy');
    await until(async () => /Copied/.test(await host.textContent('#recap-copy')), 4000, 'copied');
    const clip = await host.evaluate(() => navigator.clipboard.readText()).catch(() => null);
    if (clip) { assert.ok(/^Night in review/.test(clip) && /Genre mix/.test(clip) && /song/.test(clip)); ok('Copy summary puts short plain text on the clipboard'); }
    else ok('Copy summary reports success (clipboard read not permitted here)');
  } catch (e) { console.error('FAILED:', e.message); await browser.close(); srv.kill(); process.exit(1); }
  await browser.close(); srv.kill();
  if (errors.length) { console.error('page errors', errors); process.exit(1); }
  console.log(passed + ' checks passed');
})();
