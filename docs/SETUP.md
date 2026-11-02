# Set up and run Room Blend

This guide gets Room Blend running on your own machine and home network first, then covers how to open it to the internet when you are ready. No `npm install` is needed: the server has no dependencies.

## 1. Run it on your machine

You need Node 22 or newer.

    node -v                 # should print v22 or higher
    cd room-blend
    node server.js          # prints: Room Blend listening on port 3000

Open `http://127.0.0.1:3000` in a browser on the same machine. Press **Start a room**. You should see a room code and a QR code.

To check the install, run `npm test` (about a minute, no browser needed). `http://127.0.0.1:3000/healthz` answers `ok`.

Change the port with `PORT=8080 node server.js`.

## 2. Let phones on your home network join

Guests do not need accounts, but their phones must be able to reach your machine.

1. **Find your machine's network address.**
   - macOS: `ipconfig getifaddr en0` (Wi-Fi). Try `en1` if it prints nothing.
   - Windows: run `ipconfig` and read "IPv4 Address".
   - Linux: `hostname -I`.
   It looks like `192.168.1.20`.
2. **Start the server with that address as the public URL.** The join link and QR code use this address, so without it they would point at `127.0.0.1`, which phones cannot reach.

       PUBLIC_URL=http://192.168.1.20:3000 node server.js

   On Windows PowerShell: `$env:PUBLIC_URL="http://192.168.1.20:3000"; node server.js`
3. **Open the host page on the machine itself** at `http://127.0.0.1:3000` (not the network address). Spotify only accepts a `127.0.0.1` address for login over plain http, and the host page is the only one that needs Spotify.
4. **Allow the port through your firewall.** macOS and Windows may ask the first time Node starts. Choose Allow. On Linux with `ufw`: `sudo ufw allow 3000/tcp`.
5. **Join from a phone** on the same Wi-Fi: scan the QR code, or open the address from step 2. The phone also lists the room under **Playing near you**, because everything on one private network counts as the same Wi-Fi.

If a phone cannot connect:

- Check it is on the same Wi-Fi, not mobile data and not a router "guest network". Many routers have **client isolation** or **AP isolation** on guest networks, which blocks phones from reaching other devices.
- Open `http://192.168.1.20:3000/healthz` in the phone's browser. If that fails, it is the network or firewall, not the app.
- Make sure `PUBLIC_URL` matches the address you actually use, including the port.

## 3. Connect the music

The host chooses a music source on the host page. Nothing about guests changes.

- **Manual mode** needs nothing. Room Blend shows what to play next and the host plays it anywhere.
- **Your own music files or a Navidrome server**: choose it on the host page. Files stay in the browser. Only titles, artists and genres reach the server.
- **YouTube (free, no Premium, no files)** plays each song in YouTube's own player. You need a free Google API key, used only to look songs up. It stays in your browser and never reaches the Room Blend server.
  1. Go to console.cloud.google.com, create a project (free), then APIs & Services, then Library. Search "YouTube Data API v3" and press Enable.
  2. Credentials, then Create credentials, then API key. Under restrictions choose **Restrict key**, then the YouTube Data API v3 only. Do **not** restrict it to websites: Room Blend sends no referrer, so that would block it.
  3. In Room Blend choose **YouTube**, paste the key, save it, then press **Start the music**.
  4. Keep the tab open and the small YouTube player visible. If a song does not start by itself, press play on that player once.
  Limits: the free allowance covers about 100 playlist searches a day. Each genre in the room needs about two, and what is found is remembered for a week, so repeat genres cost nothing. Some videos cannot be embedded and are skipped, and free YouTube may play ads between songs.
- **Spotify** needs your own Spotify app, because one shared app cannot serve many people (see the README for why).
  1. Go to the Spotify developer dashboard and create an app.
  2. Add this redirect URI exactly: `http://127.0.0.1:3000/callback` (use your port if you changed it).
  3. Copy the Client ID into the Spotify option on the host page, then log in.
  4. Playing through the browser needs Spotify Premium.

## 4. Several rooms at once (multi-tenancy)

There is nothing to switch on. Every press of **Start a room** creates a separate room, so one running server already serves many hosts.

