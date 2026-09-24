// Helpers for product attributes (configurable options such as "AI Modality").

export const isConfigurable = (product) => product.attributes.length > 0;

// Starting value for one attribute: the product's default, else the picklist's default value.
function defaultFor(attr) {
  if (attr.dataType === 'Checkbox') return String(attr.defaultValue).toLowerCase() === 'true' ? 'true' : 'false';
  if (attr.dataType === 'Picklist') {
    if (attr.defaultValue && attr.values.some((v) => v.value === attr.defaultValue)) return attr.defaultValue;
    return attr.values.find((v) => v.isDefault)?.value ?? '';
  }
  return attr.defaultValue ?? '';
}

export const initialValues = (product) => Object.fromEntries(product.attributes.map((a) => [a.name, defaultFor(a)]));

export const displayValue = (attr, value) => (attr.dataType === 'Checkbox' ? (value === 'true' ? 'Yes' : 'No') : value);

// Names of required attributes that still have no value.
export const missingRequired = (product, values) =>
  product.attributes.filter((a) => a.required && !String(values[a.name] ?? '').trim()).map((a) => a.label);

// The attribute selection as stored on a cart line.
export const toLineAttributes = (product, values) =>
  product.attributes
    .filter((a) => String(values[a.name] ?? '').trim() !== '')
    .map((a) => ({ name: a.name, label: a.label, value: values[a.name], display: displayValue(a, values[a.name]) }));

// Chosen values keyed by AttributeDefinition id (what attribute-based pricing looks at), built from
// values keyed by attribute name (the Configure form) or from a cart line's saved attributes.
export const valuesByDefinitionId = (product, valuesByName) =>
  Object.fromEntries(product.attributes.map((a) => [a.id, valuesByName[a.name] ?? '']));

export const lineValuesByDefinitionId = (product, attributes = []) =>
  valuesByDefinitionId(product, Object.fromEntries(attributes.map((a) => [a.name, a.value])));

// Two lines are the same cart line only if product AND attribute choices match.
export const attributeKey = (attributes = []) =>
  attributes
    .map((a) => `${a.name}=${a.value}`)
    .sort()
    .join(';');
