import { createQueueService } from '../src/services/queueService.js';
import { jest } from '@jest/globals';

test('coordinated queue snapshots hydrate all catalog tracks with one repository batch read', async () => {
  const lounge = {
    loungeId: 'lg_queue_batch_test',
    hostUserId: 'host-user',
    currentTrackId: 'track-current',
  };
  const state = {
    revision: 4,
    currentTrackId: 'track-current',
    items: [
      { trackId: 'track-current', votes: {} },
      { trackId: 'track-next-a', votes: {} },
      { trackId: 'track-next-b', votes: {} },
    ],
    battlePriorityTrackId: null,
    pendingSegue: null,
    soundclash: { battleId: null, status: 'idle', submissions: [], candidateTrackIds: [], votes: {} },
  };
  const tracks = [
    { trackId: 'track-next-b', title: 'Next B' },
    { trackId: 'track-current', title: 'Current' },
    { trackId: 'track-next-a', title: 'Next A' },
  ];
  const repository = {
    getCoordination: async () => ({ lounge, coordination: { state } }),
    commitCoordination: async () => ({ committed: false, reason: 'unused' }),
    getTracks: jest.fn(async (ids) => tracks.filter((track) => ids.includes(track.trackId))),
    getTrack: jest.fn(async () => { throw new Error('per-track lookup should not be used'); }),
  };

  const snapshot = await createQueueService(repository).snapshot(lounge);

  expect(repository.getTracks).toHaveBeenCalledTimes(1);
  expect(repository.getTracks).toHaveBeenCalledWith(['track-current', 'track-next-a', 'track-next-b']);
  expect(repository.getTrack).not.toHaveBeenCalled();
  expect(snapshot.nowPlaying).toMatchObject({ trackId: 'track-current', title: 'Current' });
  expect(snapshot.nextUp.map(({ trackId }) => trackId)).toEqual(['track-next-a', 'track-next-b']);
});
