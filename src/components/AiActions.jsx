import React, { useEffect, useRef, useState } from 'react';
import { Send } from 'lucide-react';
import { askTrackQuestion, getActiveLounge, requestSegue } from '../api/client.js';
import { segueCommentaryText } from '../api/uiData.js';

export default function AiActions({ user, trackId, currentTime = 0, embedded = false, aiDjCommentary = true, voiceTranscript = '' }) {
  const [context, setContext] = useState(null);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState(null);
  const [segue, setSegue] = useState(null);
  const [moodNote, setMoodNote] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const questionRequestRef = useRef(null);

  useEffect(() => {
    const saved = getActiveLounge();
    setContext(user && saved?.userId === user.id ? saved : null);
  }, [user?.id]);

  useEffect(() => {
    const transcript = voiceTranscript.trim();
    if (!transcript) return;
    setQuestion(transcript.slice(0, 500));
    questionRequestRef.current = null;
    setError('');
  }, [voiceTranscript]);

  async function ask(event) {
    event.preventDefault();
    const normalizedQuestion = question.trim();
    if (!user || !context?.loungeId) {
      if (normalizedQuestion.length < 3) { setError('Describe your mood in at least 3 characters.'); return; }
      setMoodNote(normalizedQuestion);
      setQuestion('');
      setError('');
      return;
    }
    setBusy('ask'); setError(''); setAnswer(null);
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
    {!context?.loungeId && <p className="integration-status">Describe your mood below. Join a Lounge from Queue for current-track Q&amp;A and segue suggestions.</p>}
    <form className={embedded ? 'request-box' : 'ai-question-form'} onSubmit={ask}>
      <input aria-label={user && context?.loungeId ? 'Ask about the current Lounge track' : 'Describe your mood'} value={question} onChange={(event) => { setQuestion(event.target.value); questionRequestRef.current = null; }} minLength="3" maxLength="500" placeholder={user && context?.loungeId ? "Ask about the current track's metadata…" : 'Describe your mood (e.g. calm music for a night drive)…'} disabled={busy !== ''}/>
      <button aria-label={user && context?.loungeId ? 'Ask AstraDJ' : 'Save mood note'} disabled={!question.trim() || busy !== ''}>{embedded ? <Send size={15}/> : busy === 'ask' ? 'Asking…' : user && context?.loungeId ? 'Ask' : 'Save mood note'}</button>
    </form>
    {moodNote && !context?.loungeId && <div className="ai-grounded-result" role="status"><b>Mood note saved for this session</b><p>{moodNote}</p><small>Free-text notes are not yet used to change recommendations. Choose a mood preset above for the current recommendation flow.</small></div>}
    <button className="btn-outline" onClick={suggestSegue} disabled={!context?.loungeId || busy !== ''}>{busy === 'segue' ? 'Matching…' : 'Suggest an acoustic segue'}</button>
    {error && <p className="integration-error" role="alert">{error}</p>}
    {answer && <div className="ai-grounded-result" role="status"><b>Grounded answer · {answer.provider}</b><p>{answer.answer}</p><small>{answer.grounded ? `Sources: ${answer.sourceEvents.join(', ')}` : 'No supporting track metadata was found.'}</small></div>}
    {segue && <div className="ai-grounded-result" role="status">
      {segue.selectedTrackId ? <><b>Segue suggestion · {segue.provider}</b><p>{segueCommentaryText(segue, aiDjCommentary)}</p><small>{segue.matchReason?.selectionReason ?? 'Acoustic match accepted'} · {segue.sourceEvents?.length ? `Sources: ${segue.sourceEvents.join(', ')}` : 'No metadata references returned.'}</small></> : <><b>No compatible segue</b><p>No candidate met the acoustic matching rules.</p></>}
    </div>}
    <small className="ai-provider-note">Answers and transition text use deterministic metadata retrieval/templates; no external LLM is connected. The segue request's compatibility field defaults to neutral here; server room sentiment remains authoritative.</small>
  </div>;
}
