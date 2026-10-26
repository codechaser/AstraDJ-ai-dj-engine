import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';
import { queueRepository } from '../services/queueRepository.js';
import { createQueueService } from '../services/queueService.js';
import { createChatService } from '../services/chatService.js';
import { roomSentimentService } from '../services/roomSentimentService.js';
import { createSoundclashService } from '../services/soundclashService.js';
import { loungeLifecycleService as defaultLoungeLifecycleService } from '../services/loungeLifecycleService.js';
import { loungeMetricEventService as defaultLoungeMetricEventService } from '../services/loungeMetricEventService.js';
import { loungeCommandCoordinator } from '../services/loungeCommandCoordinator.js';
import { segueService as defaultSegueService } from '../services/segueService.js';

const ROOM_PREFIX = 'lounge:';
const room = (loungeId) => `${ROOM_PREFIX}${loungeId}`;
const envelope = (event, loungeId, payload) => ({ event, loungeId, payload, ts: Date.now() });
export function publishLoungeEvent(io, event, loungeId, payload) {
  io.to(room(loungeId)).emit(event, envelope(event, loungeId, payload));
}
const ackError = (error) => ({ ok: false, error: { code: error.code ?? 'INTERNAL_ERROR', message: error.status && error.status < 500 ? error.message : 'The request could not be completed' } });

