import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useCart } from '../cart.jsx';
import { money } from '../format.js';
import Breadcrumb from './Breadcrumb.jsx';

const day = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s ?? '');
  return m ? new Date(+m[1], m[2] - 1, +m[3]).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : s;
};

// Quote details page: opened from the quote pill in the header. Everything shown is read from the
// Salesforce quote itself (its fields and its saved line items), so it is exactly what Salesforce holds.
export default function QuotePage({ id }) {
  const { quote: linked, dirty } = useCart();
  const quoteId = id || linked?.id;
  const quote = linked?.id === quoteId ? linked : quoteId ? { id: quoteId } : null; // the cart's own quote, or one opened from My Quotations
  const [state, setState] = useState({ status: 'loading', data: null, error: '' });

  // re-read the quote whenever it is saved or changes status
  useEffect(() => {
    if (!quoteId) return undefined;
    let live = true;
    setState((s) => ({ ...s, status: s.data ? 'ready' : 'loading', error: '' }));
    api
      .getQuote(quoteId)
      .then((data) => live && setState({ status: 'ready', data, error: '' }))
      .catch((e) => live && setState((s) => ({ ...s, status: 'error', error: e.message })));
    return () => {
      live = false;
    };
  }, [quoteId, quote?.status, quote?.grandTotal, dirty]);

  if (!quoteId) {
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
        ['Requested by', data.ownerName],
        ['Quote Source', data.quoteSource],
        ['Notes', data.notes],
      ].filter(([, v]) => v)
    : [];

  return (
    <section className="detail">
      <Breadcrumb current={`Quote #${data?.quoteNumber ?? quote.quoteNumber ?? ''}`} />
      <div className="page-head">
        <h1>Quote #{data?.quoteNumber ?? quote.quoteNumber}</h1>
        <span className="tag-pill tag-green">{data?.status ?? quote.status}</span>
      </div>
      <p className="detail-sub">Quote details, addresses and products</p>
      {data && (data.status === 'Draft' && linked?.id === quoteId ? (
        <p className="note">This quote is a draft. To change products or quantities, <a href="#/cart">open the cart</a> and click <strong>Update Quote</strong>.</p>
      ) : (
        <p className="note warn">This quote is {data.status} and can no longer be changed.</p>
      ))}

      {linked?.id === quoteId && dirty && <p className="note warn">Your cart has changes that are not in this quote yet. Open the cart and choose Update Quote.</p>}
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
            <h2>Addresses</h2>
            <dl className="facts">
              {[['Billing address', data.billing], ['Shipping address', data.shipping]].map(([label, a]) => {
                const lines = [a?.name, a?.street, [a?.city, a?.state, a?.postalCode].filter(Boolean).join(', '), a?.country].filter(Boolean);
                return (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{lines.length ? lines.map((l, i) => <div key={i}>{l}</div>) : 'Not provided'}</dd>
                  </div>
                );
              })}
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
                        {[p.category, `${money(p.price, data.currencyCode)} × ${p.qty}`].filter(Boolean).join(' · ')}
                      </small>
                    </div>
                    <span className="line-total">{money(p.price * p.qty, data.currencyCode)}</span>
                  </li>
                ))}
              </ul>
            )}

            <dl className="totals">
              <div>
                <dt>Subtotal</dt>
                <dd>{money(data.subtotal, data.currencyCode)}</dd>
              </div>
              {data.discount > 0 && (
                <div>
                  <dt>Discount</dt>
                  <dd>−{money(data.discount, data.currencyCode)}</dd>
                </div>
              )}
              {data.tax > 0 && (
                <div>
                  <dt>Tax</dt>
                  <dd>{money(data.tax, data.currencyCode)}</dd>
                </div>
              )}
              <div className="grand">
                <dt>Total</dt>
                <dd>{money(data.grandTotal, data.currencyCode)}</dd>
              </div>
            </dl>
          </div>
        </>
      )}
    </section>
  );
}
