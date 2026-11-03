import React, { useEffect, useState } from 'react';
import { Check, Clock3, Crown, LoaderCircle, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import { createBillingSubscription, getBillingPlans, getMySubscription, verifyBillingCheckout } from '../api/client.js';

const featureLabels = {
  basicPlayback: 'Music playback', basicPlaylists: 'Basic playlists and library', basicRecommendations: 'Basic recommendations',
  aiDj: 'AI DJ access with a daily limit', joinPublicLounges: 'Join public Lounges', listeningHistory: 'Listening history',
  createPrivateLounges: 'Create private Lounges', advancedRecommendations: 'Advanced mood recommendations',
  personalizedTransitions: 'Personalized transitions', advancedPlaylistManagement: 'Advanced playlist management',
  detailedListeningStatistics: 'Detailed listening statistics', premiumThemes: 'Premium profile themes',
  additionalCollaborativeControls: 'Additional collaborative controls', advancedSessionAnalytics: 'Advanced session analytics',
  advancedAcousticInsights: 'Advanced acoustic insights', priorityAiProcessing: 'Priority AI processing (when available)',
};

function loadRazorpay() {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-razorpay-checkout]');
    if (existing) { existing.addEventListener('load', resolve, { once: true }); existing.addEventListener('error', reject, { once: true }); return; }
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    script.dataset.razorpayCheckout = 'true';
    script.onload = resolve;
    script.onerror = () => reject(new Error('Razorpay Checkout could not be loaded.'));
    document.body.appendChild(script);
  });
}

function createRequestKey() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `checkout-${Date.now()}-${Math.random().toString(36).slice(2, 14)}`;
}

