import React, { useEffect, useState } from 'react';
import { getRecommendations, searchTracks } from '../api/client.js';
import { normalizeRecommendations } from '../api/uiData.js';
import { toPlayerTrack } from '../api/catalogData.js';
import { TrackArtwork } from './CatalogArtwork.jsx';

export default function RecommendationShelf({ user, onSelect, compact = false }) {
  const [items, setItems] = useState([]);
  const [state, setState] = useState('loading');
  const [message, setMessage] = useState('');

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setState('loading'); setMessage('');
    const loadCatalogFallback = async () => {
      const catalog = await searchTracks('', controller.signal);
      if (!active) return;
      const playableTracks = (Array.isArray(catalog.items) ? catalog.items : [])
        .filter((track) => typeof track.audioAssetUrl === 'string' && track.audioAssetUrl.trim())
        .slice(0, compact ? 3 : 4);
      setItems(playableTracks);
      setState(playableTracks.length ? 'catalog-fallback' : 'empty');
    };
    if (!user) {
      loadCatalogFallback().catch((error) => {
        if (!active || error.name === 'AbortError') return;
        setMessage(error.message || 'The catalog could not be loaded right now.');
        setState('error');
      });
      return () => { active = false; controller.abort(); };
    }
    getRecommendations().then(async (result) => {
      if (!active) return;
      const recommendations = normalizeRecommendations(result);
      if (recommendations.length) {
        setItems(recommendations);
        setState('ready');
        return;
      }
      await loadCatalogFallback();
    }).catch((error) => {
      if (!active || error.name === 'AbortError') return;
      setMessage(error.status === 401 ? 'Sign in again to load recommendations.' : error.message || 'Recommendations are unavailable right now.');
      setState('error');
    });
    return () => { active = false; controller.abort(); };
  }, [user?.id, compact]);

  const title = state === 'catalog-fallback' ? (compact ? 'Tracks to try' : 'Explore the catalog') : compact ? 'Picked for your taste' : 'Recommended for you';
  if (state === 'loading') return <><div className="section-title"><h2>{title}</h2></div><div className="panel integration-status" role="status">Loading recommendations…</div></>;
  if (state === 'error') return <><div className="section-title"><h2>{title}</h2></div><div className="panel integration-error" role="alert">{message}</div></>;
  if (state === 'empty' || !items.length) return <><div className="section-title"><h2>{title}</h2></div><div className="panel integration-status">No playable catalog tracks are available right now.</div></>;

  return <><div className="section-title"><h2>{title}</h2></div><div className={compact ? 'recommend-row' : 'mix-row'} aria-label={title}>
    {items.slice(0, compact ? 3 : 4).map((item, index) => {
      const reason = typeof item.reason === 'string' ? item.reason : item.reason?.text;
      const personalized = state === 'ready';
      return <div className={compact ? 'recommend-card' : 'mix-card'} key={item.trackId}
        onClick={() => onSelect?.(toPlayerTrack(item))}
        role={onSelect ? 'button' : undefined} tabIndex={onSelect ? 0 : undefined}
        onKeyDown={onSelect ? (event) => { if (event.key === 'Enter' || event.key === ' ') onSelect(toPlayerTrack(item)); } : undefined}>
        <TrackArtwork track={item} className="cover"/>
        <b>{item.title}</b><small>{item.artist}</small>
        {personalized && <small className="recommendation-meta">#{index + 1} · score {Number.isFinite(item.score) ? item.score.toFixed(2) : '—'}</small>}
        {personalized && reason && <small className="recommendation-meta">{reason}</small>}
      </div>;
    })}
    <small className="recommendation-disclosure">{state === 'catalog-fallback' ? 'Playable tracks from the AstraDJ catalog. These are starter picks, not personalized recommendations; listening history can enable personalization.' : 'Catalog recommendations; source interactions may be self-reported. Audio availability is not included in this response.'}</small>
  </div></>;
}
