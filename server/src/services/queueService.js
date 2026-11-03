import { performance } from 'node:perf_hooks';
import { ApiError } from '../utils/ApiError.js';
import { matchSegueCandidate } from './acousticMatcher.js';
import { applyCoordinationEvent, deserializeCoordinationState, serializeCoordinationState } from './coordinationState.js';
import { acceptanceTracingEnabled, queueStateHash, queueTrackIds, recordAcceptanceDuration } from './queueAcceptanceTrace.js';

async function getTracks(repository, trackIds) {
  if (typeof repository.getTracks === 'function') return repository.getTracks(trackIds);
  return Promise.all(trackIds.map((trackId) => repository.getTrack(trackId)));
}

function createCoordinatedQueueService(repository) {
  const MAX_RETRIES = 12;

  async function getState(loungeId, acceptanceTrace = null) {
    const started = acceptanceTrace ? performance.now() : 0;
    const loaded = await repository.getCoordination(loungeId);
    if (acceptanceTrace) recordAcceptanceDuration(acceptanceTrace, 'coordinationReadMs', performance.now() - started);
    if (!loaded) throw new ApiError(404, 'LOUNGE_NOT_FOUND', 'The Lounge no longer exists');
    return { lounge: loaded.lounge, coordination: loaded.coordination, state: deserializeCoordinationState(loaded.coordination.state) };
  }

  async function publicState(lounge, state, presence = [], acceptanceTrace = null) {
    const ordered = state.items.map((item, index) => ({ trackId: item.trackId, votes: Object.values(item.votes).reduce((sum, value) => sum + value, 0), _index: index }))
      .filter((item) => item.trackId !== state.currentTrackId)
      .sort((a, b) => (a.trackId === state.battlePriorityTrackId ? -1 : b.trackId === state.battlePriorityTrackId ? 1 : b.votes - a.votes || a._index - b._index));
    const ids = [state.currentTrackId, ...ordered.map(({ trackId }) => trackId)].filter(Boolean);
    const lookupStarted = acceptanceTrace ? performance.now() : 0;
    const tracks = await getTracks(repository, ids);
    if (acceptanceTrace) recordAcceptanceDuration(acceptanceTrace, 'trackHydrationMs', performance.now() - lookupStarted);
    const byId = new Map(tracks.filter(Boolean).map((track) => [track.trackId, track]));
    return {
      loungeId: lounge.loungeId,
      revision: state.revision,
      nowPlaying: state.currentTrackId ? (byId.get(state.currentTrackId) ?? { trackId: state.currentTrackId }) : null,
      nextUp: ordered.map(({ trackId, votes }) => ({ ...(byId.get(trackId) ?? { trackId }), votes })),
      presence,
      hostDisconnected: !presence.some((participant) => participant.userId === String(lounge.hostUserId) && participant.connected),
      syncedAt: Date.now(),
    };
  }

  async function mutate(loungeId, build, { requireHostPresenceUserId = null, allowEnded = false, acceptanceTrace = null } = {}) {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      if (acceptanceTrace) acceptanceTrace.casAttempts = (acceptanceTrace.casAttempts ?? 0) + 1;
      const loaded = await getState(loungeId, acceptanceTrace);
      const buildStarted = acceptanceTrace ? performance.now() : 0;
      const result = await build(loaded);
      if (acceptanceTrace) recordAcceptanceDuration(acceptanceTrace, 'eventValidationBuildMs', performance.now() - buildStarted);
      if (result.noChange) {
        if (requireHostPresenceUserId && typeof repository.hasActiveGatewayPresence === 'function') {
          try {
            if (!await repository.hasActiveGatewayPresence(loungeId, requireHostPresenceUserId)) throw new ApiError(409, 'HOST_DISCONNECTED', 'The Lounge Host is not currently connected');
          } catch (error) {
            if (error.code === 'HOST_DISCONNECTED') throw error;
            throw new ApiError(503, 'PRESENCE_UNAVAILABLE', 'Host presence could not be verified; retry the command');
          }
        }
        return { ...result, state: await publicState(loaded.lounge, loaded.state, [], acceptanceTrace) };
      }
      const nextState = structuredClone(loaded.state);
      const drafts = result.events;
      const committedEvents = drafts.map((draft, index) => ({
        loungeId,
        seq: loaded.state.revision + index + 1,
        type: draft.type,
        actorUserId: draft.actorUserId ?? null,
        payload: draft.payload,
        createdAt: draft.createdAt ?? new Date(),
      }));
      for (const event of committedEvents) applyCoordinationEvent(nextState, event);
      if (acceptanceTrace && acceptanceTracingEnabled()) {
        const traceEvent = committedEvents.find((event) => event.payload?.acceptanceTrace?.traceId === acceptanceTrace.traceId);
        if (traceEvent) {
          const trackIds = queueTrackIds(nextState);
          Object.assign(acceptanceTrace, {
            eventId: traceEvent.eventId ?? `${loungeId}:${traceEvent.seq}`,
            committedRevision: nextState.revision,
            committedStateHash: queueStateHash(nextState.revision, trackIds),
            mutationTrackId: traceEvent.payload.trackId,
          });
          traceEvent.payload.acceptanceTrace = acceptanceTrace;
        }
      }
      let commit;
      const commitStarted = acceptanceTrace ? performance.now() : 0;
      try {
        commit = await repository.commitCoordination({
          loungeId,
          expectedRevision: loaded.state.revision,
          state: nextState,
          events: committedEvents,
          requiredHostPresenceUserId: requireHostPresenceUserId,
          allowEnded,
          acceptanceTrace,
        });
      } catch (error) {
        if (acceptanceTrace) recordAcceptanceDuration(acceptanceTrace, 'coordinationCommitAndOutboxMs', performance.now() - commitStarted);
        if (requireHostPresenceUserId) {
          const unavailable = new ApiError(503, 'PRESENCE_UNAVAILABLE', 'Host presence could not be verified; retry the command');
          unavailable.cause = error;
          throw unavailable;
        }
        throw error;
      }
      if (acceptanceTrace) recordAcceptanceDuration(acceptanceTrace, 'coordinationCommitAndOutboxMs', performance.now() - commitStarted);
      if (!commit.committed) {
        if (commit.reason === 'missing') throw new ApiError(404, 'LOUNGE_NOT_FOUND', 'The Lounge no longer exists');
        if (commit.reason === 'host_offline') throw new ApiError(409, 'HOST_DISCONNECTED', 'The Lounge Host is not currently connected');
        if (commit.reason === 'outbox_full') throw new ApiError(503, 'LOUNGE_EVENT_BACKPRESSURE', 'Lounge updates are temporarily delayed; retry shortly');
        if (commit.reason === 'state_too_large') throw new ApiError(413, 'LOUNGE_STATE_LIMIT_REACHED', 'The Lounge state reached its safe storage limit');
        if (acceptanceTrace) acceptanceTrace.casConflicts = (acceptanceTrace.casConflicts ?? 0) + 1;
        continue;
      }
      const hydrationStarted = acceptanceTrace ? performance.now() : 0;
      const state = await publicState({ ...loaded.lounge, currentTrackId: nextState.currentTrackId }, nextState);
      if (acceptanceTrace) {
        recordAcceptanceDuration(acceptanceTrace, 'responseTrackHydrationMs', performance.now() - hydrationStarted);
        acceptanceTrace.returnedRevision = state.revision;
      }
      return { ...result, state, events: commit.events };
    }
    throw new ApiError(409, 'LOUNGE_STATE_CONFLICT', 'The Lounge changed concurrently; retry the command');
  }

  return {
    async join({ inviteCode, userId, leaseId, now, expiresAt }) {
      const lounge = await repository.findLoungeByInvite(inviteCode);
      if (!lounge) throw new ApiError(404, 'LOUNGE_NOT_FOUND', 'The Lounge invite code is invalid or expired');
      const joined = await repository.joinLounge(lounge, userId, { leaseId, now, expiresAt });
      if (!joined) {
        const current = await repository.findLoungeById(lounge.loungeId);
        if (!current) throw new ApiError(404, 'LOUNGE_NOT_FOUND', 'The Lounge invite code is invalid or expired');
        if (current.status === 'ended') throw new ApiError(409, 'LOUNGE_ENDED', 'This Lounge session has ended');
        throw new ApiError(409, 'LOUNGE_FULL', 'The Lounge has reached its participant limit');
      }
      const loaded = await getState(joined.loungeId);
      return { lounge: joined, state: await publicState(joined, loaded.state) };
    },
    async snapshot(lounge) {
      const loaded = await getState(lounge.loungeId);
      return publicState(loaded.lounge, loaded.state);
    },
    async listEvents(loungeId) { return repository.listQueueEvents(loungeId); },
    async listEventsAfter(loungeId, afterSeq) {
      if (typeof repository.listQueueEventsAfter === 'function') return repository.listQueueEventsAfter(loungeId, afterSeq);
      return (await repository.listQueueEvents(loungeId)).filter((event) => event.seq > afterSeq);
    },
    async addTrack({ lounge, actor, trackId, requireHostPresenceUserId = null, acceptanceTrace = null }) {
      if (!['Host', 'Co-DJ'].includes(actor.role)) throw new ApiError(403, 'FORBIDDEN', 'Only a Host or Co-DJ can add tracks to the shared queue');
      const lookupStarted = acceptanceTrace ? performance.now() : 0;
      if (!await repository.getTrack(trackId)) throw new ApiError(404, 'TRACK_NOT_FOUND', 'The track does not exist');
      if (acceptanceTrace) recordAcceptanceDuration(acceptanceTrace, 'mutationTrackLookupMs', performance.now() - lookupStarted);
      return (await mutate(lounge.loungeId, ({ state }) => {
        if (state.items.some((item) => item.trackId === trackId)) throw new ApiError(409, 'TRACK_ALREADY_QUEUED', 'The track is already in this queue');
        const trace = acceptanceTracingEnabled()
          && acceptanceTrace
          && typeof acceptanceTrace.traceId === 'string'
          && /^[0-9a-f-]{36}$/i.test(acceptanceTrace.traceId)
          && Number.isFinite(acceptanceTrace.serverReceivedAtUnixMs)
          ? { acceptanceTrace }
          : {};
        return { events: [{ type: 'track.added', actorUserId: actor.id, payload: { trackId, ...trace } }] };
      }, { requireHostPresenceUserId, acceptanceTrace })).state;
    },
    async vote({ lounge, actor, trackId, value, requireHostPresenceUserId = null }) {
      if (![-1, 0, 1].includes(value)) throw new ApiError(400, 'INVALID_VOTE', 'Vote value must be -1, 0, or 1');
      return (await mutate(lounge.loungeId, ({ state }) => {
        const item = state.items.find((entry) => entry.trackId === trackId);
        if (!item || trackId === state.currentTrackId) throw new ApiError(404, 'TRACK_NOT_QUEUED', 'Only an upcoming track can be voted on');
        if ((item.votes[String(actor.id)] ?? 0) === value) return { noChange: true };
        return { events: [{ type: 'track.voted', actorUserId: actor.id, payload: { trackId, value } }] };
      }, { requireHostPresenceUserId })).state;
    },
    async recordLoungeEvent({ lounge, actor, type, payload, requireHostPresenceUserId = null }) {
      return mutate(lounge.loungeId, ({ state }) => {
        let eventPayload = payload;
        if (type === 'soundclash.submitted') {
          const battle = state.soundclash;
          if (battle.status === 'open' || battle.status === 'tied') throw new ApiError(409, 'SOUNDCLASH_STATE_CONFLICT', 'A Soundclash changed concurrently; refresh and retry');
          if (battle.status === 'collecting' && battle.battleId !== payload.battleId) eventPayload = { ...payload, battleId: battle.battleId };
          if (battle.submissions.some((entry) => entry.submittedByUserId === String(actor?.id))) throw new ApiError(409, 'SOUNDCLASH_ALREADY_SUBMITTED', 'Each Listener may submit one track per Soundclash');
          if (battle.candidateTrackIds.includes(eventPayload.trackId)) throw new ApiError(409, 'TRACK_ALREADY_SUBMITTED', 'This track is already submitted');
        }
        if (type === 'soundclash.opened' && (state.soundclash.battleId !== payload.battleId || state.soundclash.status !== 'collecting')) {
          if (state.soundclash.battleId === payload.battleId && state.soundclash.status === 'open') return { noChange: true };
          throw new ApiError(409, 'SOUNDCLASH_STATE_CONFLICT', 'Soundclash state changed before opening');
        }
        if (type === 'soundclash.tied' && state.soundclash.battleId === payload.battleId && state.soundclash.status === 'tied') return { noChange: true };
        if (type === 'soundclash.voted') {
          if (state.soundclash.battleId !== payload.battleId || state.soundclash.status !== 'open') throw new ApiError(409, 'SOUNDCLASH_NOT_ACTIVE', 'There is no active Soundclash vote');
          if (Object.hasOwn(state.soundclash.votes, String(actor?.id))) throw new ApiError(409, 'SOUNDCLASH_DUPLICATE_VOTE', 'Each Listener may vote once per Soundclash');
        }
        if (type === 'soundclash.resolved' && state.soundclash.status === 'resolved' && state.soundclash.battleId === payload.battleId) return { noChange: true };
        return { events: [{ type, actorUserId: actor?.id ?? null, payload: eventPayload }] };
      }, { requireHostPresenceUserId, allowEnded: type === 'lounge.session.ended' });
    },
    async spliceNextUp({ lounge, actor, battleId, winningTrackId, autoResolved = false, requireHostPresenceUserId = null }) {
      if (!await repository.getTrack(winningTrackId)) throw new ApiError(404, 'TRACK_NOT_FOUND', 'The Soundclash winner no longer exists');
      const result = await mutate(lounge.loungeId, ({ state }) => {
        if (state.soundclash.battleId !== battleId) throw new ApiError(404, 'SOUNDCLASH_NOT_FOUND', 'Soundclash battle not found');
        if (state.soundclash.status === 'resolved') {
          if (state.soundclash.winningTrackId === winningTrackId) return { noChange: true };
          throw new ApiError(409, 'SOUNDCLASH_ALREADY_RESOLVED', 'Soundclash was resolved to another track');
        }
        if (!['tied', 'open'].includes(state.soundclash.status)) throw new ApiError(409, 'SOUNDCLASH_NOT_ACTIVE', 'Soundclash is not ready to resolve');
        return { events: [{ type: 'soundclash.resolved', actorUserId: actor?.id ?? null, payload: { battleId, winningTrackId, autoResolved } }] };
      }, { requireHostPresenceUserId });
      return result.state;
    },
    async transitionTo({ lounge, actor, trackId, transition = null }) {
      if (String(lounge.hostUserId) !== String(actor.id) || actor.role !== 'Host') throw new ApiError(403, 'LOUNGE_HOST_REQUIRED', 'Only the Lounge Host can advance a playback segue');
      if (!await repository.getTrack(trackId)) throw new ApiError(404, 'TRACK_NOT_FOUND', 'The segue track does not exist');
      return (await mutate(lounge.loungeId, async ({ state, lounge: currentLounge }) => {
        if (state.pendingSegue?.fromTrackId !== state.currentTrackId || state.pendingSegue?.trackId !== trackId) {
          throw new ApiError(409, 'SEGUE_NOT_PENDING', 'There is no matching durable playback segue to complete');
        }
        const candidate = state.items.find((item) => item.trackId === trackId);
        if (!candidate || trackId === state.currentTrackId) throw new ApiError(409, 'TRACK_NOT_QUEUED', 'The segue target must be an upcoming queue item');
        const [currentTrack, nextTrack] = await Promise.all([repository.getTrack(state.currentTrackId), repository.getTrack(trackId)]);
        const match = matchSegueCandidate(currentTrack, nextTrack, { bpmTolerancePct: currentLounge.settings?.bpmTolerancePct ?? 8 });
        if (!match.eligible) throw new ApiError(409, 'SEGUE_NO_LONGER_COMPATIBLE', 'The selected track no longer satisfies acoustic segue rules');
        return { events: [{ type: 'track.transitioned', actorUserId: actor.id, payload: { trackId, fromTrackId: state.currentTrackId, ...(transition ? { transition } : {}) } }] };
      }, { requireHostPresenceUserId: lounge.hostUserId })).state;
    },
    async flush() {},
    async flushAll() {},
    clear() {},
  };
}