export default function PlansPage({ user }) {
  const [plans, setPlans] = useState([]);
  const [current, setCurrent] = useState(null);
  const [state, setState] = useState(user ? 'loading' : 'ready');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [isError, setIsError] = useState(false);
  const [unavailablePlan, setUnavailablePlan] = useState(null);

  async function reload() {
    const [planResult, subscription] = await Promise.all([getBillingPlans(), user ? getMySubscription() : Promise.resolve(null)]);
    setPlans(planResult.items ?? []);
    setCurrent(subscription);
  }
  useEffect(() => { let active = true; setState('loading'); Promise.all([getBillingPlans(), user ? getMySubscription() : Promise.resolve(null)]).then(([planResult, subscription]) => { if (active) { setPlans(planResult.items ?? []); setCurrent(subscription); setState('ready'); } }).catch((error) => { if (active) { setMessage(error.message || 'Plans could not be loaded.'); setIsError(true); setState('error'); } }); return () => { active = false; }; }, [user?.id]);

  async function subscribe(plan) {
    setBusy(plan.planId); setMessage(''); setIsError(false);
    try {
      const checkout = await createBillingSubscription(plan.planId, createRequestKey());
      if (!checkout.keyId || !checkout.subscriptionId) throw new Error('Checkout is not configured for this plan.');
      await loadRazorpay();
      const instance = new window.Razorpay({
        key: checkout.keyId, subscription_id: checkout.subscriptionId, name: 'AstraDJ',
        description: `${plan.name} monthly subscription`,
        theme: { color: '#00d7b3' },
        handler: async (result) => {
          setBusy('verify');
          try {
            const verification = await verifyBillingCheckout(result);
            await reload();
            setMessage(verification.active ? 'Payment verified. Your subscription is active.' : 'Payment authorization verified. Plan access will update after Razorpay confirms activation.');
            setIsError(false);
          } catch (error) { setMessage(error.message || 'Payment verification failed.'); setIsError(true); }
          finally { setBusy(''); }
        },
        modal: { ondismiss: () => { setBusy(''); setMessage('Checkout closed. No plan was changed.'); } },
      });
      instance.on('payment.failed', (event) => { setBusy(''); setMessage(event.error?.description || 'Razorpay could not complete the payment.'); setIsError(true); });
      instance.open();
    } catch (error) { setBusy(''); setMessage(error.message || 'Checkout could not be started.'); setIsError(true); }
  }

  return <div className="page plans-page">
    <div className="page-heading"><div><span className="eyebrow">ASTRADJ MEMBERSHIP</span><h1>Choose your plan</h1><p>Plans and limits are configurable. Paid access starts only after server-side payment verification.</p></div></div>
    {state === 'loading' && <div className="panel integration-status" role="status">Loading subscription plans…</div>}
    {state === 'error' && <div className="panel integration-error" role="alert">{message}</div>}
    {message && state !== 'error' && <div className={`panel ${isError ? 'integration-error' : 'integration-status'}`} role="status">{message}</div>}
    {state === 'ready' && <><div className="panel integration-status plan-availability-note">Plans and prices are proposed configuration. Benefits marked “Planned” are not enabled in the current app yet; only verified capabilities and the displayed limits are active.</div><div className="plan-grid">{plans.map((plan) => {
      const isCurrent = current?.plan?.planId === plan.planId;
      const hasPaidSubscription = Boolean(current?.subscription?.id && current.subscription.status === 'active');
      const features = Object.entries(plan.features ?? {}).filter(([, enabled]) => enabled);
      return <article className={`panel plan-card ${plan.planId === 'premium' ? 'plan-featured' : ''}`} key={plan.planId}>
        {plan.planId === 'premium' && <span className="plan-recommended"><Sparkles size={12}/> Recommended</span>}
        <div className="plan-card-title"><span className={`plan-icon plan-${plan.planId}`}><Crown size={17}/></span><div><h2>{plan.name}</h2><small>{plan.planId === 'free' ? 'AstraDJ essentials' : 'More room for your sound'}</small></div></div>
        <div className="plan-price"><b>₹{plan.price}</b><span>/{plan.billingInterval}</span><small>{plan.currency} · billed monthly</small></div>
        <div className="plan-limit">AI DJ: <b>{plan.usageLimits?.aiDjRequestsPerDay ?? '—'} requests/day</b> · Lounge capacity: <b>{plan.usageLimits?.loungeCapacity ?? '—'}</b></div>
        <ul>{features.map(([key]) => { const name = featureLabels[key] ?? key; const ready = (plan.implementedFeatures ?? []).includes(key); return <li className={ready ? '' : 'plan-feature-planned'} key={key}>{ready ? <Check size={14}/> : <Clock3 size={14}/>}<span>{ready ? name : `Planned · ${name}`}</span></li>; })}</ul>
        {isCurrent ? <button className="btn-outline" disabled aria-current="true">Current plan</button>
          : plan.planId === 'free' ? <button className="btn-outline" disabled>Included</button>
          : !user ? <Link className="btn-outline" to="/profile">Sign in to upgrade</Link>
              : hasPaidSubscription ? <Link className="btn-outline" to="/settings/billing">Manage subscription</Link>
              : <button className="btn-primary" disabled={Boolean(busy)} onClick={() => plan.checkoutAvailable ? subscribe(plan) : setUnavailablePlan(plan)}>{busy === plan.planId || busy === 'verify' ? <><LoaderCircle size={14} className="spin"/> Processing…</> : plan.checkoutAvailable ? `Choose ${plan.name}` : `Get ${plan.name}`}</button>}
        {!plan.checkoutAvailable && plan.planId !== 'free' && <small className="plan-provider-note">Razorpay test credentials and this plan’s provider plan ID are required.</small>}
      </article>;
    })}</div></>}
    {unavailablePlan && <div className="payment-info-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setUnavailablePlan(null); }}><section className="panel payment-info-dialog" role="dialog" aria-modal="true" aria-labelledby="payment-setup-title"><span className="eyebrow">SECURE CHECKOUT</span><h2 id="payment-setup-title">{unavailablePlan.name} checkout isn’t ready yet</h2><p>AstraDJ hasn’t connected a payment provider plan for this option. Checkout requires configured Razorpay credentials and a matching provider plan ID.</p><p className="payment-info-safe">No payment was started or taken. Your current plan remains unchanged.</p><div className="payment-info-actions"><button type="button" className="btn-primary" onClick={() => setUnavailablePlan(null)}>Got it</button></div></section></div>}
  </div>;
}
