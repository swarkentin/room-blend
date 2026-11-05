# Room Blend

Music that fits everyone in the room, not just whoever holds the aux cord.

In a shared space, one person's playlist usually wins and everyone else tunes out. With Room Blend, each person picks a few genres on their phone and the room plays songs from what they have in common. When there's no overlap, it takes fair turns so everyone gets heard.

Room Blend only decides what plays next. The host's own music service plays the songs, so there are no streaming accounts to manage and almost nothing to host.

## How it works

1. The host starts a room and says where their music is: Spotify, a folder of files, a Navidrome server, YouTube, or a list they play by hand.
2. Guests scan a QR code and tap up to four genres. No app, no account, and a name is optional.
3. Room Blend picks songs from the overlap, protecting whoever likes the current song least. When there's no overlap, it takes turns.
4. People come and go and the queue adjusts, without reshuffling for a passer-by.

Guests can also join from a short link, from the "Playing near you" list on the same Wi-Fi, or by typing the 5-letter room code.

## Quick start

You need Node 22 or newer. There is nothing to install.

    node server.js

Open <http://127.0.0.1:3000> and press **Start a room**. To let phones on your Wi-Fi join, set `PUBLIC_URL` to your machine's address. [docs/SETUP.md](docs/SETUP.md) walks through it.

With Docker:

    docker build -t room-blend . && docker run -p 8080:8080 -v rb-data:/data room-blend

## Music sources

The host picks one per room. Guests never need any of these.

| Source | What you need |
|---|---|
| Spotify | Premium, and your own free Spotify app (see below) |
| Spotify: my songs | The same, plays from your saved songs |
| My music files | A folder of songs on your computer. Files stay in your browser |
| YouTube | A free Google API key. No Premium or files needed |
| Navidrome / Subsonic | Your own music server |
| Just show the songs | Nothing. You play them yourself |

Apple Music isn't supported yet. Christmas and Halloween are optional picks that only play while someone in the room asks for them.

Each host creates their own Spotify app because Spotify limits development-mode apps to five users and grants wider access only to established products. If you have extended access, set `SPOTIFY_CLIENT_ID` and hosts can use your app instead.

Details on each source, how matching works, and how to add a new one are in [docs/PROVIDERS.md](docs/PROVIDERS.md).

## Documentation

- [docs/SETUP.md](docs/SETUP.md): running it, letting phones join, connecting music, running several rooms, going online, and the [settings reference](docs/SETUP.md#settings-reference)
- [docs/PROVIDERS.md](docs/PROVIDERS.md): [how music sources work](docs/PROVIDERS.md#two-kinds-of-source), [adding one](docs/PROVIDERS.md#adding-a-source), and [genres](docs/PROVIDERS.md#genres)

## Free ways to run it

- **Your laptop plus a Cloudflare Tunnel.** Run `node server.js`, then `cloudflared tunnel --url http://localhost:3000`, and set `PUBLIC_URL` to the tunnel address. Good for trying it with friends tonight.
- **Render free web service.** `render.yaml` is included. The service sleeps when idle, but the host's browser keeps a snapshot and restores the room when it wakes.
- **Oracle Cloud Always Free VM.** Always on, but you manage a small Linux server.
- **Fly.io.** `fly.toml` is included. It asks for a card and costs a few dollars a month.

It needs a long-running server, so serverless platforms like Vercel and Netlify won't work. More in [docs/SETUP.md](docs/SETUP.md#5-when-you-want-it-outside-your-home).

## Privacy

The server only sees song titles, artists and genres. Audio, files and music-service logins stay in the host's browser. Logs don't contain names, picks, room codes or IP addresses.

## Status

Room Blend works end to end: host console, guest page, live queue, big-screen view and the music sources above. It is tested against fakes of Spotify, YouTube and Navidrome, and against real local files. It has not been tried against the real services or with a room full of real guests yet, so expect rough edges. If something breaks, please open an issue.

Spotify is for private listening, so use Room Blend at home or with friends, not in a business.

## License

Apache License 2.0. See [LICENSE](LICENSE).

## Development

    npm test                # engine, tag reader (needs ffmpeg), API
    npm run test:browser    # end-to-end tests. Needs Playwright, ffmpeg and Python OpenCV

Where things live:

    server.js           HTTP, live updates, limits, room recovery
    lib/                engine.js (blending and turns), room.js (room state), built-in song list
    public/             the UI and the music source modules
    docs/               setup and provider guides
    test/               engine, API and browser tests
