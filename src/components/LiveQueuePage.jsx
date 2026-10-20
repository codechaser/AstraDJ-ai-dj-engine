import React, { useEffect, useRef, useState } from 'react';
import { Grip, ThumbsDown, ThumbsUp, X } from 'lucide-react';
import { getAccessToken, getActiveLounge, getSocketOrigin, getTrack, saveActiveLounge, searchTracks } from '../api/client.js';
import { connectToLounge } from '../api/loungeConnection.js';
import LoungeCollaborationPanel from './LoungeCollaborationPanel.jsx';

function formatTrack(track) {
  return { ...track, img: 'photo-1514525253161-7a46d19cd819', time: `${Math.floor((track.durationSeconds ?? 0) / 60)}:${String(Math.floor((track.durationSeconds ?? 0) % 60)).padStart(2, '0')}` };
}

export default function LiveQueuePage({ track, onCurrentTrack, user }) {
  const socketRef = useRef(null);
  const loungeIdRef = useRef(null);
  const [inviteCode, setInviteCode] = useState('');
  const [queueState, setQueueState] = useState(null);
  const [activeLoungeId, setActiveLoungeId] = useState(null);
  const [catalog, setCatalog] = useState([]);
  const [catalogStatus, setCatalogStatus] = useState('loading');
  const [catalogError, setCatalogError] = useState('');
  const [selectedTrackId, setSelectedTrackId] = useState('');
  const [status, setStatus] = useState('disconnected');
  const [message, setMessage] = useState('');

  useEffect(() => {
    let active = true;
    searchTracks('', undefined).then((result) => { if (active) { setCatalog(result.items ?? []); setCatalogStatus('ready'); } }).catch((error) => { if (active) { setCatalogStatus('error'); setCatalogError(error.message || 'The track catalog is unavailable.'); } });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!user) {
      socketRef.current?.disconnect(); socketRef.current = null;
      loungeIdRef.current = null; setActiveLoungeId(null); saveActiveLounge(null); setQueueState(null); setStatus('disconnected');
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
  }

  function connect(event) {
    event.preventDefault();
    setMessage('');
    if (!user || !getAccessToken()) { setMessage('Sign in before joining a Lounge.'); return; }
    socketRef.current?.disconnect();
    loungeIdRef.current = null; setActiveLoungeId(null); saveActiveLounge(null); setQueueState(null); setStatus('connecting');
    socketRef.current = connectToLounge({
      inviteCode, token: getAccessToken(), origin: getSocketOrigin(),
      onState: (state) => {
        loungeIdRef.current = state?.loungeId ?? null;
        setActiveLoungeId(loungeIdRef.current);
        setQueueState(state);
        if (state?.loungeId) saveActiveLounge({ userId: user.id, loungeId: state.loungeId, inviteCode: inviteCode.trim().toUpperCase(), snapshot: state });
        if (state?.nowPlaying?.trackId) onCurrentTrack(formatTrack(state.nowPlaying));
      },
      onQueueUpdate: (eventEnvelope) => { void hydrateUpdate(eventEnvelope); },
      onStatus: setStatus,
      onError: (error) => setMessage(error?.message === 'AUTH_REQUIRED' ? 'Your session expired. Sign in again.' : error?.message ?? 'Could not connect to the Lounge service.'),
    });
  }

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

  const nowPlaying = queueState?.nowPlaying ?? track;
  return <div className="page queue-page">
    <div className="page-heading"><div><span className="eyebrow">YOUR LISTENING FLOW</span><h1>Queue</h1></div><span className="muted">{status === 'connected' ? 'Live' : 'Not connected'}</span></div>
    {!user ? <div className="panel integration-status">Sign in from your Profile to join a shared Lounge queue.</div> : <form className="lounge-connect" onSubmit={connect}><input aria-label="Lounge invite code" placeholder="Enter Lounge invite code (SP-XXXX)" value={inviteCode} onChange={(event) => setInviteCode(event.target.value)} required maxLength="7"/><button className="btn-outline" disabled={status === 'connecting'}>{status === 'connecting' ? 'Connecting…' : status === 'connected' ? 'Reconnect' : 'Join Lounge'}</button></form>}
    {message && <p className="integration-error" role="status">{message}</p>}
    <SectionTitle>Now Playing</SectionTitle>
    <div className="queue-current"><div className="catalog-cover"/><div><b>{nowPlaying?.title ?? 'No current track'}</b><small>{nowPlaying?.artist ?? (status === 'connected' ? 'The Lounge queue is empty.' : 'Join a Lounge to load its current track.')}</small></div><span className="playing-bars"><i/><i/><i/></span></div>
    {status === 'connected' && <div className="lounge-add"><select aria-label="Choose a catalog track to add" value={selectedTrackId} onChange={(event) => setSelectedTrackId(event.target.value)} disabled={catalogStatus !== 'ready'}><option value="">{catalogStatus === 'loading' ? 'Loading catalog…' : catalogStatus === 'error' ? 'Catalog unavailable' : 'Choose a catalog track…'}</option>{catalog.map((item) => <option key={item.trackId} value={item.trackId}>{item.title} · {item.artist}</option>)}</select><button className="btn-outline" disabled={!selectedTrackId} onClick={() => command('lounge.queue.add', { trackId: selectedTrackId })}>Add to queue</button></div>}
    {status === 'connected' && catalogStatus === 'error' && <p className="integration-error" role="alert">{catalogError}</p>}
    <SectionTitle>Up Next <span className="muted">{queueState?.nextUp?.length ?? 0} tracks</span></SectionTitle>
    {status === 'connected' && queueState?.nextUp?.length ? <div className="queue-list">{queueState.nextUp.map((item, index) => <div className="queue-item" key={item.trackId}><span className="rank">{index + 1}</span><div className="catalog-cover"/><div><b>{item.title ?? item.trackId}</b><small>{item.artist ?? 'Catalog details unavailable'} · {item.votes ?? 0} votes</small></div><button aria-label={`Vote for ${item.title ?? item.trackId}`} onClick={() => command('lounge.queue.vote', { trackId: item.trackId, value: 1 })}><ThumbsUp size={14}/></button><button aria-label={`Downvote ${item.title ?? item.trackId}`} onClick={() => command('lounge.queue.vote', { trackId: item.trackId, value: -1 })}><ThumbsDown size={14}/></button><Grip size={17} className="grip"/></div>)}</div> : <div className="panel integration-status">{status === 'connected' ? 'Nothing is up next yet.' : 'Join a Lounge to see its shared queue.'}</div>}
    {status === 'connected' && <button className="btn-outline sync-button" onClick={() => command('lounge.sync.request', {})}>Refresh shared state</button>}
    {activeLoungeId && <LoungeCollaborationPanel socket={socketRef.current?.socket} loungeId={activeLoungeId} status={status} user={user} catalog={catalog} initialBattle={queueState?.soundclash}/>}
  </div>;
}

function SectionTitle({ children }) { return <div className="section-title"><h2>{children}</h2></div>; }
