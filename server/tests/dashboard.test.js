import { jest } from '@jest/globals';
import { createDashboardService } from '../src/services/dashboardService.js';
import { ApiError } from '../src/utils/ApiError.js';

describe('dashboard history and Lounge analytics', () => {
  const lounge = {
    loungeId: 'lg_123456789abc', hostUserId: 'host-1', participantIds: ['host-1', 'listener-1'],
    status: 'ended', createdAt: new Date('2026-01-01T00:00:00Z'), endedAt: new Date('2026-01-01T00:10:00Z'),
    analyticsTrackingVersion: 0,
  };
  const repo = {
    listInteractionsForUser: jest.fn(async (userId) => [{ _id: 'i-1', trackId: 't_2001', playedSeconds: 40, completed: false, liked: false, createdAt: new Date('2026-01-02T00:00:00Z'), source: 'self_reported' }]),
    findLounge: jest.fn(async () => lounge),
    listQueueEvents: jest.fn(async () => [
      { type: 'track.added' }, { type: 'soundclash.opened', payload: { battleId: 'battle-1' } }, { type: 'soundclash.resolved' },
    ]),
    listSentimentMessages: jest.fn(async () => [
      { createdAt: new Date('2026-01-01T00:01:00Z'), sentimentScore: 1, sentimentBucket: 'positive' },
      { createdAt: new Date('2026-01-01T00:02:00Z'), sentimentScore: 0, sentimentBucket: 'negative' },
    ]),
    listLoungeMetricEvents: jest.fn(async () => []),
  };
  const service = createDashboardService(repo);

  test('returns only caller-scoped listening reports and preserves their provenance', async () => {
    const result = await service.playbackHistory('listener-1', 10);
    expect(repo.listInteractionsForUser).toHaveBeenCalledWith('listener-1', 10);
    expect(result.items).toEqual([expect.objectContaining({ trackId: 't_2001', source: 'self_reported', playedSeconds: 40 })]);
  });

  test('aggregates persisted Lounge sources and reports unavailable metrics explicitly', async () => {
    const result = await service.loungeAnalytics({ loungeId: lounge.loungeId, userId: 'listener-1' });
    expect(result.durationSeconds).toBeNull();
    expect(result.soundclashBattles).toBe(1);
    expect(result.queueEventCount).toBe(3);
    expect(result.chatMessageCount).toBe(2);
    expect(result.sentimentTimeline.map(({ score }) => score)).toEqual([1, 0]);
    expect(result.aiDjQuestionCount).toBeNull();
    expect(result.peakConcurrentParticipants).toBeNull();
  });

  test('blocks non-members from Lounge analytics', async () => {
    await expect(service.loungeAnalytics({ loungeId: lounge.loungeId, userId: 'outsider' }))
      .rejects.toMatchObject({ status: 403, code: 'LOUNGE_MEMBERSHIP_REQUIRED' });
  });

  test('returns an empty history safely and validates limits', async () => {
    repo.listInteractionsForUser.mockResolvedValueOnce([]);
    expect(await service.playbackHistory('listener-1')).toEqual({ items: [] });
    await expect(service.playbackHistory('listener-1', 101)).rejects.toBeInstanceOf(ApiError);
  });
});
