// Attribute-based pricing: the price of a product can depend on the attribute values a customer
// picks (Salesforce "Attribute Based Adjustments"). This one function is shared by the storefront
// (to show the price) and the server (to re-price every quote line, so the browser cannot set prices).
//
// product.attributePricing = [{ type: 'Override' | 'Amount', value, conditions: [{ attributeId, operator, valueType, value }] }]
// valuesByDefinitionId      = { [AttributeDefinition Id]: chosen value }  ('' / missing = not chosen)

const toBool = (v) => {
  const s = String(v).trim().toLowerCase();
  if (['true', 'yes', 'y', '1'].includes(s)) return true;
  if (['false', 'no', 'n', '0'].includes(s)) return false;
  return null;
};

function conditionHolds(c, actual) {
  if (actual == null || String(actual).trim() === '') return false; // attribute not chosen: cannot match
  let equal;
  if (c.valueType === 'boolean') {
    const b = toBool(actual);
    if (b === null) return false;
    equal = b === c.value;
  } else if (c.valueType === 'number') {
    equal = Number(actual) === Number(c.value);
  } else {
    equal = String(actual).trim().toLowerCase() === String(c.value).trim().toLowerCase();
  }
  return c.operator === 'notequals' ? !equal : equal;
}

// The price for a product given the attribute values chosen. When several adjustments match, the
// most specific one (most conditions) wins. No match = the normal list price.
export function adjustedPrice(product, valuesByDefinitionId = {}) {
  const base = product.unitPrice;
  if (base == null) return null;
  let best = null;
  for (const adj of product.attributePricing ?? []) {
    if (!adj.conditions.every((c) => conditionHolds(c, valuesByDefinitionId[c.attributeId]))) continue;
    if (!best || adj.conditions.length > best.conditions.length) best = adj;
  }
  if (!best) return base;
  return best.type === 'Override' ? best.value : base + best.value; // 'Amount'
}
