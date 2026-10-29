import { useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';

// Email -> emailed 6-digit code -> (first time only) registration details.
// A colleague of a company that is already registered only gives their name and then waits for approval.
// A new company gives just its name (or registers as an individual); addresses can be added later in My Profile.
export default function SignInModal({ countryCode }) {
  const { dialog, closeSignIn, setUser } = useAuth();
  const [step, setStep] = useState('email'); // email | code | profile
  const [f, setF] = useState({ email: '', code: '', firstName: '', lastName: '', phone: '', company: '', individual: false });
  const [colleague, setColleague] = useState(null); // { accountName } when the email's company already exists
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

  const reset = () => {
    setStep('email');
    setF({ email: '', code: '', firstName: '', lastName: '', phone: '', company: '', individual: false });
    setColleague(null);
  };

  const sendCode = run(async () => {
    await api.requestCode(f.email);
    setStep('code');
  });
  const verify = run(async () => {
    const d = await api.verifyCode({
      ...f,
      country: countryCode,
      joinExisting: !!colleague,
    });
    if (d.needsProfile) {
      setColleague(d.domainMatch ? { accountName: d.accountName } : null);
      return setStep('profile');
    }
    setUser(d.user);
    closeSignIn();
    reset();
  });

  return (
    <div className="modal-scrim" onClick={closeSignIn}>
      <div className="modal" role="dialog" aria-label="Sign in" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{step === 'profile' ? 'Create your account' : 'Sign in to your quotations'}</h2>
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
              <button type="button" className="btn-soft" onClick={reset}>Use a different email</button>
            </form>
          )}
          {step === 'profile' && (
            <form onSubmit={verify} style={{ display: 'grid', gap: 8 }}>
              {colleague ? (
<>
                  <p role="alert" style={{ margin: 0, fontWeight: 700 }}>An account for {colleague.accountName} already exists.</p>
                  <p className="note">
                    Enter your contact details to request access. Its account owner approves you (we will email you a confirmation). Until then you can browse prices but not create quotes.
                  </p>
                  <button type="button" className="btn-soft" onClick={() => { setColleague(null); setF((x) => ({ ...x, company: '' })); }}>
                    Use a different company name
                  </button>
                </>
              ) : (
                <p className="note">Welcome! Tell us who you are to create your account.</p>
              )}
              <input className="field" placeholder="First name" value={f.firstName} onChange={set('firstName')} maxLength={40} />
              <input className="field" placeholder="Last name *" value={f.lastName} onChange={set('lastName')} maxLength={80} required />
              <input className="field" placeholder="Phone" value={f.phone} onChange={set('phone')} maxLength={40} />
              {!colleague && (
                <>
                  <input className="field" placeholder="Company *" value={f.company} onChange={set('company')} maxLength={255} required={!f.individual} disabled={f.individual} />
                  <label className="note" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input type="checkbox" checked={f.individual} onChange={(e) => setF((x) => ({ ...x, individual: e.target.checked, company: '' }))} />
                    I don't have a company (register as an individual)
                  </label>
                </>
              )}
              {error && <p role="alert" style={{ color: 'var(--coral)', margin: 0 }}>{error}</p>}
              <button className="btn-coral" disabled={busy}>{busy ? 'Creating…' : 'Continue'}</button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
