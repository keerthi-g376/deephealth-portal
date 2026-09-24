import { useMemo, useState } from 'react';
import { initialValues, isConfigurable, missingRequired, toLineAttributes, valuesByDefinitionId } from '../attributes.js';
import { useCart } from '../cart.jsx';
import { applyConfigRules, requiredByRules } from '../configRules.js';
import { money, sellingModelLabel } from '../format.js';
import { adjustedPrice } from '../pricing.js';
import { AttributeField } from './ConfigurePage.jsx';
import { ArrowLeftIcon, CartIcon, LayersIcon, SlidersIcon } from './icons.jsx';

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Math.floor(Number(n)) || lo));

// Bundle page: lists the child products of a bundle; any of them can be selected and added to the cart,
// where they appear nested under the bundle. `chain` is the path of bundles that led here (outermost
// first, ending with `product`), so components of a nested bundle land under their own bundle.
export default function BundlePage({ product, chain, byId, onBack }) {
  const cart = useCart();

  const groups = useMemo(() => {
    const out = [];
    const index = new Map();
    for (const c of product.components) {
      const child = byId.get(c.productId);
      if (!child) continue;
      const name = c.group || 'Components';
      if (!index.has(name)) {
        index.set(name, out.length);
        out.push({ name, rows: [] });
      }
      out[index.get(name)].rows.push({ ...c, child });
    }
    return out;
  }, [product, byId]);

  const rows = groups.flatMap((g) => g.rows);
  const addable = rows.filter((r) => r.child.unitPrice != null);
  const addableIds = useMemo(() => new Set(addable.map((r) => r.productId)), [addable]);
  const rules = product.configRules ?? [];

  // The bundle's own attributes (e.g. Center of Excellence: AI powered Detection). Their values set the
  // bundle's price (Attribute Based Adjustments), can trigger Configurator rules, and are saved on the bundle line.
  const hasAttributes = product.attributes.length > 0;
  const [attrValues, setAttrValues] = useState(() => initialValues(product));
  const attrsById = useMemo(() => valuesByDefinitionId(product, attrValues), [product, attrValues]);
  const bundlePrice = product.unitPrice == null ? null : adjustedPrice(product, attrsById);
  const missingAttrs = missingRequired(product, attrValues);

  // Required components are pre-selected when the bundle page opens (unless unpriced), and any
  // Configurator rule that fires as a result (e.g. "OS requires RIS") is applied immediately too.
  const [selected, setSelected] = useState(() =>
    applyConfigRules(
      new Set(product.components.filter((c) => c.required && addableIds.has(c.productId)).map((c) => c.productId)),
      rules,
      addableIds,
      attrsById,
    ),
  );
  const [qtys, setQtys] = useState({});

  // Products currently selected only because a rule requires them right now - their checkbox is
  // locked so unchecking one can't "stick" while the product that triggers the rule is still selected.
  const lockedByRule = useMemo(() => requiredByRules(selected, rules, attrsById), [selected, rules, attrsById]);

  // Changing an attribute can trigger a rule (e.g. AI powered Detection = Yes adds SmartMammo AI).
  const changeAttribute = (name, value) => {
    const next = { ...attrValues, [name]: value };
    setAttrValues(next);
    setSelected((s) => applyConfigRules(s, rules, addableIds, valuesByDefinitionId(product, next)));
  };

  const qtyOf = (r) => qtys[r.productId] ?? r.quantity;

  const toggle = (id) => {
    if (lockedByRule.has(id)) return;
    setSelected((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return applyConfigRules(next, rules, addableIds, attrsById);
    });
  };

  // a bundle can only be quoted if it (and every bundle above it) has a price
  const unpricedBundle = chain.find((b) => b.unitPrice == null);
  const chainPath = chain.map((b) => b.id).join('/');

  const addSelected = () => {
    const chosen = addable.filter((r) => selected.has(r.productId));
    cart.addToBundle(
      chain,
      chosen.map((r) => ({ product: r.child, quantity: qtyOf(r) })),
      hasAttributes ? { attributes: toLineAttributes(product, attrValues), unitPrice: bundlePrice } : undefined,
    );
    setSelected(new Set());
    cart.notify('success', `${chosen.length} product${chosen.length === 1 ? '' : 's'} added to the cart under ${product.name}`);
  };

  return (
    <section className="detail">
      <button className="back" onClick={onBack}>
        <ArrowLeftIcon /> Back
      </button>

      <div className="detail-head">
        <span className="detail-icon">
          <LayersIcon width={30} height={30} />
        </span>
        <div>
          <h1 className="title small">{product.name}</h1>
          <p className="detail-sub">
            Bundle{product.code && <> · {product.code}</>} · {rows.length} component{rows.length === 1 ? '' : 's'}
          </p>
          {product.sellingModels.length > 0 && (
            <div className="chips">
              {product.sellingModels.map((m, i) => (
                <span className="chip" key={i}>
                  {sellingModelLabel(m)}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      <p className="note">
        Select the products you want. They are added to the cart nested under {product.name}, each at its own standard price.
      </p>
      {unpricedBundle && <p className="note warn">{unpricedBundle.name} has no active price, so its components can't be quoted.</p>}

      {hasAttributes && (
        <div className="panel">
          <h2>Attributes</h2>
          {product.attributes.map((a) => (
            <AttributeField key={a.id} attr={a} value={attrValues[a.name] ?? ''} onChange={(v) => changeAttribute(a.name, v)} />
          ))}
          {bundlePrice != null && (
            <div className="bundle-price">
              <span>Bundle price</span>
              <strong>{money(bundlePrice, product.currency)}</strong>
            </div>
          )}
          {missingAttrs.length > 0 && <p className="hint left">Required: {missingAttrs.join(', ')}</p>}
        </div>
      )}

      {rows.length === 0 && <p className="state">This bundle has no available components.</p>}

      {groups.map((g) => (
        <div className="panel" key={g.name}>
          <h2>{g.name}</h2>
          <ul className="comps">
            {g.rows.map((r) => {
              const c = r.child;
              const priced = c.unitPrice != null;
              const locked = lockedByRule.has(r.productId);
              const lo = r.min ?? 1;
              const hi = r.max ?? 10000;
              return (
                <li className={`comp ${priced ? '' : 'unavailable'}`} key={r.productId}>
                  <input
                    type="checkbox"
                    className="comp-check"
                    checked={selected.has(r.productId)}
                    disabled={!priced || locked}
                    onChange={() => toggle(r.productId)}
                    aria-label={`Select ${c.name}`}
                  />
                  <div className="comp-info">
                    <strong>{c.name}</strong>
                    <small>{[c.code, c.family].filter(Boolean).join(' · ')}</small>
                    <div className="tags">
                      {r.required && <span className="tag tag-req">Required</span>}
                      {locked && <span className="tag tag-req">Required by rule</span>}
                      {r.isDefault && <span className="tag">Default</span>}
                      {r.priceIncluded && <span className="tag">Price included in bundle</span>}
                      {c.isBundle && <span className="tag tag-bundle">Bundle</span>}
                    </div>
                  </div>
                  <div className="comp-price">{priced ? money(c.unitPrice, c.currency) : <small>No active price</small>}</div>
                  <input
                    type="number"
                    className="field text-field qty-field"
                    min={lo}
                    max={hi}
                    value={qtyOf(r)}
                    disabled={!r.quantityEditable || !priced}
                    onChange={(e) => setQtys((q) => ({ ...q, [r.productId]: clamp(e.target.value, lo, hi) }))}
                    aria-label={`Quantity for ${c.name}`}
                  />
                  <div className="comp-actions">
                    {c.isBundle && !chain.some((b) => b.id === c.id) && (
                      <a className="icon-btn" href={`#/bundle/${chainPath}/${c.id}`} title="View the components of this bundle" aria-label={`Components of ${c.name}`}>
                        <LayersIcon />
                      </a>
                    )}
                    {isConfigurable(c) && (
                      <a className="icon-btn" href={`#/configure/${c.id}`} title="Configure attributes" aria-label={`Configure ${c.name}`}>
                        <SlidersIcon />
                      </a>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ))}

      {addable.length > 0 && (
        <div className="action-bar">
          <button className="link" onClick={() => setSelected(new Set(selected.size === addable.length ? [] : addable.map((r) => r.productId)))}>
            {selected.size === addable.length ? 'Clear selection' : 'Select all'}
          </button>
          <button className="btn btn-primary fit" disabled={selected.size === 0 || !!unpricedBundle || missingAttrs.length > 0} onClick={addSelected}>
            <CartIcon /> Add selected to cart ({selected.size})
          </button>
        </div>
      )}
    </section>
  );
}
