export function formatTrackDuration(seconds = 0) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

export function toPlayerTrack(track) {
  return { ...track, time: formatTrackDuration(track.durationSeconds), img: 'photo-1514525253161-7a46d19cd819' };
}

export function groupCatalogArtists(tracks = []) {
  const artists = new Map();
  for (const track of tracks) {
    if (typeof track?.artist !== 'string' || !track.artist.trim()) continue;
    const name = track.artist.trim();
    const existing = artists.get(name) ?? { name, tracks: [] };
    existing.tracks.push(track);
    artists.set(name, existing);
  }
  return [...artists.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function tracksForArtist(tracks = [], artistName = '') {
  const target = artistName.trim().toLocaleLowerCase();
  if (!target) return [];
  return tracks.filter((track) => track.artist?.trim().toLocaleLowerCase() === target)
    .sort((a, b) => a.title.localeCompare(b.title));
}

export function catalogDurationSeconds(tracks = []) {
  return tracks.reduce((sum, track) => sum + (Number.isFinite(track.durationSeconds) ? track.durationSeconds : 0), 0);
}
