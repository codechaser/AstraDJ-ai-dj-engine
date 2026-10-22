import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';
import { User } from '../models/User.js';
import { ApiError } from '../utils/ApiError.js';

export async function requireAuth(req, _res, next) {
  try {
    const [scheme, token] = (req.get('authorization') ?? '').split(' ');
    if (scheme !== 'Bearer' || !token) throw new ApiError(401, 'AUTH_REQUIRED', 'A valid access token is required');
    const claims = jwt.verify(token, config.jwtAccessSecret, { algorithms: ['HS256'], issuer: 'astradj-api', audience: 'astradj-client' });
    const user = await User.findById(claims.sub).select('email displayName role preferences.audio.aiDjCommentary');
    if (!user) throw new ApiError(401, 'AUTH_REQUIRED', 'The account for this token no longer exists');
    req.user = { id: user.id, email: user.email, displayName: user.displayName, role: user.role, aiDjCommentary: user.preferences?.audio?.aiDjCommentary !== false };
    return next();
  } catch (err) {
    if (err instanceof ApiError) return next(err);
    if (err.name === 'TokenExpiredError' || err.name === 'JsonWebTokenError') {
      return next(new ApiError(401, 'INVALID_TOKEN', 'The access token is invalid or expired'));
    }
    return next(err);
  }
}

export function requireRole(...allowedRoles) {
  return (req, _res, next) => {
    if (!req.user) return next(new ApiError(401, 'AUTH_REQUIRED', 'Authentication is required'));
    if (!allowedRoles.includes(req.user.role)) return next(new ApiError(403, 'FORBIDDEN', 'Your role cannot perform this action'));
    return next();
  };
}
