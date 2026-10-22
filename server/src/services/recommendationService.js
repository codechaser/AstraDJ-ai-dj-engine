import { acousticProfileErrors, camelotRelationship } from './acousticMatcher.js';
import { recommendationRepository } from './recommendationRepository.js';
import { ApiError } from '../utils/ApiError.js';

const CO_LISTEN_WINDOW_MS = 10 * 60 * 1000;
const MIN_TASTE_TRACKS = 2;
const clamp = (value) => Math.max(0, Math.min(1, value));
const round = (value) => Number(value.toFixed(4));
const interactionWeight = (interaction, track) => {
  if (!track || acousticProfileErrors(track.acoustic).length || !Number.isFinite(track.durationSeconds) || track.durationSeconds <= 0
    || !Number.isFinite(interaction?.playedSeconds) || interaction.playedSeconds < 0
    || typeof interaction.completed !== 'boolean' || typeof interaction.liked !== 'boolean') return 0;
  if (interaction.liked || interaction.completed) return 1;
  return clamp(interaction.playedSeconds / track.durationSeconds);
};
const plainObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

export function buildAcousticTasteProfile(interactions, trackById) {
  const historyTrackIds = new Set(interactions.map(({ trackId }) => trackId).filter((trackId) => typeof trackId === 'string'));
  const catalogTrackIds = [...historyTrackIds].filter((trackId) => trackById.has(trackId));
  const profiledTrackIds = catalogTrackIds.filter((trackId) => !acousticProfileErrors(trackById.get(trackId)?.acoustic).length);
  const eligibleRows = interactions.map((interaction) => ({
    interaction,
    track: trackById.get(interaction.trackId),
    weight: interactionWeight(interaction, trackById.get(interaction.trackId)),
  })).filter(({ weight }) => weight > 0);

  // Treat multiple reports for one track as one taste signal: keep its strongest
  // observed engagement. This avoids repeat plays or duplicate submissions
  // silently multiplying that track's acoustic features.
  const bestByTrack = new Map();
  for (const row of eligibleRows) {
    const existing = bestByTrack.get(row.track.trackId);
    if (!existing || row.weight > existing.weight) bestByTrack.set(row.track.trackId, row);
  }
  const weighted = [...bestByTrack.values()];
  const coverage = {
    distinctHistoryTracks: historyTrackIds.size,
    catalogTracks: catalogTrackIds.length,
    tracksWithValidAcoustics: profiledTrackIds.length,
    catalogCoverage: historyTrackIds.size ? round(catalogTrackIds.length / historyTrackIds.size) : 0,
    acousticCoverage: catalogTrackIds.length ? round(profiledTrackIds.length / catalogTrackIds.length) : 0,
  };
  const result = {
    status: weighted.length >= MIN_TASTE_TRACKS ? 'ready' : 'insufficient_data',
    minimumDistinctTracks: MIN_TASTE_TRACKS,
    eligibleInteractionCount: eligibleRows.length,
    distinctEligibleTrackCount: weighted.length,
    coverage,
    profile: null,
    explanation: weighted.length >= MIN_TASTE_TRACKS
      ? 'Taste preferences use one strongest eligible signal per distinct track with a valid acoustic profile.'
      : `At least ${MIN_TASTE_TRACKS} distinct tracks with valid acoustic profiles are needed to show preferences.`,
  };
  if (weighted.length < MIN_TASTE_TRACKS) return result;

  const totalWeight = weighted.reduce((sum, row) => sum + row.weight, 0);
  const mean = (field) => weighted.reduce((sum, row) => sum + row.track.acoustic[field] * row.weight, 0) / totalWeight;
  const keys = new Map();
  for (const row of weighted) keys.set(row.track.acoustic.camelotKey, (keys.get(row.track.acoustic.camelotKey) ?? 0) + row.weight);
  const preferredCamelotKeys = [...keys].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, keyWeight]) => ({ key, share: round(keyWeight / totalWeight) }));
  const bpms = weighted.map(({ track }) => track.acoustic.bpm);
  const preferredBpm = mean('bpm');
  const preferredCamelotKey = preferredCamelotKeys[0].key;
  result.profile = {
    bpmRange: { min: Math.min(...bpms), max: Math.max(...bpms) },
    preferredBpm: round(preferredBpm),
    preferredCamelotKeys,
    energy: round(mean('energy')),
    valence: round(mean('valence')),
  };
  result._rankingProfile = { bpm: preferredBpm, camelotKey: preferredCamelotKey, energy: result.profile.energy, valence: result.profile.valence, signalCount: weighted.length };
  return result;
}

