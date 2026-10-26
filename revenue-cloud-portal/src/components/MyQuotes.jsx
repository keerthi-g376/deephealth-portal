import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useCart } from '../cart.jsx';
import { money } from '../format.js';
import Breadcrumb from './Breadcrumb.jsx';

const POLL_MS = 45_000; // status changes made in Salesforce show up without a reload

// "My Quotations": only the signed-in customer's own quotes (an Account Admin can show the whole Account).
// Edit opens the quote's details: line items, addresses and the other quote details. A Draft is also loaded into
// the cart, where Update Quote saves changes; any later status is shown read-only.
export default function MyQuotes({ onLoaded }) {
  const { user, ready, openSignIn } = useAuth();
  const cart = useCart();
  const [state, setState] = useState({ status: 'loading', quotes: [], error: '' });
  const [busyId, setBusyId] = useState('');
  const [scope, setScope] = useState('mine');

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

  const edit = async (q) => {
    const own = !q.ownerContactId || q.ownerContactId === user.contactId;
    if (q.status !== 'Draft' || !own) {
      window.location.hash = `#/quote/${q.id}`; // read-only details
      return;
    }
    if (cart.quote?.id !== q.id && cart.items.length && !window.confirm('This replaces the products currently in your cart. Continue?')) return;
    setBusyId(q.id);
    try {
      if (cart.quote?.id !== q.id) {
        const data = await api.quoteAsCart(q.id);
        onLoaded?.(data.currency);
        cart.loadQuote(data, 'edit');
      }
      window.location.hash = `#/quote/${q.id}`;
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
              <small>{[q.status, q.createdDate, `${q.itemCount} item${q.itemCount === 1 ? '' : 's'}`, scope === 'account' ? q.ownerName : ''].filter(Boolean).join(' · ')}</small>
            </div>
            <span className="line-total">{money(q.grandTotal, q.currencyCode)}</span>
            <div className="comp-actions">
              <button className="btn-coral" disabled={busyId === q.id} onClick={() => edit(q)}>Edit</button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
