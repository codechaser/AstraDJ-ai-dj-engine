import { buildAcousticTasteProfile, createRecommendationService, precisionAtK } from '../src/services/recommendationService.js';
import { runMultiProfileRecommendationEvaluation } from '../src/services/recommendationEvaluation.js';

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
    track('seed-2', { bpm: 122, camelotKey: '8A', energy: 0.72, valence: 0.62 }),
    track('near', { bpm: 124, camelotKey: '9A', energy: 0.72, valence: 0.62 }),
    track('far', { bpm: 190, camelotKey: '2B', energy: 0.1, valence: 0.1 }),
    track('bad', { camelotKey: '99Z' }),
  ];
  const repository = fakeRepository({ tracks: [...tracks, tracks[2]], interactions: [interaction('u1', 'seed'), interaction('u1', 'seed-2')] });
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
    track('seed-2', { bpm: 122, camelotKey: '8A', energy: 0.72, valence: 0.62 }),
    track('co-favorite', { bpm: 133, camelotKey: '9A', energy: 0.6, valence: 0.5 }),
    track('peer-1-side', { bpm: 170, camelotKey: '3B' }),
    track('peer-2-side', { bpm: 174, camelotKey: '4B' }),
    track('acoustic-match', { bpm: 120, camelotKey: '8A', energy: 0.7, valence: 0.6 }),
  ];
  const interactions = [
    interaction('requester', 'seed', { coListenedWith: ['user-x', 'user-y'] }), interaction('requester', 'seed-2'),
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
  const tracks = [track('seed'), track('second-seed', { bpm: 122, camelotKey: '8A' }), track('candidate', { bpm: 123, camelotKey: '8A' })];
  const sparse = createRecommendationService(fakeRepository({ tracks, interactions: [
    interaction('u1', 'seed', { coListenedWith: ['only-peer'] }),
    interaction('u1', 'second-seed'),
    interaction('only-peer', 'candidate'),
  ] }));
  expect((await sparse.recommendForUser('u1')).strategy).toBe('content_based');
  const cold = await createRecommendationService(fakeRepository({ tracks })).recommendForUser('new-user');
  expect(cold).toMatchObject({ strategy: 'cold_start_empty', items: [] });
  expect(cold.explanation).toMatch(/No usable listening profile/);
});

test('profile aggregates persisted acoustic data once per distinct track and exposes coverage', () => {
  const tracks = new Map([
    ['played-a', track('played-a', { bpm: 100, camelotKey: '8A', energy: 0.2, valence: 0.4 })],
    ['played-b', track('played-b', { bpm: 140, camelotKey: '9A', energy: 0.8, valence: 0.9 })],
    ['missing', { ...track('missing'), acoustic: null }],
    ['invalid', track('invalid', { camelotKey: '99Z' })],
    ['skipped', track('skipped')],
  ]);
  const interactions = [
    interaction('user-a', 'played-a', { liked: true, completed: false, playedSeconds: 5 }),
    interaction('user-a', 'played-a', { liked: false, completed: true }),
    interaction('user-a', 'played-b', { liked: false, completed: false, playedSeconds: 50 }),
    interaction('user-a', 'missing'), interaction('user-a', 'invalid'),
    interaction('user-a', 'skipped', { liked: false, completed: false, playedSeconds: 0 }),
  ];
  const result = buildAcousticTasteProfile(interactions, tracks);
  expect(result).toMatchObject({ status: 'ready', eligibleInteractionCount: 3, distinctEligibleTrackCount: 2 });
  expect(result.coverage).toEqual({ distinctHistoryTracks: 5, catalogTracks: 5, tracksWithValidAcoustics: 3, catalogCoverage: 1, acousticCoverage: 0.6 });
  expect(result.profile).toEqual({
    bpmRange: { min: 100, max: 140 }, preferredBpm: 113.3333,
    preferredCamelotKeys: [{ key: '8A', share: 0.6667 }, { key: '9A', share: 0.3333 }],
    energy: 0.4, valence: 0.5667,
  });
  const withoutDuplicate = buildAcousticTasteProfile([interactions[0], interactions[2]], tracks);
  expect(withoutDuplicate.profile).toEqual(result.profile);
});

