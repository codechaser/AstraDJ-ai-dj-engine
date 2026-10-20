import { CAMELOT_KEYS } from '../models/Track.js';

const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const round = (value, digits = 4) => Number(value.toFixed(digits));

export function acousticProfileErrors(profile) {
  const errors = [];
  if (!profile || typeof profile !== 'object') return ['acoustic profile is required'];
  if (!Number.isFinite(profile.bpm) || profile.bpm < 1 || profile.bpm > 300) errors.push('bpm must be between 1 and 300');
  if (!CAMELOT_KEYS.includes(profile.camelotKey)) errors.push('camelotKey must be a valid Camelot key');
  if (!Number.isFinite(profile.energy) || profile.energy < 0 || profile.energy > 1) errors.push('energy must be between 0 and 1');
  if (!Number.isFinite(profile.valence) || profile.valence < 0 || profile.valence > 1) errors.push('valence must be between 0 and 1');
  return errors;
}

export function camelotRelationship(fromKey, toKey) {
  if (!CAMELOT_KEYS.includes(fromKey) || !CAMELOT_KEYS.includes(toKey)) return null;
  if (fromKey === toKey) return 'same';
  const fromNumber = Number(fromKey.slice(0, -1));
  const toNumber = Number(toKey.slice(0, -1));
  const fromLetter = fromKey.slice(-1);
  const toLetter = toKey.slice(-1);
  if (fromNumber === toNumber && fromLetter !== toLetter) return 'relative';
  if (fromLetter === toLetter && (Math.abs(fromNumber - toNumber) === 1 || Math.abs(fromNumber - toNumber) === 11)) return 'adjacent';
  return null;
}

export function bpmCompatibility(currentBpm, candidateBpm, tolerancePct = 8) {
  if (!Number.isFinite(currentBpm) || currentBpm <= 0 || !Number.isFinite(candidateBpm) || candidateBpm <= 0) return null;
  if (!Number.isFinite(tolerancePct) || tolerancePct < 0 || tolerancePct > 8) return null;
  const targets = [
    { bpm: currentBpm, relation: 'direct', priority: 0 },
    { bpm: currentBpm * 0.5, relation: 'half-time', priority: 1 },
    { bpm: currentBpm * 2, relation: 'double-time', priority: 2 },
  ];
  const matches = targets.map((target) => ({
    ...target,
    deltaPct: Math.abs(candidateBpm - target.bpm) / target.bpm * 100,
  })).filter((target) => target.deltaPct <= tolerancePct + 1e-9)
    .sort((a, b) => a.deltaPct - b.deltaPct || a.priority - b.priority);
  if (!matches.length) return null;
  const { deltaPct, relation } = matches[0];
  return { bpmDeltaPct: round(deltaPct, 2), bpmRelation: relation };
}

const HARMONIC_CLOSENESS = Object.freeze({ same: 1, adjacent: 0.8, relative: 0.6 });

export function matchSegueCandidate(currentTrack, candidateTrack, {
  currentSentimentScore = 0.5,
  recentTrackIds = [],
  recentWindow = 5,
  bpmTolerancePct = 8,
} = {}) {
  const currentErrors = acousticProfileErrors(currentTrack?.acoustic);
  const candidateErrors = acousticProfileErrors(candidateTrack?.acoustic);
  if (currentErrors.length || candidateErrors.length) return { eligible: false, reasonCode: 'INVALID_ACOUSTIC_PROFILE', currentErrors, candidateErrors };
  if (!Number.isFinite(currentSentimentScore) || currentSentimentScore < 0 || currentSentimentScore > 1) return { eligible: false, reasonCode: 'INVALID_SENTIMENT_SCORE' };
  if (!Number.isInteger(recentWindow) || recentWindow < 0) return { eligible: false, reasonCode: 'INVALID_RECENT_WINDOW' };

  const bpm = bpmCompatibility(currentTrack.acoustic.bpm, candidateTrack.acoustic.bpm, bpmTolerancePct);
  if (!bpm) return { eligible: false, reasonCode: 'BPM_INCOMPATIBLE' };
  const camelotRelation = camelotRelationship(currentTrack.acoustic.camelotKey, candidateTrack.acoustic.camelotKey);
  if (!camelotRelation) return { eligible: false, reasonCode: 'CAMELOT_INCOMPATIBLE' };

  // Neutral sentiment preserves current energy; positive/negative sentiment nudges
  // the target up/down by at most 0.2 on the normalized energy scale.
  const targetEnergy = clamp(currentTrack.acoustic.energy + (currentSentimentScore - 0.5) * 0.4);
  const energyFit = clamp(1 - Math.abs(candidateTrack.acoustic.energy - targetEnergy));
  const harmonicCloseness = HARMONIC_CLOSENESS[camelotRelation];
  const recentlyPlayed = recentTrackIds.slice(0, recentWindow).includes(candidateTrack.trackId);
  const recencyScore = recentlyPlayed ? 0 : 1;
  const score = 0.5 * harmonicCloseness + 0.3 * energyFit + 0.2 * recencyScore;
  const selectionReason = `${camelotRelation} Camelot match; ${bpm.bpmRelation} tempo at ${bpm.bpmDeltaPct}% delta; energy fit ${round(energyFit, 3)}; ${recentlyPlayed ? `played in the last ${recentWindow} tracks` : 'not in the recent-track window'}; weighted score ${round(score, 4)} (50% harmonic, 30% energy, 20% recency).`;

  return {
    eligible: true,
    bpmDeltaPct: bpm.bpmDeltaPct,
    bpmRelation: bpm.bpmRelation,
    camelotRelation,
    harmonicCloseness,
    targetEnergy: round(targetEnergy, 3),
    energyFit: round(energyFit, 3),
    recencyScore,
    score: round(score, 4),
    selectionReason,
  };
}

export function rankSegueCandidates(currentTrack, candidates, options = {}) {
  const recentTrackIds = options.recentTrackIds ?? [];
  const recentWindow = options.recentWindow ?? 5;
  const results = candidates.map((candidate, index) => ({
    track: candidate,
    inputOrder: index,
    match: matchSegueCandidate(currentTrack, candidate, { ...options, recentTrackIds, recentWindow }),
  }));
  const eligible = results.filter((result) => result.match.eligible)
    .sort((a, b) => b.match.score - a.match.score || a.inputOrder - b.inputOrder);
  return { eligible, rejected: results.filter((result) => !result.match.eligible) };
}
