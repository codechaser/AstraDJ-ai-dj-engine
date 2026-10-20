import { User } from '../models/User.js';
import { RefreshToken } from '../models/RefreshToken.js';
import { ApiError } from '../utils/ApiError.js';

export async function getProfile(req, res) {
  const user = await User.findById(req.user.id).select('email displayName role createdAt');
  if (!user) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found');
  const sessions = await RefreshToken.countDocuments({ userId: user.id, revokedAt: null, expiresAt: { $gt: new Date() } });
  res.json({ user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role, createdAt: user.createdAt }, activeRefreshSessions: sessions });
}
