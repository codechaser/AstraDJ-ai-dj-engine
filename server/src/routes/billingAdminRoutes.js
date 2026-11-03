import { Router } from 'express';
import { adminOverview, adminPayments, adminPlans, adminSubscriptions, adminUpdatePlan } from '../controllers/billingController.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = Router();
router.use(requireAuth, requireRole('Admin'));
router.get('/overview', asyncHandler(adminOverview));
router.get('/plans', asyncHandler(adminPlans));
router.get('/subscriptions', asyncHandler(adminSubscriptions));
router.get('/payments', asyncHandler(adminPayments));
router.patch('/plans/:planId', asyncHandler(adminUpdatePlan));
export default router;
