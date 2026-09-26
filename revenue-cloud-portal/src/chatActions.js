import { displayValue, initialValues, missingRequired, toLineAttributes, valuesByDefinitionId } from './attributes.js';
import { applyConfigRules } from './configRules.js';
import { adjustedPrice } from './pricing.js';

// Adds a product the assistant was asked to add, the same way the store's own pages do:
//  - a plain product: like the card's Add button;
//  - a product with attribute values from the customer: like the Configure page (values saved on the line, price
//    from Salesforce's attribute pricing);
//  - a bundle: like the bundle's Components page with its default choices - the bundle line with its attribute
//    values, plus its Required components and whatever the bundle's rules add automatically, nested under it.
// Returns { added: {...} } for the chat's confirmation line, { failed: 'why' } when it could not be added, or null.
export function addFromChat(cart, byId, action) {
  const product = byId.get(action.productId);
  if (!product || product.unitPrice == null) return null;

  const chosen = (action.attributes ?? []).filter((a) => product.attributes.some((p) => p.name === a.name));
  const values = { ...initialValues(product), ...Object.fromEntries(chosen.map((a) => [a.name, a.value])) };
  const hasAttributes = product.attributes.length > 0;
  const configured = hasAttributes && (product.isBundle || chosen.length > 0);

  const missing = configured ? missingRequired(product, values) : [];
  if (missing.length) return { failed: `${product.name} was not added - it needs: ${missing.join(', ')}` };

  const attributes = configured ? toLineAttributes(product, values) : undefined;
  const byDefinition = valuesByDefinitionId(product, values);
  const unitPrice = configured ? adjustedPrice(product, byDefinition) : undefined;
  const shown = chosen.map((a) => {
    const attr = product.attributes.find((p) => p.name === a.name);
    return `${attr.label}: ${displayValue(attr, a.value)}`;
  });

  if (product.isBundle) {
    // default selection of the Components page: Required components, then the bundle's auto-add rules
    const addableIds = new Set(product.components.filter((c) => byId.get(c.productId)?.unitPrice != null).map((c) => c.productId));
    const required = new Set(product.components.filter((c) => c.required && addableIds.has(c.productId)).map((c) => c.productId));
    const selected = applyConfigRules(required, product.configRules ?? [], addableIds, byDefinition);
    const components = product.components.filter((c) => selected.has(c.productId)).map((c) => ({ product: byId.get(c.productId), quantity: c.quantity }));
    cart.addToBundle([product], components, hasAttributes ? { attributes, unitPrice } : undefined);
    return { added: { quantity: 1, attributes: chosen, shown, components: components.map((c) => c.product.name) } };
  }

  cart.add(product, { quantity: action.quantity, attributes, unitPrice });
  return { added: { quantity: action.quantity, attributes: chosen, shown, components: [] } };
}
