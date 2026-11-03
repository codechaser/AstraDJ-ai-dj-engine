import {
  acousticProfileErrors,
  bpmCompatibility,
  camelotRelationship,
  matchSegueCandidate,
  rankSegueCandidates,
} from '../src/services/acousticMatcher.js';
import { seedTracks } from '../src/seed/tracks.js';

const track = (trackId, bpm, camelotKey, energy = 0.5, valence = 0.5) => ({
  trackId,
  title: trackId,
  artist: 'Test Artist',
  acoustic: { bpm, camelotKey, energy, valence },
});

describe('acoustic profile and Camelot validation', () => {
  test('accepts energy and valence boundary values and rejects invalid acoustic values', () => {
    expect(acousticProfileErrors({ bpm: 1, camelotKey: '12B', energy: 0, valence: 1 })).toEqual([]);
    expect(acousticProfileErrors({ bpm: 0, camelotKey: '13A', energy: -0.01, valence: 1.01 })).toHaveLength(4);
    expect(acousticProfileErrors({ bpm: 301, camelotKey: '8A', energy: NaN, valence: 0.5 })).toHaveLength(2);
  });

  test('allows same-key, adjacent, opposite-letter and 12-to-1 wrap relationships only', () => {
    expect(camelotRelationship('8A', '8A')).toBe('same');
    expect(camelotRelationship('8A', '9A')).toBe('adjacent');
    expect(camelotRelationship('8A', '8B')).toBe('relative');
    expect(camelotRelationship('12A', '1A')).toBe('adjacent');
    expect(camelotRelationship('1B', '12B')).toBe('adjacent');
    expect(camelotRelationship('8A', '9B')).toBeNull();
    expect(camelotRelationship('13A', '1A')).toBeNull();
  });
});

describe('BPM matching', () => {
  test('accepts the inclusive plus/minus 8 percent boundary and rejects values beyond it', () => {
    expect(bpmCompatibility(120, 129.6)).toMatchObject({ bpmDeltaPct: 8, bpmRelation: 'direct' });
    expect(bpmCompatibility(120, 110.4)).toMatchObject({ bpmDeltaPct: 8, bpmRelation: 'direct' });
    expect(bpmCompatibility(120, 129.61)).toBeNull();
    expect(bpmCompatibility(120, 110.39)).toBeNull();
  });

  test('accepts half-time and double-time multiples within the same tolerance', () => {
    expect(bpmCompatibility(120, 60)).toMatchObject({ bpmDeltaPct: 0, bpmRelation: 'half-time' });
    expect(bpmCompatibility(120, 240)).toMatchObject({ bpmDeltaPct: 0, bpmRelation: 'double-time' });
    expect(bpmCompatibility(120, 64.8)).toMatchObject({ bpmDeltaPct: 8, bpmRelation: 'half-time' });
    expect(bpmCompatibility(120, 259.2)).toMatchObject({ bpmDeltaPct: 8, bpmRelation: 'double-time' });
    expect(bpmCompatibility(120, 64.81)).toBeNull();
    expect(bpmCompatibility(120, 259.21)).toBeNull();
  });

  test('rejects invalid BPM and tolerance inputs', () => {
    expect(bpmCompatibility(0, 120)).toBeNull();
    expect(bpmCompatibility(120, 0)).toBeNull();
    expect(bpmCompatibility(120, 120, 8.01)).toBeNull();
  });
});

