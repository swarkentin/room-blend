'use strict';
// How the room knows who is still here: connection grace, leaving the Wi-Fi, and "still here?".
const assert = require('assert');
process.env.DISCONNECT_GRACE_MS = '180000';
const { Room, DISCONNECT_GRACE_MS, IDLE_ASK_S, IDLE_ANSWER_MS, AWAY_REMOVE_MS } = require('../lib/room.js');
let n = 0; const ok = (s) => { n++; console.log('  ok  ' + s); };
const T0 = 1_000_000;
const mkRoom = () => { const r = new Room('ABCDE', 'k', T0); r.opts.settle = 0; return r; };
const add = (r, name, genres, onNet = true) => { const g = r.addGuest(name, genres, { immediate: true, onNet }, T0); g.connected = true; g.lostAt = null; return g; };

// ---- a dropped connection gets a long grace period ----
{
  const r = mkRoom(); const a = add(r, 'Ana', ['rock']); add(r, 'Bo', ['blues']);
  r.setConnected(a.id, false, T0);
  r.tick(T0 + 30_000); assert.ok(r.guests.has(a.id), 'still here after 30 s');
  r.tick(T0 + DISCONNECT_GRACE_MS - 1000); assert.ok(r.guests.has(a.id), 'still here just inside the grace period');
  r.setConnected(a.id, true, T0 + 100_000); r.tick(T0 + DISCONNECT_GRACE_MS + 60_000); assert.ok(r.guests.has(a.id), 'reconnecting resets the clock');
  r.setConnected(a.id, false, T0 + 200_000); r.tick(T0 + 200_000 + DISCONNECT_GRACE_MS + 1000); assert.ok(!r.guests.has(a.id), 'removed after the grace period');
  ok('a locked phone is given ' + DISCONNECT_GRACE_MS / 1000 + ' s before the guest is removed; reconnecting resets the clock');
}

// ---- a locked phone: the doze lease ----
{
  const r = mkRoom(); const a = add(r, 'Ana', ['rock']), b = add(r, 'Bo', ['blues']);
  r.beat(a.id, { hidden: true }, T0 + 10_000);            // Ana locks her phone: the page says it is going to the background
  r.setConnected(a.id, false, T0 + 12_000);               // ...and the connection drops
  r.tick(T0 + 12_000 + DISCONNECT_GRACE_MS + 60_000); assert.ok(r.guests.has(a.id), 'a locked phone outlives the short grace');
  assert.strictEqual(r.hostView().guests.find((g) => g.id === a.id).dozing, true); assert.strictEqual(a.status, 'active');
  r.tick(T0 + 10_000 + 29 * 60_000); assert.ok(r.guests.has(a.id), 'still counted 29 minutes after locking');
  r.tick(T0 + 10_000 + 31 * 60_000); assert.ok(!r.guests.has(a.id), 'dropped once the 30 minute lease runs out');
  ok('a locked phone stays counted for the doze lease (30 min), then the guest is dropped');
  r.setConnected(b.id, false, T0 + 20_000); r.tick(T0 + 20_000 + DISCONNECT_GRACE_MS + 1000); assert.ok(!r.guests.has(b.id));
  ok('a page that just vanished, without saying it went to the background, still gets only the short grace');
  const c = add(r, 'Cy', ['jazz']); r.beat(c.id, { hidden: true }, T0 + 50_000); r.setConnected(c.id, false, T0 + 52_000);
  r.beat(c.id, { hidden: false }, T0 + 400_000); r.setConnected(c.id, true, T0 + 400_000); r.tick(T0 + 400_000 + 40 * 60_000);
  assert.ok(r.guests.has(c.id) && !c.hiddenAt); ok('opening the page again renews the lease');
  r.setOpts({ doze: 10 }); const d = add(r, 'Di', ['pop']); r.beat(d.id, { hidden: true }, T0 + 500_000); r.setConnected(d.id, false, T0 + 501_000);
  r.tick(T0 + 500_000 + 11 * 60_000); assert.ok(!r.guests.has(d.id)); assert.strictEqual(r.opts.doze, 10); r.setOpts({ doze: 1 }); assert.strictEqual(r.opts.doze, 5);
  ok('the host sets the lease length (5 to 240 minutes)');
}

