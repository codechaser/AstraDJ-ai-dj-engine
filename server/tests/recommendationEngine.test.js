import { createRecommendationService, precisionAtK } from '../src/services/recommendationService.js';

const track = (trackId, { bpm = 120, camelotKey = '8A', energy = 0.7, valence = 0.6, durationSeconds = 100 } = {}) => ({
  trackId, title: trackId, artist: 'Fixture Artist', durationSeconds,
  acoustic: { bpm, camelotKey, energy, valence },
});

function fakeRepository({ tracks = [], interactions = [] } = {}) {
  return {
    tracks,
    interactions,
    async listTracks() { return this.tracks; },
    async listInteractionsForUser(userId) { return this.interactions.filter((row) => String(row.userId) === String(userId)); },
    async listInteractionsForUsers(userIds) { return this.interactions.filter((row) => userIds.includes(String(row.userId))); },
    async getTrack(trackId) { return this.tracks.find((item) => item.trackId === trackId) ?? null; },
    async findLounge() { return null; },
  };
}

const interaction = (userId, trackId, overrides = {}) => ({
  userId, trackId, playedSeconds: 100, completed: true, liked: true, coListenedWith: [], ...overrides,
});

test('content ranking uses acoustic features, excludes seen/invalid/duplicate tracks, and stays deterministic', async () => {
  const tracks = [
    track('seed', { bpm: 120, camelotKey: '8A', energy: 0.7, valence: 0.6 }),
    track('near', { bpm: 124, camelotKey: '9A', energy: 0.72, valence: 0.62 }),
    track('far', { bpm: 190, camelotKey: '2B', energy: 0.1, valence: 0.1 }),
    track('bad', { camelotKey: '99Z' }),
  ];
  const repository = fakeRepository({ tracks: [...tracks, tracks[1]], interactions: [interaction('u1', 'seed')] });
  const service = createRecommendationService(repository);
  const result = await service.recommendForUser('u1', 10);
  expect(result.strategy).toBe('content_based');
  expect(result.items.map((item) => item.trackId)).toEqual(['near', 'far']);
  expect(result.items[0].reason).toMatchObject({ code: 'ACOUSTIC_SIMILARITY', features: { camelotRelationship: 'adjacent' } });
  expect(await service.recommendForUser('u1', 10)).toEqual(result);
});

test('collaborative scores use eligible co-listeners and hybridize with acoustic profile', async () => {
  const tracks = [
    track('seed', { bpm: 120, camelotKey: '8A', energy: 0.7, valence: 0.6 }),
    track('co-favorite', { bpm: 133, camelotKey: '9A', energy: 0.6, valence: 0.5 }),
    track('peer-1-side', { bpm: 170, camelotKey: '3B' }),
    track('peer-2-side', { bpm: 174, camelotKey: '4B' }),
    track('acoustic-match', { bpm: 120, camelotKey: '8A', energy: 0.7, valence: 0.6 }),
  ];
  const interactions = [
    interaction('requester', 'seed', { coListenedWith: ['user-x', 'user-y'] }),
    interaction('user-x', 'co-favorite'), interaction('user-x', 'peer-1-side'),
    interaction('user-y', 'co-favorite'), interaction('user-y', 'peer-2-side'),
  ];
  const service = createRecommendationService(fakeRepository({ tracks, interactions }));
  const result = await service.recommendForUser('requester', 5);
  expect(result.strategy).toBe('hybrid');
  expect(result.items[0]).toMatchObject({ trackId: 'co-favorite', reason: { code: 'HYBRID_SIGNAL', collaborativeScore: 1, coListenerSupport: 2 } });
  expect(JSON.stringify(result)).not.toContain('user-x');
});

test('sparse collaborative history falls back to content and a true cold start returns no invented rail', async () => {
  const tracks = [track('seed'), track('candidate', { bpm: 122, camelotKey: '8A' })];
  const sparse = createRecommendationService(fakeRepository({ tracks, interactions: [
    interaction('u1', 'seed', { coListenedWith: ['only-peer'] }),
    interaction('only-peer', 'candidate'),
  ] }));
  expect((await sparse.recommendForUser('u1')).strategy).toBe('content_based');
  const cold = await createRecommendationService(fakeRepository({ tracks })).recommendForUser('new-user');
  expect(cold).toMatchObject({ strategy: 'cold_start_empty', items: [] });
  expect(cold.explanation).toMatch(/No usable listening profile/);
});

test('held-out synthetic fixture reaches exactly 0.6 Precision@5 without leaking target interactions', async () => {
  const tracks = [
    track('seed-a', { bpm: 120, camelotKey: '8A', energy: 0.7, valence: 0.6 }),
    track('seed-b', { bpm: 122, camelotKey: '8A', energy: 0.72, valence: 0.62 }),
    track('relevant-1', { bpm: 121, camelotKey: '8A', energy: 0.7, valence: 0.6 }),
    track('relevant-2', { bpm: 124, camelotKey: '9A', energy: 0.75, valence: 0.65 }),
    track('relevant-3', { bpm: 118, camelotKey: '7A', energy: 0.68, valence: 0.58 }),
    track('nonrelevant-1', { bpm: 170, camelotKey: '2B', energy: 0.1, valence: 0.1 }),
    track('nonrelevant-2', { bpm: 80, camelotKey: '5B', energy: 0.2, valence: 0.2 }),
  ];
  const trainingInteractions = [interaction('eval-user', 'seed-a'), interaction('eval-user', 'seed-b')];
  const heldOutRelevantTrackIds = ['relevant-1', 'relevant-2', 'relevant-3'];
  expect(trainingInteractions.some((row) => heldOutRelevantTrackIds.includes(row.trackId))).toBe(false);
  const ranked = await createRecommendationService(fakeRepository({ tracks, interactions: trainingInteractions })).recommendForUser('eval-user', 5);
  const result = precisionAtK(ranked.items.map((item) => item.trackId), heldOutRelevantTrackIds, 5);
  console.info(`Synthetic held-out Precision@5: ${result.hits}/${result.denominator} = ${result.precision}`);
  expect(result).toEqual({ precision: 0.6, hits: 3, denominator: 5, recommended: 5 });
});

test('Precision@K counts only the top K positions and validates its cutoff', () => {
  expect(precisionAtK(['a', 'b', 'c', 'd', 'e', 'f'], ['b', 'e', 'f'], 5)).toEqual({ precision: 0.4, hits: 2, denominator: 5, recommended: 5 });
  expect(() => precisionAtK([], [], 0)).toThrow('k must be a positive integer');
});
