'use strict';
const assert = require('node:assert/strict');
const { Room } = require('../lib/room');

const room = new Room('JUKE1', 'h'.repeat(32));
const guest = room.addGuest('Guest One', ['rock'], { immediate: true });
const other = room.addGuest('Guest Two', ['jazz'], { immediate: true });
assert.ok(guest && other);

assert.equal(room.addRequest(guest.id, 'First Song', 'First Artist').ok, true);
assert.equal(room.addRequest(guest.id, 'Second Song', 'Second Artist').ok, true);
assert.equal(room.addRequest(guest.id, 'Third Song', 'Third Artist').ok, false, 'default limit is two outstanding requests');
assert.equal(room.addRequest(other.id, 'First Song', 'First Artist').ok, false, 'duplicate requests are rejected room-wide');
assert.equal(room.requestQueue.length, 2);

// A catalogue rebuild must not destroy the independent jukebox queue.
room.rebuild('test rebuild', false);
assert.equal(room.requestQueue.length, 2);

// The two-request limit is a host setting and survives room snapshots.
room.setOpts({ requestLimitEnabled: false });
assert.equal(room.addRequest(guest.id, 'Third Song', 'Third Artist').ok, true);
assert.equal(room.addRequest(other.id, 'Other Guest Song', 'Other Artist').ok, true);
const restored = new Room('JUKE1', 'h'.repeat(32));
assert.equal(restored.restoreSnapshot(room.snapshot()), true);
assert.equal(restored.requestLimitEnabled, false);
assert.equal(restored.requestQueue.length, 3);

// Requests get priority, but a blend song is inserted after two consecutive requests.
restored.advance();
assert.equal(restored.nowItem.mode, 'request');
assert.equal(restored.nowItem.request.requester, 'Guest One');
restored.advance();
assert.equal(restored.nowItem.mode, 'request');
assert.equal(restored.nowItem.request.requester, 'Guest Two', 'requesters rotate rather than letting one guest dominate');
restored.advance();
assert.notEqual(restored.nowItem.mode, 'request');

// The host can add and remove requests; removing a guest also removes their pending requests.
const hostRequest = restored.addRequest('', 'Host Song', 'Host Artist', true);
assert.equal(hostRequest.ok, true);
assert.equal(restored.removeRequest(hostRequest.request.id), true);
const pending = restored.addRequest(guest.id, 'Pending Song', 'Pending Artist');
assert.equal(pending.ok, true);
restored.removeGuest(guest.id, 'left');
assert.equal(restored.requestQueue.some((r) => r.guestId === guest.id), false);

console.log('  ok  jukebox request limits, persistence, priority, fairness, host controls and cleanup');
