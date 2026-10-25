/** Classifies actual media playback timing for the configured segue decision window. */
export function outroPlaybackState({ isHost, connected, playing, currentTime, duration, windowSeconds, hasCandidate }) {
  if (!isHost || !connected || !hasCandidate) return 'inactive';
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(currentTime) || currentTime < 0 || currentTime > duration) return 'invalid';
  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) return 'invalid';
  if (!playing) return 'paused';
  return duration - currentTime <= windowSeconds ? 'outro' : 'before-outro';
}
