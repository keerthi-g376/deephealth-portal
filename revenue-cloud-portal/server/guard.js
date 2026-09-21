import crypto from 'node:crypto';

// Protections for running the portal on the public internet ("public mode"):
//  - a visitor can only read/update quotes THEY created (ids kept in a signed, HttpOnly cookie)
//  - requests are rate limited per client address

const COOKIE = 'dhq';
const MAX_IDS = 50; // most recent quotes remembered per visitor
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

const sign = (secret, payload) => crypto.createHmac('sha256', secret).update(payload).digest('base64url');

// Quote ids this visitor's cookie vouches for (empty when missing, tampered or forged).
export function readQuoteIds(req, secret) {
  const raw = /(?:^|;\s*)dhq=([^;]+)/.exec(req.headers.cookie || '')?.[1];
  if (!raw) return [];
  const [payload, signature] = raw.split('.');
  if (!payload || !signature) return [];
  const expected = Buffer.from(sign(secret, payload));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return [];
  try {
    const ids = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

// Adds a quote id to this visitor's cookie (call before sending the response).
export function rememberQuote(req, res, secret, quoteId) {
  const ids = [quoteId, ...readQuoteIds(req, secret).filter((id) => id !== quoteId)].slice(0, MAX_IDS);
  const payload = Buffer.from(JSON.stringify(ids)).toString('base64url');
  res.cookie(COOKIE, `${payload}.${sign(secret, payload)}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure, // true behind the host's HTTPS proxy (needs "trust proxy")
    path: '/',
    maxAge: MAX_AGE_MS,
  });
}

// Fixed-window rate limiter keyed by client address.
export function rateLimit({ windowMs, max, message = 'Too many requests. Please slow down and try again shortly.' }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [key, hit] of hits) if (hit.resetAt <= now) hits.delete(key);
  }, windowMs).unref();

  return (req, res, next) => {
    const now = Date.now();
    let hit = hits.get(req.ip);
    if (!hit || hit.resetAt <= now) {
      hit = { count: 0, resetAt: now + windowMs };
      hits.set(req.ip, hit);
    }
    if (++hit.count > max) {
      res.set('Retry-After', String(Math.ceil((hit.resetAt - now) / 1000)));
      return res.status(429).json({ error: message });
    }
    next();
  };
}
