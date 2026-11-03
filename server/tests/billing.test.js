import { createHmac } from 'node:crypto';
import { jest } from '@jest/globals';
import { subscriptionPlanDefinitions } from '../src/config/subscriptionPlans.js';
import { createEntitlementService } from '../src/services/entitlementService.js';
import { createBillingService } from '../src/services/billingService.js';
import { createRazorpayProvider } from '../src/services/razorpayProvider.js';

function query(value) { return { lean: async () => value, sort() { return this; } }; }

test('central plan configuration has INR monthly prices and bounded AI DJ quotas', () => {
  expect(subscriptionPlanDefinitions.map(({ planId, price, currency, billingInterval }) => ({ planId, price, currency, billingInterval }))).toEqual([
    { planId: 'free', price: 0, currency: 'INR', billingInterval: 'month' },
    { planId: 'premium', price: 149, currency: 'INR', billingInterval: 'month' },
    { planId: 'pro', price: 299, currency: 'INR', billingInterval: 'month' },
  ]);
  expect(subscriptionPlanDefinitions.every(({ usageLimits }) => Number.isInteger(usageLimits.aiDjRequestsPerDay) && usageLimits.aiDjRequestsPerDay > 0)).toBe(true);
});

test('expired paid subscriptions resolve to Free and are marked expired', async () => {
  const updateOne = jest.fn().mockResolvedValue({ modifiedCount: 1 });
  const auditUpdate = jest.fn().mockResolvedValue({ upsertedCount: 0 });
  const service = createEntitlementService({
    subscriptionModel: { findOne: () => query({ _id: 'sub-1', planId: 'premium', status: 'active', renewalDate: new Date('2026-01-01') }), updateOne },
    planModel: { findOne: () => query(subscriptionPlanDefinitions[0]) },
    auditModel: { updateOne: auditUpdate },
    now: () => new Date('2026-02-01'),
  });
  await expect(service.current('user-1')).resolves.toMatchObject({ planId: 'free', status: 'free' });
  expect(updateOne).toHaveBeenCalledWith({ _id: 'sub-1', status: 'active' }, { $set: { status: 'expired' } });
  expect(auditUpdate).toHaveBeenCalled();
});

test('AI DJ request quotas are enforced atomically per user and UTC day', async () => {
  let count = 0;
  const usageModel = {
    findOneAndUpdate: (filter, _update, options) => ({ lean: async () => {
      if (options.upsert && count >= 1) { const error = new Error('duplicate key'); error.code = 11000; throw error; }
      if (count >= filter.count.$lt) return null;
      count += 1;
      return { count };
    } }),
    findOne: () => query({ count }),
  };
  const service = createEntitlementService({
    subscriptionModel: { findOne: () => query(null) },
    planModel: { findOne: () => query(subscriptionPlanDefinitions[0]) },
    usageModel,
    now: () => new Date('2026-11-03T05:00:00.000Z'),
  });
  await expect(service.consumeAiDjRequest('user-1')).resolves.toMatchObject({ used: 1, limit: 100, planId: 'free' });
  // Set the plan's effective configured limit to one for the deterministic boundary test.
  const limited = createEntitlementService({
    subscriptionModel: { findOne: () => query(null) },
    planModel: { findOne: () => query({ ...subscriptionPlanDefinitions[0], usageLimits: { aiDjRequestsPerDay: 1 } }) },
    usageModel,
    now: () => new Date('2026-11-03T05:00:00.000Z'),
  });
  await expect(limited.consumeAiDjRequest('user-1')).rejects.toMatchObject({ code: 'AI_DJ_DAILY_LIMIT', status: 429 });
});

test('Razorpay signatures use timing-safe server-side verification and fail closed without secrets', () => {
  const env = { RAZORPAY_KEY_ID: 'rzp_test_key', RAZORPAY_KEY_SECRET: 'test_secret', RAZORPAY_WEBHOOK_SECRET: 'webhook_secret' };
  const provider = createRazorpayProvider({ env, fetchImpl: jest.fn() });
  const paymentId = 'pay_test123';
  const subscriptionId = 'sub_test123';
  const signature = createHmac('sha256', env.RAZORPAY_KEY_SECRET).update(`${paymentId}|${subscriptionId}`).digest('hex');
  const body = Buffer.from('{"event":"subscription.activated"}');
  const webhookSignature = createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET).update(body).digest('hex');
  expect(provider.verifyCheckoutSignature({ paymentId, subscriptionId, signature })).toBe(true);
  expect(provider.verifyCheckoutSignature({ paymentId, subscriptionId, signature: '00'.repeat(32) })).toBe(false);
  expect(provider.verifyWebhookSignature(body, webhookSignature)).toBe(true);
  expect(provider.verifyWebhookSignature(Buffer.from('{}'), webhookSignature)).toBe(false);
  expect(createRazorpayProvider({ env: {}, fetchImpl: jest.fn() }).verifyWebhookSignature(body, webhookSignature)).toBe(false);
});

test('paid checkout fails closed without Razorpay and does not create a fake subscription', async () => {
  const create = jest.fn();
  const service = createBillingService({
    planModel: { findOne: () => query({ planId: 'premium', name: 'Premium', price: 149, billingInterval: 'month', currency: 'INR', features: {}, usageLimits: {}, isActive: true }) },
    subscriptionModel: { findOne: () => query(null), create },
    provider: { configured: false, planIdFor: () => null },
  });
  await expect(service.createPaidSubscription({ userId: '507f1f77bcf86cd799439011', planId: 'premium', requestKey: 'checkout-0001' }))
    .rejects.toMatchObject({ code: 'PAYMENT_PROVIDER_UNAVAILABLE', status: 503 });
  expect(create).not.toHaveBeenCalled();
});

test('unverified Razorpay webhooks cannot change subscription state', async () => {
  const updateOne = jest.fn();
  const service = createBillingService({
    subscriptionModel: { findOne: jest.fn() , updateOne },
    provider: { verifyWebhookSignature: () => false },
  });
  await expect(service.handleWebhook({ rawBody: Buffer.from('{"event":"subscription.activated"}'), signature: 'bad', eventId: 'evt_bad' }))
    .rejects.toMatchObject({ code: 'WEBHOOK_SIGNATURE_INVALID', status: 400 });
  expect(updateOne).not.toHaveBeenCalled();
});
