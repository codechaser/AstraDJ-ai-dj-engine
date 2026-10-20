function referenceFor(track, index) {
  return `${track.trackId}#timeline[${index}]`;
}

export const deterministicTransitionProvider = Object.freeze({
  name: 'deterministic_fallback',
  async generate({ currentTrack, selectedTrack }) {
    const source = selectedTrack.timeline?.find((entry) => typeof entry.text === 'string' && entry.text.trim());
    const transitionScript = source
      ? `AstraDJ deterministic fallback: from “${currentTrack.title}” by ${currentTrack.artist} into “${selectedTrack.title}” by ${selectedTrack.artist}. Track metadata: “${source.text}”`
      : `AstraDJ deterministic fallback: from “${currentTrack.title}” by ${currentTrack.artist} into “${selectedTrack.title}” by ${selectedTrack.artist}.`;
    const sourceIndex = source ? selectedTrack.timeline.indexOf(source) : -1;
    return {
      transitionScript,
      sourceEvents: sourceIndex >= 0 ? [referenceFor(selectedTrack, sourceIndex)] : [],
      provider: this.name,
    };
  },
});
