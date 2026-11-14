# DuoTune Node API migration

This package moves DuoTune's two Supabase Edge Functions into a standalone Node.js 20+ API while preserving the request/response contracts used by the existing frontend.

## What moved

| Old Supabase Edge Function | New Node API route |
| --- | --- |
| `duotune-login` | `POST /api/auth/login` |
| `duotune-youtube` | `POST /api/youtube` (now powered by YouTube Music InnerTube) |

Both routes verify the caller's Supabase access token before doing any work. Login keeps the existing Kiran/Pooja identity rules and `duotune_rooms` / `duotune_room_members` writes. Search and public playlist import now use the YouTube Music InnerTube client (`youtubei.js`) and are normalized into the exact response shape the current frontend expects. Search and playlist metadata are cached in memory for three minutes; playlist import remains capped at 500 items.

## What intentionally stays on Supabase

The frontend still uses the existing Supabase project for anonymous Auth/device identity, Realtime Presence + Broadcast, database persistence (history, queue, chat, favorites, playlists, profiles), and avatar Storage. This is deliberate: the uploaded source did not include the database schema/RLS SQL, and replacing those services without their exact schema and policies would risk breaking shared listening or exposing room data.

The existing Edge Functions can remain deployed during the cutover as a rollback path. Do not delete them until the Node API has been deployed and verified.

## 1. Configure the API

Use Node.js 20 or newer.

```bash
cp .env.example .env
npm install
```

Fill in `.env`:

- `SUPABASE_URL`: existing Supabase project URL.
- `SUPABASE_PUBLISHABLE_KEY`: existing Supabase publishable key (the same public key used by the frontend). A legacy anon key also works.
- `SUPABASE_SERVICE_ROLE_KEY`: Supabase service-role secret. Server only, never commit or expose it.
- `DUOTUNE_SHARED_PASSWORD`: the existing shared Kiran/Pooja password. Keep it identical during migration.
- `DUOTUNE_ROOM_CODE`: defaults to `KIRANUU`, matching the uploaded login function.
- `DUOTUNE_ALLOWED_ORIGINS`: comma-separated exact frontend origins. Include `https://duotune.vercel.app` and any development origin you use.

Run locally:

```bash
npm run check
npm start
```

Health check: `http://localhost:3000/health`.

## 2. Deploy the API

Deploy this folder as a Node web service on Render, Railway, Fly.io, or another Node 20 host.

- Build/install command: `npm install`
- Start command: `npm start`
- Health check path: `/health`
- Add every variable from `.env.example` in the host's secret/environment settings.
- Do not upload `.env` or put the service-role key in the frontend.

The API listens on `process.env.PORT` and binds through Express. The in-memory rate limiter is suitable for a single instance; use a shared Redis-backed limiter if you scale the API horizontally. The InnerTube client is initialized lazily and reused for requests. Set `INNERTUBE_LANGUAGE` and `INNERTUBE_LOCATION` if you want a different catalog locale.

## 3. Point the frontend at the API

Use the patched `index.html` in this package. It now calls `/api/auth/login` and `/api/youtube` instead of invoking the two Edge Functions.

By default it uses the same-origin `/api` path. If your API is hosted on a separate domain, set this global **before the main inline app script** in `index.html` (the Supabase CDN script is immediately above that app script):

```html
<script>
  window.DUOTUNE_API_BASE = 'https://YOUR-DUOTUNE-API-HOST';
</script>
```

Use the actual deployed API origin, with no trailing slash. Add your frontend origin to `DUOTUNE_ALLOWED_ORIGINS` on the API host. Then deploy the patched `index.html` to Vercel.

If you instead configure a same-origin reverse proxy from `/api/*` to the Node service, leave the default `/api` value unchanged.

## 4. Smoke test before cutover

1. Open `https://YOUR-API-HOST/health`; expect `{ "ok": true, "service": "duotune-api" }`.
2. Open DuoTune in two separate browser profiles, one for Kiran and one for Pooja.
3. Sign in on both profiles using the existing shared password and avatar flow.
4. Search for a song, add it to the queue, and import a small public YouTube playlist.
5. Verify Presence, shared queue/player sync, chat, favorites, history, playlists, and avatar loading still work. These remain Supabase-backed.
6. Check the API host logs for auth, CORS, or InnerTube response errors.

