import { Router } from 'express';
import { createLounge } from '../controllers/loungeController.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { validateRequest } from '../middleware/validateRequest.js';
import { createLoungeValidation } from '../middleware/validation.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = Router();
router.post('/', requireAuth, requireRole('Host'), createLoungeValidation, validateRequest, asyncHandler(createLounge));
export default router;
