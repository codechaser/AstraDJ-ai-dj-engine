import { createRecommendationService, precisionAtK } from './recommendationService.js';

const track = (trackId, acoustic) => ({ trackId, title: trackId, artist: 'Synthetic evaluation fixture', durationSeconds: 100, acoustic });
const report = (userId, trackId) => ({ userId, trackId, playedSeconds: 100, completed: true, liked: true, coListenedWith: [] });
const evaluationProfiles = [
  { userId: 'eval-a', bpm: 100, key: '4A', energy: 0.3, valence: 0.4, relevant: ['same', 'adjacent', 'relative'] },
  { userId: 'eval-b', bpm: 120, key: '8A', energy: 0.5, valence: 0.6, relevant: ['same', 'adjacent', 'relative'] },
  { userId: 'eval-c', bpm: 140, key: '12A', energy: 0.7, valence: 0.8, relevant: ['same', 'adjacent', 'relative'] },
];

function createFixtureRepository(tracks, interactions) {
  return {
    async listTracks() { return tracks; },
    async listInteractionsForUser(id) { return interactions.filter((row) => String(row.userId) === String(id)); },
    async listInteractionsForUsers(ids) { return interactions.filter((row) => ids.includes(String(row.userId))); },
  };
}

function relationshipKey(key, relationship) {
  const number = Number(key.slice(0, -1));
  if (relationship === 'same') return key;
  if (relationship === 'adjacent') return `${number === 12 ? 1 : number + 1}A`;
  return `${number}B`;
}

/**
 * Frozen synthetic comparison. Three independent evaluation profiles each have
 * two training seeds and a separate 10-item candidate pool with three manually
 * predeclared relevant IDs. No held-out labels are sent to the ranker.
 */
export async function runMultiProfileRecommendationEvaluation() {
  const perUser = [];
  for (const profile of evaluationProfiles) {
    const tracks = [
      track(`${profile.userId}-seed-1`, { bpm: profile.bpm - 2, camelotKey: profile.key, energy: profile.energy - 0.02, valence: profile.valence - 0.02 }),
      track(`${profile.userId}-seed-2`, { bpm: profile.bpm + 2, camelotKey: profile.key, energy: profile.energy + 0.02, valence: profile.valence + 0.02 }),
    ];
    const relevantTrackIds = profile.relevant.map((relationship, index) => {
      const trackId = `${profile.userId}-heldout-${index + 1}`;
      tracks.push(track(trackId, {
        bpm: profile.bpm + [-4, 0, 4][index], camelotKey: relationshipKey(profile.key, relationship),
        energy: profile.energy + [-0.05, 0, 0.05][index], valence: profile.valence + [-0.05, 0, 0.05][index],
      }));
      return trackId;
    });
    for (let index = 0; index < 7; index += 1) tracks.push(track(`${profile.userId}-nonrelevant-${index + 1}`, {
      bpm: 175 + index, camelotKey: '2B', energy: 0.05, valence: 0.05,
    }));

    const trainingRows = tracks.slice(0, 2).map((item) => report(profile.userId, item.trackId));
    // The popularity baseline receives separate synthetic cohort counts; cohort
    // reports do not contain evaluation-user identity or held-out relevance labels.
    const popularityCounts = tracks.slice(2).map((item, index) => [item.trackId, index < 3 ? 3 - index : 15 - (index - 3)]);
    const cohortRows = popularityCounts.flatMap(([trackId, count]) => Array.from({ length: count }, (_, row) => report(`cohort-${profile.userId}-${trackId}-${row}`, trackId)));
    const ranked = await createRecommendationService(createFixtureRepository(tracks, [...trainingRows, ...cohortRows], profile.userId))
      .recommendForUser(profile.userId, 10);
    const acoustic = precisionAtK(ranked.items.map((item) => item.trackId), relevantTrackIds, 5);
    const popularity = precisionAtK(
      [...popularityCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([trackId]) => trackId), relevantTrackIds, 5,
    );
    perUser.push({ userId: profile.userId, trainingTrackCount: trainingRows.length, candidateCount: tracks.length - trainingRows.length, heldOutRelevantCount: relevantTrackIds.length, acoustic, popularity });
  }
  const denominator = perUser.length * 5;
  const acousticHits = perUser.reduce((sum, result) => sum + result.acoustic.hits, 0);
  const popularityHits = perUser.reduce((sum, result) => sum + result.popularity.hits, 0);
  return {
    profiles: perUser.length,
    totalTrainingInteractions: perUser.reduce((sum, result) => sum + result.trainingTrackCount, 0),
    candidateCount: perUser.reduce((sum, result) => sum + result.candidateCount, 0),
    totalHeldOutRelevantLabels: perUser.reduce((sum, result) => sum + result.heldOutRelevantCount, 0),
    denominator,
    acoustic: { hits: acousticHits, precisionAt5: acousticHits / denominator },
    popularity: { hits: popularityHits, precisionAt5: popularityHits / denominator },
    perUser,
    limitations: 'Synthetic one-shot profiles and manually selected acoustic-neighbor labels; no real interaction ground truth or statistical inference.',
  };
}
