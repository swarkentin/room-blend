'use strict';
// Duels over HTTP: the endpoints, who may call them, and what the TV and the phones receive over the live stream.
const http = require('http');
const assert = require('assert');
const { server } = require('../server.js');

let base, passed = 0;
const ok = (s) => { passed++; console.log('  ok  ' + s); };

function req(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined || body === null ? null : JSON.stringify(body);
    const r = http.request(base + path, { method, headers: Object.assign(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}, headers) }, (res) => {
      const c = []; res.on('data', (d) => c.push(d));
      res.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(c).toString()); } catch (e) { /* */ } resolve({ status: res.statusCode, json: j }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
function sse(path) {
  const events = [], waiters = []; let buf = '';
  const r = http.get(base + path, (res) => {
    res.setEncoding('utf8');
    res.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n\n')) >= 0) { const b = buf.slice(0, i); buf = buf.slice(i + 2); const m = /data: (.*)/.exec(b); if (m) { events.push(JSON.parse(m[1])); waiters.slice().forEach((w) => w()); } } });
  });
  r.on('error', () => {});
  return { events, close: () => r.destroy(), last: () => events[events.length - 1],
    waitFor(pred, ms = 6000) { return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const check = () => { for (let i = events.length - 1; i >= 0; i--) if (pred(events[i])) { done(); resolve(events[i]); return true; } return false; };
      const iv = setInterval(() => { if (Date.now() - t0 > ms) { done(); reject(new Error('timeout; last=' + JSON.stringify(events[events.length - 1]).slice(0, 400))); } }, 50);
      const done = () => { clearInterval(iv); const k = waiters.indexOf(check); if (k >= 0) waiters.splice(k, 1); };
      if (!check()) waiters.push(check); }); } };
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
  console.log('Duel API tests against ' + base);

  const room = (await req('POST', '/api/rooms')).json, code = room.code, H = { 'x-host-key': room.hostKey };
  await req('POST', `/api/rooms/${code}/host/opts`, { settle: 0 }, H);
  const join = async (name, genre) => { const j = (await req('POST', `/api/rooms/${code}/guests`, { name, genres: [genre] })).json; return { id: j.guestId, h: { 'x-guest-id': j.guestId, 'x-guest-key': j.guestKey }, q: `gid=${j.guestId}&gkey=${j.guestKey}` }; };
  const ana = await join('Ana', 'rock'), bo = await join('Bo', 'jazz'), cy = await join('Cy', 'pop');
  const sa = sse(`/api/rooms/${code}/events?${ana.q}`), sb = sse(`/api/rooms/${code}/events?${bo.q}`), sc = sse(`/api/rooms/${code}/events?${cy.q}`), sh = sse(`/api/rooms/${code}/events?key=${room.hostKey}`);
  await sh.waitFor((e) => e.guests && e.guests.length === 3);
  await Promise.all([sa, sb, sc].map((s) => s.waitFor((e) => e.fights)));
  const fight = (who, act, body) => req('POST', `/api/rooms/${code}/fight/${act}`, body || {}, who.h);

  // Nobody has a song waiting yet.
  let r = await fight(ana, 'challenge', { targetId: bo.id });
  assert.strictEqual(r.status, 400); assert.match(r.json.error, /Request a song first/);
  await req('POST', `/api/rooms/${code}/request`, { title: 'Ana Song', artist: 'Ana Band' }, ana.h);
  await req('POST', `/api/rooms/${code}/request`, { title: 'Bo Song', artist: 'Bo Band' }, bo.h);
  ok('a duel needs a song waiting: the refusal says what to do');

  assert.strictEqual((await req('POST', `/api/rooms/${code}/fight/challenge`, { targetId: bo.id })).status, 401);
  assert.strictEqual((await fight(ana, 'bogus')).status, 404);
  assert.match((await fight(ana, 'challenge', { targetId: ana.id })).json.error, /someone else/);
  assert.match((await fight(ana, 'challenge', {})).json.error, /Choose someone/);
  assert.match((await fight(ana, 'pick', { move: 'strike' })).json.error, /not open/);
  ok('duel endpoints need a guest\'s keys and refuse nonsense');

  const roster = (await sa.waitFor((e) => e.fights && e.fights.roster && e.fights.roster.length === 1 && e.fights.ready)).fights;
  assert.strictEqual(roster.roster[0].name, 'Bo'); assert.strictEqual(roster.left, 2);
  r = await fight(ana, 'challenge', { targetId: bo.id });
  assert.strictEqual(r.status, 200);
  const challenged = await sh.waitFor((e) => e.fight && e.fight.phase === 'challenge');
  assert.strictEqual(challenged.fight.a.name, 'Ana'); assert.strictEqual(challenged.fight.b.name, 'Bo');
  assert.strictEqual(challenged.fight.a.song.title, 'Ana Song');
  const bView = await sb.waitFor((e) => e.fights && e.fights.live && e.fights.live.you === 'b');
  assert.strictEqual(bView.fights.live.phase, 'challenge');
  assert.ok((await sc.waitFor((e) => e.fights && e.fights.live)).fights.live.you === null, 'bystanders see the duel but are not in it');
  assert.match((await fight(cy, 'challenge', { targetId: ana.id })).json.error, /ring is busy|not here|no song/);
  ok('a challenge reaches the TV, the challenged phone and bystanders');

  assert.match((await fight(ana, 'respond', { accept: true })).json.error, /no challenge/);
  assert.strictEqual((await fight(bo, 'respond', { accept: true })).status, 200);
  await sh.waitFor((e) => e.fight && e.fight.phase === 'intro');
  const pickPhase = await sh.waitFor((e) => e.fight && e.fight.phase === 'pick', 7000);   // the server's own clock moves the duel on
  assert.strictEqual(pickPhase.fight.round, 1);
  assert.ok(pickPhase.fight.leftMs > 0 && pickPhase.fight.leftMs <= 6000);
  ok('the server clock moves a duel from the challenge to the first round without anyone polling');

  assert.match((await fight(ana, 'pick', { move: 'kick' })).json.error, /Strike, Feint or Guard/);
  assert.match((await fight(cy, 'pick', { move: 'strike' })).json.error, /not in this duel/);
  assert.strictEqual((await fight(ana, 'pick', { move: 'strike' })).status, 200);
  const locked = await sh.waitFor((e) => e.fight && e.fight.phase === 'pick' && e.fight.a.locked);
  assert.ok(!/strike/.test(JSON.stringify(locked.fight)), 'the TV is told a fighter locked in, never what they picked');
  assert.strictEqual((await sa.waitFor((e) => e.fights.live && e.fights.live.picked === 'strike')).fights.live.picked, 'strike');
  assert.strictEqual(sb.last().fights.live.picked, null);
  assert.strictEqual((await fight(bo, 'pick', { move: 'feint' })).status, 200);
  const revealed = await sh.waitFor((e) => e.fight && e.fight.phase === 'reveal');
  assert.deepStrictEqual([revealed.fight.reveal.a, revealed.fight.reveal.b, revealed.fight.reveal.outcome], ['strike', 'feint', 'a']);
  assert.strictEqual(revealed.fight.b.hp, 80);
  ok('moves are secret until both are in, then the TV and phones see the reveal');

  // The host's controls.
  assert.strictEqual((await req('POST', `/api/rooms/${code}/host/fights`, { cancel: true })).status, 401);
  assert.strictEqual((await req('POST', `/api/rooms/${code}/host/fights`, { cancel: true }, H)).status, 200);
  const over = await sh.waitFor((e) => e.fight && e.fight.phase === 'over');
  assert.strictEqual(over.fight.result.reason, 'cancelled');
  await req('POST', `/api/rooms/${code}/host/fights`, { perWindow: 4, windowMin: 30 }, H);
  assert.deepStrictEqual((await sh.waitFor((e) => e.fightOpts && e.fightOpts.perWindow === 4)).fightOpts, { enabled: true, perWindow: 4, windowMin: 30 });
  await req('POST', `/api/rooms/${code}/host/fights`, { enabled: false }, H);
  assert.strictEqual((await sa.waitFor((e) => e.fights && e.fights.enabled === false)).fights.enabled, false);
  assert.match((await fight(ana, 'challenge', { targetId: bo.id })).json.error, /turned off/);
  ok('the host can call a duel off, change the allowance and window, and switch duels off');

  [sa, sb, sc, sh].forEach((s) => s.close());
  console.log(passed + ' duel API checks passed');
  server.close(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
