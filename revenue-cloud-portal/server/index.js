import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SfError, authMode, callQuoteApi, insertRecords } from './salesforce.js';
import { getProducts } from './products.js';
import { rateLimit, readQuoteIds, rememberQuote } from './guard.js';
import { adjustedPrice } from '../src/pricing.js';

// Public mode = the portal is exposed to the internet. On by default whenever real Salesforce
// credentials are configured (i.e. on the host), off for local development on the CLI session.
const publicMode = process.env.PUBLIC_MODE ? process.env.PUBLIC_MODE === 'true' : authMode() === 'client_credentials';
const sessionSecret = process.env.SESSION_SECRET || '';
if (publicMode && sessionSecret.length < 16) {
  console.error('PUBLIC_MODE needs SESSION_SECRET (at least 16 characters) to sign visitor cookies.');
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');
if (publicMode) app.set('trust proxy', 1); // one proxy hop (the host's load balancer): real client IP + https
app.use(express.json({ limit: '100kb' }));
if (publicMode) app.use('/api', rateLimit({ windowMs: 60_000, max: 120 }));

// Public mode: a visitor may only open/update quotes created in their own browser.
const ownQuoteOnly = (req, _res, next) => {
  if (publicMode && !readQuoteIds(req, sessionSecret).includes(req.params.id)) {
    throw new SfError('This quote was not created in this browser, so it cannot be opened or changed here. Use "Start a new quote".', 403);
  }
  next();
};

const taxRate = () => {
  const r = Number(process.env.TAX_RATE ?? 0.18);
  return Number.isFinite(r) && r >= 0 ? r : 0;
};

const SF_ID = /^[a-zA-Z0-9]{15,18}$/;
const MAX_QTY = 10_000;
const MAX_TEXT = 255;

// Validates one line's attribute selection against the product's attribute definitions in Salesforce.
// Returns what is needed to write native QuoteLineItemAttribute rows.
function cleanAttributes(product, raw, where) {
  if (raw == null || (Array.isArray(raw) && raw.length === 0)) raw = [];
  if (!Array.isArray(raw) || raw.length > 50) throw new SfError(`${where}.attributes must be a list`, 400);
  const defs = new Map(product.attributes.map((a) => [a.name, a]));
  const chosen = new Map();

  for (const item of raw) {
    const def = defs.get(String(item?.name ?? ''));
    if (!def) throw new SfError(`"${product.name}" has no attribute "${item?.name}"`, 400);
    const value = String(item?.value ?? '').trim().slice(0, MAX_TEXT);
    const picked = def.dataType === 'Picklist' ? def.values.find((v) => v.value === value) : null;
    if (def.dataType === 'Picklist' && value && def.displayType !== 'ComboBox' && !picked) {
      throw new SfError(`"${value}" is not an available value for ${def.label}`, 400);
    }
    if (def.dataType === 'Checkbox' && !['true', 'false'].includes(value)) {
      throw new SfError(`${def.label} must be true or false`, 400);
    }
    chosen.set(def.name, { def, value, picklistValueId: picked?.id ?? null });
  }
  for (const def of product.attributes) {
    if (def.required && !chosen.get(def.name)?.value) throw new SfError(`${def.label} is required for "${product.name}"`, 400);
  }
  return [...chosen.values()]
    .filter(({ value }) => value !== '')
    .map(({ def, value, picklistValueId }) => ({
      definitionId: def.id,
      label: def.label,
      value,
      picklistValueId,
    }));
}

// Validates the cart from the browser and re-prices every line from the Salesforce
// catalog (Standard Price Book), so a tampered client cannot choose its own prices.
// Lines may be nested: a line with parentLineId is a component of the bundle line it points to.
async function buildQuoteBody(rawItems, { requireItems }) {
  if (!Array.isArray(rawItems)) throw new SfError('lineItems must be an array', 400);
  if (requireItems && rawItems.length === 0) throw new SfError('Add at least one product before creating a quote', 400);

  const { products, componentProducts } = await getProducts();
  const catalog = new Map([...products, ...componentProducts].map((p) => [p.id, p]));
  const seen = new Set();

  const lines = rawItems.map((item, i) => {
    const where = `lineItems[${i}]`;
    const productId = String(item?.productId ?? '');
    const quantity = Number(item?.quantity);
    if (!SF_ID.test(productId)) throw new SfError(`${where}.productId is not a valid Salesforce Id`, 400);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QTY) {
      throw new SfError(`${where}.quantity must be a whole number between 1 and ${MAX_QTY}`, 400);
    }
    const product = catalog.get(productId);
    if (!product) throw new SfError(`Product ${productId} is not in the DeepHealth Product Catalog`, 400);
    if (product.unitPrice == null) throw new SfError(`"${product.name}" has no active price and cannot be quoted`, 400);

    const attributes = cleanAttributes(product, item?.attributes, where);
    const lineId = String(item?.lineId ?? productId).slice(0, 500);
    const parentLineId = item?.parentLineId ? String(item.parentLineId).slice(0, 500) : null;
    // the same product may appear on several lines, but only in a different place or configuration
    const key = `${parentLineId ?? ''}|${productId}|${attributes.map((a) => `${a.label}=${a.value}`).sort().join(';')}`;
    if (seen.has(key)) throw new SfError(`"${product.name}" appears twice with the same configuration`, 400);
    seen.add(key);
    // the price may depend on the attribute values chosen (Salesforce Attribute Based Adjustments)
    const chosen = Object.fromEntries(attributes.map((a) => [a.definitionId, a.value]));
    return { lineId, parentLineId, productId, product, quantity, unitPrice: adjustedPrice(product, chosen), attributes };
  });

  // bundle structure: every parent must be a bundle line in this cart that lists the child as a component
  const byLineId = new Map(lines.map((l) => [l.lineId, l]));
  if (byLineId.size !== lines.length) throw new SfError('lineItems contain duplicate line ids', 400);
  for (const line of lines) {
    let top = line;
    for (let hops = 0; top.parentLineId; hops++) {
      const parent = byLineId.get(top.parentLineId);
      if (!parent || hops > lines.length) throw new SfError(`"${top.product.name}" belongs to a bundle that is not in the cart`, 400);
      if (!parent.product.isBundle) throw new SfError(`"${parent.product.name}" is not a bundle`, 400);
      if (top === line) {
        line.component = parent.product.components.find((c) => c.productId === line.productId);
        if (!line.component) throw new SfError(`"${line.product.name}" is not a component of "${parent.product.name}"`, 400);
      }
      top = parent;
    }
    line.rootLineId = top.lineId;
  }

  const subtotal = lines.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0);
  return {
    lines,
    body: {
      lineItems: lines.map(({ productId, quantity, unitPrice }) => ({ productId, quantity, unitPrice })),
      tax: Math.round(subtotal * taxRate()),
    },
  };
}

