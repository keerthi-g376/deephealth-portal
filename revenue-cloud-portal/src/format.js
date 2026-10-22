const currencyFormatters = new Map();

// Currency used when a caller does not pass one: set from the country the visitor chose.
let displayCurrency = 'USD';
export const getDisplayCurrency = () => displayCurrency;
export const setDisplayCurrency = (c) => {
  displayCurrency = c || 'USD';
};

export function money(amount, currency = displayCurrency) {
  if (!currencyFormatters.has(currency)) {
    currencyFormatters.set(currency, new Intl.NumberFormat('en-US', { style: 'currency', currency }));
  }
  return currencyFormatters.get(currency).format(amount ?? 0);
}

// "Term Based - Yearly" style label for a selling model option.
export const sellingModelLabel = (m) => m.name || m.type || 'Selling model';

// Whole-unit amount (no decimals) in a currency, e.g. for filter labels.
export const moneyWhole = (amount, currency = displayCurrency) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount);
