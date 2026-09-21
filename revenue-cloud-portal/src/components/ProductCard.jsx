import { isConfigurable } from '../attributes.js';
import { useCart } from '../cart.jsx';
import { money, sellingModelLabel } from '../format.js';
import { BoxIcon, CartIcon, CheckIcon, LayersIcon, SlidersIcon } from './icons.jsx';

export default function ProductCard({ product }) {
  const { items, add } = useCart();
  const inCart = items.filter((i) => i.productId === product.id).reduce((n, i) => n + i.quantity, 0);
  const priced = product.unitPrice != null;
  const configurable = isConfigurable(product);

  return (
    <article className="card">
      <div className="card-badges">
        {product.code ? <span className="badge badge-code">{product.code}</span> : <span />}
        <span className="badge badge-family">{product.family}</span>
      </div>

      <div className="card-media">
        {product.image ? <img src={product.image} alt="" loading="lazy" /> : <BoxIcon width={56} height={56} />}
      </div>

      <h3 className="card-title" title={product.name}>
        {product.name}
      </h3>
      {product.description && <p className="card-desc">{product.description}</p>}

      {product.sellingModels.length > 0 && (
        <div className="chips">
          {product.sellingModels.map((m, i) => (
            <span className="chip" key={i}>
              {sellingModelLabel(m)}
            </span>
          ))}
        </div>
      )}

      {configurable && (
        <div className="attrs">
          {product.attributes.map((a) => (
            <div className="attr" key={a.id}>
              <span className="attr-label">{a.label}</span>
              {a.values.length > 0 ? (
                <span className="attr-values">{a.values.map((v) => v.value).join(' · ')}</span>
              ) : (
                <span className="attr-values">{a.dataType}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {(product.isBundle || configurable) && (
        <div className="card-links">
          {product.isBundle && (
            <a className="btn btn-ghost" href={`#/bundle/${product.id}`} title="See the products in this bundle">
              <LayersIcon />
              Components ({product.components.length})
            </a>
          )}
          {configurable && (
            <a className="btn btn-ghost" href={`#/configure/${product.id}`} title="Choose attribute values before adding">
              <SlidersIcon />
              Configure
            </a>
          )}
        </div>
      )}

      <div className="card-foot">
        <div className="price">
          {priced ? (
            <>
              <strong>{money(product.unitPrice, product.currency)}</strong>
              <small>per unit</small>
            </>
          ) : (
            <small>No active price</small>
          )}
        </div>
        <button
          className="btn btn-add"
          disabled={!priced}
          onClick={() => add(product)}
          title={priced ? undefined : 'This product has no active Standard Price Book entry'}
        >
          {inCart > 0 ? <CheckIcon /> : <CartIcon />}
          {inCart > 0 ? `Added (${inCart})` : 'Add'}
        </button>
      </div>
    </article>
  );
}
