import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { apiRequest, askTrackQuestion, clearAccessToken, createLounge, getLoungeAnalytics, getLoungeHistory, getPreferences, getRecommendations, login, logout, registerAccount, requestSegue, restoreSession, searchTracks, updatePreferences } from '../src/api/client.js';
import { buildCompletionInteraction } from '../src/api/playbackEvents.js';
import { catalogDurationSeconds, formatTrackDuration, groupCatalogArtists, toPlayerTrack, tracksForArtist } from '../src/api/catalogData.js';
import { connectToLounge } from '../src/api/loungeConnection.js';
import { subscribeToLoungeEvents } from '../src/api/loungeEvents.js';
import { applySoundclashEvent, displayAnalyticsMetric, normalizeRecommendations, segueCommentaryText, shouldShowAiDjCommentary, tiedCandidateIds, uniqueChatMessages } from '../src/api/uiData.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; clearAccessToken(); });
const response = (body, status = 200) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('login sends credentials to the backend and keeps the access token in memory', async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return url.endsWith('/auth/login') ? response({ user: { id: 'u1', displayName: 'Mira', role: 'Listener' }, accessToken: 'access-one' }) : response({ user: { id: 'u1' } }); };
  const user = await login({ email: 'mira@example.test', password: 'long-password' });
  assert.equal(user.id, 'u1');
  assert.equal(calls[0].url, '/api/v1/auth/login');
  assert.equal(calls[0].options.credentials, 'include');
  assert.equal(calls[0].options.headers.Authorization, undefined);
  await apiRequest('/auth/me');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer access-one');
});

test('surfaces structured invalid-credential errors without retrying login', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return response({ error: { code: 'INVALID_CREDENTIALS', message: 'Email or password is incorrect' } }, 401); };
  await assert.rejects(login({ email: 'bad@example.test', password: 'wrong' }), (error) => error.code === 'INVALID_CREDENTIALS' && error.status === 401);
  assert.equal(calls, 1);
});

test('audio preferences use the authenticated API and rejected saves surface as errors', async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/auth/login')) return response({ user: { id: 'settings-user' }, accessToken: 'settings-token' });
    if (options.method === 'PATCH') return response({ error: { code: 'INVALID_PREFERENCES', message: 'Unsupported setting' } }, 400);
    return response({ preferences: { audio: { autoPlay: false } } });
  };
  await login({ email: 'settings@example.test', password: 'test-password' });
  assert.deepEqual(await getPreferences(), { preferences: { audio: { autoPlay: false } } });
  await assert.rejects(updatePreferences({ autoPlay: true }), (error) => error.code === 'INVALID_PREFERENCES' && error.message === 'Unsupported setting');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer settings-token');
  assert.equal(calls[2].url, '/api/v1/auth/me/preferences');
  assert.equal(calls[2].options.method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[2].options.body), { audio: { autoPlay: true } });
});

test('registration sends only account fields and accepts the server-derived Listener role', async () => {
  let request;
  globalThis.fetch = async (url, options) => { request = { url, options }; return response({ user: { id: 'u2', displayName: 'Omjee', role: 'Listener' }, accessToken: 'new-token' }, 201); };
  const user = await registerAccount({ email: 'omjee@example.test', displayName: 'Omjee', password: 'long-password' });
  assert.equal(user.role, 'Listener');
  assert.deepEqual(JSON.parse(request.options.body), { email: 'omjee@example.test', displayName: 'Omjee', password: 'long-password' });
  assert.equal(request.url, '/api/v1/auth/register');
});

test('restores a session through the HttpOnly refresh cookie then loads /me', async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return url.endsWith('/auth/refresh')
      ? response({ accessToken: 'restored-token', user: { id: 'u1' } })
      : response({ user: { id: 'u1', displayName: 'Mira', role: 'Listener' } });
  };
  assert.deepEqual(await restoreSession(), { id: 'u1', displayName: 'Mira', role: 'Listener' });
  assert.equal(calls[0].options.credentials, 'include');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer restored-token');
});

test('refreshes once after an expired access token and retries an authorized request', async () => {
  let resourceCalls = 0;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/auth/refresh')) return response({ accessToken: 'fresh-token' });
    if (url.endsWith('/auth/login')) return response({ accessToken: 'old-token', user: { id: 'u1' } });
    resourceCalls += 1;
    return resourceCalls === 1 ? response({ error: { code: 'INVALID_TOKEN', message: 'expired' } }, 401) : response({ ok: true });
  };
  await login({ email: 'mira@example.test', password: 'password' });
  assert.deepEqual(await apiRequest('/recommendations'), { ok: true });
  assert.equal(calls.filter(({ url }) => url.endsWith('/auth/refresh')).length, 1);
  assert.equal(calls.at(-1).options.headers.Authorization, 'Bearer fresh-token');
});

