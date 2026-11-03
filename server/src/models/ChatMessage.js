import mongoose from 'mongoose';

const chatMessageSchema = new mongoose.Schema({
  messageId: { type: String, required: true, unique: true, match: /^[a-f0-9-]{36}$/i },
  clientMessageId: { type: String, match: /^[a-f0-9-]{36}$/i },
  loungeId: { type: String, required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  msgType: { type: String, enum: ['chat'], default: 'chat', required: true },
  body: { type: String, required: true, trim: true, maxlength: 500 },
  sentimentBucket: { type: String, enum: ['positive', 'neutral', 'negative'], required: true },
  sentimentScore: { type: Number, required: true, min: 0, max: 1 },
  tsSeconds: { type: Number, required: true, min: 0 },
  createdAt: { type: Date, required: true, default: Date.now },
  deliveryEventSeq: { type: Number, min: 1 },
}, { versionKey: false });

chatMessageSchema.index({ loungeId: 1, createdAt: -1 });
chatMessageSchema.index({ loungeId: 1, deliveryEventSeq: 1, createdAt: 1, messageId: 1 });
chatMessageSchema.index(
  { loungeId: 1, userId: 1, clientMessageId: 1 },
  { unique: true, partialFilterExpression: { clientMessageId: { $type: 'string' } } },
);
export const ChatMessage = mongoose.model('ChatMessage', chatMessageSchema);
