'use strict';
// A guest sees what played during their visit, can save songs, find them, and widen their picks from them.
const http = require('http'), os = require('os'), path = require('path'), fs = require('fs');
const assert = require('assert');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const PORT = 4901, APP = 'http://127.0.0.1:' + PORT;
let passed = 0; const ok = (s) => { passed++; console.log('  ok  ' + s); };
const until = async (fn, ms = 10000, what = 'x') => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + what); await new Promise((r) => setTimeout(r, 100)); } };

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-played-'));
  const srv = spawn('node', ['server.js'], { cwd: __dirname + '/..', env: Object.assign({}, process.env, { PORT, DATA_DIR: tmp }), stdio: ['ignore', 'ignore', 'inherit'] });
  await until(() => new Promise((r) => http.get(APP, () => r(true)).on('error', () => r(false))), 8000, 'server up');
  const browser = await chromium.launch(); const errors = [];
  const mk = async (vp) => { const c = await browser.newContext({ viewport: vp || { width: 420, height: 900 } }); const p = await c.newPage(); p.on('pageerror', (e) => errors.push(e.message)); return [c, p]; };
  try {
    const [, host] = await mk({ width: 1200, height: 900 });
    await host.goto(APP); await host.click('#start-room'); await host.waitForURL(/\/host\/[A-Z0-9]{5}$/);
    const code = host.url().split('/').pop();
    await host.fill('#g-name', 'Pat'); await host.click('#picker [data-g="blues"]'); await host.click('#add-form button[type=submit]');
    await until(async () => (await host.textContent('#now-title')).trim().length > 0 && (await host.$('#btn-next')), 12000, 'first song');
    const titleOf = async () => (await host.textContent('#now-title')).trim();
    const next = async () => { const t = await titleOf(); await host.click('#btn-next'); await until(async () => (await titleOf()) !== t, 8000, 'next song'); return titleOf(); };
    const before = await titleOf(); const alsoBefore = await next(); const atJoin = await next();
    assert.ok(before !== alsoBefore && alsoBefore !== atJoin);

    const [gc, g] = await mk();
    await g.goto(APP + '/' + code); await g.waitForSelector('#gv-picker .chip'); await g.fill('#gv-name', 'Ana');
    await g.click('#gv-picker [data-g="blues"]'); await g.click('#gv-submit'); await g.waitForSelector('#gv-title');
    await until(async () => (await g.$$('#gv-played .prow .qtitle')).length >= 1, 8000, 'played list');
    let rows = await g.$$eval('#gv-played .prow .qtitle', (els) => els.map((e) => e.textContent));
    assert.ok(rows.some((r) => r.startsWith(atJoin)) && !rows.some((r) => r.startsWith(before)) && !rows.some((r) => r.startsWith(alsoBefore)));
    ok('a guest sees the song playing when they arrived, not the songs from before');
    await next(); await next();
    await until(async () => (await g.$$('#gv-played .prow')).length >= 3, 8000, 'three songs').catch(async (e) => { console.log('ROWS', await g.$$eval('#gv-played .prow', (els) => els.map((x) => x.textContent.slice(0, 40))), 'HOST', await titleOf()); throw e; });
    rows = await g.$$eval('#gv-played .prow .qtitle', (els) => els.map((e) => e.textContent));
    assert.ok(rows[0].startsWith(await titleOf())); ok('songs that play during the visit are added, newest first (' + rows.length + ' so far)');

    const first = rows[0];
    await g.click('#gv-played .prow:nth-child(1) .heart');
    assert.ok(/Saved/.test(await g.textContent('#gv-played .prow:nth-child(1) .heart'))); assert.ok(/Songs I saved \(1\)/.test(await g.textContent('#gv-saved-sum'))); ok('tapping Save keeps the song in "Songs I saved"');
    await g.reload(); await g.waitForSelector('#gv-saved-sum');
    assert.ok(/Songs I saved \(1\)/.test(await g.textContent('#gv-saved-sum'))); ok('the saved list survives a reload (it lives on the phone)');
    await g.click('#gv-saved-sum'); assert.ok((await g.textContent('#gv-saved-list')).startsWith(first.slice(0, 8))); ok('the saved list shows the song');

    const href = await g.getAttribute('#gv-played .prow:nth-child(1) .findlinks a', 'href');
    assert.ok(/^https:\/\/open\.spotify\.com\/search\//.test(href)); const links = await g.$$eval('#gv-played .prow:nth-child(1) .findlinks a', (as) => as.map((a) => a.textContent));
    assert.deepStrictEqual(links, ['Spotify', 'Apple Music', 'YouTube Music']); ok('Find it links to Spotify, Apple Music and YouTube Music');
    const findTitle = (await g.textContent('#gv-played .prow:nth-child(1) .qtitle')).trim();
    await g.click('#gv-played .prow:nth-child(1) .find summary');
    const afterFind = await next();
    await until(async () => (await g.textContent('#gv-played .prow:nth-child(1) .qtitle')).startsWith(afterFind), 8000, 'played list refresh after opening Find it');
    const findRow = g.locator('#gv-played .prow').filter({ hasText: findTitle });
    assert.strictEqual(await findRow.locator('.find').getAttribute('open'), 'open');
    assert.ok(await findRow.locator('.findlinks').isVisible()); ok('Find it stays open when the live played-song list refreshes');

    // "More like this": adds a genre the song has that the guest does not pick yet
    const picksBefore = (await g.textContent('#gv-me'));
    const moreRows = await g.$$('#gv-played .prow'); let added = false;
    for (let i = 1; i <= moreRows.length && !added; i++) {
      await g.click(`#gv-played .prow:nth-child(${i}) >> text=More like this`);
      const msg = await g.textContent('#gv-played-msg'); if (/^Added /.test(msg)) { added = msg.replace(/^Added (.*?) to your picks.*/, '$1'); }
    }
    assert.ok(added, 'some song offered a new genre');
    await until(async () => (await g.textContent('#gv-me')).includes(added), 8000, 'picks updated');
    ok('"More like this" adds ' + added + ' to the guest\'s picks (' + (await g.textContent('#gv-me')).trim() + ')');
    await until(async () => (await host.textContent('#guests')).includes(added), 8000, 'host sees the new pick'); ok('the host sees the widened picks');
  } catch (e) { console.error('FAILED:', e.message); await browser.close(); srv.kill(); process.exit(1); }
  await browser.close(); srv.kill();
  if (errors.length) { console.error('page errors', errors); process.exit(1); }
  console.log(passed + ' checks passed');
})();