Do not remove the old Edge Functions until all checks pass on both devices.

## API contract

All API requests require `Authorization: Bearer <Supabase access token>` and `Content-Type: application/json`.

`POST /api/auth/login`

```json
{ "action": "login", "name": "Kiran", "password": "..." }
```

Success response preserves the existing shape: `success`, `name`, `userId`, `roomCode`, `roomId`, `isAdmin`.

`POST /api/youtube`

Search (InnerTube / YouTube Music song search):

```json
{ "action": "search", "query": "song artist", "maxResults": 12 }
```

The response intentionally preserves the legacy `items[].id.videoId` and `items[].snippet` fields so the existing UI, recommendations, and CSV matching do not need a redesign.

Playlist:

```json
{ "action": "playlist", "playlistId": "YOUTUBE_PLAYLIST_ID" }
```

Search returns `{ "items": [...] }`; playlist returns `{ "playlistTitle": "...", "items": [...] }`, matching the current frontend's expectations.

## Rollback

If the new API has an issue, restore the previous `index.html` and redeploy it. The previous Edge Functions are not modified by this package. Keep them and their secrets in place until the new deployment has been verified.

## Music engine scope and important playback note

- **Search and public playlist metadata:** moved from YouTube Data API v3 to YouTube Music InnerTube through `youtubei.js` (MIT). No YouTube Data API key is needed for these routes.
- **Playback:** the YouTube IFrame Player API has been removed. The frontend uses a native `HTMLAudioElement`; the Node API asks `youtubei.js` for a deciphered audio-only format URL and returns it to the authenticated browser session. This is an unofficial integration, not a YouTube-supported web playback SDK, and availability can change. The implementation does not attempt to play private, paid, DRM-protected, or otherwise access-restricted content.
- **Lyrics:** the existing LRCLIB synced-lyrics matcher and UI renderer are retained. LRCLIB supplies line timestamps, so the existing word sweep remains an estimate between line timestamps, not true word-level karaoke timing.
- **UI:** the existing `index.html` design, styles, components, and layout are preserved. Only the API calls from the earlier Node migration remain changed.

This package replaces the custom YouTube Edge Function's search/playlist implementation and retains the already migrated login API. It does **not** replace Supabase Auth, Realtime, Storage, or direct table CRUD. A full Supabase removal would require the exact database schema, RLS policies, Storage bucket policies, and a replacement realtime transport, none of which were included in the uploads.


## Browser-native audio engine (no YouTube IFrame)

The web frontend now uses a native HTMLAudioElement instead of the YouTube IFrame Player API. The Node API exposes the authenticated `POST /api/youtube` action `{ "action": "playback", "videoId": "..." }`, resolves an audio-only format with `youtubei.js`, and returns a short-lived Googlevideo media URL. The browser audio element handles playback, seeking, volume, progress, Media Session metadata/actions, and the existing Supabase room synchronization.

Important operational notes:

- Stream URLs are short-lived and are resolved again for each track load; do not persist them in Supabase or the browser queue.
- InnerTube and stream URL resolution are unofficial and can change or become unavailable without notice. A track can fail if YouTube changes its response, the stream format is unsupported by the browser, or the content is unavailable.
- Browser autoplay restrictions still apply. After a stream resolves, some browsers require the user to tap Play. Background playback and lock-screen behavior vary by browser, operating system, and power policy.
- The backend must be deployed with the updated `src/innertube.js` and `src/routes/youtube.js`; the frontend alone is not enough.
- The Node API requires a valid Supabase bearer session for stream resolution, just like search and playlist import.
- Use this only for publicly playable content you are authorized to access, and in compliance with applicable platform terms and copyright law. No DRM circumvention or private/paid-content access is implemented.

### Playback smoke test

1. Deploy the updated API and verify `GET /health`.
2. Sign in to DuoTune in a supported browser and join the room.
3. Search for a publicly playable track, add it to the queue, then press Play if the browser blocks autoplay.
4. Test pause, seek, volume, next/previous, queue restore, and a second browser joined as the other room member.
5. Check the browser console and API logs for `Audio engine ready`, `/api/youtube` playback errors, and media decode/network errors.
