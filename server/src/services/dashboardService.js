import { ApiError } from '../utils/ApiError.js';
import { dashboardRepository } from './dashboardRepository.js';

const isMember = (lounge, userId) => String(lounge.hostUserId) === String(userId)
  || (lounge.participantIds ?? []).some((id) => String(id) === String(userId));

export function createDashboardService(repository = dashboardRepository) {
  return {
    async playbackHistory(userId, limit = 20) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiError(400, 'VALIDATION_ERROR', 'limit must be an integer between 1 and 100');
      const rows = await repository.listInteractionsForUser(userId, limit);
      return { items: rows.map((row) => ({
        interactionId: String(row._id ?? row.id), trackId: row.trackId,
        playedSeconds: row.playedSeconds, completed: row.completed, liked: row.liked,
        loungeId: row.loungeId ?? null, source: row.source ?? 'self_reported', createdAt: new Date(row.createdAt).toISOString(),
      })) };
    },

    async loungeAnalytics({ loungeId, userId }) {
      const lounge = await repository.findLounge(loungeId);
      if (!lounge) throw new ApiError(404, 'LOUNGE_NOT_FOUND', 'Lounge not found');
      if (!isMember(lounge, userId)) throw new ApiError(403, 'LOUNGE_MEMBERSHIP_REQUIRED', 'Only Lounge members can view its analytics');
      const [events, messages] = await Promise.all([
        repository.listQueueEvents(loungeId), repository.listSentimentMessages(loungeId),
      ]);
      const soundclashBattles = events.filter((event) => event.type === 'soundclash.opened').length;
      const start = lounge.startedAt ? new Date(lounge.startedAt).getTime() : null;
      const end = lounge.endedAt ? new Date(lounge.endedAt).getTime() : null;
      const sentimentTimeline = messages.map((message) => ({
        at: new Date(message.createdAt).toISOString(), score: message.sentimentScore,
        bucket: message.sentimentBucket,
      }));
      return {
        loungeId, status: lounge.status,
        durationSeconds: Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, Math.floor((end - start) / 1000)) : null,
        queueEventCount: events.length, soundclashBattles,
        chatMessageCount: messages.length, sentimentTimeline,
        peakConcurrentParticipants: null,
        aiDjQuestionCount: null,
        unavailableMetrics: {
          durationSeconds: Number.isFinite(start) && Number.isFinite(end) ? null : 'Session start or end timestamp is not persisted.',
          peakConcurrentParticipants: 'Concurrent presence is currently process-local and is not persisted.',
          aiDjQuestionCount: 'AI DJ questions are not currently persisted as Lounge events.',
        },
      };
    },
  };
}

export const dashboardService = createDashboardService();
