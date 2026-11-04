# Room Blend

One service, many rooms. Anyone can open it, press **Start a room**, and send friends a link. Friends pick up to four genres on their phones; the host's Spotify plays songs from the overlap, and takes fair turns when there is none. No accounts, no dependencies, Node 22+.

## For someone who just wants to host a room

Open the service, press **Start a room**, then choose where your music is:

- **Spotify: my songs**: plays your own saved songs through your Premium account and re-reads them automatically, so the catalogue is as big as your library.
- **Spotify**: plays through your Premium account, using Spotify's own songs for the genres in the room. A short guide helps you create your own free Spotify app (2 minutes).
- **My music files**: pick a folder on your computer. Nothing is uploaded except song names and genres. Chrome, Edge and Opera remember the folder, so after a reload you reopen it with one click.
- **YouTube (free)**: plays songs in YouTube's own player, so no Premium and no files are needed. You bring a free Google API key (about 5 minutes, steps are on the host page and in `docs/SETUP.md`). It searches a second playlist for a genre only when the first has fewer than 12 usable songs. Successful discoveries are cached in IndexedDB in the host browser for 30 days; empty searches expire after 12 hours so a temporarily poor result can be retried. The cache survives redeploys at the same site address, but is not shared with other browsers or devices. New lookups pause for the day if Google's daily quota is exhausted or rate limits persist, and uncached songs are skipped so playback can continue.
- **Navidrome / Subsonic**: connect your own music server.
- **Holiday blends**: guests can pick Christmas or Halloween. Those songs play only while someone in the room has picked the holiday, and everyone else is served by the style of each song.
- **Just show the songs**: you play them yourself.
- **Apple Music**: not available yet (needs a paid Apple developer account; see `docs/PROVIDERS.md`).

Your friends never need any of these. They join with a link and pick genres.

## How guests join

No app, no account, no typing needed. Any one of these works:

