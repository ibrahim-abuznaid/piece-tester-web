/** The full secret-bearing settings row this view reads from. */
export interface SettingsForView {
  base_url: string;
  project_id: string;
  test_timeout_ms: number;
  ai_model: string;
  updated_at: string;
  api_key: string;
  jwt_token: string;
  anthropic_api_key: string;
  mcp_token: string;
  mcp_access_token: string;
  mcp_refresh_token: string;
  mcp_token_expiry: string;
  mcp_client_id: string;
  mcp_pkce_verifier: string;
  mcp_oauth_state: string;
}

/** Mask a secret as head…tail, but only when it is long enough that the
 *  head+tail windows leave a hidden gap. Short values get a fixed bullet mask. */
function maskLong(v: string, head: number, minLen: number): string {
  if (!v) return '';
  if (v.length <= minLen) return '••••••';
  return v.slice(0, head) + '...' + v.slice(-4);
}

/**
 * Client-safe settings shape — presence + masked hints only, never raw secrets.
 * SECURITY: never spread `s` into the return value. Return an explicit literal of
 * non-secret fields only; every secret field on the row is intentionally omitted.
 */
export function maskedSettings(s: SettingsForView) {
  return {
    base_url: s.base_url,
    project_id: s.project_id,
    test_timeout_ms: s.test_timeout_ms,
    ai_model: s.ai_model,
    updated_at: s.updated_at,
    has_api_key: !!s.api_key,
    api_key_masked: maskLong(s.api_key, 6, 12),
    has_jwt: !!s.jwt_token,
    has_anthropic_key: !!s.anthropic_api_key,
    anthropic_key_masked: maskLong(s.anthropic_api_key, 10, 18),
    has_mcp_token: !!(s.mcp_access_token || s.mcp_token),
    mcp_connected_via_oauth: !!s.mcp_access_token,
    mcp_token_masked: s.mcp_token ? '...' + s.mcp_token.slice(-8) : '',
  };
}
