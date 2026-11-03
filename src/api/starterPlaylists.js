export const STARTER_PLAYLIST_VERSION = 3;

export const STARTER_PLAYLISTS = Object.freeze([
  { id: 'starter-chill', name: 'Chill Mix', trackIds: ['t_cc0_chill_beat', 't_2001', 't_2002'] },
  { id: 'starter-workout', name: 'Workout Mix', trackIds: ['t_2001', 't_2003', 't_cc0_chill_beat'] },
  { id: 'starter-lofi', name: 'Lo-fi Beats', trackIds: ['t_cc0_thoughtness', 't_cc0_chill_beat', 't_2001'] },
  { id: 'starter-focus', name: 'Focus Mode', trackIds: ['t_cc0_thoughtness', 't_2002', 't_2003'] },
  { id: 'starter-party', name: 'Party Hits', trackIds: ['t_2001', 't_2003', 't_cc0_chill_beat', 't_2002'] },
].map((playlist) => Object.freeze({ ...playlist, trackIds: Object.freeze(playlist.trackIds), createdAt: null, starter: true, starterVersion: STARTER_PLAYLIST_VERSION })));

export function mergeStarterPlaylists(saved = []) {
  const merged = new Map(STARTER_PLAYLISTS.map((playlist) => [playlist.id, playlist]));
  let migrated = false;
  for (const item of saved) {
    if (!item || typeof item.id !== 'string' || typeof item.name !== 'string') continue;
    const starter = merged.get(item.id);
    const savedTrackIds = Array.isArray(item.trackIds) ? item.trackIds.filter((id) => typeof id === 'string') : [];
    if (starter) {
      const needsMigration = item.starterVersion !== STARTER_PLAYLIST_VERSION;
      const trackIds = needsMigration ? [...starter.trackIds] : savedTrackIds;
      merged.set(item.id, { ...starter, ...item, id: starter.id, name: starter.name, starter: true, starterVersion: STARTER_PLAYLIST_VERSION, trackIds });
      migrated ||= needsMigration;
    } else {
      merged.set(item.id, { ...item, trackIds: savedTrackIds });
    }
  }
  return { playlists: [...merged.values()].map((playlist) => ({ ...playlist, trackIds: [...playlist.trackIds] })), migrated };
}
