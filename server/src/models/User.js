import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, trim: true, lowercase: true, unique: true, maxlength: 254, index: true },
  displayName: { type: String, required: true, trim: true, minlength: 1, maxlength: 60 },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: ['Listener', 'Co-DJ', 'Host', 'Admin'], default: 'Listener', required: true },
  preferences: {
    genreAffinity: { type: [String], default: [] },
    audio: {
      streamingQuality: { type: String, enum: ['High (320 kbps)', 'Normal (160 kbps)', 'Low (96 kbps)'], default: 'High (320 kbps)' },
      crossfadeSeconds: { type: Number, enum: [0, 6, 12], default: 6 },
      normalizeVolume: { type: Boolean, default: true },
      showLyrics: { type: Boolean, default: true },
      aiDjCommentary: { type: Boolean, default: true },
      downloadQuality: { type: String, enum: ['High', 'Normal'], default: 'High' },
      autoPlay: { type: Boolean, default: true },
    },
  },
}, { timestamps: { createdAt: true, updatedAt: false } });

export const User = mongoose.model('User', userSchema);
