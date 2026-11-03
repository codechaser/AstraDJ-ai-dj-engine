import { jest } from '@jest/globals';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const camelotKeys = Array.from({ length: 12 }, (_, index) => [`${index + 1}A`, `${index + 1}B`]).flat();
const users = new Map();
const lounges = new Map();
const tracks = new Map();
const metricEvents = [];
const queueEvents = [];

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
  findOneAndUpdate: jest.fn(({ loungeId }, update) => {
    const lounge = lounges.get(loungeId);
    if (lounge) lounge.sessionEventSeq = (lounge.sessionEventSeq ?? 0) + update.$inc.sessionEventSeq;
    return new Query(lounge ?? null);
  }),
};
const LoungeMetricEvent = {
  findOne: jest.fn(({ loungeId, requestId }) => new Query(metricEvents.find((event) => event.loungeId === loungeId && event.requestId === requestId) ?? null)),
  create: jest.fn(async (event) => { metricEvents.push(structuredClone(event)); return event; }),
};
const QueueEvent = {
  find: jest.fn(({ loungeId: requestedLoungeId, type }) => ({
    events: queueEvents.filter((event) => event.loungeId === requestedLoungeId && event.type === type),
    sort() { this.events.sort((a, b) => a.seq - b.seq); return this; },
    limit() { return this; },
    lean() { return Promise.resolve(this.events); },
  })),
};

await jest.unstable_mockModule('../src/models/User.js', () => ({ User }));
await jest.unstable_mockModule('../src/models/RefreshToken.js', () => ({ RefreshToken }));
await jest.unstable_mockModule('../src/models/Track.js', () => ({ Track, CAMELOT_KEYS: camelotKeys }));
await jest.unstable_mockModule('../src/models/DJLounge.js', () => ({ DJLounge }));
await jest.unstable_mockModule('../src/models/LoungeMetricEvent.js', () => ({ LoungeMetricEvent }));
await jest.unstable_mockModule('../src/models/QueueEvent.js', () => ({ QueueEvent }));

const { app } = await import('../src/app.js');
const { createSegueService, segueService } = await import('../src/services/segueService.js');
const { createRoomSentimentService } = await import('../src/services/roomSentimentService.js');
const { createMemoryRateLimiter } = await import('./support/memoryRateLimiter.js');
const rateLimiter = createMemoryRateLimiter();
app.locals.rateLimiter = rateLimiter;
app.locals.entitlementService = { assertFeature: async () => {}, consumeAiDjRequest: async () => ({ used: 1, limit: 100 }) };

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

beforeEach(async () => {
  await rateLimiter.clear();
  users.clear(); lounges.clear(); tracks.clear(); metricEvents.length = 0; queueEvents.length = 0;
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
  expect(result.transitionScript).toContain('Tempo 124 to 128 BPM');
  expect(result.transitionScript).toContain('Camelot 8A to 9A (adjacent)');
  expect(result.sourceEvents).toEqual([
    't_2001#title', 't_2001#artist', 't_2002#title', 't_2002#artist',
    't_2001#acoustic.bpm', 't_2002#acoustic.bpm', 't_2001#acoustic.camelotKey', 't_2002#acoustic.camelotKey',
    't_2001#acoustic.energy', 't_2002#acoustic.energy', 't_2001#timeline[0]', 't_2002#timeline[0]',
  ]);
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
      sourceEvents: [`${currentTrack.trackId}#title`, `${selectedTrack.trackId}#title`],
      provider: 'test-provider',
    })),
  };
  const result = await makeService({ provider }).requestSegue({ loungeId, userId: memberId, input: input() });
  expect(provider.generate).toHaveBeenCalledWith(expect.objectContaining({ currentTrack: expect.objectContaining({ trackId: 't_2001' }), selectedTrack: expect.objectContaining({ trackId: 't_2002' }) }));
  expect(result.selectedTrackId).toBe('t_2002');
  expect(result.provider).toBe('test-provider');
});

test('rejects transition provider references that do not resolve to either source track and uses grounded fallback', async () => {
  const provider = {
    name: 'test-provider',
    generate: jest.fn(async () => ({ transitionScript: 'Unsupported claim with no source.', sourceEvents: ['t_missing#timeline[88]'] })),
  };
  const result = await makeService({ provider }).requestSegue({ loungeId, userId: memberId, input: input() });
  expect(result.provider).toBe('deterministic_fallback');
  expect(result.transitionScript).toContain('AstraDJ deterministic fallback');
  expect(result.transitionScript).toContain('The chorus uses a hand-played kalimba phrase.');
  expect(result.sourceEvents).not.toContain('t_missing#timeline[88]');
});

test('deterministic segue citations resolve to metadata on the current or selected track', async () => {
  const result = await makeService().requestSegue({ loungeId, userId: memberId, input: input() });
  const sourceTracks = new Map([[currentTrack.trackId, currentTrack], [selectedTrack.trackId, selectedTrack]]);
  expect(result.sourceEvents.length).toBeGreaterThan(0);
  for (const reference of result.sourceEvents) {
    const [trackId, pointer] = reference.split('#');
    const sourceTrack = sourceTracks.get(trackId);
    expect(sourceTrack).toBeDefined();
    const exists = pointer === 'title' || pointer === 'artist'
      ? Boolean(sourceTrack[pointer])
      : pointer.startsWith('acoustic.')
        ? Number.isFinite(sourceTrack.acoustic?.[pointer.slice('acoustic.'.length)]) || typeof sourceTrack.acoustic?.[pointer.slice('acoustic.'.length)] === 'string'
        : Boolean(sourceTrack.timeline[Number(pointer.match(/^timeline\[(\d+)\]$/)?.[1])]);
    expect(exists).toBe(true);
  }
});

