// Hosts the server may send stored credentials or webhook payloads to. A logged-in user
// must not be able to point these at their own server (credential theft) or at internal
// addresses such as the cloud metadata endpoint (SSRF).

const DEFAULT_AP_ORIGINS = ['https://cloud.activepieces.com'];
const DISCORD_ORIGINS = ['https://discord.com', 'https://discordapp.com', 'https://ptb.discord.com', 'https://canary.discord.com'];

function originOf(raw: string): string | null {
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/** Self-hosted or local Activepieces instances can be added via AP_ALLOWED_ORIGINS (comma-separated). */
function apOrigins(): string[] {
  const extra = (process.env.AP_ALLOWED_ORIGINS ?? '').split(',').map(s => originOf(s.trim())).filter((o): o is string => !!o);
  return [...DEFAULT_AP_ORIGINS, ...extra];
}

export function isAllowedApUrl(raw: string): boolean {
  const origin = originOf(raw);
  return !!origin && apOrigins().includes(origin);
}

export function isAllowedDiscordWebhook(raw: string): boolean {
  const origin = originOf(raw);
  return !!origin && DISCORD_ORIGINS.includes(origin) && new URL(raw).pathname.startsWith('/api/webhooks/');
}

export function apUrlError(field: string): string {
  return `${field} is not allowed. Use one of: ${apOrigins().join(', ')} (add more with AP_ALLOWED_ORIGINS).`;
}
