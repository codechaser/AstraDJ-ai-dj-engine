import 'dotenv/config';

const ttl = Number.parseInt(process.env.JWT_ACCESS_TTL_SECONDS ?? '900', 10);
if (!Number.isInteger(ttl) || ttl < 1 || ttl > 3600) {
  throw new Error('JWT_ACCESS_TTL_SECONDS must be an integer between 1 and 3600');
}
const clientOriginValue = process.env.CLIENT_ORIGIN?.trim() || null;
let clientOrigin = null;
if (clientOriginValue) {
  let parsedOrigin;
  try { parsedOrigin = new URL(clientOriginValue); } catch { throw new Error('CLIENT_ORIGIN must be a valid HTTP(S) origin'); }
  if (!['http:', 'https:'].includes(parsedOrigin.protocol) || parsedOrigin.origin !== clientOriginValue.replace(/\/$/, '')) {
    throw new Error('CLIENT_ORIGIN must contain only an HTTP(S) origin, without a path, query, or fragment');
  }
  clientOrigin = parsedOrigin.origin;
}

export const config = {
  port: Number.parseInt(process.env.PORT ?? '4000', 10),
  mongoUri: process.env.MONGODB_URI,
  jwtAccessSecret: process.env.JWT_ACCESS_SECRET,
  accessTtlSeconds: ttl,
  refreshTtlDays: Number.parseInt(process.env.JWT_REFRESH_TTL_DAYS ?? '7', 10),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  clientOrigin,
  get cookieSecure() { return this.nodeEnv === 'production'; },
};

export function assertRuntimeConfig() {
  if (!config.mongoUri) throw new Error('MONGODB_URI is required');
  if (!config.jwtAccessSecret || config.jwtAccessSecret.length < 32) {
    throw new Error('JWT_ACCESS_SECRET must contain at least 32 characters');
  }
  if (!Number.isInteger(config.refreshTtlDays) || config.refreshTtlDays < 1 || config.refreshTtlDays > 30) {
    throw new Error('JWT_REFRESH_TTL_DAYS must be between 1 and 30');
  }
}
