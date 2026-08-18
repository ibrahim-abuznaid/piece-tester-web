import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { signToken, verifyToken } from './auth.js';
import { isValidPassword, isRateLimited, recordFailure, recordSuccess } from './auth.js';
import { requireAuth } from './auth.js';

beforeEach(() => {
  process.env.APP_AUTH_PASSWORD = 'secret123';
  process.env.SESSION_SECRET = 'test-secret-please-change';
});

afterEach(() => {
  delete process.env.APP_AUTH_PASSWORD;
  delete process.env.SESSION_SECRET;
});

describe('session tokens', () => {
  it('verifies a freshly signed token', () => {
    expect(verifyToken(signToken())).toBe(true);
  });
  it('rejects a tampered token', () => {
    expect(verifyToken(signToken() + 'x')).toBe(false);
  });
  it('rejects an expired token', () => {
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000; // TTL is 7 days
    expect(verifyToken(signToken(eightDaysAgo))).toBe(false);
  });
  it('rejects garbage', () => {
    expect(verifyToken('')).toBe(false);
    expect(verifyToken('no-dot')).toBe(false);
  });
  it('rejects a same-length but wrong-signature token (exercises timingSafeEqual)', () => {
    const token = signToken();
    const dot = token.indexOf('.');
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    // Flip the first character of the signature while keeping its length identical
    const flipped = String.fromCharCode(sig.charCodeAt(0) ^ 1) + sig.slice(1);
    const mutated = `${payload}.${flipped}`;
    expect(verifyToken(mutated)).toBe(false);
  });
});

describe('password check', () => {
  it('accepts the correct password', () => {
    expect(isValidPassword('secret123')).toBe(true);
  });
  it('rejects the wrong password', () => {
    expect(isValidPassword('nope')).toBe(false);
  });
  it('rejects non-strings', () => {
    expect(isValidPassword(undefined)).toBe(false);
  });
});

describe('login throttle', () => {
  it('locks a source after repeated failures, and clears on success', () => {
    const ip = '1.2.3.4';
    recordSuccess(ip);
    for (let i = 0; i < 5; i++) recordFailure(ip);
    expect(isRateLimited(ip)).toBe(true);
    recordSuccess(ip);
    expect(isRateLimited(ip)).toBe(false);
  });
  it('is no longer rate-limited after the 15-minute lock window expires', () => {
    const ip = '5.6.7.8';
    recordSuccess(ip);
    for (let i = 0; i < 5; i++) recordFailure(ip);
    expect(isRateLimited(ip)).toBe(true);
    // Simulate checking 16 minutes in the future — lock should have expired
    expect(isRateLimited(ip, Date.now() + 16 * 60 * 1000)).toBe(false);
  });
});

function mockRes() {
  return {
    statusCode: 0,
    body: null as any,
    status(c: number) { this.statusCode = c; return this; },
    json(b: any) { this.body = b; return this; },
  };
}

describe('requireAuth', () => {
  it('401s when no cookie is present', () => {
    const res = mockRes();
    let nexted = false;
    requireAuth({ headers: {} } as any, res as any, () => { nexted = true; });
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(401);
  });
  it('calls next() with a valid session cookie', () => {
    const res = mockRes();
    let nexted = false;
    const req = { headers: { cookie: `pt_session=${signToken()}` } } as any;
    requireAuth(req, res as any, () => { nexted = true; });
    expect(nexted).toBe(true);
    expect(res.statusCode).toBe(0);
  });
  it('401s with a tampered cookie', () => {
    const res = mockRes();
    const req = { headers: { cookie: `pt_session=${signToken()}x` } } as any;
    requireAuth(req, res as any, () => {});
    expect(res.statusCode).toBe(401);
  });
});
