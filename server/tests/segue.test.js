import { jest } from '@jest/globals';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const camelotKeys = Array.from({ length: 12 }, (_, index) => [`${index + 1}A`, `${index + 1}B`]).flat();
const users = new Map();
const lounges = new Map();
const tracks = new Map();

class Query {
  constructor(value) { this.value = value; }
  select() { return this; }
  lean() { return Promise.resolve(this.value); }
  then(resolve, reject) { return Promise.resolve(this.value).then(resolve, reject); }
}

const User = {
  findById: jest.fn((id) => new Query(users.get(String(id)) ?? null)),
};
const RefreshToken = {};
const Track = {
  findOne: jest.fn(({ trackId }) => new Query(tracks.get(trackId) ?? null)),
  find: jest.fn(({ trackId }) => new Query((trackId?.$in ?? []).map((id) => tracks.get(id)).filter(Boolean))),
};
const DJLounge = {
  findOne: jest.fn(({ loungeId }) => new Query(lounges.get(loungeId) ?? null)),
};

await jest.unstable_mockModule('../src/models/User.js', () => ({ User }));
await jest.unstable_mockModule('../src/models/RefreshToken.js', () => ({ RefreshToken }));
await jest.unstable_mockModule('../src/models/Track.js', () => ({ Track, CAMELOT_KEYS: camelotKeys }));
await jest.unstable_mockModule('../src/models/DJLounge.js', () => ({ DJLounge }));

const { app } = await import('../src/app.js');
const { createSegueService } = await import('../src/services/segueService.js');
const { createRoomSentimentService } = await import('../src/services/roomSentimentService.js');

const loungeId = 'lg_123456789abc';
const memberId = '507f1f77bcf86cd799439011';
const outsiderId = '507f1f77bcf86cd799439012';
const currentTrack = {
  trackId: 't_2001', title: 'Night Drive', artist: 'Nova Circuit', durationSeconds: 220,
  acoustic: { bpm: 124, camelotKey: '8A', energy: 0.78, valence: 0.65 },
  timeline: [{ ts: 12, type: 'trivia', text: 'Nova Circuit recorded the synth line at dawn.' }],
};
const selectedTrack = {
  trackId: 't_2002', title: 'Blue Hour', artist: 'Mira Vale', durationSeconds: 205,
  acoustic: { bpm: 128, camelotKey: '9A', energy: 0.8, valence: 0.7 },
  timeline: [{ ts: 18, type: 'sample_credit', text: 'The chorus uses a hand-played kalimba phrase.' }],
};
const incompatibleTrack = {
  trackId: 't_2003', title: 'Wrong Turn', artist: 'Echo Unit', durationSeconds: 200,
  acoustic: { bpm: 90, camelotKey: '9B', energy: 0.1, valence: 0.1 }, timeline: [],
};

function makeService({ provider, sentimentService = createRoomSentimentService() } = {}) {
  const loungeModel = { findOne: jest.fn(({ loungeId: requestedId }) => new Query(lounges.get(requestedId) ?? null)) };
  const trackModel = {
    findOne: jest.fn(({ trackId }) => new Query(tracks.get(trackId) ?? null)),
    find: jest.fn(({ trackId }) => new Query((trackId?.$in ?? []).map((id) => tracks.get(id)).filter(Boolean))),
  };
  return createSegueService({ loungeModel, trackModel, sentimentService, ...(provider ? { transitionProvider: provider } : {}) });
}
function input(overrides = {}) {
  return { currentTrackId: 't_2001', currentTs: 198, candidateTrackIds: ['t_2002', 't_2003'], currentSentimentScore: 0.72, ...overrides };
}
function accessToken(userId) {
  return jwt.sign({}, process.env.JWT_ACCESS_SECRET, { subject: userId, issuer: 'astradj-api', audience: 'astradj-client', expiresIn: 900, algorithm: 'HS256' });
}

beforeEach(() => {
  users.clear(); lounges.clear(); tracks.clear();
  users.set(memberId, { _id: memberId, id: memberId, email: 'member@example.invalid', displayName: 'Lounge Member', role: 'Listener' });
  users.set(outsiderId, { _id: outsiderId, id: outsiderId, email: 'outsider@example.invalid', displayName: 'Outsider', role: 'Listener' });
  lounges.set(loungeId, {
    loungeId, status: 'live', currentTrackId: 't_2001', participantIds: [memberId],
    settings: { bpmTolerancePct: 8 },
  });
  [currentTrack, selectedTrack, incompatibleTrack].forEach((track) => tracks.set(track.trackId, structuredClone(track)));
  jest.clearAllMocks();
});

