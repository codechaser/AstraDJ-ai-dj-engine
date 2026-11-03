import { createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError } from '../utils/ApiError.js';

export function createRazorpayProvider({ env = process.env, fetchImpl = fetch } = {}) {
  const credentialsAvailable = () => {
    if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) return false;
    const mode = env.RAZORPAY_MODE ?? 'test';
    if (mode === 'test') return env.RAZORPAY_KEY_ID.startsWith('rzp_test_');
    return mode === 'live' && env.NODE_ENV === 'production' && env.RAZORPAY_KEY_ID.startsWith('rzp_live_');
  };
  function assertConfigured() {
    if (!credentialsAvailable()) throw new ApiError(503, 'PAYMENT_PROVIDER_UNAVAILABLE', 'Razorpay is not configured for this environment');
  }
  async function call(path, { method = 'GET', body } = {}) {
    assertConfigured();
    const authorization = Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64');
    let response;
    try {
      response = await fetchImpl(`https://api.razorpay.com/v1${path}`, {
        method,
        headers: { Authorization: `Basic ${authorization}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      throw new ApiError(502, 'PAYMENT_PROVIDER_ERROR', 'Razorpay could not be reached');
    }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(502, 'PAYMENT_PROVIDER_ERROR', 'Razorpay rejected the billing request');
    return result;
  }
  return {
    get configured() { return credentialsAvailable(); },
    get checkoutEnabled() { return credentialsAvailable() && env.RAZORPAY_CHECKOUT_ENABLED === 'true'; },
    get mode() { return env.RAZORPAY_MODE === 'live' && env.NODE_ENV === 'production' ? 'razorpay-live' : 'razorpay-test'; },
    get keyId() { return env.RAZORPAY_KEY_ID ?? null; },
    planIdFor(planId) { return planId === 'premium' ? env.RAZORPAY_PLAN_PREMIUM_ID ?? null : planId === 'pro' ? env.RAZORPAY_PLAN_PRO_ID ?? null : null; },
    createSubscription: (input) => call('/subscriptions', { method: 'POST', body: input }),
    getPlan: (providerId) => call(`/plans/${encodeURIComponent(providerId)}`),
    getSubscription: (providerId) => call(`/subscriptions/${encodeURIComponent(providerId)}`),
    getPayment: (providerId) => call(`/payments/${encodeURIComponent(providerId)}`),
    cancelSubscription: (providerId, cancelAtCycleEnd) => call(`/subscriptions/${encodeURIComponent(providerId)}/cancel`, { method: 'POST', body: { cancel_at_cycle_end: cancelAtCycleEnd ? 1 : 0 } }),
    verifyCheckoutSignature({ paymentId, subscriptionId, signature }) {
      if (!credentialsAvailable() || !/^[a-f0-9]{64}$/i.test(signature ?? '')) return false;
      const expected = createHmac('sha256', env.RAZORPAY_KEY_SECRET).update(`${paymentId}|${subscriptionId}`).digest();
      const supplied = Buffer.from(signature, 'hex');
      return supplied.length === expected.length && timingSafeEqual(supplied, expected);
    },
    verifyWebhookSignature(rawBody, signature) {
      if (!env.RAZORPAY_WEBHOOK_SECRET || !/^[a-f0-9]{64}$/i.test(signature ?? '')) return false;
      const expected = createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest();
      const supplied = Buffer.from(signature, 'hex');
      return supplied.length === expected.length && timingSafeEqual(supplied, expected);
    },
  };
}

export const razorpayProvider = createRazorpayProvider();
