# Roadmap

Where Room Blend goes now that rooms, the YouTube catalogue and play history are stored on the server (see [DATABASE.md](DATABASE.md)). The goal stays the same: music that adapts to the people in the room. Persistence is what lets it remember, learn and become a service.

Principles that decide the order:
- **Guests stay anonymous.** Joining by QR code with no signup is the product. Accounts are optional and for hosts.
- **Record early, analyse later.** Data not collected cannot be learned from, so anonymous logging comes before the features that use it.
- **No shared pollution.** Anything shared between rooms is built from votes, never from one host's word.
- **Free tier first.** Every phase must run on Render's and Neon's free plans, and say what it costs when it outgrows them.

## Now: shipped

| | What | Notes |
|---|---|---|
| Done | Rooms and encrypted checkpoints in Postgres (Neon) | A restart or redeploy restores rooms without the host's browser. |
| Done | Shared YouTube lookups and video quality, built from votes | Spares the ~100 searches/day quota. Playlists stay local. |
| Done | Artist genres cached for everyone | One MusicBrainz lookup per artist. |
| Done | Anonymous play log and host recap (`GET /api/rooms/:code/host/recap`) | Every play with genres, listener count and votes, filed under a room hash. |

## Next

### 1. Recap in the host page, and a shareable "night in review"
The recap endpoint exists; the host page does not show it yet. Add a panel (songs, minutes, genre mix, best and least-liked songs, peak listeners) and a shareable summary. This is also the first thing a venue owner can see and show someone, which helps get people on board.
*Needs:* front-end work only. *Done when:* a host sees tonight's recap without leaving the page.

### 2. Optional host accounts
Sign in to keep a room: attach it to an account, see "My rooms", reclaim a room on another device. Add a nullable `owner_user_id` on rooms so anonymous hosts keep working. The catalogue voter becomes the account, so one person with ten rooms counts once.
*Needs:* an auth library on the existing Postgres (better-auth is the candidate; Neon Auth is the managed alternative) and a decision on sign-in methods. Both mean a new dependency, so they need a machine with package installs. *Done when:* a host can lose their browser data and still get their room back.

### 3. Standing rooms
A venue's room that persists between nights: its name, settings, expected genres and play history kept under the owner's account. Needs phase 2.
*Done when:* "Friday patio" opens the same way every Friday.

### 4. Remembered tastes for regulars
Optional saved taste for guests (account or device-bound id) and a venue-level prior built from the people who usually come, so a room opens with a good blend before anyone scans the code. This is the biggest product step toward the original idea.
*Needs:* phase 2 and a clear privacy design (below). *Done when:* an empty standing room starts with music its regulars like.

### 5. Learn which blends work
Use the play log (genres played, listener count, votes) to learn which genre combinations the room accepts or skips, and feed that into how the blend is built. Start with aggregate analysis offline; only then change behaviour.
*Needs:* a few weeks of logged data from real rooms. *Done when:* a measurable drop in skip-votes for blended songs.

### 6. Song-level metadata: genres, eras, moods and more
**Where we are.** Almost nothing is known about a *song*. A song carries at most three genre tags, and since the artist-genre fix those come from the *artist* (MusicBrainz), so a jazz artist's one rock song is filed as jazz. Eras (`80s`) and moods (`party`, `focus`) are not tags on songs at all: they are lists of genres (`GENRE_ALIASES` in `lib/engine.js`), so "80s" means "classic rock, new wave, synth pop..." whatever year a song came out. The shared database holds only song lookups, video quality and artist genres. That is too sparse to blend well, to explain a blend, or to learn from.

**Proposed model.** One row per song, many tagged facets per song:

- `songs`: a track identity (the MusicBrainz recording id when known, otherwise a normalised `artist|title` key; see "Track identity across sources" below), plus title, artist, release year.
- `song_tags(song, facet, value, source, weight)`, with facets `genre`, `era` (the real release decade), `mood` / `activity` (party, focus, dinner...), and later `energy`, `tempo`, `language`, `explicit`.
- **Sources, ranked by trust:** (1) MusicBrainz recording and release-group data, including its release dates and tags; (2) votes from rooms (a tag counts only after several different rooms or accounts agree, the same rule as the shared catalogue); (3) observed listening (a song that listeners in "party" rooms keep and skip rarely earns `party`); (4) title and artist wording, as today. The more specific and trusted source wins, and artist-level genres remain only as the fallback.
- **Eras come from the release date**, not from genre lists, so "80s" can include a 2019 synthwave song and exclude a 1995 re-release's wrong year. Mood and activity are inferred and labelled as such (a `source` and a `weight`), never presented as fact.

