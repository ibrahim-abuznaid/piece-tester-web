import { describe, it, expect } from 'vitest';
import { maskedSettings } from './settings-view.js';

const raw = {
  base_url: 'https://x/api', project_id: 'p1', test_timeout_ms: 1000,
  ai_model: 'claude-sonnet-4-6', updated_at: 'now',
  api_key: 'sk-secretapikey12345',
  jwt_token: 'jwt-secret-value',
  anthropic_api_key: 'sk-ant-supersecretkey',
  mcp_token: 'mcp-secret-token',
  mcp_access_token: 'mcp-access-secret',
  mcp_refresh_token: 'mcp-refresh-secret',
  mcp_token_expiry: '2026-01-01',
  mcp_client_id: 'client-id-123',
  mcp_pkce_verifier: 'pkce-verifier-secret',
  mcp_oauth_state: 'oauth-state-secret',
  linear_report_webhook_url: 'https://cloud.activepieces.com/api/v1/webhooks/SECRETHOOK',
  ap_service_email: 'user@activepieces.com',
  ap_service_password: 'enc:supersecretencryptedpassword',
  jwt_expiry: '2026-09-08T00:00:00.000Z',
  jwt_auth_status: 'ok',
  notify_webhook_url: 'https://discord.com/api/webhooks/1/SECRETHOOK',
  notify_enabled: 1,
  notify_storm_threshold: 8,
  notify_retest_count: 2,
  notify_reauth_digest_time: '09:00',
  batch_concurrency: 3,
  linear_api_key: 'lin_api_SUPERSECRETLINEARKEY1234567890abcd',
  bug_trend_roster: '[{"id":"u-kishan","name":"Kishan Parmar"}]',
};

describe('maskedSettings', () => {
  it('never returns raw secrets', () => {
    const out = maskedSettings(raw) as any;
    const s = JSON.stringify(out);
    for (const secret of ['sk-secretapikey12345', 'jwt-secret-value', 'sk-ant-supersecretkey', 'mcp-secret-token', 'mcp-access-secret', 'mcp-refresh-secret', 'pkce-verifier-secret', 'oauth-state-secret', 'enc:supersecretencryptedpassword']) {
      expect(s).not.toContain(secret);
    }
    expect(out.api_key).toBeUndefined();
    expect(out.anthropic_api_key).toBeUndefined();
    expect(out.jwt_token).toBeUndefined();
    expect(out.mcp_access_token).toBeUndefined();
    expect(out.mcp_token).toBeUndefined();
    expect(out.mcp_refresh_token).toBeUndefined();
    expect(out.mcp_pkce_verifier).toBeUndefined();
    expect(out.mcp_oauth_state).toBeUndefined();
    expect(out.ap_service_password).toBeUndefined();
    expect(out.ap_service_email).toBeUndefined();
  });
  it('exposes presence + masked hints', () => {
    const out = maskedSettings(raw) as any;
    expect(out.has_api_key).toBe(true);
    expect(out.has_anthropic_key).toBe(true);
    expect(out.has_jwt).toBe(true);
    expect(out.anthropic_key_masked).toContain('...');
    expect(out.base_url).toBe('https://x/api');
    expect(out.batch_concurrency).toBe(3);
  });
  it('reports absence when secrets are empty', () => {
    const out = maskedSettings({ ...raw, api_key: '', anthropic_api_key: '', jwt_token: '', mcp_token: '', mcp_access_token: '' }) as any;
    expect(out.has_api_key).toBe(false);
    expect(out.has_anthropic_key).toBe(false);
    expect(out.has_jwt).toBe(false);
    expect(out.api_key_masked).toBe('');
  });
  it('exposes the linear webhook as presence + mask, never raw', () => {
    const out = maskedSettings(raw) as any;
    expect(out.has_linear_webhook).toBe(true);
    expect(JSON.stringify(out)).not.toContain('SECRETHOOK');
    expect(out.linear_report_webhook_url).toBeUndefined();
  });
  it('exposes the discord webhook as presence + mask, never raw', () => {
    const out = maskedSettings(raw) as any;
    expect(out.has_notify_webhook).toBe(true);
    expect(JSON.stringify(out)).not.toContain('SECRETHOOK');
    expect(out.notify_webhook_url).toBeUndefined();
    expect(out.notify_enabled).toBe(1);
    expect(out.notify_storm_threshold).toBe(8);
    expect(out.notify_retest_count).toBe(2);
  });
  it('does not over-expose short secrets', () => {
    const out = maskedSettings({ ...raw, api_key: 'short', anthropic_api_key: 'alsoShortKey' }) as any;
    expect(out.api_key_masked).toBe('••••••');
    expect(out.api_key_masked).not.toContain('short');
    expect(out.anthropic_key_masked).toBe('••••••');
  });
  it('exposes the Linear API key as presence + mask, never raw', () => {
    const out = maskedSettings(raw) as any;
    expect(out.has_linear_api_key).toBe(true);
    expect(out.linear_api_key).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain('SUPERSECRETLINEARKEY');
    expect(out.linear_api_key_masked).toBe('lin_api_...abcd');
  });
  it('reports no Linear key when it is empty', () => {
    const out = maskedSettings({ ...raw, linear_api_key: '' }) as any;
    expect(out.has_linear_api_key).toBe(false);
    expect(out.linear_api_key_masked).toBe('');
  });
  it('returns the bug trend roster parsed, and [] when the stored value is unreadable', () => {
    expect((maskedSettings(raw) as any).bug_trend_roster).toEqual([{ id: 'u-kishan', name: 'Kishan Parmar' }]);
    expect((maskedSettings({ ...raw, bug_trend_roster: 'oops' }) as any).bug_trend_roster).toEqual([]);
  });
});
