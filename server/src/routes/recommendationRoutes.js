import { Router } from 'express';
import { getAcousticTaste, getRecommendations, recordInteraction } from '../controllers/recommendationController.js';
import { requireAuth } from '../middleware/auth.js';
import { validateRequest } from '../middleware/validateRequest.js';
import { interactionValidation, recommendationValidation } from '../middleware/validation.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { rateLimit, rateLimitPolicies } from '../middleware/rateLimit.js';

export const interactionRouter = Router();
interactionRouter.post('/', requireAuth, rateLimit(rateLimitPolicies.interaction), interactionValidation, validateRequest, asyncHandler(recordInteraction));

const recommendationRouter = Router();
recommendationRouter.get('/taste', requireAuth, rateLimit(rateLimitPolicies.recommendationTaste), asyncHandler(getAcousticTaste));
recommendationRouter.get('/', requireAuth, rateLimit(rateLimitPolicies.recommendation), recommendationValidation, validateRequest, asyncHandler(getRecommendations));
export default recommendationRouter;
