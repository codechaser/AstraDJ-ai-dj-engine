import React, { useEffect, useMemo, useState } from 'react';
import { NavLink, useSearchParams } from 'react-router-dom';
import { Clock3, Play } from 'lucide-react';
import { searchTracks } from '../api/client.js';
import { catalogDurationSeconds, formatTrackDuration, groupCatalogArtists, toPlayerTrack, tracksForArtist } from '../api/catalogData.js';

function useCatalog() {
  const [tracks, setTracks] = useState([]);
  const [status, setStatus] = useState('loading');
  const [message, setMessage] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    searchTracks('', controller.signal).then((response) => {
      setTracks(Array.isArray(response.items) ? response.items : []);
      setStatus('ready');
    }).catch((error) => {
      if (error.name === 'AbortError') return;
      setMessage(error.message || 'The track catalog could not be loaded.');
      setStatus('error');
    });
    return () => controller.abort();
  }, []);
  return { tracks, status, message };
}

function CatalogState({ status, message, emptyText = 'No tracks are available in the catalog yet.' }) {
  if (status === 'loading') return <div className="panel integration-status" role="status">Loading the AstraDJ catalog…</div>;
  if (status === 'error') return <div className="panel integration-error" role="alert">{message}</div>;
  return <div className="panel integration-status">{emptyText}</div>;
}

function TrackRows({ tracks, playSong }) {
  return <div className="ranked catalog-page-tracks">{tracks.map((track, index) => <div className="song-row" key={track.trackId}>
    <span className="rank">{index + 1}</span><div className="catalog-cover" aria-hidden="true"/>
    <div className="song-meta"><b>{track.title}</b><small><NavLink to={`/artist?name=${encodeURIComponent(track.artist)}`}>{track.artist}</NavLink>{` · ${track.trackId}`}</small></div>
    <span className="song-time">{formatTrackDuration(track.durationSeconds)}</span>
    <button className="row-play" aria-label={`Select ${track.title}`} onClick={() => playSong?.(toPlayerTrack(track))}><Play size={13} fill="currentColor"/></button>
  </div>)}</div>;
}

export function CatalogPlaylistPage({ playSong }) {
  const { tracks, status, message } = useCatalog();
  const duration = catalogDurationSeconds(tracks);
  const durationLabel = `${Math.floor(duration / 3600)}h ${Math.floor((duration % 3600) / 60)}m`;
  const ready = status === 'ready' && tracks.length > 0;
  return <div className="page playlist-page">
    <div className="playlist-hero"><div className="catalog-hero-art" aria-hidden="true"/><div>
      <span className="eyebrow">ASTRADJ TRACK CATALOG</span><h1>All Tracks</h1><p>Tracks available in the AstraDJ catalog</p>
      <small>{status === 'ready' ? `${tracks.length} tracks · ${durationLabel}` : 'Catalog details load from the server'}</small>
      <div className="playlist-actions"><button className="round-play" aria-label="Select first catalog track" disabled={!ready} title={!ready ? 'No catalog tracks are available' : 'Select the first catalog track'} onClick={() => playSong?.(toPlayerTrack(tracks[0]))}><Play size={18} fill="currentColor"/></button></div>
    </div></div>
    <div className="track-table"><div className="table-head"><span>#</span><span>Title</span><span>Artist</span><span><Clock3 size={14}/></span></div>
      {status !== 'ready' && <CatalogState status={status} message={message}/>}
      {status === 'ready' && tracks.length === 0 && <CatalogState status="empty"/>}
      {status === 'ready' && tracks.length > 0 && <TrackRows tracks={tracks} playSong={playSong}/>}
    </div>
  </div>;
}

export function CatalogArtistPage({ playSong }) {
  const { tracks, status, message } = useCatalog();
  const [params] = useSearchParams();
  const artistName = params.get('name') ?? '';
  const artistTracks = useMemo(() => tracksForArtist(tracks, artistName), [tracks, artistName]);
  const exists = status === 'ready' && groupCatalogArtists(tracks).some((artist) => artist.name.toLocaleLowerCase() === artistName.trim().toLocaleLowerCase());
  return <div className="page artist-page">
    <div className="artist-hero catalog-artist-hero"><div><span className="eyebrow">ARTIST · CATALOG METADATA</span>
      <h1>{artistName || 'Catalog artist'}</h1>
      {status === 'ready' && exists && <p>{artistTracks.length} {artistTracks.length === 1 ? 'track' : 'tracks'} in the AstraDJ catalog</p>}
      {status === 'ready' && !exists && <p>Artist details are not available in the current catalog.</p>}
    </div><div className="catalog-artist-art" aria-hidden="true"/></div>
    <div className="artist-tabs"><button className="selected" type="button">Tracks</button><button type="button" disabled title="Album relationships are not present in track catalog records">Albums unavailable</button><button type="button" disabled title="Artist biographies are not present in track catalog records">About unavailable</button></div>
    {status === 'ready' && exists ? <><div className="section-title"><h2>Tracks by {artistName}</h2></div><TrackRows tracks={artistTracks} playSong={playSong}/><div className="panel integration-status catalog-limit">The catalog stores artist names with tracks, but has no biography, artist artwork, listener counts, or album relationships.</div><div className="section-title"><h2>Albums</h2></div><div className="panel integration-status">Album metadata is not available for this artist.</div></>
      : <CatalogState status={status === 'ready' ? 'empty' : status} message={message} emptyText={artistName ? `No catalog tracks are available for ${artistName}.` : 'Choose an artist from the catalog to view its tracks.'}/>}
  </div>;
}

export function CatalogAlbumPage() {
  const { status, message } = useCatalog();
  const [params] = useSearchParams();
  const albumTitle = params.get('title');
  const artistName = params.get('artist');
  const subject = albumTitle ? `“${albumTitle}”` : artistName ? `for ${artistName}` : 'for this catalog';
  return <div className="page album-page">
    <div className="album-hero"><div className="catalog-hero-art" aria-hidden="true"/><div><span className="eyebrow">ALBUM · METADATA UNAVAILABLE</span><h1>{albumTitle ?? 'Album details unavailable'}</h1>
      {artistName && <NavLink to={`/artist?name=${encodeURIComponent(artistName)}`}>{artistName}</NavLink>}
      <p>The track catalog does not include album names, release years, album artwork, or album-to-track relationships.</p>
    </div></div>
    {status === 'loading' && <CatalogState status="loading"/>}
    {status === 'error' && <CatalogState status="error" message={message}/>}
    {status === 'ready' && <div className="panel integration-status">Album tracks cannot be listed {subject}: no album data is present in the catalog.</div>}
  </div>;
}
