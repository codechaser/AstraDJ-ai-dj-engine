import React, { useEffect, useState } from 'react';
import { ArrowLeft, Disc3, Heart, MoreHorizontal, Pause, Play, Repeat, Shuffle, SkipBack, SkipForward } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { searchTracks } from '../api/client.js';
import { formatTrackDuration, toPlayerTrack } from '../api/catalogData.js';
import { TrackArtwork } from './CatalogArtwork.jsx';

const timeLabel = (seconds = 0) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

export default function NowPlayingPage({ playSong, track, playing, onToggle, onSeek, liked, setLiked, currentTime, duration, audioStatus }) {
  if (!track) return <NoTrackSelected onSelect={playSong} />;
  const hasAudio = Boolean(track?.audioAssetUrl);
  const audioMessage = audioStatus === 'loading' ? 'Loading audio asset…'
    : audioStatus === 'duration_mismatch' ? 'Audio duration does not match the catalog metadata; history was not recorded.'
    : audioStatus === 'history_error' ? 'Playback ended, but the listening report could not be saved.'
      : audioStatus === 'error' ? 'This audio asset could not be loaded.'
        : !hasAudio ? 'Audio unavailable — this catalog entry includes metadata only.' : '';
  return <div className="page now-page"><div className="now-top"><NavLink to="/queue"><ArrowLeft size={17}/></NavLink><span>NOW PLAYING</span><button><MoreHorizontal size={18}/></button></div><div className="now-layout"><div className="now-main"><TrackArtwork track={track} className="cover now-cover" alt={`${track?.title ?? 'Track'} cover artwork`}/><div className="now-track"><div><h1>{track?.title ?? 'No track selected'}</h1><p>{track?.artist ?? 'AstraDJ catalog'}</p></div><button onClick={()=>setLiked(!liked)} className={liked?'pink':''}><Heart size={21} fill={liked?'currentColor':'none'}/></button><button><MoreHorizontal size={20}/></button></div><div className="progress-wrap"><input className="seek-slider now-seek-slider" type="range" aria-label="Playback position" min="0" max={duration > 0 ? duration : 0} step="0.1" value={duration > 0 ? Math.min(currentTime, duration) : 0} onChange={(event) => onSeek?.(Number(event.currentTarget.value))} style={{'--seek-level': `${duration > 0 ? Math.min(100, currentTime / duration * 100) : 0}%`}} disabled={!hasAudio || !Number.isFinite(duration) || duration <= 0}/><div className="time-label"><span>{hasAudio ? timeLabel(currentTime) : '—'}</span><span>{hasAudio ? timeLabel(duration) : '—'}</span></div></div><div className="controls"><button disabled={!hasAudio}><Shuffle size={18}/></button><button disabled={!hasAudio}><SkipBack size={22} fill="currentColor"/></button><button className="big-play" disabled={!hasAudio} onClick={onToggle}>{playing?<Pause size={24} fill="currentColor"/>:<Play size={24} fill="currentColor"/>}</button><button disabled={!hasAudio}><SkipForward size={22} fill="currentColor"/></button><button disabled={!hasAudio}><Repeat size={18}/></button></div>{audioMessage && <p className="player-unavailable" role="status">{audioMessage}</p>}</div><aside className="acoustic panel"><h3>Acoustic Intelligence</h3><div className="acoustic-stats"><div><span className="stat-icon cyan">◉</span><b>{track?.acoustic?.bpm ?? '—'}</b><small>BPM</small></div><div><span className="stat-icon rose">♨</span><b>{track?.acoustic ? Math.round(track.acoustic.energy*100)+'%' : '—'}</b><small>Energy</small></div><div><span className="stat-icon gold">◉</span><b>{track?.acoustic?.valence != null ? Math.round(track.acoustic.valence*100)+'%' : '—'}</b><small>Valence</small></div><div><span className="stat-icon violet">●</span><b>{track?.acoustic?.camelotKey ?? '—'}</b><small>Camelot</small></div></div><div className="waveform">{Array.from({length:60},(_,i)=><i key={i} style={{height:`${15+((i*37+i*i*3)%70)}%`}}/>)}</div><TrackDetailTabs track={track} playSong={playSong}/></aside></div></div>;
}

