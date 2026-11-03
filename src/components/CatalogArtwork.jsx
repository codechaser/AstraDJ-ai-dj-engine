import React, { useEffect, useState } from 'react';
import { AudioLines } from 'lucide-react';
import { artistPortraitUrl, trackCoverUrl } from '../api/catalogData.js';

function ArtworkImage({ src, alt, className }) {
  const [failed, setFailed] = useState(!src);
  useEffect(() => setFailed(!src), [src]);
  if (failed) return <span className={`${className} artwork-placeholder`} role="img" aria-label={alt}><AudioLines size={20}/></span>;
  return <img
    className={`${className} artwork-image`}
    src={src ?? undefined}
    alt={alt}
    loading="lazy"
    onError={() => setFailed(true)}
  />;
}

export function TrackArtwork({ track, className = 'catalog-cover', alt }) {
  return <ArtworkImage src={trackCoverUrl(track)} alt={alt ?? `${track?.title ?? 'Track'} cover artwork`} className={className}/>;
}

export function ArtistArtwork({ artist, className = 'catalog-artist-art', alt }) {
  return <ArtworkImage src={artistPortraitUrl(artist)} alt={alt ?? `${artist} artist portrait`} className={className}/>;
}
