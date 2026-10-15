import { parseApError } from './ap-error.js';

// Deterministic error classification for a thrown step — status codes + message, never an LLM.
// `auth`, `rate_limit`, `transient` and `quota` never implicate the piece; the rest can.
export type ErrorCategory =
  | 'auth' | 'rate_limit' | 'transient' | 'bad_request' | 'not_found' | 'piece_error' | 'quota' | 'unknown';

// Vendor account out of credits / over its plan / unpaid. Checked before auth and
// rate_limit because vendors return these under 401, 403 and 429 alike. The generic
// "quota exceeded" is deliberately absent: Google uses it for per-minute limits.
const QUOTA_PATTERNS = [
  /payment required/,
  /(no remaining|out of|insufficient|not enough|exhausted) (pre-?paid |your |more |additional )?credits?\b|(purchase|buy|top.?up) (pre-?paid |your |more |additional )?credits\b|credits? (exhausted|depleted)|(not|n't) (have )?enough credits|max(imum)? credits (exceeded|reached)/,
  /credit balance (is )?(too low|insufficient|exhausted|depleted|zero|negative)|insufficient_quota|insufficient (account )?(funds|balance|quota)|(reached|exceeded) your (current |monthly |usage |plan |spending )(limit|quota)\b|exceeded your quota\b|exceeds your (\w+ )?quota\b/,
  /(check|update|add|verify) (your )?billing (details|account|information)|billing (issue|problem)|upgrade (your|to a|the) (plan|subscription|account)|not available on your (current )?plan|requires an? (\w+ )?plan\b/,
  /(plan|usage|monthly|spending) (limit|quota) (reached|exceeded|hit)|(daily|monthly) (\w+ )?quota (reached|exceeded)|trial (has |is |has been )?(expired|ended)|subscription (has |is |has been |was )?(expired|ended|lapsed|inactive|not active)|account (is |has been |was )?suspended/,
];

interface ErrorFacts { text: string; status?: number }

const statusIn = (text: string): number | undefined =>
  Number(/status([\s_]?code)?\W{0,6}(\d{3})\b/.exec(text)?.[2]) || undefined;

// Only the vendor's reply is evidence. The stored wrapper also carries the step's
// request body, output and stack, where test input like "upgrade your plan" or a batch
// item's 402 would otherwise be read as the vendor's verdict.
function factsOf(raw: string): ErrorFacts {
  raw = raw || '';
  let outer: any;
  try { outer = JSON.parse(raw); } catch { /* plain text, or a wrapper cut at the storage cap */ }
  if (outer?.errorMessage != null) {
    const parsed = parseApError(raw);
    const body = parsed.responseBody == null ? ''
      : typeof parsed.responseBody === 'string' ? parsed.responseBody : JSON.stringify(parsed.responseBody);
    return { text: `${parsed.message} ${body}`.toLowerCase(), status: parsed.status ?? statusIn(parsed.message.toLowerCase()) };
  }
  if (outer && typeof outer === 'object') {
    const status = [outer.status, outer.statusCode, outer.status_code].find(n => typeof n === 'number');
    return { text: raw.toLowerCase(), status };
  }
  // A capped wrapper no longer parses; its vendor part comes before the step's own fields.
  const cut = raw.search(/\\*"(requestBody|apiMessage|raw|output)\\*"/);
  const text = (cut < 0 ? raw : raw.slice(0, cut)).toLowerCase();
  return { text, status: statusIn(text) };
}

function isQuota({ text, status }: ErrorFacts): boolean {
  return status === 402 || QUOTA_PATTERNS.some(re => re.test(text));
}

export function isQuotaError(raw: string): boolean {
  return isQuota(factsOf(raw));
}

function byStatus(status: number): ErrorCategory | null {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status >= 500 && status <= 504) return 'transient';
  if (status === 400 || status === 422) return 'bad_request';
  if (status === 404) return 'not_found';
  return null;
}

export function classifyError(raw: string): ErrorCategory {
  const facts = factsOf(raw);
  if (isQuota(facts)) return 'quota';
  const fromStatus = facts.status ? byStatus(facts.status) : null;
  if (fromStatus) return fromStatus;
  const m = facts.text;
  if (/\b(401|403)\b/.test(m) || /unauthor|forbidden|invalid token|token (is )?expired|expired token|credential|permission|access denied|not authenticated/.test(m)) return 'auth';
  if (/\b429\b/.test(m) || /rate.?limit|too many requests|quota exceeded/.test(m)) return 'rate_limit';
  if (/\b(500|502|503|504)\b/.test(m) || /timeout|timed out|econnreset|econnrefused|socket hang up|network error|temporarily unavailable|service unavailable|getaddrinfo|enotfound/.test(m)) return 'transient';
  if (/\b(400|422)\b/.test(m) || /validation|invalid (input|value|parameter|param|request|body|argument)|is required|missing required|must be a|bad request/.test(m)) return 'bad_request';
  if (/\b404\b/.test(m) || /not found|does not exist|no such/.test(m)) return 'not_found';
  return 'piece_error';
}

/**
 * Category of a stored failed step. Re-derived from the error text so classifier
 * improvements apply to history; the stored category is kept when the text yields
 * nothing more specific (the stored error is capped at 8 KB, the live one was not).
 */
export function categoryOfStep(step: { error?: string | null; errorCategory?: string | null }): string {
  const derived = step.error ? classifyError(String(step.error)) : null;
  if (derived && derived !== 'piece_error') return derived;
  return step.errorCategory || derived || 'piece_error';
}
