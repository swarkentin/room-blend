'use strict';
// How a guest gets in: QR code, short link, "playing near you", pasted link, rejoin, TV screen. Real browsers.
const http = require('http'), os = require('os'), path = require('path'), fs = require('fs');
const assert = require('assert');
const { spawn, execFileSync } = require('child_process');
const { chromium } = require('playwright');
const PORT = 4895, APP = 'http://127.0.0.1:' + PORT;
let passed = 0; const ok = (s) => { passed++; console.log('  ok  ' + s); };
const until = async (fn, ms = 8000, what = 'x') => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + what); await new Promise((r) => setTimeout(r, 100)); } };

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-join-'));
  const srv = spawn('node', ['server.js'], { cwd: __dirname + '/..', env: Object.assign({}, process.env, { PORT, DATA_DIR: tmp }), stdio: ['ignore', 'ignore', 'inherit'] });
  await until(() => new Promise((r) => http.get(APP, () => r(true)).on('error', () => r(false))), 8000, 'server up');
  const browser = await chromium.launch(); const errors = [];
  const page = async (vp) => { const c = await browser.newContext({ viewport: vp || { width: 420, height: 850 } }); const p = await c.newPage(); p.on('pageerror', (e) => errors.push(e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/fonts|ERR_|Failed to load resource/.test(m.text())) errors.push(m.text()); }); await p.route(/^https:\/\//, (r) => r.abort()); return p; };
  try {
    // ---- host ----
    const host = await page({ width: 1200, height: 900 });
    await host.goto(APP); await host.click('#start-room'); await host.waitForURL(/\/host\/[A-Z0-9]{5}$/);
    const code = host.url().split('/').pop();
    await host.fill('#room-name', 'Friday Night'); await host.waitForTimeout(700);
    ok('host names the room');

    await host.click('#tv-mode');
    assert.ok(await host.locator('body').evaluate((e) => e.classList.contains('tv-cast-mode')));
    assert.strictEqual(await host.textContent('#tv-cast-code'), code);
    assert.strictEqual((await host.textContent('#tv-cast-room')).trim(), 'Friday Night');
    assert.ok(await host.locator('#tv-cast-view').isVisible());
    ok('TV / cast view presents the room in the host tab');
    const castQr = path.join(tmp, 'cast-qr.png'); await host.locator('#tv-cast-qr').screenshot({ path: castQr });
    const castDecoded = execFileSync('python3', ['-c', 'import cv2,sys;im=cv2.imread(sys.argv[1]);im=cv2.resize(im,None,fx=3,fy=3,interpolation=cv2.INTER_NEAREST);print(cv2.QRCodeDetector().detectAndDecode(im)[0])', castQr]).toString().trim();
    assert.strictEqual(castDecoded, `${APP}/${code}`); ok('TV / cast view shows a scannable join QR code');
    await host.click('#tv-cast-exit');
    assert.ok(!(await host.locator('body').evaluate((e) => e.classList.contains('tv-cast-mode'))));
    assert.match(host.url(), /\/host\/[A-Z0-9]{5}$/); ok('exiting TV view returns to the host controls without navigating away');

    // ---- the QR code on screen really decodes to the short join link ----
    const qrPng = path.join(tmp, 'qr.png'); await host.locator('#qr').screenshot({ path: qrPng });
    const decoded = execFileSync('python3', ['-c', 'import cv2,sys;im=cv2.imread(sys.argv[1]);im=cv2.resize(im,None,fx=3,fy=3,interpolation=cv2.INTER_NEAREST);print(cv2.QRCodeDetector().detectAndDecode(im)[0])', qrPng]).toString().trim();
    assert.strictEqual(decoded, `${APP}/${code}`); ok('the QR code on the host screen decodes to the short link: ' + decoded);
    assert.ok((await host.textContent('#jl')).endsWith('/' + code)); ok('the link shown is the short one');

    // ---- guest 1: opens the site, sees the room near them, taps it ----
    const g1 = await page(); await g1.goto(APP);
    await g1.waitForSelector('#nearby:not([hidden])'); assert.ok((await g1.textContent('#nearby')).includes('Friday Night')); ok('a guest opening the site sees "Friday Night" playing near them');
    await g1.click('#nearby a'); await g1.waitForURL(new RegExp('/r/' + code));
    assert.strictEqual(await g1.textContent('#gv-title-h'), 'Friday Night'); ok('the join page shows the room name');
    await g1.click('#gv-picker [data-g="rock"]'); await g1.click('#gv-submit'); await g1.waitForSelector('#gv-title');
    await host.waitForFunction(() => /Guest/.test(document.querySelector('#guests').textContent)); ok('a guest joins with one tap on a genre and no name or sign-up');

    // ---- guest 2: short link ----
    const g2 = await page(); await g2.goto(`${APP}/${code.toLowerCase()}`);
    await g2.waitForURL(new RegExp('/r/' + code)); await g2.waitForSelector('#gv-form'); ok('the short link /code opens the join page (' + g2.url().replace(APP, '') + ')');

    // ---- guest 3: pastes the whole link into the home page box ----
    const g3 = await page(); await g3.goto(APP); await g3.fill('#join-code', `${APP}/r/${code}`);
    await g3.waitForURL(new RegExp('/r/' + code)); ok('pasting a full link into the box joins without pressing anything');
    const g4 = await page(); await g4.goto(APP); await g4.fill('#join-code', code.toLowerCase());
    await g4.waitForURL(new RegExp('/r/' + code)); ok('typing the 5-letter code joins as soon as it is complete (any case)');
    const g5 = await page(); await g5.goto(APP); await g5.fill('#join-code', 'QQQQQ'); await g5.waitForFunction(() => /No room with code QQQQQ/.test(document.body.textContent)); ok('a wrong code says so plainly');

    // ---- returning guest ----
    await g1.goto(APP); await g1.waitForSelector('#mine:not([hidden])');
    assert.ok((await g1.textContent('#mine')).includes('Rejoin')); await g1.click('#mine a'); await g1.waitForSelector('#gv-title'); ok('a returning guest gets a one-tap Rejoin and lands straight in the room');

    // ---- big screen ----
    const tv = await page({ width: 1280, height: 720 }); await tv.goto(`${APP}/screen/${code}`);
    await tv.waitForFunction(() => document.querySelector('#tv-title').textContent !== 'Waiting for the first guest', null, { timeout: 12000 });
    const tvText = await tv.textContent('.tv'); assert.ok(tvText.includes(code) && /person|people/.test(tvText)); ok('the TV screen shows the code, headcount and now playing: ' + (await tv.textContent('#tv-title')));
    const tvQr = path.join(tmp, 'tv.png'); await tv.locator('#tv-qr').screenshot({ path: tvQr });
    const d2 = execFileSync('python3', ['-c', 'import cv2,sys;im=cv2.imread(sys.argv[1]);im=cv2.resize(im,(400,400),interpolation=cv2.INTER_NEAREST);print(cv2.QRCodeDetector().detectAndDecode(im)[0])', tvQr]).toString().trim();
    assert.strictEqual(d2, `${APP}/${code}`); ok('the TV QR code decodes too');
    assert.ok(!tvText.includes('rock')); ok('the TV shows nothing about individual guests');

    // ---- turning discovery off ----
    await host.uncheck('#disc'); await host.waitForTimeout(500);
    const g6 = await page(); await g6.goto(APP); await g6.waitForSelector('#join-form'); await g6.waitForTimeout(600);
    assert.ok(await g6.$eval('#nearby', (e) => e.hidden)); ok('with "show to people on this Wi-Fi" off, the room is not listed');

    // ---- phone layout ----
    const hp = await page({ width: 390, height: 800 }); await hp.goto(APP); await hp.click('#start-room'); await hp.waitForURL(/host\//);
    assert.ok(await hp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)); ok('the host header has no horizontal scroll on a phone');
    assert.deepStrictEqual(errors, [], errors.join(' | ')); ok('no page errors');
  } finally {
    await browser.close();
    await new Promise((resolve) => {
      if (srv.exitCode !== null || srv.signalCode !== null) return resolve();
      srv.once('exit', resolve);
      srv.kill('SIGTERM');
    });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log('\n' + passed + ' checks passed'); process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e.stack || e.message); process.exit(1); });
