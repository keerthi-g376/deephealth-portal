import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useCart } from '../cart.jsx';
import { money } from '../format.js';
import Breadcrumb from './Breadcrumb.jsx';

const POLL_MS = 45_000; // status changes made in Salesforce show up without a reload

// "My Quotations": only the signed-in customer's own quotes. Draft = edit in place; any later status = view,
// or Revise (the lines become a new quote on the same Opportunity).
export default function MyQuotes({ onLoaded }) {
  const { user, ready, openSignIn } = useAuth();
  const cart = useCart();
  const [state, setState] = useState({ status: 'loading', quotes: [], error: '' });
  const [busyId, setBusyId] = useState('');
  const [scope, setScope] = useState('mine'); // an Account Admin can switch to the whole Account
  const [declining, setDeclining] = useState(null); // quote being declined
  const [reason, setReason] = useState('Price');

  const load = useCallback(() => {
    api
      .myQuotes(scope)
      .then((quotes) => setState({ status: 'ready', quotes, error: '' }))
      .catch((e) => setState((s) => ({ ...s, status: s.quotes.length ? 'ready' : 'error', error: e.message })));
  }, [scope]);

  useEffect(() => {
    if (!user) return undefined;
    load();
    const timer = setInterval(() => document.visibilityState === 'visible' && load(), POLL_MS);
    return () => clearInterval(timer);
  }, [user, load]);

  const open_ = async (q, mode) => {
    if (cart.items.length && !window.confirm('This replaces the products currently in your cart. Continue?')) return;
    setBusyId(q.id);
    try {
      const data = await api.quoteAsCart(q.id);
      onLoaded?.(data.currency);
      cart.loadQuote(data, mode);
      cart.notify('success', mode === 'edit' ? `Quote #${q.quoteNumber} loaded - change it in the cart.` : `Revision of #${q.quoteNumber} started - review the cart and create the new quote.`);
      window.location.hash = '#/';
    } catch (e) {
      cart.notify('error', e.message);
    } finally {
      setBusyId('');
    }
  };

  const act = async (q, action, why) => {
    setBusyId(q.id);
    try {
      await api.quoteAction(q.id, action, why);
      cart.notify('success', action === 'submit' ? `Quote #${q.quoteNumber} submitted for review.` : action === 'accept' ? `Quote #${q.quoteNumber} accepted. Our team will process your order.` : `Quote #${q.quoteNumber} closed. Thank you for letting us know.`);
      setDeclining(null);
      load();
    } catch (e) {
      cart.notify('error', e.message);
    } finally {
      setBusyId('');
    }
  };

  if (!ready) return null;
  if (!user) {
    return (
      <div className="state">
        <p>Sign in to see your quotations.</p>
        <button className="btn-coral" onClick={openSignIn}>Sign in</button>
      </div>
    );
  }

  const mine = (q) => q.ownerContactId === user.contactId || !q.ownerContactId || scope !== 'account';
  const actions = (q) => {
    const st = q.status;
    const busy = busyId === q.id;
    const open = ['Draft', 'Needs Review', 'In Review', 'Approved', 'Presented', 'Rejected'].includes(st);
    return (
      <>
        {st === 'Draft' && <button className="btn-coral" disabled={busy} onClick={() => open_(q, 'edit')}>Edit</button>}
        {st === 'Draft' && <button className="btn-outline" disabled={busy} onClick={() => act(q, 'submit')}>Submit for review</button>}
        {['Approved', 'Presented'].includes(st) && <button className="btn-coral" disabled={busy} onClick={() => act(q, 'accept')}>Accept quote</button>}
        {st !== 'Draft' && <button className="btn-soft" disabled={busy} onClick={() => open_(q, 'edit')}>View</button>}
        {['Needs Review', 'In Review', 'Approved', 'Presented', 'Rejected'].includes(st) && <button className="btn-outline" disabled={busy} onClick={() => open_(q, 'revise')}>Revise</button>}
        {open && <button className="btn-soft" disabled={busy} onClick={() => setDeclining(q)}>Not interested</button>}
      </>
    );
  };

  return (
    <section className="detail">
      <Breadcrumb current="My Quotations" />
      <div className="page-head">
        <h1>My Quotations</h1>
        {user.isAdmin && (
          <label className="note" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={scope === 'account'} onChange={(e) => setScope(e.target.checked ? 'account' : 'mine')} />
            Show all quotes of {user.accountName}
          </label>
        )}
      </div>
      {user.access !== 'Active' && <p className="note warn">Your access is waiting for approval from your account owner, so you cannot see or create quotes yet.</p>}
      {state.status === 'loading' && <p className="state">Loading your quotations…</p>}
      {state.status === 'error' && <p className="state error">{state.error}</p>}
      {state.status === 'ready' && state.quotes.length === 0 && <p className="note">You have no quotations yet. Add products to the cart and create one.</p>}
      <ul className="quote-lines">
        {state.quotes.map((q) => (
          <li className="quote-line" key={q.id}>
            <div className="line-info">
              <strong>Quote #{q.quoteNumber}</strong>
              <small>{[q.status, q.createdDate, `${q.itemCount} item${q.itemCount === 1 ? '' : 's'}`].join(' · ')}</small>
            </div>
            <span className="line-total">{money(q.grandTotal, q.currencyCode)}</span>
            <div className="comp-actions" style={{ flexWrap: 'wrap' }}>
              {mine(q) ? actions(q) : <small>View only</small>}
            </div>
          </li>
        ))}
      </ul>
      {declining && (
        <div className="modal-scrim" onClick={() => setDeclining(null)}>
          <div className="modal" role="dialog" aria-label="Not interested" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><h2>Not interested</h2></div>
            <div className="modal-body" style={{ display: 'grid', gap: 8 }}>
              <p className="note">Quote #{declining.quoteNumber} will be closed. Why?</p>
              <select className="field" value={reason} onChange={(e) => setReason(e.target.value)}>
                {['Price', 'Timing', 'Chose another vendor', 'No longer needed', 'Other'].map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
              <button className="btn-coral" disabled={busyId === declining.id} onClick={() => act(declining, 'decline', reason)}>Close this quote</button>
              <button className="btn-soft" onClick={() => setDeclining(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
