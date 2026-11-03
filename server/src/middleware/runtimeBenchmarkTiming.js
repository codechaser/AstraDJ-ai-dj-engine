import { performance } from 'node:perf_hooks';

const benchmarkIdPattern = /^[0-9a-f-]{36}$/i;

export function runtimeBenchmarkTiming(req, res, next) {
  const benchmarkRequestId = req.get('x-astradj-benchmark-id');
  if (process.env.ASTRA_RUNTIME_BENCH_DIAGNOSTICS !== 'true'
    || req.method !== 'GET'
    || req.path !== '/api/v1/tracks'
    || typeof benchmarkRequestId !== 'string'
    || !benchmarkIdPattern.test(benchmarkRequestId)) return next();

  const startedAt = performance.now();
  const originalEnd = res.end;
  let ended = false;
  res.end = function benchmarkTimedEnd(...args) {
    if (!ended && !res.headersSent) {
      ended = true;
      const durationMs = Math.max(0, performance.now() - startedAt);
      res.setHeader('Server-Timing', `app;dur=${durationMs.toFixed(3)}`);
    }
    return originalEnd.apply(this, args);
  };
  return next();
}
