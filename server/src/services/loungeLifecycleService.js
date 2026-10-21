import { DJLounge } from '../models/DJLounge.js';
import { dashboardRepository } from './dashboardRepository.js';
import { ApiError } from '../utils/ApiError.js';
import { createSessionAnalyticsService } from './sessionAnalyticsService.js';

export function createLoungeLifecycleService({ loungeModel = DJLounge, repository = dashboardRepository, now = () => new Date() } = {}) {
  const analytics = createSessionAnalyticsService(repository);
  return {
    async end({ loungeId, userId, userRole }) {
      const lounge = await loungeModel.findOne({ loungeId }).lean();
      if (!lounge) throw new ApiError(404, 'LOUNGE_NOT_FOUND', 'Lounge not found');
      if (userRole !== 'Host' || String(lounge.hostUserId) !== String(userId)) throw new ApiError(403, 'LOUNGE_HOST_REQUIRED', 'Only the owning Host can end this session');
      if (lounge.status === 'ended') return { lounge, alreadyEnded: true };

      const endedAt = now();
      const sessionSummary = await analytics.forLounge({ ...lounge, endedAt });
      const ended = await loungeModel.findOneAndUpdate(
        { loungeId, status: { $ne: 'ended' }, hostUserId: userId },
        { $set: { status: 'ended', endedAt, sessionSummary } },
        { new: true },
      ).lean();
      if (ended) return { lounge: ended, alreadyEnded: false };

      const current = await loungeModel.findOne({ loungeId }).lean();
      if (current?.status === 'ended' && userRole === 'Host' && String(current.hostUserId) === String(userId)) return { lounge: current, alreadyEnded: true };
      throw new ApiError(409, 'LOUNGE_END_CONFLICT', 'The Lounge changed while it was being ended');
    },

    async historyForUser(userId, limit = 50) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiError(400, 'VALIDATION_ERROR', 'limit must be an integer between 1 and 100');
      const rooms = await loungeModel.find({ status: 'ended', $or: [{ hostUserId: userId }, { participantIds: userId }] })
        .sort({ endedAt: -1, _id: -1 }).limit(limit)
        .select('loungeId hostUserId participantIds vibeProfile status createdAt startedAt endedAt sessionSummary analyticsTrackingVersion').lean();
      return { items: await Promise.all(rooms.map(async (lounge) => ({
        loungeId: lounge.loungeId,
        role: String(lounge.hostUserId) === String(userId) ? 'Host' : 'Participant',
        vibeProfile: lounge.vibeProfile,
        status: lounge.status,
        createdAt: lounge.createdAt?.toISOString?.() ?? null,
        startedAt: lounge.startedAt?.toISOString?.() ?? null,
        endedAt: lounge.endedAt?.toISOString?.() ?? null,
        summary: await analytics.forLounge(lounge),
      }))) };
    },
  };
}

export const loungeLifecycleService = createLoungeLifecycleService();
