import React, { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Headphones, Play, Podcast, RefreshCw } from 'lucide-react';
import { getPodcastCatalog } from '../api/client.js';
import { formatTrackDuration } from '../api/catalogData.js';

export default function PodcastBrowse({ playSong, track, playing }) {
  const [catalog, setCatalog] = useState(null);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const load = useCallback((signal) => {
    setStatus('loading');
    setError('');
    getPodcastCatalog(signal).then((result) => {
      setCatalog(result);
      setStatus('ready');
    }).catch((reason) => {
      if (reason.name === 'AbortError') return;
      setError(reason.code?.startsWith('PODCAST_') ? 'The podcast source is temporarily unavailable. Check the connection and try again.' : reason.message || 'The podcast catalog could not be loaded.');
      setStatus('error');
    });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  return <section className="podcast-browse" aria-labelledby="podcast-title">
    <div className="podcast-heading"><span className="ai-tag">ASTRADJ PODCASTS</span><h1 id="podcast-title">Podcasts</h1><p>Browse episodes from a public RSS feed and listen through the AstraDJ player.</p></div>
    {status === 'loading' && <div className="panel integration-status" role="status">Loading podcast episodes…</div>}
    {status === 'error' && <div className="panel podcast-error" role="alert"><span>{error}</span><button type="button" className="btn-outline" onClick={() => load(new AbortController().signal)}><RefreshCw size={14}/>Try again</button></div>}
    {status === 'ready' && !catalog?.items?.length && <div className="panel integration-status" role="status">No podcast shows are currently available from the configured feed.</div>}
    {status === 'ready' && catalog?.items?.map((show) => <article className="podcast-show panel" key={show.podcastId}>
      <div className="podcast-show-heading"><div className="podcast-show-art" aria-hidden="true"><Podcast size={28}/></div><div><span className="eyebrow">PUBLIC RSS · {show.publisher}</span><h2>{show.title}</h2><p>{show.description}</p><a href={show.websiteUrl} target="_blank" rel="noreferrer">Official show page <ExternalLink size={12}/></a></div></div>
      <div className="podcast-episode-heading"><h3>Episodes</h3><small>{show.episodes.length} recent episodes</small></div>
      <div className="podcast-episodes">{show.episodes.map((episode) => {
        const episodeTrackId = `podcast-${encodeURIComponent(episode.episodeId)}`;
        const selected = track?.kind === 'podcast' && track.trackId === episodeTrackId;
        const pubDate = episode.publishedAt ? new Date(episode.publishedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'Date unavailable';
        return <div className={`podcast-episode ${selected ? 'podcast-episode-selected' : ''}`} key={episode.episodeId}>
          <div className="podcast-episode-icon"><Headphones size={17}/></div><div className="podcast-episode-copy"><b>{episode.title}</b><small>{pubDate}{episode.durationSeconds ? ` · ${formatTrackDuration(episode.durationSeconds)}` : ''}</small>{episode.description && <p>{episode.description}</p>}</div>
          <button type="button" className={selected && playing ? 'btn-outline' : 'btn-primary'} aria-label={`${selected && playing ? 'Playing' : 'Play'} ${episode.title}`} onClick={() => playSong({ trackId: episodeTrackId, kind: 'podcast', title: episode.title, artist: show.publisher, durationSeconds: episode.durationSeconds, audioAssetUrl: episode.audioUrl, episodeUrl: episode.episodeUrl, podcastTitle: show.title }, true)}>{selected && playing ? 'Playing' : <><Play size={14} fill="currentColor"/>Play</>}</button>
          {episode.episodeUrl && <a className="podcast-episode-link" href={episode.episodeUrl} target="_blank" rel="noreferrer" aria-label={`Open ${episode.title} at NASA`}><ExternalLink size={15}/></a>}
        </div>;
      })}</div>
      <p className="podcast-source-note">Episode details and audio are served by the original NASA RSS source. AstraDJ does not host or modify the audio. <a href={show.feedUrl} target="_blank" rel="noreferrer">View RSS feed</a>.</p>
    </article>)}
  </section>;
}
