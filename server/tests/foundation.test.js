import { jest } from '@jest/globals';
import crypto from 'node:crypto';
import request from 'supertest';

const users = new Map();
const refreshTokens = new Map();
const tracks = new Map();
const lounges = new Map();

class Query {
  constructor(run) { this.run = run; this.offset = 0; this.limitValue = Infinity; }
  select() { return this; }
  sort() { return this; }
  skip(value) { this.offset = value; return this; }
  limit(value) { this.limitValue = value; return this; }
  lean() { return this; }
  then(resolve, reject) { return Promise.resolve().then(this.run).then(resolve, reject); }
}
const User = {
  create: jest.fn(async (data) => {
    const id = crypto.randomUUID();
    const user = { ...data, id, _id: id, createdAt: new Date() };
    users.set(id, user);
    return user;
  }),
  findOne: jest.fn((filter) => new Query(() => [...users.values()].find((u) => u.email === filter.email) ?? null)),
  findById: jest.fn((id) => new Query(() => users.get(String(id)) ?? null)),
};
const RefreshToken = {
  create: jest.fn(async (data) => {
    const id = crypto.randomUUID();
    const record = { ...data, id, _id: id, revokedAt: null };
    refreshTokens.set(record.tokenHash, record);
    return record;
  }),
  findOne: jest.fn((filter) => new Query(() => {
    const record = refreshTokens.get(filter.tokenHash);
    return record && !record.revokedAt && record.expiresAt > filter.expiresAt.$gt ? record : null;
  })),
  findOneAndUpdate: jest.fn(async (filter, update) => {
    const record = [...refreshTokens.values()].find((token) => token.id === String(filter._id) && !token.revokedAt);
    if (!record) return null;
    record.revokedAt = update.$set.revokedAt;
    return record;
  }),
  countDocuments: jest.fn(async ({ userId }) => [...refreshTokens.values()].filter((token) => token.userId === String(userId) && !token.revokedAt && token.expiresAt > new Date()).length),
  updateOne: jest.fn(async ({ tokenHash }, update) => {
    const record = refreshTokens.get(tokenHash);
    if (record && !record.revokedAt) record.revokedAt = update.$set.revokedAt;
    return { modifiedCount: record ? 1 : 0 };
  }),
};
const CAMELOT_KEYS = Object.freeze(['1A','1B','2A','2B','3A','3B','4A','4B','5A','5B','6A','6B','7A','7B','8A','8B','9A','9B','10A','10B','11A','11B','12A','12B']);
const matches = (track, filter) => !filter.$or || filter.$or.some((condition) => Object.entries(condition).some(([key, regex]) => regex.test(track[key])));
const Track = {
  find: jest.fn((filter) => {
    const query = new Query(() => [...tracks.values()].filter((track) => matches(track, filter)).sort((a, b) => a.title.localeCompare(b.title)).slice(query.offset, query.offset + query.limitValue));
    return query;
  }),
  countDocuments: jest.fn(async (filter) => [...tracks.values()].filter((track) => matches(track, filter)).length),
  findOne: jest.fn((filter) => new Query(() => {
    const track = [...tracks.values()].find((item) => item.trackId === filter.trackId);
    if (!track) return null;
    return { trackId: track.trackId, title: track.title, artist: track.artist, acoustic: track.acoustic, timeline: track.timeline };
  })),
  create: jest.fn(async (data) => {
    const track = { ...structuredClone(data), id: crypto.randomUUID() };
    tracks.set(track.trackId, track);
    return track;
  }),
  findById: jest.fn((id) => new Query(() => [...tracks.values()].find((track) => track.id === String(id)) ?? null)),
};
const DJLounge = {
  create: jest.fn(async (data) => {
    const lounge = { ...structuredClone(data), hostUserId: String(data.hostUserId), createdAt: new Date(data.createdAt) };
    lounges.set(lounge.loungeId, lounge);
    return lounge;
  }),
};

await jest.unstable_mockModule('../src/models/User.js', () => ({ User }));
await jest.unstable_mockModule('../src/models/RefreshToken.js', () => ({ RefreshToken }));
await jest.unstable_mockModule('../src/models/Track.js', () => ({ Track, CAMELOT_KEYS }));
await jest.unstable_mockModule('../src/models/DJLounge.js', () => ({ DJLounge }));
const { app } = await import('../src/app.js');
const { seedTracks } = await import('../src/seed/tracks.js');

