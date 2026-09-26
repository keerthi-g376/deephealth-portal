import { useMemo, useState } from 'react';
import { useCart } from '../cart.jsx';
import { money } from '../format.js';
import { CloseIcon, SlidersIcon, TrashIcon } from './icons.jsx';

// One attribute of a cart line, editable in place.
function LineAttribute({ attr, value, onChange }) {
  const id = `line-attr-${attr.id}-${attr.name}`;
  let control;
  if (attr.dataType === 'Picklist') {
    control = (
      <select id={id} className="select" value={value} disabled={attr.readOnly} onChange={(e) => onChange(e.target.value)}>
        <option value="">{attr.required ? 'Select…' : '— None —'}</option>
        {attr.values.map((v) => (
          <option key={v.code || v.value} value={v.value}>
            {v.value}
          </option>
        ))}
      </select>
    );
  } else if (attr.dataType === 'Checkbox') {
    control = (
      <label className="check">
        <input id={id} type="checkbox" checked={value === 'true'} disabled={attr.readOnly} onChange={(e) => onChange(String(e.target.checked))} />
        <span>{value === 'true' ? 'Yes' : 'No'}</span>
      </label>
    );
  } else {
    control = (
      <input
        id={id}
        className="field text-field"
        type={attr.dataType === 'Number' ? 'number' : 'text'}
        value={value}
        maxLength={attr.maxLength || undefined}
        disabled={attr.readOnly}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <div className="line-attr">
      <label htmlFor={id}>
        {attr.label}
        {attr.required && <span className="req"> *</span>}
      </label>
      {control}
    </div>
  );
}

export default function Cart({ open, onClose, byId }) {
  const cart = useCart();
  const { items, quote, dirty, locked, saving } = cart;
  const [editing, setEditing] = useState(() => new Set()); // lines whose attributes are open for editing
  const toggleEditing = (lineId) =>
    setEditing((s) => {
      const next = new Set(s);
      next.has(lineId) ? next.delete(lineId) : next.add(lineId);
      return next;
    });

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
              {ordered.map(({ line: i, depth, kids }) => {
                // a line can be edited when its product has attributes (and the quote can still be changed)
                const product = byId?.get(i.productId);
                const canEdit = !locked && (product?.attributes.length ?? 0) > 0;
                return (
                <li className={`line ${depth > 0 ? 'child' : ''}`} style={depth > 0 ? { marginLeft: depth * 18 } : undefined} key={i.lineId}>
                  <div className="line-info">
                    <strong>{i.name}</strong>
                    <small>
                      {i.code || i.family} · {money(i.unitPrice)} each
                    </small>
                    {editing.has(i.lineId) && product ? (
                      <div className="line-edit">
                        {product.attributes.map((a) => (
                          <LineAttribute
                            key={a.id}
                            attr={a}
                            value={i.attributes.find((x) => x.name === a.name)?.value ?? ''}
                            onChange={(v) => cart.setAttribute(i.lineId, a.name, v, byId)}
                          />
                        ))}
                      </div>
                    ) : (
                      i.attributes.length > 0 && (
                        <ul className="line-attrs">
                          {i.attributes.map((a) => (
                            <li key={a.name}>
                              <span>{a.label}:</span> {a.display}
                            </li>
                          ))}
                        </ul>
                      )
                    )}
                    {canEdit && (
                      <button className="link line-edit-btn" onClick={() => toggleEditing(i.lineId)}>
                        <SlidersIcon width={14} height={14} /> {editing.has(i.lineId) ? 'Done' : 'Edit attributes'}
                      </button>
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
                );
              })}
            </ul>
          )}
        </div>

        <footer className="drawer-foot">
          <dl className="totals">
            <div>
              <dt>Subtotal</dt>
              <dd>{money(cart.subtotal)}</dd>
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
