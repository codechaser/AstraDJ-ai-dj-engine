import { Plan } from '../models/Plan.js';
import { Subscription } from '../models/Subscription.js';
import { FeatureUsage } from '../models/FeatureUsage.js';
import { BillingAudit } from '../models/BillingAudit.js';
import { subscriptionPlanById } from '../config/subscriptionPlans.js';
import { ApiError } from '../utils/ApiError.js';

const utcDay = (date) => date.toISOString().slice(0, 10);

export async function ensureDefaultPlans(planModel = Plan) {
  for (const definition of subscriptionPlanById.values()) {
    await planModel.updateOne({ planId: definition.planId }, { $setOnInsert: definition }, { upsert: true });
  }
}

export function createEntitlementService({ planModel = Plan, subscriptionModel = Subscription, usageModel = FeatureUsage, auditModel = BillingAudit, now = () => new Date() } = {}) {
  async function resolve(userId) {
    const subscription = await subscriptionModel.findOne({ userId }).sort({ updatedAt: -1, _id: -1 }).lean();
    const expiration = subscription?.endDate ?? subscription?.renewalDate;
    const expired = subscription?.status === 'active' && expiration && new Date(expiration) <= now();
    if (expired) {
      await subscriptionModel.updateOne({ _id: subscription._id, status: 'active' }, { $set: { status: 'expired' } });
      await auditModel.updateOne({ idempotencyKey: `expiry:${subscription._id}` }, { $setOnInsert: { userId, subscriptionId: subscription._id, action: 'subscription.expired', source: 'system', idempotencyKey: `expiry:${subscription._id}`, metadata: {} } }, { upsert: true });
    }
    const isCurrent = subscription?.status === 'active' && expiration && new Date(expiration) > now();
    const planId = isCurrent ? subscription.planId : 'free';
    const plan = await planModel.findOne({ planId }).lean() ?? subscriptionPlanById.get('free');
    return { plan, subscription: isCurrent ? subscription : null, planId: plan.planId };
  }

  return {
    async current(userId) {
      const { plan, subscription, planId } = await resolve(userId);
      return { planId, plan: { planId: plan.planId, name: plan.name, price: plan.price, currency: plan.currency, billingInterval: plan.billingInterval }, status: subscription?.status ?? 'free', renewalDate: subscription?.renewalDate ?? null, cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false, features: plan.features, usageLimits: plan.usageLimits };
    },
    async assertFeature(userId, feature) {
      const { plan } = await resolve(userId);
      if (plan.features?.[feature] !== true) throw new ApiError(403, 'FEATURE_REQUIRES_PREMIUM', 'This feature is not included in your current plan', { feature, requiredPlan: 'premium' });
      return plan;
    },
    async consumeAiDjRequest(userId) {
      const { plan } = await resolve(userId);
      const limit = Number(plan.usageLimits?.aiDjRequestsPerDay ?? 0);
      const periodKey = utcDay(now());
      let row;
      try {
        row = await usageModel.findOneAndUpdate(
          { userId, feature: 'aiDjRequests', periodKey, count: { $lt: limit } },
          { $inc: { count: 1 }, $setOnInsert: { userId, feature: 'aiDjRequests', periodKey } },
          { upsert: true, new: true, setDefaultsOnInsert: true },
        ).lean();
      } catch (error) {
        if (error.code !== 11000) throw error;
        // A duplicate can mean another request created the counter at the same time.
        // Retry without upsert: increment if still under quota, otherwise get null.
        row = await usageModel.findOneAndUpdate(
          { userId, feature: 'aiDjRequests', periodKey, count: { $lt: limit } },
          { $inc: { count: 1 } },
          { upsert: false, new: true },
        ).lean();
      }
      if (!row) {
        row = await usageModel.findOne({ userId, feature: 'aiDjRequests', periodKey }).lean();
        const reset = new Date(`${periodKey}T00:00:00.000Z`); reset.setUTCDate(reset.getUTCDate() + 1);
        throw new ApiError(429, 'AI_DJ_DAILY_LIMIT', 'You have reached today’s AI DJ request limit', { limit, used: row?.count ?? limit, resetsAt: reset.toISOString() });
      }
      return { used: row.count, limit, planId: plan.planId };
    },
  };
}

export const entitlementService = createEntitlementService();
