import { User } from '../src/models/User.js';
import { Track, CAMELOT_KEYS } from '../src/models/Track.js';
import { DJLounge } from '../src/models/DJLounge.js';

test('User schema restricts accounts to the four defined roles', () => {
  const user = new User({ email: 'a@example.com', displayName: 'A', passwordHash: 'hash', role: 'Superuser' });
  expect(user.validateSync().errors.role).toBeDefined();
  expect(CAMELOT_KEYS).toHaveLength(24);
});

test('Track schema validates acoustic range, Camelot key, and timeline metadata', () => {
  const invalid = new Track({
    trackId: 't_bad', title: 'Bad', artist: 'Artist', durationSeconds: 120,
    acoustic: { bpm: 0, camelotKey: '13Z', energy: 1.1, valence: -0.1 },
    timeline: [{ ts: -1, type: 'made_up', text: 'bad' }],
  });
  expect(invalid.validateSync()).toBeDefined();
  const valid = new Track({
    trackId: 't_good', title: 'Good', artist: 'Artist', durationSeconds: 120,
    acoustic: { bpm: 124, camelotKey: '8A', energy: 0.7, valence: 0.8 },
    timeline: [{ ts: 10, type: 'trivia', text: 'Grounded fact.' }],
  });
  expect(valid.validateSync()).toBeUndefined();
});

test('DJ Lounge schema limits capacity and BPM tolerance to project bounds', () => {
  const lounge = new DJLounge({
    loungeId: 'lg_123456789abc', inviteCode: 'SP-9X2L', hostUserId: '507f1f77bcf86cd799439011',
    vibeProfile: 'High-Energy EDM', queue: ['t_2001'], currentTrackId: 't_2001',
    settings: { maxParticipants: 40, bpmTolerancePct: 8, soundclashEnabled: true, aiVerbosity: 'normal' },
  });
  expect(lounge.validateSync()).toBeUndefined();
  lounge.settings.maxParticipants = 51;
  expect(lounge.validateSync().errors['settings.maxParticipants']).toBeDefined();
});
