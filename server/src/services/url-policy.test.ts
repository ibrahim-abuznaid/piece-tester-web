import { describe, it, expect, afterEach } from 'vitest';
import { isAllowedApUrl, isAllowedDiscordWebhook } from './url-policy.js';

afterEach(() => {
  delete process.env.AP_ALLOWED_ORIGINS;
});

describe('isAllowedApUrl', () => {
  it('accepts Activepieces Cloud', () => {
    expect(isAllowedApUrl('https://cloud.activepieces.com/api')).toBe(true);
    expect(isAllowedApUrl('https://cloud.activepieces.com/api/v1/webhooks/abc123')).toBe(true);
  });

  it('rejects any other host', () => {
    expect(isAllowedApUrl('https://attacker.invalid/api')).toBe(false);
  });

  it('rejects plain http to Cloud', () => {
    expect(isAllowedApUrl('http://cloud.activepieces.com/api')).toBe(false);
  });

  it('rejects look-alike hosts', () => {
    expect(isAllowedApUrl('https://cloud.activepieces.com.attacker.invalid/api')).toBe(false);
    expect(isAllowedApUrl('https://cloud.activepieces.com@attacker.invalid/api')).toBe(false);
  });

  it('rejects internal addresses', () => {
    expect(isAllowedApUrl('http://169.254.169.254/latest/meta-data')).toBe(false);
    expect(isAllowedApUrl('http://127.0.0.1:4000/api')).toBe(false);
  });

  it('rejects strings that are not URLs', () => {
    expect(isAllowedApUrl('not a url')).toBe(false);
    expect(isAllowedApUrl('')).toBe(false);
  });

  it('accepts extra origins listed in AP_ALLOWED_ORIGINS', () => {
    process.env.AP_ALLOWED_ORIGINS = 'http://localhost:4200, https://ap.example.com';
    expect(isAllowedApUrl('http://localhost:4200/api')).toBe(true);
    expect(isAllowedApUrl('https://ap.example.com/api')).toBe(true);
    expect(isAllowedApUrl('https://attacker.invalid/api')).toBe(false);
  });
});

describe('isAllowedDiscordWebhook', () => {
  it('accepts Discord webhook URLs', () => {
    expect(isAllowedDiscordWebhook('https://discord.com/api/webhooks/123/abc')).toBe(true);
    expect(isAllowedDiscordWebhook('https://discordapp.com/api/webhooks/123/abc')).toBe(true);
    expect(isAllowedDiscordWebhook('https://canary.discord.com/api/webhooks/123/abc')).toBe(true);
  });

  it('rejects Discord URLs that are not webhooks', () => {
    expect(isAllowedDiscordWebhook('https://discord.com/channels/1/2')).toBe(false);
  });

  it('rejects other hosts and plain http', () => {
    expect(isAllowedDiscordWebhook('https://attacker.invalid/api/webhooks/1/x')).toBe(false);
    expect(isAllowedDiscordWebhook('http://discord.com/api/webhooks/1/x')).toBe(false);
    expect(isAllowedDiscordWebhook('http://169.254.169.254/api/webhooks/1/x')).toBe(false);
  });
});
