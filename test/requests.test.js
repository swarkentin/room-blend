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
assert.equal(restored.requestQueue.length, 4);

// Requests get priority, but a blend song is inserted after two consecutive requests.
restored.advance();
assert.equal(restored.nowItem.mode, 'request');
assert.equal(restored.nowItem.request.requester, 'Guest One');
restored.advance();
assert.equal(restored.nowItem.mode, 'request');
assert.equal(restored.nowItem.request.requester, 'Guest Two', 'requesters rotate rather than letting one guest dominate');
restored.advance();
assert.notEqual(restored.nowItem.mode, 'request');

// The TV view merges request and blend entries in actual playback order without mutating either queue.
const displayRoom = new Room('JUKE3', 'd'.repeat(32));
const d1 = displayRoom.addGuest('Display One', ['rock'], { immediate: true });
const d2 = displayRoom.addGuest('Display Two', ['jazz'], { immediate: true });
displayRoom.queue = [
  { track: { id: 'blend-1', title: 'Blend One', artist: 'Artist A', genres: ['rock'] }, mode: 'blend' },
  { track: { id: 'blend-2', title: 'Blend Two', artist: 'Artist B', genres: ['jazz'] }, mode: 'blend' },
  { track: { id: 'blend-3', title: 'Blend Three', artist: 'Artist C', genres: ['rock'] }, mode: 'blend' },
];
displayRoom.addRequest(d1.id, 'Request One', 'Artist D');
displayRoom.addRequest(d2.id, 'Request Two', 'Artist E');
let upcoming = displayRoom.upNext(5);
assert.deepEqual(upcoming.map((x) => x.track.title), ['Request One', 'Request Two', 'Blend One', 'Blend Two', 'Blend Three'].slice(0, upcoming.length));
assert.equal(displayRoom.requestQueue.length, 2, 'rendering the TV view does not consume requests');
assert.equal(displayRoom.queue.length, 3, 'rendering the TV view does not consume blend tracks');
displayRoom.requestStreak = 2;
displayRoom.lastRequestGuest = d2.id;
upcoming = displayRoom.upNext(4);
assert.deepEqual(upcoming.map((x) => x.track.title), ['Blend One', 'Request One', 'Request Two', 'Blend Two']);

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

// Provider artwork URLs are retained when they are safe HTTPS image URLs.
const artRoom = new Room('ART01', 'a'.repeat(32));
artRoom.addExtras('rock', [{
  title: 'Artwork Song', artist: 'Artwork Artist', genres: ['rock'], id: 'spotify:track:123',
  artwork: 'https://i.scdn.co/image/ab67616d0000b273abcdef0123456789',
}], { pool: true });
assert.equal(artRoom.trackView(artRoom.extra[0]).artwork, 'https://i.scdn.co/image/ab67616d0000b273abcdef0123456789');
assert.equal(artRoom.trackView({ id: 'yt', title: 'YouTube', artist: 'Video', genres: [], artwork: 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg' }).artwork, 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg');
assert.equal(artRoom.trackView({ id: 'bad', title: 'Bad', artist: 'URL', genres: [], artwork: 'http://example.com/cover.jpg' }).artwork, undefined);
assert.equal(artRoom.trackView({ id: 'cred', title: 'Credential URL', artist: 'Bad', genres: [], artwork: 'https://user:pass@example.com/cover.jpg' }).artwork, undefined);

// The host's serialized TV projection contains the same request/blend order.
assert.deepEqual(displayRoom.hostView().upNext.slice(0, upcoming.length).map((x) => x.track.title), upcoming.map((x) => x.track.title));

// The host can add and remove requests; removing a guest also removes their pending requests.
const hostRequest = restored.addRequest('', 'Host Song', 'Host Artist', true);
assert.equal(hostRequest.ok, true);
assert.equal(restored.removeRequest(hostRequest.request.id), true);
const pending = restored.addRequest(guest.id, 'Pending Song', 'Pending Artist');
assert.equal(pending.ok, true);
restored.removeGuest(guest.id, 'left');
assert.equal(restored.requestQueue.some((r) => r.guestId === guest.id), false);

console.log('  ok  jukebox request limits, persistence, priority, fairness, host controls and cleanup');
