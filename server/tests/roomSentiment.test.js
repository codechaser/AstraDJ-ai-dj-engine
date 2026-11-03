import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { bucketSentiment, createRoomSentimentService } from '../src/services/roomSentimentService.js';
import { sentimentLabeledDataset } from './fixtures/sentimentLabeledDataset.js';
import { baselineLexiconClassifier, frozenCurrentSentimentClassifier } from '../scripts/sentimentEvaluation.js';
import { evaluateClassifier } from '../scripts/sentimentEvaluation.js';
import { sentimentDevelopmentDataset } from './fixtures/sentimentDevelopmentDataset.js';
import { sentimentIndependentHeldoutDataset } from './fixtures/sentimentIndependentHeldoutDataset.js';

test('frozen synthetic sentiment diagnostic reports its confusion matrix', () => {
  const labels = ['positive', 'neutral', 'negative'];
  const confusion = Object.fromEntries(labels.map((actual) => [actual, Object.fromEntries(labels.map((predicted) => [predicted, 0]))]));
  for (const { label, text } of sentimentLabeledDataset) confusion[label][baselineLexiconClassifier(text)] += 1;
  const correct = labels.reduce((sum, label) => sum + confusion[label][label], 0);
  expect(sentimentLabeledDataset).toHaveLength(40);
  expect(confusion).toEqual({
    positive: { positive: 10, neutral: 2, negative: 1 },
    neutral: { positive: 1, neutral: 13, negative: 0 },
    negative: { positive: 1, neutral: 3, negative: 9 },
  });
  expect(correct / sentimentLabeledDataset.length).toBe(0.8);
});

test('context rules handle negation, common music slang, and explicit mixed polarity deterministically', () => {
  expect(bucketSentiment('Not bad at all')).toBe('positive');
  expect(bucketSentiment('I am not happy with this')).toBe('negative');
  expect(bucketSentiment('I am not enjoying this set')).toBe('negative');
  expect(bucketSentiment('This is not terrible')).toBe('positive');
  expect(bucketSentiment('This track is sick')).toBe('positive');
  expect(bucketSentiment('That beat slaps')).toBe('positive');
  expect(bucketSentiment('This track kills the mood')).toBe('negative');
  expect(bucketSentiment('The old song was dull, but this one is amazing')).toBe('positive');
  expect(bucketSentiment('The last song was brilliant, but this one is awful')).toBe('negative');
  expect(bucketSentiment('I do not love it, but I do not hate it')).toBe('neutral');
  expect(bucketSentiment("I don't love it, but I don't hate it")).toBe('neutral');
  expect(bucketSentiment('I do not love the previous track; I hate this one')).toBe('negative');
  expect(bucketSentiment('Not happy; I love this')).toBe('neutral');
  expect(bucketSentiment('The last one was great; this is just different')).toBe('neutral');
  expect(bucketSentiment('Maybe accha, maybe nahi; hard to tell')).toBe('neutral');
  expect(bucketSentiment('Nothing special either way')).toBe('neutral');
});

test('sentiment metric helper uses actual rows, predicted columns, and zero-safe class metrics', () => {
  const result = evaluateClassifier([
    { label: 'positive', text: 'a' },
    { label: 'neutral', text: 'b' },
    { label: 'negative', text: 'c' },
  ], (text) => ({ a: 'positive', b: 'positive', c: 'negative' })[text]);
  expect(result.confusionMatrix).toEqual({
    positive: { positive: 1, neutral: 0, negative: 0 },
    neutral: { positive: 1, neutral: 0, negative: 0 },
    negative: { positive: 0, neutral: 0, negative: 1 },
  });
  expect(result.accuracy).toBeCloseTo(2 / 3);
  expect(result.perClass.neutral).toMatchObject({ precision: 0, recall: 0, f1: 0, support: 1 });
});

test('deterministic lexicon assigns positive, neutral, and negative buckets', () => {
  expect(bucketSentiment('This is amazing, love the vibe!')).toBe('positive');
  expect(bucketSentiment('The set is awful and boring')).toBe('negative');
  expect(bucketSentiment('🎧 123 ???')).toBe('neutral');
});

