// Country -> selling currency. Prices come from the Standard Price Book entries in that currency, so every
// currency listed here needs active entries in Salesforce (Multi-Currency). Override with COUNTRIES_JSON.
const DEFAULTS = [
  { code: 'US', name: 'United States', currency: 'USD' },
  { code: 'GB', name: 'United Kingdom', currency: 'GBP' },
  { code: 'DE', name: 'Germany', currency: 'EUR' },
  { code: 'FR', name: 'France', currency: 'EUR' },
  { code: 'IN', name: 'India', currency: 'INR' },
  { code: 'AU', name: 'Australia', currency: 'AUD' },
  { code: 'CA', name: 'Canada', currency: 'CAD' },
];

function load() {
  try {
    const list = process.env.COUNTRIES_JSON ? JSON.parse(process.env.COUNTRIES_JSON) : DEFAULTS;
    return list.filter((c) => /^[A-Z]{2}$/.test(c.code) && /^[A-Z]{3}$/.test(c.currency) && c.name);
  } catch {
    return DEFAULTS;
  }
}

export const countries = load();
export const countryByCode = (code) => countries.find((c) => c.code === String(code || '').toUpperCase());
