'use strict';
// Duels in real browsers: the TV overlay, health bars and name tags over the avatars, and two guests' phones.
// Set FIGHT_SHOTS=/some/dir to save screenshots of each stage.
const http = require('http'), os = require('os'), path = require('path'), fs = require('fs');
const assert = require('assert');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const PORT = 4907, APP = 'http://127.0.0.1:' + PORT;
let passed = 0; const ok = (s) => { passed++; console.log('  ok  ' + s); };
const until = async (fn, ms = 10000, what = 'x') => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + what); await new Promise((r) => setTimeout(r, 100)); } };
const SHOTS = process.env.FIGHT_SHOTS; if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-fight-'));
  const srv = spawn('node', ['server.js'], { cwd: __dirname + '/..', env: Object.assign({}, process.env, { PORT, DATA_DIR: tmp }), stdio: ['ignore', 'ignore', 'inherit'] });
  await until(() => new Promise((r) => http.get(APP, () => r(true)).on('error', () => r(false))), 8000, 'server up');
  const browser = await chromium.launch(); const errors = [];
  const watch = (p) => { p.on('pageerror', (e) => errors.push(e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/fonts|ERR_|Failed to load resource/.test(m.text())) errors.push(m.text()); }); p.route(/^https:\/\//, (r) => r.abort()); };
  const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };
  try {
    const hctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, reducedMotion: 'no-preference' });
    const host = await hctx.newPage(); watch(host);
    await host.goto(APP); await host.click('#start-room'); await host.waitForURL(/\/host\/[A-Z0-9]{5}$/);
    const code = host.url().split('/').pop();
    const api = (page, p, body, headers) => page.evaluate(([c, p, b, h]) => fetch('/api/rooms/' + c + p, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, h || {}), body: JSON.stringify(b || {}) }).then(async (r) => ({ ok: r.ok, status: r.status, json: await r.json().catch(() => null) })), [code, p, body, headers]);
    const hostKey = await host.evaluate((c) => localStorage.getItem('rb-host-' + c), code);
    await api(host, '/host/opts', { settle: 0 }, { 'x-host-key': hostKey });
    const join = (name, genre) => api(host, '/guests', { name, genres: [genre] }).then((r) => r.json);
    const ana = await join('Ana', 'rock'), ben = await join('Ben <i>', 'blues'), cy = await join('Cy', 'country');
    const asGuest = (g) => ({ 'x-guest-id': g.guestId, 'x-guest-key': g.guestKey });
    await api(host, '/request', { title: 'Hotel California', artist: 'Eagles' }, asGuest(ana));
    await api(host, '/request', { title: 'The Thrill Is Gone', artist: 'B.B. King' }, asGuest(ben));

    // ---- host settings ----
    await host.locator('#duel-panel summary').click();
    assert.strictEqual(await host.locator('#duel-on').isChecked(), true);
    assert.strictEqual(await host.locator('#s-duel-n').inputValue(), '2');
    assert.strictEqual(await host.locator('#s-duel-w').inputValue(), '15');
    await host.locator('#s-duel-n').fill('3');
    await until(async () => (await host.locator('#o-duel-n').textContent()) === '3 challenges', 3000, 'output shows 3');
    ok('the host sees the duel settings and can change the allowance');
    await host.locator('#s-duel-n').fill('2');

    // ---- two phones ----
    const phone = async (g, name) => {
      const ctx = await browser.newContext({ viewport: { width: 400, height: 900 }, hasTouch: true });
      await ctx.addInitScript(([c, g, n]) => { localStorage.setItem('rb-guest-' + c, JSON.stringify({ id: g.guestId, key: g.guestKey, name: n, genres: [], artists: [], songs: [], lookupGenres: true, since: Date.now() })); }, [code, g, name]);
      const p = await ctx.newPage(); watch(p); await p.goto(APP + '/r/' + code);
      await p.waitForSelector('#gv-title'); return p;
    };
    const pa = await phone(ana, 'Ana'), pb = await phone(ben, 'Ben <i>');
    await until(async () => (await pa.locator('.duel-panel').isVisible()), 8000, 'duel panel on Ana\'s phone');
    await until(async () => (await pa.locator('.duel-row .btn').count()) >= 1, 10000, 'Ben on Ana\'s roster');
    assert.match(await pa.locator('.duel-panel .meta').innerText(), /2 of 2 challenges left/);
    assert.match(await pa.locator('.duel-row').first().innerText(), /Ben i/);
    assert.strictEqual(await pa.locator('.duel-row i:not(.duel-dot)').count(), 0); ok('names on the phone are text, never markup');
    assert.strictEqual(await pa.locator('.duel-row .btn').first().isEnabled(), true);
    ok('a guest with a song waiting sees who they can challenge and how many challenges are left');
    await shot(pa, '1-phone-roster');

    // ---- TV: name tags over every avatar ----
    await host.click('#tv-mode');
    await until(async () => (await host.locator('.av').count()) === 3, 10000, 'avatars');
    const names = await host.locator('.av .av-name').allInnerTexts();
    assert.deepStrictEqual(names.map((n) => n.trim()).sort(), ['Ana', 'Ben i', 'Cy']);
    assert.strictEqual(await host.locator('.av.has-req').count(), 2); ok('every avatar has a name tag, and guests with a song waiting are marked');
    assert.strictEqual(await host.locator('.av-hp').first().isVisible(), false); ok('health bars stay hidden outside a duel');
    await shot(host, '2-tv-idle');

    // ---- challenge ----
    await pa.locator('.duel-row .btn').first().click();
    await until(async () => (await pb.locator('.duel-incoming').isVisible()), 8000, 'challenge reaches Ben');
    assert.match(await pb.locator('.duel-incoming .duel-head').innerText(), /Ana challenges you/);
    await until(() => pb.locator('.duel-incoming .btn.primary').evaluate((b) => { const r = b.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }), 4000, 'Accept button scrolled into view');
    ok('an incoming challenge scrolls itself into view, so it cannot be missed');
    await until(async () => (await host.locator('#tv-cast-fight').isVisible()), 8000, 'TV overlay');
    assert.match(await host.locator('.tvf-head').innerText(), /Ana challenges Ben/);
    assert.strictEqual(await host.locator('#tv-cast-view.has-fight').count(), 1); ok('a challenge shows on the TV and on the other guest\'s phone');
    await shot(pb, '3-phone-incoming'); await shot(host, '4-tv-challenge');
    assert.match(await pa.locator('.duel-panel .meta').innerText(), /1 of 2 challenges left/); ok('declaring a challenge uses up one of the allowance');
    await pb.locator('.duel-incoming .btn.primary').click();

    // ---- the fight: avatars walk to the ring and show health ----
    await until(async () => (await host.locator('.av.in-ring').count()) === 2, 8000, 'both fighters in the ring');
    assert.strictEqual(await host.locator('.av.is-fighting .av-hp:visible').count(), 2);
    assert.strictEqual(await host.locator('.av.is-cheering').count(), 1); ok('the fighters take the ring, show health bars, and the other guest cheers');
    await until(async () => (await pa.locator('.duel-move').first().isVisible()) && (await pb.locator('.duel-move').first().isVisible()), 10000, 'pick phase');
    await shot(pa, '5-phone-pick'); await shot(host, '6-tv-pick');
    const play = async (pg, label) => { await pg.locator('.duel-move').nth(['Strike', 'Feint', 'Guard'].indexOf(label)).click(); };
    let rounds = 0, sawChaos = false;
    while (rounds < 9) {
      const over = await host.locator('.tvf-head.is-win').count() || /wins!|calls it|walked/i.test(await host.locator('.tvf-head').innerText().catch(() => ''));
      if (over) break;
      if (await pa.locator('.duel-move:enabled').count() && await pb.locator('.duel-move:enabled').count()) {
        await play(pa, 'Strike'); await play(pb, 'Guard'); rounds++;
        if (await host.locator('.tvf-chaos').isVisible()) sawChaos = true;
        await until(async () => (await host.locator('.tvf-move').first().isVisible()), 6000, 'reveal');
        if (rounds === 1) {
          assert.strictEqual(await host.locator('.tvf-move.is-loser').count(), 1);
          assert.strictEqual(await host.locator('.tvf-move.is-winner').count(), 1);
          await until(async () => (await host.locator('.av.mv-strike, .av.mv-guard').count()) === 2, 2000, 'move animations');
          await shot(host, '7-tv-reveal'); ok('both moves are revealed at once, with a winner, and the avatars act them out');
          const hp = await host.locator('.av-hp').evaluateAll((els) => els.map((e) => e.textContent));
          assert.ok(hp.some((t) => Number(t) < 100)); ok('health bars drop after a hit');
        }
      }
      await host.waitForTimeout(250);
    }
    await until(async () => /wins|calls it|walked/i.test(await host.locator('.tvf-head').innerText().catch(() => '')), 30000, 'result');
    await shot(host, '8-tv-result');
    assert.match(await host.locator('.tvf-sub').innerText(), /moves up|already as high/); ok('the result says whose song moves, and by how much');
    await shot(pa, '9-phone-result');

    // ---- clean up ----
    await until(async () => (await host.locator('#tv-cast-fight').isHidden()), 15000, 'overlay closes');
    await until(async () => (await host.locator('.av.is-fighting').count()) === 0, 8000, 'fighters released'); ok('everything clears and the fighters walk back to the floor');

    // ---- rate limit on the phone: after a duel nobody can be challenged again at once, and the phone says why ----
    assert.match(await pa.locator('.duel-panel .meta').innerText(), /1 of 2 challenges left/);
    await until(async () => (await pa.locator('.duel-empty').count()) + (await pa.locator('.duel-why').count()) >= 1, 8000, 'phone explains');
    ok('after a duel the phone shows no open challenge, and says why');

    assert.deepStrictEqual(errors, []); ok('no page errors');
  } finally { await browser.close(); srv.kill(); }
  console.log(passed + ' browser checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
