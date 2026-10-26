const emptyBattle = () => ({
  battleId: null,
  status: 'idle',
  submissions: [],
  candidateTrackIds: [],
  votes: {},
  closesAt: null,
  openedBy: null,
  winningTrackId: null,
});

export function createCoordinationState(lounge, events = []) {
  const queue = lounge.queue?.length ? lounge.queue : (lounge.currentTrackId ? [lounge.currentTrackId] : []);
  const state = {
    revision: 0,
    currentTrackId: lounge.currentTrackId ?? queue[0] ?? null,
    items: queue.map((trackId) => ({ trackId, votes: {} })),
    battlePriorityTrackId: null,
    pendingSegue: lounge.pendingSegue?.fromTrackId ? lounge.pendingSegue : null,
    soundclash: emptyBattle(),
  };
  for (const event of events) applyCoordinationEvent(state, event);
  return state;
}

export function applyCoordinationEvent(state, event) {
  const payload = event.payload ?? {};
  const actorId = event.actorUserId == null ? null : String(event.actorUserId);
  if (event.type === 'track.added' && !state.items.some((item) => item.trackId === payload.trackId)) {
    state.items.push({ trackId: payload.trackId, votes: {} });
  } else if (event.type === 'track.voted') {
    const item = state.items.find((entry) => entry.trackId === payload.trackId);
    if (item && actorId) {
      if (payload.value === 0) delete item.votes[actorId];
      else item.votes[actorId] = payload.value;
    }
  } else if (event.type === 'track.transitioned') {
    state.items = state.items.filter((item) => item.trackId !== payload.fromTrackId);
    state.currentTrackId = payload.trackId;
    state.pendingSegue = null;
  } else if (event.type === 'segue.prepared') {
    state.pendingSegue = payload;
  } else if (event.type === 'segue.cancelled') {
    if (state.pendingSegue?.fromTrackId === payload.fromTrackId) state.pendingSegue = null;
  } else if (event.type === 'soundclash.submitted') {
    if (state.soundclash.battleId !== payload.battleId) state.soundclash = { ...emptyBattle(), battleId: payload.battleId, status: 'collecting' };
    if (!state.soundclash.candidateTrackIds.includes(payload.trackId)) {
      state.soundclash.candidateTrackIds.push(payload.trackId);
      state.soundclash.submissions.push({ trackId: payload.trackId, submittedByUserId: actorId });
    }
  } else if (event.type === 'soundclash.opened' && state.soundclash.battleId === payload.battleId) {
    Object.assign(state.soundclash, { status: 'open', candidateTrackIds: [...payload.candidateTrackIds], closesAt: payload.closesAt, openedBy: payload.openedBy ?? (actorId ? 'host' : 'ai_dj'), votes: {} });
  } else if (event.type === 'soundclash.voted' && state.soundclash.battleId === payload.battleId && state.soundclash.status === 'open' && actorId) {
    state.soundclash.votes[actorId] = payload.trackId;
  } else if (event.type === 'soundclash.tied' && state.soundclash.battleId === payload.battleId) {
    state.soundclash.status = 'tied';
  } else if (event.type === 'soundclash.resolved' && state.soundclash.battleId === payload.battleId) {
    state.soundclash.status = 'resolved';
    state.soundclash.winningTrackId = payload.winningTrackId;
    const index = state.items.findIndex((item) => item.trackId === payload.winningTrackId);
    const winner = index >= 0 ? state.items.splice(index, 1)[0] : { trackId: payload.winningTrackId, votes: {} };
    const currentIndex = state.items.findIndex((item) => item.trackId === state.currentTrackId);
    state.items.splice(Math.max(currentIndex, -1) + 1, 0, winner);
    state.battlePriorityTrackId = payload.winningTrackId;
  }
  state.revision = Math.max(state.revision, Number(event.seq) || 0);
  return state;
}

export function serializeCoordinationState(state) {
  return {
    revision: state.revision,
    currentTrackId: state.currentTrackId,
    items: state.items.map(({ trackId, votes }) => ({ trackId, votes: { ...votes } })),
    battlePriorityTrackId: state.battlePriorityTrackId,
    pendingSegue: state.pendingSegue ?? null,
    soundclash: structuredClone(state.soundclash ?? emptyBattle()),
  };
}

export function deserializeCoordinationState(state) {
  return {
    ...state,
    items: (state.items ?? []).map(({ trackId, votes }) => ({ trackId, votes: { ...votes } })),
    soundclash: structuredClone(state.soundclash ?? emptyBattle()),
  };
}
