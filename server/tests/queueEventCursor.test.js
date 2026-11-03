import { jest } from '@jest/globals';
import { createQueueService } from '../src/services/queueService.js';

test('coordinated queue service forwards the gateway event cursor to the repository', async () => {
  const events = [
    { loungeId: 'lg_cursor_test', seq: 8, type: 'track.added' },
    { loungeId: 'lg_cursor_test', seq: 9, type: 'track.voted' },
  ];
  const repository = {
    getCoordination: jest.fn(),
    commitCoordination: jest.fn(),
    listQueueEventsAfter: jest.fn(async (loungeId, afterSeq) => events.filter((event) => event.loungeId === loungeId && event.seq > afterSeq)),
    listQueueEvents: jest.fn(async () => { throw new Error('incremental repository query should be used'); }),
  };
  const service = createQueueService(repository);

  await expect(service.listEventsAfter('lg_cursor_test', 8)).resolves.toEqual([events[1]]);
  expect(repository.listQueueEventsAfter).toHaveBeenCalledWith('lg_cursor_test', 8);
  expect(repository.listQueueEvents).not.toHaveBeenCalled();
});

test('coordinated queue service safely filters full-history repositories that lack cursor support', async () => {
  const events = [
    { loungeId: 'lg_cursor_test', seq: 8, type: 'track.added' },
    { loungeId: 'lg_cursor_test', seq: 9, type: 'track.voted' },
  ];
  const repository = {
    getCoordination: jest.fn(),
    commitCoordination: jest.fn(),
    listQueueEvents: jest.fn(async () => events),
  };

  await expect(createQueueService(repository).listEventsAfter('lg_cursor_test', 8)).resolves.toEqual([events[1]]);
});
