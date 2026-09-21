import { soql } from './salesforce.js';

const escapeSoql = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const idList = (ids) => ids.map((id) => `'${escapeSoql(id)}'`).join(',');
const MAX_BUNDLE_DEPTH = 5;

// Product catalog query from the API documentation, extended with the
// ProductAttributeDefinitions sub-query (requires API v62.0+).
const productQuery = (where, currency) => `
  SELECT Id, Name, ProductCode, Family, Type, Description, DisplayUrl,
    (SELECT Id, UnitPrice, CurrencyIsoCode, Pricebook2Id, Pricebook2.Name, UseStandardPrice
       FROM PricebookEntries
      WHERE Pricebook2.IsStandard = true AND Pricebook2.IsActive = true
        AND IsActive = true AND CurrencyIsoCode = '${escapeSoql(currency)}'),
    (SELECT ProductSellingModel.Name, ProductSellingModel.SellingModelType,
            ProductSellingModel.PricingTerm, ProductSellingModel.PricingTermUnit
       FROM ProductSellingModelOptions),
    (SELECT AttributeDefinitionId, AttributeDefinition.Name, AttributeDefinition.Label,
            AttributeDefinition.DataType, AttributeDefinition.PicklistId, Sequence,
            Status, IsRequired, IsHidden, IsReadOnly, DefaultValue, HelpText,
            AttributeNameOverride, MaximumCharacterCount, DisplayType
       FROM ProductAttributeDefinitions ORDER BY Sequence ASC)
  FROM Product2
  WHERE ${where}
  ORDER BY Name`;

const componentQuery = (parentIds) => `
  SELECT Id, ParentProductId, ChildProductId, Quantity, MinQuantity, MaxQuantity, Sequence,
         IsComponentRequired, IsDefaultComponent, IsQuantityEditable, DoesBundlePriceIncludeChild,
         ProductRelationshipTypeId, QuantityScaleMethod, ProductComponentGroup.Name
    FROM ProductRelatedComponent
   WHERE ParentProductId IN (${idList(parentIds)}) AND ChildProduct.IsActive = true`;

async function picklistValues(picklistIds) {
  const byPicklist = new Map();
  if (!picklistIds.length) return byPicklist;
  const rows = await soql(
    `SELECT Id, PicklistId, Value, Code, IsDefault, Sequence FROM AttributePicklistValue
      WHERE PicklistId IN (${idList(picklistIds)}) AND Status = 'Active' ORDER BY Sequence, Value`,
  );
  for (const r of rows) {
    if (!byPicklist.has(r.PicklistId)) byPicklist.set(r.PicklistId, []);
    byPicklist.get(r.PicklistId).push({ id: r.Id, value: r.Value, code: r.Code, isDefault: !!r.IsDefault });
  }
  return byPicklist;
}

const attributeRecords = (p) => p.ProductAttributeDefinitions?.records ?? [];

function normalize(p, picklists, currency, components) {
  const entry = p.PricebookEntries?.records?.[0];
  return {
    id: p.Id,
    name: p.Name,
    code: p.ProductCode || '',
    family: p.Family || 'Other',
    description: p.Description || '',
    image: p.DisplayUrl || null,
    unitPrice: entry ? entry.UnitPrice : null, // null => no active price, cannot be quoted
    currency: entry?.CurrencyIsoCode || currency,
    isBundle: p.Type === 'Bundle',
    sellingModels: (p.ProductSellingModelOptions?.records ?? []).map((o) => ({
      name: o.ProductSellingModel?.Name,
      type: o.ProductSellingModel?.SellingModelType,
      term: o.ProductSellingModel?.PricingTerm,
      termUnit: o.ProductSellingModel?.PricingTermUnit,
    })),
    // Only attributes a customer may see/set: active and not hidden.
    attributes: attributeRecords(p)
      .filter((a) => a.Status === 'Active' && !a.IsHidden)
      .map((a) => {
        const dataType = a.AttributeDefinition?.DataType;
        const values = picklists.get(a.AttributeDefinition?.PicklistId) ?? [];
        return {
          id: a.AttributeDefinitionId,
          name: a.AttributeDefinition?.Name,
          label: a.AttributeNameOverride || a.AttributeDefinition?.Label || a.AttributeDefinition?.Name,
          dataType,
          // a required picklist with no active values could never be satisfied
          required: !!a.IsRequired && !(dataType === 'Picklist' && values.length === 0),
          readOnly: !!a.IsReadOnly,
          defaultValue: a.DefaultValue ?? null,
          helpText: a.HelpText || '',
          displayType: a.DisplayType || null,
          maxLength: a.MaximumCharacterCount ?? null,
          values,
        };
      }),
    components: components.get(p.Id) ?? [],
  };
}

