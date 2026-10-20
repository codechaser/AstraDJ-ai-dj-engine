const localAudioPath = /^\/audio\/[A-Za-z0-9][A-Za-z0-9_-]*\.(?:mp3|ogg|wav|m4a|aac|flac)$/i;
const supportedExtension = /\.(?:mp3|ogg|wav|m4a|aac|flac)$/i;

export function isSafeAudioAssetUrl(value) {
  if (value == null) return true;
  if (typeof value !== 'string' || value.length > 500 || value.trim() !== value) return false;
  if (localAudioPath.test(value)) return true;
  if (value.includes('..')) return false;

  let parsed;
  try { parsed = new URL(value); } catch { return false; }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || !supportedExtension.test(parsed.pathname)) return false;
  const allowedHosts = (process.env.AUDIO_ASSET_ALLOWED_HOSTS ?? '')
    .split(',').map((host) => host.trim().toLowerCase()).filter(Boolean);
  return allowedHosts.includes(parsed.hostname.toLowerCase()) && !parsed.port;
}