test('selects an eligible segue and returns a grounded deterministic fallback plus source references', async () => {
  const service = makeService();
  const result = await service.requestSegue({ loungeId, userId: memberId, input: input() });
  expect(result.selectedTrackId).toBe('t_2002');
  expect(result.matchReason).toMatchObject({ bpmDeltaPct: 3.23, bpmRelation: 'direct', camelotRelation: 'adjacent' });
  expect(result.transitionScript).toContain('AstraDJ deterministic fallback');
  expect(result.transitionScript).toContain('The chorus uses a hand-played kalimba phrase.');
  expect(result.transitionScript).not.toContain('invented');
  expect(result.sourceEvents).toEqual(['t_2002#timeline[0]']);
  expect(result.provider).toBe('deterministic_fallback');
});

test('excludes incompatible and unknown candidates and returns a clear no-match result', async () => {
  const service = makeService();
  const result = await service.requestSegue({ loungeId, userId: memberId, input: input({ candidateTrackIds: ['t_2003', 't_9999'] }) });
  expect(result).toMatchObject({ selectedTrackId: null, matchReason: null, transitionScript: null, sourceEvents: [], reason: 'NO_COMPATIBLE_CANDIDATE' });
});

test('requires Lounge membership and the current Lounge track', async () => {
  const service = makeService();
  await expect(service.requestSegue({ loungeId, userId: outsiderId, input: input() })).rejects.toMatchObject({ code: 'LOUNGE_MEMBERSHIP_REQUIRED', status: 403 });
  await expect(service.requestSegue({ loungeId, userId: memberId, input: input({ currentTrackId: 't_2002' }) })).rejects.toMatchObject({ code: 'CURRENT_TRACK_MISMATCH', status: 409 });
  await expect(service.requestSegue({ loungeId, userId: memberId, input: input({ currentTs: 221 }) })).rejects.toMatchObject({ code: 'CURRENT_TS_OUT_OF_RANGE', status: 400 });
});

test('uses an injected transition provider without changing the matching decision', async () => {
  const provider = {
    name: 'test-provider',
    generate: jest.fn(async ({ selectedTrack, currentTrack }) => ({
      transitionScript: `Provider used only supplied metadata: ${currentTrack.title} to ${selectedTrack.title}.`,
      sourceEvents: ['provider-source'],
      provider: 'test-provider',
    })),
  };
  const result = await makeService({ provider }).requestSegue({ loungeId, userId: memberId, input: input() });
  expect(provider.generate).toHaveBeenCalledWith(expect.objectContaining({ currentTrack: expect.objectContaining({ trackId: 't_2001' }), selectedTrack: expect.objectContaining({ trackId: 't_2002' }) }));
  expect(result.selectedTrackId).toBe('t_2002');
  expect(result.provider).toBe('test-provider');
});

test('uses reliable rolling Lounge sentiment for matcher energy fit and neutral fallback for sparse data', async () => {
  const sentimentService = createRoomSentimentService();
  const service = makeService({ sentimentService });
  const before = await service.requestSegue({ loungeId, userId: memberId, input: input({ currentSentimentScore: 1 }) });
  expect(before.matchReason.targetEnergy).toBe(0.78);
  sentimentService.record(loungeId, { sentimentBucket: 'positive' });
  sentimentService.record(loungeId, { sentimentBucket: 'positive' });
  sentimentService.record(loungeId, { sentimentBucket: 'positive' });
  const after = await service.requestSegue({ loungeId, userId: memberId, input: input({ currentSentimentScore: 0 }) });
  expect(after.matchReason.targetEnergy).toBe(0.98);
});

test('HTTP endpoint requires authentication, Lounge membership, and a valid payload', async () => {
  const url = `/api/v1/lounges/${loungeId}/ai/segue`;
  const payload = input();
  expect((await request(app).post(url).send(payload)).status).toBe(401);
  const outsider = await request(app).post(url).set('Authorization', `Bearer ${accessToken(outsiderId)}`).send(payload);
  expect(outsider.status).toBe(403);
  const invalid = await request(app).post(url).set('Authorization', `Bearer ${accessToken(memberId)}`).send(input({ currentSentimentScore: 1.2 }));
  expect(invalid.status).toBe(400);
  const duplicateIds = await request(app).post(url).set('Authorization', `Bearer ${accessToken(memberId)}`).send(input({ candidateTrackIds: ['t_2002', 't_2002'] }));
  expect(duplicateIds.status).toBe(400);
  const response = await request(app).post(url).set('Authorization', `Bearer ${accessToken(memberId)}`).send(payload);
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ selectedTrackId: 't_2002', provider: 'deterministic_fallback', sourceEvents: ['t_2002#timeline[0]'] });
});
