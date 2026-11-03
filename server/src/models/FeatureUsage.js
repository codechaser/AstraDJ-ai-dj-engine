import mongoose from 'mongoose';

const featureUsageSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  feature: { type: String, required: true, enum: ['aiDjRequests'] },
  periodKey: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  count: { type: Number, required: true, min: 0, default: 0 },
}, { timestamps: true });

featureUsageSchema.index({ userId: 1, feature: 1, periodKey: 1 }, { unique: true });
export const FeatureUsage = mongoose.models.FeatureUsage ?? mongoose.model('FeatureUsage', featureUsageSchema);
