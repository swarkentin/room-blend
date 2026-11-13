# Database (Neon Postgres)

Room Blend runs without a database, and still does. Adding one (Neon's free Postgres is enough) moves three things off the host's browser and onto the server:

| What | Without `DATABASE_URL` | With `DATABASE_URL` |
|---|---|---|
| **Rooms** | Identities in `DATA_DIR/rooms.json` (lost on Render's free plan). The host's browser keeps an encrypted checkpoint and restores the room. | Identities **and an encrypted checkpoint of each live room** in Postgres. A restart or redeploy brings the room back, guests included, with no help from the host's browser. The browser checkpoint stays as a fallback. |
| **YouTube catalogue** | Each host's browser keeps its own genre playlists, song lookups and playback record in IndexedDB. Every new host or browser pays YouTube quota again, and learns about failing videos the hard way. | Hosts also share **song lookups** (which video answers a title and artist) and **video quality** (in how many rooms it played or failed), built from votes. Genre playlists and song lists stay in each host's browser. The browser's IndexedDB stays in front as a fast local layer. |
| **Artist genres** | Looked up from MusicBrainz and kept in server memory. | Looked up once, kept for 90 days, for everyone. |

What this changes for listeners: a new host or browser skips the YouTube searches other rooms already paid for, and a video that fails to embed or play in several rooms is ranked down for all hosts, so fewer songs stall mid-party. YouTube's search quota (roughly 100 searches a day per key) is the scarce resource, and this is what spares it.

## Set up Neon and connect Render (about five minutes)

1. Sign in at neon.com and create a project. Pick the region closest to your Render service (Render and Neon both offer US East and EU Central, among others). The free plan needs no card.
2. In the project dashboard choose **Connect**. Turn **Connection pooling** on and copy the string. It looks like

       postgresql://user:password@ep-cool-name-123456-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require

   Use the **pooled** string (the host contains `-pooler`) for the app.
3. In Render, open your service, then **Environment**, add `DATABASE_URL` with that string, and save. Render redeploys. (A new Blueprint deploy asks for it, because `render.yaml` lists it with `sync: false`.)
4. Watch the logs. A healthy start shows `db.migrated` (first start only) then `db.ready`, with how many rooms were restored. `GET /status` (see `STATUS_KEY`) shows `storage: { backend: "postgres", ready: true }`.
5. Keep `SESSION_SECRET` set. Room checkpoints in the database are encrypted with it, and cannot be read after a restart without it. `render.yaml` generates it for you.

Because `pg` is a new dependency, run `npm install` once and commit the updated `package-lock.json` before deploying: the Dockerfile and CI use `npm ci`, which needs it.

Nothing else to run. The server creates and upgrades its own tables on start (see Migrations).

## How it behaves

**The database is never in the way of a room.** The server listens first and connects second. If Neon is waking from sleep (its compute stops after about five idle minutes, and the first query can take a second or two), the server retries once, serves rooms from memory in the meantime, and the shared catalogue answers "not available" so browsers fall back to their local cache. Writes that failed are retried on the next checkpoint. Nothing a guest or host does fails because the database is slow.

**Rooms.** A room's identity is written within a couple of seconds of a change, and its encrypted checkpoint (typically tens of kilobytes) at least every 15 seconds while it is changing, and once more when the server is told to stop. On start the server loads every room used in the last 24 hours and applies its checkpoint. Guests are treated as disconnected with a fresh grace period, as in any restore. A room whose checkpoint cannot be read (for example `SESSION_SECRET` changed) comes back as an identity only, and its host's browser restores it as before. Expired rooms are deleted.

**Catalogue.** Only two things are shared: song lookups and video quality. Neither is taken on a host's word; both are votes, and a vote is one room reporting that a video played or failed.

- A room counts **once per video**, however often it reports. Its latest report replaces its earlier one.
- A lookup (a title and artist mapped to a video) is served only after **at least 2 different rooms** played that same video for it (`CATALOG_QUORUM`, default 2; use 1 if you run a single room). A room whose play of the video later fails withdraws its vote.
- A video that has **failed in more rooms than it has played in** is never served.
- Lookup votes expire after 90 days unless renewed by a new play, and all votes are deleted after 180 days.
- Genre playlists, song lists and artist tags are **not** shared, so nobody can tag songs into a genre or fill the catalogue with junk. Hosts keep reading their own playlists.

A host's browser sends the room code and host key with every catalogue call, and only hosts can use it. The server turns the room into an opaque voter id (a hash, so the code and key are not stored there). Requests are validated and bounded (video id format, key length, batch sizes). Because anyone can create a room, quorum is a speed bump and not a wall; the planned optional host accounts will make the account the voter, so one person with many rooms still counts once.

**What is stored.** Rooms (code, host key, name, settings, encrypted checkpoint). Votes: for each video, which rooms (as opaque ids) saw it play or fail, and for each song lookup, which rooms confirmed which video. Artist genres. No YouTube API keys, no Spotify tokens, and no guest names or picks in readable form (they are inside the encrypted checkpoint). Each room also keeps its network label, which is how "Playing near you" works; for a public address that label contains the address, exactly as in `rooms.json` today. Old data is swept every six hours: expired artist answers and votes older than six months.

## Free tier limits and growth

At the time of writing Neon's free plan allows 0.5 GB of storage per project and a monthly allowance of compute hours, and suspends compute when idle; check neon.com/pricing for the current numbers. Room Blend is light on both: so the vote tables can hold millions of votes inside the free storage (a few dozen bytes each with indexes), and compute only runs while hosts are using it. Watch usage in the Neon dashboard. If you outgrow it:

- **More storage or always-on compute.** Move to a paid Neon plan with no code change: the connection string stays the same.
- **Any other Postgres 13+** works too (RDS, Supabase, a VM, Docker). Set `DATABASE_URL` to its string. For a database without TLS (local development) use `?sslmode=disable`.
- **Several server instances.** Migrations are guarded by a lock. Rooms are still held in each instance's memory and a room has one home, so run one instance until rooms are routed by code. The catalogue has no such limit.
- **Pruning.** `store.sweep()` is the one place that decides what to forget; tighten its rules if the votes grow faster than you want.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | none | Postgres connection string. Unset means no database. |
| `DATABASE_POOL_MAX` | 5 | Most simultaneous connections from this server. |
| `CATALOG_QUORUM` | 2 | How many different rooms must have played a video for a song before it is shared as that song's answer. |
| `CATALOG_MEMORY` | off | Serve the shared catalogue from memory with no database (development only; lost on restart). |
| `SESSION_SECRET` | see SETUP | Encrypts room checkpoints. Keep it stable. |

## Migrations

`lib/pgstore.js` holds an ordered list of migrations, applied once each in a transaction (recorded in `schema_migrations`) under a transaction-level advisory lock, so two instances starting together cannot collide. To change the schema, append a new entry. Never edit one that has shipped.

## Developing and testing

`npm test` runs the storage contract against the in-memory store and the server tests against a named in-memory store (`DATABASE_URL=memory://name`, a test-only form that behaves like a database), so no database is needed. To run the same contract against real Postgres, point `TEST_DATABASE_URL` at a throwaway database. Use Neon's **direct** (non-pooler) string, because the test pins a private schema, and it creates and drops that schema and touches nothing else:

    TEST_DATABASE_URL='postgresql://...' node test/store.test.js

Local Postgres, for trying the whole thing:

    docker run --rm -p 5432:5432 -e POSTGRES_PASSWORD=pw postgres:16
    DATABASE_URL='postgresql://postgres:pw@localhost:5432/postgres?sslmode=disable' SESSION_SECRET=0123456789abcdef0123 node server.js

## Troubleshooting

- **`db.start_failed` in the logs.** The server keeps running and retries every 15 seconds. Check `DATABASE_URL` (password, `?sslmode=require`), and that the Neon project is not suspended for quota.
- **`restore.secret_not_durable`.** `SESSION_SECRET` is not set, so checkpoints would be unreadable after a restart. Set it.
- **`db.retry` warnings after a quiet spell.** Normal: Neon waking up.
- **Lookups never seem to be shared.** They need 2 different rooms to have played the same video for the same song. With one room, set `CATALOG_QUORUM=1`.
- **The shared catalogue does not show in the YouTube panel.** The panel adds "Shared by all hosts" only when the server has a database and the host page can reach it; check `/status` for `storage.ready: true`.
