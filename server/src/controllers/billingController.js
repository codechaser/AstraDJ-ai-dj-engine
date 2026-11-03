import { billingService } from '../services/billingService.js';
import { ApiError } from '../utils/ApiError.js';

const objectPayload = (body, allowed) => body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).every((key) => allowed.includes(key));

export async function listPlans(_req, res) { res.json(await billingService.listPlans()); }
export async function getMySubscription(req, res) { res.json(await billingService.current(req.user.id)); }
export async function getMyPayments(req, res) {
  const rawLimit = req.query.limit ?? '20';
  if (Object.keys(req.query).some((key) => key !== 'limit') || !/^\d+$/.test(String(rawLimit)) || Number(rawLimit) < 1 || Number(rawLimit) > 100) throw new ApiError(400, 'VALIDATION_ERROR', 'limit must be an integer between 1 and 100');
  res.json(await billingService.paymentsForUser(req.user.id, Number(rawLimit)));
}
export async function createSubscription(req, res) {
  if (!objectPayload(req.body, ['planId']) || !['premium', 'pro'].includes(req.body.planId)) throw new ApiError(400, 'VALIDATION_ERROR', 'Payload must contain a supported paid planId');
  res.status(201).json(await billingService.createPaidSubscription({ userId: req.user.id, planId: req.body.planId, requestKey: req.get('Idempotency-Key') }));
}
export async function verifyCheckout(req, res) {
  if (!objectPayload(req.body, ['razorpay_payment_id', 'razorpay_subscription_id', 'razorpay_signature'])
    || Object.keys(req.body).length !== 3
    || Object.values(req.body).some((value) => typeof value !== 'string')) throw new ApiError(400, 'VALIDATION_ERROR', 'Payload must contain the Razorpay payment, subscription, and signature fields only');
  res.json(await billingService.verifyCheckout({ userId: req.user.id, paymentId: req.body.razorpay_payment_id, subscriptionId: req.body.razorpay_subscription_id, signature: req.body.razorpay_signature }));
}
export async function cancelSubscription(req, res) {
  if (Object.keys(req.body ?? {}).length) throw new ApiError(400, 'VALIDATION_ERROR', 'Cancellation does not accept a request body');
  res.json(await billingService.cancel({ userId: req.user.id, subscriptionId: req.params.subscriptionId }));
}
export async function handleRazorpayWebhook(req, res) {
  const result = await billingService.handleWebhook({ rawBody: req.rawBody, signature: req.get('x-razorpay-signature'), eventId: req.get('x-razorpay-event-id') });
  res.status(200).json(result);
}

export async function adminOverview(_req, res) { res.json(await billingService.adminOverview()); }
export async function adminPlans(_req, res) { res.json(await billingService.adminPlans()); }
export async function adminSubscriptions(req, res) {
  const limit = req.query.limit == null ? 50 : Number(req.query.limit);
  if (Object.keys(req.query).some((key) => !['q', 'limit'].includes(key)) || !Number.isInteger(limit) || limit < 1 || limit > 100 || (req.query.q != null && (typeof req.query.q !== 'string' || req.query.q.length > 100))) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid subscription search parameters');
  res.json(await billingService.adminSubscriptions({ q: req.query.q ?? '', limit }));
}
export async function adminPayments(req, res) {
  const limit = req.query.limit == null ? 50 : Number(req.query.limit);
  if (Object.keys(req.query).some((key) => key !== 'limit') || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiError(400, 'VALIDATION_ERROR', 'limit must be an integer between 1 and 100');
  res.json(await billingService.adminPayments({ limit }));
}
export async function adminUpdatePlan(req, res) {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length !== 1 || !Object.hasOwn(req.body, 'updates')) throw new ApiError(400, 'VALIDATION_ERROR', 'Payload must contain only updates');
  res.json({ plan: await billingService.adminUpdatePlan({ planId: req.params.planId, updates: req.body.updates, actorUserId: req.user.id }) });
}
