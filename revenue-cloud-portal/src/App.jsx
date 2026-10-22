import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';
import { isConfigurable } from './attributes.js';
import { AuthProvider, useAuth } from './auth.jsx';
import { CartProvider, useCart } from './cart.jsx';
import BundlePage from './components/BundlePage.jsx';
import Cart, { CartPage } from './components/Cart.jsx';
import ChatWidget from './components/ChatWidget.jsx';
import ConfigurePage from './components/ConfigurePage.jsx';
import ProductCard from './components/ProductCard.jsx';
import QuotePage from './components/QuotePage.jsx';
import LeadForm from './components/LeadForm.jsx';
import MyQuotes from './components/MyQuotes.jsx';
import SignInModal from './components/SignInModal.jsx';
import Toasts from './components/Toasts.jsx';
import { setDisplayCurrency } from './format.js';
import { ArrowRightIcon, BellIcon, CartIcon, ChevronDownIcon, FilterIcon, SearchIcon } from './components/icons.jsx';

const initialsOf = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');

const PRICE_RANGES = [
  { id: 'any', label: 'Price Range', test: () => true },
  { id: 'lt1k', label: 'Under $1,000', test: (p) => p < 1000 },
  { id: '1k-10k', label: '$1,000 – $10,000', test: (p) => p >= 1000 && p <= 10000 },
  { id: 'gt10k', label: 'Over $10,000', test: (p) => p > 10000 },
];
const SORTS = [
  { id: 'default', label: 'Sort by', cmp: null },
  { id: 'name', label: 'Name (A–Z)', cmp: (a, b) => a.name.localeCompare(b.name) },
  { id: 'price-asc', label: 'Price: low to high', cmp: (a, b) => (a.unitPrice ?? Infinity) - (b.unitPrice ?? Infinity) },
  { id: 'price-desc', label: 'Price: high to low', cmp: (a, b) => (b.unitPrice ?? -Infinity) - (a.unitPrice ?? -Infinity) },
];
const PAGE_SIZES = [8, 12, 24, 48];

// A filter chip: a native <select> dressed as a pill (keeps keyboard + mobile behaviour for free).
function Chip({ value, onChange, children, solid = false, label }) {
  return (
    <label className={`chip-select ${solid ? 'solid' : ''}`}>
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
        {children}
      </select>
      <ChevronDownIcon width={12} height={12} />
    </label>
  );
}

function useCountry() {
  const [countries, setCountries] = useState([]);
  const [code, setCode] = useState(() => {
    try {
      return localStorage.getItem('dh-country') || '';
    } catch {
      return '';
    }
  });
  useEffect(() => {
    api.getCountries().then(setCountries).catch(() => {});
  }, []);
  const country = countries.find((c) => c.code === code) ?? null;
  const choose = (c) => {
    setCode(c);
    try {
      localStorage.setItem('dh-country', c);
    } catch {
      /* storage unavailable: the choice just won't persist */
    }
  };
  return { countries, country, choose };
}

