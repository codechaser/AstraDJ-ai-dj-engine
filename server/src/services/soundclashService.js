import crypto from 'node:crypto';
import { ApiError } from '../utils/ApiError.js';
import { queueRepository } from './queueRepository.js';
import { createQueueService } from './queueService.js';
import { deterministicTransitionProvider } from './transitionProvider.js';

const DEFAULT_VOTE_DURATION_MS = 30_000;
const trackIdPattern = /^t_[A-Za-z0-9_-]{1,64}$/;
const initialState = () => ({ battleId: null, status: 'idle', submissions: [], candidateTrackIds: [], votes: {}, closesAt: null, openedBy: null, winningTrackId: null });

function countsFor(state) {
  const counts = Object.fromEntries(state.candidateTrackIds.map((trackId) => [trackId, 0]));
  for (const trackId of Object.values(state.votes)) if (Object.hasOwn(counts, trackId)) counts[trackId] += 1;
  return counts;
}

function applyHistoryEvent(state, event) {
  const payload = event.payload ?? {};
  if (!event.type?.startsWith('soundclash.')) return state;
  if (event.type === 'soundclash.submitted') {
    if (state.battleId !== payload.battleId) Object.assign(state, initialState(), { battleId: payload.battleId, status: 'collecting' });
    if (!state.candidateTrackIds.includes(payload.trackId)) {
      state.candidateTrackIds.push(payload.trackId);
      state.submissions.push({ trackId: payload.trackId, submittedByUserId: String(event.actorUserId) });
    }
  }
  if (event.type === 'soundclash.opened' && state.battleId === payload.battleId) {
    state.candidateTrackIds = [...payload.candidateTrackIds];
    state.status = 'open';
    state.closesAt = payload.closesAt;
    state.openedBy = payload.openedBy ?? (event.actorUserId ? 'host' : 'ai_dj');
  }
  if (event.type === 'soundclash.voted' && state.battleId === payload.battleId && state.status === 'open') {
    state.votes[String(event.actorUserId)] = payload.trackId;
  }
  if (event.type === 'soundclash.tied' && state.battleId === payload.battleId) state.status = 'tied';
  if (event.type === 'soundclash.resolved' && state.battleId === payload.battleId) {
    state.status = 'resolved';
    state.winningTrackId = payload.winningTrackId;
  }
  return state;
}

