export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(path, options = {}) {
  let res;
  try {
    res = await fetch(path, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...options.headers },
    });
  } catch {
    throw new ApiError('Cannot reach the portal server. Is it running?', 0);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(data?.error || `Request failed (${res.status})`, res.status);
  return data;
}

export const api = {
  getProducts: (country) => request(`/api/products${country ? `?country=${encodeURIComponent(country)}` : ''}`),
  getCountries: () => request('/api/countries'),
  createLead: (lead) => request('/api/leads', { method: 'POST', body: JSON.stringify(lead) }),
  health: () => request('/api/health'),
  chat: (messages, cart) => request('/api/chat', { method: 'POST', body: JSON.stringify({ messages, cart }) }),
  getQuote: (id) => request(`/api/quotes/${id}`),
  createQuote: (lineItems, { currency, reviseFrom } = {}) =>
    request('/api/quotes', { method: 'POST', body: JSON.stringify({ lineItems, currency, reviseFrom }) }),
  myQuotes: (scope) => request(`/api/my/quotes${scope === 'account' ? '?scope=account' : ''}`),
  quoteAction: (id, action, reason) => request(`/api/quotes/${id}/${action}`, { method: 'POST', body: JSON.stringify({ reason }) }),
  getProfile: () => request('/api/profile'),
  saveProfile: (profile) => request('/api/profile', { method: 'PUT', body: JSON.stringify(profile) }),
  quoteAsCart: (id) => request(`/api/quotes/${id}/cart`),
  me: () => request('/api/auth/me'),
  requestCode: (email) => request('/api/auth/request', { method: 'POST', body: JSON.stringify({ email }) }),
  verifyCode: (details) => request('/api/auth/verify', { method: 'POST', body: JSON.stringify(details) }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
  updateQuote: (id, lineItems) =>
    request(`/api/quotes/${id}`, { method: 'PATCH', body: JSON.stringify({ lineItems }) }),
};
