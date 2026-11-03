import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRuntimeBenchmarkJournal, summarizeBenchmarkError } from '../scripts/runtimeBenchmarkJournal.js';

let temporaryRoot;

beforeEach(async () => {
  temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'astradj-runtime-journal-'));
});

afterEach(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

function createJournal(overrides = {}) {
  return createRuntimeBenchmarkJournal({
    baseDirectory: temporaryRoot,
    runId: 'runtime-test-001',
    manifest: { configuration: { apiSamples: 100 }, database: { target: 'disposable-loopback' } },
    plannedStages: ['api', 'soundclash', 'cleanup'],
    ...overrides,
  });
}

test('writes a manifest before stage work and persists completed measurements atomically', async () => {
  const journal = await createJournal();
  const manifest = JSON.parse(await readFile(journal.manifestPath, 'utf8'));
  expect(manifest.stagePlan.map(({ status }) => status)).toEqual(['pending', 'pending', 'pending']);

  await journal.beginStage('api');
  await journal.completeStage('api', { requests: 200, successful: 199, p95Ms: 12.5 });
  const snapshots = (await readdir(journal.runDirectory)).filter((name) => name.startsWith('snapshot-'));
  expect(snapshots).toHaveLength(2);
  const latest = JSON.parse(await readFile(path.join(journal.runDirectory, snapshots.sort().at(-1)), 'utf8'));
  expect(latest.measurements.api).toEqual({ requests: 200, successful: 199, p95Ms: 12.5 });
  expect(latest.stages[0]).toMatchObject({ name: 'api', status: 'completed', durationMs: expect.any(Number) });
});

test('preserves failed-stage evidence, classifies timeouts, and marks later stages skipped', async () => {
  const journal = await createJournal();
  await journal.beginStage('api');
  await journal.completeStage('api', { successful: 100, p95Ms: 18 });
  await journal.beginStage('soundclash');
  const error = Object.assign(new Error('No acknowledgement; token=eyJabc.def.ghi'), {
    code: 'ACK_TIMEOUT', timedOut: true,
    diagnostics: { correlationId: 'sc-123', persistedEventCount: 1 },
  });
  await journal.failStage('soundclash', error);
  await journal.skipPendingStages('prior stage failed', ['cleanup']);
  await journal.beginStage('cleanup');
  await journal.completeStage('cleanup', { databaseDropped: true, processesStopped: 2 });
  const result = await journal.finish({ cleanupStatus: 'completed' });

  expect(result.complete).toBe(false);
  const report = JSON.parse(await readFile(result.reportPath, 'utf8'));
  expect(report.status).toBe('partial');
  expect(report.measurements.api).toMatchObject({ successful: 100, p95Ms: 18 });
  expect(report.stages.find(({ name }) => name === 'soundclash')).toMatchObject({
    status: 'timed_out',
    error: { code: 'ACK_TIMEOUT', diagnostics: { correlationId: 'sc-123', persistedEventCount: 1 } },
  });
  expect(report.stages.find(({ name }) => name === 'soundclash').error.message).not.toContain('eyJabc');
  expect(report.stagePlan.find(({ name }) => name === 'cleanup').status).toBe('completed');
  expect(report.failures).toHaveLength(1);
});

test('refuses to reuse a run directory or overwrite its artifacts', async () => {
  const journal = await createJournal();
  await expect(createJournal()).rejects.toMatchObject({ code: 'EEXIST' });
  await journal.beginStage('api');
  await journal.completeStage('api', { ok: true });
  const result = await journal.finish({ cleanupStatus: 'completed' });
  expect(await readFile(result.reportPath, 'utf8')).toContain('"ok": true');
  await expect(journal.finish({ cleanupStatus: 'completed' })).rejects.toMatchObject({ code: 'EEXIST' });
});

test('redacts configured Mongo URIs and tokens from failure summaries', () => {
  const summary = summarizeBenchmarkError(new Error('failed mongodb://user:password@127.0.0.1/db with token eyJabc.def.ghi'), ['user:password@127.0.0.1/db']);
  expect(summary.message).not.toContain('password');
  expect(summary.message).not.toContain('eyJabc');
  expect(summary.message).toContain('[redacted Mongo URI]');
});