test('clears in-memory credentials on logout and always uses the refresh cookie', async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/auth/login')) return response({ accessToken: 'token', user: { id: 'u1' } });
    if (url.endsWith('/auth/logout')) return response(null, 204);
    return response({ error: { code: 'INVALID_REFRESH_TOKEN', message: 'refresh cookie expired' } }, 401);
  };
  await login({ email: 'mira@example.test', password: 'password' });
  await logout();
  assert.equal(calls.at(-1).url, '/api/v1/auth/logout');
  assert.equal(calls.at(-1).options.credentials, 'include');
  await assert.rejects(apiRequest('/auth/me'), (error) => error.code === 'INVALID_REFRESH_TOKEN');
});

test('only a completed, app-observed audio asset can create a playback interaction', () => {
  const catalogTrack = { trackId: 't_2001', durationSeconds: 224, audioAssetUrl: null };
  assert.equal(buildCompletionInteraction(catalogTrack, 224, true), null);
  assert.equal(buildCompletionInteraction({ ...catalogTrack, trackId: undefined, audioAssetUrl: '/assets/test.ogg' }, 224), null);
  assert.equal(buildCompletionInteraction({ ...catalogTrack, audioAssetUrl: '/assets/test.ogg' }, 215), null);
  assert.deepEqual(buildCompletionInteraction({ ...catalogTrack, audioAssetUrl: '/assets/test.ogg' }, 224.5, true), {
    trackId: 't_2001', playedSeconds: 224, completed: true, liked: true,
  });
  const demoTrack = { trackId: 't_cc0_thoughtness', durationSeconds: 46, audioAssetUrl: '/audio/thoughtness.ogg' };
  assert.deepEqual(buildCompletionInteraction(demoTrack, 46.13224489795918), {
    trackId: 't_cc0_thoughtness', playedSeconds: 46, completed: true, liked: false,
  });
  assert.equal(buildCompletionInteraction(demoTrack, 47.2), null);
  assert.equal(buildCompletionInteraction({ ...demoTrack, audioAssetUrl: null }, 46.132), null);
});

test('catalog search uses the backend query contract without browser credentials', async () => {
  let request;
  globalThis.fetch = async (url, options) => { request = { url: new URL(url, 'http://localhost'), options }; return response({ items: [{ trackId: 't_2001' }], page: { total: 1 } }); };
  const result = await searchTracks('Mira Sol');
  assert.equal(result.items[0].trackId, 't_2001');
  assert.equal(request.url.pathname, '/api/v1/tracks');
  assert.equal(request.url.searchParams.get('q'), 'Mira Sol');
  assert.equal(request.options.headers.Authorization, undefined);
});

test('Host Lounge creation sends the validated PRD request with the authenticated access token', async () => {
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    if (url.endsWith('/auth/login')) return response({ accessToken: 'host-access', user: { id: 'host-1', role: 'Host' } });
    return response({ loungeId: 'lg_123456789abc', inviteCode: 'SP-ABCD', status: 'scheduled', hostUserId: 'host-1', createdAt: '2026-10-21T10:00:00.000Z' }, 201);
  };
  await login({ email: 'host@example.test', password: 'not-a-real-secret' });
  const payload = { seedTrackId: 't_2001', vibeProfile: 'Chill & Focus', maxParticipants: 8, bpmTolerancePct: 8, soundclashEnabled: true, aiVerbosity: 'normal' };
  const created = await createLounge(payload);
  assert.equal(created.inviteCode, 'SP-ABCD');
  assert.equal(request.url, '/api/v1/lounges');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.Authorization, 'Bearer host-access');
  assert.deepEqual(JSON.parse(request.options.body), payload);
});

