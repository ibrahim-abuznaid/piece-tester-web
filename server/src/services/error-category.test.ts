import { describe, it, expect } from 'vitest';
import { classifyError, categoryOfStep, isQuotaError } from './error-category.js';

// The stored form: the executor's wrapper around AP's JSON error, two levels deep.
const HF_STORED = JSON.stringify({
  status: 'FAILED',
  errorMessage: JSON.stringify({
    __apErrorVersion: 1,
    message: 'Failed to perform inference: You have no remaining credits. Purchase pre-paid credits to continue using Inference Providers.',
    code: 'PIECE_ERROR',
    status: 402,
  }),
  output: null,
});

const PER_MINUTE_STORED = JSON.stringify({
  status: 'FAILED',
  errorMessage: JSON.stringify({
    message: 'Calling to this destination is temporarily limited to one call per minute. Complete account verification or increase your calling balance to lift this restriction.',
    status: 429,
  }),
});

// AP's wrapper as a live failure stores it: vendor reply plus the step's own request.
const apWrapped = (status: number, message: string, requestBody: unknown, responseBody: unknown = { message }) =>
  JSON.stringify({
    status: 'FAILED',
    errorMessage: JSON.stringify({
      __apErrorVersion: 1, message, errorName: 'HttpError', status, responseBody, requestBody,
      raw: `HttpError: ${JSON.stringify({ response: { status, body: responseBody }, request: { body: requestBody } })}`,
    }),
  });

describe('classifyError', () => {
  it.each([
    [HF_STORED, 'quota'],
    ['You exceeded your current quota, please check your plan and billing details.', 'quota'],
    ['Request failed with status code 402', 'quota'],
    ['Your credit balance is too low to access the API.', 'quota'],
    ['International calling requires a completed purchase. Adding a card by itself does not enable it — buy credits or turn on auto-recharge.', 'quota'],
    ['Request failed with status code 429: insufficient_quota', 'quota'],
    [PER_MINUTE_STORED, 'rate_limit'],
    ["Quota exceeded for quota metric 'Queries' and limit 'Queries per minute'", 'rate_limit'],
    ['Request failed with status code 429', 'rate_limit'],
    ['invalid credentials', 'auth'],
    ['401 Unauthorized', 'auth'],
    ['Request failed with status code 503', 'transient'],
    ['Request failed with status code 404', 'not_found'],
    ['Request failed with status code 422: name is required', 'bad_request'],
    ["Cannot read properties of undefined (reading 'id')", 'piece_error'],
    ['Your subscription is inactive', 'quota'],
    ['Your account has been suspended', 'quota'],
    ['Credits exhausted', 'quota'],
    ['You do not have enough credits', 'quota'],
    // Pins quota ahead of auth: a 403 with billing wording is a billing problem.
    ['Request failed with status code 403: Your credit balance is too low', 'quota'],
    // Deliberate: "upgrade your plan" is an account-tier wall, not a flake.
    ['Rate limit exceeded. Upgrade your plan for higher limits.', 'quota'],
    // 402 only counts next to a status field — not inside output or a stack trace.
    ['{"status":"FAILED","errorMessage":"401 Unauthorized","output":{"id":402}}', 'auth'],
    ['Error: 401 Unauthorized\n    at handler (/app/index.js:402:13)', 'auth'],
    // Billing-domain pieces (Stripe, Google Cloud Billing) name these objects in ordinary errors.
    ['Request failed with status code 400: subscription cancel_at_period_end is invalid', 'bad_request'],
    ['Request failed with status code 404: credit balance transaction not found', 'not_found'],
    ['Request failed with status code 404: The billing account was not found', 'not_found'],
    ['Request failed with status code 400: This subscription is canceled', 'bad_request'],
    // A per-minute limit is a rate limit even when phrased as "your limit".
    ['Request failed with status code 429: You have exceeded your limit of 100 requests per minute', 'rate_limit'],
    ['{"status_code":402,"detail":"Payment needed"}', 'quota'],
    // Positive wording in step output must not flip a real error.
    ['{"status":"FAILED","errorMessage":"404 Not Found","output":{"note":"you have enough credits"}}', 'not_found'],
    // Billing walls vendors send under auth statuses.
    ['Request failed with status code 403: Maximum credits exceeded', 'quota'],
    ['Request failed with status code 401: This request exceeds your quota of 10000. You have 0 credits remaining', 'quota'],
    ['Request failed with status code 403: This feature is not available on your current plan', 'quota'],
    ['Request failed with status code 403: This endpoint requires a Pro plan', 'quota'],
    ['Request failed with status code 454: Daily message quota exceeded', 'quota'],
    // The status code decides over loose words in the message.
    ['Request failed with status code 400: invalid token format in field', 'bad_request'],
  ])('classifies %j as %j', (message, expected) => {
    expect(classifyError(message)).toBe(expected);
  });
});

