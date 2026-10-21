import { Router } from 'express';
import { getPlaybackHistory, getLoungeAnalytics, getLoungeHistory } from '../controllers/dashboardController.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = Router();
router.get('/playback-history', requireAuth, asyncHandler(getPlaybackHistory));
router.get('/lounge-history', requireAuth, asyncHandler(getLoungeHistory));
router.get('/lounges/:id/analytics', requireAuth, asyncHandler(getLoungeAnalytics));
export default router;
