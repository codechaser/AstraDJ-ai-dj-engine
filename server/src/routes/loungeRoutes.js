import { Router } from 'express';
import { createLounge } from '../controllers/loungeController.js';
import { requestSegue } from '../controllers/segueController.js';
import { askTrackQuestion } from '../controllers/aiDjController.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { validateRequest } from '../middleware/validateRequest.js';
import { aiQuestionValidation, createLoungeValidation, segueValidation } from '../middleware/validation.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = Router();
router.post('/', requireAuth, requireRole('Host'), createLoungeValidation, validateRequest, asyncHandler(createLounge));
router.post('/:id/ai/segue', requireAuth, segueValidation, validateRequest, asyncHandler(requestSegue));
router.post('/:id/ai/ask', requireAuth, aiQuestionValidation, validateRequest, asyncHandler(askTrackQuestion));
export default router;
