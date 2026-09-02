export interface ReportPayload {
  mode: 'create' | 'comment';
  piece_name: string;
  title: string;
  description: string;
  label: string;
  priority: number;
  linear_issue_id?: string;   // present when mode === 'comment'
}

export interface ReportResult {
  linear_issue_id: string;
  linear_url: string;
}

export class ReportTransportError extends Error {}

type FetchLike = (url: string, init: any) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/**
 * POST an approved report to the AP Catch-Webhook flow and read back the Linear issue.
 * Throws ReportTransportError on any failure — callers MUST NOT persist a report row
 * when this throws.
 */
export async function sendReport(
  webhookUrl: string,
  payload: ReportPayload,
  fetchImpl: FetchLike = fetch as any,
): Promise<ReportResult> {
  if (!webhookUrl) throw new ReportTransportError('No Linear reporting webhook configured');

  let res;
  try {
    res = await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e: any) {
    throw new ReportTransportError(`Could not reach the reporting flow: ${e?.message || e}`);
  }

  const body = await res.text();
  if (!res.ok) throw new ReportTransportError(`Reporting flow returned ${res.status}: ${body.slice(0, 200)}`);

  let data: any;
  try { data = JSON.parse(body); } catch { throw new ReportTransportError(`Reporting flow returned non-JSON: ${body.slice(0, 200)}`); }

  if (!data || typeof data.linear_url !== 'string' || !data.linear_url) {
    throw new ReportTransportError(`Reporting flow response missing linear_url. Got: ${body.slice(0, 300)}`);
  }
  return { linear_issue_id: String(data.linear_issue_id ?? ''), linear_url: data.linear_url };
}
