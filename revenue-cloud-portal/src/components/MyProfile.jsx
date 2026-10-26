import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useCart } from '../cart.jsx';
import AddressFields, { emptyAddress } from './AddressFields.jsx';
import Breadcrumb from './Breadcrumb.jsx';

const norm = (a) => ({ ...emptyAddress, ...Object.fromEntries(Object.entries(a ?? {}).map(([k, v]) => [k, v ?? ''])) });

// My Profile: own name and phone; the Account's billing and shipping address is editable by the Account Admin only.
// These addresses are copied onto every new quote.
export default function MyProfile() {
  const { user, ready, openSignIn } = useAuth();
  const { notify } = useCart();
  const [p, setP] = useState(null);
  const [billing, setBilling] = useState(emptyAddress);
  const [shipping, setShipping] = useState(emptyAddress);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!user) return;
    api
      .getProfile()
      .then((d) => {
        setP(d);
        setBilling(norm(d.billing));
        setShipping(norm(d.shipping));
      })
      .catch((e) => setError(e.message));
  }, [user]);

  if (!ready) return null;
  if (!user) {
    return (
      <div className="state">
        <p>Sign in to see your profile.</p>
        <button className="btn-coral" onClick={openSignIn}>Sign in</button>
      </div>
    );
  }
  if (!p) return <p className="state">{error || 'Loading your profile…'}</p>;

  const set = (k) => (e) => setP((x) => ({ ...x, [k]: e.target.value }));
  const save = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const d = await api.saveProfile({ firstName: p.firstName, lastName: p.lastName, phone: p.phone, ...(p.canEditAccount ? { billing, shipping } : {}) });
      setP(d);
      notify('success', 'Profile saved');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="detail">
      <Breadcrumb current="My Profile" />
      <div className="page-head">
        <h1>My Profile</h1>
        {p.access !== 'Active' && <span className="tag-pill">Access: {p.access}</span>}
      </div>
      <form className="panel" onSubmit={save} style={{ display: 'grid', gap: 10, maxWidth: 520 }}>
        <p className="note">{p.accountName} · {p.email}</p>
        <input className="field" placeholder="First name" value={p.firstName ?? ''} onChange={set('firstName')} maxLength={40} />
        <input className="field" placeholder="Last name *" value={p.lastName ?? ''} onChange={set('lastName')} maxLength={80} required />
        <input className="field" placeholder="Phone" value={p.phone ?? ''} onChange={set('phone')} maxLength={40} />
        {p.access === 'Active' && (
          <>
            <AddressFields label={p.canEditAccount ? 'Billing address' : 'Billing address (changed by your account admin)'} value={billing} onChange={setBilling} disabled={!p.canEditAccount} required={p.canEditAccount} />
            <AddressFields label={p.canEditAccount ? 'Shipping address' : 'Shipping address (changed by your account admin)'} value={shipping} onChange={setShipping} disabled={!p.canEditAccount} />
          </>
        )}
        {error && <p role="alert" style={{ color: 'var(--coral)', margin: 0 }}>{error}</p>}
        <button className="btn-coral" disabled={busy}>{busy ? 'Saving…' : 'Save profile'}</button>
      </form>
    </section>
  );
}
