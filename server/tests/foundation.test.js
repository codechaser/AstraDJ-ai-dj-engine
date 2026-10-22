import { jest } from '@jest/globals';
import crypto from 'node:crypto';
import request from 'supertest';

const users = new Map();
const refreshTokens = new Map();
const tracks = new Map();
const lounges = new Map();
const interactions = [];

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
  findByIdAndUpdate: jest.fn((id, update) => new Query(() => {
    const user = users.get(String(id));
    if (!user) return null;
    for (const [path, value] of Object.entries(update.$set ?? {})) {
      const parts = path.split('.');
      let target = user;
      while (parts.length > 1) {
        const part = parts.shift();
        target[part] ??= {};
        target = target[part];
      }
      target[parts[0]] = value;
    }
    return user;
  })),
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
  findOneAndUpdate: jest.fn((filter, update) => new Query(() => {
    const track = tracks.get(filter.trackId);
    if (!track) return null;
    track.acoustic = structuredClone(update.$set.acoustic);
    return structuredClone(track);
  })),
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
await jest.unstable_mockModule('../src/services/recommendationRepository.js', () => ({
  recommendationRepository: {
    async getTrack(trackId) { return tracks.get(trackId) ?? null; },
    async listTracks() { return [...tracks.values()]; },
    async createInteraction(data) { const interaction = { coListenedWith: [], ...structuredClone(data), _id: crypto.randomUUID(), createdAt: new Date() }; interactions.push(interaction); return interaction; },
    async listInteractionsForUser(userId) { return interactions.filter((entry) => String(entry.userId) === String(userId)); },
    async listInteractionsForUsers(userIds) { return interactions.filter((entry) => userIds.includes(String(entry.userId))); },
    async getRecentCoListenerIds({ loungeId, trackId, userId, since }) { return [...new Set(interactions.filter((entry) => entry.loungeId === loungeId && entry.trackId === trackId && String(entry.userId) !== String(userId) && entry.createdAt >= since).map((entry) => String(entry.userId)))]; },
    async linkCoListeners({ interactionId, loungeId, trackId, userId, coListenerIds, since }) {
      const current = interactions.find((entry) => String(entry._id) === String(interactionId));
      if (current) current.coListenedWith.push(...coListenerIds);
      for (const entry of interactions) if (entry.loungeId === loungeId && entry.trackId === trackId && entry.createdAt >= since && coListenerIds.includes(String(entry.userId))) entry.coListenedWith.push(String(userId));
    },
    async findLounge(loungeId) { return lounges.get(loungeId) ?? null; },
  },
}));
const { app } = await import('../src/app.js');
const { seedTracks } = await import('../src/seed/tracks.js');

