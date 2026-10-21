import React, { useEffect, useState } from 'react';
import { Bell, CircleUserRound, Compass, Disc3, Heart, Play, Volume2 } from 'lucide-react';
import { getPreferences, updatePreferences } from '../api/client.js';

const defaults = {
  streamingQuality: 'High (320 kbps)',
  crossfadeSeconds: 6,
  normalizeVolume: true,
  showLyrics: true,
  aiDjCommentary: true,
  downloadQuality: 'High',
  autoPlay: true,
};

const sections = [['Account', CircleUserRound], ['Audio', Volume2], ['Notifications', Bell], ['Privacy', Heart], ['Language', Compass], ['Playback', Play], ['Connected Apps', Disc3]];

export default function SettingsPage({ user }) {
  const [preferences, setPreferences] = useState(defaults);
  const [loadState, setLoadState] = useState(user ? 'loading' : 'signed-out');
  const [saveState, setSaveState] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    setSaveState('');
    if (!user?.id) {
      setLoadState('signed-out');
      setPreferences(defaults);
      return () => { active = false; };
    }
    setLoadState('loading');
    getPreferences().then(({ preferences: saved }) => {
      if (!active) return;
      setPreferences({ ...defaults, ...saved.audio });
      setLoadState('ready');
    }).catch(() => {
      if (!active) return;
      setLoadState('error');
    });
    return () => { active = false; };
  }, [user?.id]);

  async function changePreference(key, value) {
    setSaving(true);
    setSaveState('Saving…');
    try {
      const { preferences: saved } = await updatePreferences({ [key]: value });
      setPreferences({ ...defaults, ...saved.audio });
      setSaveState('Saved to your account');
    } catch (error) {
      setSaveState(error.message || 'Could not save settings. Try again.');
    } finally {
      setSaving(false);
    }
  }

  const controlsReady = loadState === 'ready' && !saving;
  const status = loadState === 'loading' ? 'Loading your saved settings…'
    : loadState === 'signed-out' ? 'Sign in to load and save your audio settings.'
      : loadState === 'error' ? 'Could not load your saved settings. Refresh to try again.'
        : saveState || 'Settings loaded from your account';

  return <div className="page settings-page"><div className="page-heading"><div><span className="eyebrow">MAKE IT YOURS</span><h1>Settings</h1></div></div><div className="settings-layout"><nav className="settings-nav">{sections.map(([title, Icon]) => <button className={title === 'Audio' ? 'selected' : ''} key={title} type="button"><Icon size={15}/>{title}</button>)}</nav><section className="settings-body"><h2>Audio Settings</h2><p className={loadState === 'error' || (saveState && saveState !== 'Saved to your account' && saveState !== 'Saving…') ? 'integration-error' : 'integration-status'} role="status">{status}</p>
    <div className="setting-row"><div><b>Streaming Quality</b><small>Set your preferred audio quality</small></div><select aria-label="Streaming Quality" value={preferences.streamingQuality} disabled={!controlsReady} onChange={(event) => changePreference('streamingQuality', event.target.value)}><option>High (320 kbps)</option><option>Normal (160 kbps)</option><option>Low (96 kbps)</option></select></div>
    <div className="setting-row"><div><b>Crossfade Songs</b><small>Blend tracks into one another</small></div><select aria-label="Crossfade Songs" value={preferences.crossfadeSeconds} disabled={!controlsReady} onChange={(event) => changePreference('crossfadeSeconds', Number(event.target.value))}><option value={0}>Off</option><option value={6}>6 seconds</option><option value={12}>12 seconds</option></select></div>
    {[
      ['Normalize Volume', 'Keep playback at a consistent level', 'normalizeVolume'],
      ['Show Lyrics', 'Display lyrics while listening', 'showLyrics'],
      ['Enable AI DJ Commentary', 'Hear your DJ set the scene', 'aiDjCommentary'],
    ].map(([title, description, key]) => <div className="setting-row" key={key}><div><b>{title}</b><small>{description}</small></div><button type="button" role="switch" aria-label={title} aria-checked={preferences[key]} disabled={!controlsReady} className={`toggle ${preferences[key] ? 'on' : ''}`} onClick={() => changePreference(key, !preferences[key])}><span/></button></div>)}
    <div className="setting-row"><div><b>Download Quality</b><small>Choose offline audio quality</small></div><select aria-label="Download Quality" value={preferences.downloadQuality} disabled={!controlsReady} onChange={(event) => changePreference('downloadQuality', event.target.value)}><option>High</option><option>Normal</option></select></div>
    <div className="setting-row"><div><b>Auto Play</b><small>Keep music playing when your queue ends</small></div><button type="button" role="switch" aria-label="Auto Play" aria-checked={preferences.autoPlay} disabled={!controlsReady} className={`toggle ${preferences.autoPlay ? 'on' : ''}`} onClick={() => changePreference('autoPlay', !preferences.autoPlay)}><span/></button></div>
  </section></div></div>;
}
