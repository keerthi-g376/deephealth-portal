import { useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useCart } from '../cart.jsx';

// "I'm interested": step 1 records the enquiry as a Lead, step 2 verifies the email with an emailed code.
// Verifying signs the customer in and converts the Lead (Account + Contact) in Salesforce, then the dialog
// closes and they carry on straight to choosing products.
export default function LeadForm({ countries, country, products, onClose }) {
  const { setUser } = useAuth();
  const { notify } = useCart();
  const [step, setStep] = useState('details'); // details | code
  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', company: '', phone: '', country: country?.code ?? '', productId: '', message: '', code: '' });
  const [state, setState] = useState({ busy: false, error: '' });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const run = (fn) => async (e) => {
    e.preventDefault();
    if (state.busy) return;
    setState({ busy: true, error: '' });
    try {
      await fn();
      setState({ busy: false, error: '' });
    } catch (err) {
      setState({ busy: false, error: err.message });
    }
  };

  const submitDetails = run(async () => {
    const { productId, code, ...rest } = form;
    await api.createLead({ ...rest, productIds: productId ? [productId] : [] });
    await api.requestCode(form.email);
    setStep('code');
  });

  const verify = run(async () => {
    const { firstName, lastName, email, company, country: countryCode, code } = form;
    const d = await api.verifyCode({ email, code, firstName, lastName, company, country: countryCode });
    setUser(d.user);
    onClose();
    notify('success', `Welcome ${d.user.name}! You're signed in - add products to the cart to start your quotation.`);
    window.location.hash = '#/';
  });

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" role="dialog" aria-label="I'm interested" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{step === 'details' ? "I'm interested" : 'Verify your email'}</h2>
          <button className="btn-soft" onClick={onClose}>Close</button>
        </div>
        <div className="modal-body">
          {step === 'details' ? (
            <form onSubmit={submitDetails} style={{ display: 'grid', gap: 8 }}>
              <input className="field" placeholder="First name" value={form.firstName} onChange={set('firstName')} maxLength={40} />
              <input className="field" placeholder="Last name *" value={form.lastName} onChange={set('lastName')} maxLength={80} required />
              <input className="field" type="email" placeholder="Work email *" value={form.email} onChange={set('email')} maxLength={254} required />
              <input className="field" placeholder="Company *" value={form.company} onChange={set('company')} maxLength={255} required />
              <input className="field" placeholder="Phone" value={form.phone} onChange={set('phone')} maxLength={40} />
              <select className="field" value={form.country} onChange={set('country')} required>
                <option value="">Country *</option>
                {countries.map((c) => (
                  <option key={c.code} value={c.code}>{c.name}</option>
                ))}
              </select>
              <select className="field" value={form.productId} onChange={set('productId')}>
                <option value="">Product of interest (optional)</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <textarea className="field" placeholder="Message" rows={3} value={form.message} onChange={set('message')} maxLength={1000} />
              {state.error && <p role="alert" style={{ color: 'var(--coral)', margin: 0 }}>{state.error}</p>}
              <button className="btn-coral" disabled={state.busy}>{state.busy ? 'Sending…' : 'Continue'}</button>
            </form>
          ) : (
            <form onSubmit={verify} style={{ display: 'grid', gap: 8 }}>
              <p className="note">We emailed a 6-digit code to {form.email}. Enter it to continue to the products.</p>
              <input className="field" inputMode="numeric" pattern="[0-9]{6}" placeholder="123456" value={form.code} onChange={set('code')} maxLength={6} required autoFocus />
              {state.error && <p role="alert" style={{ color: 'var(--coral)', margin: 0 }}>{state.error}</p>}
              <button className="btn-coral" disabled={state.busy}>{state.busy ? 'Checking…' : 'Verify and continue'}</button>
              <button type="button" className="btn-soft" onClick={() => { setStep('details'); setState({ busy: false, error: '' }); }}>Back</button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