// The quote API only creates flat lines. After it has saved, the bundle structure
// (QuoteLineRelationship) and the picked attribute values (QuoteLineItemAttribute) are written
// as the native Revenue Cloud records, so the Salesforce quote shows nested components and
// attributes. A failure here never fails the save - it is reported so the portal can warn.
async function syncStructure(quote, lines) {
  const children = lines.filter((l) => l.parentLineId);
  const withAttributes = lines.filter((l) => l.attributes.length);
  if (!children.length && !withAttributes.length) return { ok: true, relationships: 0, attributes: 0 };

  try {
    // Salesforce assigns ids in insert order and the quote API inserts lines in request order,
    // so the n-th cart line of a product is the n-th (by id) quote line of that product.
    const idsByProduct = new Map();
    for (const l of [...(quote.products ?? [])].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      if (!idsByProduct.has(l.productId)) idsByProduct.set(l.productId, []);
      idsByProduct.get(l.productId).push(l.id);
    }
    const used = new Map();
    const sfLineId = new Map(); // cart lineId -> QuoteLineItem id
    for (const l of lines) {
      const n = used.get(l.productId) ?? 0;
      used.set(l.productId, n + 1);
      const id = idsByProduct.get(l.productId)?.[n];
      if (!id) throw new SfError(`Could not find the quote line for "${l.product.name}"`);
      sfLineId.set(l.lineId, id);
    }

    const records = [];
    for (const l of children) {
      const c = l.component;
      records.push({
        type: 'QuoteLineRelationship',
        fields: {
          MainQuoteLineId: sfLineId.get(l.parentLineId),
          AssociatedQuoteLineId: sfLineId.get(l.lineId),
          RootQuoteLineId: sfLineId.get(l.rootLineId),
          ProductRelatedComponentId: c.componentId,
          ...(c.relationshipTypeId ? { ProductRelationshipTypeId: c.relationshipTypeId } : {}),
          ...(c.scaleMethod ? { AssociatedQuantScaleMethod: c.scaleMethod } : {}),
          AssociatedQuoteLinePricing: c.priceIncluded ? 'IncludedInBundlePrice' : 'NotIncludedInBundlePrice',
        },
      });
    }
    for (const l of withAttributes) {
      for (const a of l.attributes) {
        records.push({
          type: 'QuoteLineItemAttribute',
          fields: {
            QuoteLineItemId: sfLineId.get(l.lineId),
            AttributeDefinitionId: a.definitionId,
            AttributeValue: a.value,
            ...(a.picklistValueId ? { AttributePicklistValueId: a.picklistValueId } : {}),
          },
        });
      }
    }
    await insertRecords(records);
    return { ok: true, relationships: children.length, attributes: records.length - children.length };
  } catch (err) {
    console.error('[quote] could not write bundle structure / attributes:', err.message);
    return { ok: false, error: err.message };
  }
}