test('Lounge client rejoins on reconnect, filters cross-room and ended events, and removes listeners on cleanup', () => {
  class FakeSocket {
    handlers = new Map();
    commands = [];
    connected = false;
    on(event, handler) { const group = this.handlers.get(event) ?? new Set(); group.add(handler); this.handlers.set(event, group); }
    off(event, handler) { this.handlers.get(event)?.delete(handler); }
    trigger(event, ...args) { for (const handler of this.handlers.get(event) ?? []) handler(...args); }
    emit(event, payload, ack) {
      this.commands.push({ event, payload });
      if (event === 'lounge.join') ack({ ok: true, loungeId: 'lg_current', state: { loungeId: 'lg_current', nextUp: [] } });
    }
    connect() { this.connected = true; this.trigger('connect'); }
    disconnect() { this.connected = false; this.disconnected = true; }
  }
  const socket = new FakeSocket(), received = [], ended = [], statuses = [];
  const connection = connectToLounge({ inviteCode: 'sp-abcd', token: 'memory-token', origin: 'http://test', ioFactory: () => socket, onQueueUpdate: (event) => received.push(event), onSessionEnded: (event) => ended.push(event), onStatus: (status) => statuses.push(status) });
  assert.deepEqual(socket.commands[0], { event: 'lounge.join', payload: { inviteCode: 'SP-ABCD' } });
  socket.trigger('lounge.queue.update', { loungeId: 'lg_other', payload: {} });
  socket.trigger('lounge.queue.update', { loungeId: 'lg_current', payload: { queue: [] } });
  socket.trigger('lounge.session.ended', { loungeId: 'lg_other', payload: { endedAt: '2026-10-21T00:00:00Z' } });
  socket.trigger('lounge.session.ended', { loungeId: 'lg_current', payload: {} });
  socket.trigger('lounge.session.ended', { loungeId: 'lg_current', payload: { endedAt: '2026-10-21T00:00:00Z', summary: {} } });
  assert.equal(received.length, 1);
  assert.equal(ended.length, 1);
  socket.trigger('disconnect');
  socket.trigger('connect');
  assert.equal(socket.commands.filter(({ event }) => event === 'lounge.join').length, 2);
  assert.ok(statuses.includes('disconnected'));
  connection.disconnect();
  assert.equal(socket.disconnected, true);
  assert.equal(socket.handlers.get('lounge.queue.update').size, 0);
  assert.equal(socket.handlers.get('lounge.session.ended').size, 0);
  socket.trigger('lounge.queue.update', { loungeId: 'lg_current', payload: {} });
  assert.equal(received.length, 1);
});

test('recommendation, Lounge history/analytics, segue, and Q&A calls use existing authenticated API contracts', async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/auth/login')) return response({ accessToken: 'integration-token', user: { id: 'u1' } });
    if (url.includes('/ai/segue')) return response({ selectedTrackId: 't_2002', provider: 'deterministic_fallback' });
    if (url.includes('/ai/ask')) return response({ answer: 'Grounded.', sourceEvents: ['t_2001#title'], grounded: true });
    return response({ items: [] });
  };
  await login({ email: 'mira@example.test', password: 'password' });
  await getRecommendations();
  await getLoungeHistory();
  await getLoungeAnalytics('lg_123456789abc');
  await requestSegue('lg_123456789abc', { currentTrackId: 't_2001', currentTs: 0, candidateTrackIds: ['t_2002'], currentSentimentScore: 0.5 });
  await askTrackQuestion('lg_123456789abc', 'What is the track title?', 'retry-key-123456');
  assert.ok(calls[1].url.endsWith('/api/v1/recommendations?limit=10'));
  assert.ok(calls[2].url.endsWith('/api/v1/dashboard/lounge-history?limit=50'));
  assert.ok(calls[3].url.endsWith('/api/v1/dashboard/lounges/lg_123456789abc/analytics'));
  assert.equal(calls[4].url, '/api/v1/lounges/lg_123456789abc/ai/segue');
  assert.equal(JSON.parse(calls[4].options.body).currentSentimentScore, 0.5);
  assert.equal(calls[4].options.headers.Authorization, 'Bearer integration-token');
  assert.equal(calls[5].url, '/api/v1/lounges/lg_123456789abc/ai/ask');
  assert.deepEqual(JSON.parse(calls[5].options.body), { question: 'What is the track title?' });
  assert.equal(calls[5].options.headers['Idempotency-Key'], 'retry-key-123456');
});

test('room event subscriptions ignore other Lounges and remove each listener on cleanup', () => {
  class FakeSocket {
    handlers = new Map();
    on(event, handler) { const set = this.handlers.get(event) ?? new Set(); set.add(handler); this.handlers.set(event, set); }
    off(event, handler) { this.handlers.get(event)?.delete(handler); }
    trigger(event, envelope) { for (const fn of this.handlers.get(event) ?? []) fn(envelope); }
  }
  const socket = new FakeSocket(), received = [];
  const cleanup = subscribeToLoungeEvents(socket, 'lg_current', (name, envelope) => received.push([name, envelope]));
  socket.trigger('lounge.chat.message', { loungeId: 'lg_other', payload: { body: 'private to another room' } });
  socket.trigger('lounge.chat.message', { loungeId: 'lg_current', payload: { body: 'this room only' } });
  assert.equal(received.length, 1);
  assert.equal(received[0][1].payload.body, 'this room only');
  cleanup();
  assert.equal([...socket.handlers.values()].reduce((sum, set) => sum + set.size, 0), 0);
});

