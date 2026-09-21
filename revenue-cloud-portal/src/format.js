const currencyFormatters = new Map();

export function money(amount, currency = 'USD') {
  if (!currencyFormatters.has(currency)) {
    currencyFormatters.set(currency, new Intl.NumberFormat('en-US', { style: 'currency', currency }));
  }
  return currencyFormatters.get(currency).format(amount ?? 0);
}

// "Term Based - Yearly" style label for a selling model option.
export const sellingModelLabel = (m) => m.name || m.type || 'Selling model';
