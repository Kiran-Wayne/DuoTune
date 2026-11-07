import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": Deno.env.get("DUOTUNE_ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

function cleanString(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return respond({ error: "Use POST." }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const youtubeKey = Deno.env.get("YOUTUBE_API_KEY");

    if (!supabaseUrl || !anonKey) {
      return respond({ error: "Supabase function environment is not configured." }, 500);
    }
    if (!youtubeKey) {
      return respond({ error: "YouTube API key is missing. Set the YOUTUBE_API_KEY secret." }, 500);
    }

    // Confirm that the request comes from a signed-in DUOTUNE user.
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return respond({ error: "Sign in to DUOTUNE before using YouTube search." }, 401);
    }
    const supabase = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData, error: authError } = await supabase.auth.getUser();
    if (authError || !userData.user) {
      return respond({ error: "Your DUOTUNE session is invalid. Rejoin the room and try again." }, 401);
    }

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return respond({ error: "Invalid request body." }, 400);

    const action = cleanString(body.action, 20);
    const apiBase = "https://www.googleapis.com/youtube/v3";

    if (action === "search") {
      const query = cleanString(body.query, 180);
      const maxResults = Math.max(1, Math.min(Number(body.maxResults) || 12, 25));
      if (!query) return respond({ error: "Enter a song or artist to search." }, 400);

      const params = new URLSearchParams({
        part: "snippet",
        type: "video",
        q: query,
        maxResults: String(maxResults),
        videoEmbeddable: "true",
        safeSearch: "moderate",
        key: youtubeKey,
      });
      const response = await fetch(`${apiBase}/search?${params}`);
      const data = await response.json();
      if (!response.ok) {
        const message = data?.error?.message || "YouTube search failed.";
        return respond({ error: message }, response.status === 403 ? 429 : 502);
      }
      return respond({ items: data.items ?? [] });
    }

    if (action === "playlist") {
      const playlistId = cleanString(body.playlistId, 120);
      if (!/^[A-Za-z0-9_-]{10,120}$/.test(playlistId)) {
        return respond({ error: "That YouTube playlist ID does not look valid." }, 400);
      }

      const playlistParams = new URLSearchParams({
        part: "snippet",
        id: playlistId,
        key: youtubeKey,
      });
      const playlistResponse = await fetch(`${apiBase}/playlists?${playlistParams}`);
      const playlistData = await playlistResponse.json();
      if (!playlistResponse.ok) {
        return respond(
          { error: playlistData?.error?.message || "Could not read this YouTube playlist." },
          playlistResponse.status === 403 ? 429 : 502,
        );
      }
      const playlistTitle = playlistData.items?.[0]?.snippet?.title;
      if (!playlistTitle) return respond({ error: "Playlist not found or it is private." }, 404);

      const items: unknown[] = [];
      let pageToken = "";
      // Keep the response bounded: enough for a substantial playlist without
      // allowing one request to consume the entire YouTube API quota.
      for (let page = 0; page < 10; page++) {
        const params = new URLSearchParams({
          part: "snippet,contentDetails",
          playlistId,
          maxResults: "50",
          key: youtubeKey,
        });
        if (pageToken) params.set("pageToken", pageToken);

        const response = await fetch(`${apiBase}/playlistItems?${params}`);
        const data = await response.json();
        if (!response.ok) {
          return respond(
            { error: data?.error?.message || "Could not load playlist videos." },
            response.status === 403 ? 429 : 502,
          );
        }
        items.push(...(data.items ?? []));
        pageToken = data.nextPageToken ?? "";
        if (!pageToken) break;
      }
      return respond({ playlistTitle, items });
    }

    return respond({ error: "Unknown action. Use 'search' or 'playlist'." }, 400);
  } catch (error) {
    console.error("[duotune-youtube]", error);
    return respond({ error: "The YouTube service hit an unexpected error. Try again shortly." }, 500);
  }
});
