import { Router } from 'express';
import { requireSupabaseUser } from '../middleware/auth.js';
import { getInnerTube, getPlaybackInnerTube, textValue, toLegacyPlaylistItem, toLegacySearchItem } from '../innertube.js';

const router = Router();
const searchCache = new Map();
const playlistCache = new Map();
const CACHE_TTL = 3 * 60 * 1000;
const MAX_PLAYLIST_ITEMS = 500;

function cleanString(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function cacheGet(cache, key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(cache, key, value) {
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL });
  if (cache.size > 250) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
}

function musicSearchItems(result) {
  const songs = result?.songs?.contents || [];
  const videos = result?.videos?.contents || [];
  const combined = [...songs, ...videos];
  if (combined.length) return combined;

  // Defensive fallback for parser layout changes across YouTube Music responses.
  const sections = result?.contents || [];
  return sections.flatMap((section) => section?.contents || []);
}

router.post('/', requireSupabaseUser, async (req, res) => {
  const action = cleanString(req.body?.action, 20);
  try {
    if (action === 'playback') {
      const videoId = cleanString(req.body?.videoId, 11);
      if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
        return res.status(400).json({ error: 'A valid YouTube video ID is required.' });
      }

      // Resolve a fresh audio-only URL for each play. These URLs are signed and
      // short-lived, so they are deliberately not stored in the search cache.
      const playbackClient = await getPlaybackInnerTube();
      const format = await playbackClient.getStreamingData(videoId, {
        type: 'audio',
        quality: 'best',
      });
      const streamUrl = String(format?.url || '').trim();
      let parsedUrl;
      try { parsedUrl = new URL(streamUrl); } catch { parsedUrl = null; }
      if (!parsedUrl || parsedUrl.protocol !== 'https:' || !parsedUrl.hostname.endsWith('.googlevideo.com')) {
        return res.status(502).json({ error: 'YouTube did not return a usable audio stream for this track.' });
      }

      return res.json({
        videoId,
        url: streamUrl,
        mimeType: String(format?.mime_type || format?.mimeType || ''),
        bitrate: Number(format?.bitrate) || 0,
        contentLength: Number(format?.content_length) || 0,
        duration: Number(format?.approx_duration_ms) / 1000 || 0,
        source: 'innertube-audio',
      });
    }

    const innertube = await getInnerTube();
    const music = innertube.music;

    if (action === 'search') {
      const query = cleanString(req.body?.query, 180);
      const parsedMax = Number(req.body?.maxResults) || 12;
      const maxResults = Math.max(1, Math.min(parsedMax, 25));
      if (!query) return res.status(400).json({ error: 'Enter a song or artist to search.' });

      const cacheKey = `${query.toLocaleLowerCase()}|${maxResults}`;
      const cached = cacheGet(searchCache, cacheKey);
      if (cached) return res.json(cached);

      // YouTube Music InnerTube search, prioritizing song entities rather than
      // generic video results. A general video search is only a fallback.
      let result = await music.search(query, { type: 'song' });
      let items = musicSearchItems(result).map(toLegacySearchItem).filter(Boolean);
      if (!items.length) {
        const videoSearch = await innertube.search(query, { type: 'video' });
        items = (videoSearch?.videos || []).map(toLegacySearchItem).filter(Boolean);
      }

      const response = { items: items.slice(0, maxResults), source: 'innertube' };
      cacheSet(searchCache, cacheKey, response);
      return res.json(response);
    }

    if (action === 'playlist') {
      const playlistId = cleanString(req.body?.playlistId, 120).replace(/^VL/, '');
      if (!/^[A-Za-z0-9_-]{10,120}$/.test(playlistId)) {
        return res.status(400).json({ error: 'That YouTube playlist ID does not look valid.' });
      }

      const cached = cacheGet(playlistCache, playlistId);
      if (cached) return res.json(cached);

      let playlist = await music.getPlaylist(playlistId);
      const playlistTitle = textValue(playlist?.info?.title) || 'YouTube Music playlist';
      const items = [];
      for (let page = 0; playlist && page < 10 && items.length < MAX_PLAYLIST_ITEMS; page += 1) {
        const pageItems = playlist.items || playlist.videos || [];
        items.push(...pageItems.map(toLegacyPlaylistItem).filter(Boolean));
        if (!playlist.has_continuation || items.length >= MAX_PLAYLIST_ITEMS) break;
        playlist = await playlist.getContinuation();
      }

      if (!items.length) {
        return res.status(404).json({ error: 'No playable public tracks were found in that playlist.' });
      }
      const response = { playlistTitle, items: items.slice(0, MAX_PLAYLIST_ITEMS), source: 'innertube' };
      cacheSet(playlistCache, playlistId, response);
      return res.json(response);
    }

    return res.status(400).json({ error: "Unknown action. Use 'search', 'playlist' or 'playback'." });
  } catch (error) {
    console.error('[innertube] request failed:', error);
    const status = /private|unavailable|not found/i.test(error.message || '') ? 404 : 502;
    return res.status(status).json({
      error: error.name === 'TimeoutError'
        ? 'YouTube Music took too long to respond. Try again shortly.'
        : action === 'playback'
        ? 'Could not resolve an audio stream. This track may be unavailable or the source may have changed.'
        : 'YouTube Music search is temporarily unavailable. Please try again.',
    });
  }
});

export default router;
