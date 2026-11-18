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
  return Array.isArray(result?.songs?.contents)
    ? result.songs.contents
    : [];
}

router.post('/', requireSupabaseUser, async (req, res) => {
  const action = cleanString(req.body?.action, 20);

  try {
    // ==========================================
    // RECORDING-AWARE LYRICS LOOKUP
    // ==========================================

    if (action === 'lyrics') {
      const title = cleanString(req.body?.title, 180);
      const artist = cleanString(req.body?.artist, 180);
      const album = cleanString(req.body?.album, 180);
      const duration = Math.round(Number(req.body?.duration) || 0);

      if (!title) {
        return res.status(400).json({
          error: 'A song title is required to find lyrics.',
        });
      }

      if (duration < 0 || duration > 3600) {
        return res.status(400).json({
          error: 'Track duration is invalid.',
        });
      }

      const cacheKey = [title, artist, album, duration]
        .map(normalizeTrackText)
        .join('|');

      const cached = cacheGet(lyricsCache, cacheKey);
      if (cached) return res.json(cached);

      const stripNoise = (value) => String(value || '')
        .replace(/[([{].*?[)\]}]/g, ' ')
        .replace(/\b(official|video|audio|lyrics?|lyrical|hd|4k|mv|visuali[sz]er|full song)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      const titleParts = title
        .split(/\s+[-–—:]\s+/)
        .map(stripNoise)
        .filter(Boolean);

      const titleCandidates = [
        ...new Set([
          stripNoise(title),
          ...titleParts,
        ].filter(Boolean)),
      ];

      // Search using song title, artist and movie/album combinations.
      const queries = [
        ...new Set([
          ...titleCandidates,
          ...(artist
            ? titleCandidates.map((t) => `${t} ${artist}`)
            : []),
          ...(album
            ? titleCandidates.map((t) => `${t} ${album}`)
            : []),
          ...(artist && album
            ? titleCandidates.map((t) => `${t} ${artist} ${album}`)
            : []),
        ].map((q) => q.trim()).filter(Boolean)),
      ].slice(0, 8);

      const headers = {
        'User-Agent': 'DuoTune/1.2 (https://github.com/Kiran-Wayne/DuoTune)',
        'Accept': 'application/json',
      };

      const pool = new Map();

      for (const query of queries) {
        const params = new URLSearchParams({ q: query });

        const response = await fetch(
          `https://lrclib.net/api/search?${params}`,
          {
            headers,
            signal: AbortSignal.timeout(10000),
          }
        );

        if (response.status === 429) {
          return res.status(429).json({
            error: 'Lyrics service is rate-limiting requests. Please wait a moment.',
          });
        }

        if (!response.ok) {
          if (response.status >= 500) {
            throw new Error(`LRCLIB returned HTTP ${response.status}`);
          }
          continue;
        }

        const records = await response.json();

        if (Array.isArray(records)) {
          for (const record of records) {
            const key = String(
              record.id ||
              [
                record.trackName,
                record.artistName,
                record.albumName,
                record.duration,
              ].join('|')
            );

            if (!pool.has(key)) {
              pool.set(key, record);
            }
          }
        }
      }

      const scoreTitle = (record) => {
        const found = normalizeTrackText(
          record.trackName || record.name
        );

        if (!found) return 0;

        let score = 0;

        for (const candidate of titleCandidates) {
          const wanted = normalizeTrackText(candidate);
          if (!wanted) continue;

          if (found === wanted) {
            score = Math.max(score, 100);
          } else if (
            found.includes(wanted) ||
            wanted.includes(found)
          ) {
            score = Math.max(
              score,
              Math.min(
                82,
                55 + Math.min(found.length, wanted.length) / 4
              )
            );
          }
        }

        return score;
      };

      const scoreArtist = (record) => {
        const found = normalizeTrackText(record.artistName);
        const wanted = normalizeTrackText(artist);

        if (!wanted || !found) return 0;
        if (found === wanted) return 24;

        if (
          found.includes(wanted) ||
          wanted.includes(found)
        ) {
          return 14;
        }

        return 0;
      };

      const scoreAlbum = (record) => {
        const found = normalizeTrackText(record.albumName);
        const wanted = normalizeTrackText(album);

        if (!wanted || !found) return 0;
        if (found === wanted) return 18;

        if (
          found.includes(wanted) ||
          wanted.includes(found)
        ) {
          return 10;
        }

        return 0;
      };

      const candidates = [...pool.values()]
        .map((record) => {
          const recordDuration = Number(record.duration);

          const durationDifference =
            duration > 0 && Number.isFinite(recordDuration)
              ? Math.abs(recordDuration - duration)
              : null;

          const titleScore = scoreTitle(record);
          const artistScore = scoreArtist(record);
          const albumScore = scoreAlbum(record);

          const durationTolerance =
            duration > 0
              ? Math.max(12, duration * 0.05)
              : Infinity;

          const durationValid =
            durationDifference === null ||
            durationDifference <= durationTolerance;

          const durationScore =
            durationDifference === null
              ? 0
              : Math.max(0, 20 - durationDifference * 1.5);

          return {
            record,
            titleScore,
            artistScore,
            albumScore,
            durationDifference,
            durationValid,
            score:
              titleScore +
              artistScore +
              albumScore +
              durationScore,
          };
        })
        .filter((item) =>
          item.titleScore >= 55 && item.durationValid
        )
        .sort((a, b) => b.score - a.score);

      const best = candidates[0] || null;
      const record = best?.record;

      const syncedLyrics =
        typeof record?.syncedLyrics === 'string'
          ? record.syncedLyrics.trim()
          : '';

      const plainLyrics =
        typeof record?.plainLyrics === 'string'
          ? record.plainLyrics.trim()
          : '';

      const result =
        record && (syncedLyrics || plainLyrics)
          ? {
              found: true,
              synced: Boolean(syncedLyrics),
              hasWordSync: Boolean(record.hasWordSync),
              syncedLyrics: syncedLyrics || null,
              plainLyrics: plainLyrics || null,
              lyrics: syncedLyrics || plainLyrics,
              match: {
                id: record.id,
                title: record.trackName || record.name || '',
                artist: record.artistName || '',
                album: record.albumName || '',
                duration: Number(record.duration) || null,
                durationDifference: best.durationDifference,
              },
              reason: syncedLyrics
                ? null
                : 'Only unsynced lyrics are available for this recording.',
            }
          : {
              found: false,
              synced: false,
              syncedLyrics: null,
              plainLyrics: null,
              reason: 'No sufficiently close lyrics match was found. Try including the movie or album name.',
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

      console.info('[playback diagnostic]', diagnostic);

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

      const result = await music.search(
        query,
        { type: 'song' }
      );

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

      const cached = cacheGet(playlistCache, playlistId);
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
    console.error('[innertube] request failed:', error);

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
