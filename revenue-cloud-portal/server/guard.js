import crypto from 'node:crypto';

// Protections for running the portal on the public internet:
//  - customers sign in with an emailed one-time code; a signed, HttpOnly cookie then carries who they are
//  - requests are rate limited per client address, and sign-in attempts per email

const COOKIE = 'dhs';
const SESSION_MS = 12 * 3600 * 1000;
const CODE_WINDOW_MS = 10 * 60 * 1000;

const sign = (secret, payload) => crypto.createHmac('sha256', secret).update(payload).digest('base64url');

/* ---------------- sign-in codes (stateless: nothing to store, nothing to leak) ---------------- */

// A 6-digit code derived from the server secret, the email and a 10-minute window.
const codeFor = (secret, email, window) => {
  const digest = crypto.createHmac('sha256', secret).update(`code|${email}|${window}`).digest();
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, '0');
};
const currentWindow = () => Math.floor(Date.now() / CODE_WINDOW_MS);

export const makeCode = (secret, email) => codeFor(secret, email, currentWindow());

// Valid in the window it was issued in and the one after (so 10-20 minutes).
export function codeIsValid(secret, email, code) {
  const given = Buffer.from(String(code ?? ''));
  return [currentWindow(), currentWindow() - 1].some((w) => {
    const expected = Buffer.from(codeFor(secret, email, w));
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  });
}

/* ---------------- session cookie ---------------- */

// The signed-in customer ({ contactId, accountId, name, email }) or null (missing, forged or expired cookie).
export function readSession(req, secret) {
  const raw = /(?:^|;\s*)dhs=([^;]+)/.exec(req.headers.cookie || '')?.[1];
  if (!raw) return null;
  const [payload, signature] = raw.split('.');
  if (!payload || !signature) return null;
  const expected = Buffer.from(sign(secret, payload));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data?.exp > Date.now() && /^[a-zA-Z0-9]{15,18}$/.test(data.contactId) ? data : null;
  } catch {
    return null;
  }
}

export function startSession(req, res, secret, customer) {
  const payload = Buffer.from(JSON.stringify({ ...customer, exp: Date.now() + SESSION_MS })).toString('base64url');
  res.cookie(COOKIE, `${payload}.${sign(secret, payload)}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure, // true behind the host's HTTPS proxy (needs "trust proxy")
    path: '/',
    maxAge: SESSION_MS,
  });
}

export const endSession = (res) => res.clearCookie(COOKIE, { path: '/' });

/* ---------------- rate limiting ---------------- */

// Counts hits per key in a fixed window; returns true while the key is still within `max`.
export function hitCounter({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [key, hit] of hits) if (hit.resetAt <= now) hits.delete(key);
  }, windowMs).unref();

  return {
    allow(key) {
      const now = Date.now();
      let hit = hits.get(key);
      if (!hit || hit.resetAt <= now) {
        hit = { count: 0, resetAt: now + windowMs };
        hits.set(key, hit);
      }
      return ++hit.count <= max;
    },
    retryAfter: (key) => Math.ceil(((hits.get(key)?.resetAt ?? Date.now()) - Date.now()) / 1000),
  };
}

// Fixed-window rate limiter keyed by client address.
export function rateLimit({ windowMs, max, message = 'Too many requests. Please slow down and try again shortly.' }) {
  const counter = hitCounter({ windowMs, max });
  return (req, res, next) => {
    if (!counter.allow(req.ip)) {
      res.set('Retry-After', String(counter.retryAfter(req.ip)));
      return res.status(429).json({ error: message });
    }
    next();
  };
}
