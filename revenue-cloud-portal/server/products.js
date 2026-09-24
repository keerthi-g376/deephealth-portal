import { soql } from './salesforce.js';

const escapeSoql = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const idList = (ids) => ids.map((id) => `'${escapeSoql(id)}'`).join(',');
const MAX_BUNDLE_DEPTH = 5;

// Product catalog query from the API documentation, extended with the
// ProductAttributeDefinitions sub-query (requires API v62.0+).
const productQuery = (where, currency) => `
  SELECT Id, Name, ProductCode, Family, Type, Description, DisplayUrl, BasedOnId,
    (SELECT Id, UnitPrice, CurrencyIsoCode, Pricebook2Id, Pricebook2.Name, UseStandardPrice
       FROM PricebookEntries
      WHERE Pricebook2.IsStandard = true AND Pricebook2.IsActive = true
        AND IsActive = true AND CurrencyIsoCode = '${escapeSoql(currency)}'),
    (SELECT ProductSellingModelId, ProductSellingModel.Name, ProductSellingModel.SellingModelType,
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

// Reads active, Bundle-scoped Configurator rules (e.g. "if Product A is selected, auto-add
// Product B") built in Setup > Product Configurator > Configuration Rules, and turns their
// internal JSON into a small generic shape the storefront can evaluate itself. Unrecognised
// or malformed rules are skipped rather than failing the whole catalog load.
function productIdsFromTagInfo(info, tagName) {
  const tag = (info ?? []).find((t) => t.type === 'Tag' && t.name === tagName);
  return (tag?.values?.values ?? []).filter(Boolean);
}

async function loadConfigurationRules(componentIdToProductId) {
  let rows;
  try {
    rows = await soql(
      `SELECT Id, ConfigurationRuleDefinition FROM ProductConfigurationRule
        WHERE Status = 'Active' AND RuleType = 'Configurator' AND ProcessScope = 'Bundle'`,
    );
  } catch {
    return []; // org may not have Product Configurator / Constraint Rules enabled
  }

  const rules = [];
  for (const row of rows) {
    let def;
    try {
      def = JSON.parse(row.ConfigurationRuleDefinition);
    } catch {
      continue;
    }
    const bundleProductId15 = String(def.criteria?.[0]?.rootObjectId ?? '').slice(0, 15);
    if (!bundleProductId15) continue;

    // A criterion can also carry attribute conditions ("Product = the bundle AND AI powered Detection = Yes").
    // Those are only understood when they are on the bundle itself (its attributes are what the bundle page
    // shows); a rule with any other attribute condition is skipped rather than run half-understood.
    let understood = true;
    const criteria = (def.criteria ?? [])
      .map((c) => {
        const productIds = productIdsFromTagInfo(c.sourceInformation, 'Product');
        const onBundle = productIds.some((id) => id.slice(0, 15) === bundleProductId15);
        const attributes = (c.conditions ?? [])
          .filter((x) => x.type === 'Attribute')
          .map((x) => ({ attributeId: String(x.attributeId ?? '').slice(0, 15), operator: x.operator, values: (x.values ?? []).map(String) }));
        if (attributes.length && (!onBundle || attributes.some((x) => !x.attributeId || !['Equals', 'Not Equals', 'In', 'Not In'].includes(x.operator)))) {
          understood = false;
        }
        return { operator: c.sourceOperator || 'Equals', productIds, onBundle, attributes };
      })
      .filter((c) => c.productIds.length);
    if (!understood) continue;

    const actions = (def.actions ?? [])
      .filter((a) => a.actionType === 'AutoAdd')
      .map((a) => {
        // usually a Product tag is on the action itself; fall back to the target
        // ProductRelatedComponent id, which every bundle component's id is already keyed by.
        const productId =
          productIdsFromTagInfo(a.targetInformation, 'Product')[0] ||
          componentIdToProductId.get(a.targetValues?.[0]) ||
          null;
        return productId ? { productId } : null;
      })
      .filter(Boolean);

    if (criteria.length && actions.length) {
      rules.push({ bundleProductId15, mode: def.criteriaExpressionType === 'Any' ? 'Any' : 'All', criteria, actions });
    }
  }
  return rules;
}

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

// Attribute Based Adjustments (Setup > Product > Attribute Based Adjustment): "when attribute X = Y,
// the price becomes / changes by Z". Read for the given products and turned into a small generic shape
// (see src/pricing.js). Adjustments that are not currently effective, or that use something the
// storefront cannot evaluate, are skipped so a price is never guessed.
const parseSfDate = (s) => (s ? new Date(String(s).replace(/([+-]\d{2})(\d{2})$/, '$1:$2')) : null);
const SUPPORTED_OPERATORS = new Set(['equals', 'notequals']);
const SUPPORTED_TYPES = new Set(['Override', 'Amount']);

async function loadAttributePricing(productIds, currency) {
  const byProduct = new Map(); // productId -> [adjustment]
  if (!productIds.length) return byProduct;
  let adjustments;
  let conditions;
  try {
    adjustments = await soql(
      `SELECT Id, ProductId, AdjustmentType, AdjustmentValue, ProductSellingModelId, AttributeBasedAdjRuleId, EffectiveFrom, EffectiveTo
         FROM AttributeBasedAdjustment
        WHERE ProductId IN (${idList(productIds)}) AND CurrencyIsoCode = '${escapeSoql(currency)}'`,
    );
    const ruleIds = [...new Set(adjustments.map((a) => a.AttributeBasedAdjRuleId).filter(Boolean))];
    conditions = ruleIds.length
      ? await soql(
          `SELECT AttributeBasedAdjRuleId, AttributeDefinitionId, Operator, StringValue, BooleanValue, IntegerValue, DoubleValue
             FROM AttributeAdjustmentCondition WHERE AttributeBasedAdjRuleId IN (${idList(ruleIds)})`,
        )
      : [];
  } catch {
    return byProduct; // org without attribute-based pricing: list prices apply
  }

  const conditionsByRule = new Map();
  for (const c of conditions) {
    if (!conditionsByRule.has(c.AttributeBasedAdjRuleId)) conditionsByRule.set(c.AttributeBasedAdjRuleId, []);
    conditionsByRule.get(c.AttributeBasedAdjRuleId).push(c);
  }

  const now = new Date();
  for (const a of adjustments) {
    const from = parseSfDate(a.EffectiveFrom);
    const to = parseSfDate(a.EffectiveTo);
    if ((from && from > now) || (to && to <= now)) continue;
    if (!SUPPORTED_TYPES.has(a.AdjustmentType)) continue;

    const parsed = (conditionsByRule.get(a.AttributeBasedAdjRuleId) ?? []).map((c) => {
      if (!SUPPORTED_OPERATORS.has(String(c.Operator).toLowerCase())) return null;
      let valueType;
      let value;
      if (c.BooleanValue != null) [valueType, value] = ['boolean', String(c.BooleanValue).toLowerCase() === 'true'];
      else if (c.StringValue != null) [valueType, value] = ['string', c.StringValue];
      else if (c.IntegerValue != null || c.DoubleValue != null) [valueType, value] = ['number', c.IntegerValue ?? c.DoubleValue];
      else return null;
      return { attributeId: c.AttributeDefinitionId, operator: String(c.Operator).toLowerCase(), valueType, value };
    });
    if (!parsed.length || parsed.includes(null)) continue;

    if (!byProduct.has(a.ProductId)) byProduct.set(a.ProductId, []);
    byProduct.get(a.ProductId).push({
      sellingModelId: a.ProductSellingModelId || null,
      type: a.AdjustmentType,
      value: a.AdjustmentValue,
      conditions: parsed,
    });
  }
  return byProduct;
}

// A product can inherit attributes from a Product Classification it's "Based On" (Product2.BasedOnId),
// shown in Salesforce as that product's Inherited Attributes. Read alongside its own direct
// ProductAttributeDefinitions, which is all the storefront's own products (e.g. AI Modality) have used so far.
async function classificationAttributes(classificationIds) {
  const byClassification = new Map();
  if (!classificationIds.length) return byClassification;
  const rows = await soql(
    `SELECT ProductClassificationId, AttributeDefinitionId, AttributeDefinition.Name, AttributeDefinition.Label,
            AttributeDefinition.DataType, AttributeDefinition.PicklistId, Sequence,
            Status, IsRequired, IsHidden, IsReadOnly, DefaultValue, HelpText,
            AttributeNameOverride, MaximumCharacterCount, DisplayType
       FROM ProductClassificationAttr
      WHERE ProductClassificationId IN (${idList(classificationIds)})
      ORDER BY Sequence ASC`,
  );
  for (const r of rows) {
    if (!byClassification.has(r.ProductClassificationId)) byClassification.set(r.ProductClassificationId, []);
    byClassification.get(r.ProductClassificationId).push(r);
  }
  return byClassification;
}

// Shared shape: both ProductAttributeDefinition and ProductClassificationAttr rows carry the
// same AttributeDefinition reference and the same Status/IsHidden/IsRequired/etc. fields.
function toAttribute(a, picklists) {
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
}

function normalize(p, picklists, currency, components, rulesByBundle, classificationAttrs, pricingByProduct) {
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
      id: o.ProductSellingModelId,
      name: o.ProductSellingModel?.Name,
      type: o.ProductSellingModel?.SellingModelType,
      term: o.ProductSellingModel?.PricingTerm,
      termUnit: o.ProductSellingModel?.PricingTermUnit,
    })),
    // A product's own attributes plus any it inherits from its "Based On" classification (only
    // active, non-hidden ones - own attributes win if the same AttributeDefinition appears twice).
    attributes: (() => {
      const byId = new Map();
      for (const a of classificationAttrs.get(p.BasedOnId) ?? []) {
        if (a.Status === 'Active' && !a.IsHidden) byId.set(a.AttributeDefinitionId, toAttribute(a, picklists));
      }
      for (const a of attributeRecords(p)) {
        if (a.Status === 'Active' && !a.IsHidden) byId.set(a.AttributeDefinitionId, toAttribute(a, picklists));
      }
      return [...byId.values()];
    })(),
    // Attribute-driven price adjustments that apply to this product (only ones for a selling model it offers).
    attributePricing: (pricingByProduct.get(p.Id) ?? []).filter(
      (adj) => !adj.sellingModelId || (p.ProductSellingModelOptions?.records ?? []).some((o) => o.ProductSellingModelId === adj.sellingModelId),
    ),
    components: components.get(p.Id) ?? [],
    // Configurator rules that apply while shopping this bundle (e.g. auto-add a required companion product).
    configRules: p.Type === 'Bundle' ? rulesByBundle.get(p.Id.slice(0, 15)) ?? [] : [],
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
  const componentIdToProductId = new Map(); // ProductRelatedComponent.Id -> child Product2 Id
  const extraRows = [];
  let frontier = catalogRows.filter((r) => r.Type === 'Bundle').map((r) => r.Id);

  for (let depth = 0; depth < MAX_BUNDLE_DEPTH && frontier.length; depth++) {
    const comps = await soql(componentQuery(frontier));
    for (const c of comps) {
      componentIdToProductId.set(c.Id, c.ChildProductId);
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

  const allRows = [...catalogRows, ...extraRows];
  const classificationIds = [...new Set(allRows.map((p) => p.BasedOnId).filter(Boolean))];
  const classificationAttrs = await classificationAttributes(classificationIds);

  const picklistIds = [
    ...new Set(
      [...allRows.flatMap(attributeRecords), ...classificationAttrs.values()].flat().map((a) => a.AttributeDefinition?.PicklistId).filter(Boolean),
    ),
  ];
  const picklists = await picklistValues(picklistIds);

  const pricingByProduct = await loadAttributePricing(allRows.map((p) => p.Id), currency);

  const rules = await loadConfigurationRules(componentIdToProductId);
  const rulesByBundle = new Map(); // bundle Product2 Id (15-char) -> [rule]
  for (const r of rules) {
    if (!rulesByBundle.has(r.bundleProductId15)) rulesByBundle.set(r.bundleProductId15, []);
    rulesByBundle.get(r.bundleProductId15).push({ mode: r.mode, criteria: r.criteria, actions: r.actions });
  }

  return {
    products: catalogRows.map((p) => normalize(p, picklists, currency, componentRows, rulesByBundle, classificationAttrs, pricingByProduct)),
    // bundle children that are not listed in the catalog themselves
    componentProducts: extraRows.map((p) =>
      normalize(p, picklists, currency, componentRows, rulesByBundle, classificationAttrs, pricingByProduct),
    ),
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
