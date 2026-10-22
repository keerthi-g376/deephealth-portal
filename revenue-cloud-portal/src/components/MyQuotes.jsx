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

  const load = useCallback(() => {
    api
      .myQuotes()
      .then((quotes) => setState({ status: 'ready', quotes, error: '' }))
      .catch((e) => setState((s) => ({ ...s, status: s.quotes.length ? 'ready' : 'error', error: e.message })));
  }, []);

  useEffect(() => {
    if (!user) return undefined;
    load();
    const timer = setInterval(() => document.visibilityState === 'visible' && load(), POLL_MS);
    return () => clearInterval(timer);
  }, [user, load]);

  const open = async (q, mode) => {
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
      </div>
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
            <div className="comp-actions">
              {q.status === 'Draft' ? (
                <button className="btn-coral" disabled={busyId === q.id} onClick={() => open(q, 'edit')}>Edit</button>
              ) : (
                <>
                  <button className="btn-soft" disabled={busyId === q.id} onClick={() => open(q, 'edit')}>View</button>
                  <button className="btn-outline" disabled={busyId === q.id} onClick={() => open(q, 'revise')}>Revise</button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
