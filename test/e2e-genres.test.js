'use strict';
// The grouped genre picker and broad picks ("All rock"), in a real browser on a phone-sized screen.
const http = require('http'), os = require('os'), path = require('path'), fs = require('fs');
const assert = require('assert');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const PORT = 4897, APP = 'http://127.0.0.1:' + PORT;
let passed = 0; const ok = (s) => { passed++; console.log('  ok  ' + s); };
const until = async (fn, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 100)); } };

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-gen-'));
  const srv = spawn('node', ['server.js'], { cwd: __dirname + '/..', env: Object.assign({}, process.env, { PORT, DATA_DIR: tmp }), stdio: ['ignore', 'ignore', 'inherit'] });
  await until(() => new Promise((r) => http.get(APP, () => r(true)).on('error', () => r(false))));
  const browser = await chromium.launch(); const errors = [];
  try {
    const hc = await browser.newContext({ viewport: { width: 1200, height: 900 } }), host = await hc.newPage();
    host.on('pageerror', (e) => errors.push(e.message));
    await host.goto(APP); await host.click('#start-room'); await host.waitForURL(/\/host\/[A-Z0-9]{5}$/);
    const code = host.url().split('/').pop();
    // host "add someone by hand" picker: canonical genres, aliases, and broad family buttons
    assert.strictEqual(await host.locator('#picker .chip').count(), 62 + 26 + 13); ok('the picker offers 62 genres, 26 era, mood and style shortcuts, and 13 "All ..." buttons');
    assert.strictEqual(await host.locator('#picker .chipgroup').count(), 17); ok('genres are shown in 14 groups, then eras, moods and more styles');
    assert.strictEqual(await host.locator('#picker [data-genre-group="Moods"] .chip').count(), 8);
    assert.strictEqual(await host.locator('#picker [data-genre-group="Eras"] [data-g="50s"]').count(), 1);
    for (const g of ['soundtrack', 'bollywood', 'j-pop', 'brazilian', 'djent']) assert.strictEqual(await host.locator('#picker [data-g="' + g + '"]').count(), 1, g);
    ok('moods, the 50s, djent and the four new genres are all there');
    const gc = await browser.newContext({ viewport: { width: 420, height: 850 } }), g = await gc.newPage();
    g.on('pageerror', (e) => errors.push(e.message));
    await g.goto(APP + '/' + code); await g.waitForSelector('#gv-picker .chip');
    assert.strictEqual(await g.locator('#gv-picker .chip-all').count(), 13); ok('a guest sees the same grouped picker on a phone');
    await g.locator('#gv-picker .genre-search').fill('phonk');
    assert.strictEqual(await g.locator('#gv-picker [data-g="phonk"]').isVisible(), true); ok('search finds a less common style without scrolling through every genre');
    // the first word a guest thinks of should find the right button, even when it is not the button's name
    for (const [word, genre] of [['rap', 'hip hop'], ['anime', 'j-pop'], ['film', 'soundtrack'], ['samba', 'brazilian'], ['hindi', 'bollywood'], ['xmas', 'christmas'], ['djent', 'metal'], ['lofi', 'lo-fi']]) {
      await g.locator('#gv-picker .genre-search').fill(word);
      assert.strictEqual(await g.locator('#gv-picker [data-g="' + genre + '"]').isVisible(), true, word + ' should find ' + genre);
    }
    await g.locator('#gv-picker .genre-search').fill('zzzz');
    assert.ok(/No matching genres/.test(await g.textContent('#gv-picker .genre-search-status'))); ok('search finds a genre by what people call it ("rap", "anime", "film", "samba", "djent") and says so when nothing matches');
    await g.locator('#gv-picker .genre-search').fill('');
    await g.click('#gv-picker [data-g="any:rock"]'); await g.click('#gv-picker [data-g="jazz"]'); await g.click('#gv-picker [data-g="any:hip-hop-rnb"]');
    assert.strictEqual(await g.getAttribute('#gv-picker [data-g="any:rock"]', 'aria-pressed'), 'true'); ok('"All rock" can be picked beside a specific genre');
    await g.click('#gv-submit'); await g.waitForSelector('#gv-title');
    await until(async () => /all rock/.test(await g.textContent('#gv-me')));
    ok('the guest\'s picks read "all rock, jazz, all hip hop & r&b" (a group\'s real name, not its id)');
    assert.ok(/all hip hop & r&b/.test(await g.textContent('#gv-me')));
    await until(async () => (await host.textContent('body')).includes('all rock')); ok('the host sees the broad pick as a tag');
    assert.ok((await host.textContent('body')).includes('all hip hop & r&b'));
    await g.screenshot({ path: path.join(tmp, 'picker.png') });
  } catch (e) {
    console.error('FAILED:', e.message); await browser.close(); srv.kill(); process.exit(1);
  }
  await browser.close(); srv.kill();
  if (errors.length) { console.error('page errors', errors); process.exit(1); }
  console.log(passed + ' checks passed');
})();
