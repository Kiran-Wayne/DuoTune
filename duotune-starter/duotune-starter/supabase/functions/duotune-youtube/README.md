# DUOTUNE YouTube Edge Function

This function supports the existing DUOTUNE HTML calls:

- `{ action: "search", query, maxResults }` returns `{ items }`
- `{ action: "playlist", playlistId }` returns `{ playlistTitle, items }`

It uses the YouTube Data API v3 key on the server. The key is never placed in the browser HTML.

## 1. Add the secret in Supabase

In Supabase Dashboard, open **Project Settings → Edge Functions → Secrets** and add:

- Name: `YOUTUBE_API_KEY`
- Value: your Google Cloud YouTube Data API v3 key

Do not put this key in the HTML, GitHub, or a public repository. Restrict the key in Google Cloud to **YouTube Data API v3**. Since the key is used server-side, do not add website-referrer restrictions; use API restrictions and any available server-side restrictions instead.

## 2. Deploy

Install the Supabase CLI and sign in, then from the folder containing `supabase/` run:

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase functions deploy duotune-youtube
```

Place this folder at:

```text
supabase/functions/duotune-youtube/
  index.ts
```

The supplied `config.toml` keeps JWT verification enabled.

## 3. Test from DUOTUNE

Deploy the updated DUOTUNE HTML to your HTTPS site, sign in to the room, then try a YouTube search and a YouTube playlist import.

## Notes

- Search is capped at 25 results per request.
- Playlist import reads up to 500 videos per request.
- Private playlists are not accessible through this YouTube API flow.
- YouTube API quota limits still apply. A failed/over-quota request will return an error to DUOTUNE.
- This function verifies that the caller has a valid signed-in Supabase user. It does not change room membership or database tables.
- If you set `DUOTUNE_ALLOWED_ORIGIN`, set it to your exact deployed site origin (for example `https://your-site.vercel.app`). Leave it unset for the default `*` CORS behavior if you use more than one development origin.
