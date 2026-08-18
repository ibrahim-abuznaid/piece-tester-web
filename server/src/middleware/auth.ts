import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

let generatedSecret: string | null = null;
function getSessionSecret(): string {
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  if (!generatedSecret) {
    generatedSecret = crypto.randomBytes(32).toString('base64url');
    console.warn('[auth] SESSION_SECRET not set — generated an ephemeral secret; sessions will not survive a restart. Set SESSION_SECRET in .env.');
  }
  return generatedSecret;
}

function hmac(value: string): string {
  return crypto.createHmac('sha256', getSessionSecret()).update(value).digest('base64url');
}

export function signToken(now: number = Date.now()): string {
  const payload = Buffer.from(String(now + SESSION_TTL_MS)).toString('base64url');
  return `${payload}.${hmac(payload)}`;
}

export function verifyToken(token: unknown, now: number = Date.now()): boolean {
  if (typeof token !== 'string' || !token.includes('.')) return false;
  const dot = token.indexOf('.');
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const a = Buffer.from(sig);
  const b = Buffer.from(hmac(payload));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  const expiry = parseInt(Buffer.from(payload, 'base64url').toString(), 10);
  return Number.isFinite(expiry) && expiry > now;
}

function getPassword(): string {
  return process.env.APP_AUTH_PASSWORD ?? '';
}

export function isValidPassword(input: unknown): boolean {
  const expected = getPassword();
  if (!expected || typeof input !== 'string') return false;
  const a = Buffer.from(input);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ── Login throttle (in-memory, per source IP) ──
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000; // 15 minutes
const attempts = new Map<string, { fails: number; lockedUntil: number }>();

export function isRateLimited(ip: string, now: number = Date.now()): boolean {
  const rec = attempts.get(ip);
  return !!rec && rec.lockedUntil > now;
}

export function recordFailure(ip: string, now: number = Date.now()): void {
  // Prune stale entries to keep the map bounded
  for (const [k, v] of attempts) {
    if (v.lockedUntil < now && v.fails === 0) attempts.delete(k);
  }
  const rec = attempts.get(ip) ?? { fails: 0, lockedUntil: 0 };
  rec.fails += 1;
  if (rec.fails >= MAX_FAILS) {
    rec.lockedUntil = now + LOCK_MS;
    rec.fails = 0;
  }
  attempts.set(ip, rec);
}

export function recordSuccess(ip: string): void {
  attempts.delete(ip);
}

const COOKIE_NAME = 'pt_session';

function parseCookies(header?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k) out[k] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function cookieSecure(req: Request): boolean {
  const override = process.env.COOKIE_SECURE;
  if (override === 'true') return true;
  if (override === 'false') return false;
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
  return req.secure || proto === 'https';
}

export function issueSession(req: Request, res: Response): void {
  res.cookie(COOKIE_NAME, signToken(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: cookieSecure(req),
    path: '/',
    maxAge: SESSION_TTL_MS,
  });
}

export function clearSession(res: Response): void {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

export function isAuthenticated(req: Request): boolean {
  return verifyToken(parseCookies(req.headers.cookie)[COOKIE_NAME]);
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (isAuthenticated(req)) return next();
  res.status(401).json({ error: 'Authentication required' });
}

/** Fail closed if the shared password is not configured. Call once at startup. */
export function assertAuthConfig(): void {
  if (!getPassword()) {
    console.error('[auth] APP_AUTH_PASSWORD is not set. Refusing to start. Set it in .env');
    process.exit(1);
  }
  getSessionSecret(); // triggers the ephemeral-secret warning if unset
}
