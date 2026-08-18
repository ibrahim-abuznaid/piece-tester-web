import { Router } from 'express';
import {
  isValidPassword, issueSession, clearSession, isAuthenticated,
  isRateLimited, recordFailure, recordSuccess,
} from '../middleware/auth.js';

const router = Router();

function clientIp(req: any): string {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

router.post('/login', (req, res) => {
  const ip = clientIp(req);
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  }
  if (!isValidPassword(req.body?.password)) {
    recordFailure(ip);
    return res.status(401).json({ error: 'Invalid password' });
  }
  recordSuccess(ip);
  issueSession(req, res);
  res.json({ success: true });
});

router.post('/logout', (_req, res) => {
  clearSession(res);
  res.json({ success: true });
});

router.get('/status', (req, res) => {
  res.json({ authenticated: isAuthenticated(req) });
});

export default router;
