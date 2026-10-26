export const emptyAddress = { street: '', city: '', state: '', postalCode: '', country: '' };

// Street / city / state / postal code / country inputs for one address.
export default function AddressFields({ value, onChange, label, disabled = false, required = false }) {
  const set = (k) => (e) => onChange({ ...value, [k]: e.target.value });
  return (
    <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 8 }} disabled={disabled}>
      <legend className="note" style={{ padding: 0, marginBottom: 4 }}>{label}</legend>
      <input className="field" placeholder={`Street${required ? ' *' : ''}`} value={value.street} onChange={set('street')} maxLength={255} required={required} />
      <input className="field" placeholder={`City${required ? ' *' : ''}`} value={value.city} onChange={set('city')} maxLength={80} required={required} />
      <input className="field" placeholder="State / region" value={value.state} onChange={set('state')} maxLength={80} />
      <input className="field" placeholder="Postal code" value={value.postalCode} onChange={set('postalCode')} maxLength={20} />
      <input className="field" placeholder={`Country${required ? ' *' : ''}`} value={value.country} onChange={set('country')} maxLength={80} required={required} />
    </fieldset>
  );
}