test('chat history and broadcasts deduplicate accepted messages by server messageId', () => {
  const row = { messageId: 'm1', userId: 'u1', body: 'Hello', tsSeconds: 10 };
  assert.deepEqual(uniqueChatMessages([row, row, { ...row, messageId: 'm2', tsSeconds: 11 }]).map((item) => item.messageId), ['m1', 'm2']);
});

test('Soundclash view state follows server events and ignores stale battle events', () => {
  let state = applySoundclashEvent(null, 'lounge.soundclash.submission', { battleId: 'b1', trackId: 't_2001' });
  state = applySoundclashEvent(state, 'lounge.soundclash.submission', { battleId: 'b1', trackId: 't_2002' });
  state = applySoundclashEvent(state, 'lounge.soundclash.open', { battleId: 'b1', candidateTrackIds: ['t_2001', 't_2002'], closesAt: 1000 });
  state = applySoundclashEvent(state, 'lounge.soundclash.vote', { battleId: 'b1', voteCounts: { t_2001: 1, t_2002: 1 }, closesAt: 1000, status: 'tied' });
  assert.deepEqual(tiedCandidateIds(state), ['t_2001', 't_2002']);
  state = applySoundclashEvent(state, 'lounge.soundclash.resolved', { battleId: 'b1', winningTrackId: 't_2002' });
  assert.equal(state.status, 'resolved');
  assert.equal(state.winningTrackId, 't_2002');
  assert.equal(applySoundclashEvent(state, 'lounge.soundclash.resolved', { battleId: 'b_other', winningTrackId: 't_2001' }), state);
});

test('recommendation and analytics render helpers preserve empty and unavailable API values', () => {
  assert.deepEqual(normalizeRecommendations({ items: [] }), []);
  assert.deepEqual(normalizeRecommendations({ items: [{ trackId: 't_1', title: 'A', artist: 'B' }, { title: 'missing id' }] }), [{ trackId: 't_1', title: 'A', artist: 'B' }]);
  assert.equal(displayAnalyticsMetric(null), 'Unavailable');
  assert.equal(displayAnalyticsMetric(0), 0);
});

test('AI DJ commentary preference hides only segue text and preserves selection state', () => {
  const result = { selectedTrackId: 't_2002', transitionScript: 'A grounded transition.', matchReason: { selectionReason: 'Adjacent Camelot key' } };
  assert.equal(segueCommentaryText(result, true), 'A grounded transition.');
  assert.equal(segueCommentaryText(result, false), 'DJ commentary is disabled in your audio settings.');
  assert.equal(segueCommentaryText({ transitionScript: 'orphaned text' }, false), null);
  assert.equal(shouldShowAiDjCommentary(true), true);
  assert.equal(shouldShowAiDjCommentary(false), false);
  assert.equal(result.selectedTrackId, 't_2002');
  assert.equal(result.matchReason.selectionReason, 'Adjacent Camelot key');
});

test('catalog helpers derive artist pages and player tracks only from catalog metadata', () => {
  const tracks = [
    { trackId: 't_1', title: 'Blue', artist: 'Mira Sol', durationSeconds: 61, audioAssetUrl: '/audio/blue.ogg' },
    { trackId: 't_2', title: 'Afterglow', artist: 'Mira Sol', durationSeconds: 120 },
    { trackId: 't_3', title: 'Night', artist: 'Nova Circuit', durationSeconds: 180 },
  ];
  const artists = groupCatalogArtists(tracks);
  assert.deepEqual(artists.map(({ name, tracks: items }) => [name, items.length]), [['Mira Sol', 2], ['Nova Circuit', 1]]);
  assert.deepEqual(tracksForArtist(tracks, 'mira sol').map((track) => track.trackId), ['t_2', 't_1']);
  assert.equal(formatTrackDuration(61), '1:01');
  assert.equal(catalogDurationSeconds(tracks), 361);
  assert.deepEqual(toPlayerTrack(tracks[0]), { ...tracks[0], time: '1:01', img: 'photo-1514525253161-7a46d19cd819' });
  assert.deepEqual(groupCatalogArtists([]), []);
});
