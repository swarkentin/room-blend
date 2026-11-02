'use strict';
// Presence in real browsers: leaving the Wi-Fi marks a guest away, "still here?" appears and is answered.
const http = require('http'), os = require('os'), path = require('path'), fs = require('fs');
const assert = require('assert');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const PORT = 4899, APP = 'http://127.0.0.1:' + PORT;
let passed = 0; const ok = (s) => { passed++; console.log('  ok  ' + s); };
const until = async (fn, ms = 10000, what = 'x') => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + what); await new Promise((r) => setTimeout(r, 100)); } };

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-pres-'));
  const srv = spawn('node', ['server.js'], { cwd: __dirname + '/..', env: Object.assign({}, process.env, { PORT, DATA_DIR: tmp, TRUST_PROXY: '1', BEAT_MS: '400', DISCONNECT_GRACE_MS: '2000', DOZE_DEFAULT_MIN: '0.1', IDLE_ASK_S: '10', IDLE_ANSWER_MS: '4000' }), stdio: ['ignore', 'ignore', 'inherit'] });
  await until(() => new Promise((r) => http.get(APP, () => r(true)).on('error', () => r(false))), 8000, 'server up');
  const browser = await chromium.launch(); const errors = [];
  const HOME = { 'x-forwarded-for': '203.0.113.5' }, ELSEWHERE = { 'x-forwarded-for': '198.51.100.7' };
  const mk = async (headers, vp) => { const c = await browser.newContext({ viewport: vp || { width: 420, height: 850 }, extraHTTPHeaders: headers }); const p = await c.newPage(); p.on('pageerror', (e) => errors.push(e.message)); return [c, p]; };
  try {
    const [, host] = await mk(HOME, { width: 1200, height: 900 });
    await host.goto(APP); await host.click('#start-room'); await host.waitForURL(/\/host\/[A-Z0-9]{5}$/);
    const code = host.url().split('/').pop();
    await host.fill('#room-name', 'Pres'); await host.waitForTimeout(500);
    await host.evaluate(() => fetch('/api/rooms/' + location.pathname.split('/').pop() + '/host/opts', { method: 'POST' }).catch(() => {}));

    // ---- a guest on the same Wi-Fi, then off it ----
    const [gc, g] = await mk(HOME);
    await g.goto(APP + '/' + code); await g.waitForSelector('#gv-picker .chip'); await g.fill('#gv-name', 'Ana');
    await g.click('#gv-picker [data-g="rock"]'); await g.click('#gv-submit'); await g.waitForSelector('#gv-title');
    await until(async () => /In the blend/.test(await host.textContent('#guests')), 12000, 'Ana counts').catch(async (e) => { console.log('GUESTS:', await host.textContent('#guests')); throw e; });
    ok('a guest on the room\'s Wi-Fi counts in the blend');
    await gc.setExtraHTTPHeaders(ELSEWHERE); // the phone leaves the Wi-Fi
    await until(async () => /Away: left the Wi-Fi/.test(await host.textContent('#guests')), 12000, 'away shown to host');
    ok('when the phone leaves the Wi-Fi the host sees "Away: left the Wi-Fi"');
    await until(async () => /left the Wi-Fi/.test(await g.textContent('#gv-me')), 8000, 'away shown to guest');
    ok('the guest is told songs are chosen without them');
    await gc.setExtraHTTPHeaders(HOME);
    await until(async () => /In the blend/.test(await host.textContent('#guests')), 8000, 'back in the blend');
    ok('back on the Wi-Fi, they rejoin the blend without doing anything');

    // ---- "still here?" ----
    await until(async () => !(await g.getAttribute('#gv-ask', 'hidden')), 16000, 'still here prompt');
    ok('after a while without a touch the guest sees "Still here?"');
    await g.click('#gv-here');
    await until(async () => (await g.getAttribute('#gv-ask', 'hidden')) !== null, 5000, 'prompt gone');
    ok('tapping "I\'m still here" clears it');
    await new Promise((r) => setTimeout(r, 11000)); // leave the page alone: ask, then no answer
    await until(async () => /Quiet|Away/.test(await host.textContent('#guests')) || /did not answer/.test(await g.textContent('#gv-me')), 16000, 'idle away');
    ok('with no answer the guest is set to sit out');
    await g.click('#gv-me');
    await until(async () => /In the blend/.test(await host.textContent('#guests')), 8000, 'back after touch');
    ok('touching the page brings them back');

    // ---- a locked phone (guest on mobile data, never on the host's Wi-Fi) ----
    const [lc, l] = await mk(ELSEWHERE);
    await l.goto(APP + '/' + code); await l.waitForSelector('#gv-picker .chip'); await l.fill('#gv-name', 'Lee');
    await l.click('#gv-picker [data-g="blues"]'); await l.click('#gv-submit'); await l.waitForSelector('#gv-title');
    await until(async () => /Lee[\s\S]*In the blend/.test(await host.textContent('#guests')), 12000, 'Lee counts');
    ok('a guest on mobile data, never on the host\'s Wi-Fi, counts in the blend and is not marked away');
    await l.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
    await new Promise((r) => setTimeout(r, 400));
    await l.close(); // the locked phone drops its connection
    await until(async () => /Phone locked, still counted/.test(await host.textContent('#guests')), 8000, 'dozing shown');
    await new Promise((r) => setTimeout(r, 2800)); // longer than the 2 s short grace
    assert.ok(/Lee/.test(await host.textContent('#guests')) && /Phone locked/.test(await host.textContent('#guests'))); ok('a locked phone is still counted after the short grace has passed');
    await until(async () => !/Lee/.test(await host.textContent('#guests')), 12000, 'lease runs out');
    ok('when the doze lease runs out the guest is dropped');
    const l2 = await lc.newPage(); l2.on('pageerror', (e) => errors.push(e.message)); await l2.goto(APP + '/' + code); // the phone is unlocked and the page opened again
    await until(async () => /Lee/.test(await host.textContent('#guests')), 15000, 'Lee rejoins');
    ok('opening the page again rejoins them with their picks, no tap needed');
  } catch (e) { console.error('FAILED:', e.message); await browser.close(); srv.kill(); process.exit(1); }
  await browser.close(); srv.kill();
  if (errors.length) { console.error('page errors', errors); process.exit(1); }
  console.log(passed + ' checks passed');
})();
