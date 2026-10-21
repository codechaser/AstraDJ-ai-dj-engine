import { ApiError } from '../utils/ApiError.js';
import { dashboardRepository } from './dashboardRepository.js';
import { createSessionAnalyticsService } from './sessionAnalyticsService.js';

const isMember = (lounge, userId) => String(lounge.hostUserId) === String(userId)
  || (lounge.participantIds ?? []).some((id) => String(id) === String(userId));

export function createDashboardService(repository = dashboardRepository) {
  const analytics = createSessionAnalyticsService(repository);
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
      const summary = await analytics.forLounge(lounge);
      return {
        loungeId, status: lounge.status,
        ...summary,
      };
    },
  };
}

export const dashboardService = createDashboardService();
