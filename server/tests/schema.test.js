import { User } from '../src/models/User.js';
import { Track, CAMELOT_KEYS } from '../src/models/Track.js';
import { DJLounge } from '../src/models/DJLounge.js';
import { QueueEvent } from '../src/models/QueueEvent.js';
import { ChatMessage } from '../src/models/ChatMessage.js';
import { LoungeMetricEvent } from '../src/models/LoungeMetricEvent.js';
import { Interaction } from '../src/models/Interaction.js';

test('User schema restricts accounts to the four defined roles', () => {
  const user = new User({ email: 'a@example.com', displayName: 'A', passwordHash: 'hash', role: 'Superuser' });
  expect(user.validateSync().errors.role).toBeDefined();
  expect(CAMELOT_KEYS).toHaveLength(24);
});

test('User schema restricts persisted audio preferences to supported values', () => {
  const user = new User({ email: 'settings@example.com', displayName: 'Settings', passwordHash: 'hash' });
  expect(user.preferences.audio).toMatchObject({ streamingQuality: 'High (320 kbps)', crossfadeSeconds: 6, autoPlay: true });
  user.preferences.audio.crossfadeSeconds = 5;
  expect(user.validateSync().errors['preferences.audio.crossfadeSeconds']).toBeDefined();
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

test('QueueEvent stores compact typed append-only commands with a per-Lounge sequence', () => {
  const valid = new QueueEvent({
    loungeId: 'lg_123456789abc', seq: 1, type: 'track.voted',
    actorUserId: '507f1f77bcf86cd799439011', payload: { trackId: 't_2002', value: 1 },
  });
  expect(valid.validateSync()).toBeUndefined();
  const invalid = new QueueEvent({
    loungeId: 'lg_123456789abc', seq: 0, type: 'track.deleted',
    actorUserId: 'not-an-id', payload: {},
  });
  expect(invalid.validateSync()).toBeDefined();
  const tie = new QueueEvent({ loungeId: 'lg_123456789abc', seq: 2, type: 'soundclash.tied', actorUserId: null, payload: { battleId: 'battle', voteCounts: {} } });
  const automaticWinner = new QueueEvent({ loungeId: 'lg_123456789abc', seq: 3, type: 'soundclash.resolved', actorUserId: null, payload: { battleId: 'battle', winningTrackId: 't_2001', autoResolved: true } });
  const invalidManualWinner = new QueueEvent({ loungeId: 'lg_123456789abc', seq: 4, type: 'soundclash.resolved', actorUserId: null, payload: { battleId: 'battle', winningTrackId: 't_2001', autoResolved: false } });
  const automaticOpen = new QueueEvent({ loungeId: 'lg_123456789abc', seq: 5, type: 'soundclash.opened', actorUserId: null, payload: { battleId: 'battle', openedBy: 'ai_dj', candidateTrackIds: ['t_2001', 't_2002'], closesAt: Date.now() + 1000 } });
  const invalidUnattributedOpen = new QueueEvent({ loungeId: 'lg_123456789abc', seq: 6, type: 'soundclash.opened', actorUserId: null, payload: { battleId: 'battle', openedBy: 'host', candidateTrackIds: ['t_2001', 't_2002'], closesAt: Date.now() + 1000 } });
  expect(tie.validateSync()).toBeUndefined();
  expect(automaticWinner.validateSync()).toBeUndefined();
  expect(automaticOpen.validateSync()).toBeUndefined();
  expect(invalidManualWinner.validateSync().errors.actorUserId).toBeDefined();
  expect(invalidUnattributedOpen.validateSync().errors.actorUserId).toBeDefined();
});

test('ChatMessage validates sanitized bounded text, sentiment bucket, and message identity', () => {
  const valid = new ChatMessage({
    messageId: 'e54eb334-2b10-4dc1-9e9d-9ccf01713452', loungeId: 'lg_123456789abc',
    userId: '507f1f77bcf86cd799439011', msgType: 'chat', body: 'Good set', sentimentBucket: 'positive', sentimentScore: 1, tsSeconds: 100,
  });
  expect(valid.validateSync()).toBeUndefined();
  valid.sentimentBucket = 'very positive';
  expect(valid.validateSync().errors.sentimentBucket).toBeDefined();
});

test('LoungeMetricEvent stores only typed, sequence-ordered analytics fields', () => {
  const valid = new LoungeMetricEvent({
    eventId: 'e54eb334-2b10-4dc1-9e9d-9ccf01713452', loungeId: 'lg_123456789abc', seq: 1,
    type: 'ai.question.asked', userId: '507f1f77bcf86cd799439011', requestId: 'request-0001',
  });
  expect(valid.validateSync()).toBeUndefined();
  expect(valid.toObject()).not.toHaveProperty('question');
  valid.type = 'chat.message';
  expect(valid.validateSync().errors.type).toBeDefined();
});

test('Interaction schema stores only bounded, typed listening records and private co-listener references', () => {
  const valid = new Interaction({
    userId: '507f1f77bcf86cd799439011', trackId: 't_2001', playedSeconds: 120,
    completed: false, liked: true, loungeId: 'lg_123456789abc', coListenedWith: ['507f1f77bcf86cd799439012'],
  });
  expect(valid.validateSync()).toBeUndefined();
  const invalid = new Interaction({
    userId: '507f1f77bcf86cd799439011', trackId: 'bad', playedSeconds: -1,
    completed: 'yes', liked: false, source: 'queue-vote',
  });
  expect(invalid.validateSync()).toBeDefined();
});
