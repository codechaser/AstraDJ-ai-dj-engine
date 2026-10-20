import { bucketSentiment, createRoomSentimentService } from '../src/services/roomSentimentService.js';

test('deterministic lexicon assigns positive, neutral, and negative buckets', () => {
  expect(bucketSentiment('This is amazing, love the vibe!')).toBe('positive');
  expect(bucketSentiment('The set is awful and boring')).toBe('negative');
  expect(bucketSentiment('🎧 123 ???')).toBe('neutral');
});

test('empty rooms use the neutral aggregation fallback and Lounge state is isolated', () => {
  const service = createRoomSentimentService();
  expect(service.snapshot('room-a')).toEqual({ rollingScore: 0.5, windowSeconds: 300, sampleSize: 0 });
  service.record('room-a', { sentimentBucket: 'positive' });
  expect(service.snapshot('room-a')).toMatchObject({ rollingScore: 1, sampleSize: 1 });
  expect(service.snapshot('room-b')).toMatchObject({ rollingScore: 0.5, sampleSize: 0 });
});

test('rolling score expires old messages and aggregates the recent window', () => {
  let time = 1_000_000;
  const service = createRoomSentimentService({ windowSeconds: 60, now: () => time });
  service.record('room-a', { sentimentBucket: 'positive' });
  service.record('room-a', { sentimentBucket: 'negative' });
  expect(service.snapshot('room-a')).toMatchObject({ rollingScore: 0.5, sampleSize: 2 });
  time += 61_000;
  expect(service.snapshot('room-a')).toMatchObject({ rollingScore: 0.5, sampleSize: 0 });
});

test('concurrent message ingestion contributes every message exactly once', async () => {
  const service = createRoomSentimentService();
  const values = await Promise.all(Array.from({ length: 100 }, (_, index) => Promise.resolve().then(() => service.record('room-a', { sentimentBucket: index % 2 ? 'negative' : 'positive' }))));
  expect(values.at(-1)).toMatchObject({ rollingScore: 0.5, sampleSize: 100 });
  expect(service.snapshot('room-a').sampleSize).toBe(100);
});
