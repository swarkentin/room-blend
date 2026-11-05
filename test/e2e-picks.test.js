'use strict';
// A guest names artists and songs in a real browser: search, add, remove, survive a reload, stay private.
const http = require('http'), os = require('os'), path = require('path'), fs = require('fs');
const assert = require('assert');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const PORT = 4896, APP = 'http://127.0.0.1:' + PORT;
let passed = 0; const ok = (s) => { passed++; console.log('  ok  ' + s); };
const until = async (fn, ms = 8000, what = 'x') => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + what); await new Promise((r) => setTimeout(r, 100)); } };

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-picks-'));
  const srv = spawn('node', ['server.js'], { cwd: __dirname + '/..', env: Object.assign({}, process.env, { PORT, DATA_DIR: tmp, MUSICBRAINZ_SEARCH_DISABLED: '1' }), stdio: ['ignore', 'ignore', 'inherit'] });
  await until(() => new Promise((r) => http.get(APP, () => r(true)).on('error', () => r(false))), 8000, 'server up');
  const browser = await chromium.launch(); const errors = [];
  const page = async (vp) => { const c = await browser.newContext({ viewport: vp || { width: 400, height: 850 } }); const p = await c.newPage(); p.on('pageerror', (e) => errors.push(e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/fonts|ERR_|Failed to load resource/.test(m.text())) errors.push(m.text()); }); await p.route(/^https:\/\//, (r) => r.abort()); return p; };
  try {
    const host = await page({ width: 1200, height: 900 });
    await host.goto(APP); await host.click('#start-room'); await host.waitForURL(/\/host\/[A-Z0-9]{5}$/);
    const code = host.url().split('/').pop();

    const g = await page(); await g.goto(`${APP}/r/${code}`);
    await g.click('#gv-picker [data-g="classical"]'); await g.click('#gv-submit'); await g.waitForSelector('#gv-title');
    await g.locator('details:has(#gv-picks) > summary').click();
    assert.ok(await g.locator('#gv-picks h2').isVisible()); assert.strictEqual(await g.textContent('#gv-picks h2'), 'Your profile and music preferences'); assert.ok(await g.locator('#gv-picks #gv-q').isVisible()); ok('after joining, the guest can expand "Your profile and music preferences" and search');

    await g.fill('#gv-picks #gv-q', 'quee');
    assert.match(await g.textContent('#gv-picks #gv-picks-msg'), /Searching the room and MusicBrainz/);
    assert.strictEqual(await g.getAttribute('#gv-picks #gv-results', 'aria-busy'), 'true');
    ok('search immediately shows progress while room and MusicBrainz results load');
    await g.waitForSelector('#gv-picks #gv-results .rrow');
    const rows = await g.locator('#gv-picks #gv-results .rrow').allTextContents(); assert.ok(rows.some((t) => /Queen/.test(t) && /songs? here/.test(t))); ok('typing part of a name lists matching artists with how many songs the room has');
    await g.locator('#gv-picks #gv-results .rrow', { hasText: 'Queen' }).first().getByRole('button', { name: /Add artist/ }).click();
    await g.waitForSelector('#gv-picks #gv-chosen .chip');
    assert.ok(/Queen/.test(await g.textContent('#gv-picks #gv-chosen'))); assert.ok(/1 added/.test(await g.textContent('#gv-picks #gv-picks-n'))); ok('adding an artist shows it as a chip and counts it beside the heading');
    assert.ok(await g.locator('#gv-picks #gv-results .rrow', { hasText: 'Queen' }).first().getByRole('button', { name: 'Added' }).isDisabled()); ok('an artist already added cannot be added twice');

    await g.fill('#gv-picks #gv-q', 'so what miles');
    await g.waitForSelector('#gv-picks #gv-results .rrow button:has-text("Add song")');
    await g.locator('#gv-picks #gv-results .rrow', { hasText: 'So What' }).first().getByRole('button', { name: 'Add song' }).click();
    await until(async () => /So What/i.test(await g.textContent('#gv-picks #gv-chosen')), 4000, 'song chip'); ok('adding a song shows it as a chip too');

    // it reached the server, and it is the only place the picks are visible
    const mine = await g.evaluate(async (c) => { const reg = JSON.parse(localStorage.getItem('rb-guest-' + c)); const r = await fetch('/api/rooms/' + c + '/events?gid=' + reg.id + '&gkey=' + reg.key); const rd = r.body.getReader(); const { value } = await rd.read(); rd.cancel(); return JSON.parse(new TextDecoder().decode(value).match(/data: (.*)\n/)[1]).me; }, code);
    assert.deepStrictEqual(mine.artists, ['Queen']); assert.strictEqual(mine.songs.length, 1); ok('the server holds the picks for this guest');

    await g.reload(); await g.waitForSelector('#gv-title');
    await g.locator('details:has(#gv-picks) > summary').click();
    await g.waitForSelector('#gv-picks #gv-chosen .chip'); assert.strictEqual(await g.locator('#gv-picks #gv-chosen .chip').count(), 2); ok('a reload keeps the picks');

    // another guest sees nothing of them
    const g2 = await page(); await g2.goto(`${APP}/r/${code}`); await g2.click('#gv-picker [data-g="rock"]'); await g2.click('#gv-submit'); await g2.waitForSelector('#gv-title');
    assert.strictEqual(await g2.locator('#gv-picks #gv-chosen .chip').count(), 0);
    const hostText = await host.evaluate(() => document.querySelector('#guests').innerText); assert.ok(!/Miles|So What/.test(hostText)); ok("a second guest starts with none, and the host's guest list does not show anyone's picks");

    // remove
    await g.locator('#gv-picks #gv-chosen .chip', { hasText: 'Queen' }).click();
    await until(async () => (await g.locator('#gv-picks #gv-chosen .chip').count()) === 1, 4000, 'chip removed'); ok('tapping a chip removes the pick');

    // limit
    for (const name of ['Adele', 'Beyonc', 'Radiohead', 'Madonna', 'Nirvana', 'Fleetwood']) {
      await g.fill('#gv-picks #gv-q', name);
      await g.waitForFunction(() => document.querySelector('#gv-picks #gv-results').children.length > 0, null, { timeout: 15000 });
      const b = g.locator('#gv-picks #gv-results .rrow button:has-text("Add artist")').first();
      if (await b.count() && await b.isEnabled()) {
        const saved = g.waitForResponse((r) => r.url().includes('/api/rooms/' + code + '/guests/') && r.request().method() === 'PATCH');
        await b.click(); await saved;
      }
    }
    assert.strictEqual(await g.locator('#gv-picks #gv-chosen .chip').count(), 6, 'one song plus exactly five artists'); assert.ok(!/Fleetwood/.test(await g.textContent('#gv-picks #gv-chosen'))); assert.ok(await g.locator('#gv-picks #gv-results .rrow button:has-text("Add artist")').first().isDisabled()); ok('the guest cannot go past five artists: the sixth cannot be added');

    // no match
    await g.fill('#gv-picks #gv-q', 'zzqxjv'); await g.waitForFunction(() => /Nothing in the room or MusicBrainz matches/.test(document.querySelector('#gv-picks #gv-picks-msg').textContent), null, { timeout: 15000 }); ok('a search with no match explains why');

    // joining with only an artist: no genre picked
    const g3 = await page(); await g3.goto(`${APP}/r/${code}`);
    assert.ok(await g3.locator('#gv-q').isVisible()); ok('the join page shows the artist and song search without opening anything');
    await g3.click('#gv-submit');
    assert.ok(/Pick a genre, or name an artist or song/.test(await g3.textContent('#gv-hint'))); ok('joining with nothing picked says what to do');
    await g3.fill('#gv-q', 'fleetwood'); await g3.waitForSelector('#gv-results .rrow');
    await g3.locator('#gv-results .rrow', { hasText: 'Fleetwood' }).first().getByRole('button', { name: /Add artist/ }).click();
    await g3.click('#gv-submit'); await g3.waitForSelector('#gv-title');
    await until(async () => /Starting you on/.test(await g3.textContent('#gv-me')), 6000, 'guessed genres shown to the guest'); ok('a guest who joined with only an artist is told which genres the room guessed for them');
    await until(async () => /Named 1 artist/.test(await host.evaluate(() => document.querySelector('#guests').innerText)), 6000, 'host sees a count');
    assert.ok(!/Fleetwood/.test(await host.evaluate(() => document.querySelector('#guests').innerText))); ok('the host sees "Named 1 artist" and never the name');
    await g3.locator('details:has(#gv-picks) > summary').click();
    await g3.locator('#gv-picks #gv-chosen .chip', { hasText: 'Fleetwood' }).click();
    await g3.waitForFunction(() => /Add a genre before removing/.test(document.querySelector('#gv-picks #gv-picks-msg').textContent), null, { timeout: 4000 });
    assert.strictEqual(await g3.locator('#gv-picks #gv-chosen .chip').count(), 1); ok('the last artist of a guest with no genres stays until they add a genre');

    assert.deepStrictEqual(errors, [], 'no browser errors: ' + errors.join(' | ')); ok('no browser errors');
    console.log('\n' + passed + ' checks passed');
  } catch (e) { console.error('\nFAILED:', e.stack || e.message); process.exitCode = 1; }
  finally { await browser.close(); srv.kill('SIGTERM'); }
})();
