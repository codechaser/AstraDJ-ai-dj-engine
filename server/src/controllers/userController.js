import { User } from '../models/User.js';
import { RefreshToken } from '../models/RefreshToken.js';
import { ApiError } from '../utils/ApiError.js';

const audioPreferenceRules = Object.freeze({
  streamingQuality: (value) => ['High (320 kbps)', 'Normal (160 kbps)', 'Low (96 kbps)'].includes(value),
  crossfadeSeconds: (value) => Number.isInteger(value) && [0, 6, 12].includes(value),
  normalizeVolume: (value) => typeof value === 'boolean',
  showLyrics: (value) => typeof value === 'boolean',
  aiDjCommentary: (value) => typeof value === 'boolean',
  downloadQuality: (value) => ['High', 'Normal'].includes(value),
  autoPlay: (value) => typeof value === 'boolean',
});

const defaultAudioPreferences = Object.freeze({
  streamingQuality: 'High (320 kbps)',
  crossfadeSeconds: 6,
  normalizeVolume: true,
  showLyrics: true,
  aiDjCommentary: true,
  downloadQuality: 'High',
  autoPlay: true,
});

function audioPreferences(user) {
  return { ...defaultAudioPreferences, ...(user.preferences?.audio?.toObject?.() ?? user.preferences?.audio ?? {}) };
}

function rejectPreferences(message) {
  throw new ApiError(400, 'INVALID_PREFERENCES', message);
}

export async function getProfile(req, res) {
  const user = await User.findById(req.user.id).select('email displayName role createdAt');
  if (!user) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found');
  const sessions = await RefreshToken.countDocuments({ userId: user.id, revokedAt: null, expiresAt: { $gt: new Date() } });
  res.json({ user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role, createdAt: user.createdAt }, activeRefreshSessions: sessions });
}

export async function getPreferences(req, res) {
  const user = await User.findById(req.user.id).select('preferences');
  if (!user) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found');
  res.json({ preferences: { audio: audioPreferences(user) } });
}

export async function updatePreferences(req, res) {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => key !== 'audio')) {
    rejectPreferences('Only supported audio preferences may be updated');
  }
  const audio = body.audio;
  if (!audio || typeof audio !== 'object' || Array.isArray(audio) || Object.keys(audio).length === 0) {
    rejectPreferences('Provide at least one supported audio preference');
  }

  const updates = {};
  for (const [key, value] of Object.entries(audio)) {
    if (!Object.hasOwn(audioPreferenceRules, key)) rejectPreferences(`Unsupported audio preference: ${key}`);
    if (!audioPreferenceRules[key](value)) rejectPreferences(`Invalid value for audio preference: ${key}`);
    updates[`preferences.audio.${key}`] = value;
  }

  const user = await User.findByIdAndUpdate(req.user.id, { $set: updates }, { new: true, runValidators: true }).select('preferences');
  if (!user) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found');
  res.json({ preferences: { audio: audioPreferences(user) } });
}