// Lightweight fallback for injected in-memory/test repositories. The production
// Mongo repository selects the revisioned coordinated implementation above.
export function createQueueService(repository, { voteBatchSize = 20, voteFlushMs = 1000 } = {}) {
  if (typeof repository.getCoordination === 'function' && typeof repository.commitCoordination === 'function') return createCoordinatedQueueService(repository);
  const states = new Map();
  const locks = new Map();

  async function serialized(key, operation) {
    const previous = locks.get(key) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const chain = previous.then(() => gate);
    locks.set(key, chain);
    await previous;
    try { return await operation(); }
    finally {
      release();
      if (locks.get(key) === chain) locks.delete(key);
    }
  }

  function applyEvent(state, event) {
    if (event.type === 'track.added') {
      if (!state.items.some((item) => item.trackId === event.payload.trackId)) {
        state.items.push({ trackId: event.payload.trackId, votes: new Map() });
      }
    }
    if (event.type === 'track.voted') {
      const item = state.items.find((entry) => entry.trackId === event.payload.trackId);
      if (item) {
        if (event.payload.value === 0) item.votes.delete(String(event.actorUserId));
        else item.votes.set(String(event.actorUserId), event.payload.value);
      }
    }
    if (event.type === 'track.transitioned') state.currentTrackId = event.payload.trackId;
    if (event.type === 'soundclash.resolved') {
      const winningTrackId = event.payload.winningTrackId;
      const existingIndex = state.items.findIndex((item) => item.trackId === winningTrackId);
      const winner = existingIndex >= 0 ? state.items.splice(existingIndex, 1)[0] : { trackId: winningTrackId, votes: new Map() };
      const currentIndex = state.items.findIndex((item) => item.trackId === state.currentTrackId);
      state.items.splice(Math.max(currentIndex, -1) + 1, 0, winner);
      state.battlePriorityTrackId = winningTrackId;
    }
    state.seq = Math.max(state.seq, event.seq);
  }

  async function getState(lounge) {
    let state = states.get(lounge.loungeId);
    if (state) return state;
    const baseQueue = lounge.queue?.length ? lounge.queue : (lounge.currentTrackId ? [lounge.currentTrackId] : []);
    state = { loungeId: lounge.loungeId, currentTrackId: lounge.currentTrackId ?? baseQueue[0] ?? null, items: baseQueue.map((trackId) => ({ trackId, votes: new Map() })), battlePriorityTrackId: null, seq: 0, pendingEvents: [], flushTimer: null };
    const events = await repository.listQueueEvents(lounge.loungeId);
    for (const event of events) applyEvent(state, event);
    states.set(lounge.loungeId, state);
    return state;
  }

  const publicState = async (lounge, state, presence = []) => {
    const ordered = state.items.map((item, index) => ({ trackId: item.trackId, votes: [...item.votes.values()].reduce((sum, value) => sum + value, 0), _index: index }))
      .filter((item) => item.trackId !== state.currentTrackId)
      .sort((a, b) => (a.trackId === state.battlePriorityTrackId ? -1 : b.trackId === state.battlePriorityTrackId ? 1 : b.votes - a.votes || a._index - b._index));
    const ids = [state.currentTrackId, ...ordered.map((item) => item.trackId)].filter(Boolean);
    const tracks = await getTracks(repository, ids);
    const byId = new Map(tracks.filter(Boolean).map((track) => [track.trackId, track]));
    return {
      loungeId: lounge.loungeId,
      revision: state.seq,
      nowPlaying: state.currentTrackId ? (byId.get(state.currentTrackId) ?? { trackId: state.currentTrackId }) : null,
      nextUp: ordered.map(({ trackId, votes }) => ({ ...(byId.get(trackId) ?? { trackId }), votes })),
      presence,
      hostDisconnected: !presence.some((participant) => participant.userId === String(lounge.hostUserId) && participant.connected),
      syncedAt: Date.now(),
    };
  };

  async function flushPending(state) {
    if (state.flushTimer) { clearTimeout(state.flushTimer); state.flushTimer = null; }
    if (state.pendingEvents.length === 0) return;
    const batch = [...state.pendingEvents];
    await repository.appendQueueEvents(batch);
    state.pendingEvents.splice(0, batch.length);
  }

  async function appendCommitted(state, event) {
    try {
      await repository.appendQueueEvents([event]);
    } catch (error) {
      // Mongo can commit a write while the client receives a network error.
      // Verify the unique sequence before deciding whether the command failed;
      // never acknowledge a different event occupying that sequence.
      let events;
      try { events = await repository.listQueueEvents(state.loungeId); }
      catch { throw error; }
      const stored = events.find((candidate) => candidate.seq === event.seq);
      const sameActor = String(stored?.actorUserId ?? '') === String(event.actorUserId ?? '');
      if (!stored || stored.type !== event.type || !sameActor || JSON.stringify(stored.payload) !== JSON.stringify(event.payload)) throw error;
      applyEvent(state, stored);
      return stored;
    }
    applyEvent(state, event);
    return event;
  }

  function scheduleFlush(state) {
    if (state.flushTimer || state.pendingEvents.length === 0) return;
    state.flushTimer = setTimeout(() => {
      state.flushTimer = null;
      void serialized(state.loungeId, () => flushPending(state)).catch(() => scheduleFlush(state));
    }, voteFlushMs);
    state.flushTimer.unref?.();
  }

  async function mutate({ lounge, actor, type, payload, validate }) {
    return serialized(lounge.loungeId, async () => {
      const state = await getState(lounge);
      const validation = validate ? await validate(state) : null;
      if (validation?.noChange) return publicState(lounge, state);
      if (type === 'track.added') await flushPending(state);
      const nextSeq = state.seq + 1;
      const event = { loungeId: lounge.loungeId, seq: nextSeq, type, actorUserId: actor.id, payload, createdAt: new Date() };
      if (type === 'track.voted') {
        state.pendingEvents.push(event);
        applyEvent(state, event);
        if (state.pendingEvents.length >= voteBatchSize) {
          try { await flushPending(state); } catch { scheduleFlush(state); }
        } else scheduleFlush(state);
      } else await repository.appendQueueEvents([event]);
      if (type !== 'track.voted') applyEvent(state, event);
      return publicState(lounge, state);
    });
  }

  return {
    async join({ inviteCode, userId, leaseId, now, expiresAt }) {
      const lounge = await repository.findLoungeByInvite(inviteCode);
      if (!lounge) throw new ApiError(404, 'LOUNGE_NOT_FOUND', 'The Lounge invite code is invalid or expired');
      const joined = await repository.joinLounge(lounge, userId, { leaseId, now, expiresAt });
      if (!joined) {
        const current = await repository.findLoungeById(lounge.loungeId);
        if (!current) throw new ApiError(404, 'LOUNGE_NOT_FOUND', 'The Lounge invite code is invalid or expired');
        if (current.status === 'ended') throw new ApiError(409, 'LOUNGE_ENDED', 'This Lounge session has ended');
        throw new ApiError(409, 'LOUNGE_FULL', 'The Lounge has reached its participant limit');
      }
      const state = await getState(joined);
      return { lounge: joined, state: await publicState(joined, state) };
    },
    async snapshot(lounge) { return publicState(lounge, await getState(lounge)); },
    async listEvents(loungeId) { return repository.listQueueEvents(loungeId); },
    async listEventsAfter(loungeId, afterSeq) {
      if (typeof repository.listQueueEventsAfter === 'function') return repository.listQueueEventsAfter(loungeId, afterSeq);
      return (await repository.listQueueEvents(loungeId)).filter((event) => event.seq > afterSeq);
    },
    async recordLoungeEvent({ lounge, actor, type, payload, buffered = false }) {
      return serialized(lounge.loungeId, async () => {
        const state = await getState(lounge);
        if (!buffered) await flushPending(state);
        const event = {
          loungeId: lounge.loungeId,
          seq: state.seq + 1,
          type,
          actorUserId: actor?.id ?? null,
          payload,
          createdAt: new Date(),
        };
        if (buffered) {
          state.pendingEvents.push(event);
          applyEvent(state, event);
          if (state.pendingEvents.length >= voteBatchSize) {
            try { await flushPending(state); } catch { scheduleFlush(state); }
          } else scheduleFlush(state);
        } else {
          await appendCommitted(state, event);
        }
        return event;
      });
    },
    async spliceNextUp({ lounge, actor, battleId, winningTrackId, autoResolved = false }) {
      if (!await repository.getTrack(winningTrackId)) throw new ApiError(404, 'TRACK_NOT_FOUND', 'The Soundclash winner no longer exists');
      return serialized(lounge.loungeId, async () => {
        const state = await getState(lounge);
        await flushPending(state);
        const event = {
          loungeId: lounge.loungeId,
          seq: state.seq + 1,
          type: 'soundclash.resolved',
          actorUserId: actor?.id ?? null,
          payload: { battleId, winningTrackId, autoResolved },
          createdAt: new Date(),
        };
        await appendCommitted(state, event);
        return publicState(lounge, state);
      });
    },
    async transitionTo({ lounge, actor, trackId, transition = null }) {
      if (String(lounge.hostUserId) !== String(actor.id) || actor.role !== 'Host') throw new ApiError(403, 'LOUNGE_HOST_REQUIRED', 'Only the Lounge Host can advance a playback segue');
      if (!await repository.getTrack(trackId)) throw new ApiError(404, 'TRACK_NOT_FOUND', 'The segue track does not exist');
      return serialized(lounge.loungeId, async () => {
        const state = await getState(lounge);
        const candidate = state.items.find((item) => item.trackId === trackId);
        if (!candidate || trackId === state.currentTrackId) throw new ApiError(409, 'TRACK_NOT_QUEUED', 'The segue target must be an upcoming queue item');
        const [currentTrack, nextTrack] = await Promise.all([repository.getTrack(state.currentTrackId), repository.getTrack(trackId)]);
        const match = matchSegueCandidate(currentTrack, nextTrack, { bpmTolerancePct: lounge.settings?.bpmTolerancePct ?? 8 });
        if (!match.eligible) throw new ApiError(409, 'SEGUE_NO_LONGER_COMPATIBLE', 'The selected track no longer satisfies acoustic segue rules');
        const event = { loungeId: lounge.loungeId, seq: state.seq + 1, type: 'track.transitioned', actorUserId: actor.id, payload: { trackId, fromTrackId: state.currentTrackId, ...(transition ? { transition } : {}) }, createdAt: new Date() };
        await repository.appendQueueEvents([event]);
        const updated = await repository.setCurrentTrack?.(lounge.loungeId, trackId);
        if (repository.setCurrentTrack && !updated) throw new ApiError(409, 'LOUNGE_NOT_LIVE', 'The Lounge is no longer live');
        applyEvent(state, event);
        return publicState({ ...lounge, currentTrackId: trackId }, state);
      });
    },
    async addTrack({ lounge, actor, trackId }) {
      if (!['Host', 'Co-DJ'].includes(actor.role)) throw new ApiError(403, 'FORBIDDEN', 'Only a Host or Co-DJ can add tracks to the shared queue');
      if (!await repository.getTrack(trackId)) throw new ApiError(404, 'TRACK_NOT_FOUND', 'The track does not exist');
      return mutate({ lounge, actor, type: 'track.added', payload: { trackId }, validate: (state) => {
        if (state.items.some((item) => item.trackId === trackId)) throw new ApiError(409, 'TRACK_ALREADY_QUEUED', 'The track is already in this queue');
      } });
    },
    async vote({ lounge, actor, trackId, value }) {
      if (![-1, 0, 1].includes(value)) throw new ApiError(400, 'INVALID_VOTE', 'Vote value must be -1, 0, or 1');
      return mutate({ lounge, actor, type: 'track.voted', payload: { trackId, value }, validate: (state) => {
        if (!state.items.some((item) => item.trackId === trackId) || trackId === state.currentTrackId) throw new ApiError(404, 'TRACK_NOT_QUEUED', 'Only an upcoming track can be voted on');
        const existing = state.items.find((item) => item.trackId === trackId).votes.get(String(actor.id)) ?? 0;
        if (existing === value) return { noChange: true };
      } });
    },
    async flush(loungeId) {
      return serialized(loungeId, async () => {
        const state = states.get(loungeId);
        if (state) await flushPending(state);
      });
    },
    async flushAll() {
      await Promise.all([...states.keys()].map((loungeId) => this.flush(loungeId)));
    },
    clear(loungeId) {
      const state = states.get(loungeId);
      if (state?.flushTimer) clearTimeout(state.flushTimer);
      states.delete(loungeId);
    },
  };
}
