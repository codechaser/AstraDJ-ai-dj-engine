import { createDistributedRateLimiter, assertRateLimit } from '../src/services/distributedRateLimiter.js';
import { createRateLimitMiddleware } from '../src/middleware/rateLimit.js';
import { rateLimitPolicies } from '../src/config/rateLimitPolicy.js';
import { ApiError } from '../src/utils/ApiError.js';

function memoryCounterModel() {
  const rows = new Map();
  return {
    rows,
    findOneAndUpdate(filter, update, options) {
      const key = `${filter.key}:${filter.windowStart.getTime()}`;
      let row = rows.get(key);
      if (!row && !options.upsert) return { lean: async () => null };
      if (!row) {
        row = { ...filter, count: 0, expiresAt: update.$setOnInsert.expiresAt };
        rows.set(key, row);
      }
      row.count += update.$inc.count;
      return { lean: async () => structuredClone(row) };
    },
  };
}

test('fixed windows allow the configured count and deny the next request with retry guidance', async () => {
  let time = 15_000;
  const limiter = createDistributedRateLimiter({ counterModel: memoryCounterModel(), now: () => time });
  const policy = { scope: 'test.chat', identity: ['user-a', 'lounge-a'], limit: 2, windowMs: 10_000 };

  expect(await limiter.consume(policy)).toMatchObject({ allowed: true, remaining: 1, retryAfterSeconds: 5 });
  expect(await limiter.consume(policy)).toMatchObject({ allowed: true, remaining: 0 });
  await expect(assertRateLimit(limiter, { ...policy, code: 'CHAT_RATE_LIMITED', message: 'slow down' }, policy.identity))
    .rejects.toMatchObject({ status: 429, code: 'CHAT_RATE_LIMITED', details: { retryAfterSeconds: 5 } });
  time = 20_000;
  expect(await limiter.consume(policy)).toMatchObject({ allowed: true, remaining: 1, retryAfterSeconds: 10 });
});

test('concurrent requests are atomically admitted only up to the boundary', async () => {
  const limiter = createDistributedRateLimiter({ counterModel: memoryCounterModel(), now: () => 10_000 });
  const requests = Array.from({ length: 40 }, () => limiter.consume({
    scope: 'socket.queue.vote', identity: ['user-a', 'room-a'], limit: 7, windowMs: 60_000,
  }));
  const results = await Promise.all(requests);
  expect(results.filter(({ allowed }) => allowed)).toHaveLength(7);
  expect(results.filter(({ allowed }) => !allowed)).toHaveLength(33);
});

test('distinct authenticated users and Lounge scopes have independent counters', async () => {
  const limiter = createDistributedRateLimiter({ counterModel: memoryCounterModel(), now: () => 120_000 });
  const consume = (userId, loungeId) => limiter.consume({
    scope: 'socket.chat.message', identity: [userId, loungeId], limit: 1, windowMs: 60_000,
  });
  expect((await consume('user-a', 'lounge-a')).allowed).toBe(true);
  expect((await consume('user-a', 'lounge-a')).allowed).toBe(false);
  expect((await consume('user-b', 'lounge-a')).allowed).toBe(true);
  expect((await consume('user-a', 'lounge-b')).allowed).toBe(true);
});

test('counter storage errors fail closed and a recovered store accepts requests', async () => {
  const model = memoryCounterModel();
  const limiter = createDistributedRateLimiter({ counterModel: model, now: () => 1_000 });
  model.findOneAndUpdate = () => { throw new Error('simulated Mongo outage'); };
  await expect(limiter.consume({ scope: 'test', identity: 'user-a', limit: 1, windowMs: 10_000 }))
    .rejects.toMatchObject({ status: 503, code: 'RATE_LIMIT_UNAVAILABLE' });
  model.findOneAndUpdate = memoryCounterModel().findOneAndUpdate;
  expect(await limiter.consume({ scope: 'test', identity: 'user-a', limit: 1, windowMs: 10_000 })).toMatchObject({ allowed: true });
});

test('unauthenticated middleware uses socket-derived IP and exposes Retry-After', async () => {
  const identities = [];
  const limiter = { async consume({ identity }) { identities.push(identity); return { allowed: false, retryAfterSeconds: 17 }; } };
  const middleware = createRateLimitMiddleware(rateLimitPolicies.authLogin, { limiter });
  const responseHeaders = {};
  let nextError;
  await middleware({
    ip: '192.0.2.10',
    headers: { 'x-forwarded-for': '198.51.100.55' },
    socket: { remoteAddress: '192.0.2.10' },
  }, { set(name, value) { responseHeaders[name] = value; } }, (error) => { nextError = error; });

  expect(identities).toEqual(['192.0.2.10']);
  expect(responseHeaders['Retry-After']).toBe('17');
  expect(nextError).toMatchObject({ status: 429, code: 'LOGIN_RATE_LIMITED' });
});

test('authenticated Lounge middleware rejects missing identity and keeps Lounge scope separate', async () => {
  const identities = [];
  const limiter = { async consume(input) { identities.push(input.identity); return { allowed: true, remaining: 2, resetAt: 60_000 }; } };
  const middleware = createRateLimitMiddleware({
    scope: 'test.lounge', identity: 'userLounge', limit: 3, windowMs: 60_000, code: 'TEST_LIMITED', message: 'limited',
  }, { limiter });
  const run = (userId, loungeId) => new Promise((resolve) => middleware({
    user: userId ? { id: userId } : null,
    params: loungeId ? { id: loungeId } : {},
  }, { set() {} }, resolve));

  await run('user-a', 'room-a');
  await run('user-a', 'room-b');
  expect(identities).toEqual([['user-a', 'room-a'], ['user-a', 'room-b']]);
  await expect(run(null, 'room-a')).resolves.toMatchObject({ status: 401, code: 'AUTH_REQUIRED' });
});

test('authenticated route middleware fails with 503 when shared limiter storage fails', async () => {
  const middleware = createRateLimitMiddleware(rateLimitPolicies.preferenceWrite, {
    limiter: { async consume() { throw new ApiError(503, 'RATE_LIMIT_UNAVAILABLE', 'Unavailable'); } },
  });
  const error = await new Promise((resolve) => middleware({ user: { id: 'user-a' } }, { set() {} }, resolve));
  expect(error).toMatchObject({ status: 503, code: 'RATE_LIMIT_UNAVAILABLE' });
});
