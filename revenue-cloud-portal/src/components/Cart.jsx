import { useEffect, useMemo, useState } from 'react';
import { useCart } from '../cart.jsx';
import { money } from '../format.js';
import Breadcrumb from './Breadcrumb.jsx';
import Stepper from './Stepper.jsx';
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

// Everything inside the cart - used by both the pop-up (header Cart button) and the full "Your Cart" page.
function CartContent({ byId }) {
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

  // A bundle has no price of its own in the cart: it shows the total of its components (0 until some are added),
  // and the cart total counts only the components.
  const { lineTotal, shownTotal } = useMemo(() => {
    const kidsOf = new Map();
    for (const { line } of ordered) if (line.parentLineId) kidsOf.set(line.parentLineId, [...(kidsOf.get(line.parentLineId) ?? []), line]);
    const total = (line) => {
      if (byId?.get(line.productId)?.isBundle) return (kidsOf.get(line.lineId) ?? []).reduce((n, k) => n + total(k), 0);
      return line.unitPrice * line.quantity;
    };
    const ids = new Set(ordered.map((o) => o.line.lineId));
    return {
      lineTotal: total,
      shownTotal: ordered.filter((o) => !o.line.parentLineId || !ids.has(o.line.parentLineId)).reduce((n, o) => n + total(o.line), 0),
    };
  }, [ordered, byId]);

  const isUpdate = !!quote && !locked;
  const label = saving ? (quote ? 'Updating…' : 'Creating…') : isUpdate ? 'Update Quote' : 'Create Quote';
  const canSave = !saving && !locked && (quote ? dirty : items.length > 0);

  let hint = '';
  if (locked) hint = `Quote ${quote.quoteNumber} is ${quote.status} and can no longer be changed.`;
  else if (quote && !dirty) hint = 'Cart matches the Salesforce quote.';
  else if (quote) hint = 'You have changes that are not in Salesforce yet.';

  return (
    <>
      {quote && (
        <div className={`quote-banner ${locked ? 'locked' : ''}`}>
          <div>
            <span className="muted">Salesforce Quote</span>
            <strong>#{quote.quoteNumber}</strong>
          </div>
          <span className="status">{quote.status}</span>
        </div>
      )}

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
                    {i.code || i.family}{product?.isBundle ? '' : ` · ${money(i.unitPrice)} each`}
                  </small>
                  {canEdit && (
                    <button className="badge-outline line-edit-btn" onClick={() => toggleEditing(i.lineId)}>
                      <SlidersIcon width={12} height={12} /> {editing.has(i.lineId) ? 'Done' : 'Edit attributes'}
                    </button>
                  )}
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
                </div>
                <div className="line-controls">
                  <span className="line-total">{money(lineTotal(i))}</span>
                  <div className="line-actions">
                    {kids > 0 ? (
                      <span className="bundle-note">
                        Bundle · {kids} component{kids === 1 ? '' : 's'}
                      </span>
                    ) : (
                      <Stepper
                        value={i.quantity}
                        label={`quantity for ${i.name}`}
                        minusDisabled={locked || i.quantity <= 1}
                        plusDisabled={locked || i.quantity >= 10000}
                        onMinus={() => cart.setQty(i.lineId, i.quantity - 1)}
                        onPlus={() => cart.setQty(i.lineId, i.quantity + 1)}
                      />
                    )}
                    <button
                      className="icon-btn danger"
                      onClick={() => cart.remove(i.lineId)}
                      disabled={locked}
                      title={kids > 0 ? 'Remove the bundle and its components' : undefined}
                      aria-label={`Remove ${i.name}`}
                    >
                      <TrashIcon width={16} height={16} />
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <dl className="totals">
        <div>
          <dt>Subtotal</dt>
          <dd>{money(shownTotal)}</dd>
        </div>
        <div className="grand">
          <dt>Total</dt>
          <dd>{money(shownTotal)}</dd>
        </div>
      </dl>

      {hint && <p className="hint">{hint}</p>}

      <div className="cart-actions">
        <button className="btn-coral block" disabled={!canSave} onClick={cart.saveQuote}>
          {label}
        </button>
        {items.length > 0 && !locked && (
          <button className="btn-outline block" onClick={cart.clear} disabled={saving}>
            Clear cart
          </button>
        )}
        {quote && (
          <button className="link center" onClick={cart.startNewQuote} disabled={saving}>
            Start a new quote
          </button>
        )}
      </div>
    </>
  );
}

// Pop-up cart opened by the header Cart button.
export default function Cart({ open, onClose, byId }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="modal-scrim" onClick={onClose}>
      <aside className="modal" role="dialog" aria-modal="true" aria-label="Shopping cart" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>Your Cart</h2>
          <div className="modal-head-right">
            <a className="link" href="#/cart" onClick={onClose}>
              Open full page
            </a>
            <button className="icon-btn" onClick={onClose} aria-label="Close cart">
              <CloseIcon />
            </button>
          </div>
        </header>
        <div className="modal-body">
          <CartContent byId={byId} />
        </div>
      </aside>
    </div>
  );
}

// Full-page cart at #/cart.
export function CartPage({ byId }) {
  return (
    <section className="detail">
      <Breadcrumb current="Your Cart" />
      <div className="cart-page">
        <CartContent byId={byId} />
      </div>
    </section>
  );
}
