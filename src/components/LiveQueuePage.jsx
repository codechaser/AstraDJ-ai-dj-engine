import React, { useEffect, useRef, useState } from 'react';
import { Grip, Power, ThumbsDown, ThumbsUp, X } from 'lucide-react';
import { createLounge, getAccessToken, getActiveLounge, getSocketOrigin, getTrack, saveActiveLounge, searchTracks } from '../api/client.js';
import { connectToLounge } from '../api/loungeConnection.js';
import { outroPlaybackState } from '../api/outroPlayback.js';
import LoungeCollaborationPanel from './LoungeCollaborationPanel.jsx';

function formatTrack(track) {
  return { ...track, img: 'photo-1514525253161-7a46d19cd819', time: `${Math.floor((track.durationSeconds ?? 0) / 60)}:${String(Math.floor((track.durationSeconds ?? 0) % 60)).padStart(2, '0')}` };
}

export default function LiveQueuePage({ track, currentTime = 0, duration = 0, playing = false, onCurrentTrack, onTransitionTrack = onCurrentTrack, user, aiDjCommentary = false }) {
  const socketRef = useRef(null);
  const loungeIdRef = useRef(null);
  const segueAttemptRef = useRef(null);
  const segueRequestRef = useRef(null);
  const segueRequestIdRef = useRef(0);
  const pendingSegueRef = useRef(null);
  const playbackContextRef = useRef(null);
  const [inviteCode, setInviteCode] = useState('');
  const [queueState, setQueueState] = useState(null);
  const [activeLoungeId, setActiveLoungeId] = useState(null);
  const [catalog, setCatalog] = useState([]);
  const [catalogStatus, setCatalogStatus] = useState('loading');
  const [catalogError, setCatalogError] = useState('');
  const [selectedTrackId, setSelectedTrackId] = useState('');
  const [status, setStatus] = useState('disconnected');
  const [message, setMessage] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [loungeSettings, setLoungeSettings] = useState({ vibeProfile: 'Chill & Focus', maxParticipants: 8, bpmTolerancePct: 8, soundclashEnabled: true, aiVerbosity: 'normal' });

  playbackContextRef.current = {
    trackId: track?.trackId, currentTime, duration, playing, loungeId: activeLoungeId,
    isHost: Boolean(queueState?.isHost), connected: status === 'connected',
    windowSeconds: queueState?.segueOutroWindowSeconds ?? 12,
    candidateIds: (queueState?.nextUp ?? []).map((item) => item.trackId),
    currentTrackId: queueState?.nowPlaying?.trackId,
  };

  useEffect(() => {
    let active = true;
    searchTracks('', undefined).then((result) => { if (active) { setCatalog(result.items ?? []); setCatalogStatus('ready'); } }).catch((error) => { if (active) { setCatalogStatus('error'); setCatalogError(error.message || 'The track catalog is unavailable.'); } });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!user) {
      socketRef.current?.disconnect(); socketRef.current = null;
      loungeIdRef.current = null; setActiveLoungeId(null); setQueueState(null); setStatus('disconnected');
    }
    return () => { socketRef.current?.disconnect(); socketRef.current = null; };
  }, [user?.id]);

  async function hydrateUpdate(event) {
    if (!event || event.loungeId !== loungeIdRef.current) return;
    const rows = event.payload?.queue ?? [];
    const byId = new Map([...catalog, ...(queueState?.nowPlaying ? [queueState.nowPlaying] : []), ...(queueState?.nextUp ?? [])].map((item) => [item.trackId, item]));
    const hydrated = await Promise.all(rows.map(async ({ trackId }) => {
      if (byId.has(trackId)) return byId.get(trackId);
      try { return await getTrack(trackId); } catch { return { trackId }; }
    }));
    if (event.loungeId !== loungeIdRef.current) return;
    setQueueState((current) => {
      const next = { ...(current ?? {}), nowPlaying: hydrated[0] ?? null, nextUp: hydrated.slice(1) };
      const saved = getActiveLounge();
      if (saved?.loungeId === event.loungeId) saveActiveLounge({ ...saved, snapshot: next });
      return next;
    });
    if (event.payload?.reason === 'segue' && hydrated[0]?.audioAssetUrl) {
      pendingSegueRef.current = null;
      onTransitionTrack(formatTrack(hydrated[0]));
    }
  }

  function joinWithInviteCode(code, initialMessage = '') {
    setMessage(initialMessage);
    if (!user || !getAccessToken()) { setMessage('Sign in before joining a Lounge.'); return; }
    const normalizedCode = code.trim().toUpperCase();
    if (!normalizedCode) { setMessage('Enter a Lounge invite code.'); return; }
    socketRef.current?.disconnect();
    loungeIdRef.current = null; setActiveLoungeId(null); saveActiveLounge(null); setQueueState(null); setStatus('connecting');
    socketRef.current = connectToLounge({
      inviteCode: normalizedCode, token: getAccessToken(), origin: getSocketOrigin(),
      onState: (state) => {
        loungeIdRef.current = state?.loungeId ?? null;
        setActiveLoungeId(loungeIdRef.current);
        setQueueState(state);
        if (state?.loungeId) saveActiveLounge({ userId: user.id, loungeId: state.loungeId, inviteCode: normalizedCode, snapshot: state });
        if (state?.nowPlaying?.trackId) onCurrentTrack(formatTrack(state.nowPlaying));
      },
      onQueueUpdate: (eventEnvelope) => { void hydrateUpdate(eventEnvelope); },
      onSessionEnded: (eventEnvelope) => {
        saveActiveLounge(null);
        setStatus('ended');
        const seconds = eventEnvelope.payload.summary?.durationSeconds;
        setMessage(seconds == null ? 'Lounge session ended. Session duration is unavailable.' : `Lounge session ended. Session duration: ${seconds} seconds.`);
      },
      onStatus: setStatus,
      onError: (error) => setMessage(error?.message === 'AUTH_REQUIRED' ? 'Your session expired. Sign in again.' : error?.message ?? 'Could not connect to the Lounge service.'),
    });
  }

  useEffect(() => {
    const pending = pendingSegueRef.current;
    const hasCandidate = Boolean(queueState?.nextUp?.some((item) => item.trackId !== queueState?.nowPlaying?.trackId));
    const playbackState = outroPlaybackState({
      isHost: Boolean(queueState?.isHost), connected: status === 'connected', playing,
      currentTime, duration, windowSeconds: queueState?.segueOutroWindowSeconds ?? 12, hasCandidate,
    });
    if (pending && (pending.trackId !== track?.trackId || pending.loungeId !== activeLoungeId || playbackState !== 'outro' || !queueState?.nextUp?.some((item) => item.trackId === pending.targetTrackId))) {
      socketRef.current?.socket.emit('lounge.playback.cancel', { trackId: pending.trackId });
      pendingSegueRef.current = null;
      segueAttemptRef.current = null;
      segueRequestRef.current = null;
    }
    if (playbackState !== 'outro' || !activeLoungeId || !track?.trackId || queueState?.nowPlaying?.trackId !== track.trackId) {
      if (playbackState !== 'outro') {
        segueAttemptRef.current = null;
        if (segueRequestRef.current) { segueRequestRef.current = null; segueRequestIdRef.current += 1; }
      }
      return;
    }
    const attemptKey = `${track.trackId}:${queueState.nextUp.map((item) => item.trackId).join(',')}`;
    if (segueAttemptRef.current === attemptKey || segueRequestRef.current?.attemptKey === attemptKey) return;
    segueAttemptRef.current = attemptKey;
    const requestId = ++segueRequestIdRef.current;
    segueRequestRef.current = { attemptKey, requestId };
    socketRef.current?.socket.emit('lounge.ai.segue.trigger', { currentTs: currentTime }, (ack) => {
      const latest = playbackContextRef.current;
      const latestState = outroPlaybackState({
        isHost: latest?.isHost, connected: latest?.connected, playing: latest?.playing,
        currentTime: latest?.currentTime, duration: latest?.duration, windowSeconds: latest?.windowSeconds,
        hasCandidate: Boolean(latest?.candidateIds?.length),
      });
      if (segueRequestRef.current?.requestId !== requestId || latest?.trackId !== track.trackId || latest?.currentTrackId !== track.trackId || latestState !== 'outro' || latest?.loungeId !== activeLoungeId || loungeIdRef.current !== activeLoungeId) {
        if (ack?.ok && ack.decision?.selectedTrackId) socketRef.current?.socket.emit('lounge.playback.cancel', { trackId: track.trackId });
        return;
      }
      segueRequestRef.current = null;
      if (!ack?.ok) { segueAttemptRef.current = null; setMessage(ack?.error?.message ?? 'The automatic segue could not be prepared.'); return; }
      if (ack.noCompatibleCandidate || !ack.decision?.selectedTrackId) { setMessage('No compatible queued track is available for this segue.'); return; }
      pendingSegueRef.current = { trackId: track.trackId, targetTrackId: ack.decision.selectedTrackId, loungeId: activeLoungeId };
    });
  }, [activeLoungeId, currentTime, duration, playing, queueState, status, track?.trackId]);

  useEffect(() => {
    const ended = (event) => {
      const pending = pendingSegueRef.current;
      if (!pending || pending.trackId !== event.detail?.trackId || pending.loungeId !== loungeIdRef.current) return;
      socketRef.current?.socket.emit('lounge.playback.ended', { trackId: pending.trackId }, (ack) => {
        if (!ack?.ok) { pendingSegueRef.current = null; setMessage(ack?.error?.message ?? 'The playback segue could not be completed.'); }
      });
    };
    const paused = (event) => {
      const pending = pendingSegueRef.current;
      if (pending?.trackId !== event.detail?.trackId) return;
      socketRef.current?.socket.emit('lounge.playback.cancel', { trackId: pending.trackId });
      pendingSegueRef.current = null;
      segueAttemptRef.current = null;
      segueRequestRef.current = null;
      segueRequestIdRef.current += 1;
    };
    const seeking = (event) => {
      const pending = pendingSegueRef.current;
      const timing = event.detail;
      const windowSeconds = playbackContextRef.current?.windowSeconds ?? 12;
      if (pending?.trackId === timing?.trackId && Number.isFinite(timing?.currentTime) && Number.isFinite(timing?.duration) && timing.duration - timing.currentTime > windowSeconds) {
        socketRef.current?.socket.emit('lounge.playback.cancel', { trackId: pending.trackId });
        pendingSegueRef.current = null;
        segueAttemptRef.current = null;
        segueRequestRef.current = null;
        segueRequestIdRef.current += 1;
      }
    };
    window.addEventListener('astradj:playback-ended', ended);
    window.addEventListener('astradj:playback-paused', paused);
    window.addEventListener('astradj:playback-seeking', seeking);
    return () => {
      window.removeEventListener('astradj:playback-ended', ended);
      window.removeEventListener('astradj:playback-paused', paused);
      window.removeEventListener('astradj:playback-seeking', seeking);
      const pending = pendingSegueRef.current;
      if (pending) socketRef.current?.socket.emit('lounge.playback.cancel', { trackId: pending.trackId });
      if (segueRequestRef.current) {
        const pendingTrackId = playbackContextRef.current?.trackId;
        if (pendingTrackId) socketRef.current?.socket.emit('lounge.playback.cancel', { trackId: pendingTrackId });
        segueRequestRef.current = null;
        segueRequestIdRef.current += 1;
      }
      pendingSegueRef.current = null;
    };
  }, []);

  function connect(event) {
    event.preventDefault();
    joinWithInviteCode(inviteCode);
  }

  async function createHostLounge(event) {
    event.preventDefault();
    if (!selectedTrackId) { setMessage('Choose a starting track from the catalog.'); return; }
    setCreateBusy(true);
    setMessage('');
    try {
      const created = await createLounge({
        seedTrackId: selectedTrackId,
        vibeProfile: loungeSettings.vibeProfile,
        maxParticipants: Number(loungeSettings.maxParticipants),
        bpmTolerancePct: Number(loungeSettings.bpmTolerancePct),
        soundclashEnabled: loungeSettings.soundclashEnabled,
        aiVerbosity: loungeSettings.aiVerbosity,
      });
      setInviteCode(created.inviteCode);
      setMessage(`Lounge created. Invite code: ${created.inviteCode}`);
      joinWithInviteCode(created.inviteCode, `Lounge created. Invite code: ${created.inviteCode}`);
    } catch (error) {
      setMessage(error.message || 'Could not create the Lounge.');
    } finally {
      setCreateBusy(false);
    }
  }

  const savedLounge = getActiveLounge();

  function command(event, payload) {
    const socket = socketRef.current?.socket;
    if (!socket?.connected) { setMessage('Connect to a Lounge before changing its queue.'); return; }
    socket.emit(event, payload, (ack) => {
      if (!ack?.ok) { setMessage(ack?.error?.message ?? 'The Lounge rejected that action.'); return; }
      if (ack.state) setQueueState((current) => {
        const next = { ...(current ?? {}), ...ack.state, soundclash: ack.state.soundclash ?? current?.soundclash };
        const saved = getActiveLounge();
        if (saved?.loungeId === loungeIdRef.current) saveActiveLounge({ ...saved, snapshot: next });
        return next;
      });
      setMessage('');
    });
  }

  function endSession() {
    if (!window.confirm('End this Lounge session for everyone? Participants will receive the session summary.')) return;
    const socket = socketRef.current?.socket;
    if (!socket?.connected) { setMessage('Connect to the Lounge before ending its session.'); return; }
    socket.emit('lounge.session.end', {}, (ack) => {
      if (!ack?.ok) { setMessage(ack?.error?.message ?? 'The Lounge session could not be ended.'); return; }
      if (ack.alreadyEnded) {
        saveActiveLounge(null);
        setStatus('ended');
        setMessage('This Lounge session has already ended. Its summary remains in your Profile.');
      }
    });
  }

  const nowPlaying = queueState?.nowPlaying ?? track;
  return <div className="page queue-page">
    <div className="page-heading"><div><span className="eyebrow">YOUR LISTENING FLOW</span><h1>Queue</h1></div><span className="muted">{status === 'connected' ? 'Live' : status === 'ended' ? 'Ended' : 'Not connected'}</span></div>
    {!user ? <div className="panel integration-status">Sign in from your Profile to join a shared Lounge queue.</div> : <>
      {user.role === 'Host' && <form className="lounge-create panel" onSubmit={createHostLounge}>
        <div><b>Create a DJ Lounge</b><small>Choose a catalog track to start, then share the invite code.</small></div>
        <label>Starting track<select aria-label="Starting track" value={selectedTrackId} onChange={(event) => setSelectedTrackId(event.target.value)} disabled={catalogStatus !== 'ready'} required>
          <option value="">{catalogStatus === 'loading' ? 'Loading catalog…' : catalogStatus === 'error' ? 'Catalog unavailable' : 'Choose a starting track…'}</option>
          {catalog.map((item) => <option key={item.trackId} value={item.trackId}>{item.title} · {item.artist}</option>)}
        </select></label>
        <label>Vibe<input aria-label="Lounge vibe" value={loungeSettings.vibeProfile} maxLength="80" onChange={(event) => setLoungeSettings((current) => ({ ...current, vibeProfile: event.target.value }))} required /></label>
        <label>Capacity<select aria-label="Lounge capacity" value={loungeSettings.maxParticipants} onChange={(event) => setLoungeSettings((current) => ({ ...current, maxParticipants: event.target.value }))}>
          {[4, 8, 12, 20, 50].map((capacity) => <option key={capacity} value={capacity}>{capacity} participants</option>)}
        </select></label>
        <label>BPM tolerance<select aria-label="BPM tolerance" value={loungeSettings.bpmTolerancePct} onChange={(event) => setLoungeSettings((current) => ({ ...current, bpmTolerancePct: event.target.value }))}>
          {[4, 6, 8].map((value) => <option key={value} value={value}>{value}%</option>)}
        </select></label>
        <label>AI DJ verbosity<select aria-label="AI DJ verbosity" value={loungeSettings.aiVerbosity} onChange={(event) => setLoungeSettings((current) => ({ ...current, aiVerbosity: event.target.value }))}>
          {['low', 'normal', 'high'].map((value) => <option key={value} value={value}>{value[0].toUpperCase() + value.slice(1)}</option>)}
        </select></label>
        <label className="lounge-soundclash"><input aria-label="Enable Soundclash" type="checkbox" checked={loungeSettings.soundclashEnabled} onChange={(event) => setLoungeSettings((current) => ({ ...current, soundclashEnabled: event.target.checked }))}/>Enable Soundclash</label>
        <button className="btn-primary" disabled={createBusy || catalogStatus !== 'ready' || !selectedTrackId}>{createBusy ? 'Creating…' : 'Create Lounge'}</button>
      </form>}
      <form className="lounge-connect" onSubmit={connect}><input aria-label="Lounge invite code" placeholder="Enter Lounge invite code (SP-XXXX)" value={inviteCode} onChange={(event) => setInviteCode(event.target.value)} required maxLength="7"/><button className="btn-outline" disabled={status === 'connecting'}>{status === 'connecting' ? 'Connecting…' : status === 'connected' ? 'Reconnect' : 'Join Lounge'}</button></form>
      {savedLounge?.userId === user.id && savedLounge.inviteCode && status !== 'connected' && <button className="btn-outline lounge-rejoin" disabled={status === 'connecting'} onClick={() => joinWithInviteCode(savedLounge.inviteCode)}>Rejoin your recent Lounge · {savedLounge.inviteCode}</button>}
    </>}
    {message && <p className="integration-error" role="status">{message}</p>}
    <SectionTitle>Now Playing</SectionTitle>
    <div className="queue-current"><div className="catalog-cover"/><div><b>{nowPlaying?.title ?? 'No current track'}</b><small>{nowPlaying?.artist ?? (status === 'connected' ? 'The Lounge queue is empty.' : 'Join a Lounge to load its current track.')}</small></div><span className="playing-bars"><i/><i/><i/></span></div>
    {status === 'connected' && <div className="lounge-add"><select aria-label="Choose a catalog track to add" value={selectedTrackId} onChange={(event) => setSelectedTrackId(event.target.value)} disabled={catalogStatus !== 'ready'}><option value="">{catalogStatus === 'loading' ? 'Loading catalog…' : catalogStatus === 'error' ? 'Catalog unavailable' : 'Choose a catalog track…'}</option>{catalog.map((item) => <option key={item.trackId} value={item.trackId}>{item.title} · {item.artist}</option>)}</select><button className="btn-outline" disabled={!selectedTrackId} onClick={() => command('lounge.queue.add', { trackId: selectedTrackId })}>Add to queue</button></div>}
    {status === 'connected' && catalogStatus === 'error' && <p className="integration-error" role="alert">{catalogError}</p>}
    <SectionTitle>Up Next <span className="muted">{queueState?.nextUp?.length ?? 0} tracks</span></SectionTitle>
    {status === 'connected' && queueState?.nextUp?.length ? <div className="queue-list">{queueState.nextUp.map((item, index) => <div className="queue-item" key={item.trackId}><span className="rank">{index + 1}</span><div className="catalog-cover"/><div><b>{item.title ?? item.trackId}</b><small>{item.artist ?? 'Catalog details unavailable'} · {item.votes ?? 0} votes</small></div><button aria-label={`Vote for ${item.title ?? item.trackId}`} onClick={() => command('lounge.queue.vote', { trackId: item.trackId, value: 1 })}><ThumbsUp size={14}/></button><button aria-label={`Downvote ${item.title ?? item.trackId}`} onClick={() => command('lounge.queue.vote', { trackId: item.trackId, value: -1 })}><ThumbsDown size={14}/></button><Grip size={17} className="grip"/></div>)}</div> : <div className="panel integration-status">{status === 'connected' ? 'Nothing is up next yet.' : 'Join a Lounge to see its shared queue.'}</div>}
    {status === 'connected' && queueState?.isHost && <button className="btn-outline lounge-end" onClick={endSession}><Power size={14}/> End Lounge</button>}
    {status === 'connected' && <button className="btn-outline sync-button" onClick={() => command('lounge.sync.request', {})}>Refresh shared state</button>}
    {activeLoungeId && status === 'connected' && <LoungeCollaborationPanel socket={socketRef.current?.socket} loungeId={activeLoungeId} status={status} user={user} catalog={catalog} initialBattle={queueState?.soundclash} aiDjCommentary={aiDjCommentary}/>}
  </div>;
}

function SectionTitle({ children }) { return <div className="section-title"><h2>{children}</h2></div>; }
