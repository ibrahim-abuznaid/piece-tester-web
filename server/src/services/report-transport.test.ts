import { describe, it, expect } from 'vitest';
import { sendReport, ReportTransportError } from './report-transport.js';

const payload = { mode: 'create' as const, piece_name: 'p', title: 't', description: 'd', label: 'piece:p', priority: 2 };
const okFetch = (body: any) => (async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) })) as any;

describe('sendReport', () => {
  it('returns issue id + url on success', async () => {
    const r = await sendReport('http://hook', payload, okFetch({ linear_issue_id: 'i1', linear_url: 'https://linear.app/x' }));
    expect(r).toEqual({ linear_issue_id: 'i1', linear_url: 'https://linear.app/x' });
  });

  it('throws on non-2xx', async () => {
    const f = (async () => ({ ok: false, status: 500, text: async () => 'boom' })) as any;
    await expect(sendReport('http://hook', payload, f)).rejects.toBeInstanceOf(ReportTransportError);
  });

  it('throws when linear_url is missing', async () => {
    await expect(sendReport('http://hook', payload, okFetch({ linear_issue_id: 'i1' }))).rejects.toBeInstanceOf(ReportTransportError);
  });

  it('throws when the webhook url is empty', async () => {
    await expect(sendReport('', payload)).rejects.toBeInstanceOf(ReportTransportError);
  });

  it('throws on a non-JSON body', async () => {
    const f = (async () => ({ ok: true, status: 200, text: async () => '<html>' })) as any;
    await expect(sendReport('http://hook', payload, f)).rejects.toBeInstanceOf(ReportTransportError);
  });

  it('wraps a network error as ReportTransportError', async () => {
    const f = (async () => { throw new Error('ECONNREFUSED'); }) as any;
    await expect(sendReport('http://hook', payload, f)).rejects.toBeInstanceOf(ReportTransportError);
  });
});
