'use strict';
// The host view gives each guest's happiness over the night: a running average after every song they heard.
const assert = require('assert');
const { Room } = require('../lib/room');
let n = 0; const ok = (s) => { n++; console.log('  ok  ' + s); };
const room = new Room('TRAIL', 't'.repeat(32));
const a = room.addGuest('Ana', ['rock'], { immediate: true }), b = room.addGuest('Ben', ['jazz'], { immediate: true });
const trailOf = (id) => room.hostView().fairness.find((f) => f.id === id);
assert.strictEqual(trailOf(a.id).trail.length, trailOf(a.id).songs); ok('the trail starts with the songs already heard');
for (let i = 0; i < 5; i++) room.advance();
const t = trailOf(a.id);
assert.ok(t.songs >= 2 && t.trail.length === t.songs); ok('the trail has one point per song the guest heard (' + t.songs + ')');
assert.ok(t.trail.every((v) => v >= 0 && v <= 1)); ok('every point is a 0 to 1 score');
assert.strictEqual(t.trail[t.trail.length - 1], Math.round(t.avg * 100) / 100); ok('the last point is the overall average');
for (let i = 0; i < 40; i++) room.advance();
assert.ok(trailOf(a.id).trail.length <= 16); ok('the trail keeps only the most recent songs');
console.log(n + ' mood trail checks passed');
