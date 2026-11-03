import React, { useEffect, useState } from 'react';
import { Check, Music2, Search, Save } from 'lucide-react';
import { searchTracks, updateTrackAcousticProfile } from '../api/client.js';
import { TrackArtwork } from './CatalogArtwork.jsx';

const camelotKeys = Array.from({ length: 12 }, (_, index) => index + 1).flatMap((number) => [`${number}A`, `${number}B`]);
const emptyProfile = { bpm: '', camelotKey: '', energy: '', valence: '' };
const profileForm = (track) => track?.acoustic
  ? { bpm: String(track.acoustic.bpm), camelotKey: track.acoustic.camelotKey, energy: String(track.acoustic.energy), valence: String(track.acoustic.valence) }
  : { ...emptyProfile };

export default function AdminAcousticProfilePage({ user, sessionStatus = 'ready' }) {
  const [query, setQuery] = useState('');
  const [tracks, setTracks] = useState([]);
  const [catalogState, setCatalogState] = useState('loading');
  const [catalogError, setCatalogError] = useState('');
  const [selected, setSelected] = useState(null);
  const [form, setForm] = useState(emptyProfile);
  const [saveState, setSaveState] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (user?.role !== 'Admin') return undefined;
    const controller = new AbortController();
    setCatalogState('loading');
    searchTracks(query, controller.signal).then(({ items }) => {
      setTracks(Array.isArray(items) ? items : []);
      setCatalogState('ready');
      setCatalogError('');
    }).catch((error) => {
      if (error.name === 'AbortError') return;
      setCatalogError(error.message || 'The catalog could not be loaded.');
      setCatalogState('error');
    });
    return () => controller.abort();
  }, [query, user?.role]);

  function selectTrack(track) {
    setSelected(track);
    setForm(profileForm(track));
    setSaveState('');
  }

  function change(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
    setSaveState('');
  }

  async function save(event) {
    event.preventDefault();
    if (!selected) return;
    setSaving(true);
    setSaveState('Saving acoustic profile…');
    try {
      const acoustic = { bpm: Number(form.bpm), camelotKey: form.camelotKey, energy: Number(form.energy), valence: Number(form.valence) };
      const updated = await updateTrackAcousticProfile(selected.trackId, acoustic);
      setSelected(updated);
      setForm(profileForm(updated));
      setTracks((current) => current.map((track) => track.trackId === updated.trackId ? updated : track));
      setSaveState('Acoustic profile saved and available to matching.');
    } catch (error) {
      setSaveState(error.message || 'Could not save the acoustic profile.');
    } finally {
      setSaving(false);
    }
  }

  if (sessionStatus === 'loading') return <div className="page admin-acoustic-page"><div className="panel integration-status" role="status">Checking administrator access…</div></div>;
  if (!user) return <div className="page admin-acoustic-page"><div className="page-heading"><div><span className="eyebrow">CATALOG MANAGEMENT</span><h1>Acoustic Profiles</h1></div></div><div className="panel integration-error" role="alert">Sign in with an Admin account to manage acoustic profiles.</div></div>;
  if (user.role !== 'Admin') return <div className="page admin-acoustic-page"><div className="page-heading"><div><span className="eyebrow">CATALOG MANAGEMENT</span><h1>Acoustic Profiles</h1></div></div><div className="panel integration-error" role="alert">Admin role required. The API independently enforces this permission.</div></div>;

  const profileAvailable = selected?.acoustic != null;
  return <div className="page admin-acoustic-page">
    <div className="page-heading"><div><span className="eyebrow">ADMIN · TRACK CATALOG</span><h1>Acoustic Profiles</h1><p>Review catalog tracks and save verified BPM, Camelot key, energy and valence values.</p></div></div>
    <section className="admin-acoustic-layout">
      <div className="panel admin-track-browser">
        <h2><Music2 size={16}/> Catalog tracks</h2>
        <label className="admin-track-search"><Search size={14}/><input aria-label="Search catalog tracks" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a track or artist…"/></label>
        {catalogState === 'loading' && <p className="integration-status" role="status">Loading catalog…</p>}
        {catalogState === 'error' && <p className="integration-error" role="alert">{catalogError}</p>}
        {catalogState === 'ready' && tracks.length === 0 && <p className="integration-status">No tracks match this search.</p>}
        {catalogState === 'ready' && tracks.length > 0 && <div className="admin-track-list">{tracks.map((track) => <button type="button" key={track.trackId} className={`admin-track-option ${selected?.trackId === track.trackId ? 'selected' : ''}`} onClick={() => selectTrack(track)}><TrackArtwork track={track}/><span><b>{track.title}</b><small>{track.artist} · {track.trackId}</small></span><small className={track.acoustic ? 'profile-present' : 'profile-missing'}>{track.acoustic ? 'Profile saved' : 'Profile missing'}</small></button>)}</div>}
      </div>
      <div className="panel admin-profile-editor">
        <h2>Profile details</h2>
        {!selected ? <p className="integration-status">Choose a catalog track to inspect its acoustic profile.</p> : <>
          <div className="admin-selected-track"><b>{selected.title}</b><small>{selected.artist} · {selected.trackId}</small><span className={profileAvailable ? 'profile-present' : 'profile-missing'}>{profileAvailable ? 'Acoustic values saved' : 'No acoustic profile saved'}</span>{profileAvailable && <small>Measurement provenance is not stored by the current catalog schema.</small>}</div>
          {!profileAvailable && <p className="admin-profile-note">Values are intentionally blank. Enter measurements from a trusted analysis or curation source; AstraDJ does not generate or verify measurements.</p>}
          <form className="admin-profile-form" onSubmit={save}>
            <label>BPM<input required aria-label="BPM" type="number" min="1" max="300" step="any" value={form.bpm} onChange={(event) => change('bpm', event.target.value)}/><small>Positive · 1–300</small></label>
            <label>Camelot key<select required aria-label="Camelot key" value={form.camelotKey} onChange={(event) => change('camelotKey', event.target.value)}><option value="">Select key</option>{camelotKeys.map((key) => <option key={key}>{key}</option>)}</select></label>
            <label>Energy<input required aria-label="Energy" type="number" min="0" max="1" step="any" value={form.energy} onChange={(event) => change('energy', event.target.value)}/><small>Normalized 0.0–1.0</small></label>
            <label>Valence<input required aria-label="Valence" type="number" min="0" max="1" step="any" value={form.valence} onChange={(event) => change('valence', event.target.value)}/><small>Normalized 0.0–1.0</small></label>
            <button className="btn-primary" type="submit" disabled={saving}><Save size={14}/>{saving ? 'Saving…' : 'Save profile'}</button>
          </form>
          {saveState && <p className={saveState.includes('saved') ? 'admin-save-success' : saveState.startsWith('Saving') ? 'integration-status' : 'integration-error'} role="status">{saveState.includes('saved') && <Check size={13}/>} {saveState}</p>}
        </>}
      </div>
    </section>
  </div>;
}
