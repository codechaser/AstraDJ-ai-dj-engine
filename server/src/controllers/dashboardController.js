import { dashboardService } from '../services/dashboardService.js';
import { ApiError } from '../utils/ApiError.js';

export async function getPlaybackHistory(req, res) {
  if (Object.keys(req.query).some((key) => key !== 'limit')) throw new ApiError(400, 'VALIDATION_ERROR', 'Only the limit query parameter is accepted');
  const rawLimit = req.query.limit ?? '20';
  if (!/^\d+$/.test(String(rawLimit))) throw new ApiError(400, 'VALIDATION_ERROR', 'limit must be an integer between 1 and 100');
  res.json(await dashboardService.playbackHistory(req.user.id, Number(rawLimit)));
}

export async function getLoungeAnalytics(req, res) {
  res.json(await dashboardService.loungeAnalytics({ loungeId: req.params.id, userId: req.user.id }));
}