beforeEach(() => {
  users.clear(); refreshTokens.clear(); tracks.clear(); lounges.clear();
  jest.clearAllMocks();
});

describe('authentication HTTP contract', () => {
  test('registers a Listener even when the request attempts to assign Admin', async () => {
    const agent = request.agent(app);
    const response = await agent.post('/api/v1/auth/register').send({ email: 'Guest@Example.com', displayName: 'Guest', password: 'correct-horse-42', role: 'Admin' });
    expect(response.status).toBe(201);
    expect(response.body.user.role).toBe('Listener');
    expect(response.body.expiresIn).toBeLessThanOrEqual(3600);
    expect(response.headers['set-cookie'][0]).toMatch(/HttpOnly/);
    const me = await agent.get('/api/v1/auth/me').set('Authorization', `Bearer ${response.body.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.user.role).toBe('Listener');
    const stored = [...users.values()][0];
    expect(stored.passwordHash).not.toBe('correct-horse-42');
  });

  test('logs in and rotates refresh tokens while rejecting replay', async () => {
    const agent = request.agent(app);
    await agent.post('/api/v1/auth/register').send({ email: 'dj@example.com', displayName: 'DJ', password: 'correct-horse-42' });
    const login = await agent.post('/api/v1/auth/login').send({ email: 'dj@example.com', password: 'correct-horse-42' });
    expect(login.status).toBe(200);
    const oldCookie = login.headers['set-cookie'][0].split(';')[0];
    const refresh = await agent.post('/api/v1/auth/refresh');
    expect(refresh.status).toBe(200);
    expect(refresh.body.accessToken).toBeTruthy();
    expect([...refreshTokens.values()].filter((token) => !token.revokedAt)).toHaveLength(2);
    expect((await request(app).post('/api/v1/auth/refresh').set('Cookie', oldCookie)).status).toBe(401);
  });

  test('rejects invalid registration and credentials', async () => {
    const invalid = await request(app).post('/api/v1/auth/register').send({ email: 'nope', displayName: '<admin>', password: 'short', role: 'Admin' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('VALIDATION_ERROR');
    const login = await request(app).post('/api/v1/auth/login').send({ email: 'none@example.com', password: 'wrong-password' });
    expect(login.status).toBe(401);
  });
});

describe('track catalog and acoustic-profile HTTP contract', () => {
  beforeEach(() => seedTracks.forEach((track) => tracks.set(track.trackId, structuredClone(track))));

  test('returns catalog entries and exact PRD acoustic profile fields', async () => {
    const catalog = await request(app).get('/api/v1/tracks?limit=2&skip=0');
    expect(catalog.status).toBe(200);
    expect(catalog.body.items).toHaveLength(2);
    expect(catalog.body.page).toEqual({ limit: 2, skip: 0, total: 3 });
    const profile = await request(app).get('/api/v1/tracks/t_2001/acoustic-profile');
    expect(profile.status).toBe(200);
    expect(profile.body).toEqual({
      trackId: 't_2001', title: 'Night Drive', artist: 'Nova Circuit',
      acoustic: { bpm: 124, camelotKey: '8A', energy: 0.78, valence: 0.65 },
      timeline: expect.arrayContaining([expect.objectContaining({ ts: 12, type: 'sample_credit' })]),
    });
  });

  test('rejects invalid pagination and profile IDs and returns 404 for an unknown track', async () => {
    expect((await request(app).get('/api/v1/tracks?limit=101')).status).toBe(400);
    expect((await request(app).get('/api/v1/tracks/not-a-track/acoustic-profile')).status).toBe(400);
    expect((await request(app).get('/api/v1/tracks/t_9999/acoustic-profile')).status).toBe(404);
  });

  test('restricts acoustic-profile writes to Admin and rejects invalid feature values', async () => {
    const listener = await request(app).post('/api/v1/auth/register').send({ email: 'listener@example.com', displayName: 'Listener', password: 'correct-horse-42' });
    const forbidden = await request(app).post('/api/v1/tracks').set('Authorization', `Bearer ${listener.body.accessToken}`).send(seedTracks[0]);
    expect(forbidden.status).toBe(403);

    const admin = await User.create({ email: 'admin@example.com', displayName: 'Admin', passwordHash: 'hash', role: 'Admin' });
    // Test the server role guard independently by using a real signed Admin JWT.
    const jwt = await import('jsonwebtoken');
    const token = jwt.default.sign({ role: 'Admin' }, process.env.JWT_ACCESS_SECRET, { subject: admin.id, issuer: 'astradj-api', audience: 'astradj-client', expiresIn: 900, algorithm: 'HS256' });
    const bad = await request(app).post('/api/v1/tracks').set('Authorization', `Bearer ${token}`).send({
      trackId: 't_bad', title: 'Broken', artist: 'Someone', durationSeconds: 120,
      acoustic: { bpm: -1, camelotKey: '13Z', energy: 1.2, valence: -0.1 }, timeline: [],
    });
    expect(bad.status).toBe(400);
    const good = await request(app).post('/api/v1/tracks').set('Authorization', `Bearer ${token}`).send({
      trackId: 't_3001', title: 'Safe Harbor', artist: 'Morning Array', durationSeconds: 180,
      acoustic: { bpm: 126, camelotKey: '9A', energy: 0.7, valence: 0.8 }, timeline: [{ ts: 20, type: 'trivia', text: 'Fictional catalog entry.' }],
    });
    expect(good.status).toBe(201);
    expect(good.body.acoustic.camelotKey).toBe('9A');
  });
});

test('health endpoint reports API status without secrets', async () => {
  const response = await request(app).get('/health');
  expect(response.status).toBe(200);
  expect(response.body.service).toBe('astradj-api');
  expect(response.body).not.toHaveProperty('env');
});

describe('DJ Lounge creation contract', () => {
  beforeEach(() => seedTracks.forEach((track) => tracks.set(track.trackId, structuredClone(track))));

  test('allows a Host to create a Lounge using the PRD payload and response shape', async () => {
    const host = await User.create({ email: 'host@example.com', displayName: 'Host', passwordHash: 'trusted-provisioning', role: 'Host' });
    const jwt = await import('jsonwebtoken');
    const token = jwt.default.sign({ role: 'Host' }, process.env.JWT_ACCESS_SECRET, { subject: host.id, issuer: 'astradj-api', audience: 'astradj-client', expiresIn: 900, algorithm: 'HS256' });
    const response = await request(app).post('/api/v1/lounges').set('Authorization', `Bearer ${token}`).send({
      seedTrackId: 't_2001', vibeProfile: 'High-Energy EDM', maxParticipants: 40,
      bpmTolerancePct: 8, soundclashEnabled: true, aiVerbosity: 'normal',
    });
    expect(response.status).toBe(201);
    expect(Object.keys(response.body).sort()).toEqual(['createdAt', 'hostUserId', 'inviteCode', 'loungeId', 'status']);
    expect(response.body).toMatchObject({ status: 'scheduled', hostUserId: host.id });
    expect(response.body.loungeId).toMatch(/^lg_[a-f0-9]{12}$/);
    expect(response.body.inviteCode).toMatch(/^SP-[A-HJ-NP-Z2-9]{4}$/);
    expect(lounges.get(response.body.loungeId).queue).toEqual(['t_2001']);
  });

  test('rejects Listener role, invalid Lounge settings, and missing seed tracks', async () => {
    const listener = await User.create({ email: 'listener@example.com', displayName: 'Listener', passwordHash: 'hash', role: 'Listener' });
    const jwt = await import('jsonwebtoken');
    const token = jwt.default.sign({ role: 'Listener' }, process.env.JWT_ACCESS_SECRET, { subject: listener.id, issuer: 'astradj-api', audience: 'astradj-client', expiresIn: 900, algorithm: 'HS256' });
    const payload = { seedTrackId: 't_2001', vibeProfile: 'Chill', maxParticipants: 40, bpmTolerancePct: 8, soundclashEnabled: true, aiVerbosity: 'normal' };
    expect((await request(app).post('/api/v1/lounges').set('Authorization', `Bearer ${token}`).send(payload)).status).toBe(403);

    const host = await User.create({ email: 'host2@example.com', displayName: 'Host', passwordHash: 'hash', role: 'Host' });
    const hostToken = jwt.default.sign({ role: 'Host' }, process.env.JWT_ACCESS_SECRET, { subject: host.id, issuer: 'astradj-api', audience: 'astradj-client', expiresIn: 900, algorithm: 'HS256' });
    expect((await request(app).post('/api/v1/lounges').set('Authorization', `Bearer ${hostToken}`).send({ ...payload, maxParticipants: 51 })).status).toBe(400);
    expect((await request(app).post('/api/v1/lounges').set('Authorization', `Bearer ${hostToken}`).send({ ...payload, seedTrackId: 't_9999' })).status).toBe(404);
  });
});

