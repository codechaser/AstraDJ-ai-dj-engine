import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';
import { queueRepository } from '../services/queueRepository.js';
import { createQueueService } from '../services/queueService.js';
import { createChatService } from '../services/chatService.js';
import { roomSentimentService } from '../services/roomSentimentService.js';
import { createSoundclashService } from '../services/soundclashService.js';

const ROOM_PREFIX = 'lounge:';
const room = (loungeId) => `${ROOM_PREFIX}${loungeId}`;
const envelope = (event, loungeId, payload) => ({ event, loungeId, payload, ts: Date.now() });
const ackError = (error) => ({ ok: false, error: { code: error.code ?? 'INTERNAL_ERROR', message: error.status && error.status < 500 ? error.message : 'The request could not be completed' } });

export function attachLoungeGateway(io, { repository = queueRepository, queueService = createQueueService(repository), secret = config.jwtAccessSecret, sentimentService = roomSentimentService, chatService = createChatService({ repository, sentimentService }), soundclashService = null, soundclashOptions = {} } = {}) {
  soundclashService ??= createSoundclashService({ repository, queueService, ...soundclashOptions, onEvent: (event, loungeId, payload) => io.to(room(loungeId)).emit(event, envelope(event, loungeId, payload)) });
  const loungeBySocket = new Map();
  const socketsByLounge = new Map();
  const joiningUsers = new Map();

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (typeof token !== 'string' || token.length > 4096) return next(new Error('AUTH_REQUIRED'));
      const claims = jwt.verify(token, secret, { algorithms: ['HS256'], issuer: 'astradj-api', audience: 'astradj-client' });
      const user = await repository.getUser(claims.sub);
      if (!user) return next(new Error('AUTH_REQUIRED'));
      socket.data.userId = String(user._id ?? user.id);
      socket.data.user = { id: socket.data.userId, displayName: user.displayName, role: user.role };
      next();
    } catch { next(new Error('INVALID_TOKEN')); }
  });

  const members = (loungeId) => socketsByLounge.get(loungeId) ?? new Map();
  const participants = (loungeId) => [...members(loungeId)].map(([userId, entry]) => ({ userId, displayName: entry.displayName, role: entry.role, connected: true }));
  const hasHost = (loungeId, hostUserId) => members(loungeId).has(String(hostUserId));
  const emitPresence = (loungeId, participantId, action, hostDisconnected) => {
    const payload = { participantId, action, participantCount: members(loungeId).size, hostDisconnected };
    io.to(room(loungeId)).emit('lounge.presence.update', envelope('lounge.presence.update', loungeId, payload));
  };

  io.on('connection', (socket) => {
    async function authorizedAction(callback) {
      const loungeId = loungeBySocket.get(socket.id);
      if (!loungeId) throw Object.assign(new Error('Join a Lounge before sending this command'), { status: 403, code: 'LOUNGE_MEMBERSHIP_REQUIRED' });
      const user = await repository.getUser(socket.data.userId);
      if (!user) throw Object.assign(new Error('The account is no longer available'), { status: 401, code: 'AUTH_REQUIRED' });
      return callback({ loungeId, user: { id: socket.data.userId, role: user.role, displayName: user.displayName } });
    }
    async function authorizedLoungeAction(callback) {
      return authorizedAction(async ({ loungeId, user }) => {
        const lounge = await repository.findLoungeById(loungeId);
        if (!lounge || lounge.status === 'ended') throw Object.assign(new Error('Lounge no longer exists'), { status: 404, code: 'LOUNGE_NOT_FOUND' });
        if (!lounge.participantIds?.some((participantId) => String(participantId) === String(user.id))) {
          throw Object.assign(new Error('Join this Lounge before using this operation'), { status: 403, code: 'LOUNGE_MEMBERSHIP_REQUIRED' });
        }
        return callback({ loungeId, user, lounge });
      });
    }
    function command(event, handler) {
      socket.on(event, async (payload = {}, ack = () => {}) => {
        try {
          const result = await handler(payload);
          ack({ ok: true, ...result });
        } catch (error) { ack(ackError(error)); }
      });
    }

    command('lounge.join', async ({ inviteCode }) => {
      if (typeof inviteCode !== 'string' || !/^SP-[A-HJ-NP-Z2-9]{4}$/i.test(inviteCode)) {
        throw Object.assign(new Error('inviteCode must use the SP-XXXX format'), { status: 400, code: 'VALIDATION_ERROR' });
      }
      const candidate = await repository.findLoungeByInvite(inviteCode);
      if (!candidate) return queueService.join({ inviteCode, userId: socket.data.userId });
      const loungeId = candidate.loungeId;
      const existingRoom = loungeBySocket.get(socket.id);
      if (existingRoom && existingRoom !== loungeId) throw Object.assign(new Error('One socket connection may join one Lounge at a time'), { status: 409, code: 'ALREADY_IN_LOUNGE' });
      const currentMembers = members(loungeId);
      let pending = joiningUsers.get(loungeId);
      if (!pending) { pending = new Set(); joiningUsers.set(loungeId, pending); }
      const alreadyConnected = currentMembers.has(socket.data.userId);
      const alreadyJoining = pending.has(socket.data.userId);
      const pendingOtherUsers = [...pending].filter((id) => !currentMembers.has(id) && id !== socket.data.userId).length;
      if (!alreadyConnected && !alreadyJoining && currentMembers.size + pendingOtherUsers >= candidate.settings.maxParticipants) {
        if (pending.size === 0) joiningUsers.delete(loungeId);
        throw Object.assign(new Error('The Lounge has reached its participant limit'), { status: 409, code: 'LOUNGE_FULL' });
      }
      if (!alreadyConnected) pending.add(socket.data.userId);
      let joinedResult;
      try { joinedResult = await queueService.join({ inviteCode, userId: socket.data.userId }); }
      finally {
        if (!alreadyConnected) pending.delete(socket.data.userId);
        if (pending.size === 0) joiningUsers.delete(loungeId);
      }
      const { lounge, state: initial } = joinedResult;
      const isFirstSocket = !currentMembers.has(socket.data.userId);
      currentMembers.set(socket.data.userId, { displayName: socket.data.user.displayName, role: socket.data.user.role, sockets: new Set([...(currentMembers.get(socket.data.userId)?.sockets ?? []), socket.id]) });
      socketsByLounge.set(loungeId, currentMembers);
      loungeBySocket.set(socket.id, loungeId);
      await socket.join(room(loungeId));
      const state = await queueService.snapshot(lounge);
      state.soundclash = await soundclashService.snapshot(lounge);
      state.presence = participants(loungeId);
      state.hostDisconnected = !hasHost(loungeId, lounge.hostUserId);
      if (isFirstSocket) emitPresence(loungeId, socket.data.userId, 'joined', state.hostDisconnected);
      return { loungeId, state: { ...initial, ...state } };
    });

    command('lounge.queue.add', (payload) => authorizedAction(async ({ loungeId, user }) => {
      const joined = await repository.findLoungeById(loungeId);
      if (!joined) throw Object.assign(new Error('Lounge no longer exists'), { status: 404, code: 'LOUNGE_NOT_FOUND' });
      if (!hasHost(loungeId, joined.hostUserId)) throw Object.assign(new Error('Queue mutations are frozen while the Host is disconnected'), { status: 409, code: 'HOST_DISCONNECTED' });
      const state = await queueService.addTrack({ lounge: joined, actor: user, trackId: payload.trackId });
      const envelopeValue = envelope('lounge.queue.update', loungeId, { queue: queueRows(state), reason: 'add' });
      io.to(room(loungeId)).emit('lounge.queue.update', envelopeValue);
      return { state };
    }));

    command('lounge.queue.vote', (payload) => authorizedAction(async ({ loungeId, user }) => {
      if (!['-1', '0', '1', -1, 0, 1].includes(payload.value)) throw Object.assign(new Error('value must be -1, 0, or 1'), { status: 400, code: 'VALIDATION_ERROR' });
      const joined = await repository.findLoungeById(loungeId);
      if (!joined) throw Object.assign(new Error('Lounge no longer exists'), { status: 404, code: 'LOUNGE_NOT_FOUND' });
      if (!hasHost(loungeId, joined.hostUserId)) throw Object.assign(new Error('Queue mutations are frozen while the Host is disconnected'), { status: 409, code: 'HOST_DISCONNECTED' });
      const state = await queueService.vote({ lounge: joined, actor: user, trackId: payload.trackId, value: Number(payload.value) });
      io.to(room(loungeId)).emit('lounge.queue.update', envelope('lounge.queue.update', loungeId, { queue: queueRows(state), reason: 'vote' }));
      return { state };
    }));

    command('lounge.sync.request', () => authorizedAction(async ({ loungeId }) => {
      const joined = await repository.findLoungeById(loungeId);
      if (!joined) throw Object.assign(new Error('Lounge no longer exists'), { status: 404, code: 'LOUNGE_NOT_FOUND' });
      const state = await queueService.snapshot(joined);
      state.soundclash = await soundclashService.snapshot(joined);
      state.presence = participants(loungeId);
      state.hostDisconnected = !hasHost(loungeId, joined.hostUserId);
      return { state };
    }));

    command('lounge.soundclash.submit', (payload) => authorizedLoungeAction(async ({ loungeId, user, lounge }) => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some((key) => key !== 'trackId')) throw Object.assign(new Error('Payload must contain only trackId'), { status: 400, code: 'VALIDATION_ERROR' });
      if (!hasHost(loungeId, lounge.hostUserId)) throw Object.assign(new Error('Queue mutations are frozen while the Host is disconnected'), { status: 409, code: 'HOST_DISCONNECTED' });
      return soundclashService.submit({ lounge, actor: user, trackId: payload.trackId });
    }));

    command('lounge.soundclash.open', (payload) => authorizedLoungeAction(async ({ loungeId, user, lounge }) => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length !== 0) throw Object.assign(new Error('Payload must be empty'), { status: 400, code: 'VALIDATION_ERROR' });
      if (!hasHost(loungeId, lounge.hostUserId)) throw Object.assign(new Error('Queue mutations are frozen while the Host is disconnected'), { status: 409, code: 'HOST_DISCONNECTED' });
      return soundclashService.open({ lounge, actor: user });
    }));

    command('lounge.soundclash.vote', (payload) => authorizedLoungeAction(async ({ user, lounge }) => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length !== 2 || !Object.hasOwn(payload, 'battleId') || !Object.hasOwn(payload, 'trackId')) throw Object.assign(new Error('Payload must contain battleId and trackId only'), { status: 400, code: 'VALIDATION_ERROR' });
      return soundclashService.vote({ lounge, actor: user, battleId: payload.battleId, trackId: payload.trackId });
    }));

    command('lounge.soundclash.resolve', (payload) => authorizedLoungeAction(async ({ user, lounge }) => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length !== 2 || !Object.hasOwn(payload, 'battleId') || !Object.hasOwn(payload, 'winningTrackId')) throw Object.assign(new Error('Payload must contain battleId and winningTrackId only'), { status: 400, code: 'VALIDATION_ERROR' });
      const hostPresent = hasHost(lounge.loungeId, lounge.hostUserId);
      if (!hostPresent) throw Object.assign(new Error('Queue mutations are frozen while the Host is disconnected'), { status: 409, code: 'HOST_DISCONNECTED' });
      return soundclashService.forceResolve({ lounge, actor: user, battleId: payload.battleId, winningTrackId: payload.winningTrackId });
    }));

    command('lounge.sync.ping', ({ clientSentAt }) => authorizedAction(async ({ loungeId }) => {
      if (!Number.isFinite(clientSentAt)) throw Object.assign(new Error('clientSentAt must be a timestamp'), { status: 400, code: 'VALIDATION_ERROR' });
      const payload = { clientSentAt, serverReceivedAt: Date.now() };
      socket.emit('lounge.sync.pong', envelope('lounge.sync.pong', loungeId, payload));
      return { pong: payload };
    }));

    command('lounge.chat.message', (payload) => authorizedLoungeAction(async ({ loungeId, user }) => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some((key) => key !== 'body')) {
        throw Object.assign(new Error('Payload must contain only body'), { status: 400, code: 'VALIDATION_ERROR' });
      }
      const { message, sentiment } = await chatService.send({ loungeId, user, body: payload.body });
      const messagePayload = { messageId: message.messageId, userId: message.userId, body: message.body, sentimentBucket: message.sentimentBucket, tsSeconds: message.tsSeconds };
      io.to(room(loungeId)).emit('lounge.chat.message', envelope('lounge.chat.message', loungeId, messagePayload));
      io.to(room(loungeId)).emit('lounge.sentiment.score', envelope('lounge.sentiment.score', loungeId, sentiment));
      return { message: messagePayload, sentiment };
    }));

    command('lounge.chat.history', (payload) => authorizedLoungeAction(async ({ loungeId }) => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some((key) => key !== 'limit')) {
        throw Object.assign(new Error('Payload may contain only limit'), { status: 400, code: 'VALIDATION_ERROR' });
      }
      const limit = payload.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw Object.assign(new Error('limit must be an integer between 1 and 100'), { status: 400, code: 'VALIDATION_ERROR' });
      return { messages: await chatService.history(loungeId, limit) };
    }));

    socket.on('disconnect', async () => {
      const loungeId = loungeBySocket.get(socket.id);
      if (!loungeId) return;
      loungeBySocket.delete(socket.id);
      const currentMembers = members(loungeId);
      const entry = currentMembers.get(socket.data.userId);
      if (!entry) return;
      entry.sockets.delete(socket.id);
      if (entry.sockets.size === 0) {
        currentMembers.delete(socket.data.userId);
        const lounge = await repository.findLoungeById(loungeId);
        emitPresence(loungeId, socket.data.userId, 'left', lounge ? !hasHost(loungeId, lounge.hostUserId) : true);
      }
    });
  });
  return { io, queueService, chatService, sentimentService, soundclashService };
}

function queueRows(state) {
  const rows = [];
  if (state.nowPlaying) rows.push({ trackId: state.nowPlaying.trackId, position: 0 });
  state.nextUp.forEach((track, index) => rows.push({ trackId: track.trackId, position: index + 1 }));
  return rows;
}