const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);
const quoteId = (req) => {
  if (!SF_ID.test(req.params.id)) throw new SfError('Invalid quote id', 400);
  return req.params.id;
};

app.get('/api/health', (_req, res) => res.json({ ok: true, auth: authMode() }));

// Products (+ pricing, selling models, attributes, bundle components) for the storefront.
app.get(
  '/api/products',
  wrap(async (_req, res) => {
    // public mode serves the short-lived cache so visitors don't each trigger Salesforce queries
    res.json({ taxRate: taxRate(), ...(await getProducts({ fresh: !publicMode })) });
  }),
);

// Create a quote from the cart.
app.post(
  '/api/quotes',
  publicMode
    ? rateLimit({ windowMs: 3_600_000, max: 10, message: 'Too many quotes were created from your network. Please try again later.' })
    : (_req, _res, next) => next(),
  wrap(async (req, res) => {
    const { body, lines } = await buildQuoteBody(req.body?.lineItems, { requireItems: true });
    const quote = await callQuoteApi('POST', '', body);
    if (publicMode) rememberQuote(req, res, sessionSecret, quote.id);
    res.status(201).json({ ...quote, structureSync: await syncStructure(quote, lines) });
  }),
);

// Read the current state of a quote (status, totals, lines).
app.get(
  '/api/quotes/:id',
  ownQuoteOnly,
  wrap(async (req, res) => {
    res.json(await callQuoteApi('GET', quoteId(req)));
  }),
);

// Update the SAME quote: replaces its line items with the current cart. Never creates a quote.
app.patch(
  '/api/quotes/:id',
  ownQuoteOnly,
  wrap(async (req, res) => {
    const id = quoteId(req);
    const { body, lines } = await buildQuoteBody(req.body?.lineItems, { requireItems: false });
    const quote = await callQuoteApi('PATCH', id, body);
    res.json({ ...quote, structureSync: await syncStructure(quote, lines) });
  }),
);

// Serve the built React app when running `npm start`.
const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
app.use(express.static(dist));
app.get(/^\/(?!api\/).*/, (_req, res, next) => res.sendFile(path.join(dist, 'index.html'), (err) => err && next()));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = err instanceof SfError ? err.status : 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err instanceof SfError ? err.message : 'Unexpected server error' });
});

const port = Number(process.env.PORT) || 8787;
app.listen(port, () => console.log(`Portal API on http://localhost:${port} (Salesforce auth: ${authMode()})`));
