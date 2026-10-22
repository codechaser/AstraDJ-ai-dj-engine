import React, { useEffect, useState } from 'react';
import { LogOut, UserRound } from 'lucide-react';
import { getAcousticTaste, getLoungeHistory, getPlaybackHistory, getTrack } from '../api/client.js';

export default function AccountPage({ user, sessionStatus, onLogin, onRegister, onLogout, authError }) {
  const [mode, setMode] = useState('login');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [history, setHistory] = useState([]);
  const [historyMessage, setHistoryMessage] = useState('');
  const [loungeHistory, setLoungeHistory] = useState([]);
  const [loungeHistoryMessage, setLoungeHistoryMessage] = useState('');
  const [taste, setTaste] = useState(null);
  const [tasteState, setTasteState] = useState('idle');

  useEffect(() => {
    let active = true;
    setHistory([]);
    setHistoryMessage('');
    setLoungeHistory([]);
    setLoungeHistoryMessage('');
    setTaste(null);
    setTasteState(user ? 'loading' : 'idle');
    if (!user) return () => { active = false; };
    getAcousticTaste().then((result) => { if (active) { setTaste(result); setTasteState('ready'); } })
      .catch(() => { if (active) setTasteState('error'); });
    getLoungeHistory().then(({ items }) => { if (active) setLoungeHistory(items ?? []); })
      .catch(() => { if (active) setLoungeHistoryMessage('Lounge history is unavailable right now.'); });
    getPlaybackHistory().then(async ({ items }) => {
      const rows = await Promise.all(items.map(async (item) => {
        try { return { ...item, track: await getTrack(item.trackId) }; }
        catch { return item; }
      }));
      if (active) setHistory(rows);
    }).catch(() => { if (active) setHistoryMessage('Listening reports are unavailable right now.'); });
    return () => { active = false; };
  }, [user?.id]);

  async function submit(event) {
    event.preventDefault();
    setBusy(true); setError('');
    const form = new FormData(event.currentTarget);
    const input = Object.fromEntries(form.entries());
    try {
      if (mode === 'register') await onRegister({ email: input.email, displayName: input.displayName, password: input.password });
      else await onLogin({ email: input.email, password: input.password });
    } catch (err) { setError(err.message || 'Unable to sign in. Try again.'); }
    finally { setBusy(false); }
  }

  if (sessionStatus === 'loading') return <div className="page profile-page"><div className="panel integration-status">Restoring your AstraDJ session…</div></div>;

  if (!user) return <div className="page profile-page">
    <div className="page-heading"><div><span className="eyebrow">ASTRADJ ACCOUNT</span><h1>{mode === 'login' ? 'Welcome back' : 'Create your account'}</h1><p>Sign in to use your private listening history and join a Lounge.</p></div></div>
    <form className="panel account-form" onSubmit={submit}>
      {mode === 'register' && <label>Display name<input name="displayName" autoComplete="name" maxLength="60" required/></label>}
      <label>Email<input name="email" type="email" autoComplete="email" maxLength="254" required/></label>
      <label>Password<input name="password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={mode === 'login' ? 1 : 10} maxLength="128" required/></label>
      {(error || authError) && <p className="integration-error" role="alert">{error || authError}</p>}
      <div className="account-actions"><button className="btn-primary" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Sign In' : 'Create Account'}</button><button type="button" className="btn-outline" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}>{mode === 'login' ? 'Create account' : 'I have an account'}</button></div>
      <small>New registrations receive the Listener role. Lounge permissions are checked by AstraDJ’s server.</small>
    </form>
  </div>;

  return <div className="page profile-page">
    <div className="profile-card"><div className="account-avatar"><UserRound size={28}/></div><div><span className="eyebrow">YOUR PROFILE</span><h1>{user.displayName}</h1><p>{user.email} · {user.role}</p></div><button className="btn-outline" onClick={async () => { setBusy(true); try { await onLogout(); } finally { setBusy(false); } }} disabled={busy}><LogOut size={14}/> Sign Out</button></div>
    <div className="profile-stats"><div><b>—</b><small>Playlists</small></div><div><b>{history.length || '—'}</b><small>Listening reports</small></div><div><b>—</b><small>Following</small></div></div>
    <div className="section-title"><h2>Acoustic Taste</h2><span className="muted">From reported listening</span></div>
    {tasteState === 'loading' && <div className="panel integration-status" role="status">Calculating your acoustic taste from listening reports…</div>}
    {tasteState === 'error' && <div className="panel integration-error" role="alert">Acoustic taste is unavailable right now.</div>}
    {tasteState === 'ready' && taste?.status !== 'ready' && <div className="panel integration-status" role="status">{taste?.explanation ?? 'More eligible listening data is needed to show preferences.'} {taste?.coverage?.tracksWithValidAcoustics ?? 0} of {taste?.coverage?.distinctHistoryTracks ?? 0} distinct tracks in your history have valid acoustic profiles.</div>}
    {tasteState === 'ready' && taste?.status === 'ready' && <><div className="profile-stats"><div><b>{taste.profile.bpmRange.min}–{taste.profile.bpmRange.max}</b><small>Observed BPM · mean {taste.profile.preferredBpm}</small></div><div><b>{taste.profile.preferredCamelotKeys.slice(0, 3).map(({ key }) => key).join(' · ')}</b><small>Preferred Camelot keys</small></div><div><b>{taste.profile.energy.toFixed(2)} / {taste.profile.valence.toFixed(2)}</b><small>Energy / valence preference</small></div></div><small className="recommendation-disclosure">Based on {taste.eligibleInteractionCount} eligible reports across {taste.distinctEligibleTrackCount} distinct tracks · acoustic coverage {taste.coverage.tracksWithValidAcoustics}/{taste.coverage.catalogTracks} catalogued history tracks.</small></>}
    <div className="section-title"><h2>Listening Reports</h2><span className="muted">Self-reported history</span></div>
    {historyMessage && <p className="integration-error" role="status">{historyMessage}</p>}
    {history.length ? <div className="recent-grid">{history.map((item) => <div className="recent-card" key={item.interactionId}><div className="catalog-cover"/><div><b>{item.track?.title ?? item.trackId}</b><small>{item.track?.artist ?? item.source} · {item.playedSeconds}s reported</small></div></div>)}</div> : <div className="panel integration-status">{historyMessage ? 'Listening history could not be loaded.' : user ? 'No listening reports yet.' : 'Sign in to view history.'}</div>}
    <div className="section-title"><h2>Lounge History</h2><span className="muted">Ended sessions you hosted or joined</span></div>
    {loungeHistoryMessage && <p className="integration-error" role="status">{loungeHistoryMessage}</p>}
    {loungeHistory.length ? <div className="recent-grid">{loungeHistory.map((item) => <div className="recent-card lounge-history-card" key={item.loungeId}><div className="catalog-cover"/><div><b>{item.vibeProfile}</b><small>{item.role} · {item.endedAt ? new Date(item.endedAt).toLocaleString() : 'Ended'}</small><small>{item.summary?.durationSeconds == null ? 'Duration unavailable' : `${Math.floor(item.summary.durationSeconds / 60)} min`} · {item.summary?.soundclashBattles == null ? 'Battles unavailable' : `${item.summary.soundclashBattles} battles`} · {item.summary?.chatMessageCount ?? 0} chat messages</small><small>{item.summary?.peakConcurrentParticipants == null ? 'Peak participants unavailable' : `Peak ${item.summary.peakConcurrentParticipants}`} · {item.summary?.aiDjQuestionCount == null ? 'AI questions unavailable' : `${item.summary.aiDjQuestionCount} AI questions`} · {item.summary?.sentimentTimeline?.length ?? 0} sentiment samples</small></div></div>)}</div> : <div className="panel integration-status">{loungeHistoryMessage ? 'Lounge history could not be loaded.' : 'No ended Lounge sessions yet.'}</div>}
  </div>;
}
