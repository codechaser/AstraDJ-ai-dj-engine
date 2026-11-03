import mongoose from 'mongoose';

const queueEventSchema = new mongoose.Schema({
  loungeId: { type: String, required: true, index: true },
  seq: { type: Number, required: true, min: 1 },
  type: { type: String, enum: ['track.added', 'track.voted', 'track.transitioned', 'segue.prepared', 'segue.cancelled', 'soundclash.submitted', 'soundclash.opened', 'soundclash.voted', 'soundclash.tied', 'soundclash.resolved', 'chat.message', 'lounge.session.ended'], required: true },
  actorUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required() {
      return !(this.type === 'soundclash.tied'
        || this.type === 'segue.prepared'
        || this.type === 'segue.cancelled'
        || (this.type === 'soundclash.opened' && this.payload?.openedBy === 'ai_dj')
        || (this.type === 'soundclash.resolved' && this.payload?.autoResolved === true));
    },
    default: null,
  },
  payload: { type: mongoose.Schema.Types.Mixed, required: true },
  createdAt: { type: Date, default: Date.now, required: true },
}, { versionKey: false });
queueEventSchema.index({ loungeId: 1, seq: 1 }, { unique: true });

export const QueueEvent = mongoose.model('QueueEvent', queueEventSchema);
