import { Router } from 'express';
import { createLounge } from '../controllers/loungeController.js';
import { requestSegue } from '../controllers/segueController.js';
import { askTrackQuestion } from '../controllers/aiDjController.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { validateRequest } from '../middleware/validateRequest.js';
import { aiQuestionValidation, createLoungeValidation, segueValidation } from '../middleware/validation.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { rateLimit, rateLimitPolicies } from '../middleware/rateLimit.js';
import { meterAuthorizedLoungeAiDj } from '../middleware/aiDjEntitlement.js';
import { enforcePlanLoungeCapacity } from '../middleware/aiDjEntitlement.js';

const router = Router();
router.post('/', requireAuth, rateLimit(rateLimitPolicies.loungeCreate), requireRole('Host'), createLoungeValidation, validateRequest, enforcePlanLoungeCapacity, asyncHandler(createLounge));
router.post('/:id/ai/segue', requireAuth, rateLimit(rateLimitPolicies.segue), segueValidation, validateRequest, meterAuthorizedLoungeAiDj, asyncHandler(requestSegue));
router.post('/:id/ai/ask', requireAuth, aiQuestionValidation, validateRequest, meterAuthorizedLoungeAiDj, asyncHandler(askTrackQuestion));
export default router;
