import React, { useEffect, useMemo, useState } from 'react';
import { NavLink, useSearchParams } from 'react-router-dom';
import { Clock3, Play, Trash2 } from 'lucide-react';
import { searchTracks } from '../api/client.js';
import { catalogDurationSeconds, formatTrackDuration, groupCatalogArtists, toPlayerTrack, tracksForArtist } from '../api/catalogData.js';
import { ArtistArtwork, TrackArtwork } from './CatalogArtwork.jsx';

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
    <span className="rank">{index + 1}</span><TrackArtwork track={track}/>
    <div className="song-meta"><b>{track.title}</b><small><NavLink to={`/artist?name=${encodeURIComponent(track.artist)}`}>{track.artist}</NavLink>{` · ${track.trackId}`}</small></div>
    <span className="song-time">{formatTrackDuration(track.durationSeconds)}</span>
    <button className="row-play" aria-label={`Select ${track.title}`} onClick={() => playSong?.(toPlayerTrack(track))}><Play size={13} fill="currentColor"/></button>
  </div>)}</div>;
}

export function CatalogPlaylistPage({ playSong, playlists = [], playlistsLoaded = true, onAddTrack = () => {}, onRemoveTrack = () => {}, playlistError = '' }) {
  const { tracks, status, message } = useCatalog();
  const [params] = useSearchParams();
  const playlistId = params.get('playlist');
  const savedPlaylist = playlists.find((item) => item.id === playlistId);
  const playlistTrackIds = new Set(savedPlaylist?.trackIds ?? []);
  const playlistTracks = tracks.filter((track) => playlistTrackIds.has(track.trackId));
  if (playlistId) return <LocalPlaylistPage playlist={savedPlaylist} playlistsLoaded={playlistsLoaded} tracks={tracks} playlistTracks={playlistTracks} status={status} message={message} playlistError={playlistError} playSong={playSong} onAddTrack={onAddTrack} onRemoveTrack={onRemoveTrack}/>;
  const duration = catalogDurationSeconds(tracks);
  const durationLabel = `${Math.floor(duration / 3600)}h ${Math.floor((duration % 3600) / 60)}m`;
  const ready = status === 'ready' && tracks.length > 0;
  return <div className="page playlist-page">
    <div className="playlist-hero"><TrackArtwork track={tracks[0]} className="catalog-hero-art"/><div>
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

function LocalPlaylistPage({playlist,playlistsLoaded,tracks,playlistTracks,status,message,playlistError,playSong,onAddTrack,onRemoveTrack}) {
  return <div className="page playlist-page">
    <div className="playlist-hero"><TrackArtwork track={playlistTracks[0]} className="catalog-hero-art"/><div><span className="eyebrow">{playlist?.starter?'STARTER PLAYLIST':'YOUR PLAYLIST'} · LOCAL</span><h1>{playlist?.name ?? (playlistsLoaded ? 'Playlist unavailable' : 'Loading playlist…')}</h1><p>{playlist ? `${playlistTracks.length} ${playlistTracks.length===1?'track':'tracks'} · Saved in this browser only` : 'Playlist details'}</p><div className="playlist-actions"><NavLink className="btn-outline" to="/playlist">Back to catalog</NavLink></div></div></div>
    {!playlistsLoaded ? <div className="panel integration-status" role="status">Loading saved playlist…</div> : !playlist ? <div className="panel integration-error" role="alert">This playlist is not available in the current browser profile.</div> : <>
      {playlistError&&<div role="alert" className="panel integration-error">{playlistError}</div>}
      <section className="panel local-playlist-section"><div className="section-title"><h2>Tracks in this playlist</h2><span>{playlistTracks.length}</span></div>
        {status==='loading'&&<div role="status" className="integration-status">Loading catalog tracks…</div>}
        {status==='error'&&<div role="alert" className="integration-error">{message}</div>}
        {status==='ready'&&playlistTracks.length===0&&<div className="integration-status">This playlist is empty. Add tracks from the catalog below.</div>}
        {status==='ready'&&playlistTracks.map((track,index)=><div className="local-playlist-track" key={track.trackId}><span className="rank">{index+1}</span><TrackArtwork track={track}/><div className="local-playlist-track-meta"><b>{track.title}</b><small>{track.artist} · {formatTrackDuration(track.durationSeconds)}</small></div><button type="button" aria-label={`Play ${track.title}`} className="row-play" onClick={()=>playSong?.(toPlayerTrack(track))}><Play size={14} fill="currentColor"/></button><button type="button" aria-label={`Remove ${track.title} from playlist`} className="playlist-remove" onClick={()=>onRemoveTrack(playlist.id,track.trackId)}><Trash2 size={14}/></button></div>)}
      </section>
      <section className="panel local-playlist-section"><div className="section-title"><h2>Add from catalog</h2></div>{status==='loading'&&<div role="status" className="integration-status">Loading catalog tracks…</div>}{status==='error'&&<div role="alert" className="integration-error">{message}</div>}{status==='ready'&&tracks.length===0&&<div className="integration-status">No catalog tracks are available.</div>}{status==='ready'&&tracks.map((track)=><div className="playlist-pick-row" key={track.trackId}><TrackArtwork track={track}/><div className="local-playlist-track-meta"><b>{track.title}</b><small>{track.artist} · {track.audioAssetUrl?'Audio available':'Metadata only'}</small></div><button type="button" className={playlistTrackIdsForPage(playlistTracks,track.trackId)?'btn-outline playlist-added':'btn-primary'} disabled={playlistTrackIdsForPage(playlistTracks,track.trackId)} aria-label={`${playlistTrackIdsForPage(playlistTracks,track.trackId)?'Added':'Add'} ${track.title}`} onClick={()=>onAddTrack(playlist.id,track.trackId)}>{playlistTrackIdsForPage(playlistTracks,track.trackId)?'Added':'Add'}</button></div>)}</section>
    </>}
  </div>;
}

function playlistTrackIdsForPage(playlistTracks,trackId){return playlistTracks.some((track)=>track.trackId===trackId)}

export function CatalogArtistPage({ playSong }) {
  const { tracks, status, message } = useCatalog();
  const [params] = useSearchParams();
  const [activeArtistTab, setActiveArtistTab] = useState('Tracks');
  const artistName = params.get('name') ?? '';
  const artistTracks = useMemo(() => tracksForArtist(tracks, artistName), [tracks, artistName]);
  const exists = status === 'ready' && groupCatalogArtists(tracks).some((artist) => artist.name.toLocaleLowerCase() === artistName.trim().toLocaleLowerCase());
  const knownAlbumTracks = artistTracks.filter((track) => typeof track.albumTitle === 'string' && track.albumTitle.trim());
  const playableTrackCount = artistTracks.filter((track) => Boolean(track.audioAssetUrl)).length;
  const totalRuntime = formatTrackDuration(catalogDurationSeconds(artistTracks));
  return <div className="page artist-page">
    <div className="artist-hero catalog-artist-hero"><div><span className="eyebrow">ARTIST · CATALOG METADATA</span>
      <h1>{artistName || 'Catalog artist'}</h1>
      {status === 'ready' && exists && <p>{artistTracks.length} {artistTracks.length === 1 ? 'track' : 'tracks'} in the AstraDJ catalog</p>}
      {status === 'ready' && !exists && <p>Artist details are not available in the current catalog.</p>}
    </div><ArtistArtwork artist={artistName}/></div>
    <div className="artist-tabs" role="tablist" aria-label={`${artistName || 'Artist'} sections`}>{['Tracks', 'Albums', 'About'].map((tab) => <button key={tab} type="button" role="tab" aria-selected={activeArtistTab === tab} className={activeArtistTab === tab ? 'selected' : ''} onClick={() => setActiveArtistTab(tab)}>{tab}</button>)}</div>
    {status === 'ready' && exists ? <>
      {activeArtistTab === 'Tracks' && <><div className="section-title"><h2>Tracks by {artistName}</h2></div><TrackRows tracks={artistTracks} playSong={playSong}/></>}
      {activeArtistTab === 'Albums' && <><div className="section-title"><h2>Albums by {artistName}</h2></div>{knownAlbumTracks.length ? <TrackRows tracks={knownAlbumTracks} playSong={playSong}/> : <><div className="panel integration-status" role="status">No album records are linked to this artist in the catalog. These {artistTracks.length} tracks are available without album grouping.</div><TrackRows tracks={artistTracks} playSong={playSong}/></>}</>}
      {activeArtistTab === 'About' && <section className="panel artist-about" aria-labelledby="artist-about-title"><div className="section-title"><h2 id="artist-about-title">About {artistName}</h2></div><p>AstraDJ’s catalog currently lists {artistTracks.length} {artistTracks.length === 1 ? 'track' : 'tracks'} by {artistName}. This overview uses catalog records; no biography has been supplied.</p><dl><div><dt>Tracks in catalog</dt><dd>{artistTracks.length}</dd></div><div><dt>Audio available</dt><dd>{playableTrackCount} of {artistTracks.length}</dd></div><div><dt>Total catalog runtime</dt><dd>{totalRuntime}</dd></div><div><dt>Album-linked tracks</dt><dd>{knownAlbumTracks.length} of {artistTracks.length}</dd></div></dl><div className="section-title"><h2>Catalog tracks</h2></div><TrackRows tracks={artistTracks} playSong={playSong}/></section>}
    </>
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
