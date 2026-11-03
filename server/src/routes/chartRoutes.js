import { Router } from 'express';
import { popularAlbumsService } from '../services/popularAlbumsService.js';
import { rateLimit, rateLimitPolicies } from '../middleware/rateLimit.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = Router();
router.get('/albums', rateLimit(rateLimitPolicies.publicCatalog), asyncHandler(async (_req, res) => {
  res.json(await popularAlbumsService.getPopularAlbums());
}));

export default router;
