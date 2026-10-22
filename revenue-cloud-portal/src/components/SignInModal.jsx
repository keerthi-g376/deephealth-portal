import { useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';

// Email -> emailed 6-digit code -> (first time only) name and company. Verifying the email is what links the
// visitor to their Lead/Contact in Salesforce.
export default function SignInModal({ countryCode }) {
  const { dialog, closeSignIn, setUser } = useAuth();
  const [step, setStep] = useState('email'); // email | code | profile
  const [f, setF] = useState({ email: '', code: '', firstName: '', lastName: '', company: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!dialog) return null;
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));

  const run = (fn) => async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const sendCode = run(async () => {
    await api.requestCode(f.email);
    setStep('code');
  });
  const verify = run(async () => {
    const d = await api.verifyCode({ ...f, country: countryCode });
    if (d.needsProfile) return setStep('profile');
    setUser(d.user);
    closeSignIn();
    setStep('email');
    setF({ email: '', code: '', firstName: '', lastName: '', company: '' });
  });

  return (
    <div className="modal-scrim" onClick={closeSignIn}>
      <div className="modal" role="dialog" aria-label="Sign in" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Sign in to your quotations</h2>
          <button className="btn-soft" onClick={closeSignIn}>Close</button>
        </div>
        <div className="modal-body">
          {step === 'email' && (
            <form onSubmit={sendCode} style={{ display: 'grid', gap: 8 }}>
              <p className="note">We will email you a one-time code. No password needed.</p>
              <input className="field" type="email" placeholder="Work email" value={f.email} onChange={set('email')} maxLength={254} required autoFocus />
              {error && <p role="alert" style={{ color: 'var(--coral)', margin: 0 }}>{error}</p>}
              <button className="btn-coral" disabled={busy}>{busy ? 'Sending…' : 'Send code'}</button>
            </form>
          )}
          {step === 'code' && (
            <form onSubmit={verify} style={{ display: 'grid', gap: 8 }}>
              <p className="note">Enter the 6-digit code sent to {f.email}.</p>
              <input className="field" inputMode="numeric" pattern="[0-9]{6}" placeholder="123456" value={f.code} onChange={set('code')} maxLength={6} required autoFocus />
              {error && <p role="alert" style={{ color: 'var(--coral)', margin: 0 }}>{error}</p>}
              <button className="btn-coral" disabled={busy}>{busy ? 'Checking…' : 'Verify'}</button>
              <button type="button" className="btn-soft" onClick={() => { setStep('email'); setError(''); }}>Use a different email</button>
            </form>
          )}
          {step === 'profile' && (
            <form onSubmit={verify} style={{ display: 'grid', gap: 8 }}>
              <p className="note">Welcome! Tell us who you are to create your account.</p>
              <input className="field" placeholder="First name" value={f.firstName} onChange={set('firstName')} maxLength={40} />
              <input className="field" placeholder="Last name *" value={f.lastName} onChange={set('lastName')} maxLength={80} required />
              <input className="field" placeholder="Company *" value={f.company} onChange={set('company')} maxLength={255} required />
              {error && <p role="alert" style={{ color: 'var(--coral)', margin: 0 }}>{error}</p>}
              <button className="btn-coral" disabled={busy}>{busy ? 'Creating…' : 'Continue'}</button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
