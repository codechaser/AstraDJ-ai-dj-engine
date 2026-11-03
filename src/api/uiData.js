export function uniqueChatMessages(rows) {
  return [...new Map((rows ?? []).filter((row) => row?.messageId).map((row) => [row.messageId, row])).values()];
}

export function applySoundclashEvent(current, eventName, payload = {}) {
  if (eventName === 'lounge.soundclash.open') return {
    ...(current?.battleId === payload.battleId ? current : {}), ...payload, status: 'open',
    voteCounts: Object.fromEntries((payload.candidateTrackIds ?? []).map((id) => [id, 0])),
  };
  if (eventName === 'lounge.soundclash.submission') {
    return current?.battleId === payload.battleId
      ? { ...current, candidateTrackIds: [...new Set([...(current.candidateTrackIds ?? []), payload.trackId])] }
      : { battleId: payload.battleId, status: 'collecting', candidateTrackIds: [payload.trackId], voteCounts: {} };
  }
  if (current?.battleId !== payload.battleId) return current;
  if (eventName === 'lounge.soundclash.vote') return { ...current, ...payload };
  if (eventName === 'lounge.soundclash.resolved') return { ...current, ...payload, status: 'resolved' };
  return current;
}

export function tiedCandidateIds(battle) {
  if (battle?.status !== 'tied') return [];
  const ids = battle.candidateTrackIds ?? [];
  const max = Math.max(0, ...ids.map((id) => battle.voteCounts?.[id] ?? 0));
  return ids.filter((id) => (battle.voteCounts?.[id] ?? 0) === max);
}

export function normalizeRecommendations(payload) {
  return Array.isArray(payload?.items) ? payload.items.filter((item) => item && typeof item.trackId === 'string' && typeof item.title === 'string' && typeof item.artist === 'string') : [];
}

export function displayAnalyticsMetric(value) {
  return value == null ? 'Unavailable' : value;
}

export function segueCommentaryText(segue, enabled) {
  if (!segue?.selectedTrackId) return null;
  return shouldShowAiDjCommentary(enabled) ? segue.transitionScript : 'DJ commentary is disabled in your audio settings.';
}

export function shouldShowAiDjCommentary(enabled) {
  return enabled === true;
}
