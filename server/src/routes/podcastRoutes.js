import { Router } from 'express';
import { getPodcastCatalog } from '../services/podcastCatalogService.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { rateLimit, rateLimitPolicies } from '../middleware/rateLimit.js';

const router = Router();
router.get('/', rateLimit(rateLimitPolicies.publicCatalog), asyncHandler(async (_req, res) => {
  res.json(await getPodcastCatalog());
}));

export default router;
