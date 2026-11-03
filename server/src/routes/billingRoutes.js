import { Router } from 'express';
import { cancelSubscription, createSubscription, getMyPayments, getMySubscription, listPlans, verifyCheckout } from '../controllers/billingController.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { rateLimit, rateLimitPolicies } from '../middleware/rateLimit.js';

const router = Router();
router.get('/plans', asyncHandler(listPlans));
router.get('/me', requireAuth, asyncHandler(getMySubscription));
router.get('/me/payments', requireAuth, asyncHandler(getMyPayments));
router.post('/subscriptions', requireAuth, rateLimit(rateLimitPolicies.billingCreate), asyncHandler(createSubscription));
router.post('/verify', requireAuth, rateLimit(rateLimitPolicies.billingCreate), asyncHandler(verifyCheckout));
router.post('/subscriptions/:subscriptionId/cancel', requireAuth, rateLimit(rateLimitPolicies.billingCancel), asyncHandler(cancelSubscription));
export default router;
