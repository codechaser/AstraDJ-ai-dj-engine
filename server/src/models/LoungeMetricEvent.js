import mongoose from 'mongoose';

const loungeMetricEventSchema = new mongoose.Schema({
  eventId: { type: String, required: true, unique: true, match: /^[a-f0-9-]{36}$/i },
  loungeId: { type: String, required: true, index: true },
  seq: { type: Number, required: true, min: 1 },
  type: { type: String, enum: ['participant.joined', 'participant.left', 'ai.question.asked'], required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  // Q&A text is intentionally not retained in analytics events.
  requestId: { type: String, default: null, maxlength: 128 },
  participantCount: { type: Number, min: 0, default: null },
  createdAt: { type: Date, required: true, default: Date.now },
}, { versionKey: false });

loungeMetricEventSchema.index({ loungeId: 1, seq: 1 }, { unique: true });
loungeMetricEventSchema.index({ loungeId: 1, userId: 1, requestId: 1 }, {
  unique: true, partialFilterExpression: { requestId: { $type: 'string' } },
});

export const LoungeMetricEvent = mongoose.model('LoungeMetricEvent', loungeMetricEventSchema);
