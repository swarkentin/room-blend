# Music sources (providers)

Room Blend separates two jobs:

1. **Matching** (server): guests' genres in, a fair queue of songs out. It only ever sees song titles, artists and genres. It never sees credentials, files, audio or Spotify tokens.
2. **Playing** (host's browser): the host's tab talks directly to their music service, finds each queued song and plays it.

A host picks one source per room. The service does not stream audio and holds no streaming accounts, which keeps it free to run and inside each service's terms.

## What exists

| Source | Catalogue the room plays from | Who sets it up | Notes |
|---|---|---|---|
| Spotify | Built-in list of about 6,400 songs, plus songs found by genre search | Host (own free Spotify app, or a shared one) | Premium needed. Songs are matched by title and artist. |
| My music files | The host's own folder | Nobody | Tags read in the browser. mp3, m4a, flac, ogg, opus, wav. Needs a genre tag per song, or the host assigns a genre to untagged ones. Re-pick the folder after a page reload. |
| Navidrome / Subsonic | The host's whole server library | Host (server URL + login) | Works with Navidrome, Gonic, Airsonic-Advanced, Funkwhale and any Subsonic-compatible server. The server must allow requests from the page (CORS), and an https page cannot call a plain-http server unless it runs on the same computer. |
| YouTube | Built-in list of about 6,400 songs, each looked up on YouTube | Host (free Google API key) | No Premium and no files. Plays in YouTube's embedded player, which must stay visible. Free YouTube may play ads. A search costs 100 of the free 10,000 daily units, so about 100 new songs a day; looked-up songs are remembered in the browser. Some videos block embedding and are skipped. The key stays in the host's browser. |
| Spotify: my songs | The host's saved songs, genres from their artists | Host (own Spotify app, Premium) | Re-read every 30 minutes and on Sync now. Songs with no artist genre are left out. |
| Just show the songs | Built-in list of about 6,400 songs | Nobody | The host plays them anywhere. |
| Apple Music | not built | | See below. |

The open-source equivalent of Spotify's catalogue is **Navidrome** (a self-hosted music server, Subsonic API). Jellyfin also serves music and could be added the same way.

## Two kinds of source

- **curated** (Spotify, Apple Music): the room uses the built-in genre-tagged song list and the service looks each song up. Songs not on the service are skipped. A provider may add songs per genre with `extras(genre)`.
- **curated** (Spotify, YouTube): the room plays from the built-in list and the provider finds each song on its service.
- **library** (files, Subsonic, Jellyfin): the provider sends the host's catalogue to the server (`POST /api/rooms/:code/host/library`, up to 20,000 songs of `{id, title, artist, genres[]}` with canonical genres). The room then plays only from that catalogue and every song is playable. Ids are the service's own; the server prefixes them with `L`, and the client strips that before calling `play`.

## Adding a source

Create `public/<name>.js`, register it, and add a script tag in `public/index.html` before `app.js`:

    window.Providers.register({
      id: 'jellyfin', name: 'Jellyfin', blurb: 'Your Jellyfin server.',
      kind: 'library',                      // or 'curated'
      render(ctx) { /* DOM node: setup form, progress, status */ },
      ready()     { /* true when it can play right now */ },
      play(track) { /* track.nativeId, title, artist -> Promise<true | false | null> (null = unplayable, skip it) */ },
      pause() {}, resume() {}, stop() {},
      activate(ctx) { /* library only: re-send the catalogue after the host switches back */ },
      // curated only: canExtras(), extras(genre) -> [{title, artist}]
    });

`ctx` offers `uploadLibrary(provider, label, tracks)`, `clearLibrary()`, `rerender()`, `ended()` (call when a song finishes), `changed()` (call after the source becomes ready), `st()` (latest room state), `genres` (the 56 canonical genres). Use `GenreMap.fromTag(text)` to turn free-form genre text into canonical genres, and `Providers.makeAudio()` for a ready-made audio element that survives browser autoplay rules.

## Apple Music (design, not built)

Not built because it cannot be tested or switched on without a paid Apple Developer account, and I would rather not ship code I could not run. How it would fit, from Apple's public documentation (check before relying on it):

- Web playback uses MusicKit JS. It needs a **developer token**: a JWT signed with a private key from an Apple Developer Program membership (paid, yearly). One token can serve all hosts, so the person running the service pays once and hosts need no developer account. This would be the one place the server holds a secret (a small `/api/apple/token` endpoint).
- The host signs in with their own Apple Music subscription (`music.authorize()`), which gives a user token that stays in their browser.
- It is a **curated** source: search the Apple catalogue for each queued song (`/v1/catalog/{storefront}/search`), then `setQueue` and `play`. Catalogue songs carry `genreNames`, so it could also become a **library** source built from the host's library (`/v1/me/library/songs`), which would let the room play the host's own saved songs.
- Guest taste import (Apple's "recently played") is possible but the API is reported incomplete for playlists, so manual genre picks stay the default.

## Privacy

Sent to the room's server: song titles, artists and genre tags (library sources), guests' picked genres. Not sent: file contents, file paths, passwords, tokens. Spotify and Subsonic credentials stay in the host's browser (Subsonic passwords only in the tab's session storage).

## Genres

Room Blend uses 56 genres in 8 groups (Rock, Roots, Jazz and soul, Pop, Electronic, Hip hop, World, Classical), including modern ones such as lo-fi, chillout, IDM, downtempo, trip hop, synthwave, chillwave, hyperpop, shoegaze, post-rock, neo soul and amapiano, defined in `lib/engine.js` (`GENRE_GROUPS`, `EDGES`). Each edge says how close two genres feel; the engine chains them and sharpens the result so that neighbours blend (rock + blues, house + pop) and distant genres take turns (metal + classical).

- **Broad picks.** A guest can pick "All rock" (stored as `any:rock`) instead of, or beside, specific genres. It spreads the guest's weight evenly over the group, so they overlap with everyone in that family.
- **Adding a genre:** add it to a group, add edges to its nearest neighbours, add at least six songs to `lib/catalog.js` (append, so existing ids stay stable) and a rule in `public/genremap.js` so tags from files and Spotify map to it. `npm test` checks all three.
- **Bigger lists:** the built-in list only serves Spotify and manual hosts. Library hosts (files, Navidrome) bring their own catalogue of up to 20,000 songs.

## Staying in sync

| Source | When the song list refreshes |
|---|---|
| Navidrome / Subsonic | Every time the host connects, then every 15 minutes while the room is open, and on **Sync now** |
| Spotify: my songs | When the host starts, then every 30 minutes, and on **Sync now** |
| Your own files | When the host picks the folder (a browser cannot watch a folder, so pick it again to rescan) |
| Built-in list | Fixed; it ships with the app |

A refresh swaps in the new list but keeps the song that is playing and the songs already lined up, so nothing stops mid-song. It sends the whole list again (titles, artists, genres only), capped at 20,000 songs.
