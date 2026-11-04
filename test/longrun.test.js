'use strict';
// A room left open for days: nothing about it may grow without limit, and its views stay a fixed size.
const assert = require('assert');
const { Room } = require('../lib/room.js');
let n = 0; const ok = (s) => { n++; console.log('  ok  ' + s); };
const T0 = 1_000_000;
const r = new Room('ABCDE', 'k', T0); r.opts.settle = 0;
const a = r.addGuest('Ana', ['rock', 'blues'], { immediate: true, onNet: true }, T0); a.connected = true;
const b = r.addGuest('Bo', ['pop'], { immediate: true, onNet: true }, T0); b.connected = true;
r.rebuild('start', false);
const PLAYS = 1500;
let t = T0;
for (let i = 0; i < PLAYS; i++) {
  t += 200_000;
  r.vote(a.id, i % 2 ? 'up' : 'down');
  if (!r.advance(true, t)) r.rebuild('refill', false);
  r.addExtras('rock', [], { artist: 'Artist ' + i });
}
assert.ok(r.history.length <= 400, 'history length ' + r.history.length);
ok('the server remembers at most 400 plays after ' + PLAYS + ' songs');
assert.ok(Object.keys(r.votes).length <= 402, 'votes ' + Object.keys(r.votes).length);
ok('votes on songs that are no longer remembered are dropped');
assert.ok(r.searchedArtists.size <= 300);
ok('remembered artist look-ups are capped');
const hv = r.hostView(), gv = r.guestView(a.id);
assert.ok(hv.history.length <= 60 && gv.played.length <= 60);
ok('the host and guest history lists stay at 60 entries');
assert.ok(JSON.stringify(hv).length < 100_000 && JSON.stringify(gv).length < 100_000, 'view size ' + JSON.stringify(hv).length);
ok('a view stays a few kilobytes however long the room has run');
const ids = r.history.slice(-30).map((h) => h.track.id);
assert.ok(new Set(ids).size > 15, 'recent songs are not all repeats');
ok('songs still do not repeat back to back after trimming');
{
  const { cleanArtists } = require('../lib/room.js');
  assert.deepStrictEqual(cleanArtists(['https://www.youtube.com/@djcrocsnsocks', 'Someone Else']), ['@djcrocsnsocks', 'Someone Else']);
  assert.deepStrictEqual(cleanArtists(['https://youtube.com/@DJCrocsNSocks/?si=abc', '@djcrocsnsocks']), ['@DJCrocsNSocks'], 'a link and the bare handle are one artist');
  assert.deepStrictEqual(cleanArtists(['https://example.com/@djcrocsnsocks']).length, 1);
  ok('a pasted YouTube channel link is stored as the @handle, and matches the bare handle');
}
console.log(`\n${n} checks passed`);
