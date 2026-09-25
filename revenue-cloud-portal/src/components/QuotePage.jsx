import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useCart } from '../cart.jsx';
import { money } from '../format.js';
import { ArrowLeftIcon, BoxIcon } from './icons.jsx';

const day = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s ?? '');
  return m ? new Date(+m[1], m[2] - 1, +m[3]).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : s;
};

// Quote details page: opened from the quote pill in the header. Everything shown is read from the
// Salesforce quote itself (its fields and its saved line items), so it is exactly what Salesforce holds.
export default function QuotePage({ onBack }) {
  const { quote, dirty } = useCart();
  const [state, setState] = useState({ status: 'loading', data: null, error: '' });

  // re-read the quote whenever it is saved or changes status
  useEffect(() => {
    if (!quote) return undefined;
    let live = true;
    setState((s) => ({ ...s, status: s.data ? 'ready' : 'loading', error: '' }));
    api
      .getQuote(quote.id)
      .then((data) => live && setState({ status: 'ready', data, error: '' }))
      .catch((e) => live && setState((s) => ({ ...s, status: 'error', error: e.message })));
    return () => {
      live = false;
    };
  }, [quote?.id, quote?.status, quote?.grandTotal, dirty]);

  if (!quote) {
    return (
      <div className="state">
        <p>There is no quote yet. Add products to the cart and choose Create Quote.</p>
        <a className="btn btn-primary fit" href="#/">
          Back to products
        </a>
      </div>
    );
  }

  const { data } = state;
  const products = data?.products ?? [];
  const facts = data
    ? [
        ['Quote Number', `#${data.quoteNumber}`],
        ['Quote Name', data.name],
        ['Status', data.status],
        ['Created', day(data.createdDate)],
        ['Expiration Date', day(data.expirationDate)],
        ['Quote Source', data.quoteSource],
        ['Notes', data.notes],
      ].filter(([, v]) => v)
    : [];

  return (
    <section className="detail">
      <button className="back" onClick={onBack}>
        <ArrowLeftIcon /> Back
      </button>

      <div className="detail-head">
        <span className="detail-icon">
          <BoxIcon width={30} height={30} />
        </span>
        <div>
          <h1 className="title small">Quote #{quote.quoteNumber}</h1>
          <p className="detail-sub">Quote details and products · {quote.status}</p>
        </div>
      </div>

      {dirty && <p className="note warn">Your cart has changes that are not in this quote yet. Open the cart and choose Update Quote.</p>}
      {state.status === 'loading' && <p className="state">Loading the quote from Salesforce…</p>}
      {state.status === 'error' && <p className="state error">{state.error}</p>}

      {data && (
        <>
          <div className="panel">
            <h2>Quote Details</h2>
            <dl className="facts">
              {facts.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="panel">
            <h2>Products ({products.length})</h2>
            {products.length === 0 ? (
              <p className="note">This quote has no products.</p>
            ) : (
              <ul className="quote-lines">
                {products.map((p) => (
                  <li className="quote-line" key={p.id}>
                    <div className="line-info">
                      <strong>{p.name}</strong>
                      <small>
                        {[p.category, `${money(p.price)} × ${p.qty}`].filter(Boolean).join(' · ')}
                      </small>
                    </div>
                    <span className="line-total">{money(p.price * p.qty)}</span>
                  </li>
                ))}
              </ul>
            )}

            <dl className="totals">
              <div>
                <dt>Subtotal</dt>
                <dd>{money(data.subtotal)}</dd>
              </div>
              {data.discount > 0 && (
                <div>
                  <dt>Discount</dt>
                  <dd>−{money(data.discount)}</dd>
                </div>
              )}
              {data.tax > 0 && (
                <div>
                  <dt>Tax</dt>
                  <dd>{money(data.tax)}</dd>
                </div>
              )}
              <div className="grand">
                <dt>Total</dt>
                <dd>{money(data.grandTotal)}</dd>
              </div>
            </dl>
          </div>
        </>
      )}
    </section>
  );
}
