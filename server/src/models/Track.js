import mongoose from 'mongoose';
import { isSafeAudioAssetUrl } from '../utils/audioAsset.js';

export const CAMELOT_KEYS = Object.freeze(['1A','1B','2A','2B','3A','3B','4A','4B','5A','5B','6A','6B','7A','7B','8A','8B','9A','9B','10A','10B','11A','11B','12A','12B']);
const timelineEntry = new mongoose.Schema({
  ts: { type: Number, required: true, min: 0 },
  type: { type: String, enum: ['sample_credit', 'trivia', 'glossary'], required: true },
  text: { type: String, required: true, trim: true, maxlength: 500 },
}, { _id: false });
const acousticProfile = new mongoose.Schema({
  bpm: { type: Number, required: true, min: 1, max: 300 },
  camelotKey: { type: String, required: true, enum: CAMELOT_KEYS },
  energy: { type: Number, required: true, min: 0, max: 1 },
  valence: { type: Number, required: true, min: 0, max: 1 },
}, { _id: false });
const trackSchema = new mongoose.Schema({
  trackId: { type: String, required: true, unique: true, trim: true, match: /^t_[A-Za-z0-9_-]{1,64}$/ },
  title: { type: String, required: true, trim: true, maxlength: 120 },
  artist: { type: String, required: true, trim: true, maxlength: 120 },
  durationSeconds: { type: Number, required: true, min: 1 },
  audioAssetUrl: { type: String, default: null, maxlength: 500, validate: { validator: isSafeAudioAssetUrl, message: 'audioAssetUrl must be a local /audio asset or HTTPS URL from an allow-listed host' } },
  // Some licensed demo recordings have no verified acoustic analysis yet.
  // Match/recommendation services already reject missing profiles explicitly.
  acoustic: { type: acousticProfile, default: null },
  timeline: { type: [timelineEntry], default: [] },
}, { timestamps: true });
trackSchema.index({ 'acoustic.bpm': 1, 'acoustic.camelotKey': 1 });
export const Track = mongoose.model('Track', trackSchema);