**How the blend changes.** The engine matches a guest's picks against song tags facet by facet: an `80s` pick matches songs from that decade, a `focus` pick matches songs tagged `focus` (and falls back to today's genre list for songs with no mood data). Songs with richer, agreeing tags rank higher, and the host can see why a song was chosen.

**Build in steps.**
1. Schema and store for songs and tags (additive migration; `artist_genres` stays). A background job fills it from MusicBrainz at its limit of about one request a second, caches misses, and never blocks a room.
2. Hosts read song tags in batches like catalogue lookups, and use them for tagging and for the era facet.
3. Teach the engine facets (eras from real dates first, as the least ambiguous).
4. Votes and observed listening, once real rooms have produced data (this is the same data as item 5).

**Open questions.**
- Mood, energy and tempo have no free, authoritative source we have confirmed. Spotify's audio features and AcousticBrainz are not dependable for new projects as far as we know (to be checked before relying on either). Last.fm's tags would work but need an API key and agreement to its terms. Which are you willing to use?
- How many tags per facet to keep per song, and how long unconfirmed tags live.
- Whether tags are shared across all hosts from the start or only after quorum (recommended: quorum, so nobody can tag songs into a mood).

*Needs:* items 2 and the play log for the learning steps; step 1 can start now. *Done when:* an `80s` pick returns songs from the 1980s, and a song's genres can differ from its artist's.

## Later

- **Juke box.** Song requests, play-time credits and a durable ledger. Needs durable identity (phase 2) so credits belong to someone; design the abuse model first.
- **Track identity across sources.** Store each song once (for example by MusicBrainz id) and map it to a video or track id per source, so YouTube, Spotify and Apple Music resolve the same song and the shared catalogue helps every source.
- **Host and venue stats over time.** Busiest hours, returning guests, top genres across nights, built on the play log.
- **Scheduled rooms and events.** Set a room up in advance with preset genres.
- **More than one server.** Rooms live in one instance's memory. Checkpoints make a handoff possible; do not build it before there is load.

## Operations

- **Per-PR database branches** so CI can run the storage tests against a real Postgres. Today the Postgres code is tested only against a scripted fake and an in-memory twin; run `TEST_DATABASE_URL=... node test/store.test.js` against a throwaway Neon database to close that gap.
- **Backups and restore.** Neon branching gives point-in-time restore; decide the retention you want and document how to restore.
- **Watch the free tier.** Storage (0.5 GB) and compute hours. Votes and play logs are small; the checkpoints are the biggest item. Retention today: votes 180 days, play logs one year, expired rooms deleted.

## Privacy and responsibilities

Remembering people brings duties (in Canada, PIPEDA; elsewhere GDPR or similar). Before phase 4: say plainly what is kept, keep guests anonymous by default, give a way to see and delete saved tastes, and prefer aggregate, anonymous learning over per-person profiles. The play log is built that way: no names, no guest ids, no room code.

## Getting hosts on board

- Make the first minute work with no account and no setup beyond a source.
- The recap (phase 1) is the shareable proof of value: it is what a host shows a friend or a venue owner.
- Standing rooms and regulars' tastes (phases 3 and 4) are what turns a one-night trick into a reason to come back.
- Keep the hosting story free and short: a one-page deploy (Render plus Neon) is already in [SETUP.md](SETUP.md) and [DATABASE.md](DATABASE.md).


---
Status update: host accounts API (claim, My rooms, reclaim, per-account catalogue votes) is built behind `AUTH_PROVIDER=neon`; see docs/ACCOUNTS.md. A sign-in screen on the host page is the next UI step.

Status update: host account screens (sign in, keep a room, My rooms, take over) are in PR #65. Song-level metadata (item 6) is proposed above, not started.
