import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { BadgeCheck, CreditCard, XCircle } from 'lucide-react';
import { cancelBillingSubscription, getMySubscription, getPaymentHistory } from '../api/client.js';

export default function BillingPage({ user }) {
  const [subscription, setSubscription] = useState(null);
  const [payments, setPayments] = useState([]);
  const [state, setState] = useState('loading');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    const [current, history] = await Promise.all([getMySubscription(), getPaymentHistory()]);
    setSubscription(current); setPayments(history.items ?? []);
  }
  useEffect(() => { let active = true; if (!user) { setState('signed-out'); return () => { active = false; }; } setState('loading'); Promise.all([getMySubscription(), getPaymentHistory()]).then(([current, history]) => { if (active) { setSubscription(current); setPayments(history.items ?? []); setState('ready'); } }).catch((error) => { if (active) { setMessage(error.message || 'Billing details are unavailable.'); setState('error'); } }); return () => { active = false; }; }, [user?.id]);

  async function cancel() {
    if (!subscription?.subscription?.id) return;
    setBusy(true); setMessage('');
    try { await cancelBillingSubscription(subscription.subscription.id); await load(); setMessage('Cancellation is scheduled for the end of your current billing period.'); }
    catch (error) { setMessage(error.message || 'Cancellation could not be completed.'); }
    finally { setBusy(false); }
  }

  if (state === 'loading') return <div className="page billing-page"><div className="panel integration-status">Loading billing details…</div></div>;
  if (state === 'signed-out') return <div className="page billing-page"><div className="panel integration-status">Sign in to view subscription and payment details.</div></div>;
  return <div className="page billing-page"><div className="page-heading"><div><span className="eyebrow">ACCOUNT</span><h1>Billing & subscription</h1><p>Manage your AstraDJ plan and view verified payment records.</p></div><Link className="btn-outline" to="/plans">Compare plans</Link></div>
    {state === 'error' && <div className="panel integration-error" role="alert">{message}</div>}
    {message && state === 'ready' && <div className="panel integration-status" role="status">{message}</div>}
    {state === 'ready' && <><section className="panel billing-current"><div className="billing-current-icon"><BadgeCheck size={23}/></div><div><span className="eyebrow">CURRENT PLAN</span><h2>{subscription?.plan?.name ?? 'Free'}</h2><p>Status: {subscription?.subscription?.status ?? 'Free'}{subscription?.subscription?.cancelAtPeriodEnd ? ' · Cancels at period end' : ''}</p>{subscription?.subscription?.renewalDate && <small>Next renewal: {new Date(subscription.subscription.renewalDate).toLocaleDateString()}</small>}</div>{subscription?.subscription?.id && !subscription.subscription.cancelAtPeriodEnd && <button className="btn-outline" disabled={busy} onClick={cancel}><XCircle size={14}/>{busy ? 'Cancelling…' : 'Cancel at period end'}</button>}</section>
      <div className="section-title"><h2>Payment history</h2></div>
      {payments.length ? <div className="panel billing-table">{payments.map((payment) => <div className="billing-row" key={payment.id}><CreditCard size={15}/><div><b>{payment.status}</b><small>{payment.provider} · {new Date(payment.createdAt).toLocaleString()}</small></div><strong>{payment.currency} {(payment.amount / 100).toFixed(2)}</strong></div>)}</div> : <div className="panel profile-empty-state"><div><b>No payments yet</b><small>Verified Razorpay transactions will appear here.</small></div><Link className="btn-outline" to="/plans">View plans</Link></div>}</>}
  </div>;
}