test('uses deterministic grounded banter when an injected transition provider fails and publishes the PRD announcement payload', async () => {
  const onAnnouncement = jest.fn();
  const service = createSegueService({
    loungeModel: { findOne: jest.fn(({ loungeId: id }) => new Query(lounges.get(id) ?? null)) },
    trackModel: {
      findOne: jest.fn(({ trackId }) => new Query(tracks.get(trackId) ?? null)),
      find: jest.fn(({ trackId }) => new Query((trackId?.$in ?? []).map((id) => tracks.get(id)).filter(Boolean))),
    },
    transitionProvider: { name: 'unavailable-provider', generate: jest.fn(async () => { throw new Error('provider unavailable'); }) },
    onAnnouncement,
  });
  const result = await service.requestSegue({ loungeId, userId: memberId, input: input() });
  expect(result.provider).toBe('deterministic_fallback');
  expect(result.transitionScript).toContain('The chorus uses a hand-played kalimba phrase.');
  expect(onAnnouncement).toHaveBeenCalledWith(loungeId, {
    text: result.transitionScript,
    relatedTrackId: 't_2002',
    sourceEvents: result.sourceEvents,
  });
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
  expect(response.body).toMatchObject({ selectedTrackId: 't_2002', provider: 'deterministic_fallback', sourceEvents: expect.arrayContaining(['t_2001#acoustic.bpm', 't_2002#timeline[0]']) });
});

test('successful segue REST request publishes the exact Lounge-scoped PRD announcement payload', async () => {
  const publisher = jest.fn();
  segueService.setAnnouncementPublisher(publisher);
  const response = await request(app).post(`/api/v1/lounges/${loungeId}/ai/segue`)
    .set('Authorization', `Bearer ${accessToken(memberId)}`).send(input());
  expect(response.status).toBe(200);
  expect(publisher).toHaveBeenCalledWith(loungeId, {
    text: response.body.transitionScript,
    relatedTrackId: response.body.selectedTrackId,
    sourceEvents: response.body.sourceEvents,
  });
  segueService.setAnnouncementPublisher(() => {});
});

test('disabled AI commentary keeps acoustic selection but suppresses script generation and announcement output', async () => {
  users.get(memberId).preferences = { audio: { aiDjCommentary: false } };
  const publisher = jest.fn();
  segueService.setAnnouncementPublisher(publisher);
  const response = await request(app).post(`/api/v1/lounges/${loungeId}/ai/segue`)
    .set('Authorization', `Bearer ${accessToken(memberId)}`).send(input());
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ selectedTrackId: 't_2002', transitionScript: null, sourceEvents: [], provider: 'disabled' });
  expect(publisher).not.toHaveBeenCalled();
  segueService.setAnnouncementPublisher(() => {});
});

test('track Q&A REST contract authenticates, enforces Lounge membership, validates input, and grounds answers', async () => {
  const url = `/api/v1/lounges/${loungeId}/ai/ask`;
  expect((await request(app).post(url).send({ question: 'What is the BPM?' })).status).toBe(401);
  const outsider = await request(app).post(url).set('Authorization', `Bearer ${accessToken(outsiderId)}`).set('Idempotency-Key', 'request-0000').send({ question: 'What is the BPM?' });
  expect(outsider.status).toBe(403);
  const oversized = await request(app).post(url).set('Authorization', `Bearer ${accessToken(memberId)}`).set('Idempotency-Key', 'request-0001').send({ question: 'x'.repeat(501) });
  expect(oversized.status).toBe(400);
  const unexpectedField = await request(app).post(url).set('Authorization', `Bearer ${accessToken(memberId)}`).set('Idempotency-Key', 'request-0001').send({ question: 'What is the BPM?', loungeId: 'lg_otherroom' });
  expect(unexpectedField.status).toBe(400);
  expect((await request(app).post(url).set('Authorization', `Bearer ${accessToken(memberId)}`).send({ question: 'What is the BPM?' })).status).toBe(400);
  const bpm = await request(app).post(url).set('Authorization', `Bearer ${accessToken(memberId)}`).set('Idempotency-Key', 'request-0001').send({ question: 'What is the BPM?' });
  expect(bpm.status).toBe(200);
  expect(bpm.body).toMatchObject({ trackId: 't_2001', answer: 'The catalog lists the BPM as 124 BPM.', sourceEvents: ['t_2001#acoustic.bpm'], grounded: true, provider: 'deterministic_metadata_retrieval' });
  const unsupported = await request(app).post(url).set('Authorization', `Bearer ${accessToken(memberId)}`).set('Idempotency-Key', 'request-0002').send({ question: 'What are the lyrics about?' });
  expect(unsupported.body).toMatchObject({ grounded: false, sourceEvents: [] });
  const retry = await request(app).post(url).set('Authorization', `Bearer ${accessToken(memberId)}`).set('Idempotency-Key', 'request-0001').send({ question: 'What is the BPM?' });
  expect(retry.status).toBe(200);
  expect(metricEvents.filter((event) => event.type === 'ai.question.asked')).toHaveLength(2);
  expect(metricEvents[0]).not.toHaveProperty('question');
});
