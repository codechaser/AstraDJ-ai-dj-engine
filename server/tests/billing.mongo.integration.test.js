import crypto from 'node:crypto';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createIsolatedMongoTestDatabase, dropIsolatedMongoTestDatabase } from './mongoTestDatabase.js';

const configuredMongoUri = process.env.MONGODB_TEST_URI;
const liveTest = configuredMongoUri ? test : test.skip;

liveTest('billing persists Free defaults, isolates payment reads, protects Admin routes, and processes signed webhooks idempotently', async () => {
  const mongoose = (await import('mongoose')).default;
  const { uri, databaseName } = createIsolatedMongoTestDatabase(configuredMongoUri, 'billing');
  process.env.MONGODB_URI = uri;
  process.env.JWT_ACCESS_SECRET = 'test-secret-astradj-billing-32-characters';
  process.env.JWT_ACCESS_TTL_SECONDS = '900';
  process.env.RAZORPAY_WEBHOOK_SECRET = 'billing-webhook-test-secret';
  process.env.RAZORPAY_KEY_ID = 'rzp_test_billing';
  process.env.RAZORPAY_KEY_SECRET = 'billing-test-secret';
  process.env.RAZORPAY_MODE = 'test';
  process.env.RAZORPAY_CHECKOUT_ENABLED = 'false';
  let connected = false;
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
    connected = true;
    const [{ app }, { User }, { Plan }, { Subscription }, { Payment }, { BillingWebhookEvent }, { BillingAudit }, { ensureDefaultPlans }] = await Promise.all([
      import('../src/app.js'), import('../src/models/User.js'), import('../src/models/Plan.js'), import('../src/models/Subscription.js'),
      import('../src/models/Payment.js'), import('../src/models/BillingWebhookEvent.js'), import('../src/models/BillingAudit.js'), import('../src/services/entitlementService.js'),
    ]);
    await ensureDefaultPlans();
    const suffix = crypto.randomUUID().slice(0, 8);
    const listener = await User.create({ email: `billing-user-${suffix}@example.invalid`, displayName: 'Billing User', passwordHash: 'test-only-hash', role: 'Listener' });
    const second = await User.create({ email: `billing-other-${suffix}@example.invalid`, displayName: 'Other User', passwordHash: 'test-only-hash', role: 'Listener' });
    const admin = await User.create({ email: `billing-admin-${suffix}@example.invalid`, displayName: 'Billing Admin', passwordHash: 'test-only-hash', role: 'Admin' });
    const tokenFor = (user) => jwt.sign({}, process.env.JWT_ACCESS_SECRET, { subject: String(user._id), issuer: 'astradj-api', audience: 'astradj-client', expiresIn: 900, algorithm: 'HS256' });
    const listenerToken = tokenFor(listener);
    const secondToken = tokenFor(second);
    const adminToken = tokenFor(admin);
    const agent = request.agent(app);

    const plans = await agent.get('/api/v1/billing/plans');
    expect(plans.status).toBe(200);
    expect(plans.body.items.map(({ planId, price }) => [planId, price])).toEqual([['free', 0], ['premium', 149], ['pro', 299]]);
    expect(plans.body.items.find(({ planId }) => planId === 'premium').checkoutAvailable).toBe(false);
    const free = await agent.get('/api/v1/billing/me').set('Authorization', `Bearer ${listenerToken}`);
    expect(free.body).toMatchObject({ subscription: { planId: 'free', status: 'free' }, plan: { planId: 'free' }, usageLimits: { aiDjRequestsPerDay: 100, loungeCapacity: 8 } });
    const forgedUpgrade = await agent.post('/api/v1/billing/subscriptions').set('Authorization', `Bearer ${listenerToken}`).set('Idempotency-Key', 'checkout-test-0001').send({ planId: 'premium' });
    expect(forgedUpgrade.status).toBe(503);
    expect(forgedUpgrade.body.error.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
    expect(await Subscription.countDocuments({ userId: listener._id })).toBe(0);

    const subscription = await Subscription.create({ userId: listener._id, planId: 'premium', status: 'pending', provider: 'razorpay', providerSubscriptionId: `sub_test_${suffix}`, providerPlanId: 'external-plan-id' });
    await Payment.create({ userId: listener._id, subscriptionId: subscription._id, provider: 'razorpay', amount: 14900, currency: 'INR', status: 'created' });
    const secondSubscription = await Subscription.create({ userId: second._id, planId: 'pro', status: 'pending', provider: 'razorpay' });
    await Payment.create({ userId: second._id, subscriptionId: secondSubscription._id, provider: 'razorpay', amount: 29900, currency: 'INR', status: 'created' });
    const ownPayments = await agent.get('/api/v1/billing/me/payments').set('Authorization', `Bearer ${listenerToken}`);
    expect(ownPayments.body.items).toHaveLength(1);
    expect(ownPayments.body.items[0].amount).toBe(14900);
    const otherPayments = await agent.get('/api/v1/billing/me/payments').set('Authorization', `Bearer ${secondToken}`);
    expect(otherPayments.body.items).toHaveLength(1);
    expect(otherPayments.body.items[0].amount).toBe(29900);

    const deniedAdmin = await agent.get('/api/v1/admin/billing/overview').set('Authorization', `Bearer ${listenerToken}`);
    expect(deniedAdmin.status).toBe(403);
    const adminSummary = await agent.get('/api/v1/admin/billing/overview').set('Authorization', `Bearer ${adminToken}`);
    expect(adminSummary.status).toBe(200);
    expect(adminSummary.body).toMatchObject({ users: 3, plans: { free: 3, premium: 0, pro: 0 }, paymentEnvironment: 'razorpay-test' });
    const updatedPlan = await agent.patch('/api/v1/admin/billing/plans/free').set('Authorization', `Bearer ${adminToken}`).send({ updates: { usageLimits: { aiDjRequestsPerDay: 120 } } });
    expect(updatedPlan.status).toBe(200);
    expect(updatedPlan.body.plan.usageLimits).toMatchObject({ aiDjRequestsPerDay: 120, loungeCapacity: 8 });
    const forbiddenPlanMutation = await agent.patch('/api/v1/admin/billing/plans/premium').set('Authorization', `Bearer ${listenerToken}`).send({ updates: { isActive: false } });
    expect(forbiddenPlanMutation.status).toBe(403);

    const event = { event: 'subscription.charged', created_at: Math.floor(Date.now() / 1000), payload: {
      subscription: { entity: { id: subscription.providerSubscriptionId, plan_id: 'external-plan-id', status: 'active', current_end: Math.floor(Date.now() / 1000) + 86400 * 30 } },
      payment: { entity: { id: `pay_test_${suffix}`, subscription_id: subscription.providerSubscriptionId, amount: 14900, currency: 'INR', status: 'captured' } },
    } };
    const raw = Buffer.from(JSON.stringify(event));
    const signature = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(raw).digest('hex');
    const webhook = () => agent.post('/api/v1/billing/webhooks/razorpay').set('Content-Type', 'application/json').set('x-razorpay-signature', signature).set('x-razorpay-event-id', `evt_billing_${suffix}`).send(raw.toString('utf8'));
    const firstDelivery = await webhook();
    expect(firstDelivery.status).toBe(200);
    const duplicateDelivery = await webhook();
    expect(duplicateDelivery.status).toBe(200);
    expect(duplicateDelivery.body.duplicate).toBe(true);
    const activated = await Subscription.findById(subscription._id).lean();
    expect(activated).toMatchObject({ status: 'active', planId: 'premium' });
    expect(await BillingWebhookEvent.countDocuments({ providerEventId: `evt_billing_${suffix}` })).toBe(1);
    expect(await BillingAudit.countDocuments({ idempotencyKey: `evt_billing_${suffix}:subscription.activated` })).toBe(1);
    expect(await Payment.countDocuments({ providerPaymentId: `pay_test_${suffix}` })).toBe(1);
  } finally {
    if (connected) await dropIsolatedMongoTestDatabase(mongoose, databaseName);
  }
}, 30000);
