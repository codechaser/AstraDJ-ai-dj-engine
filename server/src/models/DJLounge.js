import mongoose from 'mongoose';

const activeParticipantLeaseSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  leaseId: { type: String, required: true },
  expiresAt: { type: Date, required: true },
}, { _id: false, versionKey: false });

const gatewayPresenceSchema = new mongoose.Schema({
  gatewayId: { type: String, required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  generation: { type: String, required: true },
  socketCount: { type: Number, required: true, min: 1 },
  heartbeatAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
}, { _id: false, versionKey: false });

const loungeSchema = new mongoose.Schema({
  loungeId: { type: String, required: true, unique: true, match: /^lg_[A-Za-z0-9_-]{8,64}$/ },
  inviteCode: { type: String, required: true, unique: true, uppercase: true, match: /^SP-[A-Z2-9]{4}$/ },
  hostUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  vibeProfile: { type: String, required: true, trim: true, maxlength: 100 },
  queue: { type: [String], default: [] },
  currentTrackId: { type: String, default: null },
  pendingSegue: {
    fromTrackId: { type: String, default: null },
    trackId: { type: String, default: null },
    createdAt: { type: Date, default: null },
    decision: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  soundclash: {
    active: { type: Boolean, default: false },
    candidates: { type: [String], default: [] },
    votes: { type: Map, of: String, default: () => new Map() },
  },
  status: { type: String, enum: ['scheduled', 'live', 'ended'], default: 'scheduled', required: true },
  // Per-process leases represent current distinct participants. Historical
  // participantIds remains the membership/privacy-history source.
  activeParticipantLeases: { type: [activeParticipantLeaseSchema], default: [] },
  // Authenticated live socket presence is separate from both historical
  // membership and capacity seats. Expired rows are ignored using MongoDB time.
  gatewayPresences: { type: [gatewayPresenceSchema], default: [] },
  participantIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  createdAt: { type: Date, default: Date.now },
  startedAt: { type: Date, default: null },
  endedAt: { type: Date, default: null },
  sessionSummary: { type: mongoose.Schema.Types.Mixed, default: null },
  // Version 1 means presence and AI question analytics have complete event coverage
  // from this Lounge's creation. Legacy documents remain explicitly unavailable.
  analyticsTrackingVersion: { type: Number, default: 0 },
  sessionEventSeq: { type: Number, default: 0, min: 0 },
  // Queue, segue, and Soundclash coordination are versioned and committed
  // together with their durable event intent in this single Mongo document.
  // The outbox is bounded by the coordinator and drained to QueueEvent.
  coordination: { type: mongoose.Schema.Types.Mixed, default: null },
  settings: {
    maxParticipants: { type: Number, required: true, min: 2, max: 50 },
    aiVerbosity: { type: String, enum: ['low', 'normal', 'high'], default: 'normal' },
    bpmTolerancePct: { type: Number, required: true, min: 0, max: 8 },
    soundclashEnabled: { type: Boolean, default: true },
  },
}, { versionKey: false });

export const DJLounge = mongoose.model('DJLounge', loungeSchema);
