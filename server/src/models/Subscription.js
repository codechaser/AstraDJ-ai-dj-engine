import mongoose from 'mongoose';

const subscriptionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  planId: { type: String, enum: ['free', 'premium', 'pro'], required: true },
  status: { type: String, enum: ['creating', 'pending', 'active', 'past_due', 'paused', 'cancelled', 'expired', 'failed'], required: true, index: true },
  provider: { type: String, enum: ['none', 'razorpay'], required: true },
  providerSubscriptionId: { type: String },
  providerPlanId: { type: String, default: null, select: false },
  startDate: { type: Date, default: null },
  endDate: { type: Date, default: null },
  renewalDate: { type: Date, default: null },
  cancelAtPeriodEnd: { type: Boolean, default: false, required: true },
  requestKey: { type: String, default: null },
  lastProviderEventAt: { type: Date, default: null },
}, { timestamps: true });

subscriptionSchema.index({ userId: 1, requestKey: 1 }, { unique: true, partialFilterExpression: { requestKey: { $type: 'string' } } });
subscriptionSchema.index({ providerSubscriptionId: 1 }, { unique: true, sparse: true });
subscriptionSchema.index({ userId: 1, status: 1, renewalDate: -1 });
export const Subscription = mongoose.models.Subscription ?? mongoose.model('Subscription', subscriptionSchema);
