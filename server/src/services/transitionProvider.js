function referenceFor(track, index) {
  return `${track.trackId}#timeline[${index}]`;
}
const safeTimelineEntry = (entry) => typeof entry?.text === 'string' && entry.text.trim().length > 0 && entry.text.trim().length <= 500 && !/[<>\u0000-\u001f]/.test(entry.text) && typeof entry.ts === 'number' && entry.ts >= 0 && ['sample_credit', 'trivia', 'glossary'].includes(entry.type);

export const deterministicTransitionProvider = Object.freeze({
  name: 'deterministic_fallback',
  async generate({ currentTrack, selectedTrack, matchReason = null }) {
    const currentTimeline = Array.isArray(currentTrack.timeline) ? currentTrack.timeline : [];
    const selectedTimeline = Array.isArray(selectedTrack.timeline) ? selectedTrack.timeline : [];
    const currentSourceIndex = currentTimeline.findIndex(safeTimelineEntry);
    const selectedSourceIndex = selectedTimeline.findIndex(safeTimelineEntry);
    const currentSource = currentSourceIndex >= 0 ? currentTimeline[currentSourceIndex] : null;
    const selectedSource = selectedSourceIndex >= 0 ? selectedTimeline[selectedSourceIndex] : null;
    const facts = [];
    if (matchReason && currentTrack.acoustic && selectedTrack.acoustic) {
      facts.push(`Tempo ${currentTrack.acoustic.bpm} to ${selectedTrack.acoustic.bpm} BPM (${matchReason.bpmDeltaPct}% delta, ${matchReason.bpmRelation}); Camelot ${currentTrack.acoustic.camelotKey} to ${selectedTrack.acoustic.camelotKey} (${matchReason.camelotRelation}); energy-fit score ${matchReason.energyFit}.`);
    }
    if (currentSource) facts.push(`Current-track metadata: “${currentSource.text}”`);
    if (selectedSource) facts.push(`Next-track metadata: “${selectedSource.text}”`);
    const trackLabel = (track) => {
      const title = typeof track.title === 'string' && track.title.trim() ? track.title.trim() : track.trackId;
      const artist = typeof track.artist === 'string' && track.artist.trim() ? ` by ${track.artist.trim()}` : '';
      return `“${title}”${artist}`;
    };
    const base = `AstraDJ deterministic fallback: from ${trackLabel(currentTrack)} into ${trackLabel(selectedTrack)}.`;
    const transitionScript = matchReason ? `${base}${facts.length ? ` ${facts.join(' ')}` : ''}`
      : selectedSource ? `${base} Track metadata: “${selectedSource.text}”` : base;
    // Keep Soundclash's existing timeline-only sourceEvents contract intact.
    const sourceEvents = matchReason ? [
      ...(typeof currentTrack.title === 'string' && currentTrack.title.trim() ? [`${currentTrack.trackId}#title`] : []),
      ...(typeof currentTrack.artist === 'string' && currentTrack.artist.trim() ? [`${currentTrack.trackId}#artist`] : []),
      ...(typeof selectedTrack.title === 'string' && selectedTrack.title.trim() ? [`${selectedTrack.trackId}#title`] : []),
      ...(typeof selectedTrack.artist === 'string' && selectedTrack.artist.trim() ? [`${selectedTrack.trackId}#artist`] : []),
    ] : (selectedSourceIndex >= 0 ? [referenceFor(selectedTrack, selectedSourceIndex)] : []);
    if (matchReason && currentTrack.acoustic && selectedTrack.acoustic) {
      sourceEvents.push(
        `${currentTrack.trackId}#acoustic.bpm`, `${selectedTrack.trackId}#acoustic.bpm`,
        `${currentTrack.trackId}#acoustic.camelotKey`, `${selectedTrack.trackId}#acoustic.camelotKey`,
        `${currentTrack.trackId}#acoustic.energy`, `${selectedTrack.trackId}#acoustic.energy`,
      );
    }
    if (matchReason && currentSourceIndex >= 0) sourceEvents.push(referenceFor({ ...currentTrack, timeline: currentTimeline }, currentSourceIndex));
    if (matchReason && selectedSourceIndex >= 0) sourceEvents.push(referenceFor({ ...selectedTrack, timeline: selectedTimeline }, selectedSourceIndex));
    return {
      transitionScript,
      sourceEvents,
      provider: this.name,
    };
  },
});