describe('classifyError on AP-wrapped failures', () => {
  it('ignores billing words in the step request body', () => {
    expect(classifyError(apWrapped(404, 'channel_not_found', { text: 'Please upgrade your plan' }))).toBe('not_found');
    expect(classifyError(apWrapped(400, 'Invalid To header', { subject: 'Your trial has expired' }))).toBe('bad_request');
  });
  it('ignores a 402 nested in a batch response item', () => {
    const body = { message: 'Index does not exist', results: [{ status: 402 }] };
    expect(classifyError(apWrapped(404, 'Index does not exist', { requests: [] }, body))).toBe('not_found');
  });
  it('reads a billing reason from the response body when the message is generic', () => {
    const body = { errors: [{ message: 'Maximum credits exceeded' }] };
    expect(classifyError(apWrapped(403, 'Request failed with status code 403', {}, body))).toBe('quota');
  });
  it('treats an HTTP 402 status as quota', () => {
    expect(classifyError(apWrapped(402, 'Request failed', {}))).toBe('quota');
  });
  it('maps the nested status when the message has no keywords', () => {
    expect(classifyError(apWrapped(403, 'This operation cannot be processed, the application is blocked.', {}))).toBe('auth');
    expect(classifyError(apWrapped(503, 'Upstream said no', {}))).toBe('transient');
  });
});

describe('classifyError on edge shapes', () => {
  it('ignores billing words in the request body of a wrapper cut at the storage cap', () => {
    const capped = apWrapped(500, "Cannot read properties of undefined (reading 'id')", { note: 'please upgrade your plan' }).slice(0, -20) + '…[truncated, 9000 chars]';
    expect(classifyError(capped)).toBe('transient');
    const noStatus = JSON.stringify({ status: 'FAILED', errorMessage: JSON.stringify({ message: 'boom', requestBody: { status: 402 } }) }).slice(0, -5) + '…[truncated]';
    expect(classifyError(noStatus)).toBe('piece_error');
  });
  it('does not read a status from inside non-wrapper JSON', () => {
    expect(classifyError('[{"status":402}]')).toBe('piece_error');
  });
  it('does not treat a credit card or a plan id as billing', () => {
    expect(classifyError('Request failed with status code 400: purchase credit card required field')).toBe('bad_request');
    expect(classifyError('Request failed with status code 400: unknown field check your plan id')).toBe('bad_request');
  });
});

describe('isQuotaError', () => {
  it('does not fire on the word "credentials"', () => {
    expect(isQuotaError('Invalid credentials supplied')).toBe(false);
  });
  it('does not fire on a bare 402 with no status context', () => {
    expect(isQuotaError('Error processing invoice 402')).toBe(false);
  });
});

describe('categoryOfStep', () => {
  it('re-derives the category from the error text over a stale stored category', () => {
    expect(categoryOfStep({ error: HF_STORED, errorCategory: 'piece_error' })).toBe('quota');
  });
  it('uses the stored category when there is no error text', () => {
    expect(categoryOfStep({ error: null, errorCategory: 'auth' })).toBe('auth');
  });
  it('keeps a more specific stored category when the text yields only piece_error', () => {
    expect(categoryOfStep({ error: 'boom', errorCategory: 'transient' })).toBe('transient');
  });
  it('defaults to piece_error when both are missing', () => {
    expect(categoryOfStep({})).toBe('piece_error');
  });
});
