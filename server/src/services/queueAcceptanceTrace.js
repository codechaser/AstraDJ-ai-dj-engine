import { createHash } from 'node:crypto';

export function acceptanceTracingEnabled() {
  return process.env.ASTRA_LOUNGE_ACCEPTANCE_TRACE === 'true';
}

export function recordAcceptanceDuration(trace, name, durationMs) {
  if (!trace || !Number.isFinite(durationMs)) return;
  trace.timings ??= {};
  trace.timings[name] = Number(((trace.timings[name] ?? 0) + durationMs).toFixed(3));
}

export function queueTrackIds(state) {
  const ordered = state.items.map((item, index) => ({
    trackId: item.trackId,
    votes: Object.values(item.votes ?? {}).reduce((sum, vote) => sum + vote, 0),
    index,
  })).filter((item) => item.trackId !== state.currentTrackId)
    .sort((left, right) => (left.trackId === state.battlePriorityTrackId ? -1
      : right.trackId === state.battlePriorityTrackId ? 1
        : right.votes - left.votes || left.index - right.index));
  return [state.currentTrackId, ...ordered.map(({ trackId }) => trackId)].filter(Boolean);
}

export function queueStateHash(revision, trackIds) {
  const canonicalState = {
    revision,
    queue: trackIds.map((trackId, position) => ({ trackId, position })),
  };
  return createHash('sha256').update(JSON.stringify(canonicalState)).digest('hex');
}
