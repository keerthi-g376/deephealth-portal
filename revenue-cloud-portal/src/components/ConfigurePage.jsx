import { useState } from 'react';
import { initialValues, missingRequired, toLineAttributes, valuesByDefinitionId } from '../attributes.js';
import { useCart } from '../cart.jsx';
import { money, sellingModelLabel } from '../format.js';
import { adjustedPrice } from '../pricing.js';
import Breadcrumb from './Breadcrumb.jsx';
import Stepper from './Stepper.jsx';
import { CartIcon } from './icons.jsx';

export function AttributeField({ attr, value, onChange }) {
  const id = `attr-${attr.id}`;
  let control;
  if (attr.dataType === 'Picklist') {
    control = (
      <select id={id} className="select field" value={value} disabled={attr.readOnly} onChange={(e) => onChange(e.target.value)}>
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
    <div className="attr-field">
      <label htmlFor={id}>
        {attr.label}
        {attr.required && <span className="req" title="Required"> *</span>}
      </label>
      {control}
      {attr.helpText && <small>{attr.helpText}</small>}
    </div>
  );
}

// Configure Product page: pick attribute values, then add the configured product to the cart.
export default function ConfigurePage({ product, onBack }) {
  const cart = useCart();
  const [values, setValues] = useState(() => initialValues(product));
  // Kept as text while typing so the field can be emptied and retyped; the number used is derived from it.
  const [qtyText, setQtyText] = useState('1');
  const qty = Math.min(10000, Math.max(1, Math.floor(Number(qtyText)) || 1));

  const priced = product.unitPrice != null;
  const missing = missingRequired(product, values);
  const canAdd = priced && missing.length === 0;
  // the price can depend on the attribute values chosen (Attribute Based Adjustments in Salesforce)
  const unitPrice = priced ? adjustedPrice(product, valuesByDefinitionId(product, values)) : null;

  const add = () => {
    cart.add(product, { quantity: qty, attributes: toLineAttributes(product, values), unitPrice });
    cart.notify('success', `${product.name} added to the cart`);
  };

  const term = product.sellingModels.length > 0 ? sellingModelLabel(product.sellingModels[0]) : '';

  return (
    <section className="detail">
      <Breadcrumb current="Configure" />

      <div className="page-head">
        <h1>{product.name}</h1>
        {term && <span className="tag-pill tag-green">{term}</span>}
      </div>
      <p className="detail-sub">{[product.code, product.family].filter(Boolean).join(' · ')}</p>
      <p className="note">Choose the attribute values you want, then add the product to the cart.</p>

      <div className="panel">
        <h2>Attributes</h2>
        {product.attributes.map((a) => (
          <AttributeField key={a.id} attr={a} value={values[a.name] ?? ''} onChange={(v) => setValues((s) => ({ ...s, [a.name]: v }))} />
        ))}

        <div className="attr-field">
          <label>Quantity</label>
          <Stepper
            value={qty}
            label="quantity"
            minusDisabled={qty <= 1}
            plusDisabled={qty >= 10000}
            onMinus={() => setQtyText(String(qty - 1))}
            onPlus={() => setQtyText(String(qty + 1))}
          />
        </div>

        <div className="configure-foot">
          <div className="price">
            {priced ? (
              <>
                <strong>{money(unitPrice * qty, product.currency)}</strong>
                <small>{money(unitPrice, product.currency)} per unit</small>
              </>
            ) : (
              <small>No active price - this product cannot be quoted</small>
            )}
          </div>
          <button className="btn-soft fit" disabled={!canAdd} onClick={add}>
            <CartIcon width={14} height={14} /> Add
          </button>
        </div>
        {priced && missing.length > 0 && <p className="hint left">Required: {missing.join(', ')}</p>}
      </div>
    </section>
  );
}
