import type { Request, Response, NextFunction } from 'express';

// The MCP OAuth provider redirects the browser back here from another site.
const CROSS_SITE_ALLOWED = new Set(['/settings/mcp-callback']);

/**
 * Browsers label every request with Sec-Fetch-Site. "cross-site" means another website
 * triggered it (a link, an <img>, a form), and the SameSite=Lax session cookie still rides
 * along on GET navigations — some of which start paid AI runs. Non-browser clients send no
 * header and are unaffected. Mount on /api.
 */
export function rejectCrossSiteRequests(req: Request, res: Response, next: NextFunction): void {
  if (req.headers['sec-fetch-site'] === 'cross-site' && !CROSS_SITE_ALLOWED.has(req.path)) {
    res.status(403).json({ error: 'Cross-site request blocked' });
    return;
  }
  next();
}
