import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';
import { GATEWAY_PRESENCE_TTL_MS, PARTICIPANT_LEASE_TTL_MS, queueRepository } from '../services/queueRepository.js';
import { createQueueService } from '../services/queueService.js';
import { createChatService } from '../services/chatService.js';
import { roomSentimentService } from '../services/roomSentimentService.js';
import { createSoundclashService } from '../services/soundclashService.js';
import { loungeLifecycleService as defaultLoungeLifecycleService } from '../services/loungeLifecycleService.js';
import { loungeMetricEventService as defaultLoungeMetricEventService } from '../services/loungeMetricEventService.js';
import { createLoungeCommandCoordinator, loungeCommandCoordinator } from '../services/loungeCommandCoordinator.js';
import { segueService as defaultSegueService } from '../services/segueService.js';
import { assertRateLimit, distributedRateLimiter } from '../services/distributedRateLimiter.js';
import { rateLimitPolicies } from '../config/rateLimitPolicy.js';
import { acceptanceTracingEnabled, queueStateHash, queueTrackIds, recordAcceptanceDuration } from '../services/queueAcceptanceTrace.js';

const ROOM_PREFIX = 'lounge:';
const room = (loungeId) => `${ROOM_PREFIX}${loungeId}`;
const envelope = (event, loungeId, payload) => ({ event, loungeId, payload, ts: Date.now() });
export function publishLoungeEvent(io, event, loungeId, payload) {
  io.to(room(loungeId)).emit(event, envelope(event, loungeId, payload));
}
function createSoundclashRuntimeDiagnostic(correlationId) {
  if (process.env.ASTRA_RUNTIME_BENCH_DIAGNOSTICS !== 'true' || !correlationId) return () => {};
  return (stage, details = {}) => {
    const record = {
      type: 'astradj.runtime.soundclash',
      correlationId,
      stage,
      processId: process.pid,
      atUnixMs: Date.now(),
      ...(typeof details.code === 'string' ? { code: details.code } : {}),
      ...(Number.isInteger(details.status) ? { status: details.status } : {}),
    };
    console.info(JSON.stringify(record));
  };
}

function soundclashCorrelationId(loungeId, trackId) {
  if (typeof loungeId !== 'string' || typeof trackId !== 'string') return null;
  return createHash('sha256').update(`${loungeId}\0${trackId}`).digest('hex').slice(0, 24);
}

const ackError = (error) => ({ ok: false, error: { code: error.code ?? 'INTERNAL_ERROR', message: error.status && error.status < 500 ? error.message : 'The request could not be completed', ...(error.details?.retryAfterSeconds ? { retryAfterSeconds: error.details.retryAfterSeconds } : {}) } });