export function contentSimilarity(profile, track) {
  if (!profile || acousticProfileErrors(track?.acoustic).length) return null;
  const bpmSimilarity = clamp(1 - Math.abs(track.acoustic.bpm - profile.bpm) / 60);
  const relationship = camelotRelationship(profile.camelotKey, track.acoustic.camelotKey);
  const camelotSimilarity = relationship === 'same' ? 1 : relationship === 'adjacent' ? 0.8 : relationship === 'relative' ? 0.6 : 0;
  const energySimilarity = 1 - Math.abs(track.acoustic.energy - profile.energy);
  const valenceSimilarity = 1 - Math.abs(track.acoustic.valence - profile.valence);
  const score = 0.35 * bpmSimilarity + 0.3 * camelotSimilarity + 0.2 * energySimilarity + 0.15 * valenceSimilarity;
  return {
    score: round(score),
    features: {
      bpmSimilarity: round(bpmSimilarity),
      camelotRelationship: relationship ?? 'clash',
      camelotSimilarity: round(camelotSimilarity),
      energySimilarity: round(energySimilarity),
      valenceSimilarity: round(valenceSimilarity),
    },
  };
}

function positiveTrackWeights(interactions, trackById) {
  const result = new Map();
  for (const interaction of interactions) {
    const track = trackById.get(interaction.trackId);
    const weight = interactionWeight(interaction, track);
    if (weight > 0) result.set(interaction.trackId, Math.max(result.get(interaction.trackId) ?? 0, weight));
  }
  return result;
}

export function precisionAtK(recommendedTrackIds, relevantTrackIds, k = 5) {
  if (!Number.isInteger(k) || k < 1) throw new TypeError('k must be a positive integer');
  const relevant = new Set(relevantTrackIds);
  const top = [...new Set(recommendedTrackIds)].slice(0, k);
  const hits = top.filter((trackId) => relevant.has(trackId)).length;
  return { precision: round(hits / k), hits, denominator: k, recommended: top.length };
}

