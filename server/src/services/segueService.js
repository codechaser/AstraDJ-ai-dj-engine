import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { DJLounge } from '../models/DJLounge.js';
import { Track } from '../models/Track.js';
import { ApiError } from '../utils/ApiError.js';
import { acousticProfileErrors, rankSegueCandidates } from './acousticMatcher.js';
import { deterministicTransitionProvider } from './transitionProvider.js';
import { buildTrackDocuments } from './metadataRetrievalService.js';
import { roomSentimentService } from './roomSentimentService.js';

const trackFields = 'trackId title artist durationSeconds acoustic timeline';

export function createSegueService({ loungeModel = DJLounge, trackModel = Track, transitionProvider = deterministicTransitionProvider, fallbackProvider = deterministicTransitionProvider, sentimentService = roomSentimentService, onAnnouncement = () => {} } = {}) {
  let announcementPublisher = onAnnouncement;
  return {
    setAnnouncementPublisher(publisher) {
      if (typeof publisher !== 'function') throw new TypeError('announcement publisher must be a function');
      announcementPublisher = publisher;
    },
    async requestSegue({ loungeId, userId, input, includeCommentary = true, announce = true }) {
      const diagnosticsEnabled = process.env.ASTRA_RUNTIME_BENCH_DIAGNOSTICS === 'true';
      const totalStartedAt = performance.now();
      const spansMs = {};
      const finish = (result) => {
        if (!diagnosticsEnabled) return result;
        spansMs.totalServiceMs = Number((performance.now() - totalStartedAt).toFixed(3));
        return { ...result, runtimeDiagnostics: { correlationId: randomUUID(), spansMs } };
      };
      let spanStartedAt = performance.now();
      const lounge = await loungeModel.findOne({ loungeId, status: { $ne: 'ended' } }).lean();
      spansMs.loungeLookupMs = Number((performance.now() - spanStartedAt).toFixed(3));
      if (!lounge) throw new ApiError(404, 'LOUNGE_NOT_FOUND', 'Lounge not found or ended');
      if (!lounge.participantIds.some((participantId) => String(participantId) === String(userId))) {
        throw new ApiError(403, 'LOUNGE_MEMBERSHIP_REQUIRED', 'Join this Lounge before requesting an AI segue');
      }
      if (lounge.currentTrackId !== input.currentTrackId) {
        throw new ApiError(409, 'CURRENT_TRACK_MISMATCH', 'currentTrackId must match the Lounge current track');
      }
      spanStartedAt = performance.now();
      const currentTrack = await trackModel.findOne({ trackId: input.currentTrackId }).select(trackFields).lean();
      spansMs.currentTrackLookupMs = Number((performance.now() - spanStartedAt).toFixed(3));
      if (!currentTrack) throw new ApiError(404, 'CURRENT_TRACK_NOT_FOUND', 'The current track does not exist');
      const profileErrors = acousticProfileErrors(currentTrack.acoustic);
      if (profileErrors.length) throw new ApiError(422, 'INVALID_CURRENT_ACOUSTIC_PROFILE', 'Current track has an invalid acoustic profile', profileErrors);
      if (input.currentTs > currentTrack.durationSeconds) throw new ApiError(400, 'CURRENT_TS_OUT_OF_RANGE', 'currentTs cannot exceed the current track duration');

      const uniqueCandidateIds = [...new Set(input.candidateTrackIds)].filter((trackId) => trackId !== currentTrack.trackId);
      spanStartedAt = performance.now();
      const candidateDocuments = uniqueCandidateIds.length
        ? await trackModel.find({ trackId: { $in: uniqueCandidateIds } }).select(trackFields).lean()
        : [];
      spansMs.candidateRetrievalMs = Number((performance.now() - spanStartedAt).toFixed(3));
      const byId = new Map(candidateDocuments.map((track) => [track.trackId, track]));
      const orderedCandidates = uniqueCandidateIds.map((trackId) => byId.get(trackId)).filter(Boolean);
      const roomSentiment = sentimentService.snapshot(loungeId);
      // A minimum of three recent messages avoids overreacting to one short message.
      // Until then use a neutral baseline (0.5), which preserves current track energy.
      const effectiveSentimentScore = roomSentiment.sampleSize >= 3 ? roomSentiment.rollingScore : 0.5;
      spanStartedAt = performance.now();
      const ranked = rankSegueCandidates(currentTrack, orderedCandidates, {
        currentSentimentScore: effectiveSentimentScore,
        recentTrackIds: input.recentTrackIds ?? [],
        recentWindow: 5,
        bpmTolerancePct: lounge.settings?.bpmTolerancePct ?? 8,
      });
      spansMs.acousticEligibilityAndRankingMs = Number((performance.now() - spanStartedAt).toFixed(3));
      const selected = ranked.eligible[0];
      const generatedAt = new Date().toISOString();
      if (!selected) {
        return finish({
          selectedTrackId: null,
          matchReason: null,
          transitionScript: null,
          sourceEvents: [],
          generatedAt,
          provider: transitionProvider.name,
          reason: 'NO_COMPATIBLE_CANDIDATE',
        });
      }

      // Preference suppression happens before provider invocation, while the
      // same acoustic selection and hard constraints still run normally.
      if (!includeCommentary) {
        return finish({
          selectedTrackId: selected.track.trackId,
          matchReason: {
            bpmDeltaPct: selected.match.bpmDeltaPct, bpmRelation: selected.match.bpmRelation,
            camelotRelation: selected.match.camelotRelation, energyFit: selected.match.energyFit,
            harmonicCloseness: selected.match.harmonicCloseness, targetEnergy: selected.match.targetEnergy,
            recencyScore: selected.match.recencyScore, score: selected.match.score,
            selectionReason: selected.match.selectionReason,
          },
          transitionScript: null, sourceEvents: [], generatedAt, provider: 'disabled',
        });
      }

      const providerInput = {
        currentTrack,
        selectedTrack: selected.track,
        matchReason: selected.match,
        currentTs: input.currentTs,
        currentSentimentScore: effectiveSentimentScore,
      };
      let generated;
      let usedFallback = transitionProvider === fallbackProvider;
      spanStartedAt = performance.now();
      try {
        generated = await transitionProvider.generate(providerInput);
        const validReferences = new Set([
          ...buildTrackDocuments(currentTrack),
          ...buildTrackDocuments(selected.track),
        ].map((document) => document.reference));
        const hasResolvedSources = Array.isArray(generated?.sourceEvents)
          && generated.sourceEvents.length > 0
          && generated.sourceEvents.every((reference) => validReferences.has(reference));
        if (!generated || typeof generated.transitionScript !== 'string' || !generated.transitionScript.trim() || !hasResolvedSources) {
          throw new Error('Transition provider returned an ungrounded response');
        }
      } catch {
        if (transitionProvider === fallbackProvider) throw new ApiError(503, 'TRANSITION_UNAVAILABLE', 'The transition could not be generated');
        generated = await fallbackProvider.generate(providerInput);
        usedFallback = true;
      }
      spansMs.transitionScriptAndReferenceValidationMs = Number((performance.now() - spanStartedAt).toFixed(3));
      const response = {
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
        provider: usedFallback ? fallbackProvider.name : (generated.provider ?? transitionProvider.name),
      };
      if (announce) {
        try { announcementPublisher(loungeId, { text: response.transitionScript, relatedTrackId: response.selectedTrackId, sourceEvents: response.sourceEvents }); }
        catch { /* Realtime fan-out must not invalidate an otherwise successful REST decision. */ }
      }
      return finish({
        ...response,
      });
    },
  };
}

export const segueService = createSegueService();
