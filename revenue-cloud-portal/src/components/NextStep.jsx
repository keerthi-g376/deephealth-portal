import { useAuth } from '../auth.jsx';
import { useCart } from '../cart.jsx';

const STEPS = ['Sign in', 'Choose products', 'Create quote'];

// Tells the customer where they are and what to do next, from their sign-in state, cart and quote.
export default function NextStep() {
  const { user, ready } = useAuth();
  const { items, quote, dirty } = useCart();
  if (!ready) return null;

  let step = 0;
  let text = 'Click Sign in (top right) with your email to start. Browsing prices does not need an account.';

  if (user?.access && user.access !== 'Active') {
    step = 1;
    text = 'Your access is waiting for approval from your account owner. You can browse prices, but you cannot create quotes yet.';
  } else if (user && !quote) {
    step = items.length ? 2 : 1;
    text = items.length ? `You have ${items.length} product${items.length === 1 ? '' : 's'} in the cart. Open the cart and click Create Quote.` : 'You are signed in. Add products to the cart to start your quotation.';
  } else if (user && quote) {
    step = 3;
    text = quote.status === 'Draft'
      ? dirty
        ? 'Your cart has changes. Open the cart and click Update Quote to save them.'
        : `Quote #${quote.quoteNumber} is created. To change it, update the cart and click Update Quote, or open My Quotations to see its details.`
      : `Quote #${quote.quoteNumber} is ${quote.status}. Open My Quotations to see its details.`;
  }

  return (
    <div className="panel" style={{ marginBottom: 12 }}>
      <ol style={{ display: 'flex', gap: 12, flexWrap: 'wrap', listStyle: 'none', margin: '0 0 8px', padding: 0, fontSize: '0.75rem' }}>
        {STEPS.map((label, i) => (
          <li key={label} style={{ fontWeight: i + 1 === Math.max(step, 1) ? 800 : 500, opacity: i + 1 <= Math.max(step, 1) ? 1 : 0.5 }}>
            {i + 1}. {label}
          </li>
        ))}
      </ol>
      <p style={{ margin: 0 }}>
        {text}
      </p>
    </div>
  );
}
