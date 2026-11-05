'use strict';
const assert = require('assert');
const { createClient } = require('../lib/musicbrainz');
const { Room } = require('../lib/room');

(async () => {
  let requests = 0, requestedUrl = '';
  const artistIds = {
    tool: '11111111-1111-1111-1111-111111111111',
    nada: '22222222-2222-2222-2222-222222222222',
    bach: '33333333-3333-3333-3333-333333333333',
  };
  const client = createClient({
    intervalMs: 0,
    fetchImpl: async (url, options) => {
      requests++;
      requestedUrl = String(url);
      const parsed = new URL(requestedUrl), path = parsed.pathname, query = parsed.searchParams.get('query') || '';
      assert.ok(options.headers['User-Agent'].startsWith('RoomBlend/'));
      if (path.endsWith('/artist/')) {
        if (query.includes('Bach')) return {
          ok: true,
          json: async () => ({ artists: [{
            id: artistIds.bach, name: 'Johann Sebastian Bach', score: 100, aliases: [{ name: 'Bach' }],
            tags: [{ name: 'jazz', count: 900 }],
          }] }),
        };
        if (query.includes('Nada Surf')) return {
          ok: true,
          json: async () => ({ artists: [{
            id: artistIds.nada, name: 'Nada Surf', score: 100,
            tags: [{ name: 'jazz', count: 900 }],
          }] }),
        };
        return {
          ok: true,
          json: async () => ({ artists: [
            { id: artistIds.tool, name: 'Tool', score: 100, tags: [{ name: 'jazz', count: 900 }] },
            { id: '44444444-4444-4444-4444-444444444444', name: 'Tool', score: 70, tags: [{ name: 'classical', count: 50 }] },
          ] }),
        };
      }
      if (path.endsWith('/artist/' + artistIds.tool)) return {
        ok: true,
        json: async () => ({ genres: [
          { name: 'progressive metal', count: 41 },
          { name: 'metal', count: 5 },
          { name: 'progressive rock', count: 20 },
          { name: 'post-metal', count: 1 },
          { name: 'classical', count: 0 },
          { name: 'christmas', count: 100 },
        ] }),
      };
      if (path.endsWith('/artist/' + artistIds.nada)) return {
        ok: true,
        json: async () => ({ genres: [
          { name: 'alternative rock', count: 40 },
          { name: 'indie rock', count: 30 },
          { name: 'rock', count: 20 },
        ] }),
      };
      if (path.endsWith('/artist/' + artistIds.bach)) return {
        ok: true,
        json: async () => ({ genres: [
          { name: 'classical', count: 40 },
          { name: 'baroque', count: 30 },
        ] }),
      };
      if (path.endsWith('/recording/')) return {
        ok: true,
        json: async () => ({ recordings: [
          { title: 'Schism', score: 100, 'artist-credit': [{ name: 'Tool' }] },
          { title: 'Wrong', score: 40, 'artist-credit': [{ name: 'Other' }] },
        ] }),
      };
      if (path.endsWith('/release-group/')) return {
        ok: true,
        json: async () => ({ 'release-groups': [
          { id: '12345678-1234-1234-1234-123456789abc', title: 'Lateralus', score: 100, 'artist-credit': [{ name: 'Tool' }] },
        ] }),
      };
      if (path.endsWith('/release-group/12345678-1234-1234-1234-123456789abc')) {
        return { ok: true, json: async () => ({ releases: [{ id: '00000000-0000-0000-0000-000000000001' }] }) };
      }
      if (path.endsWith('/release/00000000-0000-0000-0000-000000000001')) return {
        ok: true,
        json: async () => ({
          'artist-credit': [{ name: 'Tool' }],
          media: [{ tracks: [
            { title: 'Track One', recording: { 'artist-credit': [{ name: 'Tool' }] } },
            { title: 'Track Two' },
            { title: 'Track One', recording: { 'artist-credit': [{ name: 'Tool' }] } },
            { title: 'Track Three' },
            { title: 'Track Four' },
            { title: 'Track Five' },
            { title: 'Track Six' },
          ] }],
        }),
      };
      throw new Error('unexpected MusicBrainz path: ' + path);
    },
  });
  const red = createClient({
    intervalMs: 0,
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/artist/')) {
        assert.strictEqual(parsed.searchParams.get('limit'), '25', 'artist lookup searches beyond the default top five');
        return { ok: true, json: async () => ({ artists: [
          { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', name: 'Red Hot Chili Peppers', score: 100 },
          { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', name: 'Simply Red', score: 97 },
          { id: '0ff93a82-dc2f-4a6f-93c3-e260868b6566', name: 'Red', score: 84, type: 'Group', disambiguation: 'US Christian rock band' },
        ] }) };
      }
      if (parsed.pathname.endsWith('/artist/0ff93a82-dc2f-4a6f-93c3-e260868b6566')) {
        assert.strictEqual(parsed.searchParams.get('inc'), 'genres');
        return { ok: true, json: async () => ({ genres: [
          { name: 'alternative metal', count: 1 },
          { name: 'christian rock', count: 3 },
          { name: 'metal', count: 1 },
          { name: 'nu metal', count: 1 },
          { name: 'post-grunge', count: 2 },
          { name: 'symphonic rock', count: 2 },
        ] }) };
      }
      throw new Error('unexpected RED MusicBrainz path: ' + parsed.pathname);
    },
  });
  const redGenres = await red.lookupArtist('RED');
  assert.ok(redGenres.some((x) => x.genre === 'metal'), redGenres.map((x) => x.genre).join(', '));
  assert.ok(redGenres.some((x) => x.genre === 'gospel'), 'Christian rock is mapped to the canonical gospel pool');
  assert.ok(redGenres.some((x) => x.genre === 'rock'), 'post-grunge/symphonic rock contribute canonical rock styles');
  console.log('  ok  exact artist matches below 90 and beyond the top five resolve curated genres');

  const tags = await client.lookupArtist('Tool');
  assert.ok(new URL(requestedUrl).searchParams.get('inc') === 'genres', 'the second request fetches curated genres by MBID');
  assert.ok(tags.some((x) => x.genre === 'metal'));
  assert.ok(tags.some((x) => x.genre === 'rock'));
  assert.ok(!tags.some((x) => x.genre === 'jazz'), 'arbitrary tags returned by search are ignored');
  assert.ok(!tags.some((x) => x.genre === 'classical'));
  assert.ok(!tags.some((x) => x.genre === 'christmas'), 'holiday styles cannot be inferred');
  assert.deepStrictEqual(await client.lookupArtist('tool'), tags);
  assert.strictEqual(requests, 2, 'cached lookups avoid repeating either MusicBrainz request');
  const nada = await client.lookupArtist('Nada Surf');
  assert.ok(nada.some((x) => x.genre === 'alternative'));
  assert.ok(nada.some((x) => x.genre === 'indie'));
  assert.ok(nada.some((x) => x.genre === 'rock'));
  assert.ok(!nada.some((x) => x.genre === 'jazz'), 'Nada Surf is classified from its actual MusicBrainz genres');
  const bach = await client.lookupArtist('Bach');
  assert.ok(bach.some((x) => x.genre === 'classical'), 'exact aliases resolve canonical artist names');
  console.log('  ok  MusicBrainz resolves exact artist MBIDs, fetches curated genres, and caches results');
  
  const found = await client.search('Schism');
  assert.deepStrictEqual(found.songs[0], { title: 'Schism', artist: 'Tool', source: 'musicbrainz' });
  assert.strictEqual(found.albums[0].title, 'Lateralus');
  assert.ok(found.artists.some((x) => x.name === 'Tool'));
  console.log('  ok  MusicBrainz search returns artist, recording and release-group matches');
  const foundByBoth = await client.search('Schism', 'Tool');
  assert.deepStrictEqual(foundByBoth.songs[0], { title: 'Schism', artist: 'Tool', source: 'musicbrainz' });
  const combinedQuery = new URL(requestedUrl).searchParams.get('query');
  assert.ok(combinedQuery.includes('recording:"Schism" AND artist:"Tool"'), combinedQuery);
  assert.deepStrictEqual(foundByBoth.artists, [], 'combined song searches do not return artist-only matches');
  console.log('  ok  combined jukebox search requires both recording title and artist');

  const withTracks = createClient({
    intervalMs: 0,
    fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/release-group/12345678-1234-1234-1234-123456789abc')) {
        return { ok: true, json: async () => ({ releases: [{ id: '00000000-0000-0000-0000-000000000001' }] }) };
      }
      if (path.endsWith('/release/00000000-0000-0000-0000-000000000001')) {
        return {
          ok: true,
          json: async () => ({
            'artist-credit': [{ name: 'Tool' }],
            media: [{ tracks: [
              { title: 'Track One', recording: { 'artist-credit': [{ name: 'Tool' }] } },
              { title: 'Track Two' },
              { title: 'Track One', recording: { 'artist-credit': [{ name: 'Tool' }] } },
              { title: 'Track Three' },
              { title: 'Track Four' },
              { title: 'Track Five' },
              { title: 'Track Six' },
            ] }],
          }),
        };
      }
      throw new Error('unexpected MusicBrainz path: ' + path);
    },
  });
  const tracks = await withTracks.albumTracks('12345678-1234-1234-1234-123456789abc');
  assert.strictEqual(tracks.length, 5);
  assert.strictEqual(tracks[1].artist, 'Tool', 'album artist is used when track artist credit is missing');
  assert.deepStrictEqual(await withTracks.albumTracks('bad-id'), []);
  console.log('  ok  album tracklists deduplicate, resolve credits, and honor the five-song pick limit');

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

  // A single existing track must not suppress discovery of a named artist's wider catalogue.
  const toolGuest = room.addGuest('Tool Guest', [], { artists: ['Tool'], immediate: true });
  toolGuest.artistGenres = { tool: [{ genre: 'metal', count: 41 }] };
  room.extra.push({ id: 'existing-tool', title: 'One Tool Song', artist: 'Tool', genres: ['metal'] });
  room.rebuildCatalog();
  assert.ok(room.wantArtists().some((x) => x.name === 'Tool'), 'one existing Tool track should still trigger artist discovery');
  for (let i = 0; i < 7; i++) room.extra.push({ id: 'more-tool-' + i, title: 'Tool Song ' + i, artist: 'Tool', genres: ['metal'] });
  room.rebuildCatalog();
  assert.ok(!room.wantArtists().some((x) => x.name === 'Tool'), 'eight existing tracks are enough to satisfy the initial artist seed');

  const nadaGuest = room.addGuest('Nada Guest', [], { artists: ['Nada Surf'] });
  nadaGuest.artistGenres = { 'nada surf': nada };
  const nadaInference = room.inferredGenres(nadaGuest);
  assert.ok(nadaInference.includes('alternative') && nadaInference.includes('indie'), nadaInference.join(', '));

  const rockGuest = room.addGuest('Rock Guest', [], { artists: ['Nada Surf', 'Tool'] });
  rockGuest.artistGenres = { 'tool': tags, 'nada surf': nada };
  const rockInference = room.inferredGenres(rockGuest);
  assert.ok(rockInference.includes('metal'), rockInference.join(', '));
  assert.ok(rockInference.includes('alternative') || rockInference.includes('indie'), rockInference.join(', '));
  assert.ok(!rockInference.includes('jazz'), 'Nada Surf and Tool genres must not inherit unrelated search tags');
  console.log('  ok  Nada Surf infers alternative/indie and combined Nada Surf + Tool infer metal without jazz');

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