// ---- leaving the Wi-Fi ----
{
  const r = mkRoom(); const a = add(r, 'Ana', ['rock']), b = add(r, 'Bo', ['blues']), c = add(r, 'Cy', ['jazz'], false);
  r.beat(a.id, { onNet: true }, T0 + 60_000); assert.strictEqual(a.status, 'active');
  r.beat(a.id, { onNet: false }, T0 + 120_000); assert.strictEqual(a.status, 'active', 'one missed check is forgiven (a phone can flip to mobile data briefly)');
  r.beat(a.id, { onNet: true }, T0 + 180_000); r.beat(a.id, { onNet: false }, T0 + 240_000); assert.strictEqual(a.status, 'active', 'a good check in between resets the count');
  r.beat(a.id, { onNet: false }, T0 + 300_000); assert.strictEqual(a.away, 'network'); assert.strictEqual(a.status, 'sitting');
  assert.ok(!r.active().some((g) => g.id === a.id), 'an away guest is not counted in the blend');
  assert.ok(r.log.some((l) => /left the Wi-Fi/.test(l.text || l.msg || JSON.stringify(l)))); ok('two checks in a row from outside the network mark a guest away, and songs are chosen without them');
  r.beat(a.id, { onNet: true }, T0 + 360_000); assert.strictEqual(a.away, ''); assert.strictEqual(a.status, 'active'); ok('coming back to the network brings them straight back into the blend');
  r.beat(c.id, { onNet: false }, T0 + 60_000); r.beat(c.id, { onNet: false }, T0 + 120_000); r.beat(c.id, { onNet: false }, T0 + 180_000);
  assert.strictEqual(c.away, '', 'a guest who joined from outside the Wi-Fi (link or QR) is never marked away for it'); ok('guests who joined from outside the Wi-Fi are not judged by it');
  r.beat(b.id, { onNet: false }, T0 + 400_000); r.beat(b.id, { onNet: false }, T0 + 460_000); assert.strictEqual(b.away, 'network');
  r.tick(T0 + 460_000 + AWAY_REMOVE_MS + 1000); assert.ok(!r.guests.has(b.id)); ok('a guest who stays off the network is removed after ' + AWAY_REMOVE_MS / 60000 + ' minutes');
}

// ---- "still here?" ----
{
  const r = mkRoom(); const a = add(r, 'Ana', ['rock']); add(r, 'Bo', ['blues']);
  r.beat(a.id, { idleSec: 600 }, T0 + 60_000); assert.ok(!a.askAt, 'ten idle minutes is nothing');
  r.beat(a.id, { idleSec: IDLE_ASK_S }, T0 + 120_000); assert.ok(a.askAt); assert.strictEqual(r.guestView(a.id).me.ask, true); ok('after an hour without a touch the guest is asked "still here?"');
  r.tick(T0 + 120_000 + IDLE_ANSWER_MS - 1000); assert.strictEqual(a.status, 'active');
  r.beat(a.id, { idleSec: 3 }, T0 + 150_000); assert.ok(!a.askAt); assert.strictEqual(a.status, 'active'); ok('touching the page answers the question');
  r.beat(a.id, { idleSec: IDLE_ASK_S + 60 }, T0 + 200_000); r.tick(T0 + 200_000 + IDLE_ANSWER_MS + 1000);
  assert.strictEqual(a.away, 'idle'); assert.strictEqual(a.status, 'sitting'); assert.ok(!r.active().some((g) => g.id === a.id)); ok('no answer in 5 minutes: the guest is set to sit out');
  r.beat(a.id, { idleSec: 1 }, T0 + 700_000); assert.strictEqual(a.away, ''); assert.strictEqual(a.status, 'active'); ok('touching the page again brings them back');
  assert.strictEqual(r.hostView().guests.find((g) => g.id === a.id).away, ''); ok('the host view carries each guest\'s away state');
}

// ---- hand-added guests are never judged ----
{
  const r = mkRoom(); const m = r.addGuest('Pat', ['country'], { manual: true, immediate: true }, T0);
  r.beat(m.id, { onNet: false, idleSec: 99999 }, T0 + 1000); r.tick(T0 + 99_999_999);
  assert.ok(r.guests.has(m.id) && m.status === 'active'); ok('guests the host added by hand never time out');
}
// ---- songs played during a visit ----
{
  const r = mkRoom(); const a = add(r, 'Ana', ['rock']);
  const t1 = Date.now();
  assert.ok(r.nowItem, 'a song is playing'); const first = r.nowItem.track.id;
  r.advance(false, t1 + 1000); r.advance(false, t1 + 2000);
  const b = r.addGuest('Bo', ['rock'], { immediate: true }, t1 + 2500);
  assert.strictEqual(b.sinceAt, t1 + 2000, 'a newcomer starts from the song that was already playing');
  let pv = r.guestView(b.id).played; assert.strictEqual(pv.length, 1); assert.strictEqual(pv[0].playing, true);
  r.advance(false, t1 + 3000); r.advance(false, t1 + 4000);
  pv = r.guestView(b.id).played; assert.strictEqual(pv.length, 3); assert.ok(pv[0].at > pv[2].at, 'newest first'); assert.ok(pv[0].playing && !pv[1].playing);
  assert.ok(typeof pv[0].title === 'string' && Array.isArray(pv[0].genres) && 'fit' in pv[0]); ok('a guest\'s view lists the songs played since they arrived, newest first');
  assert.ok(r.guestView(a.id).played.length > pv.length && r.guestView(a.id).played.some((x) => x.id === first)); ok('earlier guests see earlier songs too');
  const c = r.addGuest('Cy', ['rock'], { immediate: true, since: t1 + 1000 }, t1 + 5000);
  assert.strictEqual(c.sinceAt, t1 + 1000); assert.ok(r.guestView(c.id).played.length >= 4); ok('a guest who rejoins keeps their original start time');
  const d = r.addGuest('Di', ['rock'], { immediate: true, since: 1 }, t1 + 5000);
  assert.ok(d.sinceAt >= t1 + 5000 - 86400000); ok('a start time cannot reach back further than a day');
}
console.log(n + ' checks passed');
