import mongoose from 'mongoose';

const interactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  trackId: { type: String, required: true, trim: true, match: /^t_[A-Za-z0-9_-]{1,64}$/ },
  playedSeconds: { type: Number, required: true, min: 0 },
  completed: { type: Boolean, required: true },
  liked: { type: Boolean, required: true },
  loungeId: { type: String, default: null, match: /^lg_[A-Za-z0-9_-]{8,64}$/ },
  coListenedWith: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  source: { type: String, enum: ['self_reported'], default: 'self_reported', required: true },
  createdAt: { type: Date, default: Date.now, required: true },
}, { versionKey: false });

interactionSchema.index({ userId: 1, trackId: 1, createdAt: -1 });
interactionSchema.index({ loungeId: 1, trackId: 1, createdAt: -1 });

export const Interaction = mongoose.model('Interaction', interactionSchema);
