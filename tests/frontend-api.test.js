import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { apiRequest, clearAccessToken, login, logout, registerAccount, restoreSession, searchTracks } from '../src/api/client.js';
import { buildCompletionInteraction } from '../src/api/playbackEvents.js';
import { connectToLounge } from '../src/api/loungeConnection.js';

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

test('Lounge client rejoins on reconnect, filters cross-room updates, and removes listeners on cleanup', () => {
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
  const socket = new FakeSocket(), received = [], statuses = [];
  const connection = connectToLounge({ inviteCode: 'sp-abcd', token: 'memory-token', origin: 'http://test', ioFactory: () => socket, onQueueUpdate: (event) => received.push(event), onStatus: (status) => statuses.push(status) });
  assert.deepEqual(socket.commands[0], { event: 'lounge.join', payload: { inviteCode: 'SP-ABCD' } });
  socket.trigger('lounge.queue.update', { loungeId: 'lg_other', payload: {} });
  socket.trigger('lounge.queue.update', { loungeId: 'lg_current', payload: { queue: [] } });
  assert.equal(received.length, 1);
  socket.trigger('disconnect');
  socket.trigger('connect');
  assert.equal(socket.commands.filter(({ event }) => event === 'lounge.join').length, 2);
  assert.ok(statuses.includes('disconnected'));
  connection.disconnect();
  assert.equal(socket.disconnected, true);
  assert.equal(socket.handlers.get('lounge.queue.update').size, 0);
  socket.trigger('lounge.queue.update', { loungeId: 'lg_current', payload: {} });
  assert.equal(received.length, 1);
});
