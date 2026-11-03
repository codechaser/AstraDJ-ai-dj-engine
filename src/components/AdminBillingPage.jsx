import React, { useEffect, useState } from 'react';
import { Search, ShieldCheck } from 'lucide-react';
import { getBillingAdminOverview, getBillingAdminPayments, getBillingAdminPlans, getBillingAdminSubscriptions, updateBillingPlan } from '../api/client.js';

export default function AdminBillingPage({ user }) {
  const [overview, setOverview] = useState(null);
  const [subscriptions, setSubscriptions] = useState([]);
  const [payments, setPayments] = useState([]);
  const [plans, setPlans] = useState([]);
  const [query, setQuery] = useState('');
  const [state, setState] = useState('loading');
  const [message, setMessage] = useState('');

  async function load(search = query) {
    const [stats, subscriptionResult, paymentResult, planResult] = await Promise.all([
      getBillingAdminOverview(), getBillingAdminSubscriptions(search), getBillingAdminPayments(), getBillingAdminPlans(),
    ]);
    setOverview(stats); setSubscriptions(subscriptionResult.items ?? []); setPayments(paymentResult.items ?? []); setPlans(planResult.items ?? []);
  }
  useEffect(() => { let active = true; if (user?.role !== 'Admin') { setState('forbidden'); return () => { active = false; }; } load('').then(() => { if (active) setState('ready'); }).catch((error) => { if (active) { setMessage(error.message || 'Billing administration is unavailable.'); setState('error'); } }); return () => { active = false; }; }, [user?.id]);

  async function searchSubscriptions(event) { event.preventDefault(); setState('loading'); try { await load(query); setState('ready'); } catch (error) { setMessage(error.message || 'Search failed.'); setState('error'); } }
  async function togglePlan(plan) {
    try { await updateBillingPlan(plan.planId, { isActive: !plan.isActive }); await load(); setMessage(`${plan.name} plan availability saved.`); }
    catch (error) { setMessage(error.message || 'Plan update failed.'); }
  }
  async function saveLimits(plan, event) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const usageLimits = { aiDjRequestsPerDay: Number(data.get('aiDjRequestsPerDay')), loungeCapacity: Number(data.get('loungeCapacity')) };
    try { await updateBillingPlan(plan.planId, { usageLimits }); await load(); setMessage(`${plan.name} usage limits saved.`); }
    catch (error) { setMessage(error.message || 'Usage limits could not be saved.'); }
  }

  if (state === 'forbidden') return <div className="page"><div className="panel integration-error" role="alert">Admin access is required.</div></div>;
  if (state === 'loading') return <div className="page"><div className="panel integration-status">Loading subscription administration…</div></div>;
  if (state === 'error') return <div className="page"><div className="panel integration-error" role="alert">{message}</div></div>;
  return <div className="page billing-admin-page"><div className="page-heading"><div><span className="eyebrow">ADMINISTRATION</span><h1>Subscriptions</h1><p><ShieldCheck size={13}/> Billing records and plan configuration</p></div></div>
    {message && <div className="panel integration-status" role="status">{message}</div>}
    {overview && <div className="billing-admin-stats">{[['Subscribers', overview.subscribers], ['Free users', overview.plans.free], ['Premium', overview.plans.premium], ['Pro', overview.plans.pro], ['MRR', `₹${overview.mrr}`], ['Failed payments', overview.failedPayments]].map(([label, value]) => <div className="panel" key={label}><small>{label}</small><b>{value}</b></div>)}</div>}
    <section className="panel billing-admin-plans"><div className="section-title"><h2>Plans and limits</h2></div>{plans.map((plan) => <div className="billing-plan-admin-row" key={plan.planId}><div><b>{plan.name} · ₹{plan.price}/month</b><small>{plan.isActive ? 'Available for new subscriptions' : 'Unavailable for new subscriptions'}</small></div><form className="billing-limit-form" onSubmit={(event) => saveLimits(plan, event)}><label>AI requests/day<input name="aiDjRequestsPerDay" type="number" min="1" max="100000" defaultValue={plan.usageLimits.aiDjRequestsPerDay}/></label><label>Lounge capacity<input name="loungeCapacity" type="number" min="1" max="50" defaultValue={plan.usageLimits.loungeCapacity}/></label><button className="btn-outline">Save limits</button></form><button className="btn-outline" disabled={plan.planId === 'free'} onClick={() => togglePlan(plan)}>{plan.planId === 'free' ? 'Always available' : plan.isActive ? 'Disable plan' : 'Enable plan'}</button></div>)}</section>
    <section className="panel billing-admin-table"><div className="section-title"><h2>Subscriptions</h2></div><form className="billing-search" onSubmit={searchSubscriptions}><Search size={15}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by user name or email" aria-label="Search subscriptions"/><button className="btn-outline">Search</button></form>{subscriptions.map((item) => <div className="billing-row" key={item.id}><div><b>{item.user?.displayName ?? 'Deleted account'} · {item.planId}</b><small>{item.user?.email ?? 'Email unavailable'} · {item.status}</small></div><small>{item.renewalDate ? new Date(item.renewalDate).toLocaleDateString() : 'No renewal date'}</small></div>)}{!subscriptions.length && <p className="integration-status">No matching subscription records.</p>}</section>
    <section className="panel billing-admin-table"><div className="section-title"><h2>Recent payments</h2></div>{payments.map((item) => <div className="billing-row" key={item.id}><div><b>{item.user?.displayName ?? 'Deleted account'} · {item.planId ?? 'Plan unavailable'}</b><small>{item.user?.email ?? 'Email unavailable'} · {item.provider} · {item.status}</small></div><strong>{item.currency} {(item.amount / 100).toFixed(2)}</strong></div>)}{!payments.length && <p className="integration-status">No payment records yet.</p>}</section>
    <small className="recommendation-disclosure">Provider environment: {overview.paymentEnvironment}. Test-mode records are not represented as production revenue.</small>
  </div>;
}
