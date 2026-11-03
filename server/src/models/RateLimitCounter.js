import mongoose from 'mongoose';

const rateLimitCounterSchema = new mongoose.Schema({
  key: { type: String, required: true },
  windowStart: { type: Date, required: true },
  count: { type: Number, required: true, min: 0 },
  expiresAt: { type: Date, required: true },
}, { versionKey: false });

rateLimitCounterSchema.index({ key: 1, windowStart: 1 }, { unique: true });
rateLimitCounterSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RateLimitCounter = mongoose.model('RateLimitCounter', rateLimitCounterSchema);