1. **Scan the QR code** on the host's screen. For a TV, **TV / cast view** gives the host page a clean presentation while keeping its music player running; cast that same browser tab. **QR screen** opens a separate join-code display and does not play music.
2. **Tap the room** under "Playing near you" when they open the site. It lists rooms started on the same Wi-Fi whose host is online. The host can switch this off, and rooms are shown by name, head count and code only.
3. **Open the short link** `yoursite.com/ABCDE`, shared with the Share button (the phone's share sheet), copy, or any chat.
4. **Type the 5-letter code, or paste the link,** into the box on the home page. It joins the moment the code is complete.

On the join page a guest taps one to four genres, names an artist or song, or both, and is in. A name is optional. Returning guests get a one-tap **Rejoin** on the home page, and reloading the page keeps them in the room. Shared links show a preview with the room name in chat apps.

### Naming artists and songs

Under the name field on the join page, and again in the room after joining, a guest can search the room's music and MusicBrainz for artists, songs and albums, then name up to 5 artists and 5 songs (or type an artist the search does not find). Searches of two or more characters are sent to MusicBrainz for matching results. Selecting an album adds up to five tracks as song picks. A guest who does not know their genres can join with only artists or songs: the room guesses genres from matching songs, and can optionally use MusicBrainz's free community artist tags for a stronger guess. The separate genre lookup option is off by default; enabling it sends up to five artist names from the guest's artist and song picks to MusicBrainz. The guest can always choose genres manually. A named artist or song counts as a perfect match for that guest. It never overrides the room: when the room agrees on a style, a named song only gets a small nudge and only if everyone could nearly accept it, and when songs rotate, it is the first choice on that guest's own turn. Only the guest sees their picks. The host sees how many artists and songs each guest named, never which ones, and the server logs only counts. If the room's songs do not include a named artist, the host's browser looks them up once in its music source (Spotify artist search, or one YouTube playlist search of "<artist> greatest hits") and keeps only that artist's songs. Hosts playing their own complete library are never asked to look anything up.

"Near you" matches the public network address, so it suits a home, party or venue Wi-Fi. On a mobile network, where many strangers share an address, the host should untick "Show to people on this Wi-Fi".

## Run the service

First time, or testing on your home network? Follow [docs/SETUP.md](docs/SETUP.md): install check, phones joining over Wi-Fi, Spotify setup, running several rooms, and every setting.

    node server.js                      # http://localhost:3000, works with no settings
    docker build -t room-blend . && docker run -p 8080:8080 -v rb-data:/data room-blend

No settings are required. The address is picked up from the browser, so there is no URL to configure. Optional:

| Setting | Meaning |
|---|---|
| `TRUST_PROXY=1` | Behind Render, Fly, Cloudflare and so on, use the real visitor IP for limits. Set in the Dockerfile; turn off if you expose Node directly. |
| `PUBLIC_URL` | Address friends should open. Only needed for the laptop + tunnel setup below. |
| `SPOTIFY_CLIENT_ID` | A Spotify app for everyone to use. See the note below before you rely on it. |
| `MAX_ROOMS`, `ROOMS_PER_IP_HOUR` | Capacity (2000) and how many rooms one visitor may start per hour (8). |
| `SESSION_SECRET` | Signs the receipts a host's browser keeps so a room can be restored after a restart or redeploy, even with no disk. `render.yaml` generates one. Any long random string works. |
| `RESTORE_DAYS` | How long after the host last opened a room it can still be restored (30). |
| `DATA_DIR` | Where room codes and host keys are also kept across restarts when the host has a real disk. Live state is rebuilt when people reconnect. |
| `LOG_LEVEL` | `silent`, `error`, `warn`, `info` (default), or `debug` (adds one line per request). Logs are JSON lines: warnings and errors on stderr, the rest on stdout. They never contain names, picks, room codes, host keys or IP addresses. Rooms and visitors appear as short salted hashes. |
| `STATUS_KEY` | `/status` shows rooms, guests, connections, timings, memory and top genres. By default it answers only on the machine itself. Set a key to read it remotely with `?key=...` or an `x-status-key` header. |

`/healthz` answers `ok` for platform health checks.

### Why hosts bring their own Spotify app

Spotify limits a development-mode app to five authorised users, and extended access is granted only to established products. One shared app cannot serve a public service. A host's own app only ever needs the host, so the limit never applies, and the service owner needs no Spotify approval. If you do get extended access, set `SPOTIFY_CLIENT_ID` and hosts can use it with one click (guest genre import also turns on).

## Free ways to run it

- **Your laptop plus a Cloudflare Tunnel** (free, always HTTPS): `node server.js` then `cloudflared tunnel --url http://localhost:3000`. Set `PUBLIC_URL` to the tunnel address so join links and QR codes use it. The host opens `http://127.0.0.1:3000` themselves, which Spotify accepts for login. Best for testing with friends tonight.
- **Render free web service**: `render.yaml` is included (New > Blueprint). Free services sleep after 15 minutes with no incoming requests (the host page pings every 5 minutes while a room is open), wake in about a minute, have no persistent disk, and can be restarted at any time. Rooms survive that anyway: the host's browser keeps a signed receipt and brings the same room back (same code, name and settings) the next time it connects, and listeners' picks are kept on their own phones. This needs the `SESSION_SECRET` that `render.yaml` generates. 750 free hours a month covers one always-on service. See `docs/SETUP.md` section 5.
- **Oracle Cloud Always Free VM**: genuinely always on, but you manage a small Linux server (install Node or Docker, put Caddy in front for HTTPS). Availability varies by region.
- **Railway** gives a one-time trial credit; **Fly.io** (`fly.toml` included) asks for a card and costs a few dollars a month. Serverless platforms (Vercel, Netlify, Workers) are not suitable: this needs a long-running server.

## Tests

    npm test                    # engine, tag reader (needs ffmpeg), API
    npm run test:browser        # Spotify (shared, own app, saved-songs sync), local files (folder input and the File System Access API), Navidrome/Subsonic sync, join paths, genre picker. Needs Playwright, ffmpeg and Python OpenCV (CI installs these).

## Not verified against real Spotify

Local files were tested with real mp3, ogg and flac files played in Chromium. Subsonic was tested against a fake server that checks the real token login. Spotify was tested against a fake built from the documented API. YouTube was tested against a fake of its search and player APIs. Not yet tried against real Navidrome, Spotify or YouTube. Check these first on a real run:
- YouTube: that your API key is accepted, that songs start by themselves (browsers may need one click on the player first), and that most songs are found and embeddable.
- Navidrome: that your server allows requests from the page (CORS) and that an empty search returns your whole library. If it does not, the app falls back to walking albums.
- The player reports end-of-track the way `public/spotify.js` expects. If songs do not advance, **Next song** still works.
- Genre search and top-artists import still work for new apps. If not, the app uses the built-in list of about 6,700 songs and manual picks.
- Built-in songs are matched by title and artist, so a few may be a different version.

Licensing: Spotify is for private listening. Use this at home or with friends, not in a business.

## Layout

    server.js          HTTP, live updates (SSE), limits, persistence of room identities
    lib/               engine.js (blend / rotation), room.js (state), catalog.js (about 360 tracks)
    public/            app.js (UI), providers.js + spotify.js + local.js + subsonic.js (music sources),
                       tags.js (reads song tags), genremap.js, app.css
    docs/PROVIDERS.md  how music sources work, how to add one, Apple Music plan
    test/              engine, API and browser tests
    Dockerfile  render.yaml  fly.toml

## What guests take home

Each guest sees **Played while you were here**: every song since they arrived (including the one already playing), newest first. Per song they can **Save** it (kept on their phone, with a Copy my list button), open **Find it** links for Spotify, Apple Music and YouTube Music, or tap **More like this** to add the song's genre to their picks, so a good surprise widens what the room plays for them. A guest who rejoins keeps their original start time.

## How the room knows who is still here

- **Connection:** each guest's page keeps a live connection. If it vanishes (closed tab, bad signal), the guest is kept for 3 minutes, then removed.
- **Locked phone:** a page that goes to the background says so, and the guest then stays counted for the host's "keep a guest counted after their phone locks" time (30 minutes by default, 5 to 240). This works for guests on mobile data who never join the host's Wi-Fi. Opening the page again renews it, or rejoins them with their picks if the time ran out.
- **Leaving the Wi-Fi:** for guests who joined from the room's own Wi-Fi, the page checks in once a minute. Two checks in a row from another network mark them away, so songs are chosen without them. They return on their own when back, and are removed after 15 minutes away. Guests who joined by link from outside the Wi-Fi are never judged this way.
- **Still here?** After an hour without touching the page, the guest is asked. No answer in 5 minutes sets them to sit out; touching the page brings them back.
- The host sees "Away" or "Quiet" next to a guest's name. Guests added by hand never time out.
- Tunable with `DISCONNECT_GRACE_MS`, `DOZE_DEFAULT_MIN`, `AWAY_REMOVE_MS`, `IDLE_ASK_S`, `IDLE_ANSWER_MS` and `BEAT_MS`.
