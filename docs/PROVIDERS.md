# Music sources (providers)

Room Blend separates two jobs:

1. **Matching** (server): guests' genres in, a fair queue of songs out. It only ever sees song titles, artists and genres. It never sees credentials, files, audio or Spotify tokens.
2. **Playing** (host's browser): the host's tab talks directly to their music service, finds each queued song and plays it.

A host picks one source per room. The service does not stream audio and holds no streaming accounts, which keeps it free to run and inside each service's terms.

## What exists

| Source | Catalogue the room plays from | Who sets it up | Notes |
|---|---|---|---|
| Spotify | Songs Spotify files under each genre in the room (genre search), plus the built-in list only where that comes back thin | Host (own free Spotify app, or a shared one) | Premium needed. Songs are found by title and artist with a precise search, then a looser one; a result is accepted only if most of the title and part of the artist match, and covers, live and karaoke versions are rejected (`public/match.js`). |
| My music files | The host's own folder | Nobody | Tags read in the browser. mp3, m4a, flac, ogg, opus, wav. Needs a genre tag per song, or the host assigns a genre to untagged ones. In Chrome, Edge and Opera the folder is chosen through the File System Access API and remembered, so after a reload "Reopen" brings it back in one click (see below). Other browsers use a plain folder input and re-pick the folder after a reload. |
| Navidrome / Subsonic | The host's whole server library | Host (server URL + login) | Works with Navidrome, Gonic, Airsonic-Advanced, Funkwhale and any Subsonic-compatible server. The server must allow requests from the page (CORS), and an https page cannot call a plain-http server unless it runs on the same computer. |
| YouTube | A playlist per genre in the room, read and filtered; the built-in list only where that comes back thin | Host (free Google API key) | No Premium and no files. Plays in YouTube's embedded player, which must stay visible. Free YouTube may play ads. Playlist searches cost 100 of the free 10,000 daily units; a second search for a genre is made only if the first pool has fewer than 12 usable songs. Requests are serialized and paced. Results and the daily quota pause are stored in the host browser. Some videos block embedding and are skipped. The key stays in the host's browser. |
| Spotify: my songs | The host's saved songs, genres from their artists | Host (own Spotify app, Premium) | Re-read every 30 minutes and on Sync now. Songs with no artist genre are left out. |
| Just show the songs | Built-in list of about 6,700 songs | Nobody | The host plays them anywhere. |
| Apple Music | not built | | See below. |

The open-source equivalent of Spotify's catalogue is **Navidrome** (a self-hosted music server, Subsonic API). Jellyfin also serves music and could be added the same way.

## Two kinds of source

- **curated** (Spotify, YouTube, Apple Music): the room's songs come from the service, by genre. The built-in list is the fallback, not the source.
  - The server tells the host page which genres in the room it has no songs for yet (`wantGenres`). For each, the provider's `extras(genre, partners)` returns `[{title, artist, id, genres}]`: songs the service itself returned, the service's own id (a Spotify uri or a YouTube video id), and the tags the search implies. `partners` are the genres the other guests picked.
  - `Pools` (`public/pools.js`) says what to search: each genre's own name, then a few real compound names that include it ("blues rock" is tagged blues and rock, so a blues fan and a rock fan share it), preferring compounds that include another guest's genre. YouTube stops after the first pool provides at least 12 usable songs. `GenreMap.classifyAll` turns a compound name into tags.
  - The host page posts the result (`POST /host/extras` with `pool: true`). The room then plays from those songs and plays each by its id, so nothing is looked up or matched. Built-in songs are added only for a genre the host asked about that came back with fewer than 12 songs, and always for holidays. If a search returns nothing at all the room stays on the built-in list.
  - Spotify: `genre:"..."` track searches, 10 results per page (the dev-mode maximum), three pages per name, with `market=from_token`. YouTube: one playlist search per query, then the playlist's videos (1 unit per 50) and their details (1 unit per 50), keeping embeddable, public songs between 1 and 10 minutes that are not live, remix, compilation or "full album" uploads. Searches are serialized and spaced two seconds apart across tabs where the browser supports Web Locks; a brief 429 gets one retry, but a long Retry-After or repeated rate limits pauses new lookups until midnight Pacific time. Playlist results are cached in the host browser for a week and survive same-origin Render redeploys, but are not shared across browsers/devices. A daily quota pause is remembered in browser storage; cached songs remain usable, and songs that need a new lookup are skipped so playback continues.
  - A song that is on the built-in list but not from the service is found by title and artist (`public/match.js`), as before.
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

## Choosing a folder for "My music files"

Audio never leaves the host's computer, so there is nothing to upload and nothing for the server to store or scan. There are two ways to choose the folder, and the panel offers whichever the browser supports:

- **File System Access API** (Chrome, Edge, Opera; `showDirectoryPicker`). The browser asks to let the site "view" the folder. Room Blend walks it, reads each song's tags, and plays a song by reading its file from the folder handle when its turn comes. The handle is stored in this browser's IndexedDB (`rb-local`), so after a reload the panel offers **Reopen "<folder>"**. A saved handle keeps the folder but not the permission, so the browser may ask again; the reopen click is the gesture it needs. **Forget this folder** deletes the saved handle. Chrome refuses some broad folders (Documents, Downloads, the home folder); the panel says so and points to the older picker. If storage is blocked (a private window), the folder just is not remembered.
- **Folder input** (`<input webkitdirectory>`, every browser, also offered as "older folder picker" where the API exists). Some browsers word this prompt as "upload this folder". That is the browser's standard text: the files are only read here. It cannot remember the folder, and iOS Safari has no folder choice at all, only "or choose files".

Songs get the same ids either way (from the folder-relative path and file size), and a file that has moved or been deleted since the scan is skipped when its turn comes. A browser cannot watch a folder, so changes on disk are picked up by choosing or reopening the folder again.

## Artists and songs guests name

A guest's named artists and songs are matched by plain text (`normKey`, `artistKeys`, `songKey` in `lib/engine.js`), so the same song found through Spotify, YouTube or a file lines up, and "Mark Ronson feat. Bruno Mars" answers to both names. The engine gives a named song a fit of 1.0 for that guest. In rotation it also adds 0.12 for a named song (0.06 for a named artist) to that guest's turn; in a blend it adds a nudge of at most 0.06, and only for songs the room would nearly accept (`U >= tau - 0.1`).

Guests who join without genre picks can optionally enable MusicBrainz artist-tag lookup. It searches exact artist names (including exact aliases), maps positive community tags to Room Blend's genres, and keeps the existing room-catalog guess as a fallback. At most five artist names are looked up; requests are rate-limited and cached in memory. The option is off by default; enabling it sends up to five names from the guest's artist picks and song credits to MusicBrainz. Genre picks always take precedence. MusicBrainz identifies tags as supplementary data under CC BY-NC-SA 3.0; review its [data license](https://musicbrainz.org/doc/MusicBrainz_Database) before commercial deployment.

When a named artist is not in the room's songs, the room lists them in `wantArtists` (at most 3 at a time, with the naming guest's first genre) and the host page calls the provider's optional `artistTracks(name, genre)`. Spotify searches `artist:"<name>"` (two pages of 10); YouTube reads one playlist for "<name> greatest hits" (about 100 quota units, cached for a week). The result is posted to `/host/extras` with `artist`, and the room keeps only songs whose credit includes that artist. Each artist is asked about once per music source. Library sources never ask.

## Privacy

Sent to the room's server: song titles, artists and genre tags (library sources), guests' picked genres. If a guest opts into MusicBrainz genre lookup, up to five names from their artist and song picks are also sent to MusicBrainz. Not sent: file contents, file paths, passwords, tokens. A remembered music folder is a handle stored only in the host's own browser (IndexedDB); it is never sent anywhere. Spotify and Subsonic credentials stay in the host's browser (Subsonic passwords only in the tab's session storage).

## Genres

Room Blend uses 62 genres, defined in `lib/engine.js` (`GENRE_GROUPS`, `EDGES`). The picker shows them in 14 groups laid out the way the big music apps do it, so a guest looks for "Hip hop & R&B" or "Country & folk" and not for our own families: Pop, Rock, Alternative & indie, Hip hop & R&B, Soul & funk, Jazz & blues, Country & folk, Electronic, Chill, Latin, Reggae & Caribbean, World, Classical & soundtrack and Holiday. After them come shortcut buttons: **Eras** (50s to 2020s), **Moods** (focus, party, workout, dinner, sleep, road trip, feel good, romance) and **More styles** (drill, phonk, djent, indie rock, classic and modern R&B, latin pop, bluegrass, opera, salsa & bachata). Modern and global styles are all there: lo-fi, chillout, IDM, trip hop, synthwave, hyperpop, shoegaze, post-rock, neo soul, amapiano, K-pop, J-pop (with city pop and anime themes), Bollywood (Hindi film music and Punjabi pop), Brazilian (MPB, samba, sertanejo and Brazilian pop and rock) and soundtrack (film, TV and game scores and songs from musicals). Each edge says how close two genres feel; the engine chains them and sharpens the result so that neighbours blend (rock + blues, house + pop, J-pop + K-pop) and distant genres take turns (metal + classical).

- **Holiday genres (Christmas, Halloween).** These are seasonal, so they work differently. A song tagged with a holiday plays only while someone in the room has picked that holiday, so nobody hears Christmas songs in July. Everyone else in the room is still served by the song's style tags: a Christmas fan and a pop fan share Christmas pop, a Christmas fan and a metal fan start with Christmas songs that rock and then take turns. There is no "All holiday" pick, because a holiday has to be asked for by name. When the last holiday fan leaves, queued holiday songs are dropped. To add a holiday, add it to `HOLIDAYS` and the Holiday group in `lib/engine.js`, give it a few edges to its nearest styles, put songs in `lib/songs/holiday.js` (holiday tag first, then their styles) and add a rule in `public/genremap.js`.
- **Broad picks.** A guest can pick "All rock" (stored as `any:rock`) instead of, or beside, specific genres. It spreads the guest's weight evenly over the group, so they overlap with everyone in that family. A group's id defaults to its lower-cased name with dashes; a group whose name has symbols gives its own short id as a third element (`['Hip hop & R&B', [...], 'hip-hop-rnb']` is `any:hip-hop-rnb`). Picks from earlier versions of the picker (`any:roots`, `any:jazz-and-soul`, `any:hip-hop`) are still accepted and mean what they did (`LEGACY_GROUPS`), so a guest who already joined is not broken. Other group ids kept their names but now cover the regrouped genres (`any:rock` no longer includes alternative or indie; pick "All alternative & indie" for those).
- **Eras, moods and styles** are shortcuts, not tags: each expands to a few of the 62 genres (`GENRE_ALIASES`), splitting the guest's weight evenly, and never to a holiday. They need no songs of their own. A shortcut keeps working for guests who picked it even after its button is removed (`rap`, `korean pop`, `japanese pop` and `christian music` are no longer buttons because each is now a genre or a search word).
- **Search words.** The picker's search matches a button's name and also the words people use for it (`GENRE_SYNONYMS`): "rap" finds hip hop, "anime" finds J-pop, "film" finds soundtrack, "samba" finds Brazilian, "xmas" finds Christmas, "djent" finds metal. Add the first word a guest would type when adding a genre.
- **Genres from other services.** `public/genremap.js` maps the names services and file taggers use onto these genres, and the first matching rule wins. "djent" and "progressive metal" count as metal, "desi hip hop" as Bollywood and hip hop, "japanese city pop" and "anime" as J-pop (K-pop is only Korean), and samba, sertanejo, MPB and baile funk as Brazilian (bossa nova keeps its own genre).
- **Adding a genre:** add it to a group in `GENRE_GROUPS`, add edges to its nearest neighbours in `EDGES`, add at least 25 songs where it is the first tag (a new file in `lib/songs/` that sorts after the others, so existing ids stay stable), add a rule in `public/genremap.js` so tags from files and Spotify map to it, a search name in `public/pools.js` (`MAIN`, and a compound name or two in `BRIDGES`) and its search words in `GENRE_SYNONYMS`. Tag a song with a second genre only if a fan of that genre would really enjoy it: a song's tags are what make two genres blend, so a stray tag can join genres that are far apart (a metal game score tagged as a soundtrack made metal and classical fans blend, until it was tagged as metal). `npm test` checks all of this, including that about half of all genre pairs blend.
- **Bigger lists:** the built-in list only serves Spotify and manual hosts. Library hosts (files, Navidrome) bring their own catalogue of up to 20,000 songs.

## Staying in sync

| Source | When the song list refreshes |
|---|---|
| Navidrome / Subsonic | Every time the host connects, then every 15 minutes while the room is open, and on **Sync now** |
| Spotify: my songs | When the host starts, then every 30 minutes, and on **Sync now** |
| Your own files | When the host picks or reopens the folder (a browser cannot watch a folder, so choose or reopen it again to rescan) |
| Built-in list | Fixed; it ships with the app |

A refresh swaps in the new list but keeps the song that is playing and the songs already lined up, so nothing stops mid-song. It sends the whole list again (titles, artists, genres only), capped at 20,000 songs.
