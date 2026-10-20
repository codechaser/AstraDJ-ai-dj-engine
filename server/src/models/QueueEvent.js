import mongoose from 'mongoose';

const queueEventSchema = new mongoose.Schema({
  loungeId: { type: String, required: true, index: true },
  seq: { type: Number, required: true, min: 1 },
  type: { type: String, enum: ['track.added', 'track.voted'], required: true },
  actorUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  payload: { type: mongoose.Schema.Types.Mixed, required: true },
  createdAt: { type: Date, default: Date.now, required: true },
}, { versionKey: false });
queueEventSchema.index({ loungeId: 1, seq: 1 }, { unique: true });

export const QueueEvent = mongoose.model('QueueEvent', queueEventSchema);
