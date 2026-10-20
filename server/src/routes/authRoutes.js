import { Router } from 'express';
import { register, login, refresh, logout } from '../controllers/authController.js';
import { getProfile } from '../controllers/userController.js';
import { requireAuth } from '../middleware/auth.js';
import { validateRequest } from '../middleware/validateRequest.js';
import { loginValidation, registerValidation } from '../middleware/validation.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = Router();
router.post('/register', registerValidation, validateRequest, asyncHandler(register));
router.post('/login', loginValidation, validateRequest, asyncHandler(login));
router.post('/refresh', asyncHandler(refresh));
router.post('/logout', asyncHandler(logout));
router.get('/me', requireAuth, asyncHandler(getProfile));
export default router;
