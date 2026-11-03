import mongoose from 'mongoose';

const billingAuditSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  actorUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  subscriptionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Subscription', default: null },
  idempotencyKey: { type: String, default: null },
  action: { type: String, required: true, enum: ['subscription.created', 'subscription.activated', 'subscription.cancel_scheduled', 'subscription.cancelled', 'subscription.expired', 'payment.failed', 'payment.refunded', 'plan.updated'] },
  source: { type: String, required: true, enum: ['user', 'razorpay', 'admin', 'system'] },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: { createdAt: true, updatedAt: false } });

billingAuditSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });

export const BillingAudit = mongoose.models.BillingAudit ?? mongoose.model('BillingAudit', billingAuditSchema);
