'use strict';
// One set of expectations for every storage backend (lib/store.js). Exported as a function so test/store.test.js can run it against
// the memory store always, and against Postgres/Neon when TEST_DATABASE_URL is set.
const assert = require('assert');

module.exports = async function contract(store, ok) {
  const now = 1_800_000_000_000, DAY = 86400000;
  await store.init();
  assert.strictEqual(await store.ping(), true);

  // ----- rooms -----
  const room = { code: 'ABCDE', hostKey: 'h'.repeat(32), createdAt: now - 5000, touchedAt: now - 1000, name: 'Patio', discoverable: false, netKey: 'v4:1.2.3.4', opts: { tau: 0.7 } };
  await store.upsertRoom(room);
  await store.upsertRoom({ ...room, code: 'OLDRM', touchedAt: now - 3 * DAY });
  let loaded = await store.loadRooms(now - DAY);
  assert.deepStrictEqual(loaded.map((r) => r.code), ['ABCDE'], 'only recently used rooms load');
  assert.deepStrictEqual({ ...loaded[0], snapshot: null, snapshotVersion: 0, snapshotAt: 0 }, { ...room, snapshot: null, snapshotVersion: 0, snapshotAt: 0 });
  assert.strictEqual(await store.saveSnapshot('ABCDE', 'v1.aaa.bbb.ccc', 5, now), true);
  assert.strictEqual(await store.saveSnapshot('ABCDE', 'v1.old.old.old', 4, now), false, 'an older checkpoint never replaces a newer one');
  assert.strictEqual(await store.saveSnapshot('NOROOM', 'x', 1, now), false, 'no checkpoint for an unknown room');
  await store.upsertRoom({ ...room, name: 'Renamed', touchedAt: now });
  loaded = await store.loadRooms(now - DAY);
  assert.strictEqual(loaded[0].name, 'Renamed');
  assert.strictEqual(loaded[0].snapshot, 'v1.aaa.bbb.ccc', 'updating identity keeps the checkpoint');
  assert.strictEqual(loaded[0].snapshotVersion, 5);
  await store.deleteRooms(['ABCDE', 'OLDRM']);
  assert.deepStrictEqual(await store.loadRooms(0), []);
  ok('rooms: identity, newest-wins checkpoints, expiry window, delete');

  // ----- play votes: one standing opinion per room per video -----
  await store.recordPlay('room-a', 'vid-good', true, undefined, now);
  await store.recordPlay('room-a', 'vid-good', true, undefined, now + 1);
  await store.recordPlay('room-b', 'vid-good', true, undefined, now);
  await store.recordPlay('room-c', 'vid-good', false, undefined, now);
  await Promise.all([store.recordPlay('room-a', 'vid-bad', false, undefined, now), store.recordPlay('room-b', 'vid-bad', false, undefined, now)]);
  assert.deepStrictEqual(await store.getPlayback(['vid-good', 'vid-bad', 'vid-none']), { 'vid-good': { successes: 2, failures: 1 }, 'vid-bad': { successes: 0, failures: 2 } }, 'a room counts once per video, however often it reports');
  assert.deepStrictEqual(await store.getPlayback([]), {});
  await store.recordPlay('room-c', 'vid-good', true, undefined, now + 5);
  assert.deepStrictEqual((await store.getPlayback(['vid-good']))['vid-good'], { successes: 3, failures: 0 }, 'a room that changes its mind replaces its earlier report');
  ok('quality: one vote per room per video, latest report wins');

  // ----- song lookups: served only once enough different rooms agree -----
  const key = 'take five|dave brubeck';
  await store.recordPlay('room-a', 'vid-take5', true, key, now);
  await store.recordPlay('room-a', 'vid-take5', true, key, now + 1);
  assert.deepStrictEqual(await store.getSearches([key], 2, now + 2), {}, 'one room, however often it reports, is not a quorum');
  assert.deepStrictEqual(await store.getSearches([key], 1, now + 2), { [key]: ['vid-take5'] }, 'a quorum of one serves it');
  await store.recordPlay('room-b', 'vid-take5', true, key, now + 3);
  await store.recordPlay('room-b', 'vid-live', true, key, now + 3);
  await store.recordPlay('room-c', 'vid-take5', true, key, now + 4);
  let got = await store.getSearches([key, 'nope|nobody'], 2, now + 5);
  assert.deepStrictEqual(got, { [key]: ['vid-take5'] }, 'only videos with a quorum are served, unknown lookups are absent');
  await store.recordPlay('room-c', 'vid-live', true, key, now + 6);
  got = await store.getSearches([key], 2, now + 7);
  assert.deepStrictEqual(got[key], ['vid-take5', 'vid-live'].sort((x, y) => (x === 'vid-take5' ? -1 : 1)), 'the most confirmed video comes first');
  assert.deepStrictEqual(await store.getSearches([], 2, now), {});
  ok('lookups: a quorum of different rooms, most confirmed first');

  // a failure withdraws that room's vote, and a video that fails more than it plays is not served
  await store.recordPlay('room-c', 'vid-live', false, key, now + 8);
  got = await store.getSearches([key], 2, now + 9);
  assert.deepStrictEqual(got[key], ['vid-take5'], 'a room that saw it fail withdraws its vote, so the quorum is lost');
  for (const room of ['r1', 'r2', 'r3']) await store.recordPlay(room, 'vid-doomed', true, 'doomed|song', now);
  assert.deepStrictEqual((await store.getSearches(['doomed|song'], 2, now))['doomed|song'], ['vid-doomed']);
  for (const room of ['f1', 'f2', 'f3', 'f4']) await store.recordPlay(room, 'vid-doomed', false, undefined, now); // failed elsewhere, without a lookup vote
  assert.deepStrictEqual(await store.getSearches(['doomed|song'], 2, now), {}, 'a video that has failed in more rooms than it played in is no longer served');
  ok('lookups: failures withdraw votes and retire bad videos');

  // old votes stop counting
  await store.recordPlay('old-1', 'vid-old', true, 'old|song', now);
  await store.recordPlay('old-2', 'vid-old', true, 'old|song', now);
  assert.ok((await store.getSearches(['old|song'], 2, now + 89 * DAY))['old|song']);
  assert.deepStrictEqual(await store.getSearches(['old|song'], 2, now + 91 * DAY), {}, 'lookup votes expire unless renewed');
  await store.recordPlay('old-1', 'vid-old', true, 'old|song', now + 90 * DAY);
  await store.recordPlay('old-2', 'vid-old', true, 'old|song', now + 90 * DAY);
  assert.ok((await store.getSearches(['old|song'], 2, now + 91 * DAY))['old|song'], 'and are renewed by a new play');
  ok('lookups: votes age out and are renewed by new plays');

  // ----- play log -----
  const row = (at, extra = {}) => ({ at, trackId: 't' + at, title: 'Song ' + at, artist: 'Artist', genres: ['rock', 'blues'], mode: 'blend', present: 3, up: 0, down: 0, skips: 0, ...extra });
  await store.upsertPlays('hash-a', [row(now + 3000), row(now + 1000), row(now + 2000)]);
  await store.upsertPlays('hash-b', [row(now + 500)]);
  assert.deepStrictEqual((await store.getPlays('hash-a')).map((r) => r.at), [now + 1000, now + 2000, now + 3000], 'plays come back oldest first');
  await store.upsertPlays('hash-a', [row(now + 3000, { up: 4, down: 1, skips: 2, present: 5 })]);
  const rewritten = await store.getPlays('hash-a');
  assert.strictEqual(rewritten.length, 3, 'writing a play again does not duplicate it');
  assert.deepStrictEqual({ up: rewritten[2].up, down: rewritten[2].down, skips: rewritten[2].skips, present: rewritten[2].present }, { up: 4, down: 1, skips: 2, present: 5 }, 'later votes update the row');
  assert.deepStrictEqual(rewritten[0].genres, ['rock', 'blues']);
  assert.strictEqual((await store.getPlays('hash-a', 2)).length, 2); assert.strictEqual((await store.getPlays('hash-a', 2))[1].at, now + 3000, 'a limit keeps the newest');
  assert.deepStrictEqual(await store.getPlays('hash-none'), []);
  ok('play log: ordered, idempotent, votes update, per-room, limited');

  // ----- artist genres -----
  assert.strictEqual(await store.getArtistGenres('tool', now), undefined);
  await store.putArtistGenres('tool', ['metal|9', 'rock|4'], 90 * DAY, now);
  assert.deepStrictEqual(await store.getArtistGenres('tool', now + DAY), ['metal|9', 'rock|4']);
  assert.strictEqual(await store.getArtistGenres('tool', now + 91 * DAY), undefined);
  await store.putArtistGenres('nobody', [], 7 * DAY, now);
  assert.deepStrictEqual(await store.getArtistGenres('nobody', now), [], 'an empty answer is remembered too');
  ok('artist genres: stored, expire, empty answers kept');

  // ----- housekeeping -----
  const before = await store.stats(2, now + 5);
  assert.ok(before.ratedVideos >= 5 && before.playVotes >= 8 && before.confirmedLookups >= 1 && before.lookupsWithVotes >= 3, JSON.stringify(before));
  await store.sweep(now + 40 * DAY);
  assert.deepStrictEqual(await store.stats(2, now + 5), { ...before, artists: 1 }, 'recent votes stay (expired artist answers go)');
  assert.ok((await store.getPlays('hash-a')).length === 3, 'play logs outlive vote retention');
  await store.sweep(now + 300 * DAY);
  const late = await store.stats(2, now + 300 * DAY);
  assert.ok(late.playVotes < before.playVotes && late.lookupsWithVotes === 0, 'votes older than six months are forgotten: ' + JSON.stringify(late));
  await store.sweep(now + 400 * DAY);
  assert.deepStrictEqual(await store.getPlays('hash-a'), [], 'play logs are deleted after a year');
  ok('sweep: expired artist answers, stale votes and year-old play logs only');
};
