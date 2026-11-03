import React, { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { Play, Search, X } from 'lucide-react';
import { searchTracks } from '../api/client.js';
import { toPlayerTrack } from '../api/catalogData.js';
import { TrackArtwork } from './CatalogArtwork.jsx';

const toTime = (seconds = 0) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

export default function CatalogSearchPage({ query, playSong }) {
  const [term, setTerm] = useState(query ?? '');
  const [result, setResult] = useState([]);
  const [tab, setTab] = useState('All');
  const [status, setStatus] = useState('loading');
  const [message, setMessage] = useState('');

  useEffect(() => { setTerm(query ?? ''); }, [query]);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setStatus('loading'); setMessage('');
      searchTracks(term, controller.signal).then((response) => {
        setResult(response.items ?? []); setStatus('ready');
      }).catch((error) => {
        if (error.name === 'AbortError') return;
        setMessage(error.message || 'The catalog could not be loaded.'); setStatus('error');
      });
    }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [term]);

  const asSong = (track) => ({ ...toPlayerTrack(track), time: toTime(track.durationSeconds) });
  return <div className="page search-page">
    <div className="search-title"><span className="eyebrow">FIND YOUR FREQUENCY</span><h1>Search</h1></div>
    <div className="large-search"><Search size={21}/><input aria-label="Search the AstraDJ track catalog" placeholder="Search songs and artists in the AstraDJ catalog" value={term} onChange={(event) => setTerm(event.target.value)}/>{term && <button aria-label="Clear search" onClick={() => setTerm('')}><X size={18}/></button>}</div>
    <div className="filter-tabs">{['All','Songs','Artists','Albums','Playlists','Podcasts'].map((category) => <button key={category} className={tab === category ? 'selected' : ''} onClick={() => setTab(category)}>{category}</button>)}</div>
    <div className="search-results catalog-results">
      <section><div className="section-title"><h2>{tab === 'All' || tab === 'Songs' ? (term.trim() ? 'Catalog results' : 'AstraDJ Catalog') : tab}</h2><span className="muted">{status === 'ready' && (tab === 'All' || tab === 'Songs') ? `${result.length} tracks` : ''}</span></div>
        {tab !== 'All' && tab !== 'Songs' && <div className="panel integration-status">The backend currently provides song catalog entries only.</div>}
        {(tab === 'All' || tab === 'Songs') && status === 'loading' && <div className="panel integration-status">Searching the catalog…</div>}
        {(tab === 'All' || tab === 'Songs') && status === 'error' && <div className="panel integration-error" role="alert">{message}</div>}
        {(tab === 'All' || tab === 'Songs') && status === 'ready' && result.length === 0 && <div className="panel integration-status">No tracks match this search.</div>}
        {(tab === 'All' || tab === 'Songs') && status === 'ready' && result.length > 0 && <div className="ranked">{result.map((track, index) => {
          const song = asSong(track);
          return <div className="catalog-row" key={track.trackId}><span className="rank">{index + 1}</span><TrackArtwork track={track}/><div className="song-meta"><b>{track.title}</b><small>{track.artist} · {track.trackId}</small></div><span className="song-time">{song.time}</span><button className="row-play" aria-label={`Select ${track.title}`} onClick={() => playSong(song)}><Play size={13} fill="currentColor"/></button></div>;
        })}</div>}
      </section>
      <section><div className="section-title"><h2>Catalog note</h2></div><div className="panel catalog-note">These are metadata catalog entries. Playback is available only when the track record includes a working audio asset.</div><NavLink className="btn-outline catalog-link" to="/queue">Open Lounge queue</NavLink></section>
    </div>
  </div>;
}
