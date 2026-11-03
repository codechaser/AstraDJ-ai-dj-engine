import { createHash } from 'node:crypto';
import { Plan } from '../models/Plan.js';
import { Subscription } from '../models/Subscription.js';
import { Payment } from '../models/Payment.js';
import { BillingWebhookEvent } from '../models/BillingWebhookEvent.js';
import { BillingAudit } from '../models/BillingAudit.js';
import { User } from '../models/User.js';
import { subscriptionPlanById } from '../config/subscriptionPlans.js';
import { ensureDefaultPlans, entitlementService } from './entitlementService.js';
import { razorpayProvider } from './razorpayProvider.js';
import { ApiError } from '../utils/ApiError.js';

const addMonth = (date) => { const next = new Date(date); next.setUTCMonth(next.getUTCMonth() + 1); return next; };
const publicPlan = (plan) => ({ planId: plan.planId, name: plan.name, price: plan.price, billingInterval: plan.billingInterval, currency: plan.currency, features: plan.features, implementedFeatures: plan.implementedFeatures ?? [], usageLimits: plan.usageLimits, isActive: plan.isActive });

export function createBillingService({ planModel = Plan, subscriptionModel = Subscription, paymentModel = Payment, webhookModel = BillingWebhookEvent, auditModel = BillingAudit, userModel = User, provider = razorpayProvider, entitlements = entitlementService, now = () => new Date() } = {}) {
  async function audit(data) {
    if (data.idempotencyKey) {
      try { await auditModel.updateOne({ idempotencyKey: data.idempotencyKey }, { $setOnInsert: data }, { upsert: true }); }
      catch (error) { if (error.code !== 11000) throw error; }
      return;
    }
    await auditModel.create(data);
  }
  async function recordPayment({ userId, subscriptionId, paymentId, amount, currency, status }) {
    let existing = paymentId ? await paymentModel.findOne({ providerPaymentId: paymentId }).select('_id').lean() : null;
    if (!existing && paymentId) existing = await paymentModel.findOne({ subscriptionId, status: 'created' }).select('_id').lean();
    if (existing) {
      const old = await paymentModel.findById(existing._id).select('status').lean();
      if (old?.status === 'captured' && status !== 'refunded') return;
      if (old?.status === 'refunded') return;
    }
    const values = { userId, subscriptionId, provider: 'razorpay', providerPaymentId: paymentId, amount, currency, status, receipt: `pay-${paymentId}` };
    if (existing) await paymentModel.updateOne({ _id: existing._id }, { $set: values });
    else await paymentModel.updateOne({ providerPaymentId: paymentId }, { $setOnInsert: values }, { upsert: true });
  }

  return {
    async listPlans() {
      await ensureDefaultPlans(planModel);
      const plans = await planModel.find({ isActive: true }).sort({ price: 1 }).lean();
      return { items: plans.map((plan) => ({ ...publicPlan(plan), checkoutAvailable: Boolean(provider.checkoutEnabled && provider.planIdFor(plan.planId)) })) };
    },
    async current(userId) {
      const entitlementsNow = await entitlements.current(userId);
      const subscription = await subscriptionModel.findOne({ userId }).sort({ updatedAt: -1, _id: -1 }).lean();
      const active = entitlementsNow.status !== 'free';
      return { subscription: active ? { id: String(subscription._id), planId: subscription.planId, status: subscription.status, provider: subscription.provider, startDate: subscription.startDate, endDate: subscription.endDate, renewalDate: subscription.renewalDate, cancelAtPeriodEnd: subscription.cancelAtPeriodEnd } : { planId: 'free', status: 'free', renewalDate: null, cancelAtPeriodEnd: false }, plan: entitlementsNow.plan, features: entitlementsNow.features, usageLimits: entitlementsNow.usageLimits };
    },
    async paymentsForUser(userId, limit = 20) {
      const rows = await paymentModel.find({ userId }).sort({ createdAt: -1, _id: -1 }).limit(limit).select('subscriptionId provider amount currency status receipt createdAt').lean();
      return { items: rows.map((row) => ({ id: String(row._id), subscriptionId: String(row.subscriptionId), provider: row.provider, amount: row.amount, currency: row.currency, status: row.status, receipt: row.receipt, createdAt: row.createdAt })) };
    },
    async createPaidSubscription({ userId, planId, requestKey }) {
      if (!['premium', 'pro'].includes(planId)) throw new ApiError(400, 'VALIDATION_ERROR', 'Select a paid plan');
      if (!/^[A-Za-z0-9._:-]{8,128}$/.test(requestKey ?? '')) throw new ApiError(400, 'VALIDATION_ERROR', 'A valid Idempotency-Key header is required');
      const plan = await planModel.findOne({ planId, isActive: true }).lean();
      if (!plan) throw new ApiError(404, 'PLAN_UNAVAILABLE', 'That plan is not currently available');
      const current = await subscriptionModel.findOne({ userId, status: 'active', $or: [{ renewalDate: null }, { renewalDate: { $gt: now() } }] }).lean();
      if (current) throw new ApiError(409, 'SUBSCRIPTION_ALREADY_ACTIVE', 'Cancel or change the current subscription before starting another paid plan');
      if (!provider.checkoutEnabled || !provider.planIdFor(planId)) throw new ApiError(503, 'PAYMENT_PROVIDER_UNAVAILABLE', 'Razorpay test credentials, provider plan IDs, and explicit checkout enablement are required');

      let local;
      try { local = await subscriptionModel.create({ userId, planId, provider: 'razorpay', status: 'creating', requestKey, providerPlanId: provider.planIdFor(planId) }); }
      catch (error) {
        if (error.code !== 11000) throw error;
        const existing = await subscriptionModel.findOne({ userId, requestKey }).lean();
        if (existing?.providerSubscriptionId && existing.status === 'pending') return { subscriptionId: existing.providerSubscriptionId, localSubscriptionId: String(existing._id), status: existing.status, keyId: provider.keyId, plan: publicPlan(plan) };
        if (existing?.providerSubscriptionId) throw new ApiError(409, 'SUBSCRIPTION_REQUEST_FINALIZED', 'This checkout request has already been finalized; use a new idempotency key to retry');
        throw new ApiError(409, 'SUBSCRIPTION_REQUEST_IN_PROGRESS', 'This checkout request is already being processed');
      }
      try {
        const providerPlan = await provider.getPlan(provider.planIdFor(planId));
        if (providerPlan.id !== provider.planIdFor(planId) || providerPlan.item?.amount !== plan.price * 100 || providerPlan.item?.currency !== plan.currency) {
          throw new ApiError(409, 'PROVIDER_PLAN_MISMATCH', 'Razorpay plan amount or currency does not match the configured AstraDJ plan');
        }
        const created = await provider.createSubscription({ plan_id: provider.planIdFor(planId), total_count: 12, customer_notify: 1, notes: { userId: String(userId), localSubscriptionId: String(local._id) } });
        if (!created?.id || created.plan_id !== provider.planIdFor(planId)) throw new Error('Invalid subscription response');
        await subscriptionModel.updateOne({ _id: local._id, status: 'creating' }, { $set: { status: 'pending', providerSubscriptionId: created.id } });
        await paymentModel.create({ userId, subscriptionId: local._id, provider: 'razorpay', amount: plan.price * 100, currency: plan.currency, status: 'created', receipt: `sub-${String(local._id).slice(-16)}` });
        await audit({ userId, subscriptionId: local._id, action: 'subscription.created', source: 'user', metadata: { planId } });
        return { subscriptionId: created.id, localSubscriptionId: String(local._id), status: 'pending', keyId: provider.keyId, plan: publicPlan(plan) };
      } catch (error) {
        await subscriptionModel.updateOne({ _id: local._id }, { $set: { status: 'failed' } });
        if (error instanceof ApiError) throw error;
        throw new ApiError(502, 'PAYMENT_PROVIDER_ERROR', 'Razorpay could not create the subscription');
      }
    },
    async verifyCheckout({ userId, paymentId, subscriptionId, signature }) {
      if (!/^[A-Za-z0-9_-]{4,80}$/.test(paymentId ?? '') || !/^[A-Za-z0-9_-]{4,80}$/.test(subscriptionId ?? '') || !provider.verifyCheckoutSignature({ paymentId, subscriptionId, signature })) {
        throw new ApiError(400, 'PAYMENT_SIGNATURE_INVALID', 'Razorpay payment signature could not be verified');
      }
      const subscription = await subscriptionModel.findOne({ userId, providerSubscriptionId: subscriptionId }).lean();
      if (!subscription) throw new ApiError(404, 'SUBSCRIPTION_NOT_FOUND', 'No matching pending subscription was found for this account');
      const plan = await planModel.findOne({ planId: subscription.planId }).lean();
      const [remoteSubscription, remotePayment] = await Promise.all([provider.getSubscription(subscriptionId), provider.getPayment(paymentId)]);
      if (remoteSubscription.id !== subscriptionId || remoteSubscription.plan_id !== provider.planIdFor(subscription.planId)
        || remoteSubscription.notes?.userId !== String(userId) || remoteSubscription.notes?.localSubscriptionId !== String(subscription._id)
        || !['active', 'authenticated'].includes(remoteSubscription.status)
        || remotePayment.id !== paymentId || remotePayment.subscription_id !== subscriptionId
        || !['authorized', 'captured'].includes(remotePayment.status)
        || remotePayment.amount !== plan.price * 100 || remotePayment.currency !== plan.currency) {
        throw new ApiError(409, 'PAYMENT_NOT_CONFIRMED', 'Razorpay has not confirmed the expected subscription payment');
      }
      const isActive = remoteSubscription.status === 'active';
      const startDate = remoteSubscription.current_start ? new Date(remoteSubscription.current_start * 1000) : now();
      const renewalDate = remoteSubscription.current_end ? new Date(remoteSubscription.current_end * 1000) : (isActive ? addMonth(startDate) : null);
      await subscriptionModel.updateOne({ _id: subscription._id, status: { $in: ['pending', 'active'] } }, { $set: { status: isActive ? 'active' : 'pending', startDate: isActive ? startDate : null, renewalDate, endDate: renewalDate } });
      await recordPayment({ userId, subscriptionId: subscription._id, paymentId, amount: remotePayment.amount, currency: remotePayment.currency, status: remotePayment.status === 'captured' ? 'captured' : 'authorized' });
      if (isActive && subscription.status !== 'active') await audit({ userId, subscriptionId: subscription._id, action: 'subscription.activated', source: 'razorpay', metadata: { planId: subscription.planId } });
      return { verified: true, active: isActive, status: isActive ? 'active' : 'pending' };
    },
    async cancel({ userId, subscriptionId }) {
      const subscription = await subscriptionModel.findOne({ _id: subscriptionId, userId });
      if (!subscription) throw new ApiError(404, 'SUBSCRIPTION_NOT_FOUND', 'Subscription not found');
      if (subscription.status !== 'active' || !subscription.providerSubscriptionId) throw new ApiError(409, 'SUBSCRIPTION_NOT_CANCELLABLE', 'There is no active paid subscription to cancel');
      if (!subscription.cancelAtPeriodEnd) {
        await provider.cancelSubscription(subscription.providerSubscriptionId, true);
        subscription.cancelAtPeriodEnd = true;
        await subscription.save();
        await audit({ userId, subscriptionId: subscription._id, action: 'subscription.cancel_scheduled', source: 'user', metadata: { cancelAtPeriodEnd: true } });
      }
      return { cancelAtPeriodEnd: true, endDate: subscription.endDate, renewalDate: subscription.renewalDate };
    },
    async handleWebhook({ rawBody, signature, eventId }) {
      if (!Buffer.isBuffer(rawBody) || !provider.verifyWebhookSignature(rawBody, signature)) throw new ApiError(400, 'WEBHOOK_SIGNATURE_INVALID', 'Razorpay webhook signature could not be verified');
      if (!/^[A-Za-z0-9_-]{1,120}$/.test(eventId ?? '')) throw new ApiError(400, 'WEBHOOK_EVENT_ID_REQUIRED', 'Razorpay event ID is required');
      let event;
      try { event = JSON.parse(rawBody.toString('utf8')); } catch { throw new ApiError(400, 'INVALID_JSON', 'Webhook payload is invalid JSON'); }
      const digest = createHash('sha256').update(rawBody).digest('hex');
      const priorEvent = await webhookModel.findOne({ providerEventId: eventId }).lean();
      if (priorEvent) {
        if (priorEvent.payloadSha256 !== digest) throw new ApiError(409, 'WEBHOOK_IDEMPOTENCY_CONFLICT', 'The event ID was previously used with a different payload');
        return { received: true, duplicate: true };
      }
      const entity = event.payload?.subscription?.entity;
      const payment = event.payload?.payment?.entity;
      const providerSubscriptionId = entity?.id ?? payment?.subscription_id;
      const subscription = providerSubscriptionId ? await subscriptionModel.findOne({ providerSubscriptionId }).select('+providerPlanId') : null;
      if (providerSubscriptionId && /^subscription\./.test(String(event.event)) && !subscription) throw new ApiError(503, 'SUBSCRIPTION_SYNC_PENDING', 'Subscription setup is still being committed; retry this webhook');
      if (subscription) {
        if (entity?.plan_id && subscription.providerPlanId && entity.plan_id !== subscription.providerPlanId) throw new ApiError(409, 'WEBHOOK_PLAN_MISMATCH', 'Razorpay subscription plan does not match the stored subscription');
        const plan = await planModel.findOne({ planId: subscription.planId }).lean();
        const providerTime = entity?.current_end ? new Date(entity.current_end * 1000) : null;
        const activeStatuses = ['subscription.activated', 'subscription.charged', 'subscription.resumed'];
        const statusByEvent = {
          'subscription.activated': 'active', 'subscription.charged': 'active', 'subscription.resumed': 'active',
          'subscription.halted': 'past_due', 'subscription.paused': 'paused', 'subscription.cancelled': 'cancelled', 'subscription.completed': 'expired',
          'payment.failed': 'past_due',
        };
        let nextStatus = statusByEvent[event.event];
        const providerEventAt = Number.isSafeInteger(event.created_at) ? new Date(event.created_at * 1000) : now();
        const validUntilFuture = providerTime && providerTime > now();
        if (event.event === 'subscription.cancelled' && validUntilFuture && subscription.cancelAtPeriodEnd) nextStatus = 'active';
        if (nextStatus && (!subscription.lastProviderEventAt || providerEventAt >= subscription.lastProviderEventAt)) {
          await subscriptionModel.updateOne(
            { _id: subscription._id, $or: [{ lastProviderEventAt: null }, { lastProviderEventAt: { $lte: providerEventAt } }] },
            { $set: { status: nextStatus, ...(providerTime ? { renewalDate: providerTime, endDate: providerTime } : {}), ...(event.event === 'subscription.cancelled' ? { cancelAtPeriodEnd: Boolean(validUntilFuture) } : {}), lastProviderEventAt: providerEventAt } },
          );
        }
        if (payment?.id && plan && ['subscription.charged', 'payment.captured', 'payment.failed', 'payment.refunded'].includes(event.event)) {
          const status = event.event === 'payment.refunded' || payment.status === 'refunded' ? 'refunded' : event.event === 'payment.failed' || payment.status === 'failed' ? 'failed' : payment.status === 'authorized' ? 'authorized' : 'captured';
          await recordPayment({ userId: subscription.userId, subscriptionId: subscription._id, paymentId: payment.id, amount: payment.amount ?? plan.price * 100, currency: payment.currency ?? plan.currency, status });
          if (status === 'failed') await audit({ userId: subscription.userId, subscriptionId: subscription._id, action: 'payment.failed', source: 'razorpay', idempotencyKey: `${eventId}:payment.failed`, metadata: { paymentId: payment.id } });
          if (status === 'refunded') await audit({ userId: subscription.userId, subscriptionId: subscription._id, action: 'payment.refunded', source: 'razorpay', idempotencyKey: `${eventId}:payment.refunded`, metadata: { paymentId: payment.id } });
        }
        if (activeStatuses.includes(event.event)) await audit({ userId: subscription.userId, subscriptionId: subscription._id, action: 'subscription.activated', source: 'razorpay', idempotencyKey: `${eventId}:subscription.activated`, metadata: { planId: subscription.planId, event: event.event } });
        if (event.event === 'subscription.cancelled') await audit({ userId: subscription.userId, subscriptionId: subscription._id, action: 'subscription.cancelled', source: 'razorpay', idempotencyKey: `${eventId}:subscription.cancelled`, metadata: { keptThroughPeriodEnd: Boolean(validUntilFuture) } });
        if (event.event === 'subscription.completed') await audit({ userId: subscription.userId, subscriptionId: subscription._id, action: 'subscription.expired', source: 'razorpay', idempotencyKey: `${eventId}:subscription.expired`, metadata: {} });
      }
      try { await webhookModel.create({ providerEventId: eventId, eventType: String(event.event ?? 'unknown').slice(0, 80), payloadSha256: digest, processedAt: now() }); }
      catch (error) { if (error.code === 11000) return { received: true, duplicate: true }; throw error; }
      return { received: true, duplicate: false };
    },
    async adminOverview() {
      const [users, activeSubs, failedPayments, totalActiveSubscriptions, totalCancelled] = await Promise.all([
        userModel.countDocuments({}),
        subscriptionModel.find({ status: 'active', renewalDate: { $gt: now() } }).select('planId').lean(),
        paymentModel.countDocuments({ status: 'failed' }),
        subscriptionModel.countDocuments({ status: 'active', renewalDate: { $gt: now() } }),
        subscriptionModel.countDocuments({ status: 'cancelled' }),
      ]);
      // Each active row contributes one subscriber; plan counts and MRR use only unexpired active records.
      const counts = { free: Math.max(0, users - activeSubs.length), premium: 0, pro: 0 };
      let mrr = 0;
      for (const row of activeSubs) { if (row.planId === 'premium') counts.premium += 1; if (row.planId === 'pro') counts.pro += 1; mrr += subscriptionPlanById.get(row.planId)?.price ?? 0; }
      return { users, subscribers: activeSubs.length, plans: counts, mrr, currency: 'INR', activeSubscriptions: totalActiveSubscriptions, cancelledSubscriptions: totalCancelled, failedPayments, conversionRate: users ? activeSubs.length / users : 0, paymentEnvironment: provider.configured ? provider.mode : 'unconfigured' };
    },
    async adminPlans() {
      await ensureDefaultPlans(planModel);
      const rows = await planModel.find().sort({ price: 1 }).lean();
      return { items: rows.map(publicPlan) };
    },
    async adminSubscriptions({ q = '', limit = 50 }) {
      const userFilter = q ? await userModel.find({ $or: [{ email: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }, { displayName: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }] }).select('_id').lean() : null;
      const filter = userFilter ? { userId: { $in: userFilter.map(({ _id }) => _id) } } : {};
      const rows = await subscriptionModel.find(filter).sort({ createdAt: -1 }).limit(limit).populate('userId', 'email displayName').lean();
      return { items: rows.map((row) => ({ id: String(row._id), user: row.userId ? { id: String(row.userId._id), email: row.userId.email, displayName: row.userId.displayName } : null, planId: row.planId, status: row.status, provider: row.provider, createdAt: row.createdAt, renewalDate: row.renewalDate, endDate: row.endDate, cancelAtPeriodEnd: row.cancelAtPeriodEnd })) };
    },
    async adminPayments({ limit = 50 }) {
      const rows = await paymentModel.find().sort({ createdAt: -1 }).limit(limit).populate('userId', 'email displayName').populate('subscriptionId', 'planId').select('-providerPaymentId -providerOrderId').lean();
      return { items: rows.map((row) => ({ id: String(row._id), user: row.userId ? { email: row.userId.email, displayName: row.userId.displayName } : null, planId: row.subscriptionId?.planId ?? null, amount: row.amount, currency: row.currency, status: row.status, provider: row.provider, createdAt: row.createdAt })) };
    },
    async adminUpdatePlan({ planId, updates, actorUserId }) {
      if (!subscriptionPlanById.has(planId)) throw new ApiError(404, 'PLAN_NOT_FOUND', 'Plan not found');
      await ensureDefaultPlans(planModel);
      const fields = Object.keys(updates ?? {});
      if (!fields.length || fields.some((field) => !['isActive', 'usageLimits'].includes(field))) throw new ApiError(400, 'VALIDATION_ERROR', 'Only plan availability and usage limits may be updated');
      if (updates.isActive !== undefined && typeof updates.isActive !== 'boolean') throw new ApiError(400, 'VALIDATION_ERROR', 'isActive must be a boolean');
      if (planId === 'free' && updates.isActive === false) throw new ApiError(400, 'VALIDATION_ERROR', 'The Free plan must remain available');
      if (updates.usageLimits !== undefined) {
        if (!updates.usageLimits || typeof updates.usageLimits !== 'object' || Array.isArray(updates.usageLimits) || !Object.keys(updates.usageLimits).length || Object.keys(updates.usageLimits).some((key) => key !== 'aiDjRequestsPerDay' && key !== 'loungeCapacity')) throw new ApiError(400, 'VALIDATION_ERROR', 'usageLimits contains unsupported fields');
        for (const [key, value] of Object.entries(updates.usageLimits)) if (!Number.isInteger(value) || value < 1 || value > (key === 'loungeCapacity' ? 50 : 100000)) throw new ApiError(400, 'VALIDATION_ERROR', `usageLimits.${key} is outside the supported range`);
      }
      const $set = {};
      if (updates.isActive !== undefined) $set.isActive = updates.isActive;
      if (updates.usageLimits) for (const [key, value] of Object.entries(updates.usageLimits)) $set[`usageLimits.${key}`] = value;
      const plan = await planModel.findOneAndUpdate({ planId }, { $set }, { new: true, runValidators: true }).lean();
      await audit({ actorUserId, action: 'plan.updated', source: 'admin', metadata: { planId, fields } });
      return publicPlan(plan);
    },
  };
}

export const billingService = createBillingService();
