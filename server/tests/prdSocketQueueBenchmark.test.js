import { createMemoryRateLimiter } from './support/memoryRateLimiter.js';
import { measureFiftyParticipantQueue } from '../scripts/prdSocketQueueBenchmark.js';

test('PRD socket benchmark injects policy-enforcing test rate limits and cleans up its gateway', async () => {
  const rateLimiter = createMemoryRateLimiter();
  const report = await measureFiftyParticipantQueue({
    rounds: 2,
    participantCount: 4,
    rateLimiter,
    connectionTimeoutMs: 5_000,
    acknowledgementTimeoutMs: 2_000,
  });

  expect(rateLimiter.calls).toBe(10);
  expect(report).toMatchObject({
    status: 'PASS_LOCAL_SYNTHETIC_ONLY',
    loungeCount: 1,
    participants: 4,
    rounds: 2,
    mutationAttempts: 2,
    successfulMutations: 2,
    acknowledgedMutations: 2,
    rejectedMutations: 0,
    mutationTimeouts: 0,
    serverRecordedQueueEvents: 2,
    missingServerEvents: 0,
    duplicateLogicalEvents: 0,
    expectedClientReceipts: 8,
    observedClientReceipts: 8,
    missingClientReceipts: 0,
    duplicateClientReceipts: 0,
    queueStateHashMismatches: 0,
    queueStateDivergences: 0,
    outOfOrderClientReceipts: 0,
    finalClientDivergences: 0,
    finalQueue: {
      revision: 2,
      trackCount: 3,
      missingQueueItems: 0,
      matchesExpectedOrder: true,
    },
  });
  expect(report.queueStateHashComparisons).toBe(8);
  expect(report.latencyMs.clientArrivalSpread.samples).toBe(2);
  expect(report.latencyMs.serverReceiptToLastClientReceipt.samples).toBe(2);
  expect(report.environment.writerRoles).toEqual(['Host']);
});
