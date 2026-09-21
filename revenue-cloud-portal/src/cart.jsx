import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { api } from './api.js';
import { attributeKey } from './attributes.js';

const STORAGE_KEY = 'dh-portal-session-v1';
const MAX_QTY = 10000;
// The Salesforce API only allows changing line items while the quote is in one of these statuses.
const EDITABLE_STATUSES = ['Draft', 'Pending'];

// A cart line is a product plus its attribute choices. A product added without any
// configuration keeps the plain product id as its line id, exactly as before.
// A component added under a bundle is a different line from the same product added on its own.
const lineIdOf = (productId, attributes, parentLineId = null) => {
  const key = attributeKey(attributes);
  const own = key ? `${productId}|${key}` : productId;
  return parentLineId ? `${parentLineId}>${own}` : own;
};

// Fingerprint of the cart content; lets us tell whether the cart differs from what Salesforce holds.
export const signature = (items) =>
  items
    .map((i) => `${i.lineId}:${i.quantity}`)
    .sort()
    .join('|');

const emptyState = { items: [], quote: null, syncedSig: null };

// Cart + linked Salesforce quote live in sessionStorage, so a page refresh keeps the
// quote link and later cart changes still update the SAME quote.
function loadState() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY));
    if (saved && Array.isArray(saved.items)) {
      // carts saved before configurable lines existed have no lineId / attributes
      const items = saved.items.map((i) => ({
        ...i,
        attributes: i.attributes ?? [],
        lineId: i.lineId ?? i.productId,
        parentLineId: i.parentLineId ?? null,
      }));
      return { ...emptyState, ...saved, items };
    }
  } catch {
    /* storage unavailable or corrupt - start clean */
  }
  return emptyState;
}

const clampQty = (n) => Math.min(MAX_QTY, Math.max(1, Math.floor(Number(n)) || 1));

// Adds a line (or adds to its quantity when it exists). `bump: false` leaves an existing line alone.
function withLine(items, product, { quantity = 1, attributes = [], parentLineId = null, bump = true }) {
  const lineId = lineIdOf(product.id, attributes, parentLineId);
  if (items.some((i) => i.lineId === lineId)) {
    if (!bump) return { items, lineId };
    return { items: items.map((i) => (i.lineId === lineId ? { ...i, quantity: clampQty(i.quantity + quantity) } : i)), lineId };
  }
  const line = {
    lineId,
    parentLineId,
    productId: product.id,
    name: product.name,
    code: product.code,
    family: product.family,
    unitPrice: product.unitPrice,
    quantity: clampQty(quantity),
    attributes,
  };
  return { items: [...items, line], lineId };
}

function reducer(state, action) {
  switch (action.type) {
    case 'add':
      return { ...state, items: withLine(state.items, action.product, { quantity: action.quantity, attributes: action.attributes }).items };
    case 'addToBundle': {
      // chain = the bundle (and any bundles above it) the components belong to, outermost first
      let items = state.items;
      let parentLineId = null;
      for (const bundle of action.chain) {
        ({ items, lineId: parentLineId } = withLine(items, bundle, { parentLineId, bump: false }));
      }
      for (const { product, quantity } of action.components) {
        ({ items } = withLine(items, product, { quantity, parentLineId }));
      }
      return { ...state, items };
    }
    case 'setQty':
      return {
        ...state,
        items: state.items.map((i) => (i.lineId === action.lineId ? { ...i, quantity: clampQty(action.quantity) } : i)),
      };
    case 'remove': {
      // removing a bundle also removes its components (and theirs)
      const gone = new Set([action.lineId]);
      for (let grew = true; grew; ) {
        grew = false;
        for (const i of state.items) {
          if (!gone.has(i.lineId) && i.parentLineId && gone.has(i.parentLineId)) {
            gone.add(i.lineId);
            grew = true;
          }
        }
      }
      return { ...state, items: state.items.filter((i) => !gone.has(i.lineId)) };
    }
    case 'clear':
      return { ...state, items: [] };
    case 'refreshPrices': {
      const byId = new Map(action.products.map((p) => [p.id, p]));
      return {
        ...state,
        items: state.items.map((i) => {
          const p = byId.get(i.productId);
          return p && p.unitPrice != null ? { ...i, name: p.name, unitPrice: p.unitPrice } : i;
        }),
      };
    }
    case 'quoteSaved':
      return { ...state, quote: action.quote, syncedSig: action.sig };
    case 'quoteRefreshed':
      return state.quote ? { ...state, quote: { ...state.quote, ...action.quote } } : state;
    case 'detachQuote':
      return { ...state, quote: null, syncedSig: null };
    default:
      return state;
  }
}

