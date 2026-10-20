import { Router } from 'express';
import { createTrack, getAcousticProfile, listTracks } from '../controllers/trackController.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { validateRequest } from '../middleware/validateRequest.js';
import { catalogValidation, createTrackValidation, trackIdValidation } from '../middleware/validation.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = Router();
router.get('/', catalogValidation, validateRequest, asyncHandler(listTracks));
router.get('/:trackId/acoustic-profile', trackIdValidation, validateRequest, asyncHandler(getAcousticProfile));
router.post('/', requireAuth, requireRole('Admin'), createTrackValidation, validateRequest, asyncHandler(createTrack));
export default router;
