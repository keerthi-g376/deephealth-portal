import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';
import { isConfigurable } from './attributes.js';
import { CartProvider, useCart } from './cart.jsx';
import BundlePage from './components/BundlePage.jsx';
import Cart from './components/Cart.jsx';
import ConfigurePage from './components/ConfigurePage.jsx';
import ProductCard from './components/ProductCard.jsx';
import QuotePage from './components/QuotePage.jsx';
import Toasts from './components/Toasts.jsx';
import { BoxIcon, CartIcon, SearchIcon } from './components/icons.jsx';

function useCatalog() {
  const [state, setState] = useState({ status: 'loading', products: [], componentProducts: [], error: '' });
  const load = useCallback(() => {
    setState((s) => ({ ...s, status: 'loading', error: '' }));
    api
      .getProducts()
      .then((d) => setState({ status: 'ready', products: d.products, componentProducts: d.componentProducts ?? [], error: '' }))
      .catch((e) => setState((s) => ({ ...s, status: 'error', error: e.message })));
  }, []);
  useEffect(load, [load]);
  return { ...state, reload: load };
}

// Tiny hash router: "#/" = products, "#/configure/{id}" = configure product,
// "#/bundle/{id}" = bundle components ("#/bundle/{outer}/{inner}" = a bundle opened from inside another),
// "#/quote" = details and products of the linked Salesforce quote.
function useRoute() {
  const parse = () => {
    const [name = '', ...ids] = window.location.hash.replace(/^#\/?/, '').split('/').filter((s, i) => i === 0 || s);
    return { name, id: ids[ids.length - 1] ?? '', ids };
  };
  const [route, setRoute] = useState(parse);
  const navigated = useRef(false);
  useEffect(() => {
    const onChange = () => {
      navigated.current = true;
      setRoute(parse());
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  // "Back" returns to where the user came from; a deep link with no history goes to the product list.
  const back = useCallback(() => {
    if (navigated.current) window.history.back();
    else window.location.hash = '#/';
  }, []);
  return { route, back };
}

function Storefront({ catalog }) {
  const cart = useCart();
  const { route, back } = useRoute();
  const [query, setQuery] = useState('');
  const [family, setFamily] = useState('All');
  const [cartOpen, setCartOpen] = useState(false);
  const { products, componentProducts } = catalog;

  // Every product that can be shown or quoted: the catalog plus bundle children outside it.
  const allProducts = useMemo(() => [...products, ...componentProducts], [products, componentProducts]);
  const byId = useMemo(() => new Map(allProducts.map((p) => [p.id, p])), [allProducts]);

  // Keep cart prices/names in step with Salesforce whenever the catalog is (re)loaded.
  const { refreshPrices } = cart;
  useEffect(() => {
    if (allProducts.length) refreshPrices(allProducts);
  }, [allProducts, refreshPrices]);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [route.name, route.id]);

  const families = useMemo(() => ['All', ...new Set(products.map((p) => p.family))].sort((a, b) => (a === 'All' ? -1 : a.localeCompare(b))), [products]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return products.filter(
      (p) =>
        (family === 'All' || p.family === family) &&
        (!q || [p.name, p.code, p.family, p.description].some((v) => v?.toLowerCase().includes(q))),
    );
  }, [products, query, family]);

  const detailProduct = byId.get(route.id);
  const chain = route.ids.map((id) => byId.get(id));
  const isBundleRoute = route.name === 'bundle';
  const isConfigureRoute = route.name === 'configure';
  const isQuoteRoute = route.name === 'quote';
  const onDetail = isBundleRoute || isConfigureRoute || isQuoteRoute;

  let detail = null;
  if (onDetail) {
    if (isQuoteRoute) detail = <QuotePage onBack={back} />;
    else if (catalog.status === 'loading') detail = <p className="state">Loading from Salesforce…</p>;
    else if (catalog.status === 'error') detail = <p className="state error">{catalog.error}</p>;
    else if (
      !detailProduct ||
      (isBundleRoute && !chain.every((b) => b?.isBundle)) ||
      (isConfigureRoute && !isConfigurable(detailProduct))
    ) {
      detail = (
        <div className="state">
          <p>That product could not be found.</p>
          <a className="btn btn-primary fit" href="#/">
            Back to products
          </a>
        </div>
      );
    } else if (isBundleRoute) {
      detail = <BundlePage key={route.ids.join('/')} product={detailProduct} chain={chain} byId={byId} onBack={back} />;
    } else {
      detail = <ConfigurePage key={detailProduct.id} product={detailProduct} onBack={back} />;
    }
  }

  return (
    <>
      <header className="topbar">
        <a className="brand" href="#/">
          <span className="brand-mark">
            <BoxIcon />
          </span>
          <span>DeepHealth Portal</span>
        </a>
        <div className="topbar-right">
          {cart.quote && (
            <a className="quote-pill" href="#/quote" title="View this quote's details and products">
              Quote #{cart.quote.quoteNumber} · {cart.quote.status}
            </a>
          )}
          <button className="btn btn-cart" onClick={() => setCartOpen(true)}>
            <CartIcon />
            Cart
            {cart.count > 0 && <span className="count">{cart.count}</span>}
          </button>
        </div>
      </header>

      <main className="page">
        {onDetail ? (
          detail
        ) : (
          <>
            <h1 className="title">Products</h1>

            <div className="stat">
              <span className="stat-icon">
                <BoxIcon />
              </span>
              <div>
                <strong>{catalog.status === 'ready' ? products.length : '–'}</strong>
                <small>Total Products</small>
              </div>
            </div>

            <div className="toolbar">
              <label className="search">
                <SearchIcon />
                <input
                  type="search"
                  placeholder="Search products by name, category, code or SKU…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
              <select className="select" value={family} onChange={(e) => setFamily(e.target.value)} aria-label="Filter by category">
                {families.map((f) => (
                  <option key={f}>{f}</option>
                ))}
              </select>
            </div>

            {catalog.status === 'loading' && <p className="state">Loading products from Salesforce…</p>}
            {catalog.status === 'error' && (
              <div className="state error">
                <p>{catalog.error}</p>
                <button className="btn btn-primary" onClick={catalog.reload}>
                  Retry
                </button>
              </div>
            )}
            {catalog.status === 'ready' && visible.length === 0 && <p className="state">No products match your search.</p>}

            <div className="grid">
              {visible.map((p) => (
                <ProductCard key={p.id} product={p} />
              ))}
            </div>
          </>
        )}
      </main>

      <Cart open={cartOpen} onClose={() => setCartOpen(false)} />
      <Toasts />
    </>
  );
}

export default function App() {
  const catalog = useCatalog();
  return (
    <CartProvider>
      <Storefront catalog={catalog} />
    </CartProvider>
  );
}
