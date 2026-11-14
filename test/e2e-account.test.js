'use strict';
// Host accounts in the browser, against a stand-in auth provider (lib/auth-fake.js, enabled only by ALLOW_FAKE_AUTH=1):
// sign up, keep a room, find it under "My rooms" on another device, take it over, sign in with Google, and guests never see any of it.
const http = require('http'), os = require('os'), path = require('path'), fs = require('fs');
const assert = require('assert');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const PORT = 4907, APP = 'http://127.0.0.1:' + PORT;
let passed = 0; const ok = (s) => { passed++; console.log('  ok  ' + s); };
const until = async (fn, ms = 10000, what = 'x') => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + what); await new Promise((r) => setTimeout(r, 100)); } };

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-account-'));
  const env = Object.assign({}, process.env, { PORT, DATA_DIR: tmp, AUTH_PROVIDER: 'fake', ALLOW_FAKE_AUTH: '1' }); delete env.DATABASE_URL;
  const srv = spawn('node', ['server.js'], { cwd: __dirname + '/..', env, stdio: ['ignore', 'ignore', 'inherit'] });
  await until(() => new Promise((r) => http.get(APP, () => r(true)).on('error', () => r(false))), 8000, 'server up');
  const browser = await chromium.launch(); const errors = [];
  const device = async () => { const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } }); const page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message)); return { ctx, page }; };
  const text = async (page, sel) => (await page.textContent(sel)) || '';
  try {
    // ---- device A: sign up, start a room, keep it ----
    const A = (await device()).page;
    await A.goto(APP); await A.waitForSelector('#account');
    assert.ok(/Host account \(optional\)/.test(await text(A, '#account'))); assert.ok(/Guests never need an account/.test(await text(A, '#account')));
    await A.fill('#account input[type=email]', 'ann@example.test'); await A.fill('#account input[type=password]', 'secret1');
    await A.click('#account .account-form button.btn:not(.primary)'); // switch to "create account"
    await A.click('#account .account-form button[type=submit]');
    await until(async () => /Signed in as ann/.test(await text(A, '#account')), 8000, 'signed in after sign up');
    ok('a host can create an account from the landing page');
    await A.click('#start-room'); await A.waitForURL(/\/host\/[A-Z0-9]{5}$/);
    const code = A.url().split('/').pop();
    await A.waitForSelector('#account button.primary');
    assert.ok(/Keep this room/.test(await text(A, '#account')));
    await A.click('#account button.primary');
    await until(async () => /Stop keeping this room/.test(await text(A, '#account')), 8000, 'kept');
    ok('on the host page, "Keep this room" keeps it');

    // ---- device B: signed out, sign in, find the room under My rooms, open it ----
    const B = await device();
    await B.page.goto(APP); await B.page.waitForSelector('#account');
    await B.page.fill('#account input[type=email]', 'ann@example.test'); await B.page.fill('#account input[type=password]', 'wrong');
    await B.page.click('#account .account-form button[type=submit]');
    await until(async () => /Invalid email or password/.test(await text(B.page, '#account')), 8000, 'wrong password message');
    ok('a wrong password says so');
    await B.page.fill('#account input[type=password]', 'secret1'); await B.page.click('#account .account-form button[type=submit]');
    await until(async () => (await B.page.$$('#account .account-rooms li')).length === 1, 8000, 'my rooms');
    assert.ok(new RegExp(code).test(await text(B.page, '#account .account-rooms')));
    ok('on another device, signing in lists the kept room under My rooms');
    await B.page.click('#account .account-rooms button'); await B.page.waitForURL(new RegExp('/host/' + code + '$'));
    await B.page.waitForSelector('#btn-next');
    ok('"Open" gives that device the host key and opens the room as its host');

    // ---- device C: lands straight on the host URL without the key ----
    const Cc = await device(), C = Cc.page;
    await C.goto(APP + '/host/' + code); await C.waitForSelector('#account');
    assert.ok(/did not start room/.test(await C.textContent('body'))); assert.ok(/Is this your room\?/.test(await text(C, '#account')));
    await C.fill('#account input[type=email]', 'ann@example.test'); await C.fill('#account input[type=password]', 'secret1'); await C.click('#account .account-form button[type=submit]');
    await until(async () => /Take over room/.test(await text(C, '#account')), 8000, 'take over offered');
    await C.click('#account button.primary'); await C.waitForSelector('#btn-next', { timeout: 10000 });
    ok('a signed-in owner can take over a room that this browser did not start');

    // ---- someone else cannot ----
    const D = (await device()).page;
    await D.goto(APP + '/host/' + code); await D.waitForSelector('#account');
    await D.fill('#account input[type=email]', 'bob@example.test'); await D.fill('#account input[type=password]', 'pw');
    await D.click('#account .account-form button.btn:not(.primary)'); await D.click('#account .account-form button[type=submit]');
    await until(async () => /not kept under your account/.test(await text(D, '#account')), 8000, 'not yours');
    assert.ok(!/Take over/.test(await text(D, '#account')));
    ok('another account is told the room is not theirs');

    // ---- Google ----
    const G = (await device()).page;
    await G.goto(APP + '/?x=1'); await G.waitForSelector('#account');
    await G.click('#account >> text=Continue with Google');
    await until(async () => /Signed in as Gina/.test(await text(G, '#account')), 10000, 'google sign-in');
    assert.ok(!/neon_auth_session_verifier/.test(G.url()), 'the one-time verifier is removed from the address bar');
    assert.ok(/x=1/.test(G.url()), 'other query parameters are kept');
    ok('"Continue with Google" returns signed in, and the one-time verifier leaves the address bar');
    await G.click('#account >> text=Sign out');
    await until(async () => /Host account \(optional\)/.test(await text(G, '#account')), 8000, 'signed out');
    ok('signing out returns to the sign-in form');

    // ---- guests never see it ----
    const Gu = (await device()).page;
    await Gu.goto(APP + '/r/' + code); await Gu.waitForSelector('body');
    await new Promise((r) => setTimeout(r, 800));
    assert.strictEqual((await Gu.$$('#account, #account-mount')).length, 0); ok('the guest page has no account UI at all');
  } catch (e) { console.error('FAILED:', e.message); await browser.close(); srv.kill(); process.exit(1); }
  await browser.close(); srv.kill();
  if (errors.length) { console.error('page errors', errors); process.exit(1); }
  console.log('\n' + passed + ' checks passed');
})();
