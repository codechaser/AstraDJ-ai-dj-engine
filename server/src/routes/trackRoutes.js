import { Router } from 'express';
import { createTrack, getAcousticProfile, listTracks, updateAcousticProfile } from '../controllers/trackController.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { validateRequest } from '../middleware/validateRequest.js';
import { acousticProfileUpdateValidation, catalogValidation, createTrackValidation, trackIdValidation } from '../middleware/validation.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { rateLimit, rateLimitPolicies } from '../middleware/rateLimit.js';

const router = Router();
router.get('/', rateLimit(rateLimitPolicies.publicCatalog), catalogValidation, validateRequest, asyncHandler(listTracks));
router.get('/:trackId/acoustic-profile', rateLimit(rateLimitPolicies.publicCatalog), trackIdValidation, validateRequest, asyncHandler(getAcousticProfile));
router.put('/:trackId/acoustic-profile', requireAuth, rateLimit(rateLimitPolicies.adminCatalogWrite), requireRole('Admin'), trackIdValidation, validateRequest, acousticProfileUpdateValidation, asyncHandler(updateAcousticProfile));
router.post('/', requireAuth, rateLimit(rateLimitPolicies.adminCatalogWrite), requireRole('Admin'), createTrackValidation, validateRequest, asyncHandler(createTrack));
export default router;
