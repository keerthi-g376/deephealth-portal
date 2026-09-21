import { useCart } from '../cart.jsx';

export default function Toasts() {
  const { toasts, dismissToast } = useCart();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <button key={t.id} className={`toast toast-${t.type}`} onClick={() => dismissToast(t.id)}>
          {t.message}
        </button>
      ))}
    </div>
  );
}
