'use strict';
// House picks in the browser: a host starts music with no guest, guests take over, and the house is never shown as a person.
const http = require('http'), os = require('os'), path = require('path'), fs = require('fs');
const assert = require('assert');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const PORT = 4913, APP = 'http://127.0.0.1:' + PORT;
let passed = 0; const ok = (s) => { passed++; console.log('  ok  ' + s); };
const until = async (fn, ms = 10000, what = 'x') => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + what); await new Promise((r) => setTimeout(r, 100)); } };

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-house-'));
  const env = Object.assign({}, process.env, { PORT, DATA_DIR: tmp }); delete env.DATABASE_URL;
  const srv = spawn('node', ['server.js'], { cwd: __dirname + '/..', env, stdio: ['ignore', 'ignore', 'inherit'] });
  await until(() => new Promise((r) => http.get(APP, () => r(true)).on('error', () => r(false))), 8000, 'server up');
  const browser = await chromium.launch(); const errors = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1300, height: 1000 } });
    const host = await ctx.newPage(); host.on('pageerror', (e) => errors.push(e.message));
    await host.route(/^https:\/\//, (r) => r.abort());
    await host.goto(APP); await host.click('#start-room'); await host.waitForURL(/\/host\/[A-Z0-9]{5}$/);
    const code = host.url().split('/').pop();
    await host.waitForSelector('#house > summary');
    assert.ok(/House picks/.test(await host.textContent('#house > summary')) && /off/.test(await host.textContent('#house > summary')));
    assert.strictEqual((await host.textContent('#now-title')).trim(), 'Nothing yet'); ok('a new room plays nothing, and the House picks card says it is off');

    await host.click('#house > summary');
    await host.check('#house-on');
    await host.click('#house-picker button[data-g="jazz"]');
    await host.fill('#house .house-body input[type=text]', 'Miles Davis'); await host.keyboard.press('Enter');
    assert.strictEqual(await host.locator('#house .house-artists button').count(), 1);
    await host.click('#house .btn.primary');
    await until(async () => (await host.textContent('#now-title')).trim() !== 'Nothing yet', 10000, 'music starts');
    ok('picking a genre and an artist for the house starts music with no guest in the room');
    await until(async () => /playing/.test(await host.textContent('#house > summary')), 8000, 'badge says playing');
    ok('the card shows the house is playing');
    assert.strictEqual(await host.locator('.av').count(), 0); ok('no avatar, so no pretend guest');
    const rows = await host.evaluate(async (c) => (await (await fetch('/api/rooms/' + c + '/host/recap', { headers: window.RoomBlendHost.headers })).json()).recap, code);
    assert.ok(rows.peakListeners === 0 || rows.peakListeners === undefined); ok('the recap does not count the house as a listener');

    // a reload keeps the house picks (restored from the room's saved state)
    await host.reload(); await host.waitForSelector('#house > summary');
    await host.click('#house > summary');
    await until(async () => await host.isChecked('#house-on'), 8000, 'house on after reload');
    assert.strictEqual(await host.getAttribute('#house-picker button[data-g="jazz"]', 'aria-pressed'), 'true');
    assert.strictEqual(await host.locator('#house .house-artists button').count(), 1); ok('house picks are still there after a reload');

    // a real guest takes over
    const guest = await (await browser.newContext()).newPage();
    await guest.route(/^https:\/\//, (r) => r.abort());
    const gr = await host.evaluate(async (c) => (await (await fetch('/api/rooms/' + c + '/guests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Ana', genres: ['rock'] }) })).json()), code);
    assert.ok(gr && (gr.id || gr.guest || gr.guestId || gr.token));
    await until(async () => !/playing/.test(await host.textContent('#house > summary')), 10000, 'house steps aside');
    await until(async () => (await host.locator('.av').count()) >= 1, 10000, 'avatar for the real guest');
    assert.strictEqual(await host.locator('.av').count(), 1); ok('when a guest joins the house steps aside and only the real guest is shown');

    // turning it off
    await host.click('#house .btn.primary'); // saves current form (still on)
    await host.uncheck('#house-on'); await host.click('#house .btn.primary');
    await until(async () => /off/.test(await host.textContent('#house > summary')), 8000, 'house off');
    ok('the host can turn house picks off');

    // guests never see it
    const gp = await ctx.newPage(); await gp.route(/^https:\/\//, (r) => r.abort()); await gp.goto(APP + '/' + code); await gp.waitForTimeout(1000);
    assert.strictEqual(await gp.locator('#house, #house-mount').count(), 0); ok('the guest page has no house picks card');
  } catch (e) { console.error('FAILED:', e.message); await browser.close(); srv.kill(); process.exit(1); }
  await browser.close(); srv.kill();
  if (errors.length) { console.error('page errors', errors); process.exit(1); }
  console.log('\n' + passed + ' checks passed');
})();
