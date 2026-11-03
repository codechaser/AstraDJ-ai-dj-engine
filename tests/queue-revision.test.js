import test from 'node:test';
import assert from 'node:assert/strict';
import { canApplyQueueRevision } from '../src/api/queueRevision.js';

test('queue snapshots cannot move a rendered client backwards after a newer revision arrives', () => {
  assert.equal(canApplyQueueRevision(12, 11), false);
  assert.equal(canApplyQueueRevision(12, 12), true);
  assert.equal(canApplyQueueRevision(12, 13), true);
});

test('a pending lower-revision hydration is rejected after a higher revision has been observed', () => {
  let highestObservedRevision = 8;
  const observe = (revision) => {
    if (!canApplyQueueRevision(highestObservedRevision, revision)) return false;
    highestObservedRevision = Math.max(highestObservedRevision, revision);
    return true;
  };

  assert.equal(observe(10), true);
  assert.equal(observe(9), false);
  assert.equal(highestObservedRevision, 10);
});

test('unversioned snapshots cannot replace a versioned queue and legacy queues still initialize', () => {
  assert.equal(canApplyQueueRevision(4, undefined), false);
  assert.equal(canApplyQueueRevision(undefined, 0), true);
  assert.equal(canApplyQueueRevision(undefined, undefined), true);
});
