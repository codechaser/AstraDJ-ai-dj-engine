import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { getPodcastCatalog, parsePodcastFeed, resetPodcastCatalogCache } from '../src/services/podcastCatalogService.js';

const feed = `<?xml version="1.0"?><rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel>
  <title>NASA's Curious Universe</title><description>Official NASA science stories.</description>
  <item><title>Real episode</title><description>Episode summary &amp; details.</description><link>https://www.nasa.gov/podcasts/curious-universe/real-episode/</link><pubDate>Tue, 20 Oct 2026 13:40:00 GMT</pubDate><itunes:duration>0:26:47</itunes:duration><guid isPermaLink="false">episode-1</guid><enclosure url="https://traffic.megaphone.fm/episode.mp3" type="audio/mpeg"/></item>
  <item><title>Unsafe enclosure</title><link>https://www.nasa.gov/unsafe/</link><enclosure url="http://example.com/episode.mp3" type="audio/mpeg"/></item>
</channel></rss>`;

describe('podcast catalog service', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = global.fetch; resetPodcastCatalogCache(); });
  afterEach(() => { global.fetch = originalFetch; resetPodcastCatalogCache(); });

  test('parses real episode metadata and excludes non-HTTPS audio', () => {
    const catalog = parsePodcastFeed(feed);
    expect(catalog.items).toHaveLength(1);
    expect(catalog.items[0]).toMatchObject({ podcastId: 'nasa-curious-universe', publisher: 'NASA' });
    expect(catalog.items[0].episodes).toHaveLength(1);
    expect(catalog.items[0].episodes[0]).toMatchObject({
      episodeId: 'episode-1', title: 'Real episode', durationSeconds: 1607,
      audioUrl: 'https://traffic.megaphone.fm/episode.mp3',
    });
    expect(catalog.items[0].episodes[0].description).toBe('Episode summary & details.');
  });

  test('rejects malformed and oversized feeds', () => {
    expect(() => parsePodcastFeed('<rss><channel>')).toThrow(/could not be parsed/i);
    expect(() => parsePodcastFeed('x'.repeat(1_000_001))).toThrow(/too large/i);
  });

  test('uses one fixed official feed request and coalesces concurrent reads into cache', async () => {
    const fetchMock = jest.fn(async () => new Response(feed, { status: 200, headers: { 'content-type': 'application/xml' } }));
    global.fetch = fetchMock;
    const [first, second] = await Promise.all([getPodcastCatalog(), getPodcastCatalog()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0].href).toBe('https://www.nasa.gov/feeds/podcasts/curious-universe');
    expect(first).toEqual(second);
    expect((await getPodcastCatalog()).items[0].episodes[0].episodeId).toBe('episode-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('reports upstream and response-type failures without returning fabricated catalog data', async () => {
    global.fetch = jest.fn(async () => { throw new Error('network unavailable'); });
    await expect(getPodcastCatalog()).rejects.toMatchObject({ status: 502, code: 'PODCAST_SOURCE_UNAVAILABLE' });
    resetPodcastCatalogCache();
    global.fetch = jest.fn(async () => new Response('<html/>', { status: 200, headers: { 'content-type': 'text/html' } }));
    await expect(getPodcastCatalog()).rejects.toMatchObject({ status: 502, code: 'PODCAST_SOURCE_UNAVAILABLE' });
  });

  test('follows only the official NASA redirect to the podcast feed host', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: 'https://feeds.megaphone.fm/nationalaeronauticsandspaceadministration8162188566' } }))
      .mockResolvedValueOnce(new Response(feed, { status: 200, headers: { 'content-type': 'application/xml' } }));
    global.fetch = fetchMock;
    expect((await getPodcastCatalog()).items[0].episodes[0].episodeId).toBe('episode-1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0].hostname).toBe('feeds.megaphone.fm');

    resetPodcastCatalogCache();
    global.fetch = jest.fn(async () => new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } }));
    await expect(getPodcastCatalog()).rejects.toMatchObject({ status: 502, code: 'PODCAST_SOURCE_UNAVAILABLE' });
  });
});
