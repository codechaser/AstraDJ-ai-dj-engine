import { ApiError } from '../../src/utils/ApiError.js';

export function createMemoryRateLimiter({ now = () => Date.now() } = {}) {
  const counters = new Map();
  let calls = 0;
  return {
    async consume({ scope, identity, limit, windowMs }) {
      calls += 1;
      const identities = Array.isArray(identity) ? identity : [identity];
      const key = JSON.stringify([scope, ...identities]);
      const timestamp = now();
      const windowStart = Math.floor(timestamp / windowMs) * windowMs;
      const counterKey = JSON.stringify([key, windowStart]);
      const count = (counters.get(counterKey) ?? 0) + 1;
      counters.set(counterKey, count);
      if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(windowMs) || windowMs < 1) {
        throw new TypeError('Rate limit and window must be positive integers');
      }
      return {
        allowed: count <= limit,
        remaining: Math.max(0, limit - count),
        retryAfterSeconds: Math.max(1, Math.ceil((windowStart + windowMs - timestamp) / 1000)),
        resetAt: windowStart + windowMs,
      };
    },
    get calls() { return calls; },
    async clear() { counters.clear(); },
    failWith(error) {
      return { async consume() { throw error ?? new ApiError(503, 'RATE_LIMIT_UNAVAILABLE', 'Unavailable'); } };
    },
  };
}
