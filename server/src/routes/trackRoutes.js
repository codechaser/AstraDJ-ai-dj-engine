import { Router } from 'express';
import { createTrack, getAcousticProfile, listTracks, updateAcousticProfile } from '../controllers/trackController.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { validateRequest } from '../middleware/validateRequest.js';
import { acousticProfileUpdateValidation, catalogValidation, createTrackValidation, trackIdValidation } from '../middleware/validation.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = Router();
router.get('/', catalogValidation, validateRequest, asyncHandler(listTracks));
router.get('/:trackId/acoustic-profile', trackIdValidation, validateRequest, asyncHandler(getAcousticProfile));
router.put('/:trackId/acoustic-profile', requireAuth, requireRole('Admin'), trackIdValidation, validateRequest, acousticProfileUpdateValidation, asyncHandler(updateAcousticProfile));
router.post('/', requireAuth, requireRole('Admin'), createTrackValidation, validateRequest, asyncHandler(createTrack));
export default router;
