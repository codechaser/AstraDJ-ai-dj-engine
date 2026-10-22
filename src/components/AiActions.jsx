import React, { useEffect, useRef, useState } from 'react';
import { Send } from 'lucide-react';
import { askTrackQuestion, getActiveLounge, requestSegue } from '../api/client.js';
import { segueCommentaryText } from '../api/uiData.js';

export default function AiActions({ user, trackId, currentTime = 0, embedded = false, aiDjCommentary = true }) {
  const [context, setContext] = useState(null);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState(null);
  const [segue, setSegue] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const questionRequestRef = useRef(null);

  useEffect(() => {
    const saved = getActiveLounge();
    setContext(user && saved?.userId === user.id ? saved : null);
  }, [user?.id]);

  async function ask(event) {
    event.preventDefault();
    if (!user || !context?.loungeId) { setError('Join a Lounge and sign in before asking about its current track.'); return; }
    setBusy('ask'); setError(''); setAnswer(null);
    const normalizedQuestion = question.trim();
    if (questionRequestRef.current?.question !== normalizedQuestion) {
      questionRequestRef.current = { question: normalizedQuestion, requestId: globalThis.crypto?.randomUUID?.() ?? `q-${Date.now()}-${Math.random().toString(36).slice(2)}` };
    }
    try {
      setAnswer(await askTrackQuestion(context.loungeId, normalizedQuestion, questionRequestRef.current.requestId));
      questionRequestRef.current = null;
    }
    catch (err) { setError(err.message || 'The track question could not be answered.'); }
    finally { setBusy(''); }
  }

  async function suggestSegue() {
    if (!user || !context?.loungeId) { setError('Join a Lounge and sign in before requesting a segue.'); return; }
    const currentTrackId = context.snapshot?.nowPlaying?.trackId;
    const candidateTrackIds = (context.snapshot?.nextUp ?? []).map((item) => item.trackId).filter(Boolean);
    if (!currentTrackId || !candidateTrackIds.length) { setError('The active Lounge needs a current track and at least one Next Up candidate.'); return; }
    setBusy('segue'); setError(''); setSegue(null);
    try {
      setSegue(await requestSegue(context.loungeId, {
        currentTrackId,
        currentTs: trackId === currentTrackId && Number.isFinite(currentTime) ? Math.max(0, currentTime) : 0,
        candidateTrackIds,
        currentSentimentScore: context.sentiment?.rollingScore ?? 0.5,
        recentTrackIds: [],
      }));
    } catch (err) { setError(err.message || 'A segue suggestion is unavailable.'); }
    finally { setBusy(''); }
  }

  return <div className={`${embedded ? 'ai-connected-embedded' : 'panel ai-connected-actions'}`}>
    {!embedded && <div className="section-title"><h2>Connected DJ tools</h2><span className="muted">{context?.loungeId ? `Lounge ${context.loungeId}` : 'No active Lounge'}</span></div>}
    {!context?.loungeId && <p className="integration-status">Join a Lounge from Queue to use current-track Q&amp;A and segue suggestions.</p>}
    <form className={embedded ? 'request-box' : 'ai-question-form'} onSubmit={ask}>
      <input aria-label="Ask about the current Lounge track" value={question} onChange={(event) => { setQuestion(event.target.value); questionRequestRef.current = null; }} minLength="3" maxLength="500" placeholder="Ask about the current track's metadata…" disabled={!user || !context?.loungeId || busy !== ''}/>
      <button aria-label="Ask AstraDJ" disabled={!question.trim() || busy !== ''}>{embedded ? <Send size={15}/> : busy === 'ask' ? 'Asking…' : 'Ask'}</button>
    </form>
    <button className="btn-outline" onClick={suggestSegue} disabled={!context?.loungeId || busy !== ''}>{busy === 'segue' ? 'Matching…' : 'Suggest an acoustic segue'}</button>
    {error && <p className="integration-error" role="alert">{error}</p>}
    {answer && <div className="ai-grounded-result" role="status"><b>Grounded answer · {answer.provider}</b><p>{answer.answer}</p><small>{answer.grounded ? `Sources: ${answer.sourceEvents.join(', ')}` : 'No supporting track metadata was found.'}</small></div>}
    {segue && <div className="ai-grounded-result" role="status">
      {segue.selectedTrackId ? <><b>Segue suggestion · {segue.provider}</b><p>{segueCommentaryText(segue, aiDjCommentary)}</p><small>{segue.matchReason?.selectionReason ?? 'Acoustic match accepted'} · {segue.sourceEvents?.length ? `Sources: ${segue.sourceEvents.join(', ')}` : 'No metadata references returned.'}</small></> : <><b>No compatible segue</b><p>No candidate met the acoustic matching rules.</p></>}
    </div>}
    <small className="ai-provider-note">Answers and transition text use deterministic metadata retrieval/templates; no external LLM is connected. The segue request's compatibility field defaults to neutral here; server room sentiment remains authoritative.</small>
  </div>;
}
