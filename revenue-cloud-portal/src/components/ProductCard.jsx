import { isConfigurable } from '../attributes.js';
import { useCart } from '../cart.jsx';
import { money, sellingModelLabel } from '../format.js';
import { BoxIcon, CartIcon, LayersIcon, MinusIcon, PlusIcon, SlidersIcon } from './icons.jsx';

export default function ProductCard({ product }) {
  const { items, add, setQty, remove } = useCart();
  // top-level lines of this product (components nested under a bundle are not "this card's" lines)
  const lines = items.filter((i) => i.productId === product.id && !i.parentLineId);
  const inCart = items.filter((i) => i.productId === product.id).reduce((n, i) => n + i.quantity, 0);
  const target = lines[lines.length - 1];
  const priced = product.unitPrice != null;
  // A bundle's attributes are chosen on its Components page, so its card shows Components instead of Configure.
  const configurable = isConfigurable(product) && !product.isBundle;
  const term = product.sellingModels.length > 0 ? sellingModelLabel(product.sellingModels[0]) : '';

  const minus = () => {
    if (!target) return;
    if (target.quantity <= 1) remove(target.lineId);
    else setQty(target.lineId, target.quantity - 1);
  };
  const plus = () => (target ? setQty(target.lineId, target.quantity + 1) : add(product));

  return (
    <article className="card">
      <div className="card-tags">
        {product.code && <span className="tag-pill tag-dark">{product.code}</span>}
        {product.family && <span className="tag-pill tag-green">{product.family}</span>}
      </div>

      <div className="card-media">
        {product.image ? <img src={product.image} alt="" loading="lazy" /> : <BoxIcon width={44} height={44} />}
      </div>

      <div className="card-price">
        {priced ? (
          <>
            <strong>{money(product.unitPrice, product.currency)}</strong>
            <small>per unit</small>
          </>
        ) : (
          <small>No active price</small>
        )}
      </div>

      <h3 className="card-title" title={product.description || product.name}>
        {product.name}
      </h3>
      {term && <p className="card-term">{term}</p>}

      <div className="card-badge-row">
        {product.isBundle ? (
          <a className="badge-outline" href={`#/bundle/${product.id}`} title="See the products in this bundle">
            <LayersIcon width={12} height={12} />
            Components ({product.components.length})
          </a>
        ) : configurable ? (
          <a className="badge-outline" href={`#/configure/${product.id}`} title="Choose attribute values before adding">
            <SlidersIcon width={12} height={12} />
            Configure
          </a>
        ) : null}
      </div>

      {inCart > 0 ? (
        <div className="added-bar">
          <button type="button" onClick={minus} aria-label={`Remove one ${product.name}`}>
            <MinusIcon width={14} height={14} />
          </button>
          <span>Added ({inCart})</span>
          <button type="button" onClick={plus} aria-label={`Add one more ${product.name}`}>
            <PlusIcon width={14} height={14} />
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="btn-soft"
          disabled={!priced}
          onClick={() => add(product)}
          title={priced ? undefined : 'This product has no active Standard Price Book entry'}
        >
          <CartIcon width={14} height={14} />
          Add
        </button>
      )}
    </article>
  );
}
