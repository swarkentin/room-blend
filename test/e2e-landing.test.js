'use strict';
// The landing page explains the idea, lets a visitor try the blend, and gets a host going; the host page opens with a short checklist.
const http = require('http'), os = require('os'), path = require('path'), fs = require('fs');
const assert = require('assert');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const PORT = 4914, APP = 'http://127.0.0.1:' + PORT;
let passed = 0; const ok = (s) => { passed++; console.log('  ok  ' + s); };
const until = async (fn, ms = 10000, what = 'x') => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + what); await new Promise((r) => setTimeout(r, 100)); } };

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-landing-'));
  const env = Object.assign({}, process.env, { PORT, DATA_DIR: tmp }); delete env.DATABASE_URL;
  const srv = spawn('node', ['server.js'], { cwd: __dirname + '/..', env, stdio: ['ignore', 'ignore', 'inherit'] });
  await until(() => new Promise((r) => http.get(APP, () => r(true)).on('error', () => r(false))), 8000, 'server up');
  const browser = await chromium.launch(); const errors = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
    await p.route(/^https:\/\//, (r) => r.abort());
    await p.goto(APP);
    await p.waitForSelector('.landing-art .landing-wave');
    assert.match(await p.textContent('h1'), /Music that fits the whole room/);
    assert.ok(await p.locator('#start-room').isVisible()); assert.ok(await p.locator('a[href="/demo"]').isVisible());
    assert.match(await p.textContent('.lead'), /QR code/); ok('the landing page leads with the product promise and clear start/demo actions');

    assert.strictEqual(await p.locator('.how-line li').count(), 3);
    assert.strictEqual(await p.locator('.landing-feature').count(), 6);
    assert.ok(await p.locator('.landing-art').isVisible());
    assert.ok(await p.locator('.landing-wave i').count() >= 20);
    assert.ok(await p.locator('.landing-explore').getAttribute('href') === '#landing-features');
    await p.waitForFunction(() => getComputedStyle(document.querySelector('.landing-wave i')).animationName === 'landing-wave');
    const animation = await p.locator('.landing-wave i').first().evaluate((node) => getComputedStyle(node).animationName);
    assert.strictEqual(animation, 'landing-wave');
    ok('the animated hero explains how individual tastes feed a shared room mix, followed by discoverable steps and differentiating features');

    await p.click('.landing-explore');
    assert.ok(await p.locator('#landing-features').isVisible());
    assert.match(await p.textContent('#landing-features'), /fair turn|fairly/i);
    assert.match(await p.textContent('#landing-features'), /Spotify/);
    assert.match(await p.textContent('#landing-features'), /avatars/);
    ok('feature navigation exposes fair blending, host music sources, and the live TV experience');

    await p.click('a[href="/demo"]'); await p.waitForURL(/\/demo$/);
    await p.waitForSelector('.demo-songs li');
    assert.match(await p.textContent('.demo-line'), /likes blues/); assert.ok(await p.locator('.demo-songs li').count() >= 3);
    assert.strictEqual(await p.locator('.demo-person[aria-pressed="true"]').count(), 2); ok('the demo opens with two people who share a genre, and shows songs from the overlap');

    await p.click('.demo-person:nth-child(3)'); await p.click('.demo-person:nth-child(4)');
    await until(async () => /takes turns/.test(await p.textContent('.demo-line')), 5000, 'turns line');
    assert.ok((await p.locator('.demo-why.turn').count()) >= 1); ok('adding people with nothing in common switches the demo to taking turns, naming whose turn it is');

    for (const g of ['pop']) await p.click('.demo-you .chip:text-is("' + g + '")');
    await until(async () => /You/.test(await p.textContent('.demo-out')) || (await p.locator('.demo-songs li').count()) > 0, 5000, 'you');
    for (const n of [1, 2, 3, 4]) await p.click('.demo-person:nth-child(' + n + ')');
    await p.click('.demo-you .chip:text-is("pop")');
    await until(async () => /Nobody is in the room/.test(await p.textContent('.demo-out')), 5000, 'empty'); ok('with nobody in, the demo says so instead of showing songs');

    const bad = await p.evaluate(async () => { const r = await fetch('/api/demo/blend', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ people: [{ name: '<b>x</b>', genres: ['rock', 'nonsense'] }, null, 5] }) }); return { status: r.status, body: await r.json() }; });
    assert.strictEqual(bad.status, 200); assert.ok(!/<b>/.test(JSON.stringify(bad.body))); ok('the demo endpoint ignores junk and strips markup from names');

    await p.setViewportSize({ width: 390, height: 844 });
    assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)); ok('no sideways scrolling on a phone');
    await p.setViewportSize({ width: 1280, height: 900 });

    await p.click('.back'); await p.waitForURL(APP + '/');
    assert.ok(await p.locator('#join-form #join-code').isVisible()); ok('the demo links back, and joining with a code still works on the landing page');

    await p.click('#start-room'); await p.waitForURL(/\/host\/[A-Z0-9]{5}$/);
    await p.waitForSelector('.onboard');
    const steps = await p.locator('.onboard-steps li').count(); assert.strictEqual(steps, 3);
    assert.ok(await p.locator('.onboard-steps li.next').count() === 1 && /Choose the music/.test(await p.textContent('.onboard-steps li.next')));
    ok('a new host page opens with a three-step checklist, with the next step highlighted');

    const code = p.url().split('/').pop();
    await p.evaluate(async (c) => { await fetch('/api/rooms/' + c + '/guests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Ana', genres: ['jazz'] }) }); }, code);
    await until(async () => /1 person has joined/.test(await p.textContent('.onboard')), 10000, 'joined');
    ok('when a guest joins, the "invite friends" step ticks off');

    await p.click('.onboard .btn:text-is("Hide")');
    await p.reload(); await p.waitForSelector('#now-title'); await p.waitForTimeout(800);
    assert.strictEqual(await p.locator('.onboard').count(), 0); ok('hiding the checklist keeps it hidden on this browser');

    assert.deepStrictEqual(errors, []); ok('no page errors');
    console.log('\n' + passed + ' checks passed');
  } catch (e) { console.error('FAILED:', e); process.exitCode = 1; } finally { await browser.close(); srv.kill(); await new Promise((r) => setTimeout(r, 300)); try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { /* the server may still be writing */ } }
})();