const summarize = (q) => ({
  id: q.id,
  quoteNumber: q.quoteNumber,
  status: q.status,
  subtotal: q.subtotal,
  tax: q.tax,
  grandTotal: q.grandTotal,
});

const CartContext = createContext(null);
export const useCart = () => useContext(CartContext);

export function CartProvider({ taxRate, children }) {
  const [state, dispatch] = useReducer(reducer, undefined, loadState);
  const [saving, setSaving] = useState(false);
  const [toasts, setToasts] = useState([]);

  const stateRef = useRef(state);
  stateRef.current = state;
  const savingRef = useRef(false); // synchronous guard: a double click can never fire two requests

  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* ignore */
    }
  }, [state]);

  const notify = useCallback((type, message) => {
    const id = crypto.randomUUID();
    setToasts((t) => [...t, { id, type, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), type === 'error' ? 7000 : 4000);
  }, []);
  const dismissToast = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const isNotFound = (err) => /not found/i.test(err.message);

  // Re-check the linked quote (still exists? still editable?). Drops the link only when
  // Salesforce says the quote is gone - a network blip must never orphan the quote.
  const refreshQuote = useCallback(async () => {
    const quote = stateRef.current.quote;
    if (!quote) return;
    try {
      const fresh = await api.getQuote(quote.id);
      dispatch({ type: 'quoteRefreshed', quote: summarize(fresh) });
    } catch (err) {
      if (isNotFound(err)) {
        dispatch({ type: 'detachQuote' });
        notify('info', 'The linked quote no longer exists in Salesforce. Your cart is kept - the next save creates a new quote.');
      }
    }
  }, [notify]);

  useEffect(() => {
    refreshQuote();
  }, [refreshQuote]);

  // The one action behind the Create Quote / Update Quote button.
  const saveQuote = useCallback(async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    const { items, quote } = stateRef.current;
    const lineItems = items.map(({ lineId, parentLineId, productId, quantity, unitPrice, attributes }) => ({
      lineId,
      parentLineId,
      productId,
      quantity,
      unitPrice,
      attributes: attributes.map(({ name, value }) => ({ name, value })),
    }));
    try {
      const saved = quote ? await api.updateQuote(quote.id, lineItems) : await api.createQuote(lineItems);
      if (!saved?.id) throw new Error('Salesforce did not return a quote id');
      dispatch({ type: 'quoteSaved', quote: summarize(saved), sig: signature(items) });
      notify('success', quote ? `Quote ${saved.quoteNumber} updated` : `Quote ${saved.quoteNumber} created`);
      if (saved.structureSync && !saved.structureSync.ok) {
        notify('info', 'The quote was saved, but its bundle structure / attribute values could not be written to Salesforce.');
      }
    } catch (err) {
      notify('error', err.message);
      if (quote) refreshQuote(); // the failure may be "quote is locked" or "quote was deleted"
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [notify, refreshQuote]);

  const value = useMemo(() => {
    const { items, quote, syncedSig } = state;
    const subtotal = items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
    const tax = Math.round(subtotal * taxRate);
    const dirty = !quote || signature(items) !== syncedSig;
    return {
      items,
      quote,
      count: items.length, // number of products in the cart, not the total of their quantities
      subtotal,
      tax,
      total: subtotal + tax,
      dirty,
      locked: !!quote && !EDITABLE_STATUSES.includes(quote.status),
      saving,
      toasts,
      dismissToast,
      notify,
      // add(product) works as before; add(product, { quantity, attributes }) adds a configured line
      add: (product, options = {}) => dispatch({ type: 'add', product, quantity: options.quantity, attributes: options.attributes }),
      // components: [{ product, quantity }] added under the last bundle of `chain`
      addToBundle: (chain, components) => dispatch({ type: 'addToBundle', chain, components }),
      setQty: (lineId, quantity) => dispatch({ type: 'setQty', lineId, quantity }),
      remove: (lineId) => dispatch({ type: 'remove', lineId }),
      clear: () => dispatch({ type: 'clear' }),
      startNewQuote: () => dispatch({ type: 'detachQuote' }),
      refreshPrices: (products) => dispatch({ type: 'refreshPrices', products }),
      saveQuote,
    };
  }, [state, saving, toasts, taxRate, saveQuote, dismissToast, notify]);

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}
