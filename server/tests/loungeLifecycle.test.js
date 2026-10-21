import { jest } from '@jest/globals';
import { createLoungeLifecycleService } from '../src/services/loungeLifecycleService.js';

function setup() {
  const lounge = {
    loungeId: 'lg_123456789abc', hostUserId: 'host-1', participantIds: ['host-1', 'listener-1'],
    vibeProfile: 'Chill & Focus', status: 'live', createdAt: new Date('2026-10-20T10:00:00Z'),
    startedAt: new Date('2026-10-20T10:02:00Z'), endedAt: null,
  };
  const events = [{ type: 'track.added' }, { type: 'soundclash.opened' }, { type: 'soundclash.resolved' }];
  const messages = [{ createdAt: new Date('2026-10-20T10:03:00Z'), sentimentScore: 0.8, sentimentBucket: 'positive' }];
  const model = {
    findOne: () => ({ lean: async () => structuredClone(lounge) }),
    findOneAndUpdate: (_filter, update) => {
      if (lounge.status === 'ended') return { lean: async () => null };
      Object.assign(lounge, update.$set);
      return { lean: async () => structuredClone(lounge) };
    },
    find: jest.fn(() => ({
      sort() { return this; }, limit() { return this; }, select() { return this; },
      lean: async () => [structuredClone(lounge)],
    })),
  };
  const repository = {
    listQueueEvents: async () => events,
    listSentimentMessages: async () => messages,
  };
  return { lounge, model, repository };
}

test('Host ending persists one summary snapshot, computes known metrics, and is idempotent', async () => {
  const { lounge, model, repository } = setup();
  const service = createLoungeLifecycleService({ loungeModel: model, repository, now: () => new Date('2026-10-20T10:12:10Z') });
  const first = await service.end({ loungeId: lounge.loungeId, userId: 'host-1', userRole: 'Host' });
  expect(first.alreadyEnded).toBe(false);
  expect(first.lounge).toMatchObject({
    status: 'ended', endedAt: new Date('2026-10-20T10:12:10Z'),
    sessionSummary: {
      durationSeconds: 610, queueEventCount: 3, soundclashBattles: 1, chatMessageCount: 1,
      sentimentTimeline: [{ score: 0.8, bucket: 'positive' }],
      peakConcurrentParticipants: null, aiDjQuestionCount: null,
    },
  });
  const retry = await service.end({ loungeId: lounge.loungeId, userId: 'host-1', userRole: 'Host' });
  expect(retry.alreadyEnded).toBe(true);
  expect(retry.lounge.endedAt).toEqual(first.lounge.endedAt);
});

test('only the owning Host can end a Lounge', async () => {
  const { lounge, model, repository } = setup();
  const service = createLoungeLifecycleService({ loungeModel: model, repository });
  await expect(service.end({ loungeId: lounge.loungeId, userId: 'listener-1', userRole: 'Listener' }))
    .rejects.toMatchObject({ status: 403, code: 'LOUNGE_HOST_REQUIRED' });
  await expect(service.end({ loungeId: lounge.loungeId, userId: 'other-host', userRole: 'Host' }))
    .rejects.toMatchObject({ status: 403, code: 'LOUNGE_HOST_REQUIRED' });
  await expect(service.end({ loungeId: lounge.loungeId, userId: 'host-1', userRole: 'Admin' }))
    .rejects.toMatchObject({ status: 403, code: 'LOUNGE_HOST_REQUIRED' });
  expect(lounge.status).toBe('live');
});

test('history lists only ended Lounge records for their owner or persisted participants and omits invite/private membership fields', async () => {
  const { lounge, model, repository } = setup();
  lounge.status = 'ended';
  lounge.endedAt = new Date('2026-10-20T10:12:10Z');
  lounge.sessionSummary = { durationSeconds: 610, soundclashBattles: 1 };
  const service = createLoungeLifecycleService({ loungeModel: model, repository });
  const result = await service.historyForUser('listener-1');
  expect(result.items).toHaveLength(1);
  expect(result.items[0]).toMatchObject({ loungeId: lounge.loungeId, role: 'Participant', status: 'ended', summary: lounge.sessionSummary });
  expect(result.items[0]).not.toHaveProperty('inviteCode');
  expect(result.items[0]).not.toHaveProperty('participantIds');
  expect(model.find).toHaveBeenCalledWith(expect.objectContaining({ status: 'ended' }));
});