- **How rooms stay apart.** Each room has its own code, host key and guest keys. Host actions need the host key, guest actions need that guest's key, and a guest only ever sees the current song, their own picks and the songs played during their visit. Other guests' names and tastes are never sent to them.
- **Try it.** Open the site in two different browser profiles (or a normal and a private window) and start a room in each. Join each from a phone. The two rooms do not affect each other. On the same Wi-Fi, a phone will list both under **Playing near you** and picks one.
- **Limits you can change** (environment variables):

  | Setting | Default | Meaning |
  |---|---|---|
  | `MAX_ROOMS` | 2000 | Most rooms at once. |
  | `ROOMS_PER_IP_HOUR` | 8 | Rooms one device may start per hour. Raise it if you create many test rooms (`ROOMS_PER_IP_HOUR=100`). |
  | `DATA_DIR` | `./data` | Where room codes, host keys and room settings are saved so rooms survive a restart. |
  | `LOG_LEVEL` | `info` | `silent`, `error`, `warn`, `info` or `debug`. JSON lines, with no names, picks, codes, keys or IPs. |
  | `STATUS_KEY` | none | Lets you read `/status` from outside with `?key=` or an `x-status-key` header. Without it, only the machine itself can. |

  A room holds at most 40 guests. Idle rooms are cleaned up automatically.
- **What is stored.** The data folder holds room codes, host keys, room settings and the room's network label. It does not hold guest names, picks or listening history, which live in memory only and are rebuilt when people reconnect. Delete the data folder to forget all rooms.
- **Keep it private on your network.** Anyone on the same network who has a room code can join that room. For a stricter setup, run it on a network you control, or put it behind HTTPS and your own access rules.

## 5. When you want it outside your home

- **Quick test with friends elsewhere:** `cloudflared tunnel --url http://localhost:3000`, then start the server with `PUBLIC_URL` set to the tunnel address and `TRUST_PROXY=1`. The host still opens `http://127.0.0.1:3000` themselves.
- **Always-on hosting:** Docker (`docker build -t room-blend . && docker run -p 8080:8080 -v rb-data:/data room-blend`), Render (`render.yaml`), or Fly.io (`fly.toml`). Put the data folder on a volume. See the README section "Free ways to run it".
- **Render, free:** push the folder to a GitHub repo, then on render.com choose New, Blueprint, and pick the repo (`render.yaml` is included). Set `PUBLIC_URL` to the `https://your-name.onrender.com` address Render gives you. Limits of the free plan: it sleeps after 15 minutes with no incoming requests and takes about a minute to wake; it has no persistent disk, so a restart or redeploy forgets every room (hosts start a new one); it can be restarted at any time; and 750 free hours a month is enough for one always-on service. The host page sends a small request every 5 minutes while open, so a room in use stays awake. The first visitor after a sleep waits about a minute. Spotify login will not work on the Render address (Spotify only allows `127.0.0.1` over plain http), so use YouTube, files or manual mode there, or open the host page through your own HTTPS address with your Spotify app set up for it.
- Set `TRUST_PROXY=1` only when a proxy sits in front of Node. Leave it off when Node is reached directly, or visitors could fake their address.

## Settings reference

| Setting | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | Port to listen on. |
| `PUBLIC_URL` | the browser's address | Address friends should open. Needed on a home network and behind tunnels. |
| `TRUST_PROXY` | off | Use the proxy's visitor address. |
| `MAX_ROOMS`, `ROOMS_PER_IP_HOUR`, `DATA_DIR` | see above | Capacity and storage. |
| `SPOTIFY_CLIENT_ID` | none | A shared Spotify app, only if you have extended access. |
| `DISCONNECT_GRACE_MS` | 180000 | How long a dropped connection stays counted. |
| `DOZE_DEFAULT_MIN` | 30 | Minutes a locked phone stays counted. |
| `AWAY_REMOVE_MS` | 900000 | Away from the Wi-Fi this long: removed. |
| `IDLE_ASK_S` | 3600 | Seconds without a touch before asking "still here?". |
| `IDLE_ANSWER_MS` | 300000 | Time to answer before the guest sits out. |
