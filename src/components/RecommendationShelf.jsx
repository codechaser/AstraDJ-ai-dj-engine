import React, { useEffect, useState } from 'react';
import { getRecommendations } from '../api/client.js';
import { normalizeRecommendations } from '../api/uiData.js';

const artwork = ['photo-1470225620780-dba8ba36b745', 'photo-1514525253161-7a46d19cd819', 'photo-1511379938547-c1f69419868d'];
const imageUrl = (id) => `https://images.unsplash.com/${id}?auto=format&fit=crop&w=320&q=80`;

export default function RecommendationShelf({ user, onSelect, compact = false }) {
  const [items, setItems] = useState([]);
  const [state, setState] = useState(user ? 'loading' : 'signed-out');
  const [message, setMessage] = useState('');

  useEffect(() => {
    let active = true;
    if (!user) { setItems([]); setState('signed-out'); return () => { active = false; }; }
    setState('loading'); setMessage('');
    getRecommendations().then((result) => {
      if (!active) return;
      setItems(normalizeRecommendations(result));
      setState('ready');
    }).catch((error) => {
      if (!active) return;
      setMessage(error.status === 401 ? 'Sign in again to load recommendations.' : error.message || 'Recommendations are unavailable right now.');
      setState('error');
    });
    return () => { active = false; };
  }, [user?.id]);

  const heading = compact ? 'Picked for your taste' : 'Recommended for you';
  if (state === 'signed-out') return <div className="panel integration-status">{heading}: sign in to request your private recommendations.</div>;
  if (state === 'loading') return <div className="panel integration-status" role="status">Loading recommendations…</div>;
  if (state === 'error') return <div className="panel integration-error" role="alert">{message}</div>;
  if (!items.length) return <div className="panel integration-status">No recommendations yet. More interaction history may be needed.</div>;

  return <div className={compact ? 'recommend-row' : 'mix-row'} aria-label={heading}>
    {items.slice(0, compact ? 3 : 4).map((item, index) => {
      const reason = typeof item.reason === 'string' ? item.reason : item.reason?.text;
      return <div className={compact ? 'recommend-card' : 'mix-card'} key={item.trackId}
        onClick={() => onSelect?.({ ...item, img: artwork[index % artwork.length] })}
        role={onSelect ? 'button' : undefined} tabIndex={onSelect ? 0 : undefined}
        onKeyDown={onSelect ? (event) => { if (event.key === 'Enter' || event.key === ' ') onSelect({ ...item, img: artwork[index % artwork.length] }); } : undefined}>
        <img className="cover" src={imageUrl(artwork[index % artwork.length])} alt=""/>
        <b>{item.title}</b><small>{item.artist}</small>
        <small className="recommendation-meta">#{index + 1} · score {Number.isFinite(item.score) ? item.score.toFixed(2) : '—'}</small>
        {reason && <small className="recommendation-meta">{reason}</small>}
      </div>;
    })}
    <small className="recommendation-disclosure">Catalog recommendations; source interactions may be self-reported. Audio availability is not included in this response.</small>
  </div>;
}