test('development examples cover Hinglish, slang, negation, contrast, short text, and spelling noise', () => {
  expect(sentimentDevelopmentDataset).toHaveLength(36);
  expect(sentimentDevelopmentDataset.every(({ source }) => source === 'developer_authored_synthetic')).toBe(true);
  expect(evaluateClassifier(sentimentDevelopmentDataset, bucketSentiment).accuracy).toBeGreaterThanOrEqual(0.85);
  expect(bucketSentiment('Yeh gaana mast hai')).toBe('positive');
  expect(bucketSentiment('Is gaane mein maza nahi')).toBe('negative');
  expect(bucketSentiment('luv this beattt')).toBe('positive');
  expect(bucketSentiment('Skip this')).toBe('negative');
  expect(bucketSentiment('mid tempo session')).toBe('neutral');
  expect(bucketSentiment('hmm 🤔')).toBe('neutral');
});

test('the independent evaluation fixture is balanced, sourced, and frozen before scoring', () => {
  expect(sentimentIndependentHeldoutDataset).toHaveLength(90);
  expect(sentimentIndependentHeldoutDataset.every(({ source }) => source === 'developer_authored_synthetic')).toBe(true);
  expect(sentimentIndependentHeldoutDataset.filter(({ label }) => label === 'positive')).toHaveLength(30);
  expect(sentimentIndependentHeldoutDataset.filter(({ label }) => label === 'neutral')).toHaveLength(30);
  expect(sentimentIndependentHeldoutDataset.filter(({ label }) => label === 'negative')).toHaveLength(30);
  const fixture = readFileSync(new URL('./fixtures/sentimentIndependentHeldoutDataset.js', import.meta.url));
  expect(createHash('sha256').update(fixture).digest('hex')).toBe('832b0f5ca1fbd62e67b293ddb09ecb33646c97b18cbc86201ec85f7a52519fcb');
  expect(evaluateClassifier(sentimentIndependentHeldoutDataset, frozenCurrentSentimentClassifier).correct).toBe(48);
  expect(evaluateClassifier(sentimentIndependentHeldoutDataset, bucketSentiment)).toMatchObject({
    correct: 69,
    confusionMatrix: {
      positive: { positive: 26, neutral: 4, negative: 0 },
      neutral: { positive: 5, neutral: 25, negative: 0 },
      negative: { positive: 1, neutral: 11, negative: 18 },
    },
    perClass: {
      positive: { precision: 0.8125, recall: 0.8667 },
      neutral: { precision: 0.625, recall: 0.8333 },
      negative: { precision: 1, recall: 0.6 },
    },
  });
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

test('sentiment reconstruction replaces prior state and excludes expired persisted messages', () => {
  let time = Date.parse('2026-01-01T00:10:00.000Z');
  const service = createRoomSentimentService({ windowSeconds: 300, now: () => time });
  const persisted = [
    { createdAt: new Date(time - 60_000), sentimentBucket: 'positive' },
    { createdAt: new Date(time - 120_000), sentimentBucket: 'negative' },
    { createdAt: new Date(time - 301_000), sentimentBucket: 'positive' },
  ];

  expect(service.replace('room-a', persisted)).toMatchObject({ rollingScore: 0.5, sampleSize: 2 });
  expect(service.replace('room-a', persisted)).toMatchObject({ rollingScore: 0.5, sampleSize: 2 });
  expect(service.snapshot('room-b')).toMatchObject({ rollingScore: 0.5, sampleSize: 0 });

  time += 241_000;
  expect(service.replace('room-a', persisted)).toMatchObject({ rollingScore: 0.5, sampleSize: 0 });
});

test('concurrent message ingestion contributes every message exactly once', async () => {
  const service = createRoomSentimentService();
  const values = await Promise.all(Array.from({ length: 100 }, (_, index) => Promise.resolve().then(() => service.record('room-a', { sentimentBucket: index % 2 ? 'negative' : 'positive' }))));
  expect(values.at(-1)).toMatchObject({ rollingScore: 0.5, sampleSize: 100 });
  expect(service.snapshot('room-a').sampleSize).toBe(100);
});
