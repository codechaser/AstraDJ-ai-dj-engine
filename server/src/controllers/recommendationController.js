import { recommendationService } from '../services/recommendationService.js';
import { ApiError } from '../utils/ApiError.js';

const interactionFields = new Set(['trackId', 'playedSeconds', 'completed', 'liked', 'loungeId']);

export async function recordInteraction(req, res) {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).some((key) => !interactionFields.has(key))) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Only trackId, playedSeconds, completed, liked, and optional loungeId are accepted');
  }
  const result = await recommendationService.recordInteraction({ userId: req.user.id, ...req.body });
  res.status(201).json(result);
}

export async function getRecommendations(req, res) {
  if (Object.keys(req.query).some((key) => key !== 'limit')) throw new ApiError(400, 'VALIDATION_ERROR', 'Only the limit query parameter is accepted');
  res.json(await recommendationService.recommendForUser(req.user.id, req.query.limit ?? 10));
}

export async function getAcousticTaste(req, res) {
  if (Object.keys(req.query).length) throw new ApiError(400, 'VALIDATION_ERROR', 'The acoustic-taste endpoint does not accept query parameters');
  res.json(await recommendationService.acousticTasteForUser(req.user.id));
}
