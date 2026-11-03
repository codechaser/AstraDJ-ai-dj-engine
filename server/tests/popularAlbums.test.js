import { describe, expect, jest, test } from '@jest/globals';
import { createPopularAlbumsService, parsePopularAlbumsFeed } from '../src/services/popularAlbumsService.js';

const payload = {
  feed: {
    title: 'Top Albums',
    updated: 'Mon, 2 Nov 2026 21:48:50 +0000',
    results: [
      { id: 'album-1', kind: 'albums', name: 'Chart Album', artistName: 'Real Artist', releaseDate: '2026-10-30', artworkUrl100: 'https://is1-ssl.mzstatic.com/image/album.jpg', url: 'https://music.apple.com/in/album/chart-album/album-1', genres: [{ name: 'Hindi' }, { name: 'Music' }] },
      { id: 'album-2', kind: 'albums', name: 'Unsafe Artwork', artistName: 'Another Artist', artworkUrl100: 'https://example.com/album.jpg', url: 'https://music.apple.com/in/album/unsafe-artwork/album-2' },
      { id: 'song-1', kind: 'songs', name: 'Not an album', artistName: 'Someone' },
    ],
  },
};

describe('Apple Music popular album chart service', () => {
  test('normalizes real chart metadata, preserves source ranking, and excludes unsafe links', () => {
    expect(parsePopularAlbumsFeed(payload, '2026-11-03T00:00:00.000Z')).toMatchObject({
      source: 'Apple Music India · Most Played Albums',
      storefront: 'in',
      items: [{ albumId: 'album-1', rank: 1, title: 'Chart Album', artistName: 'Real Artist', genres: ['Hindi'] }],
    });
  });

  test('coalesces concurrent chart reads and caches successful responses', async () => {
    const fetchImpl = jest.fn(async () => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }));
    const service = createPopularAlbumsService({ fetchImpl, now: () => Date.parse('2026-11-03T00:00:00.000Z') });
    const [first, second] = await Promise.all([service.getPopularAlbums(), service.getPopularAlbums()]);
    expect(first).toEqual(second);
    expect(first.items[0]).toMatchObject({ title: 'Chart Album', rank: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0].href).toBe('https://rss.applemarketingtools.com/api/v2/in/music/most-played/25/albums.json');
    await service.getPopularAlbums();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('returns explicit source errors instead of fabricated chart entries', async () => {
    const unavailable = createPopularAlbumsService({ fetchImpl: async () => { throw new Error('network down'); } });
    await expect(unavailable.getPopularAlbums()).rejects.toMatchObject({ status: 502, code: 'ALBUM_CHART_UNAVAILABLE' });
    const malformed = createPopularAlbumsService({ fetchImpl: async () => new Response('<html/>', { status: 200, headers: { 'content-type': 'text/html' } }) });
    await expect(malformed.getPopularAlbums()).rejects.toMatchObject({ status: 502, code: 'ALBUM_CHART_UNAVAILABLE' });
  });

  test('follows the official Apple feed redirect and rejects untrusted redirect hosts', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: 'https://rss.marketingtools.apple.com/api/v2/in/music/most-played/25/albums.json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }));
    const service = createPopularAlbumsService({ fetchImpl });
    expect((await service.getPopularAlbums()).items[0].title).toBe('Chart Album');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1][0].hostname).toBe('rss.marketingtools.apple.com');

    const unsafe = createPopularAlbumsService({ fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://example.com/chart.json' } }) });
    await expect(unsafe.getPopularAlbums()).rejects.toMatchObject({ status: 502, code: 'ALBUM_CHART_UNAVAILABLE' });
  });
});
