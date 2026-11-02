'use strict';
const assert = require('assert');
const { createClient } = require('../lib/musicbrainz');
const { Room } = require('../lib/room');

(async () => {
  let requests = 0, requestedUrl = '';
  const client = createClient({
    intervalMs: 0,
    fetchImpl: async (url, options) => {
      requests++;
      requestedUrl = String(url);
      assert.ok(options.headers['User-Agent'].startsWith('RoomBlend/'));
      if (new URL(requestedUrl).searchParams.get('query').includes('Bach')) {
        return {
          ok: true,
          json: async () => ({ artists: [{
            name: 'Johann Sebastian Bach', score: 100, aliases: [{ name: 'Bach' }],
            tags: [{ name: 'classical', count: 40 }, { name: 'baroque', count: 30 }],
          }] }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          artists: [
            { name: 'Tool', score: 100, tags: [
              { name: 'progressive metal', count: 41 },
              { name: 'metal', count: 5 },
              { name: 'progressive rock', count: 20 },
              { name: 'post-metal', count: 1 },
              { name: 'classical', count: 0 },
              { name: 'christmas', count: 100 },
            ] },
            { name: 'Tool', score: 70, tags: [{ name: 'classical', count: 50 }] },
          ],
        }),
      };
    },
  });
  const tags = await client.lookupArtist('Tool');
  assert.ok(new URL(requestedUrl).searchParams.get('query').includes('artist:"Tool"'));
  assert.ok(tags.some((x) => x.genre === 'metal'));
  assert.ok(tags.some((x) => x.genre === 'post-rock') === false);
  assert.ok(!tags.some((x) => x.genre === 'classical'));
  assert.ok(!tags.some((x) => x.genre === 'christmas'), 'holiday styles cannot be inferred');
  assert.deepStrictEqual(await client.lookupArtist('tool'), tags);
  assert.strictEqual(requests, 1, 'cached lookups avoid another MusicBrainz request');
  const bach = await client.lookupArtist('Bach');
  assert.ok(bach.some((x) => x.genre === 'classical'), 'exact aliases resolve canonical artist names');
  console.log('  ok  MusicBrainz maps positive community tags, exact aliases, and cached artist lookups');

  const room = new Room('ABCDE', 'key');
  const guest = room.addGuest('Guest', [], { artists: ['Tool', 'Bach'] });
  guest.artistGenres = {
    tool: [{ genre: 'metal', count: 46 }, { genre: 'rock', count: 20 }],
    bach: [{ genre: 'classical', count: 30 }],
  };
  const inferred = room.inferredGenres(guest);
  assert.ok(inferred.includes('metal'), inferred.join(', '));
  assert.ok(inferred.includes('classical'), inferred.join(', '));
  console.log('  ok  genres from multiple named artists are both retained in the inference');

  const misses = createClient({
    intervalMs: 0,
    fetchImpl: async () => ({ ok: true, json: async () => ({ artists: [{ name: 'Tool DJ', score: 100, tags: [{ name: 'classical', count: 10 }] }] }) }),
  });
  assert.deepStrictEqual(await misses.lookupArtist('Tool'), [], 'non-exact names are not attributed to the requested artist');
  console.log('  ok  ambiguous search results are ignored unless the artist name matches exactly');

  let attempts = 0;
  const retries = createClient({
    intervalMs: 0,
    fetchImpl: async () => {
      attempts++;
      return attempts === 1
        ? { ok: false, status: 503, body: { cancel: async () => {} } }
        : { ok: true, json: async () => ({ artists: [] }) };
    },
  });
  assert.deepStrictEqual(await retries.lookupArtist('Unavailable'), []);
  assert.strictEqual(attempts, 2, 'a transient service overload is retried once');
  console.log('  ok  transient MusicBrainz overloads retry once, then return a normal no-match');
})().catch((e) => { console.error(e); process.exitCode = 1; });
