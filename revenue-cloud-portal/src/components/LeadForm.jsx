import { useState } from 'react';
import { api } from '../api.js';

// "I'm interested" form: creates a Lead in Salesforce (de-duplicated by email there).
export default function LeadForm({ countries, country, products, onClose }) {
  const [form, setForm] = useState({ firstName: '', lastName: '', email: '', company: '', phone: '', country: country?.code ?? '', productId: '', message: '' });
  const [state, setState] = useState({ busy: false, error: '', done: false });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    if (state.busy) return;
    setState({ busy: true, error: '', done: false });
    try {
      const { productId, ...rest } = form;
      await api.createLead({ ...rest, productIds: productId ? [productId] : [] });
      setState({ busy: false, error: '', done: true });
    } catch (err) {
      setState({ busy: false, error: err.message, done: false });
    }
  };

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" role="dialog" aria-label="I'm interested" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>I'm interested</h2>
          <button className="btn-soft" onClick={onClose}>Close</button>
        </div>
        <div className="modal-body">
          {state.done ? (
            <p>Thank you.</p>
          ) : (
            <form onSubmit={submit} style={{ display: 'grid', gap: 8 }}>
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
              <button className="btn-coral" disabled={state.busy}>{state.busy ? 'Sending…' : 'Submit'}</button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
