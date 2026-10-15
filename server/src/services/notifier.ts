export interface DiscordEmbed { title?: string; description?: string; color?: number; url?: string; }
export interface DiscordMessage { content?: string; embeds?: DiscordEmbed[]; }

export type FetchLike = (url: string, init: any) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;
export class NotifierError extends Error {}

function withWait(url: string): string { return url.includes('?') ? `${url}&wait=true` : `${url}?wait=true`; }

export async function postDiscordMessage(webhookUrl: string, msg: DiscordMessage, fetchImpl: FetchLike = fetch as any): Promise<{ id: string }> {
  if (!webhookUrl) throw new NotifierError('No Discord webhook configured');
  let res;
  try { res = await fetchImpl(withWait(webhookUrl), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msg) }); }
  catch (e: any) { throw new NotifierError(`Could not reach Discord: ${e?.message || e}`); }
  const body = await res.text();
  if (!res.ok) throw new NotifierError(`Discord POST ${res.status}: ${body.slice(0, 200)}`);
  let data: any; try { data = JSON.parse(body); } catch { throw new NotifierError(`Discord returned non-JSON: ${body.slice(0, 200)}`); }
  if (!data?.id) throw new NotifierError(`Discord response missing message id: ${body.slice(0, 200)}`);
  return { id: String(data.id) };
}

export async function editDiscordMessage(webhookUrl: string, messageId: string, msg: DiscordMessage, fetchImpl: FetchLike = fetch as any): Promise<void> {
  if (!webhookUrl) throw new NotifierError('No Discord webhook configured');
  let res;
  try { res = await fetchImpl(`${webhookUrl}/messages/${messageId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msg) }); }
  catch (e: any) { throw new NotifierError(`Could not reach Discord: ${e?.message || e}`); }
  const body = await res.text();
  if (!res.ok) throw new NotifierError(`Discord PATCH ${res.status}: ${body.slice(0, 200)}`);
}

export interface AlertLike {
  id: number; piece_name: string; target_action: string | null;
  error_category: string | null; error_message: string | null;
  status: string; acknowledged_by?: string | null; first_seen_at?: string | null;
}
const COLORS = { verifying: 0xFEE75C, confirmed: 0xED4245, acknowledged: 0x5865F2, recovered: 0x57F287, storm: 0xED4245, account: 0xE879F9 };

// Dedup key for an alert. Numbers/uuids are normalized away on purpose: the same
// failure on a target (differing request ids, timeout durations, etc.) collapses to
// one signature so we alert once, not per fire. A genuinely different message differs.
export function errorSignature(category: string, error: string | null): string {
  const norm = (error || '')
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
    .replace(/\d+/g, '<n>')
    .replace(/["'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `${category}:${norm}`;
}

export function alertEmbed(a: AlertLike, opts: { appBaseUrl: string; reproduced?: number; recoveredNote?: string; failCount?: number }): DiscordMessage {
  const target = a.target_action ? `${a.piece_name} · ${a.target_action}` : a.piece_name;
  const ackLinks = [`[Acknowledge](${opts.appBaseUrl}/ack/${a.id})`, `[Open in Health](${opts.appBaseUrl}/?piece=${encodeURIComponent(a.piece_name)})`].join('   ');
  let title: string, color: number, lines: string[];
  switch (a.status) {
    case 'verifying':
      title = `⏳ Verifying — ${target}`; color = COLORS.verifying;
      lines = [`Just failed · ${a.error_category}`, a.error_message || '', 'verifying…']; break;
    case 'acknowledged':
      title = `🔴 Piece bug — ${target}`; color = COLORS.acknowledged;
      lines = [`✔ Acknowledged by ${a.acknowledged_by || 'a teammate'} · ${a.error_category}`, a.error_message || '']; break;
    case 'recovered':
      title = `🟢 Recovered — ${target}`; color = COLORS.recovered;
      lines = [opts.recoveredNote || 'Recovered', a.error_message || '']; break;
    case 'confirmed':
    default:
      title = `🔴 Piece bug — ${target}`; color = COLORS.confirmed;
      // A chronic bug (failed on multiple sweeps) shows its fire count; a fresh one shows the retest reproduction.
      const headline = opts.failCount && opts.failCount > 1
        ? `Confirmed · chronic — failed ${opts.failCount} sweeps · ${a.error_category}`
        : opts.reproduced ? `Confirmed · reproduced ${opts.reproduced}× · ${a.error_category}` : `Confirmed (unverified retest) · ${a.error_category}`;
      lines = [headline, a.error_message || '', ackLinks];
  }
  return { embeds: [{ title, color, description: lines.filter(Boolean).join('\n') }] };
}

// One notice per vendor account running dry, and one when it is topped up — never per run.
export function accountEmbed(a: AlertLike, opts: { appBaseUrl: string; recoveredNote?: string }): DiscordMessage {
  const health = `[Open in Health](${opts.appBaseUrl}/?piece=${encodeURIComponent(a.piece_name)})`;
  if (a.status === 'recovered') {
    return { embeds: [{ title: `🟢 Credits restored — ${a.piece_name}`, color: COLORS.recovered, description: opts.recoveredNote || 'Tests are running again' }] };
  }
  return { embeds: [{
    title: `💳 Out of credits — ${a.piece_name}`,
    color: COLORS.account,
    description: ['The vendor test account is out of credits or over its plan. Its tests cannot run until it is topped up — not a piece bug.', a.error_message || '', health].filter(Boolean).join('\n'),
  }] };
}

export function stormEmbed(opts: { failing: number; suppressed: number; appBaseUrl: string }): DiscordMessage {
  return { embeds: [{
    title: `⚠️ ${opts.failing} targets failing this sweep`,
    color: COLORS.storm,
    description: `${opts.suppressed} not individually alerted — this is likely a platform/connection issue, not ${opts.failing} separate piece bugs.\n[Open in Health](${opts.appBaseUrl}/)`,
  }] };
}
