import { Router } from 'express';
import { register, login, refresh, logout } from '../controllers/authController.js';
import { getPreferences, getProfile, updatePreferences } from '../controllers/userController.js';
import { requireAuth } from '../middleware/auth.js';
import { validateRequest } from '../middleware/validateRequest.js';
import { loginValidation, registerValidation } from '../middleware/validation.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { rateLimit, rateLimitPolicies } from '../middleware/rateLimit.js';

const router = Router();
router.post('/register', rateLimit(rateLimitPolicies.authRegister), registerValidation, validateRequest, asyncHandler(register));
router.post('/login', rateLimit(rateLimitPolicies.authLogin), loginValidation, validateRequest, asyncHandler(login));
router.post('/refresh', rateLimit(rateLimitPolicies.authRefresh), asyncHandler(refresh));
router.post('/logout', asyncHandler(logout));
router.get('/me', requireAuth, asyncHandler(getProfile));
router.get('/me/preferences', requireAuth, asyncHandler(getPreferences));
router.patch('/me/preferences', requireAuth, rateLimit(rateLimitPolicies.preferenceWrite), asyncHandler(updatePreferences));
export default router;
