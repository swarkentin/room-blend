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
(Shipped in #63; kept here for the record.) The recap endpoint exists and the host page now shows it. The panel covers songs, minutes, genre mix, best and least-liked songs and peak listeners, with a shareable summary. This is also the first thing a venue owner can see and show someone, which helps get people on board.
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

### 7. Start music without a guest ("house picks")
Today a room plays nothing until someone joins, so hosts add fake guests to get going. Replace that with a first-class **house profile**: the host picks genres, eras, moods or artists once (or chooses a preset such as "Friday dinner" or "Pool party") and the room blends them like a guest, labelled "House" on the screen and in recaps, with an adjustable weight, so real guests can outweigh it or it can fade out as people arrive. A standing room (item 3) keeps its house profile.
**Built (first version):** the host sets up to 4 genres, moods or eras and up to 6 artists in a *House picks* card; the music starts with nobody in the room. The house either steps aside when a guest arrives (default) or stays as one more listener. It is never shown as a person, never counted in listeners or the recap, and is saved with the room. Not yet built: presets ("Friday dinner"), an adjustable weight, and fading out gradually.
*Needs:* an engine input that is not a person (no avatar, no votes, no skip rights). *Done when:* a host presses Start and music plays with no guest in the room, and the recap and play log never count the house as a listener.

### 8. Guest profiles with sign-in (optional)
Guests stay anonymous by default. A guest who signs in (same provider as hosts) can save a profile: name, avatar, genres, eras, moods, favourite artists, and join any room in one tap. This is the account side of "remembered tastes" (item 4). Let a guest start anonymous and sign in later without losing their picks in the current room, and let them delete the profile and everything linked to it.
*Needs:* a `profiles` table keyed by user, a join path that reads it, and the privacy rules in "Privacy and responsibilities" (a profile must never be shown to a host beyond what the guest picked for the room). *Done when:* a returning guest scans the code and is already "themselves".

### 9. A meaningful cast to Google TV and other screens
The TV view is just a web page, so there are three routes, from least to most work. We have not tried any of them on real hardware, so each needs a device test before it is promised:
1. **Open the page on the TV.** A short address and room code (for example `/tv`, then type the 5 letters) for the browser on Google TV, Fire TV, Samsung or LG, plus a QR code on the host page. No Google account or app needed.
2. **Cast the tab or window** from desktop Chrome (the browser's own Cast menu). Works today, but the host must know to do it (item 11) and the audio plays from the host's computer unless they choose otherwise.
3. **A "Cast this view" button** using the browser's Presentation API where it exists, and later a registered Google Cast receiver app, which needs a Google developer registration and a hosted receiver page.
Decide first **where the sound plays**: on the host's device (simple, the TV is only a display) or on the TV itself (a receiver must do the playback, and YouTube and Spotify have their own rules for that). Recommend starting with route 1 and an explicit "sound plays from..." choice.
*Done when:* a host can get the TV view on a living-room TV in under a minute without reading documentation.

### 10. More variety on the TV / cast screen
One scene is fine for a minute and dull for an evening. Add selectable and rotating **scenes**: album-art-led now playing, the walking avatars (today's), the crowd's genre mix as it shifts, the next three songs with who picked them, a leaderboard from the duels, and a quiet "ambient" scene for dinners. The host picks one or "rotate every N minutes". Keep it safe for TVs: slow motion, no long static bright elements (burn-in), a reduced-motion option, large type readable from across a room, and no scene that needs sound to make sense.
*Needs:* the scenes read the same room state the screen reads now, so mostly front-end work. *Done when:* a three-hour night does not repeat one picture, and a host can pin a scene.

### 11. Tell hosts how to share their room (Discord, Zoom, Meet, Teams and others)
It is not obvious how to get music and the TV view to people who are not in the room. Add a **Share your room** help panel on the host page with short, per-app steps: how to share a browser tab or window together with its sound in Discord, Zoom, Google Meet and Microsoft Teams (including the "share sound" or "share tab audio" option that people miss), plus what guests then do (scan the QR or open the link from the call chat). Include a one-click "copy invite message" and a stream-friendly view with a large QR and link. The exact menu names change between apps and versions, so each guide needs checking against the current app before it is published and a "last checked" date.
*Done when:* a first-time host can run a Discord or Zoom session by following the panel alone.

### 12. Remote guests: take part without watching the cast
A guest who is not in the room (or not watching the shared screen) should still be able to pick, vote and hear the music. Two options, and we recommend the first:
- **Listen along (recommended).** The guest's own device plays the same song in step with the host, using the same source (a YouTube embed on the guest's device, for example), so nothing is streamed from the host and no audio is re-broadcast. The server publishes what is playing and where it is (video or track id, start time, position), the guest page plays it with a mute and volume control, and re-syncs when it drifts by more than a couple of seconds. Browsers need one tap from the guest to allow sound. Sources that need each listener to hold an account (Spotify Premium, for example) can be offered only to guests who have one; local files and music servers cannot be listened along to at all.
- **Stream the host's audio** to remote guests (for example over WebRTC). Avoid: it re-broadcasts licensed music, which the streaming services' terms generally forbid, and quality and delay are poor.
Let each guest choose where *their* sound plays: "the room's speakers", "my device", or "off". Remote guests still count in the blend and the votes.
*Needs:* a published playback position per song, a guest-side player, and a clear rule for which sources support it. *Done when:* a guest on another continent hears the same song within a couple of seconds of the room, and a source that cannot do this says so instead of failing silently.

### 13. Search that works across providers
Each source (YouTube, Spotify, local files, a music server) searches on its own, so a guest or host looking for one song has to know which source has it. Add one search box that asks every connected source, merges the answers into one list with a small source badge, and picks a playable source for the room automatically (the host's connected sources, in the host's chosen order), falling back to the next source when one cannot play it. Today's room search already merges songs and MusicBrainz artists; this extends it to every provider and to the host page.
*Needs:* a common result shape across providers, quota awareness (YouTube searches are the scarce resource, see DATABASE.md), and the track identity work under "Later". *Done when:* typing one song name finds it whichever source holds it, and playing it never needs the person to choose a source.

### 14. A shared YouTube key, a quota budget, and keeping the cache warm
**The problem.** Today every host needs their own YouTube API key, and a key's free allowance (10,000 units a day by default, where a search costs 100 units and most other lookups cost 1, so roughly 100 searches a day; check the current figures in Google's console) is easy to spend. The shared catalogue (DATABASE.md) already spares searches that another room paid for, and it gets better as it fills.

**A shared key for hosts who have none.** Keep the key on the server only; hosts never see it. Their searches go through the server, which first answers from the shared catalogue and only then spends quota. Spend is limited at three levels:
- **Per room and per account:** a small bucket (for example a few searches an hour) that refills slowly, and accounts (item 2) get a larger one than anonymous rooms.
- **Global daily budget:** a fixed share of the day's units, with a reserve so one busy hour cannot starve the evening. The allowance resets at midnight Pacific time, so the budget is paced against that clock, not ours.
- **A circuit breaker:** when the budget is spent or YouTube returns a quota error, the server stops asking and answers "not available right now" so hosts fall back to their own key or to cached songs.
Hosts who add their own key keep using it and spend nothing from the shared budget.

**Spend less per song.** Prefer the 1-unit lookups (confirming a video is playable and embeddable) over the 100-unit search wherever we already know candidate video ids, and let votes in the catalogue confirm answers so a song is searched once for everyone. Applying to Google for a higher quota is free and worth doing once there are real users.

**Warming the cache in the background.** When the day's budget has leftovers (or just before the midnight reset, when unused units are lost anyway), spend them looking up the songs rooms are most likely to ask for next: the most-played songs in the play log, and the songs of artists guests recently picked. This uses the official API and the same budget, so it is safe and honest about its cost.
**We should not scrape YouTube's pages or results.** It breaks YouTube's terms of service (automated access outside the API), puts the key and the service at risk of being blocked, and is fragile. Third-party mirrors that wrap YouTube carry the same risk. Other sources that are meant to be queried (MusicBrainz for metadata, as item 6 proposes) are fine within their rate limits.

**Waking a sleeping server.** On Render's free plan the service stops after about 15 minutes without traffic, so a background job cannot run while it is asleep. Options, simplest first, each needing a check against the current Render and Neon plans:
1. **A scheduled ping from outside.** A free scheduler (a GitHub Actions workflow on a schedule, or a free cron service) calls a protected `/tasks/warm` endpoint with a secret. Waking is just the first request; the endpoint runs the warming work and returns. Cheap, and the secret lives only in the scheduler and in Render's environment.
2. **Render's own cron job** service, which is a paid feature, running the same task without the web server.
3. **A webhook from Neon to Render.** Neon (as far as we know) does not call out to a web address when data changes, so this would need a small bridge we run ourselves, which is more moving parts than option 1. We would only choose it if a data change must trigger work immediately.
Whichever is used, the task is idempotent, bounded in time and spend, and refuses to run without the secret.

*Needs:* the quota ledger (a table of units spent per day and per room), a server-side search proxy, and a protected task endpoint. *Done when:* a host with no key can search within a stated allowance, the server never exceeds the day's budget, and popular songs are already cached before the first guest asks for them.

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

Status update: items 7 to 13 added from the owner's list (house picks, guest profiles, casting, TV scenes, sharing help, remote guests, cross-provider search). None started.

Status update: item 14 (shared YouTube key, quota budget, cache warming) added. Scraping is deliberately excluded; see the item.
