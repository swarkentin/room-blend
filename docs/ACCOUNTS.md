# Host accounts (optional)

Hosts can sign in to **keep** a room. Guests never sign in. With no account, everything works as before.

A signed-in host gets:

- **Rooms that last.** A kept room lives `OWNED_ROOM_DAYS` (default 30) after its last use, not 24 hours.
- **My rooms, on any device.** `GET /api/me/rooms` lists them; `POST /api/me/rooms/:code/reclaim` returns the room's host key so a new browser can take over. `{"rotate": true}` also replaces the key, so a lost or shared device is locked out.
- **One voice in the shared catalogue.** All of one account's rooms count as a single voter (see DATABASE.md), which stops one person from confirming their own lookups with many rooms.

## Provider: Neon Auth (managed Better Auth)

Neon Auth is included free on every Neon plan (the free plan covers 60,000 monthly active users; check neon.com/pricing). It keeps users in your project's `neon_auth` schema, so you own the data. Room Blend needs no extra package: `lib/auth.js` proxies `/api/auth/*` to Neon Auth, and asks it who a session cookie belongs to.

The proxy exists because Neon Auth does not yet support a front end and back end on different domains. Browsers talk only to this server, so the session cookie belongs to your site.

### Turn it on

1. In the Neon console, open the project, then **Auth**, and enable it. Copy the **Auth URL** (an https address).
2. Add your Render address to Neon Auth's **trusted domains**.
3. Email verification and password reset need your own SMTP in production (Neon's shared sender is for testing).
4. In Render, set `AUTH_PROVIDER=neon`, `NEON_AUTH_BASE_URL=<the Auth URL>` and `PUBLIC_URL=https://<your service>`. Behind a proxy that sets `X-Forwarded-For`, also `TRUST_PROXY=1`.
5. Check `/api/me` returns `{"user":null}` and the logs show no `auth.misconfigured`.

Keep `NEON_AUTH_BASE_URL` in Render's environment only, never in the repository.

### Status

The ownership logic is tested against a fake provider, and the proxy against a fake upstream. It has **not** been run against the real Neon Auth service: the first deploy is the first real test. If sign-in misbehaves, the usual causes are a missing trusted domain, a wrong `PUBLIC_URL`, or an unverified email.

The host page has no sign-in screen yet; the API is in place for it.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `AUTH_PROVIDER` | none | `neon` to enable accounts. |
| `NEON_AUTH_BASE_URL` | none | Neon Auth URL (https). |
| `PUBLIC_URL` | request host | The address browsers use; sent upstream as the origin, and allowed for cookie-authenticated writes. |
| `TRUST_PROXY` | off | Trust `X-Forwarded-*` headers. |
| `OWNED_ROOM_DAYS` | 30 | Life of a kept room. |

## Safety notes

- Writes that use the session cookie (claim, reclaim) refuse a foreign `Origin`.
- Claiming also needs the room's host key, so a stranger signed in somewhere cannot take a room.
- A room has at most one owner; another account gets 409 (claim) or 404 (reclaim).
- If the auth provider is down, hosts are simply treated as signed out; rooms keep working.
