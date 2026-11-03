import 'dotenv/config';

const ttl = Number.parseInt(process.env.JWT_ACCESS_TTL_SECONDS ?? '900', 10);
if (!Number.isInteger(ttl) || ttl < 1 || ttl > 3600) {
  throw new Error('JWT_ACCESS_TTL_SECONDS must be an integer between 1 and 3600');
}
const clientOriginValue = process.env.CLIENT_ORIGIN?.trim() || null;
const segueOutroWindowSeconds = Number.parseInt(process.env.AI_DJ_OUTRO_WINDOW_SECONDS ?? '12', 10);
if (!Number.isInteger(segueOutroWindowSeconds) || segueOutroWindowSeconds < 3 || segueOutroWindowSeconds > 60) {
  throw new Error('AI_DJ_OUTRO_WINDOW_SECONDS must be an integer between 3 and 60');
}
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
  segueOutroWindowSeconds,
  razorpayKeyId: process.env.RAZORPAY_KEY_ID ?? null,
  razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET ?? null,
  razorpayWebhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET ?? null,
  razorpayPlanPremiumId: process.env.RAZORPAY_PLAN_PREMIUM_ID ?? null,
  razorpayPlanProId: process.env.RAZORPAY_PLAN_PRO_ID ?? null,
  get cookieSecure() { return this.nodeEnv === 'production'; },
};

export function assertRuntimeConfig(runtime = config) {
  if (runtime.nodeEnv === 'production') {
    if (!runtime.clientOrigin) throw new Error('CLIENT_ORIGIN is required in production');
    if (!runtime.clientOrigin.startsWith('https://')) throw new Error('CLIENT_ORIGIN must use HTTPS in production');
  }
  if (!runtime.mongoUri) throw new Error('MONGODB_URI is required');
  if (!runtime.jwtAccessSecret || runtime.jwtAccessSecret.length < 32) {
    throw new Error('JWT_ACCESS_SECRET must contain at least 32 characters');
  }
  if (!Number.isInteger(runtime.refreshTtlDays) || runtime.refreshTtlDays < 1 || runtime.refreshTtlDays > 30) {
    throw new Error('JWT_REFRESH_TTL_DAYS must be between 1 and 30');
  }
}
