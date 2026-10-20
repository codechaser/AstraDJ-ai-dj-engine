import { ApiError } from '../utils/ApiError.js';

// Queue order and vote tallies live in memory. Compact append-only commands are
// replayed after a process restart; no full queue snapshot is written per vote.
export function createQueueService(repository, { voteBatchSize = 20, voteFlushMs = 1000 } = {}) {
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
    const tracks = await Promise.all(ids.map((id) => repository.getTrack(id)));
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
    async join({ inviteCode, userId }) {
      const lounge = await repository.findLoungeByInvite(inviteCode);
      if (!lounge) throw new ApiError(404, 'LOUNGE_NOT_FOUND', 'The Lounge invite code is invalid or expired');
      const joined = await repository.joinLounge(lounge, userId);
      if (!joined) throw new ApiError(409, 'LOUNGE_FULL', 'The Lounge has reached its participant limit');
      const state = await getState(joined);
      return { lounge: joined, state: await publicState(joined, state) };
    },
    async snapshot(lounge) { return publicState(lounge, await getState(lounge)); },
    async listEvents(loungeId) { return repository.listQueueEvents(loungeId); },
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
          await repository.appendQueueEvents([event]);
          applyEvent(state, event);
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
        await repository.appendQueueEvents([event]);
        applyEvent(state, event);
        return publicState(lounge, state);
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
