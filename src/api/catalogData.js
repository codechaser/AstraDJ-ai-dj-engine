export function formatTrackDuration(seconds = 0) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

const artistPortraits = Object.freeze({
  kainotomic: '/assets/artists/kainotomic.webp',
  'kian moretz': '/assets/artists/kian-moretz.webp',
  maddy: '/assets/artists/maddy.webp',
  'mira sol': '/assets/artists/mira-sol.webp',
  'nova circuit': '/assets/artists/nova-circuit.webp',
  'the quiet current': '/assets/artists/the-quiet-current.webp',
});

const trackCovers = Object.freeze({
  t_2001: '/assets/covers/night-drive.webp',
  t_2002: '/assets/covers/blue-horizon.webp',
  t_2003: '/assets/covers/afterglow-avenue.webp',
  t_cc0_thoughtness: '/assets/covers/thoughtness.webp',
  t_cc0_chill_beat: '/assets/covers/chill-beat.webp',
  t_cc0_ivory_atlas: '/assets/covers/ivory-atlas.webp',
  t_cc0_faded_fortress: '/assets/covers/faded-fortress.webp',
});

export function artistPortraitUrl(artistName) {
  return typeof artistName === 'string' ? artistPortraits[artistName.trim().toLocaleLowerCase()] ?? null : null;
}

export function trackCoverUrl(track) {
  if (typeof track?.coverImageUrl === 'string' && track.coverImageUrl.startsWith('/assets/covers/')) return track.coverImageUrl;
  return typeof track?.trackId === 'string' ? trackCovers[track.trackId] ?? null : null;
}

export function toPlayerTrack(track) {
  return { ...track, coverImageUrl: trackCoverUrl(track), time: formatTrackDuration(track.durationSeconds) };
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
