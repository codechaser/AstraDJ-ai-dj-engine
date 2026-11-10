import React, { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { Heart, ListMusic, MoreHorizontal, Pause, Play, Repeat, Shuffle, SkipBack, SkipForward, SlidersHorizontal, Volume2, VolumeX } from 'lucide-react';
import { apiRequest } from '../api/client.js';
import { buildCompletionInteraction } from '../api/playbackEvents.js';
import { TrackArtwork } from './CatalogArtwork.jsx';

const timeLabel = (seconds = 0) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

export default function ConnectedPlayer({ track, playing, onToggle, registerPlaybackToggle, registerPlaybackSeek, liked, setLiked, currentTime, setCurrentTime, duration, setDuration, audioStatus, setAudioStatus, onPlaybackChange }) {
  const audioRef = useRef(null);
  const completedRef = useRef(null);
  const [volume, setVolume] = useState(0.72);
  const previousVolumeRef = useRef(0.72);
  const trackIdRef = useRef(track?.trackId);
  trackIdRef.current = track?.trackId;
  const available = Boolean(track?.audioAssetUrl);
  const hasTrack = Boolean(track?.trackId);
  const liveStream = track?.kind === 'radio';
  const externalEpisode = track?.kind === 'podcast';
  const nonCatalogMedia = liveStream || externalEpisode;

  const seekTo = useCallback((seconds) => {
    const audio = audioRef.current;
    const target = Number(seconds);
    if (!audio || liveStream || !Number.isFinite(audio.duration) || audio.duration <= 0 || !Number.isFinite(target)) return;
    const bounded = Math.max(0, Math.min(audio.duration, target));
    audio.currentTime = bounded;
    setCurrentTime(bounded);
  }, [liveStream, setCurrentTime]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  function toggleMute() {
    setVolume((current) => {
      if (current > 0) { previousVolumeRef.current = current; return 0; }
      return previousVolumeRef.current || 0.72;
    });
  }

  function updateVolume(event) {
    const next = Number(event.currentTarget.value);
    if (next > 0) previousVolumeRef.current = next;
    setVolume(next);
  }

  useEffect(() => {
    completedRef.current = null;
    const audio = audioRef.current;
    if (audio) { audio.pause(); audio.currentTime = 0; }
    setCurrentTime(0); setDuration(0);
    if (!hasTrack) setAudioStatus('idle');
    else if (!available) setAudioStatus('unavailable');
    else setAudioStatus('loading');
  }, [track?.trackId, track?.audioAssetUrl, hasTrack, available, setCurrentTime, setDuration, setAudioStatus]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!playing || !available || !audio) return undefined;
    audio.play().then(() => onPlaybackChange(true)).catch(() => { setAudioStatus('error'); onPlaybackChange(false); });
    return undefined;
  }, [track?.trackId, playing, available, onPlaybackChange, setAudioStatus]);

  const toggleAudio = useCallback(() => {
    const audio = audioRef.current;
    const requestedTrackId = track?.trackId;
    if (!audio || !available) { setAudioStatus('unavailable'); return; }
    if (audio.paused || audio.ended) {
      audio.play().then(() => {
        if (audioRef.current === audio && trackIdRef.current === requestedTrackId && !audio.paused) onPlaybackChange(true);
      }).catch(() => {
        if (audioRef.current === audio && trackIdRef.current === requestedTrackId) { setAudioStatus('error'); onPlaybackChange(false); }
      });
    } else {
      window.dispatchEvent(new CustomEvent('astradj:playback-paused', { detail: { trackId: requestedTrackId } }));
      audio.pause(); onPlaybackChange(false);
    }
  }, [available, onPlaybackChange, setAudioStatus, track?.trackId]);

  useEffect(() => {
    registerPlaybackToggle?.(toggleAudio);
    return () => registerPlaybackToggle?.(null);
  }, [registerPlaybackToggle, toggleAudio]);

  useEffect(() => {
    registerPlaybackSeek?.(seekTo);
    return () => registerPlaybackSeek?.(null);
  }, [registerPlaybackSeek, seekTo]);

  async function handleEnded() {
    const audio = audioRef.current;
    if (nonCatalogMedia) { onPlaybackChange(false); setAudioStatus('ended'); return; }
    if (!track?.trackId || completedRef.current === track.trackId) return;
    completedRef.current = track.trackId;
    onPlaybackChange(false);
    window.dispatchEvent(new CustomEvent('astradj:playback-ended', { detail: { trackId: track.trackId } }));
    const interaction = buildCompletionInteraction(track, audio.duration, liked);
    if (!interaction) {
      setAudioStatus('duration_mismatch'); return;
    }
    try {
      await apiRequest('/interactions', { method: 'POST', body: JSON.stringify(interaction) });
    } catch { setAudioStatus('history_error'); }
  }

  return <footer className="player">
    <audio ref={audioRef} src={track?.audioAssetUrl || undefined} preload="metadata" onLoadedMetadata={(event) => { setDuration(liveStream ? 0 : event.currentTarget.duration); setAudioStatus('ready'); }} onPlaying={() => { if (liveStream) setAudioStatus('ready'); }} onPlay={(event) => { if (!nonCatalogMedia && event.currentTarget.currentTime < 1) completedRef.current = null; }} onSeeking={(event) => { if (!nonCatalogMedia) window.dispatchEvent(new CustomEvent('astradj:playback-seeking', { detail: { trackId: track?.trackId, currentTime: event.currentTarget.currentTime, duration: event.currentTarget.duration } })); }} onTimeUpdate={(event) => setCurrentTime(liveStream ? 0 : event.currentTarget.currentTime)} onError={() => { setAudioStatus('error'); onPlaybackChange(false); }} onEnded={handleEnded}/>
    <div className="player-song"><NavLink to="/now-playing" aria-label="Open Now Playing"><TrackArtwork track={track} className="cover" alt={track?.title ? `${track.title} cover artwork` : 'No track artwork'}/></NavLink><div><b>{track?.title ?? <NavLink className="player-empty-link" to="/playlist">Select a track</NavLink>}</b><small>{track?.artist ?? 'AstraDJ catalog'}</small><small className="player-availability">{!hasTrack ? 'Choose a song from the catalog to start listening' : audioStatus === 'loading' ? 'Loading audio…' : audioStatus === 'error' ? liveStream ? 'Radio stream unavailable' : externalEpisode ? 'Podcast audio unavailable' : 'Audio failed to load' : liveStream ? playing ? 'Live radio · TheRadio.CC' : audioStatus === 'ended' ? 'Radio stream ended' : 'Radio ready · TheRadio.CC' : externalEpisode ? playing ? 'Podcast · NASA' : audioStatus === 'ended' ? 'Episode ended' : 'Podcast ready · NASA' : available ? 'Audio ready' : 'Audio unavailable'}</small></div><button className={liked?'pink':''} onClick={() => setLiked(!liked)}><Heart size={15} fill={liked?'currentColor':'none'}/></button></div>
    <div className="player-center"><div className="player-controls"><button disabled={!available || nonCatalogMedia} aria-label="Shuffle unavailable"><Shuffle size={14}/></button><button disabled={!available || nonCatalogMedia} aria-label="Previous track unavailable"><SkipBack size={16} fill="currentColor"/></button><button className="player-play" disabled={!available} aria-label={playing?'Pause':'Play'} onClick={onToggle}>{playing?<Pause size={15} fill="currentColor"/>:<Play size={15} fill="currentColor"/>}</button><button disabled={!available || nonCatalogMedia} aria-label="Next track unavailable"><SkipForward size={16} fill="currentColor"/></button><button disabled={!available || nonCatalogMedia} aria-label="Repeat unavailable"><Repeat size={14}/></button></div><div className={`player-progress ${liveStream ? 'player-progress-live' : ''}`}><span>{liveStream ? 'LIVE' : available ? timeLabel(currentTime) : '—'}</span><input className="seek-slider" type="range" aria-label="Playback position" min="0" max={duration > 0 ? duration : 0} step="0.1" value={duration > 0 ? Math.min(currentTime, duration) : 0} onChange={(event) => seekTo(event.currentTarget.value)} style={{'--seek-level': `${duration > 0 ? Math.min(100, currentTime / duration * 100) : liveStream && playing ? 100 : 0}%`}} disabled={!available || liveStream || !Number.isFinite(duration) || duration <= 0}/><span>{liveStream ? 'ON AIR' : available ? timeLabel(duration || audioRef.current?.duration || 0) : '—'}</span></div></div>
    <div className="player-extra"><NavLink to="/queue"><ListMusic size={16}/></NavLink><button disabled={!available}><Shuffle size={15}/></button><button type="button" className="volume-toggle" aria-label={volume === 0 ? 'Unmute' : 'Mute'} title={volume === 0 ? 'Unmute' : 'Mute'} disabled={!available} onClick={toggleMute}>{volume === 0 ? <VolumeX size={16}/> : <Volume2 size={16}/>}</button><div className="volume"><input type="range" aria-label="Volume" min="0" max="1" step="0.01" value={volume} onChange={updateVolume} style={{'--volume-level': `${volume * 100}%`}} disabled={!available}/></div><NavLink to="/settings"><SlidersHorizontal size={15}/></NavLink></div>
  </footer>;
}
