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
  const start = async (port, extra) => {
    const env = Object.assign({}, process.env, { PORT: port, DATA_DIR: tmp, AUTH_PROVIDER: 'fake', ALLOW_FAKE_AUTH: '1' }, extra); delete env.DATABASE_URL; if (!extra.AUTH_METHODS) delete env.AUTH_METHODS;
    const p = spawn('node', ['server.js'], { cwd: __dirname + '/..', env, stdio: ['ignore', 'ignore', 'inherit'] });
    await until(() => new Promise((r) => http.get('http://127.0.0.1:' + port, () => r(true)).on('error', () => r(false))), 8000, 'server up');
    return p;
  };
  const srv = await start(PORT, { AUTH_METHODS: 'google,email' });
  const srv2 = await start(PORT + 1, {});
  const browser = await chromium.launch(); const errors = [];
  const device = async (w = 1100) => { const ctx = await browser.newContext({ viewport: { width: w, height: 900 } }); const page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message)); return { ctx, page }; };
  const text = async (page, sel) => (await page.textContent(sel)) || '';
  const dlg = '[role=dialog][aria-modal=true]';
  const signInEmail = async (page, email, pw, create) => {
    await page.fill(dlg + ' input[type=email]', email); await page.fill(dlg + ' input[type=password]', pw);
    if (create) await page.click(dlg + ' .acct-tab >> text=Create account');
    await page.click(dlg + ' button[type=submit]');
  };
  try {
    // ---- device A: sign up from the header, start a room, keep it ----
    const A = (await device()).page;
    await A.goto(APP); await A.waitForSelector('#account-mount button');
    assert.strictEqual((await A.$$('#account')).length, 0, 'no permanent account card');
    assert.ok(await A.isVisible('#account-mount >> text=Sign in'));
    await A.click('#account-mount button');
    await A.waitForSelector(dlg);
    assert.ok(/Optional\. Sign in to keep rooms for 30 days and open them on any device\. Guests never need an account\./.test(await text(A, dlg)));
    assert.ok(await A.$(dlg + '[aria-labelledby]'));
    assert.ok(/Continue with Google/.test(await text(A, dlg)) && (await A.$(dlg + ' input[type=email]')));
    ok('the header Sign in button opens a labelled dialog with the enabled methods');
    await A.keyboard.press('Escape'); await until(async () => !(await A.$(dlg)), 3000, 'esc closes');
    assert.strictEqual(await A.evaluate(() => document.activeElement && document.activeElement.textContent), 'Sign in');
    ok('Esc closes the dialog and returns focus to the button');
    await A.click('#account-mount button'); await A.waitForSelector(dlg);
    for (let i = 0; i < 12; i++) await A.keyboard.press('Tab');
    assert.ok(await A.evaluate(() => !!document.activeElement.closest('[role=dialog]')), 'focus stays inside the dialog');
    await signInEmail(A, 'ann@example.test', 'secret1', true);
    await until(async () => /ann/i.test(await text(A, '#account-mount .chip')), 8000, 'signed in after sign up');
    ok('a host can create an account from the landing page');
    await A.click('#start-room'); await A.waitForURL(/\/host\/[A-Z0-9]{5}$/);
    const code = A.url().split('/').pop();
    await A.waitForSelector('#keep-mount .keep-chip');
    assert.strictEqual(await A.getAttribute('#keep-mount .keep-chip', 'aria-pressed'), 'false');
    assert.strictEqual((await A.$$('.side #account-mount, .side #account')).length, 0, 'nothing in the right-hand column');
    await A.click('#keep-mount .keep-chip');
    await until(async () => (await A.getAttribute('#keep-mount .keep-chip', 'aria-pressed')) === 'true', 8000, 'kept');
    ok('on the host page, the Keep this room toggle keeps it');
    await A.click('#account-mount .chip'); await A.waitForSelector(dlg);
    assert.ok(new RegExp(code).test(await text(A, dlg)) && /This room/.test(await text(A, dlg)), 'the menu marks the current room');
    await A.keyboard.press('Escape');
    await A.click('#keep-mount .keep-chip');
    await until(async () => (await A.getAttribute('#keep-mount .keep-chip', 'aria-pressed')) === 'false', 8000, 'unkept');
    await A.click('#keep-mount .keep-chip');
    await until(async () => (await A.getAttribute('#keep-mount .keep-chip', 'aria-pressed')) === 'true', 8000, 'kept again');
    ok('the toggle turns off and on again');

    // ---- device B: signed out, sign in, find the room under My rooms, open it ----
    const B = await device();
    await B.page.goto(APP + '/host/' + code); await B.page.waitForSelector('.acct-locked');
    await B.page.goto(APP); await B.page.waitForSelector('#account-mount button');
    await B.page.click('#account-mount button'); await B.page.waitForSelector(dlg);
    await signInEmail(B.page, 'ann@example.test', 'wrong');
    await until(async () => /Invalid email or password/.test(await text(B.page, dlg + ' .acct-err')), 8000, 'wrong password message');
    ok('a wrong password shows the provider message inline');
    await B.page.fill(dlg + ' input[type=password]', 'secret1'); await B.page.click(dlg + ' button[type=submit]');
    await until(async () => !(await B.page.$(dlg)) && (await B.page.$('#account-mount .chip')), 8000, 'signed in');
    await B.page.click('#account-mount .chip'); await B.page.waitForSelector(dlg + ' .account-rooms li');
    assert.strictEqual((await B.page.$$(dlg + ' .account-rooms li')).length, 1);
    assert.ok(new RegExp(code).test(await text(B.page, dlg + ' .account-rooms')));
    ok('on another device, the account menu lists the kept room under My rooms');
    await B.page.click(dlg + ' .account-rooms button'); await B.page.waitForURL(new RegExp('/host/' + code + '$'));
    await B.page.waitForSelector('#btn-next');
    ok('"Open" gives that device the host key and opens the room as its host');

    // ---- device C: lands straight on the host URL without the key ----
    const Cc = await device(390), C = Cc.page;
    await C.goto(APP + '/host/' + code); await C.waitForSelector('.acct-locked');
    assert.ok(/did not start room/.test(await C.textContent('body'))); assert.ok(/Is this your room\?/.test(await text(C, '.acct-locked')));
    await C.click('.acct-locked >> text=Sign in to take over'); await C.waitForSelector(dlg);
    await signInEmail(C, 'ann@example.test', 'secret1');
    await until(async () => /Take over room/.test(await text(C, '.acct-locked')), 8000, 'take over offered');
    await C.click('.acct-locked button.primary'); await C.waitForSelector('#btn-next', { timeout: 10000 });
    ok('a signed-in owner can take over a room that this browser did not start (phone width)');

    // ---- someone else cannot ----
    const D = (await device()).page;
    await D.goto(APP + '/host/' + code); await D.waitForSelector('.acct-locked');
    await D.click('.acct-locked >> text=Sign in to take over'); await D.waitForSelector(dlg);
    await signInEmail(D, 'bob@example.test', 'pw', true);
    await until(async () => /not kept under your account/.test(await text(D, '.acct-locked')), 8000, 'not yours');
    assert.ok(!/Take over room/.test(await text(D, '.acct-locked')));
    ok('another account is told the room is not theirs');

    // ---- sign-up that needs email confirmation ----
    const U = (await device()).page;
    await U.goto(APP); await U.click('#account-mount button'); await U.waitForSelector(dlg);
    await signInEmail(U, 'unverified1@example.test', 'pw', true);
    await until(async () => /Check your email/.test(await text(U, dlg)), 8000, 'check your email');
    assert.ok(!(await U.$('#account-mount .chip')));
    ok('a sign-up without a session shows the "check your email" state');

    // ---- Google ----
    const G = (await device()).page;
    await G.goto(APP + '/?x=1'); await G.click('#account-mount button'); await G.waitForSelector(dlg);
    await G.click(dlg + ' >> text=Continue with Google');
    await until(async () => /Gina/.test(await text(G, '#account-mount .chip')), 10000, 'google sign-in');
    assert.ok(!/neon_auth_session_verifier/.test(G.url()), 'the one-time verifier is removed from the address bar');
    assert.ok(/x=1/.test(G.url()), 'other query parameters are kept');
    ok('"Continue with Google" returns signed in, and the one-time verifier leaves the address bar');
    await G.click('#account-mount .chip'); await G.waitForSelector(dlg);
    assert.ok(/No kept rooms yet/.test(await text(G, dlg)));
    await G.click(dlg + ' >> text=Sign out');
    await until(async () => (await text(G, '#account-mount')).trim() === 'Sign in', 8000, 'signed out');
    ok('signing out returns to the Sign in button (and My rooms shows an empty state)');

    // ---- signed out on the host page: Keep opens sign-in with context ----
    const K = (await device()).page;
    await K.goto(APP); await K.click('#start-room'); await K.waitForURL(/\/host\//); await K.waitForSelector('#keep-mount .keep-chip');
    await K.click('#keep-mount .keep-chip'); await K.waitForSelector(dlg);
    assert.ok(/Sign in to keep this room/.test(await text(K, dlg)));
    ok('signed out, Keep this room opens sign-in with that context');

    // ---- default methods: Google only, no email/password inputs anywhere ----
    const P = (await device()).page;
    await P.goto('http://127.0.0.1:' + (PORT + 1)); await P.click('#account-mount button'); await P.waitForSelector('[role=dialog]');
    assert.ok(/Continue with Google/.test(await text(P, '[role=dialog]')));
    assert.strictEqual((await P.$$('input[type=email], input[type=password]')).length, 0);
    ok('by default (AUTH_METHODS unset) only Google is offered: no email or password inputs');

    // ---- guests never see it ----
    const Gu = (await device()).page;
    await Gu.goto(APP + '/r/' + code); await Gu.waitForSelector('body');
    await new Promise((r) => setTimeout(r, 800));
    assert.strictEqual((await Gu.$$('#account, #account-mount, #keep-mount')).length, 0); ok('the guest page has no account UI at all');
  } catch (e) { console.error('FAILED:', e.message); await browser.close(); srv.kill(); srv2.kill(); process.exit(1); }
  await browser.close(); srv.kill(); srv2.kill();
  if (errors.length) { console.error('page errors', errors); process.exit(1); }
  console.log('\n' + passed + ' checks passed');
})();
