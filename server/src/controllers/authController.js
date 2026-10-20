import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';
import { User } from '../models/User.js';
import { RefreshToken } from '../models/RefreshToken.js';
import { ApiError } from '../utils/ApiError.js';

const COOKIE_NAME = 'astradj_refresh';
const COOKIE_PATH = '/api/v1/auth';
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

function cookieOptions() {
  return { httpOnly: true, secure: config.cookieSecure, sameSite: 'strict', path: COOKIE_PATH, maxAge: config.refreshTtlDays * 86400000 };
}

function issueAccessToken(user) {
  return jwt.sign({ role: user.role }, config.jwtAccessSecret, {
    subject: user.id,
    issuer: 'astradj-api',
    audience: 'astradj-client',
    algorithm: 'HS256',
    expiresIn: config.accessTtlSeconds,
  });
}

async function createRefreshToken(userId, res) {
  const raw = crypto.randomBytes(48).toString('base64url');
  const expiresAt = new Date(Date.now() + config.refreshTtlDays * 86400000);
  await RefreshToken.create({ userId, tokenHash: hashToken(raw), expiresAt });
  res.cookie(COOKIE_NAME, raw, cookieOptions());
}

export async function register(req, res) {
  const { email, displayName, password } = req.body;
  const passwordHash = await bcrypt.hash(password, 12);
  let user;
  try {
    // Role is intentionally not accepted from the request. New accounts are always Listeners.
    user = await User.create({ email, displayName, passwordHash, role: 'Listener' });
  } catch (err) {
    if (err.code === 11000) throw new ApiError(409, 'EMAIL_IN_USE', 'An account with this email already exists');
    throw err;
  }
  const accessToken = issueAccessToken(user);
  await createRefreshToken(user.id, res);
  res.status(201).json({ user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role }, accessToken, expiresIn: config.accessTtlSeconds });
}

export async function login(req, res) {
  const { email, password } = req.body;
  const user = await User.findOne({ email: email.toLowerCase() }).select('+passwordHash');
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
  }
  const accessToken = issueAccessToken(user);
  await createRefreshToken(user.id, res);
  res.json({ user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role }, accessToken, expiresIn: config.accessTtlSeconds });
}

export async function refresh(req, res) {
  const raw = req.cookies[COOKIE_NAME];
  if (!raw) throw new ApiError(401, 'INVALID_REFRESH_TOKEN', 'A refresh token is required');
  const record = await RefreshToken.findOne({ tokenHash: hashToken(raw), revokedAt: null, expiresAt: { $gt: new Date() } });
  if (!record) throw new ApiError(401, 'INVALID_REFRESH_TOKEN', 'The refresh token is invalid or expired');
  const consumed = await RefreshToken.findOneAndUpdate({ _id: record.id, revokedAt: null }, { $set: { revokedAt: new Date() } }, { new: true });
  if (!consumed) throw new ApiError(401, 'INVALID_REFRESH_TOKEN', 'The refresh token has already been used');
  const user = await User.findById(record.userId);
  if (!user) throw new ApiError(401, 'INVALID_REFRESH_TOKEN', 'The account for this token no longer exists');
  const accessToken = issueAccessToken(user);
  await createRefreshToken(user.id, res);
  res.json({ user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role }, accessToken, expiresIn: config.accessTtlSeconds });
}

export async function logout(req, res) {
  const raw = req.cookies[COOKIE_NAME];
  if (raw) await RefreshToken.updateOne({ tokenHash: hashToken(raw), revokedAt: null }, { $set: { revokedAt: new Date() } });
  res.clearCookie(COOKIE_NAME, { ...cookieOptions(), maxAge: undefined });
  res.status(204).end();
}

export const authCookie = { name: COOKIE_NAME, path: COOKIE_PATH };