export function createRecommendationService(repository = recommendationRepository, { now = () => new Date() } = {}) {
  return {
    async acousticTasteForUser(userId) {
      const [tracks, interactions] = await Promise.all([repository.listTracks(), repository.listInteractionsForUser(userId)]);
      const trackById = new Map(tracks.filter((track) => track?.trackId).map((track) => [track.trackId, track]));
      const { _rankingProfile, ...profile } = buildAcousticTasteProfile(interactions, trackById);
      return profile;
    },

    async recordInteraction({ userId, trackId, playedSeconds, completed, liked, loungeId = null }) {
      if (!/^t_[A-Za-z0-9_-]{1,64}$/.test(trackId ?? '') || !Number.isFinite(playedSeconds) || playedSeconds < 0 || typeof completed !== 'boolean' || typeof liked !== 'boolean') {
        throw new ApiError(400, 'VALIDATION_ERROR', 'trackId, non-negative playedSeconds, completed, and liked are required');
      }
      const track = await repository.getTrack(trackId);
      if (!track) throw new ApiError(404, 'TRACK_NOT_FOUND', 'Track not found');
      if (playedSeconds > track.durationSeconds) throw new ApiError(400, 'VALIDATION_ERROR', 'playedSeconds cannot exceed the track duration');
      if (completed && playedSeconds < track.durationSeconds) throw new ApiError(400, 'VALIDATION_ERROR', 'A completed interaction must report the full track duration');

      let lounge = null;
      if (loungeId) {
        if (typeof loungeId !== 'string' || !/^lg_[A-Za-z0-9_-]{8,64}$/.test(loungeId)) throw new ApiError(400, 'VALIDATION_ERROR', 'loungeId is invalid');
        lounge = await repository.findLounge(loungeId);
        if (!lounge) throw new ApiError(404, 'LOUNGE_NOT_FOUND', 'Lounge not found');
        if (!lounge.participantIds?.some((id) => String(id) === String(userId))) throw new ApiError(403, 'LOUNGE_MEMBERSHIP_REQUIRED', 'Join this Lounge before recording a co-listening interaction');
        if (lounge.status !== 'live' || lounge.currentTrackId !== trackId) throw new ApiError(409, 'TRACK_NOT_PLAYING', 'The track must be the current track in a live Lounge');
      }

      const interaction = await repository.createInteraction({ userId, trackId, playedSeconds, completed, liked, loungeId: lounge?.loungeId ?? null, source: 'self_reported' });
      let coListenerIds = [];
      if (lounge) {
        const since = new Date(now().getTime() - CO_LISTEN_WINDOW_MS);
        coListenerIds = await repository.getRecentCoListenerIds({ loungeId: lounge.loungeId, trackId, userId, since });
        await repository.linkCoListeners({ interactionId: interaction._id, loungeId: lounge.loungeId, trackId, userId, coListenerIds, since });
      }
      return { interactionId: String(interaction._id ?? interaction.id), trackId, recordedAt: interaction.createdAt, source: 'self_reported', coListenerCount: coListenerIds.length };
    },

    async recommendForUser(userId, limit = 10) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new ApiError(400, 'VALIDATION_ERROR', 'limit must be an integer between 1 and 20');
      const [tracks, ownInteractions] = await Promise.all([repository.listTracks(), repository.listInteractionsForUser(userId)]);
      const uniqueTracks = [...new Map(tracks.filter((track) => track?.trackId).map((track) => [track.trackId, track])).values()];
      const trackById = new Map(uniqueTracks.map((track) => [track.trackId, track]));
      const profile = buildAcousticTasteProfile(ownInteractions, trackById)._rankingProfile;
      const seenTrackIds = new Set(ownInteractions.map((interaction) => interaction.trackId));
      const coListenerCounts = new Map();
      for (const interaction of ownInteractions) for (const peerId of interaction.coListenedWith ?? []) {
        const id = String(peerId);
        if (id !== String(userId)) coListenerCounts.set(id, (coListenerCounts.get(id) ?? 0) + 1);
      }
      const collaboratorIds = [...coListenerCounts.keys()];
      const collaboratorInteractions = await repository.listInteractionsForUsers(collaboratorIds);
      const collaborativeByTrack = new Map();
      const eligiblePeers = new Set();
      const grouped = new Map();
      for (const interaction of collaboratorInteractions) {
        const id = String(interaction.userId);
        if (!coListenerCounts.has(id)) continue;
        const group = grouped.get(id) ?? [];
        group.push(interaction);
        grouped.set(id, group);
      }
      for (const [id, peerInteractions] of grouped) {
        const positives = positiveTrackWeights(peerInteractions, trackById);
        if (positives.size >= 2) eligiblePeers.add(id);
        else continue;
        const peerWeight = coListenerCounts.get(id);
        for (const [trackId, engagement] of positives) {
          if (seenTrackIds.has(trackId)) continue;
          const entry = collaborativeByTrack.get(trackId) ?? { weighted: 0, weight: 0, neighbors: new Set() };
          entry.weighted += engagement * peerWeight;
          entry.weight += peerWeight;
          entry.neighbors.add(id);
          collaborativeByTrack.set(trackId, entry);
        }
      }
      const collaborativeAvailable = eligiblePeers.size >= 2;
      const scored = [];
      if (profile) for (const track of uniqueTracks) {
        if (seenTrackIds.has(track.trackId) || acousticProfileErrors(track.acoustic).length) continue;
        const content = contentSimilarity(profile, track);
        const collab = collaborativeByTrack.get(track.trackId);
        const collaborativeScore = collaborativeAvailable ? (collab ? collab.weighted / collab.weight : 0) : null;
        const score = collaborativeScore === null ? content.score : 0.65 * content.score + 0.35 * collaborativeScore;
        scored.push({
          trackId: track.trackId,
          title: track.title,
          artist: track.artist,
          score: round(score),
          reason: collaborativeScore === null
            ? { code: 'ACOUSTIC_SIMILARITY', text: `Matches your listening profile: BPM ${content.features.bpmSimilarity.toFixed(2)}, Camelot ${content.features.camelotRelationship}, energy ${content.features.energySimilarity.toFixed(2)}, valence ${content.features.valenceSimilarity.toFixed(2)}.`, features: content.features }
            : { code: 'HYBRID_SIGNAL', text: `Acoustic similarity plus support from ${collab?.neighbors.size ?? 0} co-listener(s).`, features: content.features, collaborativeScore: round(collaborativeScore), coListenerSupport: collab?.neighbors.size ?? 0 },
          _content: content.score,
        });
      }
      if (!profile && collaborativeAvailable) {
        for (const track of uniqueTracks) {
          if (seenTrackIds.has(track.trackId) || acousticProfileErrors(track.acoustic).length) continue;
          const collab = collaborativeByTrack.get(track.trackId);
          if (!collab) continue;
          const score = collab.weighted / collab.weight;
          scored.push({ trackId: track.trackId, title: track.title, artist: track.artist, score: round(score), reason: { code: 'COLLABORATIVE_SIMILARITY', text: `Engaged with by ${collab.neighbors.size} co-listener(s).`, coListenerSupport: collab.neighbors.size }, _content: 0 });
        }
      }
      scored.sort((a, b) => b.score - a.score || a.trackId.localeCompare(b.trackId));
      const items = scored.slice(0, limit).map(({ _content, ...item }) => item);
      const strategy = !profile && !collaborativeAvailable ? 'cold_start_empty'
        : collaborativeAvailable && profile ? 'hybrid'
          : collaborativeAvailable ? 'collaborative_only'
            : profile ? 'content_based' : 'cold_start_empty';
      return {
        items,
        strategy,
        explanation: strategy === 'cold_start_empty'
          ? 'No usable listening profile or co-listening history is available yet.'
          : strategy === 'content_based'
            ? 'Collaborative history is sparse, so results use acoustic similarity from your reported listening interactions.'
            : 'Recommendations combine acoustic similarity with eligible co-listener interaction signals.',
      };
    },
  };
}

export const recommendationService = createRecommendationService();