export function attachLoungeGateway(io, { repository = queueRepository, queueService = createQueueService(repository), secret = config.jwtAccessSecret, sentimentService = roomSentimentService, chatService = createChatService({ repository, sentimentService }), soundclashService = null, soundclashOptions = {}, loungeLifecycleService = defaultLoungeLifecycleService, loungeMetricEventService = defaultLoungeMetricEventService, segueService = defaultSegueService, pollIntervalMs = 50 } = {}) {
  soundclashService ??= createSoundclashService({
    repository, queueService, ...soundclashOptions,
    onEvent: typeof repository.getCoordination === 'function' ? () => {} : (event, loungeId, payload) => publishLoungeEvent(io, event, loungeId, payload),
  });
  const loungeBySocket = new Map();
  const socketsByLounge = new Map();
  const joiningUsers = new Map();
  const pendingSegueDecisions = new Map();
  const eventCursors = new Map();
  let polling = false;
  const pollCommittedEvents = async () => {
    if (typeof repository.getCoordination !== 'function') return;
    if (polling) return;
    polling = true;
    try {
      for (const loungeId of socketsByLounge.keys()) {
        let cursor = eventCursors.get(loungeId);
        if (!Number.isInteger(cursor)) continue;
        const events = await queueService.listEvents(loungeId);
        const fresh = events.filter((event) => event.seq > cursor).sort((a, b) => a.seq - b.seq);
        for (const event of fresh) {
          if (event.type.startsWith('soundclash.')) {
            const payload = event.payload ?? {};
            if (event.type === 'soundclash.submitted') {
              const battleEvents = events.filter((candidate) => candidate.type === 'soundclash.submitted' && candidate.payload?.battleId === payload.battleId && candidate.seq <= event.seq);
              publishLoungeEvent(io, 'lounge.soundclash.submission', loungeId, { battleId: payload.battleId, trackId: payload.trackId, submittedByUserId: String(event.actorUserId), candidateCount: battleEvents.length });
            } else if (event.type === 'soundclash.opened') {
              publishLoungeEvent(io, 'lounge.soundclash.open', loungeId, { battleId: payload.battleId, candidateTrackIds: payload.candidateTrackIds, closesAt: payload.closesAt });
            } else if (event.type === 'soundclash.voted' || event.type === 'soundclash.tied') {
              const battleVotes = events.filter((candidate) => candidate.type === 'soundclash.voted' && candidate.payload?.battleId === payload.battleId && candidate.seq <= event.seq);
              const voteCounts = Object.fromEntries((events.find((candidate) => candidate.type === 'soundclash.opened' && candidate.payload?.battleId === payload.battleId)?.payload?.candidateTrackIds ?? []).map((id) => [id, 0]));
              for (const vote of battleVotes) if (Object.hasOwn(voteCounts, vote.payload.trackId)) voteCounts[vote.payload.trackId] += 1;
              const opened = events.find((candidate) => candidate.type === 'soundclash.opened' && candidate.payload?.battleId === payload.battleId);
              publishLoungeEvent(io, 'lounge.soundclash.vote', loungeId, { battleId: payload.battleId, voteCounts, closesAt: opened?.payload?.closesAt ?? null, ...(event.type === 'soundclash.tied' ? { status: 'tied' } : {}) });
            } else if (event.type === 'soundclash.resolved') {
              const lounge = await repository.findLoungeById(loungeId);
              const state = lounge ? await queueService.snapshot(lounge) : null;
              if (state) publishLoungeEvent(io, 'lounge.queue.update', loungeId, { queue: queueRows(state), reason: 'battle' });
              publishLoungeEvent(io, 'lounge.soundclash.resolved', loungeId, { battleId: payload.battleId, winningTrackId: payload.winningTrackId });
            }
          } else if (event.type === 'segue.prepared') {
            const decision = event.payload?.decision;
            if (decision?.transitionScript) publishLoungeEvent(io, 'lounge.ai.dj_announcement', loungeId, { text: decision.transitionScript, relatedTrackId: decision.selectedTrackId, sourceEvents: decision.sourceEvents });
          } else if (event.type === 'track.added' || event.type === 'track.voted' || event.type === 'track.transitioned') {
            const lounge = await repository.findLoungeById(loungeId);
            const state = lounge ? await queueService.snapshot(lounge) : null;
            if (state) publishLoungeEvent(io, 'lounge.queue.update', loungeId, {
              queue: queueRows(state),
              reason: event.type === 'track.added' ? 'add' : event.type === 'track.voted' ? 'vote' : 'segue',
              ...(event.payload?.transition ? { transition: event.payload.transition } : {}),
            });
          }
          cursor = event.seq;
        }
        eventCursors.set(loungeId, cursor);
      }
    } catch { /* A later poll retries durable events; no uncommitted event is broadcast. */ }
    finally { polling = false; }
  };
  const pollTimer = setInterval(() => { void pollCommittedEvents(); }, pollIntervalMs);
  pollTimer.unref?.();
  const serializeLoungeCommand = (loungeId, operation) => loungeCommandCoordinator.run(loungeId, operation);

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
  const emitPresence = async (loungeId, participantId, action, hostDisconnected) => {
    const payload = { participantId, action, participantCount: members(loungeId).size, hostDisconnected };
    await loungeMetricEventService.recordPresence({ loungeId, userId: participantId, action, participantCount: payload.participantCount });
    io.to(room(loungeId)).emit('lounge.presence.update', envelope('lounge.presence.update', loungeId, payload));
  };

  io.on('connection', (socket) => {
    async function authorizedAction(callback) {
      const loungeId = loungeBySocket.get(socket.id);
      if (!loungeId) throw Object.assign(new Error('Join a Lounge before sending this command'), { status: 403, code: 'LOUNGE_MEMBERSHIP_REQUIRED' });
      const user = await repository.getUser(socket.data.userId);
      if (!user) throw Object.assign(new Error('The account is no longer available'), { status: 401, code: 'AUTH_REQUIRED' });
      return callback({ loungeId, user: { id: socket.data.userId, role: user.role, displayName: user.displayName, aiDjCommentary: user.preferences?.audio?.aiDjCommentary !== false } });
    }
    async function authorizedLoungeAction(callback) {
      return authorizedAction(async ({ loungeId, user }) => {
        return serializeLoungeCommand(loungeId, async () => {
          const lounge = await repository.findLoungeById(loungeId);
          if (!lounge) throw Object.assign(new Error('Lounge no longer exists'), { status: 404, code: 'LOUNGE_NOT_FOUND' });
          if (lounge.status === 'ended') throw Object.assign(new Error('This Lounge session has ended'), { status: 409, code: 'LOUNGE_ENDED' });
          if (!lounge.participantIds?.some((participantId) => String(participantId) === String(user.id))) {
            throw Object.assign(new Error('Join this Lounge before using this operation'), { status: 403, code: 'LOUNGE_MEMBERSHIP_REQUIRED' });
          }
          return callback({ loungeId, user, lounge });
        });
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
      return serializeLoungeCommand(loungeId, async () => {
        const activeCandidate = await repository.findLoungeByInvite(inviteCode);
        if (!activeCandidate) return queueService.join({ inviteCode, userId: socket.data.userId });
        const existingRoom = loungeBySocket.get(socket.id);
        if (existingRoom && existingRoom !== loungeId) throw Object.assign(new Error('One socket connection may join one Lounge at a time'), { status: 409, code: 'ALREADY_IN_LOUNGE' });
        const currentMembers = members(loungeId);
        let pending = joiningUsers.get(loungeId);
        if (!pending) { pending = new Set(); joiningUsers.set(loungeId, pending); }
        const alreadyConnected = currentMembers.has(socket.data.userId);
        const alreadyJoining = pending.has(socket.data.userId);
        const pendingOtherUsers = [...pending].filter((id) => !currentMembers.has(id) && id !== socket.data.userId).length;
        if (!alreadyConnected && !alreadyJoining && currentMembers.size + pendingOtherUsers >= activeCandidate.settings.maxParticipants) {
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
        if (!eventCursors.has(loungeId)) eventCursors.set(loungeId, state.revision ?? 0);
        state.presence = participants(loungeId);
        state.hostDisconnected = !hasHost(loungeId, lounge.hostUserId);
        state.isHost = String(lounge.hostUserId) === socket.data.userId;
        if (isFirstSocket) await emitPresence(loungeId, socket.data.userId, 'joined', state.hostDisconnected);
        return { loungeId, state: { ...initial, ...state, segueOutroWindowSeconds: config.segueOutroWindowSeconds } };
      });
    });

    command('lounge.queue.add', (payload) => authorizedAction(({ loungeId, user }) => serializeLoungeCommand(loungeId, async () => {
      const joined = await repository.findLoungeById(loungeId);
      if (!joined) throw Object.assign(new Error('Lounge no longer exists'), { status: 404, code: 'LOUNGE_NOT_FOUND' });
      if (joined.status === 'ended') throw Object.assign(new Error('This Lounge session has ended'), { status: 409, code: 'LOUNGE_ENDED' });
      if (!hasHost(loungeId, joined.hostUserId)) throw Object.assign(new Error('Queue mutations are frozen while the Host is disconnected'), { status: 409, code: 'HOST_DISCONNECTED' });
      const state = await queueService.addTrack({ lounge: joined, actor: user, trackId: payload.trackId });
      if (typeof repository.getCoordination !== 'function') io.to(room(loungeId)).emit('lounge.queue.update', envelope('lounge.queue.update', loungeId, { queue: queueRows(state), reason: 'add' }));
      return { state };
    })));

    command('lounge.queue.vote', (payload) => authorizedAction(({ loungeId, user }) => serializeLoungeCommand(loungeId, async () => {
      if (!['-1', '0', '1', -1, 0, 1].includes(payload.value)) throw Object.assign(new Error('value must be -1, 0, or 1'), { status: 400, code: 'VALIDATION_ERROR' });
      const joined = await repository.findLoungeById(loungeId);
      if (!joined) throw Object.assign(new Error('Lounge no longer exists'), { status: 404, code: 'LOUNGE_NOT_FOUND' });
      if (joined.status === 'ended') throw Object.assign(new Error('This Lounge session has ended'), { status: 409, code: 'LOUNGE_ENDED' });
      if (!hasHost(loungeId, joined.hostUserId)) throw Object.assign(new Error('Queue mutations are frozen while the Host is disconnected'), { status: 409, code: 'HOST_DISCONNECTED' });
      const state = await queueService.vote({ lounge: joined, actor: user, trackId: payload.trackId, value: Number(payload.value) });
      if (typeof repository.getCoordination !== 'function') io.to(room(loungeId)).emit('lounge.queue.update', envelope('lounge.queue.update', loungeId, { queue: queueRows(state), reason: 'vote' }));
      return { state };
    })));

    command('lounge.ai.segue.trigger', (payload) => authorizedLoungeAction(async ({ loungeId, user, lounge }) => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length !== 1 || !Number.isFinite(payload.currentTs) || payload.currentTs < 0) {
        throw Object.assign(new Error('Payload must contain a non-negative currentTs'), { status: 400, code: 'VALIDATION_ERROR' });
      }
      if (user.role !== 'Host' || String(lounge.hostUserId) !== String(user.id)) throw Object.assign(new Error('Only the Lounge Host can trigger playback segues'), { status: 403, code: 'LOUNGE_HOST_REQUIRED' });
      if (!hasHost(loungeId, lounge.hostUserId)) throw Object.assign(new Error('Queue mutations are frozen while the Host is disconnected'), { status: 409, code: 'HOST_DISCONNECTED' });
      const state = await queueService.snapshot(lounge);
      const duration = state.nowPlaying?.durationSeconds;
      if (!Number.isFinite(duration) || duration <= 0) throw Object.assign(new Error('Current track duration is unavailable'), { status: 409, code: 'TRACK_DURATION_UNAVAILABLE' });
      if (payload.currentTs > duration) throw Object.assign(new Error('currentTs cannot exceed the current track duration'), { status: 400, code: 'VALIDATION_ERROR' });
      if (!state.nowPlaying || payload.currentTs < duration - config.segueOutroWindowSeconds) {
        throw Object.assign(new Error('Playback has not reached the configured outro window'), { status: 409, code: 'OUTRO_WINDOW_NOT_REACHED' });
      }
      const candidates = state.nextUp.map(({ trackId }) => trackId);
      const currentPending = pendingSegueDecisions.get(loungeId);
      if (currentPending?.fromTrackId === state.nowPlaying.trackId && candidates.includes(currentPending.trackId) && Date.now() - currentPending.createdAt <= 5 * 60_000) {
        return { decision: currentPending.decision, outroWindowSeconds: config.segueOutroWindowSeconds, duplicate: true };
      }
      if (currentPending) pendingSegueDecisions.delete(loungeId);
      let recovered = false;
      const savedPending = lounge.pendingSegue;
      if (savedPending?.fromTrackId === state.nowPlaying.trackId && candidates.includes(savedPending.trackId) && savedPending.decision && Date.now() - new Date(savedPending.createdAt).getTime() <= 5 * 60_000) {
        const decision = savedPending.decision;
        pendingSegueDecisions.set(loungeId, { fromTrackId: savedPending.fromTrackId, trackId: savedPending.trackId, decision, createdAt: new Date(savedPending.createdAt).getTime() });
        return { decision, outroWindowSeconds: config.segueOutroWindowSeconds, duplicate: true, recovered: true };
      }
      let candidateTrackIds = candidates;
      if (savedPending?.fromTrackId === state.nowPlaying.trackId && candidates.includes(savedPending.trackId) && Date.now() - new Date(savedPending.createdAt).getTime() <= 5 * 60_000) {
        candidateTrackIds = [savedPending.trackId];
        recovered = true;
      } else if (savedPending?.fromTrackId) {
        await repository.clearPendingSegue?.(loungeId, savedPending.fromTrackId);
      }
      const decision = await segueService.requestSegue({
        loungeId, userId: user.id,
        input: { currentTrackId: state.nowPlaying.trackId, currentTs: payload.currentTs, candidateTrackIds, currentSentimentScore: 0.5 },
        includeCommentary: user.aiDjCommentary,
        announce: false,
      });
      if (!decision.selectedTrackId) {
        if (recovered) await repository.clearPendingSegue?.(loungeId, savedPending.fromTrackId);
        return { noCompatibleCandidate: true, decision };
      }
      if (recovered && decision.selectedTrackId !== savedPending.trackId) {
        await repository.clearPendingSegue?.(loungeId, savedPending.fromTrackId);
        throw Object.assign(new Error('The saved segue decision is no longer eligible'), { status: 409, code: 'SEGUE_STALE' });
      }
      const createdAt = recovered ? new Date(savedPending.createdAt).getTime() : Date.now();
      if (!recovered) {
        const persisted = await repository.setPendingSegue?.(loungeId, state.nowPlaying.trackId, { fromTrackId: state.nowPlaying.trackId, trackId: decision.selectedTrackId, createdAt: new Date(createdAt), decision });
        if (repository.setPendingSegue && !persisted) throw Object.assign(new Error('The Lounge track changed before the segue could be scheduled'), { status: 409, code: 'SEGUE_STALE' });
      }
      pendingSegueDecisions.set(loungeId, { fromTrackId: state.nowPlaying.trackId, trackId: decision.selectedTrackId, decision, createdAt });
      return { decision, outroWindowSeconds: config.segueOutroWindowSeconds, recovered };
    }));

    command('lounge.playback.ended', (payload) => authorizedLoungeAction(async ({ loungeId, user, lounge }) => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length !== 1 || typeof payload.trackId !== 'string') throw Object.assign(new Error('Payload must contain only trackId'), { status: 400, code: 'VALIDATION_ERROR' });
      if (user.role !== 'Host' || String(lounge.hostUserId) !== String(user.id)) throw Object.assign(new Error('Only the Lounge Host can advance playback'), { status: 403, code: 'LOUNGE_HOST_REQUIRED' });
      let pending = pendingSegueDecisions.get(loungeId);
      const savedPending = lounge.pendingSegue;
      if (!pending && savedPending?.fromTrackId === payload.trackId && savedPending.trackId && savedPending.decision && Date.now() - new Date(savedPending.createdAt).getTime() <= 5 * 60_000) {
        pending = { fromTrackId: payload.trackId, trackId: savedPending.trackId, decision: savedPending.decision, createdAt: new Date(savedPending.createdAt).getTime() };
        pendingSegueDecisions.set(loungeId, pending);
      } else if (!pending && savedPending?.fromTrackId === payload.trackId && savedPending.trackId && Date.now() - new Date(savedPending.createdAt).getTime() <= 5 * 60_000) {
        const state = await queueService.snapshot(lounge);
        if (state.nowPlaying?.trackId === payload.trackId && state.nextUp.some((item) => item.trackId === savedPending.trackId)) {
          const decision = await segueService.requestSegue({
            loungeId, userId: user.id,
            input: { currentTrackId: payload.trackId, currentTs: state.nowPlaying.durationSeconds, candidateTrackIds: [savedPending.trackId], currentSentimentScore: 0.5 },
            includeCommentary: user.aiDjCommentary,
            announce: false,
          });
          if (decision.selectedTrackId === savedPending.trackId) {
            pending = { fromTrackId: payload.trackId, trackId: savedPending.trackId, decision, createdAt: new Date(savedPending.createdAt).getTime() };
            pendingSegueDecisions.set(loungeId, pending);
          }
        }
      }
      if (!pending || pending.fromTrackId !== payload.trackId || Date.now() - pending.createdAt > 5 * 60_000 || lounge.currentTrackId !== payload.trackId) {
        pendingSegueDecisions.delete(loungeId);
        if (savedPending?.fromTrackId === payload.trackId) await repository.clearPendingSegue?.(loungeId, payload.trackId);
        throw Object.assign(new Error('There is no current playback segue to complete'), { status: 409, code: 'SEGUE_NOT_PENDING' });
      }
      const transition = { trackId: pending.trackId, matchReason: pending.decision.matchReason, transitionScript: pending.decision.transitionScript, sourceEvents: pending.decision.sourceEvents, provider: pending.decision.provider };
      const nextState = await queueService.transitionTo({ lounge, actor: user, trackId: pending.trackId, transition });
      pendingSegueDecisions.delete(loungeId);
      if (typeof repository.getCoordination !== 'function') io.to(room(loungeId)).emit('lounge.queue.update', envelope('lounge.queue.update', loungeId, { queue: queueRows(nextState), reason: 'segue', transition }));
      return { state: nextState, transition };
    }));

    command('lounge.playback.cancel', (payload) => authorizedLoungeAction(async ({ loungeId, user, lounge }) => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length !== 1 || typeof payload.trackId !== 'string') throw Object.assign(new Error('Payload must contain only trackId'), { status: 400, code: 'VALIDATION_ERROR' });
      if (user.role !== 'Host' || String(lounge.hostUserId) !== String(user.id)) throw Object.assign(new Error('Only the Lounge Host can cancel a playback segue'), { status: 403, code: 'LOUNGE_HOST_REQUIRED' });
      if (pendingSegueDecisions.get(loungeId)?.fromTrackId === payload.trackId || lounge.pendingSegue?.fromTrackId === payload.trackId) {
        pendingSegueDecisions.delete(loungeId);
        await repository.clearPendingSegue?.(loungeId, payload.trackId);
      }
      return {};
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

    command('lounge.session.end', (payload) => authorizedAction(({ loungeId, user }) => serializeLoungeCommand(loungeId, async () => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length !== 0) {
        throw Object.assign(new Error('Payload must be empty'), { status: 400, code: 'VALIDATION_ERROR' });
      }
      const currentLounge = await repository.findLoungeById(loungeId);
      if (!currentLounge) throw Object.assign(new Error('Lounge no longer exists'), { status: 404, code: 'LOUNGE_NOT_FOUND' });
      if (user.role !== 'Host' || String(currentLounge.hostUserId) !== String(user.id)) {
        throw Object.assign(new Error('Only the owning Host can end this session'), { status: 403, code: 'LOUNGE_HOST_REQUIRED' });
      }
      await soundclashService.closeLounge?.(loungeId);
      await queueService.flush(loungeId);
      await chatService.flush(loungeId);
      const result = await loungeLifecycleService.end({ loungeId, userId: user.id, userRole: user.role });
      if (!result.alreadyEnded) {
        pendingSegueDecisions.delete(loungeId);
        await repository.clearPendingSegue?.(loungeId, currentLounge.currentTrackId);
        const eventPayload = { endedAt: result.lounge.endedAt.toISOString(), summary: result.lounge.sessionSummary };
        io.to(room(loungeId)).emit('lounge.session.ended', envelope('lounge.session.ended', loungeId, eventPayload));
      }
      return { alreadyEnded: result.alreadyEnded, endedAt: result.lounge.endedAt.toISOString(), summary: result.lounge.sessionSummary };
    })));

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
      try {
        await serializeLoungeCommand(loungeId, async () => {
          loungeBySocket.delete(socket.id);
          const currentMembers = members(loungeId);
          const entry = currentMembers.get(socket.data.userId);
          if (!entry) return;
          entry.sockets.delete(socket.id);
          if (entry.sockets.size === 0) {
            currentMembers.delete(socket.data.userId);
            const lounge = await repository.findLoungeById(loungeId);
            if (String(lounge?.hostUserId) === socket.data.userId) {
              pendingSegueDecisions.delete(loungeId);
              if (lounge?.pendingSegue?.fromTrackId) await repository.clearPendingSegue?.(loungeId, lounge.pendingSegue.fromTrackId);
            }
            if (lounge?.status === 'live') await emitPresence(loungeId, socket.data.userId, 'left', !hasHost(loungeId, lounge.hostUserId));
          }
        });
      } catch { /* A disconnected socket cannot receive an error; the next analytics read reports incomplete sources. */ }
    });
  });
  return {
    io, queueService, chatService, sentimentService, soundclashService,
    async close() { clearInterval(pollTimer); soundclashService.close?.(); await queueService.flushAll?.(); },
    publishAnnouncement: (loungeId, payload) => publishLoungeEvent(io, 'lounge.ai.dj_announcement', loungeId, payload),
  };
}

function queueRows(state) {
  const rows = [];
  if (state.nowPlaying) rows.push({ trackId: state.nowPlaying.trackId, position: 0 });
  state.nextUp.forEach((track, index) => rows.push({ trackId: track.trackId, position: index + 1 }));
  return rows;
}
