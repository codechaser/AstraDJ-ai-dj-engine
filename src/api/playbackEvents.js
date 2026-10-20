export function buildCompletionInteraction(track, observedDurationSeconds, liked = false) {
  if (!track?.trackId || !track?.audioAssetUrl) return null;
  const catalogDuration = Number(track.durationSeconds);
  if (!Number.isFinite(catalogDuration) || catalogDuration <= 0 || !Number.isFinite(observedDurationSeconds)) return null;
  if (Math.abs(observedDurationSeconds - catalogDuration) > 1) return null;
  return { trackId: track.trackId, playedSeconds: catalogDuration, completed: true, liked: Boolean(liked) };
}
