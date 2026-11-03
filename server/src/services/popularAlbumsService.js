import { ApiError } from '../utils/ApiError.js';

export const ALBUM_CHART_SOURCE = Object.freeze({
  storefront: 'in',
  title: 'Apple Music India · Most Played Albums',
  feedUrl: 'https://rss.applemarketingtools.com/api/v2/in/music/most-played/25/albums.json',
  sourceUrl: 'https://rss.marketingtools.apple.com/',
});

const MAX_RESPONSE_BYTES = 1_000_000;
const CACHE_TTL_MS = 60 * 60 * 1000;
const APPLE_FEED_HOSTS = new Set(['rss.applemarketingtools.com', 'rss.marketingtools.apple.com']);
const ALLOWED_ARTWORK_HOST = /^(?:is\d+-ssl\.)?mzstatic\.com$|^is\d+-ssl\.mzstatic\.com$/i;

function safeHttps(value, hostCheck) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && hostCheck(url.hostname) ? url.toString() : null;
  } catch { return null; }
}

function cleanText(value, maxLength = 240) {
  return typeof value === 'string' ? value.trim().replace(/[\u0000-\u001f]/g, '').slice(0, maxLength) : '';
}

function isAppleMusicHost(hostname) {
  return hostname === 'music.apple.com' || hostname === 'itunes.apple.com';
}

function isArtworkHost(hostname) {
  return ALLOWED_ARTWORK_HOST.test(hostname);
}

export function parsePopularAlbumsFeed(payload, fetchedAt = new Date().toISOString()) {
  if (!payload || typeof payload !== 'object' || !payload.feed || !Array.isArray(payload.feed.results)) {
    throw new ApiError(502, 'ALBUM_CHART_INVALID', 'Apple’s album chart response was invalid');
  }
  const items = payload.feed.results.slice(0, 25).flatMap((entry, index) => {
    if (!entry || entry.kind !== 'albums') return [];
    const albumId = cleanText(entry.id, 80);
    const title = cleanText(entry.name);
    const artistName = cleanText(entry.artistName);
    const artworkUrl = safeHttps(entry.artworkUrl100, isArtworkHost);
    const appleMusicUrl = safeHttps(entry.url, isAppleMusicHost);
    if (!albumId || !title || !artistName || !artworkUrl || !appleMusicUrl) return [];
    const releaseDate = /^\d{4}-\d{2}-\d{2}$/.test(entry.releaseDate ?? '') ? entry.releaseDate : null;
    const genres = Array.isArray(entry.genres)
      ? entry.genres.map((genre) => cleanText(genre?.name, 80)).filter((name) => name && name !== 'Music').slice(0, 3)
      : [];
    return [{ albumId, rank: index + 1, title, artistName, releaseDate, artworkUrl, appleMusicUrl, genres }];
  });
  if (!items.length) throw new ApiError(502, 'ALBUM_CHART_INVALID', 'Apple’s album chart did not contain usable album records');
  return {
    source: ALBUM_CHART_SOURCE.title,
    sourceUrl: ALBUM_CHART_SOURCE.sourceUrl,
    storefront: ALBUM_CHART_SOURCE.storefront,
    chartUpdatedAt: cleanText(payload.feed.updated, 100) || null,
    fetchedAt,
    items,
  };
}

export function createPopularAlbumsService({ fetchImpl = fetch, now = () => Date.now() } = {}) {
  let cached = null;
  let cachedAt = 0;
  let pending = null;

  async function load() {
    let response;
    let feedUrl = new URL(ALBUM_CHART_SOURCE.feedUrl);
    try {
      for (let redirects = 0; redirects <= 2; redirects += 1) {
        response = await fetchImpl(feedUrl, {
          headers: { Accept: 'application/json' },
          redirect: 'manual',
          signal: AbortSignal.timeout(8_000),
        });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get('location');
        if (!location || redirects === 2) throw new Error('Unexpected album chart redirect');
        const destination = new URL(location, feedUrl);
        if (destination.protocol !== 'https:' || !APPLE_FEED_HOSTS.has(destination.hostname)) {
          throw new Error('Album chart redirected outside verified Apple feed hosts');
        }
        feedUrl = destination;
      }
    } catch {
      throw new ApiError(502, 'ALBUM_CHART_UNAVAILABLE', 'The album chart could not be reached. Try again shortly.');
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!response.ok || !/application\/json/i.test(contentType)) {
      throw new ApiError(502, 'ALBUM_CHART_UNAVAILABLE', 'The album chart source returned an unavailable response');
    }
    let body;
    try { body = await response.text(); }
    catch { throw new ApiError(502, 'ALBUM_CHART_UNAVAILABLE', 'The album chart response could not be read'); }
    if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
      throw new ApiError(502, 'ALBUM_CHART_INVALID', 'The album chart response was too large');
    }
    let payload;
    try { payload = JSON.parse(body); }
    catch { throw new ApiError(502, 'ALBUM_CHART_INVALID', 'The album chart response was not valid JSON'); }
    return parsePopularAlbumsFeed(payload, new Date(now()).toISOString());
  }

  return {
    async getPopularAlbums({ forceRefresh = false } = {}) {
      if (!forceRefresh && cached && now() - cachedAt < CACHE_TTL_MS) return cached;
      if (!pending) {
        pending = load().then((result) => {
          cached = result;
          cachedAt = now();
          return result;
        }).finally(() => { pending = null; });
      }
      return pending;
    },
    clearCache() { cached = null; cachedAt = 0; pending = null; },
  };
}

export const popularAlbumsService = createPopularAlbumsService();
