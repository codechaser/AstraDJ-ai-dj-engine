import { registerAccount, loginAccount, rotateRefreshToken, revokeRefreshToken } from '../services/authService.js';
import { config } from '../config/env.js';

const COOKIE_NAME = 'astradj_refresh';
const COOKIE_PATH = '/api/v1/auth';
function cookieOptions() {
  return { httpOnly: true, secure: config.cookieSecure, sameSite: 'strict', path: COOKIE_PATH, maxAge: config.refreshTtlDays * 86400000 };
}
function sendAuthResult(res, result, status = 200) {
  res.cookie(COOKIE_NAME, result.refreshToken, cookieOptions());
  const { refreshToken: _refreshToken, ...body } = result;
  res.status(status).json(body);
}

export async function register(req, res) {
  sendAuthResult(res, await registerAccount(req.body), 201);
}

export async function login(req, res) {
  sendAuthResult(res, await loginAccount(req.body));
}

export async function refresh(req, res) {
  sendAuthResult(res, await rotateRefreshToken(req.cookies[COOKIE_NAME]));
}

export async function logout(req, res) {
  await revokeRefreshToken(req.cookies[COOKIE_NAME]);
  res.clearCookie(COOKIE_NAME, { ...cookieOptions(), maxAge: undefined });
  res.status(204).end();
}