function useCatalog(countryCode) {
  const [state, setState] = useState({ status: 'loading', products: [], componentProducts: [], error: '' });
  const load = useCallback(() => {
    setState((s) => ({ ...s, status: 'loading', error: '' }));
    api
      .getProducts(countryCode)
      .then((d) => {
        setDisplayCurrency(d.country?.currency);
        setState({ status: 'ready', products: d.products, componentProducts: d.componentProducts ?? [], error: '' });
      })
      .catch((e) => setState((s) => ({ ...s, status: 'error', error: e.message })));
  }, [countryCode]);
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

function Storefront({ catalog, geo }) {
  const cart = useCart();
  const [leadOpen, setLeadOpen] = useState(false);
  const auth = useAuth();
  const { route, back } = useRoute();
  const [query, setQuery] = useState('');
  const [family, setFamily] = useState('All');
  const [priceRange, setPriceRange] = useState('any');
  const [sort, setSort] = useState('default');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);
  const [cartOpen, setCartOpen] = useState(false);
  const closeCart = useCallback(() => setCartOpen(false), []);
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
    const inRange = PRICE_RANGES.find((r) => r.id === priceRange).test;
    const list = products.filter(
      (p) =>
        (family === 'All' || p.family === family) &&
        (priceRange === 'any' || (p.unitPrice != null && inRange(p.unitPrice))) &&
        (!q || [p.name, p.code, p.family, p.description].some((v) => v?.toLowerCase().includes(q))),
    );
    const cmp = SORTS.find((x) => x.id === sort).cmp;
    return cmp ? [...list].sort(cmp) : list;
  }, [products, query, family, priceRange, sort]);

  const pages = Math.max(1, Math.ceil(visible.length / pageSize));
  const currentPage = Math.min(page, pages);
  const from = (currentPage - 1) * pageSize;
  const pageItems = visible.slice(from, from + pageSize);
  const activeFilters = (family !== 'All') + (priceRange !== 'any') + (sort !== 'default');
  const resetFilters = () => {
    setQuery('');
    setFamily('All');
    setPriceRange('any');
    setSort('default');
    setPage(1);
  };
  const pageNumbers = useMemo(() => {
    // 1 … current-1 current current+1 … last
    const set = new Set([1, pages, currentPage - 1, currentPage, currentPage + 1].filter((n) => n >= 1 && n <= pages));
    return [...set].sort((a, b) => a - b);
  }, [pages, currentPage]);

  const detailProduct = byId.get(route.id);
  const chain = route.ids.map((id) => byId.get(id));
  const isBundleRoute = route.name === 'bundle';
  const isConfigureRoute = route.name === 'configure';
  const isQuoteRoute = route.name === 'quote';
  const isCartRoute = route.name === 'cart';
  const isQuotesRoute = route.name === 'quotes';
  const onDetail = isBundleRoute || isConfigureRoute || isQuoteRoute || isCartRoute || isQuotesRoute;

  let detail = null;
  if (onDetail) {
    if (isQuotesRoute) detail = <MyQuotes onLoaded={geo.syncCurrency} />;
    else if (isQuoteRoute) detail = <QuotePage onBack={back} />;
    else if (isCartRoute) detail = <CartPage byId={byId} />;
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
        <a className="brand" href="#/" aria-label="CareSphere Health Portal - home">
          <span className="brand-name">CareSphere</span>
          <span className="brand-sub">Health Portal</span>
        </a>
        <div className="topbar-right">
          {cart.quote && (
            <a className="quote-pill" href="#/quote" title="View this quote's details and products">
              Quote #{cart.quote.quoteNumber} · {cart.quote.status}
            </a>
          )}
          <Chip value={geo.country?.code ?? ''} onChange={geo.choose} label="Country">
            <option value="" disabled={!!geo.country}>
              Select country
            </option>
            {geo.countries.map((c) => (
              <option key={c.code} value={c.code} disabled={(cart.count > 0 || !!cart.quote) && c.code !== geo.country?.code}>
                {c.name} ({c.currency})
              </option>
            ))}
          </Chip>
          <button className="cart-pill" onClick={() => setLeadOpen(true)}>
            I'm interested
          </button>
          <button className="cart-pill" onClick={() => setCartOpen(true)}>
            <CartIcon width={16} height={16} />
            Cart
            <span className="count">{cart.count}</span>
          </button>
          <button className="bell" aria-label="Notifications">
            <BellIcon width={18} height={18} />
          </button>
          {auth.user ? (
            <>
              <a className="view-all" href="#/quotes">My Quotations</a>
              <button className="account" title="Sign out" onClick={auth.signOut}>
                <span className="avatar">{initialsOf(auth.user.name)}</span>
                <span className="account-text">
                  <small>SIGN OUT</small>
                  <strong>{auth.user.name}</strong>
                </span>
              </button>
            </>
          ) : (
            <button className="cart-pill" onClick={auth.openSignIn}>Sign in</button>
          )}
        </div>
      </header>

      <main className="page">
        {onDetail ? (
          detail
        ) : (
          <>
            <div className="title-row">
              <h1 className="title">Products</h1>
              <button className="view-all" onClick={resetFilters}>
                View all products <ArrowRightIcon width={14} height={14} />
              </button>
            </div>

            <div className="toolbar">
              <label className="search">
                <SearchIcon width={16} height={16} />
                <input
                  type="search"
                  placeholder="Search products..."
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setPage(1);
                  }}
                />
              </label>
              <div className="chip-row">
                <Chip solid label="Filter by category" value={family} onChange={(v) => { setFamily(v); setPage(1); }}>
                  {families.map((f) => (
                    <option key={f} value={f}>
                      {f === 'All' ? 'All Categories' : f}
                    </option>
                  ))}
                </Chip>
                <Chip label="Filter by price range" value={priceRange} onChange={(v) => { setPriceRange(v); setPage(1); }}>
                  {PRICE_RANGES.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
                </Chip>
                <Chip label="Sort products" value={sort} onChange={(v) => { setSort(v); setPage(1); }}>
                  {SORTS.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.label}
                    </option>
                  ))}
                </Chip>
                <button className="filters-btn" onClick={resetFilters} disabled={activeFilters === 0} title="Clear all filters">
                  <FilterIcon width={13} height={13} /> Filters
                  {activeFilters > 0 && <span className="count">{activeFilters}</span>}
                </button>
              </div>
            </div>

            {catalog.status === 'loading' && <p className="state">Loading products from Salesforce…</p>}
            {catalog.status === 'error' && (
              <div className="state error">
                <p>{catalog.error}</p>
                <button className="btn-coral" onClick={catalog.reload}>
                  Retry
                </button>
              </div>
            )}
            {catalog.status === 'ready' && visible.length === 0 && <p className="state">No products match your search.</p>}

            <div className="grid">
              {pageItems.map((p) => (
                <ProductCard key={p.id} product={p} />
              ))}
            </div>

            {catalog.status === 'ready' && visible.length > 0 && (
              <footer className="pager">
                <span className="pager-count">
                  Showing {from + 1}–{from + pageItems.length} of {visible.length} products
                </span>
                {pages > 1 && (
                  <nav className="pager-pages" aria-label="Pagination">
                    <button onClick={() => setPage(currentPage - 1)} disabled={currentPage === 1} aria-label="Previous page">
                      ‹
                    </button>
                    {pageNumbers.map((n, i) => (
                      <span key={n} className="pager-slot">
                        {i > 0 && n - pageNumbers[i - 1] > 1 && <span className="pager-gap">…</span>}
                        <button className={n === currentPage ? 'on' : ''} onClick={() => setPage(n)} aria-current={n === currentPage ? 'page' : undefined}>
                          {n}
                        </button>
                      </span>
                    ))}
                    <button onClick={() => setPage(currentPage + 1)} disabled={currentPage === pages} aria-label="Next page">
                      ›
                    </button>
                  </nav>
                )}
                <label className="pager-size">
                  Items per page
                  <select
                    value={pageSize}
                    onChange={(e) => {
                      setPageSize(Number(e.target.value));
                      setPage(1);
                    }}
                  >
                    {PAGE_SIZES.map((n) => (
                      <option key={n}>{n}</option>
                    ))}
                  </select>
                </label>
              </footer>
            )}
          </>
        )}
      </main>

      <Cart open={cartOpen} onClose={closeCart} byId={byId} />
      {catalog.status === 'ready' && <ChatWidget products={products} byId={byId} />}
      {leadOpen && <LeadForm countries={geo.countries} country={geo.country} products={products} onClose={() => setLeadOpen(false)} />}
      <SignInModal countryCode={geo.country?.code ?? ''} />
      <Toasts />
    </>
  );
}

export default function App() {
  const geo = useCountry();
  // a loaded quotation is priced in its own currency: switch the storefront to a country that uses it
  geo.syncCurrency = (currency) => {
    const match = geo.countries.find((c) => c.currency === currency);
    if (match && match.currency !== geo.country?.currency) geo.choose(match.code);
  };
  const catalog = useCatalog(geo.country?.code ?? '');
  return (
    <AuthProvider>
      <CartProvider>
        <Storefront catalog={catalog} geo={geo} />
      </CartProvider>
    </AuthProvider>
  );
}
