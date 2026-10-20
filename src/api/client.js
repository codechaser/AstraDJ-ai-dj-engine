const API_BASE = (import.meta.env?.VITE_API_BASE_URL || '/api/v1').replace(/\/$/, '');
let accessToken = null;
let refreshPromise = null;

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function toError(response, payload) {
  const error = payload?.error ?? {};
  return new ApiError(response.status, error.code ?? 'REQUEST_FAILED', error.message ?? 'The request could not be completed', error.details);
}

async function rawRequest(path, { token = accessToken, ...options } = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: 'include',
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  if (response.status === 204) return null;
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw toError(response, payload);
  return payload;
}

async function refreshAccessToken() {
  if (!refreshPromise) {
    refreshPromise = rawRequest('/auth/refresh', { method: 'POST', token: null })
      .then((result) => { accessToken = result.accessToken; return accessToken; })
      .catch((error) => { accessToken = null; throw error; })
      .finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

export async function apiRequest(path, options = {}) {
  try {
    return await rawRequest(path, options);
  } catch (error) {
    const publicAuthRequest = path === '/auth/login' || path === '/auth/register' || path === '/auth/refresh';
    if (error.status !== 401 || publicAuthRequest || options.retryAuth === false) throw error;
    await refreshAccessToken();
    return rawRequest(path, options);
  }
}

export const getAccessToken = () => accessToken;
export const clearAccessToken = () => { accessToken = null; };

export async function login(credentials) {
  const result = await apiRequest('/auth/login', { method: 'POST', token: null, body: JSON.stringify(credentials) });
  accessToken = result.accessToken;
  return result.user;
}

export async function registerAccount(account) {
  const result = await apiRequest('/auth/register', { method: 'POST', token: null, body: JSON.stringify(account) });
  accessToken = result.accessToken;
  return result.user;
}

export async function restoreSession() {
  try {
    await refreshAccessToken();
    const result = await apiRequest('/auth/me');
    return result.user;
  } catch {
    accessToken = null;
    return null;
  }
}

export async function logout() {
  try { await apiRequest('/auth/logout', { method: 'POST', retryAuth: false }); }
  finally { accessToken = null; }
}

export async function searchTracks(query, signal) {
  const params = new URLSearchParams({ limit: '50' });
  if (query.trim()) params.set('q', query.trim());
  return apiRequest(`/tracks?${params}`, { token: null, signal });
}

export async function getTrack(trackId) {
  return apiRequest(`/tracks/${encodeURIComponent(trackId)}/acoustic-profile`, { token: null });
}

export async function getPlaybackHistory(limit = 20) {
  return apiRequest(`/dashboard/playback-history?limit=${limit}`);
}

export function getSocketOrigin() {
  const configured = import.meta.env?.VITE_API_BASE_URL;
  if (!configured) return window.location.origin;
  return new URL(configured, window.location.origin).origin;
}
