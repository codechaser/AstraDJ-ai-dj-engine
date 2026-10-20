import { DJLounge } from '../models/DJLounge.js';
import { Track } from '../models/Track.js';
import { ApiError } from '../utils/ApiError.js';
import { acousticProfileErrors, rankSegueCandidates } from './acousticMatcher.js';
import { deterministicTransitionProvider } from './transitionProvider.js';
import { roomSentimentService } from './roomSentimentService.js';

const trackFields = 'trackId title artist durationSeconds acoustic timeline';

export function createSegueService({ loungeModel = DJLounge, trackModel = Track, transitionProvider = deterministicTransitionProvider, sentimentService = roomSentimentService } = {}) {
  return {
    async requestSegue({ loungeId, userId, input }) {
      const lounge = await loungeModel.findOne({ loungeId, status: { $ne: 'ended' } }).lean();
      if (!lounge) throw new ApiError(404, 'LOUNGE_NOT_FOUND', 'Lounge not found or ended');
      if (!lounge.participantIds.some((participantId) => String(participantId) === String(userId))) {
        throw new ApiError(403, 'LOUNGE_MEMBERSHIP_REQUIRED', 'Join this Lounge before requesting an AI segue');
      }
      if (lounge.currentTrackId !== input.currentTrackId) {
        throw new ApiError(409, 'CURRENT_TRACK_MISMATCH', 'currentTrackId must match the Lounge current track');
      }
      const currentTrack = await trackModel.findOne({ trackId: input.currentTrackId }).select(trackFields).lean();
      if (!currentTrack) throw new ApiError(404, 'CURRENT_TRACK_NOT_FOUND', 'The current track does not exist');
      const profileErrors = acousticProfileErrors(currentTrack.acoustic);
      if (profileErrors.length) throw new ApiError(422, 'INVALID_CURRENT_ACOUSTIC_PROFILE', 'Current track has an invalid acoustic profile', profileErrors);
      if (input.currentTs > currentTrack.durationSeconds) throw new ApiError(400, 'CURRENT_TS_OUT_OF_RANGE', 'currentTs cannot exceed the current track duration');

      const uniqueCandidateIds = [...new Set(input.candidateTrackIds)].filter((trackId) => trackId !== currentTrack.trackId);
      const candidateDocuments = uniqueCandidateIds.length
        ? await trackModel.find({ trackId: { $in: uniqueCandidateIds } }).select(trackFields).lean()
        : [];
      const byId = new Map(candidateDocuments.map((track) => [track.trackId, track]));
      const orderedCandidates = uniqueCandidateIds.map((trackId) => byId.get(trackId)).filter(Boolean);
      const roomSentiment = sentimentService.snapshot(loungeId);
      // A minimum of three recent messages avoids overreacting to one short message.
      // Until then use a neutral baseline (0.5), which preserves current track energy.
      const effectiveSentimentScore = roomSentiment.sampleSize >= 3 ? roomSentiment.rollingScore : 0.5;
      const ranked = rankSegueCandidates(currentTrack, orderedCandidates, {
        currentSentimentScore: effectiveSentimentScore,
        recentTrackIds: input.recentTrackIds ?? [],
        recentWindow: 5,
        bpmTolerancePct: lounge.settings?.bpmTolerancePct ?? 8,
      });
      const selected = ranked.eligible[0];
      const generatedAt = new Date().toISOString();
      if (!selected) {
        return {
          selectedTrackId: null,
          matchReason: null,
          transitionScript: null,
          sourceEvents: [],
          generatedAt,
          provider: transitionProvider.name,
          reason: 'NO_COMPATIBLE_CANDIDATE',
        };
      }

      const generated = await transitionProvider.generate({
        currentTrack,
        selectedTrack: selected.track,
        matchReason: selected.match,
        currentTs: input.currentTs,
        currentSentimentScore: effectiveSentimentScore,
      });
      return {
        selectedTrackId: selected.track.trackId,
        matchReason: {
          bpmDeltaPct: selected.match.bpmDeltaPct,
          bpmRelation: selected.match.bpmRelation,
          camelotRelation: selected.match.camelotRelation,
          energyFit: selected.match.energyFit,
          harmonicCloseness: selected.match.harmonicCloseness,
          targetEnergy: selected.match.targetEnergy,
          recencyScore: selected.match.recencyScore,
          score: selected.match.score,
          selectionReason: selected.match.selectionReason,
        },
        transitionScript: generated.transitionScript,
        sourceEvents: generated.sourceEvents,
        generatedAt,
        provider: generated.provider ?? transitionProvider.name,
      };
    },
  };
}

export const segueService = createSegueService();
