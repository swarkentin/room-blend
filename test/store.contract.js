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

  // ----- pools and songs -----
  const song = (id, title, artist, genres = [], quality = 1) => ({ id, title, artist, genres, quality });
  await store.putPool('blues rock', [song('vid-blues1', 'Pride and Joy', 'Stevie Ray Vaughan', ['blues']), song('vid-blues2', 'Crossfire', 'Stevie Ray Vaughan', ['blues', 'rock'], 2)], 30 * DAY, now);
  await store.putPool('empty one', [], 12 * 3600000, now);
  let got = await store.getPools(['blues rock', 'empty one', 'never stored'], now + 1000);
  assert.deepStrictEqual(got['blues rock'].map((s) => s.id), ['vid-blues1', 'vid-blues2'], 'a pool keeps its order');
  assert.deepStrictEqual(got['empty one'], [], 'an empty pool is a real answer');
  assert.ok(!('never stored' in got), 'unknown pools are absent');
  assert.strictEqual(got['blues rock'][1].title, 'Crossfire');
  got = await store.getPools(['blues rock', 'empty one'], now + 13 * 3600000);
  assert.ok('blues rock' in got && !('empty one' in got), 'pools expire on their own schedule');
  got = await store.getPools(['blues rock'], now + 31 * DAY);
  assert.ok(!('blues rock' in got));
  ok('pools: ordered, negative answers, per-pool expiry');

  // songs merge across pools: genres add up (capped), quality keeps the best
  await store.putPool('rock hits', [song('vid-blues2', 'Crossfire', 'Stevie Ray Vaughan', ['classic rock', 'guitar', 'electric', 'extra'], 5)], DAY, now);
  const merged = (await store.getPools(['rock hits'], now))['rock hits'][0];
  assert.strictEqual(merged.quality, 5, 'best quality wins');
  assert.strictEqual(merged.genres.length, 4, 'genres are capped');
  assert.ok(merged.genres.includes('blues') && merged.genres.includes('rock'), 'earlier genres are kept');
  await store.putSongs([song('vid-blues2', 'Crossfire', 'Stevie Ray Vaughan', [], 0.5)], now);
  assert.strictEqual((await store.getPools(['rock hits'], now))['rock hits'][0].quality, 5, 'a lower quality never replaces a higher one');
  ok('songs: genres merge (capped), quality only goes up');

  // ----- searches -----
  await store.putSearch('take five|dave brubeck', ['vid-a', 'vid-b'], 30 * DAY, now);
  await store.putSearch('missing|nobody', [], 6 * 3600000, now);
  let s = await store.getSearches(['take five|dave brubeck', 'missing|nobody', 'nope'], now + 1000);
  assert.deepStrictEqual(s['take five|dave brubeck'], ['vid-a', 'vid-b']);
  assert.deepStrictEqual(s['missing|nobody'], []);
  assert.ok(!('nope' in s));
  await store.putSearch('take five|dave brubeck', ['vid-b', 'vid-a'], 30 * DAY, now);
  assert.deepStrictEqual((await store.getSearches(['take five|dave brubeck'], now))['take five|dave brubeck'], ['vid-b', 'vid-a'], 'a later answer replaces the earlier one');
  s = await store.getSearches(['missing|nobody'], now + 7 * 3600000);
  assert.ok(!('missing|nobody' in s), 'not-found answers expire sooner');
  ok('song lookups: ordered ids, replace, expiry');

  // ----- playback record -----
  await Promise.all([store.addPlayback('vid-blues1', 1, 0, now), store.addPlayback('vid-blues1', 1, 0, now), store.addPlayback('vid-blues1', 0, 1, now), store.addPlayback('vid-bad', 0, 1, now), store.addPlayback('vid-bad', 0, 1, now)]);
  assert.deepStrictEqual(await store.getPlayback(['vid-blues1', 'vid-bad', 'vid-none']), { 'vid-blues1': { successes: 2, failures: 1 }, 'vid-bad': { successes: 0, failures: 2 } }, 'simultaneous reports all count');
  assert.deepStrictEqual(await store.getPlayback([]), {});
  await store.putPool('blues again', [song('vid-blues1', 'Pride and Joy', 'Stevie Ray Vaughan', ['blues'])], DAY, now);
  const withTally = (await store.getPools(['blues again'], now))['blues again'][0];
  assert.strictEqual(withTally.s, 2); assert.strictEqual(withTally.f, 1, 'pool reads carry the community tally');
  ok('playback: atomic tallies, carried on pool reads');

  // ----- finding songs -----
  await store.putSongs([
    song('vid-take5', 'Take Five', 'Dave Brubeck', ['jazz'], 3), song('vid-take5b', 'Take Five (Live)', 'Dave Brubeck Quartet', ['jazz'], 1),
    song('vid-other', 'Blue Rondo a la Turk', 'Dave Brubeck', ['jazz'], 2), song('vid-unrelated', 'Thunderstruck', 'AC/DC', ['rock'], 4),
  ], now);
  const cand = await store.candidates('Take Five', 'Dave Brubeck', 10);
  assert.strictEqual(cand[0].id, 'vid-take5', 'the closest title and artist comes first');
  assert.ok(cand.some((c) => c.id === 'vid-take5b') && cand.some((c) => c.id === 'vid-other'));
  assert.ok(!cand.some((c) => c.id === 'vid-unrelated'), 'songs sharing no words are not candidates');
  assert.deepStrictEqual(await store.candidates('', '', 10), []);
  assert.strictEqual((await store.candidates('Take Five', 'Dave Brubeck', 1)).length, 1, 'limit applies');
  ok('candidates: ranked by shared words, bounded');

  for (let i = 0; i < 12; i++) await store.putSongs([song('vid-j' + i, 'Jazz Tune ' + i, 'Jazz Artist ' + i, ['jazz'], 1 + i / 100)], now);
  await store.addPlayback('vid-j0', 0, 1, now); await store.addPlayback('vid-j0', 0, 1, now); // two failures: taken out of rotation
  const sample = await store.genreSongs('jazz', 5, () => 0.5);
  assert.strictEqual(sample.length, 5);
  assert.ok(sample.every((x) => x.genres.includes('jazz')), 'only the asked-for genre');
  assert.ok(!sample.some((x) => x.id === 'vid-j0'));
  const all = await store.genreSongs('jazz', 100, () => 0.5);
  assert.ok(!all.some((x) => x.id === 'vid-j0'), 'songs that keep failing are skipped');
  assert.ok(all.length >= 12 && all.every((x) => x.genres.includes('jazz')));
  assert.deepStrictEqual(await store.genreSongs('polka', 5), []);
  assert.notDeepStrictEqual((await store.genreSongs('jazz', 5, () => 0.01)).map((x) => x.id), (await store.genreSongs('jazz', 5, () => 0.99)).map((x) => x.id), 'the sample is shuffled');
  ok('genre sample: right genre, failing songs skipped, shuffled');

  // ----- artist genres -----
  assert.strictEqual(await store.getArtistGenres('tool', now), undefined);
  await store.putArtistGenres('tool', ['metal|9', 'rock|4'], 90 * DAY, now);
  assert.deepStrictEqual(await store.getArtistGenres('tool', now + DAY), ['metal|9', 'rock|4']);
  assert.strictEqual(await store.getArtistGenres('tool', now + 91 * DAY), undefined);
  await store.putArtistGenres('nobody', [], 7 * DAY, now);
  assert.deepStrictEqual(await store.getArtistGenres('nobody', now), [], 'an empty answer is remembered too');
  ok('artist genres: stored, expire, empty answers kept');

  // ----- housekeeping -----
  const before = await store.stats();
  assert.ok(before.songs >= 18 && before.ratedVideos >= 3);
  await store.sweep(now + 40 * DAY);
  const after = await store.stats();
  assert.ok(after.pools <= before.pools && after.searches <= before.searches, 'sweep clears expired lookups');
  assert.ok(after.songs === before.songs, 'recent songs stay');
  await store.sweep(now + 200 * DAY);
  const late = await store.stats();
  assert.ok(late.songs < before.songs && late.songs >= 1, 'old songs go unless they have played successfully: ' + JSON.stringify(late));
  assert.ok((await store.getPlayback(['vid-blues1']))['vid-blues1'].successes === 2, 'play history survives the sweep');
  ok('sweep: expired lookups and stale unplayed songs only');
};
