import mongoose from 'mongoose';

const planSchema = new mongoose.Schema({
  planId: { type: String, required: true, unique: true, immutable: true, match: /^(free|premium|pro)$/ },
  name: { type: String, required: true, trim: true, maxlength: 40 },
  price: { type: Number, required: true, min: 0, max: 100000 },
  billingInterval: { type: String, enum: ['month'], required: true },
  currency: { type: String, enum: ['INR'], required: true, uppercase: true },
  features: { type: mongoose.Schema.Types.Mixed, required: true },
  implementedFeatures: { type: [String], default: [] },
  usageLimits: { type: mongoose.Schema.Types.Mixed, required: true },
  isActive: { type: Boolean, default: true, required: true },
  providerPlanId: { type: String, default: null, select: false },
}, { timestamps: true });

planSchema.index({ isActive: 1, price: 1 });
export const Plan = mongoose.models.Plan ?? mongoose.model('Plan', planSchema);