function TrackDetailTabs({ track, playSong }) {
  const [activeTab, setActiveTab] = useState('Lyrics');
  const [relatedTracks, setRelatedTracks] = useState([]);
  const [relatedStatus, setRelatedStatus] = useState('idle');
  const [relatedError, setRelatedError] = useState('');

  useEffect(() => {
    if (activeTab !== 'Related' || relatedStatus !== 'idle') return;
    setRelatedStatus('loading');
    searchTracks('').then((response) => {
      const currentId = track.trackId;
      const currentArtist = track.artist?.trim().toLocaleLowerCase();
      const matches = (Array.isArray(response.items) ? response.items : [])
        .filter((item) => item.trackId !== currentId && currentArtist && item.artist?.trim().toLocaleLowerCase() === currentArtist)
        .sort((a, b) => a.title.localeCompare(b.title));
      setRelatedTracks(matches);
      setRelatedStatus('ready');
    }).catch((error) => {
      setRelatedError(error.message || 'Related catalog tracks could not be loaded.');
      setRelatedStatus('error');
    });
  }, [activeTab, track.artist, track.trackId]);

  const tabs = ['Lyrics', 'About', 'Related'];
  return <section className="track-details" aria-label="Track details">
    <div className="detail-tabs" role="tablist" aria-label="Track details">
      {tabs.map((tab) => <button key={tab} id={`track-tab-${tab.toLowerCase()}`} type="button" role="tab" aria-selected={activeTab === tab} aria-controls="track-detail-panel" className={activeTab === tab ? 'selected' : ''} onClick={() => setActiveTab(tab)}>{tab}</button>)}
    </div>
    <div id="track-detail-panel" role="tabpanel" aria-labelledby={`track-tab-${activeTab.toLowerCase()}`} className="track-detail-panel">
      {activeTab === 'Lyrics' && <p className="lyric-preview">Lyrics are unavailable for this track.</p>}
      {activeTab === 'About' && <div className="track-about"><p>Catalog information for <b>{track.title}</b>.</p><dl>
        <div><dt>Artist</dt><dd>{track.artist || 'Unavailable'}</dd></div>
        <div><dt>Duration</dt><dd>{formatTrackDuration(track.durationSeconds)}</dd></div>
        <div><dt>Audio</dt><dd>{track.audioAssetUrl ? 'Available in catalog' : 'Metadata only'}</dd></div>
        {track.trackId && <div><dt>Track ID</dt><dd>{track.trackId}</dd></div>}
        {track.acoustic?.bpm != null && <div><dt>BPM</dt><dd>{track.acoustic.bpm}</dd></div>}
        {track.acoustic?.camelotKey && <div><dt>Camelot key</dt><dd>{track.acoustic.camelotKey}</dd></div>}
        {track.acoustic?.energy != null && <div><dt>Energy</dt><dd>{Math.round(track.acoustic.energy * 100)}%</dd></div>}
        {track.acoustic?.valence != null && <div><dt>Valence</dt><dd>{Math.round(track.acoustic.valence * 100)}%</dd></div>}
      </dl></div>}
      {activeTab === 'Related' && <div className="related-tracks"><p>Other tracks by {track.artist || 'this artist'}</p>
        {relatedStatus === 'loading' && <p role="status" className="integration-status">Loading related catalog tracks…</p>}
        {relatedStatus === 'error' && <p role="alert" className="integration-error">{relatedError}</p>}
        {relatedStatus === 'ready' && relatedTracks.length === 0 && <p role="status" className="integration-status">No other tracks by {track.artist || 'this artist'} are available in the catalog.</p>}
        {relatedTracks.map((item) => <div className="related-track" key={item.trackId}><span className="related-track-meta"><b>{item.title}</b><small>{item.artist} · {formatTrackDuration(item.durationSeconds)}</small></span><button type="button" aria-label={`Play ${item.title}`} onClick={() => playSong(toPlayerTrack(item))}><Play size={14} fill="currentColor"/> Play</button></div>)}
      </div>}
    </div>
  </section>;
}

function NoTrackSelected({ onSelect }) {
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
  return <div className="page now-page"><div className="now-top"><NavLink to="/playlist" aria-label="Browse catalog"><ArrowLeft size={17}/></NavLink><span>NOW PLAYING</span><span/></div><section className="panel now-empty" aria-labelledby="now-empty-title"><div className="now-empty-mark"><Disc3 size={32}/></div><span className="eyebrow">ASTRADJ PLAYER</span><h1 id="now-empty-title">No track selected</h1><p>Choose a track from the AstraDJ catalog to load it into the player.</p><NavLink className="btn-outline now-browse-link" to="/playlist">Browse full catalog</NavLink><div className="now-empty-list" aria-label="Catalog tracks">{status === 'loading' && <div role="status" className="integration-status">Loading available tracks…</div>}{status === 'error' && <div role="alert" className="integration-error">{message}</div>}{status === 'ready' && tracks.length === 0 && <div role="status" className="integration-status">No tracks are available in the catalog yet.</div>}{status === 'ready' && tracks.map((item) => <button className="now-empty-track" type="button" key={item.trackId} aria-label={`Select ${item.title}`} onClick={() => onSelect(toPlayerTrack(item))}><TrackArtwork track={item} className="catalog-cover" alt=""/><span className="now-empty-track-meta"><b>{item.title}</b><small>{item.artist} · {formatTrackDuration(item.durationSeconds)}</small></span><small className={item.audioAssetUrl ? 'now-track-audio' : 'now-track-metadata'}>{item.audioAssetUrl ? 'Audio available' : 'Metadata only'}</small></button>)}</div></section></div>;
}
