import { useMemo } from 'react';
import { useCart } from '../cart.jsx';
import { money } from '../format.js';
import { CloseIcon, TrashIcon } from './icons.jsx';

export default function Cart({ open, onClose, taxRate }) {
  const cart = useCart();
  const { items, quote, dirty, locked, saving } = cart;

  // Lines in display order: each bundle is followed by its components (indented), like the Salesforce quote.
  const ordered = useMemo(() => {
    const ids = new Set(items.map((i) => i.lineId));
    const children = new Map();
    const roots = [];
    for (const i of items) {
      if (i.parentLineId && ids.has(i.parentLineId)) {
        if (!children.has(i.parentLineId)) children.set(i.parentLineId, []);
        children.get(i.parentLineId).push(i);
      } else roots.push(i);
    }
    const out = [];
    const walk = (line, depth) => {
      out.push({ line, depth, kids: children.get(line.lineId)?.length ?? 0 });
      (children.get(line.lineId) ?? []).forEach((k) => walk(k, depth + 1));
    };
    roots.forEach((r) => walk(r, 0));
    return out;
  }, [items]);

  const isUpdate = !!quote && !locked;
  const label = saving ? (quote ? 'Updating…' : 'Creating…') : isUpdate ? 'Update Quote' : 'Create Quote';
  const canSave = !saving && !locked && (quote ? dirty : items.length > 0);

  let hint = '';
  if (locked) hint = `Quote ${quote.quoteNumber} is ${quote.status} and can no longer be changed.`;
  else if (quote && !dirty) hint = 'Cart matches the Salesforce quote.';
  else if (quote) hint = 'You have changes that are not in Salesforce yet.';

  return (
    <>
      <div className={`scrim ${open ? 'show' : ''}`} onClick={onClose} />
      <aside className={`drawer ${open ? 'open' : ''}`} aria-label="Shopping cart" aria-hidden={!open}>
        <header className="drawer-head">
          <h2>Your Cart</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close cart">
            <CloseIcon />
          </button>
        </header>

        {quote && (
          <div className={`quote-banner ${locked ? 'locked' : ''}`}>
            <div>
              <span className="muted">Salesforce Quote</span>
              <strong>#{quote.quoteNumber}</strong>
            </div>
            <span className="status">{quote.status}</span>
          </div>
        )}

        <div className="drawer-body">
          {items.length === 0 ? (
            <p className="empty">
              {quote ? 'The cart is empty. Updating will remove all products from the quote.' : 'Your cart is empty. Add products to get started.'}
            </p>
          ) : (
            <ul className="lines">
              {ordered.map(({ line: i, depth, kids }) => (
                <li className={`line ${depth > 0 ? 'child' : ''}`} style={depth > 0 ? { marginLeft: depth * 18 } : undefined} key={i.lineId}>
                  <div className="line-info">
                    <strong>{i.name}</strong>
                    <small>
                      {i.code || i.family} · {money(i.unitPrice)} each
                    </small>
                    {i.attributes.length > 0 && (
                      <ul className="line-attrs">
                        {i.attributes.map((a) => (
                          <li key={a.name}>
                            <span>{a.label}:</span> {a.display}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div className="line-controls">
                    {kids > 0 ? (
                      <span className="bundle-note">
                        Bundle · {kids} component{kids === 1 ? '' : 's'}
                      </span>
                    ) : (
                      <div className="qty">
                        <button onClick={() => cart.setQty(i.lineId, i.quantity - 1)} disabled={locked || i.quantity <= 1} aria-label="Decrease quantity">
                          −
                        </button>
                        <input
                          type="number"
                          min="1"
                          max="10000"
                          value={i.quantity}
                          disabled={locked}
                          onChange={(e) => cart.setQty(i.lineId, e.target.value)}
                          aria-label={`Quantity for ${i.name}`}
                        />
                        <button onClick={() => cart.setQty(i.lineId, i.quantity + 1)} disabled={locked} aria-label="Increase quantity">
                          +
                        </button>
                      </div>
                    )}
                    <span className="line-total">{money(i.unitPrice * i.quantity)}</span>
                    <button
                      className="icon-btn danger"
                      onClick={() => cart.remove(i.lineId)}
                      disabled={locked}
                      title={kids > 0 ? 'Remove the bundle and its components' : undefined}
                      aria-label={`Remove ${i.name}`}
                    >
                      <TrashIcon />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <footer className="drawer-foot">
          <dl className="totals">
            <div>
              <dt>Subtotal</dt>
              <dd>{money(cart.subtotal)}</dd>
            </div>
            <div>
              <dt>Tax ({Math.round(taxRate * 100)}%)</dt>
              <dd>{money(cart.tax)}</dd>
            </div>
            <div className="grand">
              <dt>Total</dt>
              <dd>{money(cart.total)}</dd>
            </div>
          </dl>

          {hint && <p className="hint">{hint}</p>}

          <button className="btn btn-primary" disabled={!canSave} onClick={cart.saveQuote}>
            {label}
          </button>

          <div className="foot-links">
            {items.length > 0 && !locked && (
              <button className="link" onClick={cart.clear} disabled={saving}>
                Clear cart
              </button>
            )}
            {quote && (
              <button className="link" onClick={cart.startNewQuote} disabled={saving}>
                Start a new quote
              </button>
            )}
          </div>
        </footer>
      </aside>
    </>
  );
}
