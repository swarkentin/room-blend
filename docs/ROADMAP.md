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
