import React, { useCallback, useEffect, useRef } from 'react';
import { NavLink } from 'react-router-dom';
import { Heart, ListMusic, MoreHorizontal, Pause, Play, Repeat, Shuffle, SkipBack, SkipForward, SlidersHorizontal, Volume2 } from 'lucide-react';
import { apiRequest } from '../api/client.js';
import { buildCompletionInteraction } from '../api/playbackEvents.js';

const imageUrl = (id) => `https://images.unsplash.com/${id || 'photo-1514525253161-7a46d19cd819'}?auto=format&fit=crop&w=180&q=80`;
const timeLabel = (seconds = 0) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

export default function ConnectedPlayer({ track, playing, onToggle, registerPlaybackToggle, liked, setLiked, currentTime, setCurrentTime, setDuration, audioStatus, setAudioStatus, onPlaybackChange }) {
  const audioRef = useRef(null);
  const completedRef = useRef(null);
  const trackIdRef = useRef(track?.trackId);
  trackIdRef.current = track?.trackId;
  const available = Boolean(track?.audioAssetUrl);

  useEffect(() => {
    completedRef.current = null;
    const audio = audioRef.current;
    if (audio) { audio.pause(); audio.currentTime = 0; }
    setCurrentTime(0); setDuration(0);
    if (!available) setAudioStatus('unavailable');
    else setAudioStatus('loading');
  }, [track?.trackId, track?.audioAssetUrl, available, setCurrentTime, setDuration, setAudioStatus]);

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
      audio.pause(); onPlaybackChange(false);
    }
  }, [available, onPlaybackChange, setAudioStatus, track?.trackId]);

  useEffect(() => {
    registerPlaybackToggle?.(toggleAudio);
    return () => registerPlaybackToggle?.(null);
  }, [registerPlaybackToggle, toggleAudio]);

  async function handleEnded() {
    const audio = audioRef.current;
    if (!track?.trackId || completedRef.current === track.trackId) return;
    completedRef.current = track.trackId;
    onPlaybackChange(false);
    const interaction = buildCompletionInteraction(track, audio.duration, liked);
    if (!interaction) {
      setAudioStatus('duration_mismatch'); return;
    }
    try {
      await apiRequest('/interactions', { method: 'POST', body: JSON.stringify(interaction) });
    } catch { setAudioStatus('history_error'); }
  }

  return <footer className="player">
    <audio ref={audioRef} src={track?.audioAssetUrl || undefined} preload="metadata" onLoadedMetadata={(event) => { setDuration(event.currentTarget.duration); setAudioStatus('ready'); }} onPlay={(event) => { if (event.currentTarget.currentTime < 1) completedRef.current = null; }} onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)} onError={() => { setAudioStatus('error'); onPlaybackChange(false); }} onEnded={handleEnded}/>
    <div className="player-song"><NavLink to="/now-playing"><img className="cover" src={imageUrl(track?.img)} alt=""/></NavLink><div><b>{track?.title ?? 'Select a track'}</b><small>{track?.artist ?? 'AstraDJ catalog'}</small><small className="player-availability">{audioStatus === 'loading' ? 'Loading audio…' : audioStatus === 'error' ? 'Audio failed to load' : available ? 'Audio ready' : 'Audio unavailable'}</small></div><button className={liked?'pink':''} onClick={() => setLiked(!liked)}><Heart size={15} fill={liked?'currentColor':'none'}/></button></div>
    <div className="player-center"><div className="player-controls"><button disabled={!available} aria-label="Shuffle unavailable"><Shuffle size={14}/></button><button disabled={!available} aria-label="Previous track unavailable"><SkipBack size={16} fill="currentColor"/></button><button className="player-play" disabled={!available} aria-label={playing?'Pause':'Play'} onClick={onToggle}>{playing?<Pause size={15} fill="currentColor"/>:<Play size={15} fill="currentColor"/>}</button><button disabled={!available} aria-label="Next track unavailable"><SkipForward size={16} fill="currentColor"/></button><button disabled={!available} aria-label="Repeat unavailable"><Repeat size={14}/></button></div><div className="player-progress"><span>{available ? timeLabel(currentTime) : '—'}</span><div className="progress"><span style={{width: available && audioRef.current?.duration ? `${Math.min(100,currentTime/audioRef.current.duration*100)}%` : '0%'}}/></div><span>{available ? timeLabel(audioRef.current?.duration || 0) : '—'}</span></div></div>
    <div className="player-extra"><NavLink to="/queue"><ListMusic size={16}/></NavLink><button disabled={!available}><Shuffle size={15}/></button><Volume2 size={16}/><div className="volume"><i/></div><NavLink to="/settings"><SlidersHorizontal size={15}/></NavLink></div>
  </footer>;
}
