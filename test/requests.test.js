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

// Host exclusions persist, remove matching requests and prevent guest requests bypassing them.
assert.equal(room.setBlock('artist', 'Blocked Band').ok, true);
assert.equal(room.addRequest(other.id, 'Anything', 'Blocked Band').ok, false);
assert.equal(room.requestQueue.some((x) => x.artist === 'Blocked Band'), false);
assert.equal(room.setBlock('song', { title: 'No Thanks', artist: 'Allowed Band' }).ok, true);
assert.equal(room.addRequest(other.id, 'No Thanks', 'Allowed Band').ok, false);
const welcome = room.addRequest(other.id, 'Welcome', 'Allowed Band');
assert.equal(welcome.ok, true);
assert.equal(room.removeRequest(welcome.request.id), true);
assert.equal(room.setBlock('artist', 'Blocked Band', true).ok, true);
assert.equal(room.setBlock('artist', 'Persisted Band').ok, true);

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
assert.equal(restored.requestQueue.length, 4);
assert.deepEqual(restored.blockedArtists, room.blockedArtists);
assert.deepEqual(restored.blockedSongs, room.blockedSongs);

// Requests get priority, but a blend song is inserted after two consecutive requests.
restored.advance();
assert.equal(restored.nowItem.mode, 'request');
assert.equal(restored.nowItem.request.requester, 'Guest One');
restored.advance();
assert.equal(restored.nowItem.mode, 'request');
assert.equal(restored.nowItem.request.requester, 'Guest Two', 'requesters rotate rather than letting one guest dominate');
restored.advance();
assert.notEqual(restored.nowItem.mode, 'request');

// Position estimates include the blend songs required by the two-request burst limit.
const positionRoom = new Room('JUKE2', 'p'.repeat(32));
const p1 = positionRoom.addGuest('One', ['rock'], { immediate: true });
const p2 = positionRoom.addGuest('Two', ['jazz'], { immediate: true });
const pReq1 = positionRoom.addRequest(p1.id, 'Position One', 'Artist One').request;
const pReq2 = positionRoom.addRequest(p2.id, 'Position Two', 'Artist Two').request;
let positions = positionRoom.requestPositions();
assert.equal(positions.get(pReq1.id), 1);
assert.equal(positions.get(pReq2.id), 2);
positionRoom.requestStreak = 2;
positionRoom.lastRequestGuest = p2.id;
positions = positionRoom.requestPositions();
assert.equal(positions.get(pReq1.id), 2, 'a blend song plays after two requests');
assert.equal(positions.get(pReq2.id), 3, 'a later request waits behind the blend song');

// The host can add and remove requests; removing a guest also removes their pending requests.
const hostRequest = restored.addRequest('', 'Host Song', 'Host Artist', true);
assert.equal(hostRequest.ok, true);
assert.equal(restored.removeRequest(hostRequest.request.id), true);
const pending = restored.addRequest(guest.id, 'Pending Song', 'Pending Artist');
assert.equal(pending.ok, true);
restored.removeGuest(guest.id, 'left');
assert.equal(restored.requestQueue.some((r) => r.guestId === guest.id), false);

console.log('  ok  jukebox request limits, persistence, priority, fairness, host controls and cleanup');
