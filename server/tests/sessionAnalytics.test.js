import { buildSessionAnalytics } from '../src/services/sessionAnalyticsService.js';

const startedAt = new Date('2026-10-21T10:00:00.000Z');
const endedAt = new Date('2026-10-21T10:01:00.000Z');

test('reconciles a manually calculated Lounge session from sequenced durable events', () => {
  const lounge = { startedAt, endedAt, analyticsTrackingVersion: 1 };
  const queueEvents = [
    { seq: 1, type: 'track.added', createdAt: new Date(startedAt.getTime() + 1_000) },
    { seq: 2, type: 'soundclash.opened', payload: { battleId: 'battle-1' }, createdAt: new Date(startedAt.getTime() + 8_000) },
    { seq: 3, type: 'soundclash.opened', payload: { battleId: 'battle-1' }, createdAt: new Date(startedAt.getTime() + 9_000) },
    { seq: 4, type: 'soundclash.resolved', createdAt: new Date(startedAt.getTime() + 10_000) },
  ];
  const metricEvents = [
    { seq: 1, type: 'participant.joined', userId: 'A', participantCount: 1, createdAt: new Date(startedAt.getTime() + 1_000) },
    { seq: 2, type: 'participant.joined', userId: 'B', participantCount: 2, createdAt: new Date(startedAt.getTime() + 2_000) },
    { seq: 3, type: 'participant.left', userId: 'A', participantCount: 1, createdAt: new Date(startedAt.getTime() + 4_000) },
    { seq: 4, type: 'participant.left', userId: 'B', participantCount: 0, createdAt: new Date(startedAt.getTime() + 5_000) },
    { seq: 5, type: 'participant.joined', userId: 'A', participantCount: 1, createdAt: new Date(startedAt.getTime() + 7_000) },
    { seq: 6, type: 'ai.question.asked', userId: 'A', requestId: 'same-request-0001', createdAt: new Date(startedAt.getTime() + 12_000) },
    { seq: 7, type: 'ai.question.asked', userId: 'B', requestId: 'same-request-0001', createdAt: new Date(startedAt.getTime() + 13_000) },
  ];
  const messages = [
    { messageId: 'm1', createdAt: new Date(startedAt.getTime() + 15_000), sentimentScore: 0.2, sentimentBucket: 'negative' },
    { messageId: 'm2', createdAt: new Date(startedAt.getTime() + 25_000), sentimentScore: 0.5, sentimentBucket: 'neutral' },
    { messageId: 'm3', createdAt: new Date(startedAt.getTime() + 35_000), sentimentScore: 0.9, sentimentBucket: 'positive' },
  ];
  // Manual reconciliation: 60s duration; four QueueEvents but one unique battleId;
  // max active set size is 2; the same key from two users is two questions; three timestamped chat samples.
  expect(buildSessionAnalytics({ lounge, queueEvents, metricEvents, messages })).toEqual({
    durationSeconds: 60,
    queueEventCount: 4,
    soundclashBattles: 1,
    chatMessageCount: 3,
    sentimentTimeline: [
      { at: '2026-10-21T10:00:15.000Z', score: 0.2, bucket: 'negative' },
      { at: '2026-10-21T10:00:25.000Z', score: 0.5, bucket: 'neutral' },
      { at: '2026-10-21T10:00:35.000Z', score: 0.9, bucket: 'positive' },
    ],
    peakConcurrentParticipants: 2,
    aiDjQuestionCount: 2,
    unavailableMetrics: {},
  });
});

test('does not manufacture metrics for legacy sessions without event coverage or timestamps', () => {
  const result = buildSessionAnalytics({ lounge: { analyticsTrackingVersion: 0 }, queueEvents: [], metricEvents: [], messages: [] });
  expect(result).toMatchObject({ durationSeconds: null, soundclashBattles: 0, peakConcurrentParticipants: null, aiDjQuestionCount: null });
  expect(result.unavailableMetrics).toMatchObject({
    durationSeconds: expect.any(String),
    peakConcurrentParticipants: expect.any(String),
    aiDjQuestionCount: expect.any(String),
  });
});

test('rejects incomplete battle IDs and flags inconsistent participant counts as unavailable', () => {
  const result = buildSessionAnalytics({
    lounge: { startedAt, endedAt, analyticsTrackingVersion: 1 },
    queueEvents: [{ type: 'soundclash.opened', payload: {}, createdAt: new Date(startedAt.getTime() + 1_000) }],
    metricEvents: [{ seq: 1, type: 'participant.joined', userId: 'A', participantCount: 3, createdAt: new Date(startedAt.getTime() + 1_000) }],
  });
  expect(result.soundclashBattles).toBeNull();
  expect(result.peakConcurrentParticipants).toBeNull();
  expect(result.unavailableMetrics).toMatchObject({
    soundclashBattles: expect.any(String),
  });
});

test('uses persisted sequence for presence ordering and excludes events after session end', () => {
  const result = buildSessionAnalytics({
    lounge: { startedAt, endedAt, analyticsTrackingVersion: 1 },
    metricEvents: [
      { seq: 2, type: 'participant.joined', userId: 'B', participantCount: 2, createdAt: new Date(startedAt.getTime() + 2_000) },
      { seq: 1, type: 'participant.joined', userId: 'A', participantCount: 1, createdAt: new Date(startedAt.getTime() + 1_000) },
      { seq: 3, type: 'participant.joined', userId: 'C', participantCount: 3, createdAt: new Date(endedAt.getTime() + 1_000) },
    ],
  });
  expect(result.peakConcurrentParticipants).toBe(2);
});
