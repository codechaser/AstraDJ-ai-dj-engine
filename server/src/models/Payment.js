import mongoose from 'mongoose';

const paymentSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  subscriptionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Subscription', required: true, index: true },
  provider: { type: String, enum: ['razorpay'], required: true },
  providerPaymentId: { type: String },
  providerOrderId: { type: String },
  amount: { type: Number, required: true, min: 0 }, // paise
  currency: { type: String, enum: ['INR'], required: true },
  status: { type: String, enum: ['created', 'authorized', 'captured', 'failed', 'refunded'], required: true },
  receipt: { type: String, maxlength: 80, default: null },
}, { timestamps: { createdAt: true, updatedAt: true } });

paymentSchema.index({ providerPaymentId: 1 }, { unique: true, sparse: true });
paymentSchema.index({ userId: 1, createdAt: -1 });
export const Payment = mongoose.models.Payment ?? mongoose.model('Payment', paymentSchema);
