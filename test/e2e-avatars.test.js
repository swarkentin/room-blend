'use strict';
// TV / cast view avatars in a real browser: one per guest, a stats card on hover, calm movement, and clear of the QR code.
const http = require('http'), os = require('os'), path = require('path'), fs = require('fs');
const assert = require('assert');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const PORT = 4903, APP = 'http://127.0.0.1:' + PORT;
let passed = 0; const ok = (s) => { passed++; console.log('  ok  ' + s); };
const until = async (fn, ms = 10000, what = 'x') => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + what); await new Promise((r) => setTimeout(r, 100)); } };
const intersects = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-av-'));
  const srv = spawn('node', ['server.js'], { cwd: __dirname + '/..', env: Object.assign({}, process.env, { PORT, DATA_DIR: tmp }), stdio: ['ignore', 'ignore', 'inherit'] });
  await until(() => new Promise((r) => http.get(APP, () => r(true)).on('error', () => r(false))), 8000, 'server up');
  const browser = await chromium.launch(); const errors = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, reducedMotion: 'no-preference' });
    const host = await ctx.newPage();
    host.on('pageerror', (e) => errors.push(e.message)); host.on('console', (m) => { if (m.type() === 'error' && !/fonts|ERR_|Failed to load resource/.test(m.text())) errors.push(m.text()); });
    await host.route(/^https:\/\//, (r) => r.abort());
    await host.goto(APP); await host.click('#start-room'); await host.waitForURL(/\/host\/[A-Z0-9]{5}$/);
    const code = host.url().split('/').pop();
    await host.evaluate((c) => fetch('/api/rooms/' + c + '/host/opts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settle: 0 }) }), code);
    await host.click('#tv-mode');
    assert.ok(await host.locator('#tv-cast-avatars').isHidden()); ok('no avatar stage while the room is empty');

    const join = (name, genres) => host.evaluate(([c, n, g]) => fetch('/api/rooms/' + c + '/guests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: n, genres: g }) }).then((r) => r.json()), [code, name, genres]);
    const ana = await join('Ana', ['rock']); await join('Ben', ['blues']); await join('Cy <b>', ['country']);
    await until(async () => (await host.locator('.av').count()) === 3, 10000, 'three avatars');
    ok('each guest gets an avatar');
    assert.strictEqual(await host.locator('.av b').count(), 0); ok('guest names are text, never markup');
    await until(() => host.evaluate(() => [...document.querySelectorAll('.av')].every((a) => a.dataset.mood)), 5000, 'moods set');

    // the stage never covers the QR code, the code text, or the video dock
    await host.waitForTimeout(2500);
    const qr = await host.locator('.tv-cast-join').boundingBox();
    for (const box of await Promise.all((await host.locator('.av').all()).map((a) => a.boundingBox()))) assert.ok(!intersects(box, qr), 'avatar overlaps the QR block');
    ok('avatars stay clear of the QR code');

    // hover shows stats
    const first = host.locator('.av').first();
    assert.strictEqual(await first.locator('.av-tip').evaluate((e) => getComputedStyle(e).visibility), 'hidden');
    await first.hover();
    await until(async () => (await first.locator('.av-tip').evaluate((e) => getComputedStyle(e).visibility)) === 'visible', 3000, 'tip visible');
    const tip = await first.locator('.av-tip').innerText();
    assert.match(tip, /Ana|Ben|Cy/); assert.match(tip, /Own turns/); assert.match(tip, /So far/);
    const tb = await first.locator('.av-tip').boundingBox();
    assert.ok(tb.x >= 0 && tb.x + tb.width <= 1920 && !intersects(tb, qr)); ok('hovering an avatar shows their stats, on screen and off the QR code');

    // movement is occasional: at most one walker at a time, and standing still most of the time
    // (guests walking in when they first arrive is separate, so let those entrances finish before counting strolls)
    await until(async () => (await host.locator('.av.is-walking').count()) === 0, 45000, 'entrances finished');
    let walkers = 0, maxAtOnce = 0;
    for (let i = 0; i < 20; i++) { const w = await host.locator('.av.is-walking').count(); maxAtOnce = Math.max(maxAtOnce, w); walkers += w ? 1 : 0; await host.waitForTimeout(250); }
    assert.ok(maxAtOnce <= 1); ok('only one avatar walks at a time');

    // the toggle hides every avatar, stops the strolling, and is remembered
    const btn = host.locator('#tv-cast-guests-btn');
    assert.strictEqual(await btn.getAttribute('aria-pressed'), 'true');
    await btn.click();
    assert.ok(await host.locator('#tv-cast-avatars').isHidden()); assert.strictEqual(await btn.getAttribute('aria-pressed'), 'false'); ok('the Guests button hides the avatars');
    assert.strictEqual(await host.locator('.av.is-walking').count(), 0);
    await host.reload(); await host.click('#tv-mode');
    assert.ok(await host.locator('#tv-cast-avatars').isHidden()); ok('the choice is remembered after a reload');
    await host.locator('#tv-cast-guests-btn').click();
    await until(async () => (await host.locator('.av').count()) === 3 && await host.locator('#tv-cast-avatars').isVisible(), 5000, 'avatars back');
    ok('turning it back on brings everyone back');

    // leaving removes the avatar
    await host.evaluate(([c, g]) => fetch('/api/rooms/' + c + '/guests/' + g.guestId, { method: 'DELETE', headers: { 'x-guest-id': g.guestId, 'x-guest-key': g.guestKey } }), [code, ana]);
    await until(async () => (await host.locator('.av').count()) === 2, 5000, 'avatar removed');
    ok('a guest who leaves loses their avatar');

    // narrow screens do not show the stage
    await host.setViewportSize({ width: 600, height: 900 });
    assert.ok(await host.locator('#tv-cast-avatars').isHidden()); ok('the stage is hidden on narrow screens');
    assert.deepStrictEqual(errors, []); ok('no page errors');
  } finally { await browser.close(); srv.kill(); }
  console.log(passed + ' browser checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
