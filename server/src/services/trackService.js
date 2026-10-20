import { Track } from '../models/Track.js';
import { ApiError } from '../utils/ApiError.js';

export async function listTracks({ q, limit = 20, skip = 0 }) {
  const filter = q ? { $or: [{ title: new RegExp(escapeRegex(q), 'i') }, { artist: new RegExp(escapeRegex(q), 'i') }] } : {};
  const [items, total] = await Promise.all([
    Track.find(filter).sort({ title: 1 }).skip(skip).limit(limit).select('-_id -__v -createdAt -updatedAt').lean(),
    Track.countDocuments(filter),
  ]);
  return { items, page: { limit, skip, total } };
}

export async function getAcousticProfile(trackId) {
  const track = await Track.findOne({ trackId }).select('-_id trackId title artist acoustic timeline').lean();
  if (!track) throw new ApiError(404, 'TRACK_NOT_FOUND', 'Track not found');
  return track;
}

export async function createTrack(profile) {
  try {
    const track = await Track.create(profile);
    return Track.findById(track.id).select('-_id trackId title artist durationSeconds audioAssetUrl acoustic timeline').lean();
  } catch (err) {
    if (err.code === 11000) throw new ApiError(409, 'TRACK_ID_IN_USE', 'A track with this trackId already exists');
    throw err;
  }
}

function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
