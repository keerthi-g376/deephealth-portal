import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SfError, authMode, callCustomerApi, callLeadApi, callQuoteApi, insertRecords, soql } from './salesforce.js';
import { defaultCurrency, getProducts, pricedCurrencies } from './products.js';
import { countries, countryByCode } from './countries.js';
import crypto from 'node:crypto';
import { codeIsValid, endSession, hitCounter, makeCode, rateLimit, readSession, startSession } from './guard.js';
import { askAssistant, chatEnabled } from './chat.js';
import { adjustedPrice } from '../src/pricing.js';
import { lineIdOf } from '../src/attributes.js';

// Public mode = the portal is exposed to the internet. On by default whenever real Salesforce
// credentials are configured (i.e. on the host), off for local development on the CLI session.
const publicMode = process.env.PUBLIC_MODE ? process.env.PUBLIC_MODE === 'true' : authMode() === 'client_credentials';
// local development without SESSION_SECRET gets a random per-process secret (sessions end when the server restarts)
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (publicMode && !process.env.SESSION_SECRET) {
  console.error('PUBLIC_MODE needs SESSION_SECRET to sign sign-in codes and session cookies.');
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');
if (publicMode) app.set('trust proxy', 1); // one proxy hop (the host's load balancer): real client IP + https
app.use(express.json({ limit: '100kb' }));
if (publicMode) app.use('/api', rateLimit({ windowMs: 60_000, max: 120 }));

// Only a signed-in customer can use the quote endpoints. Every quote call carries that customer's Contact id and
// Apex refuses any quote that does not belong to it (it then looks exactly like a missing quote).
const requireCustomer = (req, _res, next) => {
  req.customer = readSession(req, sessionSecret);
  if (!req.customer) throw new SfError('Please sign in to continue.', 401);
  next();
};
const own = (req) => `?contactId=${encodeURIComponent(req.customer.contactId)}`;

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
async function buildQuoteBody(rawItems, { requireItems, currency }) {
  if (!Array.isArray(rawItems)) throw new SfError('lineItems must be an array', 400);
  if (requireItems && rawItems.length === 0) throw new SfError('Add at least one product before creating a quote', 400);

  const { products, componentProducts } = await getProducts({ currency });
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
    if (!product) throw new SfError(`Product ${productId} is not in the CareSphere Health Product Catalog`, 400);
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
    // a bundle has no price of its own (same rule as the cart): its price is the total of its component lines
    const unitPrice = product.isBundle ? 0 : adjustedPrice(product, chosen);
    return { lineId, parentLineId, productId, product, quantity, unitPrice, attributes };
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
      tax: 0, // Salesforce holds no tax rate, so the portal adds none
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

app.get('/api/health', (_req, res) => res.json({ ok: true, auth: authMode(), chat: chatEnabled() }));

// Products (+ pricing, selling models, attributes, bundle components) for the storefront.
app.get(
  '/api/products',
  wrap(async (req, res) => {
    // public mode serves the short-lived cache so visitors don't each trigger Salesforce queries
    const country = req.query.country ? countryByCode(req.query.country) : null;
    if (req.query.country && !country) throw new SfError('Unknown country', 400);
    res.json({ ...(await getProducts({ fresh: !publicMode, ...(country ? { currency: country.currency } : {}) })), country });
  }),
);

// only countries whose currency has priced catalog products are offered
app.get(
  '/api/countries',
  wrap(async (_req, res) => {
    const priced = await pricedCurrencies();
    res.json(countries.filter((c) => c.currency in priced).map((c) => ({ ...c, rate: priced[c.currency] })));
  }),
);

// "I'm interested" -> a Lead in Salesforce (de-duplicated by email in Apex). Public form, so tightly rate limited.
app.post(
  '/api/leads',
  publicMode
    ? rateLimit({ windowMs: 3_600_000, max: 5, message: 'Too many requests from your network. Please try again later.' })
    : (_req, _res, next) => next(),
  wrap(async (req, res) => {
    const b = req.body ?? {};
    const text = (v, max) => String(v ?? '').trim().slice(0, max);
    const country = countryByCode(b.country);
    const lead = {
      firstName: text(b.firstName, 40),
      lastName: text(b.lastName, 80),
      email: cleanEmail(b.email),
      company: text(b.company, 255),
      phone: text(b.phone, 40),
      country: country?.name ?? '',
      currencyCode: country?.currency ?? '',
      productIds: (Array.isArray(b.productIds) ? b.productIds : []).map(String).filter((id) => SF_ID.test(id)).slice(0, 25),
      message: text(b.message, 1000),
    };
    if (!lead.lastName) throw new SfError('Please enter your name', 400);
    if (!lead.email) throw new SfError('Please enter a valid email address', 400);
    if (!lead.company) throw new SfError('Please enter your company', 400);
    if (!country) throw new SfError('Please choose your country', 400);
    await callLeadApi(lead);
    res.status(201).json({ ok: true });
  }),
);

// ---- customer sign-in: an emailed one-time code proves the email; that is when a Lead becomes a Contact ----
const codeRequests = hitCounter({ windowMs: 3_600_000, max: 5 }); // codes emailed per address per hour
const codeAttempts = hitCounter({ windowMs: 15 * 60_000, max: 10 }); // wrong guesses per address per 15 minutes
const cleanEmail = (v) => {
  const email = String(v ?? '').trim().toLowerCase().slice(0, 254);
  return /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/.test(email) ? email : '';
};
const text = (v, max) => String(v ?? '').trim().slice(0, max);
const cleanAddress = (a) =>
  a && typeof a === 'object'
    ? { street: text(a.street, 255), city: text(a.city, 80), state: text(a.state, 80), postalCode: text(a.postalCode, 20), country: text(a.country, 80) }
    : null;
// what the browser may know about the signed-in customer
const publicUser = (c) => ({ contactId: c.contactId, name: c.name, email: c.email, access: c.access, isAdmin: !!c.isAdmin, accountName: c.accountName ?? '' });
const signInLimit = publicMode
  ? rateLimit({ windowMs: 3_600_000, max: 30, message: 'Too many sign-in attempts from your network. Please try again later.' })
  : (_req, _res, next) => next();

app.post(
  '/api/auth/request',
  signInLimit,
  wrap(async (req, res) => {
    const email = cleanEmail(req.body?.email);
    if (!email) throw new SfError('Please enter a valid email address', 400);
    if (!codeRequests.allow(email)) throw new SfError('A code was already sent several times. Please check your inbox or try again later.', 429);
    const code = makeCode(sessionSecret, email);
    try {
      await callCustomerApi('mail', { email, code });
    } catch (err) {
      if (publicMode) throw err;
      console.log(`[dev] sign-in code for ${email}: ${code} (email not sent: ${err.message})`); // local development only
    }
    res.json({ ok: true }); // same answer whether or not the address is known
  }),
);

app.post(
  '/api/auth/verify',
  signInLimit,
  wrap(async (req, res) => {
    const b = req.body ?? {};
    const email = cleanEmail(b.email);
    if (!email) throw new SfError('Please enter a valid email address', 400);
    if (!codeAttempts.allow(email)) throw new SfError('Too many wrong codes. Please wait a few minutes and try again.', 429);
    if (!codeIsValid(sessionSecret, email, String(b.code ?? '').trim())) throw new SfError('That code is not correct or has expired.', 400);

    const customer = await callCustomerApi('resolve', {
      email,
      firstName: text(b.firstName, 40),
      lastName: text(b.lastName, 80),
      phone: text(b.phone, 40),
      company: text(b.company, 255),
      individual: b.individual === true,
      joinExisting: b.joinExisting === true,
      country: countryByCode(b.country)?.name ?? '',
      billing: cleanAddress(b.billing),
      shipping: cleanAddress(b.shipping),
    });
    if (customer.needsProfile) return res.json({ needsProfile: true, domainMatch: !!customer.domainMatch, accountName: customer.accountName ?? '' });
    startSession(req, res, sessionSecret, { contactId: customer.contactId, accountId: customer.accountId, name: customer.name || email, email });
    res.json({ user: publicUser(customer) });
  }),
);

app.get(
  '/api/auth/me',
  wrap(async (req, res) => {
    const session = readSession(req, sessionSecret);
    if (!session) return res.json({ user: null });
    try {
      res.json({ user: publicUser(await callCustomerApi('status', { contactId: session.contactId })) });
    } catch {
      endSession(res); // the contact no longer exists
      res.json({ user: null });
    }
  }),
);

// My Profile: the customer's own details; an Account Admin also edits the Account's billing and shipping address.
app.get(
  '/api/profile',
  requireCustomer,
  wrap(async (req, res) => {
    res.json(await callCustomerApi('profile', { contactId: req.customer.contactId }));
  }),
);
app.put(
  '/api/profile',
  requireCustomer,
  wrap(async (req, res) => {
    const b = req.body ?? {};
    if (!text(b.lastName, 80)) throw new SfError('Please enter your last name', 400);
    res.json(
      await callCustomerApi('saveProfile', {
        contactId: req.customer.contactId,
        firstName: text(b.firstName, 40),
        lastName: text(b.lastName, 80),
        phone: text(b.phone, 40),
        billing: cleanAddress(b.billing),
        shipping: cleanAddress(b.shipping),
      }),
    );
  }),
);

app.post('/api/auth/logout', (_req, res) => {
  endSession(res);
  res.json({ ok: true });
});

// Which currencies a customer may quote in: the default plus every configured country's.
const allowedCurrency = (value) => {
  const currency = String(value || defaultCurrency());
  if (currency !== defaultCurrency() && !countries.some((c) => c.currency === currency)) throw new SfError('Unsupported currency', 400);
  return currency;
};

// The signed-in customer's own quotations (newest first).
app.get(
  '/api/my/quotes',
  requireCustomer,
  wrap(async (req, res) => {
    res.json(await callQuoteApi('GET', '', null, own(req) + (req.query.scope === 'account' ? '&scope=account' : '')));
  }),
);

// Create a quote from the cart for the signed-in customer. The Opportunity is reused or created in Apex.
// reviseFrom: id of an earlier quote of this customer; the new quote goes on the same Opportunity.
app.post(
  '/api/quotes',
  requireCustomer,
  publicMode
    ? rateLimit({ windowMs: 3_600_000, max: 10, message: 'Too many quotes were created from your network. Please try again later.' })
    : (_req, _res, next) => next(),
  wrap(async (req, res) => {
    const currency = allowedCurrency(req.body?.currency);
    const { body, lines } = await buildQuoteBody(req.body?.lineItems, { requireItems: true, currency });
    let revision = null;
    if (req.body?.reviseFrom) {
      if (!SF_ID.test(String(req.body.reviseFrom))) throw new SfError('Invalid quote id', 400);
      revision = await callQuoteApi('GET', String(req.body.reviseFrom), null, own(req)); // 'not found' unless it is theirs
    }
    const quote = await callQuoteApi('POST', '', {
      ...body,
      contactId: req.customer.contactId,
      currencyCode: currency,
      ...(revision ? { opportunityId: revision.opportunityId, supersedes: revision.id, notes: `Revision of quote #${revision.quoteNumber}` } : {}),
    });
    res.status(201).json({ ...quote, structureSync: await syncStructure(quote, lines) });
  }),
);

// Read one of the customer's quotes (status, totals, lines).
app.get(
  '/api/quotes/:id',
  requireCustomer,
  wrap(async (req, res) => {
    res.json(await callQuoteApi('GET', quoteId(req), null, own(req)));
  }),
);

// A quote as cart lines (products, quantities, attributes and bundle nesting), so the customer can edit a Draft
// or start a revision of a later-stage quote.
app.get(
  '/api/quotes/:id/cart',
  requireCustomer,
  wrap(async (req, res) => {
    const quote = await callQuoteApi('GET', quoteId(req), null, own(req));
    const currency = quote.currencyCode || defaultCurrency();
    const { products, componentProducts } = await getProducts({ currency });
    const catalog = new Map([...products, ...componentProducts].map((p) => [p.id, p]));
    const sfIds = quote.products.map((l) => l.id);

    const attrsByLine = new Map();
    const parentOf = new Map();
    if (sfIds.length) {
      try {
        for (const a of await soql(`SELECT QuoteLineItemId, AttributeDefinition.Name, AttributeValue FROM QuoteLineItemAttribute WHERE QuoteLineItemId IN (${sfIds.map((i) => `'${i}'`).join(',')})`)) {
          if (!attrsByLine.has(a.QuoteLineItemId)) attrsByLine.set(a.QuoteLineItemId, []);
          attrsByLine.get(a.QuoteLineItemId).push({ name: a.AttributeDefinition?.Name, value: a.AttributeValue });
        }
        for (const r of await soql(`SELECT MainQuoteLineId, AssociatedQuoteLineId FROM QuoteLineRelationship WHERE AssociatedQuoteLineId IN (${sfIds.map((i) => `'${i}'`).join(',')})`)) {
          parentOf.set(r.AssociatedQuoteLineId, r.MainQuoteLineId);
        }
      } catch (err) {
        console.error('[quote] could not read attributes / bundle structure:', err.message); // fall back to flat lines
      }
    }

    const bySf = new Map(quote.products.map((l) => [l.id, l]));
    const lineIds = new Map(); // QuoteLineItem id -> cart lineId (parents first)
    const lineIdFor = (sfId, depth = 0) => {
      if (lineIds.has(sfId)) return lineIds.get(sfId);
      const l = bySf.get(sfId);
      const parentSf = depth < 6 ? parentOf.get(sfId) : null;
      const parentLineId = parentSf && bySf.has(parentSf) ? lineIdFor(parentSf, depth + 1) : null;
      const attrs = (attrsByLine.get(sfId) ?? []).filter((a) => a.name && a.value != null);
      const id = lineIdOf(l.productId, attrs, parentLineId);
      lineIds.set(sfId, id);
      return id;
    };
    const items = quote.products
      .filter((l) => catalog.has(l.productId))
      .map((l) => {
        const p = catalog.get(l.productId);
        const attributes = (attrsByLine.get(l.id) ?? [])
          .filter((a) => a.name && a.value != null)
          .map((a) => {
            const def = p.attributes.find((d) => d.name === a.name);
            return def ? { name: a.name, label: def.label, value: a.value, display: def.dataType === 'Checkbox' ? (a.value === 'true' ? 'Yes' : 'No') : a.value } : null;
          })
          .filter(Boolean);
        const parentSf = parentOf.get(l.id);
        return {
          lineId: lineIdFor(l.id),
          parentLineId: parentSf && bySf.has(parentSf) ? lineIdFor(parentSf) : null,
          productId: l.productId,
          name: p.name,
          code: p.code,
          family: p.family,
          unitPrice: l.price,
          quantity: Math.max(1, Math.round(l.qty)),
          attributes,
        };
      });
    res.json({
      quote: { id: quote.id, quoteNumber: quote.quoteNumber, status: quote.status, subtotal: quote.subtotal, tax: quote.tax, grandTotal: quote.grandTotal },
      currency,
      items,
    });
  }),
);

// Customer actions on a quote. Apex checks the owner and which status each action is allowed from:
//   submit  Draft -> Needs Review (locks it for the pricing review)
//   accept  Approved -> Accepted (the Opportunity becomes Closed Won)
//   decline anything open -> Denied, with a reason (the Opportunity becomes Closed Lost)
const ACTIONS = { submit: 'Needs Review', accept: 'Accepted', decline: 'Denied' };
app.post(
  '/api/quotes/:id/:action',
  requireCustomer,
  wrap(async (req, res) => {
    const status = ACTIONS[req.params.action];
    if (!status) throw new SfError('Unknown action', 404);
    const id = quoteId(req);
    const body = { status };
    if (status === 'Denied') {
      const existing = await callQuoteApi('GET', id, null, own(req));
      const reason = text(req.body?.reason, 200) || 'no reason given';
      body.notes = [existing.notes, `Customer not interested: ${reason}`].filter(Boolean).join('\n').slice(0, 2000);
    }
    res.json(await callQuoteApi('PATCH', id, body, own(req)));
  }),
);

// Update the SAME quote: replaces its line items with the current cart. Only a Draft can be changed (Apex enforces it).
app.patch(
  '/api/quotes/:id',
  requireCustomer,
  wrap(async (req, res) => {
    const id = quoteId(req);
    const existing = await callQuoteApi('GET', id, null, own(req)); // ownership + the quote's own currency
    const { body, lines } = await buildQuoteBody(req.body?.lineItems, { requireItems: false, currency: existing.currencyCode || defaultCurrency() });
    const quote = await callQuoteApi('PATCH', id, body, own(req));
    res.json({ ...quote, structureSync: await syncStructure(quote, lines) });
  }),
);

// AI shopping assistant: answers from the live Salesforce catalog. Each call costs money, so public mode
// gives every visitor address a small hourly allowance on top of the general rate limit.
app.post(
  '/api/chat',
  publicMode
    ? rateLimit({ windowMs: 3_600_000, max: 40, message: 'You have reached the hourly limit for the assistant. Please try again later.' })
    : (_req, _res, next) => next(),
  wrap(async (req, res) => {
    res.json(await askAssistant(req.body?.messages, req.body?.cart));
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
