import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { ApiError } from '../utils/ApiError.js';

export const PODCAST_SOURCE = Object.freeze({
  podcastId: 'nasa-curious-universe',
  title: "NASA's Curious Universe",
  publisher: 'NASA',
  websiteUrl: 'https://www.nasa.gov/podcasts/curious-universe/',
  feedUrl: 'https://www.nasa.gov/feeds/podcasts/curious-universe',
});

const MAX_FEED_BYTES = 1_000_000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const PODCAST_REDIRECT_HOSTS = new Set(['www.nasa.gov', 'feeds.megaphone.fm']);
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseTagValue: false,
  trimValues: true,
  processEntities: true,
});
let cachedCatalog = null;
let cachedAt = 0;
let pendingRequest = null;

function text(value) {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  if (value && typeof value === 'object' && '#text' in value) return text(value['#text']);
  return '';
}

function cleanDescription(value) {
  return text(value).replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ').trim().slice(0, 1200);
}

function parseDuration(value) {
  const raw = text(value);
  if (!raw) return null;
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Math.floor(Number(raw));
  if (!/^\d{1,2}:\d{2}(?::\d{2})?$/.test(raw)) return null;
  return raw.split(':').map(Number).reduce((total, part) => total * 60 + part, 0);
}

function httpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch { return null; }
}

export function parsePodcastFeed(xml) {
  if (typeof xml !== 'string' || Buffer.byteLength(xml, 'utf8') > MAX_FEED_BYTES) {
    throw new ApiError(502, 'PODCAST_FEED_INVALID', 'The podcast feed is unavailable or too large');
  }
  if (XMLValidator.validate(xml) !== true) throw new ApiError(502, 'PODCAST_FEED_INVALID', 'The podcast feed could not be parsed');
  const parsed = parser.parse(xml);
  const channel = parsed?.rss?.channel;
  if (!channel || !Array.isArray(channel.item) && !channel.item) {
    throw new ApiError(502, 'PODCAST_FEED_INVALID', 'The podcast feed did not contain episodes');
  }
  const rawItems = Array.isArray(channel.item) ? channel.item : [channel.item];
  const episodes = rawItems.slice(0, 50).flatMap((item) => {
    const enclosure = Array.isArray(item.enclosure) ? item.enclosure[0] : item.enclosure;
    const mediaType = text(enclosure?.['@_type']);
    const audioUrl = httpsUrl(enclosure?.['@_url']);
    const title = text(item.title);
    if (!audioUrl || !title || (mediaType && !/^audio\//i.test(mediaType))) return [];
    const guid = text(item.guid) || text(item.link) || audioUrl;
    const publishedAt = text(item.pubDate);
    const publishedTimestamp = Date.parse(publishedAt);
    return [{
      episodeId: guid.slice(0, 200),
      title: title.slice(0, 240),
      description: cleanDescription(item['itunes:summary'] ?? item.description),
      publishedAt: Number.isFinite(publishedTimestamp) ? new Date(publishedTimestamp).toISOString() : null,
      durationSeconds: parseDuration(item['itunes:duration']),
      audioUrl,
      episodeUrl: httpsUrl(text(item.link)),
    }];
  });
  if (!episodes.length) throw new ApiError(502, 'PODCAST_FEED_INVALID', 'The podcast feed did not contain playable episodes');
  return {
    items: [{
      ...PODCAST_SOURCE,
      description: cleanDescription(channel.description),
      episodes,
    }],
    fetchedAt: new Date().toISOString(),
  };
}

async function loadCatalog() {
  let response;
  let feedUrl = new URL(PODCAST_SOURCE.feedUrl);
  try {
    for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
      response = await fetch(feedUrl, {
        headers: { Accept: 'application/rss+xml, application/xml, text/xml' },
        signal: AbortSignal.timeout(8_000),
        redirect: 'manual',
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      if (!location || redirectCount === 3) throw new Error('Unexpected podcast feed redirect');
      const destination = new URL(location, feedUrl);
      if (destination.protocol !== 'https:' || !PODCAST_REDIRECT_HOSTS.has(destination.hostname)) {
        throw new Error('Podcast feed redirected outside the verified source hosts');
      }
      feedUrl = destination;
    }
  } catch {
    throw new ApiError(502, 'PODCAST_SOURCE_UNAVAILABLE', 'The podcast feed could not be reached. Try again shortly.');
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!response.ok || !/(application|text)\/(rss\+xml|xml)/i.test(contentType)) {
    throw new ApiError(502, 'PODCAST_SOURCE_UNAVAILABLE', 'The podcast source returned an unavailable response');
  }
  let body;
  try { body = await response.text(); }
  catch { throw new ApiError(502, 'PODCAST_SOURCE_UNAVAILABLE', 'The podcast feed could not be read. Try again shortly.'); }
  if (Buffer.byteLength(body, 'utf8') > MAX_FEED_BYTES) throw new ApiError(502, 'PODCAST_FEED_INVALID', 'The podcast feed is unavailable or too large');
  return parsePodcastFeed(body);
}

export async function getPodcastCatalog({ forceRefresh = false } = {}) {
  if (!forceRefresh && cachedCatalog && Date.now() - cachedAt < CACHE_TTL_MS) return cachedCatalog;
  if (!pendingRequest) {
    pendingRequest = loadCatalog().then((catalog) => {
      cachedCatalog = catalog;
      cachedAt = Date.now();
      return catalog;
    }).finally(() => { pendingRequest = null; });
  }
  return pendingRequest;
}

export function resetPodcastCatalogCache() {
  cachedCatalog = null;
  cachedAt = 0;
  pendingRequest = null;
}