export function createSoundclashService({
  repository = queueRepository,
  queueService = createQueueService(repository),
  transitionProvider = deterministicTransitionProvider,
  onEvent = () => {},
  now = () => Date.now(),
  voteDurationMs = DEFAULT_VOTE_DURATION_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const states = new Map();
  const timers = new Map();
  const locks = new Map();

  async function serialized(loungeId, operation) {
    const previous = locks.get(loungeId) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const chain = previous.then(() => gate);
    locks.set(loungeId, chain);
    await previous;
    try { return await operation(); }
    finally { release(); if (locks.get(loungeId) === chain) locks.delete(loungeId); }
  }

  function emit(event, loungeId, payload) {
    onEvent(event, loungeId, payload);
  }

  function cancelTimer(loungeId) {
    const timer = timers.get(loungeId);
    if (timer) clearTimer(timer);
    timers.delete(loungeId);
  }

  function scheduleDeadline(lounge, state, retry = false) {
    cancelTimer(lounge.loungeId);
    if (state.status !== 'open') return;
    const delay = retry ? 1000 : Math.max(0, state.closesAt - now());
    const timer = setTimer(() => {
      timers.delete(lounge.loungeId);
      void serialized(lounge.loungeId, async () => {
        const currentLounge = await repository.findLoungeById(lounge.loungeId);
        if (!currentLounge || currentLounge.status === 'ended') { states.delete(lounge.loungeId); cancelTimer(lounge.loungeId); return; }
        const current = await loadState(currentLounge);
        if (current.status === 'open' && current.battleId === state.battleId && current.closesAt <= now()) await closeVoting(currentLounge, current);
      }).catch(() => {
        const current = states.get(lounge.loungeId);
        if (current?.status === 'open' && current.battleId === state.battleId) scheduleDeadline(lounge, current, true);
      });
    }, delay);
    timer?.unref?.();
    timers.set(lounge.loungeId, timer);
  }

  async function loadState(lounge) {
    // Process-local state is a cache only. Reload the durable event projection
    // before every command/snapshot so another application instance is visible.
    const state = initialState();
    const events = await queueService.listEvents(lounge.loungeId);
    for (const event of events) applyHistoryEvent(state, event);
    states.set(lounge.loungeId, state);
    if (state.status === 'open') scheduleDeadline(lounge, state);
    return state;
  }

  function publicState(state) {
    return {
      battleId: state.battleId,
      status: state.status,
      active: state.status === 'open',
      candidateTrackIds: [...state.candidateTrackIds],
      voteCounts: countsFor(state),
      closesAt: state.closesAt,
      openedBy: state.openedBy,
      winningTrackId: state.winningTrackId,
    };
  }

  function ensureEnabled(lounge) {
    if (lounge.settings?.soundclashEnabled === false) throw new ApiError(409, 'SOUNDCLASH_DISABLED', 'Soundclash is disabled for this Lounge');
  }

  async function record(lounge, actor, type, payload) {
    const committed = await queueService.recordLoungeEvent({ lounge, actor, type, payload });
    return committed?.events?.at(-1) ?? committed;
  }

  async function openLocked(lounge, state, actor, openedBy) {
    ensureEnabled(lounge);
    if (state.status === 'open') return { state: publicState(state) };
    if (state.status !== 'collecting') throw new ApiError(409, 'SOUNDCLASH_NOT_COLLECTING', 'Soundclash submissions are not ready to open');
    if (state.candidateTrackIds.length < 2 || state.candidateTrackIds.length > 4) throw new ApiError(400, 'SOUNDCLASH_REQUIRES_2_TO_4_CANDIDATES', 'A Soundclash requires two to four submitted tracks');
    const closesAt = now() + voteDurationMs;
    await record(lounge, actor, 'soundclash.opened', { battleId: state.battleId, candidateTrackIds: [...state.candidateTrackIds], closesAt, openedBy });
    Object.assign(state, await loadState(lounge));
    const payload = { battleId: state.battleId, candidateTrackIds: [...state.candidateTrackIds], closesAt };
    emit('lounge.soundclash.open', lounge.loungeId, payload);
    scheduleDeadline(lounge, state);
    return { state: publicState(state) };
  }

  async function recoverAutomaticOpen(lounge, state) {
    if (state.status === 'collecting' && state.candidateTrackIds.length >= 2) await openLocked(lounge, state, null, 'ai_dj');
  }

  async function finalize(lounge, state, winningTrackId, actor, autoResolved) {
    const queue = await queueService.spliceNextUp({ lounge, actor, battleId: state.battleId, winningTrackId, autoResolved });
    state.status = 'resolved';
    state.winningTrackId = winningTrackId;
    cancelTimer(lounge.loungeId);
    emit('lounge.queue.update', lounge.loungeId, {
      queue: [queue.nowPlaying, ...queue.nextUp].filter(Boolean).map((track, position) => ({ trackId: track.trackId, position })),
      reason: 'battle',
    });
    emit('lounge.soundclash.resolved', lounge.loungeId, { battleId: state.battleId, winningTrackId });

    try {
      const [currentTrack, winningTrack] = await Promise.all([
        lounge.currentTrackId ? repository.getTrackMetadata(lounge.currentTrackId) : null,
        repository.getTrackMetadata(winningTrackId),
      ]);
      if (currentTrack && winningTrack) {
        const announcement = await transitionProvider.generate({ currentTrack, selectedTrack: winningTrack });
        emit('lounge.ai.dj_announcement', lounge.loungeId, {
          text: announcement.transitionScript,
          relatedTrackId: winningTrackId,
          sourceEvents: announcement.sourceEvents,
        });
      }
    } catch { /* Optional announcement failures do not roll back a persisted winner. */ }
    return { state: publicState(state), queue };
  }

  async function closeVoting(lounge, state) {
    const counts = countsFor(state);
    const highest = Math.max(...Object.values(counts));
    const leaders = Object.entries(counts).filter(([, count]) => count === highest).map(([trackId]) => trackId);
    if (leaders.length === 1) return finalize(lounge, state, leaders[0], null, true);
    if (state.status !== 'tied') {
      await record(lounge, null, 'soundclash.tied', { battleId: state.battleId, voteCounts: counts });
      Object.assign(state, await loadState(lounge));
      cancelTimer(lounge.loungeId);
      emit('lounge.soundclash.vote', lounge.loungeId, { battleId: state.battleId, voteCounts: counts, closesAt: state.closesAt, status: 'tied' });
    }
    return { state: publicState(state), tiedTrackIds: leaders };
  }

  return {
    async snapshot(lounge) {
      return serialized(lounge.loungeId, async () => {
        const state = await loadState(lounge);
        await recoverAutomaticOpen(lounge, state);
        return publicState(state);
      });
    },

    async submit({ lounge, actor, trackId }) {
      return serialized(lounge.loungeId, async () => {
        if (actor.role !== 'Listener') throw new ApiError(403, 'FORBIDDEN', 'Only Lounge Listeners may submit Soundclash tracks');
        ensureEnabled(lounge);
        const state = await loadState(lounge);
        if (state.submissions.some((submission) => submission.submittedByUserId === String(actor.id))) throw new ApiError(409, 'SOUNDCLASH_ALREADY_SUBMITTED', 'Each Listener may submit one track per Soundclash');
        if (state.status === 'open' || state.status === 'tied') throw new ApiError(409, 'SOUNDCLASH_ALREADY_ACTIVE', 'A Soundclash is already underway');
        if (typeof trackId !== 'string' || !trackIdPattern.test(trackId)) throw new ApiError(400, 'VALIDATION_ERROR', 'trackId is invalid');
        const queue = await queueService.snapshot(lounge);
        if (!queue.nowPlaying || queue.nextUp.length === 0) throw new ApiError(409, 'NEXT_UP_REQUIRED', 'Add a Next Up track before collecting Soundclash entries');
        if (!await repository.getTrack(trackId)) throw new ApiError(404, 'TRACK_NOT_FOUND', 'The submitted track does not exist');
        if ([queue.nowPlaying, ...queue.nextUp].some((track) => track.trackId === trackId)) throw new ApiError(409, 'TRACK_ALREADY_QUEUED', 'A queued track cannot be submitted to Soundclash');
        const startsNewBattle = state.status === 'idle' || state.status === 'resolved' || state.status === 'cancelled';
        const targetState = startsNewBattle ? Object.assign(initialState(), { battleId: crypto.randomUUID(), status: 'collecting' }) : state;
        if (targetState.submissions.some((submission) => submission.submittedByUserId === String(actor.id))) throw new ApiError(409, 'SOUNDCLASH_ALREADY_SUBMITTED', 'Each Listener may submit one track per Soundclash');
        if (targetState.candidateTrackIds.includes(trackId)) throw new ApiError(409, 'TRACK_ALREADY_SUBMITTED', 'This track is already submitted');
        if (targetState.candidateTrackIds.length >= 4) throw new ApiError(409, 'SOUNDCLASH_CANDIDATE_LIMIT', 'A Soundclash accepts at most four tracks');

        const submissionEvent = await record(lounge, actor, 'soundclash.submitted', { battleId: targetState.battleId, trackId });
        if (submissionEvent?.payload?.battleId) targetState.battleId = submissionEvent.payload.battleId;
        Object.assign(state, await loadState(lounge));
        const submission = { battleId: state.battleId, trackId, submittedByUserId: String(actor.id), candidateCount: state.candidateTrackIds.length };
        emit('lounge.soundclash.submission', lounge.loungeId, submission);
        if (state.candidateTrackIds.length >= 2) await openLocked(lounge, state, null, 'ai_dj');
        return { state: publicState(state), submission };
      });
    },

    async open({ lounge, actor }) {
      return serialized(lounge.loungeId, async () => {
        if (actor.role !== 'Host') throw new ApiError(403, 'FORBIDDEN', 'Only the Lounge Host may open a Soundclash');
        const state = await loadState(lounge);
        return openLocked(lounge, state, actor, 'host');
      });
    },

    async vote({ lounge, actor, battleId, trackId }) {
      return serialized(lounge.loungeId, async () => {
        if (actor.role !== 'Listener') throw new ApiError(403, 'FORBIDDEN', 'Only Lounge Listeners may vote in Soundclash');
        ensureEnabled(lounge);
        const state = await loadState(lounge);
        if (state.battleId !== battleId) throw new ApiError(404, 'SOUNDCLASH_NOT_FOUND', 'Soundclash battle not found');
        if (state.status === 'open' && state.closesAt <= now()) {
          await closeVoting(lounge, state);
          throw new ApiError(409, 'SOUNDCLASH_CLOSED', 'Soundclash voting has closed');
        }
        if (state.status !== 'open') throw new ApiError(409, 'SOUNDCLASH_NOT_ACTIVE', 'There is no active Soundclash vote');
        if (typeof trackId !== 'string' || !state.candidateTrackIds.includes(trackId)) throw new ApiError(400, 'VALIDATION_ERROR', 'trackId must identify a Soundclash candidate');
        if (Object.hasOwn(state.votes, String(actor.id))) throw new ApiError(409, 'SOUNDCLASH_DUPLICATE_VOTE', 'Each Listener may vote once per Soundclash');
        // Acknowledged votes must be durable before the state is exposed or
        // broadcast. Unlike the general queue's batched upvotes, Soundclash
        // vote totals determine the battle outcome and must survive a crash.
        await record(lounge, actor, 'soundclash.voted', { battleId, trackId });
        Object.assign(state, await loadState(lounge));
        const voteCounts = countsFor(state);
        const payload = { battleId, voteCounts, closesAt: state.closesAt };
        emit('lounge.soundclash.vote', lounge.loungeId, payload);
        return { state: publicState(state), voteCounts };
      });
    },

    async forceResolve({ lounge, actor, battleId, winningTrackId }) {
      return serialized(lounge.loungeId, async () => {
        if (!['Host', 'Co-DJ'].includes(actor.role)) throw new ApiError(403, 'FORBIDDEN', 'Only a Host or Co-DJ may resolve a tied Soundclash');
        ensureEnabled(lounge);
        const state = await loadState(lounge);
        if (state.battleId !== battleId) throw new ApiError(404, 'SOUNDCLASH_NOT_FOUND', 'Soundclash battle not found');
        if (state.status === 'resolved') {
          if (state.winningTrackId !== winningTrackId) throw new ApiError(409, 'SOUNDCLASH_ALREADY_RESOLVED', 'Soundclash was resolved to another track');
          return { state: publicState(state), queue: await queueService.snapshot(lounge), duplicate: true };
        }
        if (state.status === 'open' && state.closesAt <= now()) await closeVoting(lounge, state);
        if (state.status !== 'tied') throw new ApiError(409, 'SOUNDCLASH_NOT_TIED', 'Only a closed tied Soundclash can be force-resolved');
        const counts = countsFor(state);
        const highest = Math.max(...Object.values(counts));
        const tiedTrackIds = Object.entries(counts).filter(([, count]) => count === highest).map(([id]) => id);
        if (!tiedTrackIds.includes(winningTrackId)) throw new ApiError(400, 'INVALID_TIE_WINNER', 'winningTrackId must be one of the tied candidates');
        return finalize(lounge, state, winningTrackId, actor, false);
      });
    },

    close() {
      for (const timer of timers.values()) clearTimer(timer);
      timers.clear();
      states.clear();
    },
    async closeLounge(loungeId) {
      return serialized(loungeId, async () => {
        cancelTimer(loungeId);
        states.delete(loungeId);
      });
    },
  };
}
