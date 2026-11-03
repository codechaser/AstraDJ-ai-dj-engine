import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { runtimeBenchmarkTiming } from '../src/middleware/runtimeBenchmarkTiming.js';

let previousSetting;

beforeEach(() => {
  previousSetting = process.env.ASTRA_RUNTIME_BENCH_DIAGNOSTICS;
  process.env.ASTRA_RUNTIME_BENCH_DIAGNOSTICS = 'true';
});

afterEach(() => {
  if (previousSetting === undefined) delete process.env.ASTRA_RUNTIME_BENCH_DIAGNOSTICS;
  else process.env.ASTRA_RUNTIME_BENCH_DIAGNOSTICS = previousSetting;
});

function makeApp() {
  const app = express();
  app.use(runtimeBenchmarkTiming);
  app.get('/api/v1/tracks', (_req, res) => res.json({ items: [] }));
  app.get('/other', (_req, res) => res.json({ ok: true }));
  return app;
}

test('adds a monotonic Server-Timing value only to a correlated benchmark catalog request', async () => {
  const response = await request(makeApp()).get('/api/v1/tracks')
    .set('x-astradj-benchmark-id', crypto.randomUUID());
  expect(response.status).toBe(200);
  expect(response.headers['server-timing']).toMatch(/^app;dur=\d+\.\d{3}$/);
});

test('does not add diagnostic timing to normal, malformed-ID, or unrelated requests', async () => {
  const app = makeApp();
  const noId = await request(app).get('/api/v1/tracks');
  const invalidId = await request(app).get('/api/v1/tracks').set('x-astradj-benchmark-id', 'not-a-uuid');
  const unrelated = await request(app).get('/other').set('x-astradj-benchmark-id', crypto.randomUUID());
  expect(noId.headers['server-timing']).toBeUndefined();
  expect(invalidId.headers['server-timing']).toBeUndefined();
  expect(unrelated.headers['server-timing']).toBeUndefined();
});
