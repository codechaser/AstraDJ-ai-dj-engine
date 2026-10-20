import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, trim: true, lowercase: true, unique: true, maxlength: 254, index: true },
  displayName: { type: String, required: true, trim: true, minlength: 1, maxlength: 60 },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: ['Listener', 'Co-DJ', 'Host', 'Admin'], default: 'Listener', required: true },
  preferences: { genreAffinity: { type: [String], default: [] } },
}, { timestamps: { createdAt: true, updatedAt: false } });

export const User = mongoose.model('User', userSchema);
