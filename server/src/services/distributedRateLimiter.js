import { createHash } from 'node:crypto';
import { RateLimitCounter } from '../models/RateLimitCounter.js';
import { ApiError } from '../utils/ApiError.js';

const isDuplicateKey = (error) => error?.code === 11000;

function counterKey(scope, identity) {
  const identities = Array.isArray(identity) ? identity : [identity];
  if (!scope || identities.some((value) => typeof value !== 'string' || !value)) {
    throw new TypeError('Rate limit scope and identities must be non-empty strings');
  }
  return createHash('sha256').update(JSON.stringify([scope, ...identities])).digest('hex');
}

async function executeQuery(query) {
  return typeof query?.lean === 'function' ? query.lean() : query;
}

export function createDistributedRateLimiter({ counterModel = RateLimitCounter, now = () => Date.now() } = {}) {
  async function increment(key, windowStart, expiresAt, upsert) {
    return executeQuery(counterModel.findOneAndUpdate(
      { key, windowStart },
      { $inc: { count: 1 }, ...(upsert ? { $setOnInsert: { expiresAt } } : {}) },
      { upsert, new: true, setDefaultsOnInsert: true },
    ));
  }

  return {
    async consume({ scope, identity, limit, windowMs }) {
      if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(windowMs) || windowMs < 1) {
        throw new TypeError('Rate limit and window must be positive integers');
      }
      const timestamp = now();
      const windowStartMs = Math.floor(timestamp / windowMs) * windowMs;
      const windowStart = new Date(windowStartMs);
      const expiresAt = new Date(windowStartMs + windowMs * 2);
      const retryAfterSeconds = Math.max(1, Math.ceil((windowStartMs + windowMs - timestamp) / 1000));
      const key = counterKey(scope, identity);

      let counter;
      try {
        try {
          counter = await increment(key, windowStart, expiresAt, true);
        } catch (error) {
          if (!isDuplicateKey(error)) throw error;
          counter = await increment(key, windowStart, expiresAt, false);
        }
      } catch {
        throw new ApiError(503, 'RATE_LIMIT_UNAVAILABLE', 'Rate limiting is temporarily unavailable; retry shortly');
      }

      if (!counter) {
        throw new ApiError(503, 'RATE_LIMIT_UNAVAILABLE', 'Rate limiting is temporarily unavailable; retry shortly');
      }
      return {
        allowed: counter.count <= limit,
        remaining: Math.max(0, limit - counter.count),
        retryAfterSeconds,
        resetAt: windowStartMs + windowMs,
      };
    },
  };
}

export const distributedRateLimiter = createDistributedRateLimiter();

export async function assertRateLimit(limiter, policy, identity) {
  const result = await limiter.consume({
    scope: policy.scope,
    identity,
    limit: policy.limit,
    windowMs: policy.windowMs,
  });
  if (!result.allowed) {
    throw new ApiError(429, policy.code, policy.message, { retryAfterSeconds: result.retryAfterSeconds });
  }
  return result;
}