beforeEach(() => {
  users.clear(); refreshTokens.clear(); tracks.clear(); lounges.clear(); interactions.splice(0);
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

describe('authenticated user audio preferences contract', () => {
  async function account(email) {
    const created = await request(app).post('/api/v1/auth/register').send({ email, displayName: email.split('@')[0], password: 'correct-horse-42' });
    return { token: created.body.accessToken, id: created.body.user.id };
  }

  test('requires authentication and reads defaults, then persists only the authenticated account fields', async () => {
    expect((await request(app).get('/api/v1/auth/me/preferences')).status).toBe(401);
    const first = await account('settings-a@example.com');
    const second = await account('settings-b@example.com');
    const defaults = await request(app).get('/api/v1/auth/me/preferences').set('Authorization', `Bearer ${first.token}`);
    expect(defaults.status).toBe(200);
    expect(defaults.body.preferences.audio).toMatchObject({ streamingQuality: 'High (320 kbps)', crossfadeSeconds: 6, autoPlay: true });
    const saved = await request(app).patch('/api/v1/auth/me/preferences').set('Authorization', `Bearer ${first.token}`).send({ audio: { streamingQuality: 'Normal (160 kbps)', crossfadeSeconds: 12, normalizeVolume: false } });
    expect(saved.status).toBe(200);
    expect(saved.body.preferences.audio).toMatchObject({ streamingQuality: 'Normal (160 kbps)', crossfadeSeconds: 12, normalizeVolume: false, showLyrics: true });
    const isolated = await request(app).get('/api/v1/auth/me/preferences').set('Authorization', `Bearer ${second.token}`);
    expect(isolated.body.preferences.audio).toMatchObject({ streamingQuality: 'High (320 kbps)', crossfadeSeconds: 6, normalizeVolume: true });
    expect([...users.values()].find((user) => user.id === first.id).preferences.audio.streamingQuality).toBe('Normal (160 kbps)');
    expect([...users.values()].find((user) => user.id === second.id).preferences).toBeUndefined();
  });

  test('rejects unsupported fields, invalid values, and empty patches without modifying preferences', async () => {
    const { token, id } = await account('settings-invalid@example.com');
    const url = '/api/v1/auth/me/preferences';
    const auth = { Authorization: `Bearer ${token}` };
    for (const body of [
      { audio: { streamingQuality: 'Lossless' } },
      { audio: { crossfadeSeconds: 7 } },
      { audio: { autoPlay: 'yes' } },
      { audio: { hackedField: 'value' } },
      { audio: {} },
      { role: 'Admin', audio: { autoPlay: false } },
    ]) {
      const response = await request(app).patch(url).set(auth).send(body);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('INVALID_PREFERENCES');
    }
    expect(users.get(id).preferences).toBeUndefined();
  });
});

describe('track catalog and acoustic-profile HTTP contract', () => {
  beforeEach(() => seedTracks.forEach((track) => tracks.set(track.trackId, structuredClone(track))));

  test('returns catalog entries and exact PRD acoustic profile fields', async () => {
    const catalog = await request(app).get('/api/v1/tracks?limit=2&skip=0');
    expect(catalog.status).toBe(200);
    expect(catalog.body.items).toHaveLength(2);
    expect(catalog.body.page).toEqual({ limit: 2, skip: 0, total: 4 });
    const demo = await request(app).get('/api/v1/tracks?q=Thoughtness');
    expect(demo.body.items).toContainEqual(expect.objectContaining({
      trackId: 't_cc0_thoughtness', title: 'Thoughtness', artist: 'Kian Moretz', durationSeconds: 46,
      audioAssetUrl: '/audio/thoughtness.ogg', acoustic: null,
    }));
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
    const demoProfile = await request(app).get('/api/v1/tracks/t_cc0_thoughtness/acoustic-profile');
    expect(demoProfile.status).toBe(409);
    expect(demoProfile.body.error.code).toBe('ACOUSTIC_PROFILE_UNAVAILABLE');
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

  test('Admin can create or replace an existing track acoustic profile and the matcher reads the saved values', async () => {
    const { default: jwt } = await import('jsonwebtoken');
    const admin = await User.create({ email: 'profile-admin@example.com', displayName: 'Profile Admin', passwordHash: 'test-only', role: 'Admin' });
    const token = jwt.sign({}, process.env.JWT_ACCESS_SECRET, { subject: admin.id, issuer: 'astradj-api', audience: 'astradj-client', expiresIn: 900, algorithm: 'HS256' });
    const missingBefore = await request(app).get('/api/v1/tracks?q=Thoughtness');
    expect(missingBefore.body.items.find((item) => item.trackId === 't_cc0_thoughtness').acoustic).toBeNull();

    const created = await request(app).put('/api/v1/tracks/t_cc0_thoughtness/acoustic-profile')
      .set('Authorization', `Bearer ${token}`)
      .send({ acoustic: { bpm: 130, camelotKey: '10A', energy: 0, valence: 1 } });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ trackId: 't_cc0_thoughtness', acoustic: { bpm: 130, camelotKey: '10A', energy: 0, valence: 1 } });
    expect((await request(app).get('/api/v1/tracks/t_cc0_thoughtness/acoustic-profile')).body.acoustic).toEqual(created.body.acoustic);
    const { matchSegueCandidate } = await import('../src/services/acousticMatcher.js');
    expect(matchSegueCandidate(tracks.get('t_2001'), tracks.get('t_cc0_thoughtness')).eligible).toBe(false);
    expect(matchSegueCandidate(tracks.get('t_2001'), tracks.get('t_cc0_thoughtness')).reasonCode).toBe('CAMELOT_INCOMPATIBLE');
    const updated = await request(app).put('/api/v1/tracks/t_cc0_thoughtness/acoustic-profile')
      .set('Authorization', `Bearer ${token}`)
      .send({ acoustic: { bpm: 126, camelotKey: '9A', energy: 0.7, valence: 0.8 } });
    expect(updated.body.acoustic).toEqual({ bpm: 126, camelotKey: '9A', energy: 0.7, valence: 0.8 });
    const current = { ...tracks.get('t_2001'), acoustic: { bpm: 126, camelotKey: '8A', energy: 0.7, valence: 0.6 } };
    expect(matchSegueCandidate(current, tracks.get('t_cc0_thoughtness')).eligible).toBe(true);
    expect(tracks.get('t_2003').acoustic).toEqual(seedTracks.find((track) => track.trackId === 't_2003').acoustic);
  });

  test('acoustic profile write checks persisted Admin role and denies all other roles and anonymous requests', async () => {
    const { default: jwt } = await import('jsonwebtoken');
    const profile = { acoustic: { bpm: 120, camelotKey: '8A', energy: 0.5, valence: 0.5 } };
    expect((await request(app).put('/api/v1/tracks/t_cc0_thoughtness/acoustic-profile').send(profile)).status).toBe(401);
    for (const role of ['Listener', 'Co-DJ', 'Host']) {
      const user = await User.create({ email: `${role}@profile.example`, displayName: role, passwordHash: 'test-only', role });
      const token = jwt.sign({}, process.env.JWT_ACCESS_SECRET, { subject: user.id, issuer: 'astradj-api', audience: 'astradj-client', expiresIn: 900, algorithm: 'HS256' });
      const denied = await request(app).put('/api/v1/tracks/t_cc0_thoughtness/acoustic-profile').set('Authorization', `Bearer ${token}`).send(profile);
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe('FORBIDDEN');
    }
  });

  test('acoustic profile writes reject missing, malformed, non-finite, out-of-range and unknown fields', async () => {
    const { default: jwt } = await import('jsonwebtoken');
    const admin = await User.create({ email: 'validation-admin@example.com', displayName: 'Validation Admin', passwordHash: 'test-only', role: 'Admin' });
    const token = jwt.sign({}, process.env.JWT_ACCESS_SECRET, { subject: admin.id, issuer: 'astradj-api', audience: 'astradj-client', expiresIn: 900, algorithm: 'HS256' });
    const invalidBodies = [
      {},
      { acoustic: { bpm: 0, camelotKey: '8A', energy: 0.5, valence: 0.5 } },
      { acoustic: { bpm: 0.5, camelotKey: '8A', energy: 0.5, valence: 0.5 } },
      { acoustic: { bpm: 301, camelotKey: '8A', energy: 0.5, valence: 0.5 } },
      { acoustic: { bpm: 121, camelotKey: '13A', energy: 0.5, valence: 0.5 } },
      { acoustic: { bpm: 121, camelotKey: '8A', energy: -0.01, valence: 0.5 } },
      { acoustic: { bpm: 121, camelotKey: '8A', energy: 0.5, valence: 1.01 } },
      { acoustic: { bpm: '121', camelotKey: '8A', energy: 0.5, valence: 0.5 } },
      { acoustic: { bpm: 121, camelotKey: '8A', energy: 0.5, valence: 0.5, source: 'guessed' } },
      { acoustic: { bpm: 121, camelotKey: '8A', energy: 0.5, valence: 0.5 }, title: 'unsupported' },
    ];
    for (const body of invalidBodies) {
      const response = await request(app).put('/api/v1/tracks/t_cc0_thoughtness/acoustic-profile').set('Authorization', `Bearer ${token}`).send(body);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(response.body.error.details.length).toBeGreaterThan(0);
    }
    const missingTrack = await request(app).put('/api/v1/tracks/t_9999/acoustic-profile').set('Authorization', `Bearer ${token}`)
      .send({ acoustic: { bpm: 120, camelotKey: '8A', energy: 0.5, valence: 0.5 } });
    expect(missingTrack.status).toBe(404);
  });
});

describe('authenticated interaction collection and private recommendations', () => {
  let userA;
  let userB;
  let tokenA;
  let tokenB;
  beforeEach(async () => {
    seedTracks.forEach((track) => tracks.set(track.trackId, structuredClone(track)));
    const a = await request(app).post('/api/v1/auth/register').send({ email: 'listener-a@example.com', displayName: 'Listener A', password: 'correct-horse-42' });
    const b = await request(app).post('/api/v1/auth/register').send({ email: 'listener-b@example.com', displayName: 'Listener B', password: 'correct-horse-42' });
    userA = a.body.user.id; userB = b.body.user.id; tokenA = a.body.accessToken; tokenB = b.body.accessToken;
    lounges.set('lg_123456789abc', { loungeId: 'lg_123456789abc', status: 'live', currentTrackId: 't_2001', participantIds: [userA, userB] });
    lounges.set('lg_223456789abc', { loungeId: 'lg_223456789abc', status: 'live', currentTrackId: 't_2001', participantIds: [] });
  });

  test('requires authentication, rejects invalid playback reports, and only records the token owner', async () => {
    expect((await request(app).get('/api/v1/recommendations')).status).toBe(401);
    expect((await request(app).post('/api/v1/interactions').send({ trackId: 't_2001', playedSeconds: 10, completed: false, liked: false })).status).toBe(401);
    const invalid = await request(app).post('/api/v1/interactions').set('Authorization', `Bearer ${tokenA}`).send({ userId: userB, trackId: 't_2001', playedSeconds: 999, completed: false, liked: false });
    expect(invalid.status).toBe(400);
    expect(interactions).toHaveLength(0);
    const valid = await request(app).post('/api/v1/interactions').set('Authorization', `Bearer ${tokenA}`).send({ trackId: 't_2001', playedSeconds: 100, completed: false, liked: true });
    expect(valid.status).toBe(201);
    expect(valid.body).toMatchObject({ trackId: 't_2001', source: 'self_reported', coListenerCount: 0 });
    expect(interactions[0].userId).toBe(userA);
    expect(interactions[0].userId).not.toBe(userB);
  });

  test('records co-listener links only from member reports of the current track in the same live Lounge', async () => {
    const a = await request(app).post('/api/v1/interactions').set('Authorization', `Bearer ${tokenA}`).send({ trackId: 't_2001', playedSeconds: 100, completed: false, liked: true, loungeId: 'lg_123456789abc' });
    const b = await request(app).post('/api/v1/interactions').set('Authorization', `Bearer ${tokenB}`).send({ trackId: 't_2001', playedSeconds: 200, completed: false, liked: true, loungeId: 'lg_123456789abc' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.coListenerCount).toBe(1);
    expect(interactions[0].coListenedWith).toContain(userB);
    expect(interactions[1].coListenedWith).toContain(userA);
    const outsider = await request(app).post('/api/v1/interactions').set('Authorization', `Bearer ${tokenA}`).send({ trackId: 't_2001', playedSeconds: 10, completed: false, liked: false, loungeId: 'lg_223456789abc' });
    expect(outsider.status).toBe(403);
    const otherTrack = await request(app).post('/api/v1/interactions').set('Authorization', `Bearer ${tokenA}`).send({ trackId: 't_2002', playedSeconds: 10, completed: false, liked: false, loungeId: 'lg_123456789abc' });
    expect(otherTrack.status).toBe(409);
  });

  test('recommendation reads are scoped to the authenticated user and validate limits', async () => {
    await request(app).post('/api/v1/interactions').set('Authorization', `Bearer ${tokenA}`).send({ trackId: 't_2001', playedSeconds: 224, completed: true, liked: true });
    await request(app).post('/api/v1/interactions').set('Authorization', `Bearer ${tokenA}`).send({ trackId: 't_2002', playedSeconds: 208, completed: true, liked: true });
    const response = await request(app).get('/api/v1/recommendations?limit=2').set('Authorization', `Bearer ${tokenA}`);
    expect(response.status).toBe(200);
    expect(response.body.strategy).toBe('content_based');
    expect(response.body.items).toHaveLength(1);
    expect(JSON.stringify(response.body)).not.toContain(userA);
    expect(JSON.stringify(response.body)).not.toContain(userB);
    expect((await request(app).get(`/api/v1/recommendations?userId=${userB}`).set('Authorization', `Bearer ${tokenA}`)).status).toBe(400);
    expect((await request(app).get('/api/v1/recommendations?limit=21').set('Authorization', `Bearer ${tokenA}`)).status).toBe(400);
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

