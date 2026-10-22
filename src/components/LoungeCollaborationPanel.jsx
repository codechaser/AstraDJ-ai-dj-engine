import React, { useEffect, useState } from 'react';
import { getActiveLounge, getLoungeAnalytics, saveActiveLounge } from '../api/client.js';
import { subscribeToLoungeEvents } from '../api/loungeEvents.js';
import { applySoundclashEvent, displayAnalyticsMetric, shouldShowAiDjCommentary, tiedCandidateIds, uniqueChatMessages } from '../api/uiData.js';

const errorMessage = (ack) => ack?.error?.message || 'The Lounge rejected that action.';

export default function LoungeCollaborationPanel({ socket, loungeId, status, user, catalog, initialBattle, aiDjCommentary = false }) {
  const [messages, setMessages] = useState([]);
  const [sentiment, setSentiment] = useState(null);
  const [body, setBody] = useState('');
  const [chatState, setChatState] = useState('idle');
  const [chatError, setChatError] = useState('');
  const [battle, setBattle] = useState(initialBattle ?? null);
  const [battleTrackId, setBattleTrackId] = useState('');
  const [battleError, setBattleError] = useState('');
  const [battleBusy, setBattleBusy] = useState(false);
  const [announcement, setAnnouncement] = useState(null);
  const [remaining, setRemaining] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [analyticsState, setAnalyticsState] = useState('idle');
  const [analyticsError, setAnalyticsError] = useState('');

  useEffect(() => {
    setMessages([]); setSentiment(null); setBody(''); setChatError(''); setChatState('idle');
    setBattle(initialBattle ?? null); setBattleError(''); setAnnouncement(null);
    setAnalytics(null); setAnalyticsState(loungeId ? 'loading' : 'idle'); setAnalyticsError('');
  }, [loungeId]);

  useEffect(() => { setBattle(initialBattle ?? null); }, [initialBattle]);

  useEffect(() => { if (!shouldShowAiDjCommentary(aiDjCommentary)) setAnnouncement(null); }, [aiDjCommentary]);

  useEffect(() => {
    if (!socket || !loungeId) return undefined;
    return subscribeToLoungeEvents(socket, loungeId, (eventName, envelope) => {
      const payload = envelope.payload ?? {};
      if (eventName === 'lounge.chat.message') setMessages((current) => uniqueChatMessages([...current, payload]));
      if (eventName === 'lounge.sentiment.score') {
        setSentiment(payload);
        const saved = getActiveLounge();
        if (saved?.loungeId === loungeId) saveActiveLounge({ ...saved, sentiment: payload });
      }
      if (eventName.startsWith('lounge.soundclash.')) setBattle((current) => applySoundclashEvent(current, eventName, payload));
      if (eventName === 'lounge.ai.dj_announcement' && shouldShowAiDjCommentary(aiDjCommentary)) setAnnouncement(payload);
    });
  }, [socket, loungeId, aiDjCommentary]);

  useEffect(() => {
    if (!socket || !loungeId || status !== 'connected') return;
    let active = true;
    setChatState('loading'); setChatError('');
    socket.emit('lounge.chat.history', { limit: 50 }, (ack) => {
      if (!active) return;
      if (ack?.ok) { setMessages((current) => uniqueChatMessages([...current, ...(ack.messages ?? [])])); setChatState('ready'); }
      else { setChatError(errorMessage(ack)); setChatState('error'); }
    });
    return () => { active = false; };
  }, [socket, loungeId, status]);

  useEffect(() => {
    if (!loungeId) return;
    let active = true;
    setAnalyticsState('loading'); setAnalyticsError('');
    getLoungeAnalytics(loungeId).then((result) => { if (active) { setAnalytics(result); setAnalyticsState('ready'); } })
      .catch((error) => { if (active) { setAnalyticsError(error.message || 'Lounge analytics are unavailable.'); setAnalyticsState('error'); } });
    return () => { active = false; };
  }, [loungeId]);

  useEffect(() => {
    if (battle?.status !== 'open' || !Number.isFinite(battle.closesAt)) { setRemaining(null); return undefined; }
    const update = () => setRemaining(Math.max(0, Math.ceil((battle.closesAt - Date.now()) / 1000)));
    update(); const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [battle?.battleId, battle?.status, battle?.closesAt]);

  const voteCounts = battle?.voteCounts ?? {};
  const tiedCandidates = tiedCandidateIds(battle);

  function command(eventName, payload, done) {
    if (!socket?.connected) { done?.({ ok: false, error: { message: 'Reconnect to the Lounge before sending this action.' } }); return; }
    socket.emit(eventName, payload, (ack) => done?.(ack));
  }

  function sendMessage(event) {
    event.preventDefault();
    const cleanBody = body.trim();
    if (!cleanBody || chatState === 'sending') return;
    setChatState('sending'); setChatError('');
    command('lounge.chat.message', { body: cleanBody }, (ack) => {
      if (ack?.ok) {
        if (ack.message) setMessages((current) => uniqueChatMessages([...current, ack.message]));
        if (ack.sentiment) {
          setSentiment(ack.sentiment);
          const saved = getActiveLounge();
          if (saved?.loungeId === loungeId) saveActiveLounge({ ...saved, sentiment: ack.sentiment });
        }
        setBody(''); setChatState('ready');
      } else { setChatError(errorMessage(ack)); setChatState('ready'); }
    });
  }

  function sendBattleCommand(eventName, payload) {
    setBattleBusy(true); setBattleError('');
    command(eventName, payload, (ack) => {
      if (ack?.ok) {
        if (ack.state) setBattle(ack.state);
        if (ack.state?.soundclash) setBattle(ack.state.soundclash);
        setBattleTrackId('');
      } else setBattleError(errorMessage(ack));
      setBattleBusy(false);
    });
  }

  const nameFor = (trackId) => catalog.find((item) => item.trackId === trackId)?.title ?? trackId;
  const isListener = user?.role === 'Listener';
  const canHost = user?.role === 'Host';
  const canResolve = canHost || user?.role === 'Co-DJ';

  return <div className="lounge-tools">
    <section className="panel lounge-chat-panel">
      <div className="section-title"><h2>Live Chat</h2><span className="muted">{status === 'connected' ? 'Connected' : 'Reconnecting'}</span></div>
      {sentiment ? <p className="sentiment-status" aria-live="polite">Room sentiment score: {Number(sentiment.rollingScore).toFixed(2)} · {sentiment.sampleSize} messages / {sentiment.windowSeconds}s</p> : <p className="sentiment-status">Sentiment will appear after the room receives chat messages.</p>}
      <div className="lounge-chat-history" aria-live="polite">
        {chatState === 'loading' && <div className="integration-status">Loading Lounge history…</div>}
        {chatState === 'error' && <div className="integration-error" role="alert">{chatError}</div>}
        {chatState === 'ready' && messages.length === 0 && <div className="integration-status">No Lounge messages yet.</div>}
        {messages.map((message) => <div className="lounge-chat-message" key={message.messageId}><b>{String(message.userId) === String(user?.id) ? 'You' : `Member ${String(message.userId).slice(-4)}`}</b><span>{message.body}</span><small>{new Date(message.tsSeconds * 1000).toLocaleTimeString()}</small></div>)}
      </div>
      <form className="lounge-chat-form" onSubmit={sendMessage}><input aria-label="Chat message" value={body} onChange={(event) => setBody(event.target.value)} maxLength={500} placeholder="Send a message to the Lounge…" disabled={status !== 'connected' || chatState === 'sending'}/><button className="btn-outline" disabled={!body.trim() || status !== 'connected' || chatState === 'sending'}>{chatState === 'sending' ? 'Sending…' : 'Send'}</button></form>
      {chatError && chatState !== 'error' && <p className="integration-error" role="alert">{chatError}</p>}
    </section>

    <section className="panel soundclash-panel">
      <div className="section-title"><h2>Soundclash</h2><span className="muted">{battle?.status ?? 'idle'}</span></div>
      {!battle || battle.status === 'idle' ? <p className="integration-status">No Soundclash entries yet. A Listener can submit an unqueued catalog track.</p> : <>
        {battle.status === 'open' && <p className="sentiment-status">Voting closes in {remaining ?? '—'}s. The server decides the result.</p>}
        {battle.status === 'tied' && <p className="sentiment-status">The server reported a tie. Host or Co-DJ can resolve one of the tied entries.</p>}
        {(battle.candidateTrackIds ?? []).map((trackId) => <div className="soundclash-candidate" key={trackId}><span>{nameFor(trackId)}</span><span>{voteCounts[trackId] ?? 0} votes</span>
          {battle.status === 'open' && isListener && <button className="btn-outline" disabled={battleBusy} onClick={() => sendBattleCommand('lounge.soundclash.vote', { battleId: battle.battleId, trackId })}>Vote</button>}
          {battle.status === 'tied' && canResolve && tiedCandidates.includes(trackId) && <button className="btn-outline" disabled={battleBusy} onClick={() => sendBattleCommand('lounge.soundclash.resolve', { battleId: battle.battleId, winningTrackId: trackId })}>Resolve to this track</button>}
          {battle.status === 'resolved' && battle.winningTrackId === trackId && <b className="soundclash-winner">Winner · queued</b>}
        </div>)}
      </>}
      {isListener && <div className="soundclash-actions"><select aria-label="Choose a track to submit to Soundclash" value={battleTrackId} onChange={(event) => setBattleTrackId(event.target.value)} disabled={battleBusy}><option value="">Choose a catalog track…</option>{catalog.map((track) => <option key={track.trackId} value={track.trackId}>{track.title} · {track.artist}</option>)}</select><button className="btn-outline" disabled={!battleTrackId || battleBusy} onClick={() => sendBattleCommand('lounge.soundclash.submit', { trackId: battleTrackId })}>Submit track</button></div>}
      {canHost && battle?.status === 'collecting' && <button className="btn-outline" disabled={battleBusy || (battle.candidateTrackIds?.length ?? 0) < 2} onClick={() => sendBattleCommand('lounge.soundclash.open', {})}>Open timed vote</button>}
      {battleError && <p className="integration-error" role="alert">{battleError}</p>}
      {announcement && <div className="ai-grounded-result"><b>AstraDJ transition · deterministic metadata fallback</b><p>{announcement.text}</p><small>Related track: {nameFor(announcement.relatedTrackId)} · Sources: {(announcement.sourceEvents ?? []).join(', ') || 'none returned'}</small></div>}
    </section>

    <section className="panel lounge-analytics-panel">
      <div className="section-title"><h2>Lounge Analytics</h2><span className="muted">Persisted records</span></div>
      {analyticsState === 'loading' && <div className="integration-status">Loading authorized Lounge analytics…</div>}
      {analyticsState === 'error' && <div className="integration-error" role="alert">{analyticsError}</div>}
      {analyticsState === 'ready' && analytics && <><div className="analytics-grid">{[['Queue events', analytics.queueEventCount], ['Soundclash battles', analytics.soundclashBattles], ['Chat messages', analytics.chatMessageCount], ['Session duration', analytics.durationSeconds == null ? null : `${analytics.durationSeconds}s`], ['Peak participants', analytics.peakConcurrentParticipants], ['AI DJ questions', analytics.aiDjQuestionCount]].map(([label, value]) => <div key={label}><small>{label}</small><b>{displayAnalyticsMetric(value)}</b></div>)}</div><small>Persisted sentiment timeline · heuristic scores, not a verified mood measure</small><div className="sentiment-timeline" role="img" aria-label="Persisted sentiment score samples from this Lounge">{analytics.sentimentTimeline?.length ? analytics.sentimentTimeline.slice(-30).map((point, index) => <i key={`${point.at}-${index}`} title={`${point.bucket} · ${Number(point.score).toFixed(2)} · ${new Date(point.at).toLocaleString()}`} style={{ height: `${Math.max(3, Math.min(100, Number(point.score) * 100))}%` }}/> ) : <span>No persisted sentiment messages.</span>}</div></>}
    </section>
  </div>;
}