async function loadCatalog() {
  const catalog = process.env.SF_CATALOG_NAME || 'DeepHealth Product Catalog';
  const currency = process.env.SF_CURRENCY || 'USD';

  const catalogRows = await soql(
    productQuery(
      `IsActive = true AND Id IN (SELECT ProductId FROM ProductCategoryProduct
                                   WHERE ProductCategory.Catalog.Name = '${escapeSoql(catalog)}')`,
      currency,
    ),
  );

  // Bundles: read their child components, following nested bundles. Children that are not
  // in the catalog themselves are loaded too, so they can be shown and quoted.
  const known = new Set(catalogRows.map((r) => r.Id));
  const componentRows = new Map(); // parentId -> [component]
  const extraRows = [];
  let frontier = catalogRows.filter((r) => r.Type === 'Bundle').map((r) => r.Id);

  for (let depth = 0; depth < MAX_BUNDLE_DEPTH && frontier.length; depth++) {
    const comps = await soql(componentQuery(frontier));
    for (const c of comps) {
      if (!componentRows.has(c.ParentProductId)) componentRows.set(c.ParentProductId, []);
      componentRows.get(c.ParentProductId).push({
        componentId: c.Id, // ProductRelatedComponent - recorded on the quote's bundle relationship
        relationshipTypeId: c.ProductRelationshipTypeId,
        scaleMethod: c.QuantityScaleMethod || null,
        productId: c.ChildProductId,
        // whole units only - the quote API takes integer quantities
        quantity: Math.max(1, Math.ceil(c.Quantity || 1)),
        min: c.MinQuantity ?? null,
        max: c.MaxQuantity ?? null,
        required: !!c.IsComponentRequired,
        isDefault: !!c.IsDefaultComponent,
        quantityEditable: !!c.IsQuantityEditable,
        priceIncluded: !!c.DoesBundlePriceIncludeChild,
        group: c.ProductComponentGroup?.Name || '',
        sequence: c.Sequence ?? 9999,
      });
    }
    const missing = [...new Set(comps.map((c) => c.ChildProductId))].filter((id) => !known.has(id));
    if (!missing.length) break;
    const kids = await soql(productQuery(`IsActive = true AND Id IN (${idList(missing)})`, currency));
    for (const k of kids) {
      known.add(k.Id);
      extraRows.push(k);
    }
    frontier = kids.filter((k) => k.Type === 'Bundle').map((k) => k.Id);
  }
  for (const list of componentRows.values()) list.sort((a, b) => a.sequence - b.sequence);

  const picklistIds = [
    ...new Set([...catalogRows, ...extraRows].flatMap((p) => attributeRecords(p).map((a) => a.AttributeDefinition?.PicklistId).filter(Boolean))),
  ];
  const picklists = await picklistValues(picklistIds);

  return {
    products: catalogRows.map((p) => normalize(p, picklists, currency, componentRows)),
    // bundle children that are not listed in the catalog themselves
    componentProducts: extraRows.map((p) => normalize(p, picklists, currency, componentRows)),
  };
}

// The catalog changes rarely; a short cache keeps the storefront snappy and lets the
// quote endpoints re-price cart lines from Salesforce instead of trusting the browser.
const TTL_MS = 60_000;
let cache = { at: 0, data: null, pending: null };

export async function getProducts({ fresh = false } = {}) {
  if (!fresh && cache.data && Date.now() - cache.at < TTL_MS) return cache.data;
  if (!cache.pending) {
    cache.pending = loadCatalog()
      .then((data) => {
        cache = { at: Date.now(), data, pending: null };
        return data;
      })
      .catch((err) => {
        cache.pending = null;
        throw err;
      });
  }
  return cache.pending;
}
