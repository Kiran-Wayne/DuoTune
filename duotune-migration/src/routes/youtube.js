
import { Router } from 'express';
import { requireSupabaseUser } from '../middleware/auth.js';
import {
  getInnerTube,
  getPlaybackInnerTube,
  textValue,
  toLegacyPlaylistItem,
  toLegacySearchItem,
} from '../innertube.js';

const router = Router();

const searchCache = new Map();
const playlistCache = new Map();
const lyricsCache = new Map();

const CACHE_TTL = 3 * 60 * 1000;
const MAX_PLAYLIST_ITEMS = 500;

function cleanString(value, max) {
  return typeof value === 'string'
    ? value.trim().slice(0, max)
    : '';
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
  cache.set(key, {
    value,
    expiresAt: Date.now() + CACHE_TTL,
  });

  if (cache.size > 250) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
}

function normalizeTrackText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function musicSearchItems(result) {
  // Keep discovery music-first: never mix generic YouTube video results into
  // the song search response. The UI expects song entities from YouTube Music.
  return Array.isArray(result?.songs?.contents)
    ? result.songs.contents
    : [];
}

router.post('/', requireSupabaseUser, async (req, res) => {
  const action = cleanString(req.body?.action, 20);

  try {

    // ==========================================
    // STRICT SYNCED LYRICS LOOKUP
    // ==========================================

    if (action === 'lyrics') {
      const title = cleanString(req.body?.title, 180);
      const artist = cleanString(req.body?.artist, 180);
      const album = cleanString(req.body?.album, 180);
      const duration = Math.round(Number(req.body?.duration) || 0);

      if (!title || !artist || duration < 1 || duration > 3600) {
        return res.status(400).json({
          error: 'Exact title, artist and track duration are required for synced lyrics.',
        });
      }

      const cacheKey = [title, artist, album, duration].map(normalizeTrackText).join('|');
      const cached = cacheGet(lyricsCache, cacheKey);
      if (cached) return res.json(cached);

      const params = new URLSearchParams({
        track_name: title,
        artist_name: artist,
        duration: String(duration),
      });
      if (album) params.set('album_name', album);

      const response = await fetch(`https://lrclib.net/api/get?${params}`, {
        headers: {
          'User-Agent': 'DuoTune/1.1 (https://github.com/Kiran-Wayne/DuoTune)',
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(10000),
      });

      if (response.status === 404) {
        const miss = { found: false, synced: false, reason: 'No exact synced-lyrics match was found.' };
        cacheSet(lyricsCache, cacheKey, miss);
        return res.json(miss);
      }
      if (response.status === 429) {
        return res.status(429).json({ error: 'Lyrics service is rate-limiting requests. Please wait a moment.' });
      }
      if (!response.ok) throw new Error(`LRCLIB returned HTTP ${response.status}`);

      const record = await response.json();
      const exactTitle = normalizeTrackText(record.trackName || record.name) === normalizeTrackText(title);
      const exactArtist = normalizeTrackText(record.artistName) === normalizeTrackText(artist);
      const exactAlbum = !album || normalizeTrackText(record.albumName) === normalizeTrackText(album);
      const durationDifference = Math.abs(Number(record.duration) - duration);
      const syncedLyrics = typeof record.syncedLyrics === 'string' ? record.syncedLyrics.trim() : '';
      const exactMatch = exactTitle && exactArtist && exactAlbum && durationDifference <= 2;

      // Never substitute a cover, alternate release, plain lyrics, or a loose title match.
      const result = exactMatch && syncedLyrics
        ? {
            found: true,
            synced: true,
            hasWordSync: Boolean(record.hasWordSync),
            syncedLyrics,
            match: {
              id: record.id,
              title: record.trackName || record.name,
              artist: record.artistName,
              album: record.albumName || '',
              duration: Number(record.duration),
              durationDifference,
            },
          }
        : {
            found: false,
            synced: false,
            reason: !exactMatch
              ? 'Lyrics metadata did not match this exact recording.'
              : 'This recording has no timestamped lyrics.',
          };

      cacheSet(lyricsCache, cacheKey, result);
      return res.json(result);
    }

    // ==========================================
    // TEMPORARY PLAYBACK DIAGNOSTIC
    // ==========================================

    if (action === 'playback') {
      const videoId = cleanString(req.body?.videoId, 11);

      if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
        return res.status(400).json({
          error: 'A valid YouTube video ID is required.',
        });
      }

      const playbackClient = await getPlaybackInnerTube();

      const info = await playbackClient.getBasicInfo(videoId);

      const status = info?.playability_status;

      const formats =
        info?.streaming_data?.adaptive_formats || [];

      const audioFormats = formats.filter((format) =>
        String(format.mime_type || '').startsWith('audio/')
      );

      const diagnostic = {
        videoId,
        playability: status?.status || 'unknown',
        reason: status?.reason || null,
        audioFormats: audioFormats.length,
        totalFormats: formats.length,
      };

      console.info(
        '[playback diagnostic]',
        diagnostic
      );

      return res.json({
        diagnostic: true,
        playability: diagnostic.playability,
        reason: diagnostic.reason,
        audioFormats: diagnostic.audioFormats,
        totalFormats: diagnostic.totalFormats,
      });
    }

    // ==========================================
    // INNER TUBE CLIENT
    // ==========================================

    const innertube = await getInnerTube();
    const music = innertube.music;

    // ==========================================
    // MUSIC SEARCH
    // ==========================================

    if (action === 'search') {
      const query = cleanString(req.body?.query, 180);

      const parsedMax = Number(req.body?.maxResults) || 12;

      const maxResults = Math.max(
        1,
        Math.min(parsedMax, 25)
      );

      if (!query) {
        return res.status(400).json({
          error: 'Enter a song or artist to search.',
        });
      }

      const cacheKey =
        `${query.toLocaleLowerCase()}|${maxResults}`;

      const cached = cacheGet(searchCache, cacheKey);

      if (cached) return res.json(cached);

      // Spotify-style music discovery: ask the YouTube Music song catalog
      // only. An empty song result stays empty instead of falling back to videos.
      const result = await music.search(query, { type: 'song' });
      const items = musicSearchItems(result)
        .map(toLegacySearchItem)
        .filter(Boolean);

      const response = {
        items: items.slice(0, maxResults),
        source: 'youtube-music',
      };

      cacheSet(searchCache, cacheKey, response);

      return res.json(response);
    }

    // ==========================================
    // PLAYLIST IMPORT
    // ==========================================

    if (action === 'playlist') {
      const playlistId = cleanString(
        req.body?.playlistId,
        120
      ).replace(/^VL/, '');

      if (!/^[A-Za-z0-9_-]{10,120}$/.test(playlistId)) {
        return res.status(400).json({
          error: 'That YouTube playlist ID does not look valid.',
        });
      }

      const cached = cacheGet(
        playlistCache,
        playlistId
      );

      if (cached) return res.json(cached);

      let playlist = await music.getPlaylist(playlistId);

      const playlistTitle =
        textValue(playlist?.info?.title) ||
        'YouTube Music playlist';

      const items = [];

      for (
        let page = 0;
        playlist &&
        page < 10 &&
        items.length < MAX_PLAYLIST_ITEMS;
        page += 1
      ) {
        const pageItems =
          playlist.items || playlist.videos || [];

        items.push(
          ...pageItems
            .map(toLegacyPlaylistItem)
            .filter(Boolean)
        );

        if (
          !playlist.has_continuation ||
          items.length >= MAX_PLAYLIST_ITEMS
        ) {
          break;
        }

        playlist = await playlist.getContinuation();
      }

      if (!items.length) {
        return res.status(404).json({
          error: 'No playable public tracks were found in that playlist.',
        });
      }

      const response = {
        playlistTitle,
        items: items.slice(0, MAX_PLAYLIST_ITEMS),
        source: 'innertube',
      };

      cacheSet(playlistCache, playlistId, response);

      return res.json(response);
    }

    // ==========================================
    // INVALID ACTION
    // ==========================================

    return res.status(400).json({
      error: "Unknown action. Use 'search', 'playlist', 'lyrics' or 'playback'.",
    });

  } catch (error) {

    console.error(
      '[innertube] request failed:',
      error
    );

    const status =
      /private|unavailable|not found/i.test(
        error.message || ''
      )
        ? 404
        : 502;

    return res.status(status).json({
      error:
        error.name === 'TimeoutError'
          ? 'YouTube Music took too long to respond. Try again shortly.'
          : action === 'playback'
            ? 'Playback diagnostic failed. Check Render logs.'
            : action === 'lyrics'
              ? 'The lyrics service is temporarily unavailable. Please try again.'
              : 'YouTube Music is temporarily unavailable. Please try again.',
    });
  }
});

export default router;

