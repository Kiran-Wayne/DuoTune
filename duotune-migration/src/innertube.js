import { Innertube } from 'youtubei.js';

let clientPromise;
let playbackClientPromise;

/**
 * Shared anonymous InnerTube session for YouTube Music search and public playlist metadata.
 * It does not provide a supported browser audio-only stream resolver.
 */
export function getInnerTube() {
  if (!clientPromise) {
    clientPromise = Innertube.create({
      lang: process.env.INNERTUBE_LANGUAGE || 'en',
      location: process.env.INNERTUBE_LOCATION || 'IN',
      retrieve_player: false,
      enable_session_cache: true,
      generate_session_locally: true,
    }).catch((error) => {
      clientPromise = undefined;
      throw error;
    });
  }
  return clientPromise;
}

export function textValue(value) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (typeof value.text === 'string') return value.text;
  if (typeof value.toString === 'function') {
    const rendered = value.toString();
    if (rendered && rendered !== '[object Object]') return rendered;
  }
  return '';
}

export function bestThumbnail(item) {
  const list = Array.isArray(item?.thumbnails) ? item.thumbnails : [];
  const chosen = [...list].sort((a, b) => (Number(b.width) || 0) - (Number(a.width) || 0))[0];
  return chosen?.url || item?.thumbnail?.url || item?.best_thumbnail?.url || '';
}

export function toLegacySearchItem(item) {
  const videoId = String(item?.id || item?.video_id || item?.videoId || '').trim();
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return null;

  const artists = Array.isArray(item?.artists)
    ? item.artists.map((artist) => textValue(artist?.name || artist)).filter(Boolean)
    : [];
  const artist = artists.join(', ') || textValue(item?.author?.name || item?.author) || 'YouTube Music';
  const title = textValue(item?.title || item?.name) || 'Untitled track';
  const thumbnail = bestThumbnail(item) || `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
  const duration = Number(item?.duration?.seconds || item?.duration_seconds || 0) || 0;

  const album = textValue(item?.album?.name || item?.album || item?.album_name);
  const musicVideoType = textValue(item?.music_video_type || item?.musicVideoType);

  return {
    id: { videoId },
    videoId,
    title,
    artist,
    album,
    duration,
    musicVideoType,
    recording: {
      provider: 'youtube-music',
      videoId,
      title,
      artist,
      album,
      duration,
      musicVideoType,
    },
    snippet: {
      title,
      channelTitle: artist,
      thumbnails: {
        medium: { url: thumbnail },
        default: { url: thumbnail },
      },
    },
    contentDetails: { videoId, duration },
  };
}

export function toLegacyPlaylistItem(item) {
  const videoId = String(item?.video_id || item?.id || item?.videoId || '').trim();
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return null;
  const title = textValue(item?.title || item?.name) || 'YouTube track';
  const artist = textValue(item?.author?.name || item?.author || item?.short_byline_text) || 'YouTube Music';
  const thumbnail = bestThumbnail(item) || `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
  return {
    id: `yt-${videoId}`,
    contentDetails: { videoId },
    snippet: {
      title,
      channelTitle: artist,
      videoOwnerChannelTitle: artist,
      resourceId: { videoId },
      thumbnails: { medium: { url: thumbnail }, default: { url: thumbnail } },
    },
  };
}


/**
 * Separate InnerTube session for audio-format resolution. Player JS is needed
 * here for deciphering signed streaming URLs, so this client retrieves it.
 */
export function getPlaybackInnerTube() {
  if (!playbackClientPromise) {
    playbackClientPromise = Innertube.create({
      lang: process.env.INNERTUBE_LANGUAGE || 'en',
      location: process.env.INNERTUBE_LOCATION || 'IN',
      retrieve_player: true,
      enable_session_cache: true,
      generate_session_locally: true,
    }).catch((error) => {
      playbackClientPromise = undefined;
      throw error;
    });
  }
  return playbackClientPromise;
}