describe('segue eligibility and scoring', () => {
  test('rejects incompatible candidates and malformed candidate profiles', () => {
    const current = track('t_current', 120, '8A');
    expect(matchSegueCandidate(current, track('t_clash', 120, '9B')).reasonCode).toBe('CAMELOT_INCOMPATIBLE');
    expect(matchSegueCandidate(current, track('t_slow', 90, '8A')).reasonCode).toBe('BPM_INCOMPATIBLE');
    expect(matchSegueCandidate(current, track('t_bad', 120, '13A')).reasonCode).toBe('INVALID_ACOUSTIC_PROFILE');
  });

  test('uses deterministic weighted harmonic, sentiment-energy and recency scores', () => {
    const current = track('t_current', 120, '8A', 0.5);
    const sameKey = track('t_same', 120, '8A', 0.5);
    const adjacent = track('t_adjacent', 120, '9A', 0.5);
    const match = matchSegueCandidate(current, sameKey, { currentSentimentScore: 0.5 });
    expect(match).toMatchObject({ harmonicCloseness: 1, energyFit: 1, recencyScore: 1, score: 1 });
    const ranked = rankSegueCandidates(current, [sameKey, adjacent], {
      currentSentimentScore: 0.5,
      recentTrackIds: ['t_same'],
    });
    // The fresh adjacent candidate's 20% recency advantage outweighs the 10-point harmonic-score gap.
    expect(ranked.eligible[0].track.trackId).toBe('t_adjacent');
    expect(ranked.eligible[1].match.recencyScore).toBe(0);
    expect(ranked.eligible[0].match.selectionReason).toContain('50% harmonic, 30% energy, 20% recency');
  });

  test('clamps sentiment-derived target energy and returns a valid energy fit at feature boundaries', () => {
    const lowCurrent = track('t_low', 120, '8A', 0, 0);
    const highCandidate = track('t_high', 120, '8A', 1, 1);
    const lowSentiment = matchSegueCandidate(lowCurrent, highCandidate, { currentSentimentScore: 0 });
    expect(lowSentiment.targetEnergy).toBe(0);
    expect(lowSentiment.energyFit).toBe(0);
    const highCurrent = track('t_high_current', 120, '8A', 1, 1);
    const highSentiment = matchSegueCandidate(highCurrent, highCandidate, { currentSentimentScore: 1 });
    expect(highSentiment.targetEnergy).toBe(1);
    expect(highSentiment.energyFit).toBe(1);
  });

  test('returns no eligible result when every candidate is incompatible', () => {
    const ranked = rankSegueCandidates(track('t_current', 120, '8A'), [
      track('t_bad_bpm', 90, '8A'),
      track('t_bad_key', 120, '9B'),
    ]);
    expect(ranked.eligible).toHaveLength(0);
    expect(ranked.rejected.map((item) => item.match.reasonCode)).toEqual(['BPM_INCOMPATIBLE', 'CAMELOT_INCOMPATIBLE']);
  });

  test('unverified seed profiles cannot make a catalog track segue-eligible', () => {
    const current = seedTracks.find((item) => item.trackId === 't_cc0_ivory_atlas');
    const candidate = seedTracks.find((item) => item.trackId === 't_cc0_faded_fortress');
    expect(current).toMatchObject({ audioAssetUrl: null, acoustic: null, acousticEvidence: null });
    expect(candidate).toMatchObject({ audioAssetUrl: null, acoustic: null, acousticEvidence: null });
    expect(rankSegueCandidates(current, [candidate]).eligible).toHaveLength(0);
  });

  test('keeps 20 simulated decisions within BPM and Camelot rules', () => {
    const validKeys = ['12A', '11A', '1A', '12B'];
    let decisions = 0;
    let invalidSelections = 0;
    for (let decision = 0; decision < 20; decision += 1) {
      const current = track(`t_current_${decision}`, 120 + (decision % 6), '12A', 0.2 + (decision % 5) * 0.15, 0.5);
      const candidate = track(`t_candidate_${decision}`, current.acoustic.bpm * [1, 0.5, 2][decision % 3], validKeys[decision % validKeys.length], 0.1 + (decision % 8) * 0.1, 0.5);
      const ranked = rankSegueCandidates(current, [
        candidate,
        track(`t_bad_bpm_${decision}`, 90, '12A'),
        track(`t_bad_key_${decision}`, current.acoustic.bpm, '9B'),
      ], { currentSentimentScore: (decision % 11) / 10 });
      decisions += 1;
      if (!ranked.eligible[0] || ranked.eligible[0].track.trackId !== candidate.trackId) invalidSelections += 1;
      expect(ranked.eligible[0].match.bpmDeltaPct).toBeLessThanOrEqual(8);
      expect(['same', 'adjacent', 'relative']).toContain(ranked.eligible[0].match.camelotRelation);
      expect(ranked.rejected).toHaveLength(2);
    }
    expect({ decisions, invalidSelections, compliancePct: (decisions - invalidSelections) / decisions * 100 })
      .toEqual({ decisions: 20, invalidSelections: 0, compliancePct: 100 });
  });
});