test('empty and single-track histories return insufficient data and no content-only recommendations', async () => {
  const tracks = [track('single')];
  const service = createRecommendationService(fakeRepository({ tracks, interactions: [interaction('u1', 'single')] }));
  expect(await service.acousticTasteForUser('u1')).toMatchObject({ status: 'insufficient_data', profile: null, distinctEligibleTrackCount: 1 });
  expect(await createRecommendationService(fakeRepository({ tracks })).acousticTasteForUser('new-user')).toMatchObject({ status: 'insufficient_data', profile: null, eligibleInteractionCount: 0 });
  expect((await service.recommendForUser('u1')).strategy).toBe('cold_start_empty');
});

test('taste profile reads are scoped to the requested user', async () => {
  const tracks = [track('a', { bpm: 100 }), track('b', { bpm: 102 }), track('x', { bpm: 180, camelotKey: '2B' }), track('y', { bpm: 182, camelotKey: '3B' })];
  const service = createRecommendationService(fakeRepository({ tracks, interactions: [
    interaction('user-a', 'a'), interaction('user-a', 'b'), interaction('user-b', 'x'), interaction('user-b', 'y'),
  ] }));
  expect((await service.acousticTasteForUser('user-a')).profile.preferredBpm).toBe(101);
  expect((await service.acousticTasteForUser('user-b')).profile.preferredBpm).toBe(181);
});

test('held-out synthetic evaluation compares acoustic ranking with a training-only popularity baseline', async () => {
  const tracks = [
    track('seed-a', { bpm: 120, camelotKey: '8A', energy: 0.7, valence: 0.6 }),
    track('seed-b', { bpm: 122, camelotKey: '8A', energy: 0.72, valence: 0.62 }),
    track('relevant-1', { bpm: 121, camelotKey: '8A', energy: 0.7, valence: 0.6 }),
    track('relevant-2', { bpm: 124, camelotKey: '9A', energy: 0.75, valence: 0.65 }),
    track('relevant-3', { bpm: 118, camelotKey: '7A', energy: 0.68, valence: 0.58 }),
    ...Array.from({ length: 7 }, (_, index) => track(`nonrelevant-${index + 1}`, { bpm: 170 + index, camelotKey: `${index + 1}B`, energy: 0.1, valence: 0.1 })),
  ];
  const trainingInteractions = [interaction('eval-user', 'seed-a'), interaction('eval-user', 'seed-b')];
  const heldOutRelevantTrackIds = ['relevant-1', 'relevant-2', 'relevant-3'];
  expect(trainingInteractions.some((row) => heldOutRelevantTrackIds.includes(row.trackId))).toBe(false);
  const popularityCounts = [
    ...Array.from({ length: 7 }, (_, index) => [`nonrelevant-${index + 1}`, 12 - index]),
    ['relevant-1', 4], ['relevant-2', 3], ['relevant-3', 2],
  ];
  const popularityTraining = popularityCounts.flatMap(([trackId, count]) => Array.from({ length: count }, (_, index) => interaction(`cohort-${trackId}-${index}`, trackId)));
  const ranked = await createRecommendationService(fakeRepository({ tracks, interactions: [...trainingInteractions, ...popularityTraining] })).recommendForUser('eval-user', 5);
  const result = precisionAtK(ranked.items.map((item) => item.trackId), heldOutRelevantTrackIds, 5);
  const popularityRank = [...popularityCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([trackId]) => trackId);
  const baseline = precisionAtK(popularityRank, heldOutRelevantTrackIds, 5);
  expect(result).toEqual({ precision: 0.6, hits: 3, denominator: 5, recommended: 5 });
  expect(baseline).toEqual({ precision: 0, hits: 0, denominator: 5, recommended: 5 });
});

test('multi-profile held-out evaluation keeps input interactions separate from relevance labels', async () => {
  const result = await runMultiProfileRecommendationEvaluation();
  expect(result).toMatchObject({ profiles: 3, totalTrainingInteractions: 6, candidateCount: 30, totalHeldOutRelevantLabels: 9, denominator: 15, acoustic: { hits: 9, precisionAt5: 0.6 }, popularity: { hits: 0, precisionAt5: 0 } });
  expect(result.perUser.every((profile) => profile.candidateCount === 10 && profile.acoustic.hits === 3 && profile.popularity.hits === 0)).toBe(true);
});

test('Precision@K counts only the top K positions and validates its cutoff', () => {
  expect(precisionAtK(['a', 'b', 'c', 'd', 'e', 'f'], ['b', 'e', 'f'], 5)).toEqual({ precision: 0.4, hits: 2, denominator: 5, recommended: 5 });
  expect(() => precisionAtK([], [], 0)).toThrow('k must be a positive integer');
});
