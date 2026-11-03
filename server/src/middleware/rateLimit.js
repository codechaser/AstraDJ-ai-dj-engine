import { rateLimitPolicies } from '../config/rateLimitPolicy.js';
import { distributedRateLimiter, assertRateLimit } from '../services/distributedRateLimiter.js';
import { ApiError } from '../utils/ApiError.js';

export function createRateLimitMiddleware(policy, { limiter, identity = policy.identity } = {}) {
  return async (req, res, next) => {
    try {
      let key;
      if (identity === 'user') key = req.user?.id;
      else if (identity === 'userLounge') {
        if (!req.user?.id) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication is required');
        if (!req.params.id) throw new ApiError(400, 'RATE_LIMIT_SCOPE_UNAVAILABLE', 'A Lounge scope is required');
        key = [req.user.id, req.params.id];
      }
      else key = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
      if (!key) throw new ApiError(401, 'AUTH_REQUIRED', 'Authentication is required');

      const activeLimiter = limiter ?? req.app?.locals?.rateLimiter ?? distributedRateLimiter;
      const result = await assertRateLimit(activeLimiter, policy, key);
      res.set('RateLimit-Limit', String(policy.limit));
      res.set('RateLimit-Remaining', String(result.remaining));
      res.set('RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));
      return next();
    } catch (error) {
      if (error.status === 429) res.set('Retry-After', String(error.details.retryAfterSeconds));
      return next(error);
    }
  };
}

export const rateLimit = (policy, options) => createRateLimitMiddleware(policy, options);
export { rateLimitPolicies };
