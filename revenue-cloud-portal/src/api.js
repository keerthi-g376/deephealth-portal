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
  getProducts: () => request('/api/products'),
  getQuote: (id) => request(`/api/quotes/${id}`),
  createQuote: (lineItems) => request('/api/quotes', { method: 'POST', body: JSON.stringify({ lineItems }) }),
  updateQuote: (id, lineItems) =>
    request(`/api/quotes/${id}`, { method: 'PATCH', body: JSON.stringify({ lineItems }) }),
};
