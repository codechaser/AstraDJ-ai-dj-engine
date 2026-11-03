import { DJLounge } from '../models/DJLounge.js';
import { entitlementService } from '../services/entitlementService.js';
import { ApiError } from '../utils/ApiError.js';
import { subscriptionPlanById } from '../config/subscriptionPlans.js';

export async function meterAuthorizedLoungeAiDj(req, _res, next) {
  try {
    const entitlements = req.app?.locals?.entitlementService ?? entitlementService;
    const lounge = await DJLounge.findOne({ loungeId: req.params.id, status: { $ne: 'ended' } }).select('participantIds').lean();
    if (!lounge) throw new ApiError(404, 'LOUNGE_NOT_FOUND', 'Lounge not found or ended');
    if (!lounge.participantIds?.some((id) => String(id) === String(req.user.id))) throw new ApiError(403, 'LOUNGE_MEMBERSHIP_REQUIRED', 'Join this Lounge before using the AI DJ');
    await entitlements.assertFeature(req.user.id, 'aiDj');
    req.aiDjUsage = await entitlements.consumeAiDjRequest(req.user.id);
    return next();
  } catch (error) { return next(error); }
}

export async function enforcePlanLoungeCapacity(req, _res, next) {
  try {
    // The normal/default Free capacity is already the Lounge API's common case;
    // avoid introducing a subscription lookup for unchanged requests.
    const freeCapacity = subscriptionPlanById.get('free').usageLimits.loungeCapacity;
    if (req.body.maxParticipants <= freeCapacity) return next();
    const entitlement = await (req.app?.locals?.entitlementService ?? entitlementService).current(req.user.id);
    const maximum = entitlement.usageLimits?.loungeCapacity ?? 8;
    if (req.body.maxParticipants > maximum) {
      const requiredPlan = req.body.maxParticipants > 20 ? 'pro' : 'premium';
      throw new ApiError(403, 'FEATURE_REQUIRES_PREMIUM', `Your plan supports Lounge capacity up to ${maximum}`, { feature: 'loungeCapacity', maximum, requiredPlan });
    }
    return next();
  } catch (error) { return next(error); }
}
