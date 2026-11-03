import mongoose from 'mongoose';

const billingWebhookEventSchema = new mongoose.Schema({
  providerEventId: { type: String, required: true, unique: true },
  eventType: { type: String, required: true, maxlength: 80 },
  payloadSha256: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  processedAt: { type: Date, required: true },
}, { timestamps: { createdAt: true, updatedAt: false } });

export const BillingWebhookEvent = mongoose.models.BillingWebhookEvent ?? mongoose.model('BillingWebhookEvent', billingWebhookEventSchema);
