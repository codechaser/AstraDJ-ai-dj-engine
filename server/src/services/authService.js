import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';
import { User } from '../models/User.js';
import { RefreshToken } from '../models/RefreshToken.js';
import { ApiError } from '../utils/ApiError.js';

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

function issueAccessToken(user) {
  return jwt.sign({ role: user.role }, config.jwtAccessSecret, {
    subject: user.id,
    issuer: 'astradj-api',
    audience: 'astradj-client',
    algorithm: 'HS256',
    expiresIn: config.accessTtlSeconds,
  });
}

async function createRefreshToken(userId) {
  const raw = crypto.randomBytes(48).toString('base64url');
  const expiresAt = new Date(Date.now() + config.refreshTtlDays * 86400000);
  await RefreshToken.create({ userId, tokenHash: hashToken(raw), expiresAt });
  return raw;
}

function authResult(user, refreshToken) {
  return {
    user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role },
    accessToken: issueAccessToken(user),
    refreshToken,
    expiresIn: config.accessTtlSeconds,
  };
}

export async function registerAccount({ email, displayName, password }) {
  const passwordHash = await bcrypt.hash(password, 12);
  let user;
  try {
    // Public registration can only create Listeners; role elevation is privileged provisioning.
    user = await User.create({ email, displayName, passwordHash, role: 'Listener' });
  } catch (err) {
    if (err.code === 11000) throw new ApiError(409, 'EMAIL_IN_USE', 'An account with this email already exists');
    throw err;
  }
  return authResult(user, await createRefreshToken(user.id));
}

export async function loginAccount({ email, password }) {
  const user = await User.findOne({ email: email.toLowerCase() }).select('+passwordHash');
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
  }
  return authResult(user, await createRefreshToken(user.id));
}

export async function rotateRefreshToken(raw) {
  if (!raw) throw new ApiError(401, 'INVALID_REFRESH_TOKEN', 'A refresh token is required');
  const record = await RefreshToken.findOne({ tokenHash: hashToken(raw), revokedAt: null, expiresAt: { $gt: new Date() } });
  if (!record) throw new ApiError(401, 'INVALID_REFRESH_TOKEN', 'The refresh token is invalid or expired');
  const consumed = await RefreshToken.findOneAndUpdate({ _id: record.id, revokedAt: null }, { $set: { revokedAt: new Date() } }, { new: true });
  if (!consumed) throw new ApiError(401, 'INVALID_REFRESH_TOKEN', 'The refresh token has already been used');
  const user = await User.findById(record.userId);
  if (!user) throw new ApiError(401, 'INVALID_REFRESH_TOKEN', 'The account for this token no longer exists');
  return authResult(user, await createRefreshToken(user.id));
}

export async function revokeRefreshToken(raw) {
  if (raw) await RefreshToken.updateOne({ tokenHash: hashToken(raw), revokedAt: null }, { $set: { revokedAt: new Date() } });
}