export function attachLoungeGateway(io, { repository = queueRepository, queueService = createQueueService(repository), secret = config.jwtAccessSecret, sentimentService = roomSentimentService, rateLimiter = distributedRateLimiter, chatService = createChatService({ repository, sentimentService, rateLimiter }), soundclashService = null, soundclashOptions = {}, loungeLifecycleService = defaultLoungeLifecycleService, loungeMetricEventService = defaultLoungeMetricEventService, segueService = defaultSegueService, pollIntervalMs = 50, presencePollIntervalMs = 500, participantLeaseTtlMs = PARTICIPANT_LEASE_TTL_MS, gatewayPresenceTtlMs = GATEWAY_PRESENCE_TTL_MS, participantLeaseRenewalIntervalMs = Math.max(100, Math.floor(participantLeaseTtlMs / 3)), participantLeaseCoordinator = createLoungeCommandCoordinator() } = {}) {
  soundclashService ??= createSoundclashService({
    repository, queueService, ...soundclashOptions,
    onEvent: typeof repository.getCoordination === 'function' ? () => {} : (event, loungeId, payload) => publishLoungeEvent(io, event, loungeId, payload),
  });
  const loungeBySocket = new Map();
  const socketsByLounge = new Map();
  const gatewayInstanceId = randomUUID();
  const acceptanceTraces = new Map();
  let gatewayClosing = false;
  const serializeParticipantLease = (loungeId, userId, operation) => participantLeaseCoordinator.run(`${loungeId}\0${userId}`, operation);
  const serializeParticipantLeases = (loungeId, participants, operation) => {
    const orderedUserIds = [...new Set(participants.map(({ userId }) => userId))].sort();
    const acquire = (index) => index === orderedUserIds.length
      ? operation()
      : serializeParticipantLease(loungeId, orderedUserIds[index], () => acquire(index + 1));
    return acquire(0);
  };
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
        await chatService.repairPendingDelivery?.(loungeId);
        const events = typeof queueService.listEventsAfter === 'function'
          ? await queueService.listEventsAfter(loungeId, cursor)
          : (await queueService.listEvents(loungeId)).filter((event) => event.seq > cursor);
        const fresh = events.filter((event) => event.seq > cursor).sort((a, b) => a.seq - b.seq);
        // Incremental event reads no longer include the battle's earlier open
        // event. Use the authoritative snapshot only for these infrequent
        // Soundclash events so vote updates retain their complete public totals.
        const hasSoundclashEvents = fresh.some((event) => event.type.startsWith('soundclash.'));
        const coordinated = hasSoundclashEvents ? await repository.getCoordination(loungeId) : null;
        const soundclash = coordinated?.coordination?.state?.soundclash;
        const voteCountsFor = (battle) => {
          const counts = Object.fromEntries((battle?.candidateTrackIds ?? []).map((trackId) => [trackId, 0]));
          for (const trackId of Object.values(battle?.votes ?? {})) {
            if (Object.hasOwn(counts, trackId)) counts[trackId] += 1;
          }
          return counts;
        };
        let pendingQueueUpdates = [];
        const flushQueueUpdates = async () => {
          if (!pendingQueueUpdates.length) return;
          const lounge = await repository.findLoungeById(loungeId);
          const state = lounge ? await queueService.snapshot(lounge) : null;
          if (state) {
            const queue = queueRows(state);
            const broadcastRevision = Number.isSafeInteger(state.revision) ? state.revision : 0;
            const broadcastStateHash = queueStateHash(broadcastRevision, queue.map(({ trackId }) => trackId));
            for (const event of pendingQueueUpdates) {
              const storedTrace = event.payload?.acceptanceTrace;
              let traceRecord = storedTrace?.traceId ? acceptanceTraces.get(storedTrace.traceId) : null;
              if (storedTrace?.traceId && !traceRecord) {
                for (const [existingId, record] of acceptanceTraces) {
                  if (performance.now() - record.createdAtMonoMs > 120_000) acceptanceTraces.delete(existingId);
                }
                while (acceptanceTraces.size >= 5_000) acceptanceTraces.delete(acceptanceTraces.keys().next().value);
                const trace = { ...storedTrace };
                if (trace.serverInstanceId !== gatewayInstanceId) {
                  trace.serverReceivedAtMonoMs = null;
                  trace.commitAtMonoMs = null;
                }
                traceRecord = {
                  trace,
                  createdAtMonoMs: performance.now(),
                  receiptClients: new Set(),
                  renderClients: new Set(),
                  renderAckRecords: new Map(),
                };
                acceptanceTraces.set(storedTrace.traceId, traceRecord);
              }
              const acceptanceTrace = storedTrace?.traceId
                ? {
                  traceId: storedTrace.traceId,
                  eventId: storedTrace.eventId,
                  committedRevision: storedTrace.committedRevision,
                  committedStateHash: storedTrace.committedStateHash,
                  mutationTrackId: storedTrace.mutationTrackId,
                  serverInstanceId: storedTrace.serverInstanceId,
                  serverReceivedAtUnixMs: storedTrace.serverReceivedAtUnixMs,
                  broadcastRevision,
                  broadcastStateHash,
                }
                : null;
              if (acceptanceTrace) {
                const trace = traceRecord?.trace;
                if (trace) {
                  trace.broadcastRevision = broadcastRevision;
                  trace.broadcastStateHash = broadcastStateHash;
                  trace.expectedClientCount = io.sockets.adapter.rooms.get(room(loungeId))?.size ?? 0;
                  trace.broadcastStartedAtMonoMs = performance.now();
                }
              }
              const broadcastStarted = performance.now();
              publishLoungeEvent(io, 'lounge.queue.update', loungeId, {
                queue,
                revision: broadcastRevision,
                stateHash: broadcastStateHash,
                reason: event.type === 'track.added' ? 'add' : event.type === 'track.voted' ? 'vote' : 'segue',
                ...(acceptanceTrace ? { acceptanceTrace } : {}),
                ...(event.payload?.transition ? { transition: event.payload.transition } : {}),
              });
              if (acceptanceTrace) {
                const trace = traceRecord?.trace;
                if (trace) {
                  trace.broadcastCompletedAtMonoMs = performance.now();
                  recordAcceptanceDuration(trace, 'queueEmitCallMs', trace.broadcastCompletedAtMonoMs - broadcastStarted);
                  trace.queuePollToBroadcastMs = Number((broadcastStarted - (trace.commitAtMonoMs ?? broadcastStarted)).toFixed(3));
                }
              }
            }
          }
          pendingQueueUpdates = [];
        };
        for (const event of fresh) {
          if (event.type === 'track.added' || event.type === 'track.voted' || event.type === 'track.transitioned') {
            pendingQueueUpdates.push(event);
            cursor = event.seq;
            continue;
          }
          // Preserve the order of queue updates relative to other committed
          // Lounge event types while sharing one current-state lookup for a
          // contiguous run of queue events.
          await flushQueueUpdates();
          if (event.type.startsWith('soundclash.')) {
            const payload = event.payload ?? {};
            if (event.type === 'soundclash.submitted') {
              const candidateCount = soundclash?.battleId === payload.battleId
                ? soundclash.candidateTrackIds.length
                : events.filter((candidate) => candidate.type === 'soundclash.submitted' && candidate.payload?.battleId === payload.battleId && candidate.seq <= event.seq).length;
              publishLoungeEvent(io, 'lounge.soundclash.submission', loungeId, { battleId: payload.battleId, trackId: payload.trackId, submittedByUserId: String(event.actorUserId), candidateCount });
            } else if (event.type === 'soundclash.opened') {
              publishLoungeEvent(io, 'lounge.soundclash.open', loungeId, { battleId: payload.battleId, candidateTrackIds: payload.candidateTrackIds, closesAt: payload.closesAt });
            } else if (event.type === 'soundclash.voted' || event.type === 'soundclash.tied') {
              if (soundclash?.battleId === payload.battleId) {
                publishLoungeEvent(io, 'lounge.soundclash.vote', loungeId, { battleId: payload.battleId, voteCounts: voteCountsFor(soundclash), closesAt: soundclash.closesAt ?? null, ...(event.type === 'soundclash.tied' ? { status: 'tied' } : {}) });
              }
            } else if (event.type === 'soundclash.resolved') {
              const lounge = await repository.findLoungeById(loungeId);
              const state = lounge ? await queueService.snapshot(lounge) : null;
              if (state) publishLoungeEvent(io, 'lounge.queue.update', loungeId, { queue: queueRows(state), reason: 'battle' });
              publishLoungeEvent(io, 'lounge.soundclash.resolved', loungeId, { battleId: payload.battleId, winningTrackId: payload.winningTrackId });
            }
          } else if (event.type === 'segue.prepared') {
            const decision = event.payload?.decision;
            if (decision?.transitionScript) publishLoungeEvent(io, 'lounge.ai.dj_announcement', loungeId, { text: decision.transitionScript, relatedTrackId: decision.selectedTrackId, sourceEvents: decision.sourceEvents });
          } else if (event.type === 'chat.message') {
            const message = await repository.findChatMessageByMessageId?.(loungeId, event.payload?.messageId);
            if (!message) throw new Error(`Durable chat event ${loungeId}:${event.seq} has no persisted message`);
            publishLoungeEvent(io, 'lounge.chat.message', loungeId, {
              messageId: message.messageId,
              userId: String(message.userId),
              body: message.body,
              sentimentBucket: message.sentimentBucket,
              tsSeconds: message.tsSeconds,
            });
            const sentiment = await chatService.sentiment?.(loungeId);
            if (sentiment) publishLoungeEvent(io, 'lounge.sentiment.score', loungeId, sentiment);
          } else if (event.type === 'lounge.session.ended') {
            publishLoungeEvent(io, 'lounge.session.ended', loungeId, event.payload ?? {});
          }
          cursor = event.seq;
        }
        await flushQueueUpdates();
        eventCursors.set(loungeId, cursor);
      }
    } catch { /* A later poll retries durable events; no uncommitted event is broadcast. */ }
    finally { polling = false; }
  };
  const pollTimer = setInterval(() => { void pollCommittedEvents(); }, pollIntervalMs);
  pollTimer.unref?.();
  let renewingLeases = false;
  const renewParticipantLeases = async () => {
    if (gatewayClosing || renewingLeases || typeof repository.renewAdmissionLeases !== 'function' || typeof repository.joinLounge !== 'function') return;
    renewingLeases = true;
    try {
      for (const [loungeId, currentMembers] of socketsByLounge) {
        const membersInLounge = [...currentMembers.entries()].map(([userId, member]) => ({ userId, leaseId: member.leaseId }));
        await serializeParticipantLeases(loungeId, membersInLounge, async () => {
          const stillConnectedMembers = membersInLounge.filter((member) => {
            const currentMember = members(loungeId).get(member.userId);
            return !gatewayClosing && currentMember?.sockets.size > 0 && currentMember.leaseId === member.leaseId;
          });
          if (!stillConnectedMembers.length) return;

          const now = new Date();
          const expiresAt = new Date(now.getTime() + participantLeaseTtlMs);
          const renewed = await repository.renewAdmissionLeases(loungeId, stillConnectedMembers.map(({ leaseId }) => leaseId), now, expiresAt);
          for (const member of stillConnectedMembers) {
            if (renewed.has(member.leaseId)) continue;

            // Final disconnect uses the same per-user lock set. Membership
            // therefore remains current across the DB check and any recovery.
            const stillConnected = members(loungeId).get(member.userId);
            if (gatewayClosing || !stillConnected?.sockets.size || stillConnected.leaseId !== member.leaseId) continue;
            const lounge = await repository.findLoungeById(loungeId);
            if (gatewayClosing) continue;
            const restored = lounge && await repository.joinLounge(lounge, member.userId, { leaseId: member.leaseId, now, expiresAt });
            if (!restored) {
              for (const socketId of stillConnected.sockets) io.sockets.sockets.get(socketId)?.disconnect(true);
            }
          }
          if (typeof repository.upsertGatewayPresence === 'function') {
            for (const member of stillConnectedMembers) {
              const currentMember = members(loungeId).get(member.userId);
              if (gatewayClosing || !currentMember?.sockets.size || currentMember.leaseId !== member.leaseId) continue;
              try {
                await repository.upsertGatewayPresence(loungeId, {
                  gatewayId: gatewayInstanceId,
                  userId: member.userId,
                  generation: currentMember.presenceGeneration,
                  socketCount: currentMember.sockets.size,
                }, gatewayPresenceTtlMs);
              } catch { /* The next heartbeat retries; commands still require a live database check. */ }
            }
          }
        });
      }
    } catch { /* The per-user lock is released on failure; a later tick retries. */ }
    finally { renewingLeases = false; }
  };
  const leaseRenewalTimer = setInterval(() => { void renewParticipantLeases(); }, participantLeaseRenewalIntervalMs);
  leaseRenewalTimer.unref?.();
  const serializeLoungeCommand = (loungeId, operation) => loungeCommandCoordinator.run(loungeId, operation);

  io.use(async (socket, next) => {
    try {
      await assertRateLimit(rateLimiter, rateLimitPolicies.socketConnection, String(socket.handshake.address ?? 'unknown'));
    } catch (error) {
      return next(Object.assign(new Error(error.code ?? 'RATE_LIMIT_UNAVAILABLE'), {
        data: { code: error.code ?? 'RATE_LIMIT_UNAVAILABLE', ...(error.details?.retryAfterSeconds ? { retryAfterSeconds: error.details.retryAfterSeconds } : {}) },
      }));
    }
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
  const presenceSignatures = new Map();
  const presenceSignature = (presence) => JSON.stringify(presence.map(({ userId }) => userId).sort());
  const getPresence = async (loungeId) => {
    if (typeof repository.listActiveGatewayPresence === 'function') return repository.listActiveGatewayPresence(loungeId);
    return participants(loungeId);
  };
  const hasHost = async (loungeId, hostUserId) => {
    if (typeof repository.hasActiveGatewayPresence === 'function') {
      try { return await repository.hasActiveGatewayPresence(loungeId, hostUserId); }
      catch { throw Object.assign(new Error('Host presence could not be verified; retry the command'), { status: 503, code: 'PRESENCE_UNAVAILABLE' }); }
    }
    return members(loungeId).has(String(hostUserId));
  };
  const assertHostConnected = async (loungeId, hostUserId) => {
    if (!await hasHost(loungeId, hostUserId)) throw Object.assign(new Error('Queue mutations are frozen while the Host is disconnected'), { status: 409, code: 'HOST_DISCONNECTED' });
  };
  const publishPresenceSnapshot = async (loungeId, { participantId = null, action = 'sync', presence = null, force = false } = {}) => {
    presence ??= await getPresence(loungeId);
    const signature = presenceSignature(presence);
    const changed = presenceSignatures.get(loungeId) !== signature;
    if (!force && !changed) return presence;
    const lounge = await repository.findLoungeById(loungeId);
    const hostDisconnected = !presence.some((participant) => participant.userId === String(lounge?.hostUserId) && participant.connected);
    const payload = { participantId, action, participantCount: presence.length, hostDisconnected, presence };
    io.to(room(loungeId)).emit('lounge.presence.update', envelope('lounge.presence.update', loungeId, payload));
    presenceSignatures.set(loungeId, signature);
    return presence;
  };
  const emitPresence = async (loungeId, participantId, action) => {
    const presence = await getPresence(loungeId);
    await loungeMetricEventService.recordPresence({ loungeId, userId: participantId, action, participantCount: presence.length });
    return publishPresenceSnapshot(loungeId, { participantId, action, presence, force: true });
  };
  const presenceTimer = setInterval(() => {
    void (async () => {
      for (const loungeId of socketsByLounge.keys()) {
        try { await publishPresenceSnapshot(loungeId); } catch { /* A later poll repairs missed cross-instance notifications. */ }
      }
    })();
  }, presencePollIntervalMs);
  presenceTimer.unref?.();

  io.on('connection', (socket) => {
    async function authorizedAction(callback, acceptanceTrace = null) {
      const started = acceptanceTrace ? performance.now() : 0;
      const loungeId = loungeBySocket.get(socket.id);
      if (!loungeId) throw Object.assign(new Error('Join a Lounge before sending this command'), { status: 403, code: 'LOUNGE_MEMBERSHIP_REQUIRED' });
      const user = await repository.getUser(socket.data.userId);
      if (!user) throw Object.assign(new Error('The account is no longer available'), { status: 401, code: 'AUTH_REQUIRED' });
      if (acceptanceTrace) recordAcceptanceDuration(acceptanceTrace, 'membershipAndRoleLookupMs', performance.now() - started);
      return callback({ loungeId, user: { id: socket.data.userId, role: user.role, displayName: user.displayName, aiDjCommentary: user.preferences?.audio?.aiDjCommentary !== false } });
    }

    function acceptanceAck(payload, ack, kind) {
      if (!acceptanceTracingEnabled()) return;
      const loungeId = loungeBySocket.get(socket.id);
      if (!loungeId || typeof payload?.traceId !== 'string') {
        ack({ ok: false, error: 'INVALID_ACCEPTANCE_ACK' });
        return;
      }
      const traceRecord = acceptanceTraces.get(payload.traceId);
      const trace = traceRecord?.trace;
      if (!trace || trace.loungeId !== loungeId
        || payload.eventId !== trace.eventId || payload.committedRevision !== trace.committedRevision) {
        ack({ ok: false, error: 'ACCEPTANCE_TRACE_MISMATCH' });
        return;
      }
      const receivedAtMonoMs = performance.now();
      const clients = kind === 'receipt' ? traceRecord.receiptClients : traceRecord.renderClients;
      const clientKey = socket.id;
      const isDuplicate = clients.has(clientKey);
      if (!isDuplicate) clients.add(clientKey);
      if (kind === 'receipt') {
        ack({
          ok: true,
          duplicate: isDuplicate,
          serverReceivedAtMonoMs: receivedAtMonoMs,
          serverReceiptElapsedMs: Number.isFinite(trace.serverReceivedAtMonoMs)
            ? Number((receivedAtMonoMs - trace.serverReceivedAtMonoMs).toFixed(3)) : null,
        });
        return;
      }

      const trackIds = Array.isArray(payload.renderedTrackIds)
        && payload.renderedTrackIds.length <= 1_000
        && payload.renderedTrackIds.every((trackId) => typeof trackId === 'string')
        ? payload.renderedTrackIds
        : null;
      const stateHashValid = Boolean(trackIds
        && payload.renderedRevision === trace.broadcastRevision
        && payload.renderedRevision >= trace.committedRevision
        && payload.renderedStateHash === trace.broadcastStateHash
        && queueStateHash(payload.renderedRevision, trackIds) === trace.broadcastStateHash
        && trackIds.includes(trace.mutationTrackId));
      const ackRecord = {
        clientKey,
        renderedRevision: payload.renderedRevision ?? null,
        renderedStateHash: payload.renderedStateHash ?? null,
        stateHashValid,
        duplicate: isDuplicate,
        receivedAtMonoMs,
        commitToRenderAckUpperBoundMs: Number.isFinite(trace.commitAtMonoMs)
          ? Number((receivedAtMonoMs - trace.commitAtMonoMs).toFixed(3)) : null,
      };
      traceRecord.renderAckRecords.set(clientKey, ackRecord);
      ack({
        ok: true,
        duplicate: isDuplicate,
        stateHashValid,
        renderedRevision: ackRecord.renderedRevision,
        renderedStateHash: ackRecord.renderedStateHash,
        serverReceivedAtMonoMs: receivedAtMonoMs,
        serverReceiptToRenderAckUpperBoundMs: Number.isFinite(trace.serverReceivedAtMonoMs)
          ? Number((receivedAtMonoMs - trace.serverReceivedAtMonoMs).toFixed(3)) : null,
        commitToRenderAckUpperBoundMs: ackRecord.commitToRenderAckUpperBoundMs,
      });
    }

    socket.on('lounge.queue.acceptance.received', (payload = {}, ack = () => {}) => acceptanceAck(payload, ack, 'receipt'));
    socket.on('lounge.queue.acceptance.rendered', (payload = {}, ack = () => {}) => acceptanceAck(payload, ack, 'render'));
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
    function command(event, handler, policy = null) {
      socket.on(event, async (payload = {}, ack = () => {}) => {
        const soundclashTraceId = event === 'lounge.soundclash.submit'
          && process.env.ASTRA_RUNTIME_BENCH_DIAGNOSTICS === 'true'
          ? soundclashCorrelationId(loungeBySocket.get(socket.id), payload?.trackId)
          : null;
        const soundclashDiagnostic = createSoundclashRuntimeDiagnostic(soundclashTraceId);
        soundclashDiagnostic('request_received');
        const traceId = process.env.ASTRA_LOUNGE_ACCEPTANCE_TRACE === 'true'
          && event === 'lounge.queue.add'
          && typeof payload?.acceptanceTraceId === 'string'
          && /^[0-9a-f-]{36}$/i.test(payload.acceptanceTraceId)
          ? payload.acceptanceTraceId
          : null;
        const receivedAt = traceId ? performance.now() : null;
        const acceptanceTrace = traceId ? {
          traceId,
          loungeId: loungeBySocket.get(socket.id) ?? null,
          serverInstanceId: gatewayInstanceId,
          serverReceivedAtMonoMs: receivedAt,
          serverReceivedAtUnixMs: Date.now(),
          timings: {},
        } : null;
        if (acceptanceTrace) {
          for (const [existingId, record] of acceptanceTraces) {
            if (performance.now() - record.createdAtMonoMs > 120_000) acceptanceTraces.delete(existingId);
          }
          while (acceptanceTraces.size >= 5_000) acceptanceTraces.delete(acceptanceTraces.keys().next().value);
          acceptanceTraces.set(traceId, {
            trace: acceptanceTrace,
            createdAtMonoMs: receivedAt,
            receiptClients: new Set(),
            renderClients: new Set(),
            renderAckRecords: new Map(),
          });
        }
        try {
          if (policy) {
            const rateLimitStarted = traceId ? performance.now() : 0;
            const loungeId = loungeBySocket.get(socket.id);
            if (policy.identity === 'userLounge' && loungeId) {
              await assertRateLimit(rateLimiter, policy, [socket.data.userId, loungeId]);
            } else if (policy.identity === 'user') {
              await assertRateLimit(rateLimiter, policy, socket.data.userId);
            }
            soundclashDiagnostic('rate_limit_passed');
            if (acceptanceTrace) recordAcceptanceDuration(acceptanceTrace, 'rateLimitMs', performance.now() - rateLimitStarted);
          }
          const handlerStarted = traceId ? performance.now() : 0;
          const result = await handler(payload, acceptanceTrace, soundclashDiagnostic);
          soundclashDiagnostic('handler_completed');
          if (acceptanceTrace) {
            recordAcceptanceDuration(acceptanceTrace, 'handlerTotalMs', performance.now() - handlerStarted);
            acceptanceTrace.outcome = 'accepted';
          }
          const serverAckAtMonoMs = traceId ? performance.now() : null;
          const response = {
            ok: true,
            ...result,
            ...(acceptanceTrace ? {
              acceptanceTrace: {
                ...acceptanceTrace,
                serverCompletedAtUnixMs: Date.now(),
                serverAckAtMonoMs,
                serverProcessingMs: Number((serverAckAtMonoMs - receivedAt).toFixed(3)),
              },
            } : {}),
          };
          soundclashDiagnostic('ack_ready', { status: 200 });
          ack(response);
          soundclashDiagnostic('ack_callback_invoked', { status: 200 });
        } catch (error) {
          if (acceptanceTrace) {
            acceptanceTrace.outcome = 'rejected';
            acceptanceTrace.rejectionCode = error.code ?? 'INTERNAL_ERROR';
            acceptanceTrace.rejectionStatus = error.status ?? 500;
          }
          const response = {
            ...ackError(error),
            ...(acceptanceTrace ? { acceptanceTrace } : {}),
          };
          soundclashDiagnostic('ack_ready', { code: response.error?.code ?? 'INTERNAL_ERROR', status: response.error?.status ?? error.status ?? 500 });
          ack(response);
          soundclashDiagnostic('ack_callback_invoked', { code: response.error?.code ?? 'INTERNAL_ERROR', status: response.error?.status ?? error.status ?? 500 });
        }
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
        const alreadyConnected = currentMembers.has(socket.data.userId);
        const leaseId = currentMembers.get(socket.data.userId)?.leaseId ?? `${gatewayInstanceId}:${loungeId}:${socket.data.userId}`;
        const presenceGeneration = currentMembers.get(socket.data.userId)?.presenceGeneration ?? randomUUID();
        const nextSockets = new Set([...(currentMembers.get(socket.data.userId)?.sockets ?? []), socket.id]);
        const now = new Date();
        const expiresAt = new Date(now.getTime() + participantLeaseTtlMs);
        let joinedResult;
        try {
          joinedResult = await queueService.join({ inviteCode, userId: socket.data.userId, leaseId, now, expiresAt });
          if (typeof repository.upsertGatewayPresence === 'function') {
            const registered = await repository.upsertGatewayPresence(loungeId, {
              gatewayId: gatewayInstanceId,
              userId: socket.data.userId,
              generation: presenceGeneration,
              socketCount: nextSockets.size,
            }, gatewayPresenceTtlMs);
            if (!registered) throw Object.assign(new Error('Lounge presence could not be registered'), { status: 503, code: 'PRESENCE_UNAVAILABLE' });
          }
        }
        catch (error) {
          if (!alreadyConnected) await repository.releaseAdmissionLease?.(loungeId, leaseId).catch(() => {});
          throw error;
        }
        const { lounge, state: initial } = joinedResult;
        const isFirstSocket = !currentMembers.has(socket.data.userId);
        currentMembers.set(socket.data.userId, { displayName: socket.data.user.displayName, role: socket.data.user.role, leaseId, presenceGeneration, sockets: nextSockets });
        socketsByLounge.set(loungeId, currentMembers);
        loungeBySocket.set(socket.id, loungeId);
        socket.data.loungeLeaseId = leaseId;
        socket.data.loungePresenceGeneration = presenceGeneration;
        await socket.join(room(loungeId));
        const state = await queueService.snapshot(lounge);
        state.soundclash = await soundclashService.snapshot(lounge);
        if (!eventCursors.has(loungeId)) eventCursors.set(loungeId, state.revision ?? 0);
        state.presence = await getPresence(loungeId);
        state.hostDisconnected = !await hasHost(loungeId, lounge.hostUserId);
        state.isHost = String(lounge.hostUserId) === socket.data.userId;
        if (isFirstSocket) await emitPresence(loungeId, socket.data.userId, 'joined', state.hostDisconnected);
        return { loungeId, state: { ...initial, ...state, segueOutroWindowSeconds: config.segueOutroWindowSeconds } };
      });
    }, rateLimitPolicies.socketJoin);

    command('lounge.queue.add', (payload, acceptanceTrace) => {
      const serializationStarted = acceptanceTrace ? performance.now() : 0;
      return authorizedAction(({ loungeId, user }) => serializeLoungeCommand(loungeId, async () => {
        if (acceptanceTrace) recordAcceptanceDuration(acceptanceTrace, 'loungeCommandQueueWaitMs', performance.now() - serializationStarted);
        const loungeLookupStarted = acceptanceTrace ? performance.now() : 0;
        const joined = await repository.findLoungeById(loungeId);
        if (acceptanceTrace) recordAcceptanceDuration(acceptanceTrace, 'loungeLookupMs', performance.now() - loungeLookupStarted);
        if (!joined) throw Object.assign(new Error('Lounge no longer exists'), { status: 404, code: 'LOUNGE_NOT_FOUND' });
        if (joined.status === 'ended') throw Object.assign(new Error('This Lounge session has ended'), { status: 409, code: 'LOUNGE_ENDED' });
        const hostPresenceStarted = acceptanceTrace ? performance.now() : 0;
        await assertHostConnected(loungeId, joined.hostUserId);
        if (acceptanceTrace) recordAcceptanceDuration(acceptanceTrace, 'hostPresenceCheckMs', performance.now() - hostPresenceStarted);
        const state = await queueService.addTrack({ lounge: joined, actor: user, trackId: payload.trackId, requireHostPresenceUserId: joined.hostUserId, acceptanceTrace });
        if (typeof repository.getCoordination !== 'function') {
          const queue = queueRows(state);
          const revision = Number.isSafeInteger(state.revision) ? state.revision : 0;
          const stateHash = queueStateHash(revision, queue.map(({ trackId }) => trackId));
          if (acceptanceTrace) {
            Object.assign(acceptanceTrace, {
              eventId: `${loungeId}:${revision}`,
              committedRevision: revision,
              committedStateHash: stateHash,
              mutationTrackId: payload.trackId,
              broadcastRevision: revision,
              broadcastStateHash: stateHash,
            });
          }
          io.to(room(loungeId)).emit('lounge.queue.update', envelope('lounge.queue.update', loungeId, {
            queue, revision, stateHash, reason: 'add',
            ...(acceptanceTrace ? {
              acceptanceTrace: {
                traceId: acceptanceTrace.traceId,
                eventId: acceptanceTrace.eventId,
                committedRevision: acceptanceTrace.committedRevision,
                committedStateHash: acceptanceTrace.committedStateHash,
                mutationTrackId: acceptanceTrace.mutationTrackId,
                serverInstanceId: acceptanceTrace.serverInstanceId,
                serverReceivedAtUnixMs: acceptanceTrace.serverReceivedAtUnixMs,
                broadcastRevision: acceptanceTrace.broadcastRevision,
                broadcastStateHash: acceptanceTrace.broadcastStateHash,
              },
            } : {}),
          }));
        }
        return { state };
      }), acceptanceTrace);
    }, rateLimitPolicies.queueAdd);

    command('lounge.queue.vote', (payload) => authorizedAction(({ loungeId, user }) => serializeLoungeCommand(loungeId, async () => {
      if (!['-1', '0', '1', -1, 0, 1].includes(payload.value)) throw Object.assign(new Error('value must be -1, 0, or 1'), { status: 400, code: 'VALIDATION_ERROR' });
      const joined = await repository.findLoungeById(loungeId);
      if (!joined) throw Object.assign(new Error('Lounge no longer exists'), { status: 404, code: 'LOUNGE_NOT_FOUND' });
      if (joined.status === 'ended') throw Object.assign(new Error('This Lounge session has ended'), { status: 409, code: 'LOUNGE_ENDED' });
      await assertHostConnected(loungeId, joined.hostUserId);
      const state = await queueService.vote({ lounge: joined, actor: user, trackId: payload.trackId, value: Number(payload.value), requireHostPresenceUserId: joined.hostUserId });
      if (typeof repository.getCoordination !== 'function') io.to(room(loungeId)).emit('lounge.queue.update', envelope('lounge.queue.update', loungeId, { queue: queueRows(state), reason: 'vote' }));
      return { state };
    })), rateLimitPolicies.queueVote);

    command('lounge.ai.segue.trigger', (payload) => authorizedLoungeAction(async ({ loungeId, user, lounge }) => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length !== 1 || !Number.isFinite(payload.currentTs) || payload.currentTs < 0) {
        throw Object.assign(new Error('Payload must contain a non-negative currentTs'), { status: 400, code: 'VALIDATION_ERROR' });
      }
      if (user.role !== 'Host' || String(lounge.hostUserId) !== String(user.id)) throw Object.assign(new Error('Only the Lounge Host can trigger playback segues'), { status: 403, code: 'LOUNGE_HOST_REQUIRED' });
      await assertHostConnected(loungeId, lounge.hostUserId);
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
      const generatedDecision = await segueService.requestSegue({
        loungeId, userId: user.id,
        input: { currentTrackId: state.nowPlaying.trackId, currentTs: payload.currentTs, candidateTrackIds, currentSentimentScore: 0.5 },
        includeCommentary: user.aiDjCommentary,
        announce: false,
      });
      const { runtimeDiagnostics, ...decision } = generatedDecision;
      if (!decision.selectedTrackId) {
        if (recovered) await repository.clearPendingSegue?.(loungeId, savedPending.fromTrackId);
        return { noCompatibleCandidate: true, decision, ...(runtimeDiagnostics ? { runtimeDiagnostics } : {}) };
      }
      if (recovered && decision.selectedTrackId !== savedPending.trackId) {
        await repository.clearPendingSegue?.(loungeId, savedPending.fromTrackId);
        throw Object.assign(new Error('The saved segue decision is no longer eligible'), { status: 409, code: 'SEGUE_STALE' });
      }
      const createdAt = recovered ? new Date(savedPending.createdAt).getTime() : Date.now();
      if (!recovered) {
        let persisted;
        try {
          persisted = await repository.setPendingSegue?.(loungeId, state.nowPlaying.trackId, { fromTrackId: state.nowPlaying.trackId, trackId: decision.selectedTrackId, createdAt: new Date(createdAt), decision }, { requiredHostPresenceUserId: lounge.hostUserId });
        } catch { throw Object.assign(new Error('Host presence could not be verified; retry the command'), { status: 503, code: 'PRESENCE_UNAVAILABLE' }); }
        if (repository.setPendingSegue && !persisted) {
          await assertHostConnected(loungeId, lounge.hostUserId);
          throw Object.assign(new Error('The Lounge track changed before the segue could be scheduled'), { status: 409, code: 'SEGUE_STALE' });
        }
      }
      pendingSegueDecisions.set(loungeId, { fromTrackId: state.nowPlaying.trackId, trackId: decision.selectedTrackId, decision, createdAt });
      return { decision, outroWindowSeconds: config.segueOutroWindowSeconds, recovered, ...(runtimeDiagnostics ? { runtimeDiagnostics } : {}) };
    }), rateLimitPolicies.playback);

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
    }), rateLimitPolicies.playback);

    command('lounge.playback.cancel', (payload) => authorizedLoungeAction(async ({ loungeId, user, lounge }) => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length !== 1 || typeof payload.trackId !== 'string') throw Object.assign(new Error('Payload must contain only trackId'), { status: 400, code: 'VALIDATION_ERROR' });
      if (user.role !== 'Host' || String(lounge.hostUserId) !== String(user.id)) throw Object.assign(new Error('Only the Lounge Host can cancel a playback segue'), { status: 403, code: 'LOUNGE_HOST_REQUIRED' });
      if (pendingSegueDecisions.get(loungeId)?.fromTrackId === payload.trackId || lounge.pendingSegue?.fromTrackId === payload.trackId) {
        pendingSegueDecisions.delete(loungeId);
        await repository.clearPendingSegue?.(loungeId, payload.trackId);
      }
      return {};
    }), rateLimitPolicies.playback);

    command('lounge.sync.request', () => authorizedAction(async ({ loungeId }) => {
      const joined = await repository.findLoungeById(loungeId);
      if (!joined) throw Object.assign(new Error('Lounge no longer exists'), { status: 404, code: 'LOUNGE_NOT_FOUND' });
      const state = await queueService.snapshot(joined);
      state.soundclash = await soundclashService.snapshot(joined);
      state.presence = await getPresence(loungeId);
      state.hostDisconnected = !await hasHost(loungeId, joined.hostUserId);
      return { state };
    }), rateLimitPolicies.syncRequest);

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
        if (typeof repository.getCoordination === 'function') {
          await queueService.recordLoungeEvent({ lounge: currentLounge, actor: user, type: 'lounge.session.ended', payload: eventPayload });
        } else {
          io.to(room(loungeId)).emit('lounge.session.ended', envelope('lounge.session.ended', loungeId, eventPayload));
        }
      }
      return { alreadyEnded: result.alreadyEnded, endedAt: result.lounge.endedAt.toISOString(), summary: result.lounge.sessionSummary };
    })), rateLimitPolicies.sessionEnd);

    command('lounge.soundclash.submit', (payload, _acceptanceTrace, diagnostic) => authorizedLoungeAction(async ({ loungeId, user, lounge }) => {
      diagnostic('authentication_and_membership_passed');
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some((key) => key !== 'trackId')) throw Object.assign(new Error('Payload must contain only trackId'), { status: 400, code: 'VALIDATION_ERROR' });
      diagnostic('payload_validated');
      await assertHostConnected(loungeId, lounge.hostUserId);
      diagnostic('host_presence_passed');
      diagnostic('service_started');
      const result = await soundclashService.submit({ lounge, actor: user, trackId: payload.trackId, requireHostPresenceUserId: lounge.hostUserId });
      diagnostic('service_returned');
      return result;
    }), rateLimitPolicies.soundclashSubmit);

    command('lounge.soundclash.open', (payload) => authorizedLoungeAction(async ({ loungeId, user, lounge }) => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length !== 0) throw Object.assign(new Error('Payload must be empty'), { status: 400, code: 'VALIDATION_ERROR' });
      if (user.role !== 'Host' || String(user.id) !== String(lounge.hostUserId)) throw Object.assign(new Error('Only the owning Lounge Host may open a Soundclash'), { status: 403, code: 'LOUNGE_HOST_REQUIRED' });
      await assertHostConnected(loungeId, lounge.hostUserId);
      return soundclashService.open({ lounge, actor: user, requireHostPresenceUserId: lounge.hostUserId });
    }), rateLimitPolicies.soundclashOpen);

    command('lounge.soundclash.vote', (payload) => authorizedLoungeAction(async ({ user, lounge }) => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length !== 2 || !Object.hasOwn(payload, 'battleId') || !Object.hasOwn(payload, 'trackId')) throw Object.assign(new Error('Payload must contain battleId and trackId only'), { status: 400, code: 'VALIDATION_ERROR' });
      return soundclashService.vote({ lounge, actor: user, battleId: payload.battleId, trackId: payload.trackId });
    }), rateLimitPolicies.soundclashVote);

    command('lounge.soundclash.resolve', (payload) => authorizedLoungeAction(async ({ user, lounge }) => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length !== 2 || !Object.hasOwn(payload, 'battleId') || !Object.hasOwn(payload, 'winningTrackId')) throw Object.assign(new Error('Payload must contain battleId and winningTrackId only'), { status: 400, code: 'VALIDATION_ERROR' });
      await assertHostConnected(lounge.loungeId, lounge.hostUserId);
      return soundclashService.forceResolve({ lounge, actor: user, battleId: payload.battleId, winningTrackId: payload.winningTrackId, requireHostPresenceUserId: lounge.hostUserId });
    }), rateLimitPolicies.soundclashResolve);

    command('lounge.sync.ping', ({ clientSentAt }) => authorizedAction(async ({ loungeId }) => {
      if (!Number.isFinite(clientSentAt)) throw Object.assign(new Error('clientSentAt must be a timestamp'), { status: 400, code: 'VALIDATION_ERROR' });
      const payload = { clientSentAt, serverReceivedAt: Date.now() };
      socket.emit('lounge.sync.pong', envelope('lounge.sync.pong', loungeId, payload));
      return { pong: payload };
    }), rateLimitPolicies.syncRequest);

    command('lounge.chat.message', (payload) => authorizedLoungeAction(async ({ loungeId, user }) => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some((key) => !['body', 'clientMessageId'].includes(key))) {
        throw Object.assign(new Error('Payload may contain only body and clientMessageId'), { status: 400, code: 'VALIDATION_ERROR' });
      }
      const { message, sentiment, inserted } = await chatService.send({ loungeId, user, body: payload.body, clientMessageId: payload.clientMessageId });
      const messagePayload = { messageId: message.messageId, userId: String(message.userId), body: message.body, sentimentBucket: message.sentimentBucket, tsSeconds: message.tsSeconds };
      if (typeof repository.getCoordination !== 'function') {
        io.to(room(loungeId)).emit('lounge.chat.message', envelope('lounge.chat.message', loungeId, messagePayload));
        if (inserted && sentiment) io.to(room(loungeId)).emit('lounge.sentiment.score', envelope('lounge.sentiment.score', loungeId, sentiment));
      }
      return { message: messagePayload, sentiment };
    }));

    command('lounge.chat.history', (payload) => authorizedLoungeAction(async ({ loungeId }) => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some((key) => key !== 'limit')) {
        throw Object.assign(new Error('Payload may contain only limit'), { status: 400, code: 'VALIDATION_ERROR' });
      }
      const limit = payload.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw Object.assign(new Error('limit must be an integer between 1 and 100'), { status: 400, code: 'VALIDATION_ERROR' });
      return { messages: await chatService.history(loungeId, limit), sentiment: await chatService.sentiment(loungeId) };
    }), rateLimitPolicies.chatHistory);

    socket.on('disconnect', async () => {
      const loungeId = loungeBySocket.get(socket.id);
      if (!loungeId) return;
      try {
        await serializeLoungeCommand(loungeId, async () => {
          let finalSocketDisconnected = false;
          await serializeParticipantLease(loungeId, socket.data.userId, async () => {
            loungeBySocket.delete(socket.id);
            const currentMembers = members(loungeId);
            const entry = currentMembers.get(socket.data.userId);
            if (!entry) return;
            entry.sockets.delete(socket.id);
            if (entry.sockets.size === 0) {
              currentMembers.delete(socket.data.userId);
              await repository.removeGatewayPresence?.(loungeId, {
                gatewayId: gatewayInstanceId,
                userId: socket.data.userId,
                generation: entry.presenceGeneration,
              }).catch(() => {});
              await repository.releaseAdmissionLease?.(loungeId, entry.leaseId).catch(() => {});
              finalSocketDisconnected = true;
            }
          });
          if (finalSocketDisconnected) {
            const lounge = await repository.findLoungeById(loungeId);
            if (String(lounge?.hostUserId) === socket.data.userId) {
              pendingSegueDecisions.delete(loungeId);
              if (lounge?.pendingSegue?.fromTrackId) await repository.clearPendingSegue?.(loungeId, lounge.pendingSegue.fromTrackId);
            }
            if (lounge?.status === 'live') await emitPresence(loungeId, socket.data.userId, 'left');
          }
        });
      } catch { /* A disconnected socket cannot receive an error; the next analytics read reports incomplete sources. */ }
    });
  });
  return {
    io, queueService, chatService, sentimentService, soundclashService,
    async close() {
      gatewayClosing = true;
      clearInterval(pollTimer);
      clearInterval(presenceTimer);
      clearInterval(leaseRenewalTimer);
      soundclashService.close?.();
      await queueService.flushAll?.();
      if (typeof repository.releaseAdmissionLease === 'function') {
        const leases = [...socketsByLounge].flatMap(([loungeId, participants]) => [...participants].map(([userId, { leaseId, presenceGeneration }]) => ({ loungeId, userId, leaseId, presenceGeneration })));
        await Promise.all(leases.map(({ loungeId, userId, leaseId, presenceGeneration }) => serializeParticipantLease(loungeId, userId, async () => {
          await repository.removeGatewayPresence?.(loungeId, { gatewayId: gatewayInstanceId, userId, generation: presenceGeneration }).catch(() => {});
          await repository.releaseAdmissionLease(loungeId, leaseId).catch(() => {});
        })));
      }
    },
    renewParticipantLeases,
    publishAnnouncement: (loungeId, payload) => publishLoungeEvent(io, 'lounge.ai.dj_announcement', loungeId, payload),
  };
}

function queueRows(state) {
  const rows = [];
  if (state.nowPlaying) rows.push({ trackId: state.nowPlaying.trackId, position: 0 });
  state.nextUp.forEach((track, index) => rows.push({ trackId: track.trackId, position: index + 1 }));
  return rows;
}
