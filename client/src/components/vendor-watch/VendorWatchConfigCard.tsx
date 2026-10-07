import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, CheckCircle, Loader2, RefreshCw, X, XCircle } from 'lucide-react';
import { api, type VwConfig } from '../../lib/api';
import { parseJsonArray, shortPieceName, toPieceName } from '../../lib/vendorWatch';

const INPUT = 'w-full rounded border border-gray-700 bg-gray-950 px-2 py-1.5 text-sm text-gray-200';

export default function VendorWatchConfigCard() {
  const qc = useQueryClient();
  const config = useQuery({ queryKey: ['vw-config'], queryFn: api.vwConfig });
  const [form, setForm] = useState<VwConfig | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (config.data && !form) setForm(config.data);
  }, [config.data, form]);

  const save = useMutation({
    mutationFn: (f: VwConfig) => api.vwUpdateConfig({
      enabled: f.enabled,
      cron_expression: f.cron_expression,
      timezone: f.timezone,
      auto_file_enabled: f.auto_file_enabled,
      linear_team_key: f.linear_team_key,
      linear_label: f.linear_label,
      classifier_model: f.classifier_model,
      dead_after_failures: f.dead_after_failures,
      importance_high_min: f.importance_high_min,
      importance_medium_min: f.importance_medium_min,
      enterprise_pieces: parseJsonArray(f.enterprise_pieces),
    }),
    onSuccess: (row) => {
      setForm(row);
      qc.setQueryData(['vw-config'], row);
      for (const key of ['vw-findings', 'vw-plans', 'vw-usage']) qc.invalidateQueries({ queryKey: [key] });
      setMsg({ ok: true, text: 'Saved.' });
    },
    onError: (e: Error) => setMsg({ ok: false, text: e.message }),
  });

  const testLinear = useMutation({
    mutationFn: api.vwTestLinear,
    onSuccess: (r) => setMsg({ ok: true, text: `Linear OK: new tickets go to ${r.team} → ${r.state} with label "${r.label}".` }),
    onError: (e: Error) => setMsg({ ok: false, text: e.message }),
  });

  if (config.isError) return <div className="text-sm text-red-400">{(config.error as Error).message}</div>;
  if (!form) return <div className="text-sm text-gray-400">Loading…</div>;
  const set = <K extends keyof VwConfig>(k: K, v: VwConfig[K]) => setForm({ ...form, [k]: v });

  return (
    <div className="max-w-xl space-y-4 rounded-lg border border-gray-800 bg-gray-900 p-4">
      <Toggle label="Daily watch cycle" hint="Checks every active watcher on the schedule below. Manual runs work either way."
        checked={!!form.enabled} onChange={v => set('enabled', v ? 1 : 0)} />
      <Toggle label="Auto-file breakage in Linear"
        hint="Vendor dead, or a high/critical breaking change, deprecation or auth change that hits a target, with a quote found in the source. Everything else waits in the Inbox. Baselines never auto-file."
        checked={!!form.auto_file_enabled} onChange={v => set('auto_file_enabled', v ? 1 : 0)} />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Schedule (cron)">
          <input value={form.cron_expression} onChange={e => set('cron_expression', e.target.value)} className={INPUT} />
        </Field>
        <Field label="Timezone">
          <input value={form.timezone} onChange={e => set('timezone', e.target.value)} className={INPUT} />
        </Field>
        <Field label="Linear team key">
          <input value={form.linear_team_key} onChange={e => set('linear_team_key', e.target.value)} className={INPUT} />
        </Field>
        <Field label="Linear label">
          <input value={form.linear_label} onChange={e => set('linear_label', e.target.value)} className={INPUT} />
        </Field>
        <Field label="Classifier model">
          <input value={form.classifier_model} placeholder="default: the AI model in Settings"
            onChange={e => set('classifier_model', e.target.value)} className={INPUT} />
        </Field>
        <Field label="Failed days before 'vendor dead'">
          <input type="number" min={1} max={30} value={form.dead_after_failures}
            onChange={e => set('dead_after_failures', Number(e.target.value))} className={INPUT} />
        </Field>
      </div>
      <ImportanceSettings
        high={form.importance_high_min}
        medium={form.importance_medium_min}
        enterprise={parseJsonArray(form.enterprise_pieces)}
        onHigh={v => set('importance_high_min', v)}
        onMedium={v => set('importance_medium_min', v)}
        onEnterprise={v => set('enterprise_pieces', JSON.stringify(v))}
      />
      <p className="text-[11px] text-gray-500">
        Uses the Linear API key and Anthropic key saved in Settings. The label must already exist on the team; the app never
        creates labels. Don't use <span className="font-mono">piece-tester</span>: Bug Trend counts those issues as tester bugs.
      </p>
      <div className="flex items-center gap-2">
        <button onClick={() => { setMsg(null); save.mutate(form); }} disabled={save.isPending}
          className="flex items-center gap-1.5 rounded bg-primary-600 px-3 py-1.5 text-sm text-white hover:bg-primary-500 disabled:opacity-50">
          {save.isPending && <Loader2 size={13} className="animate-spin" />} Save
        </button>
        <button onClick={() => { setMsg(null); testLinear.mutate(); }} disabled={testLinear.isPending}
          className="flex items-center gap-1.5 rounded border border-gray-700 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-800 disabled:opacity-50">
          {testLinear.isPending && <Loader2 size={13} className="animate-spin" />} Test Linear
        </button>
      </div>
      {msg && (
        <div className={`flex items-center gap-2 text-sm ${msg.ok ? 'text-green-400' : 'text-red-400'}`}>
          {msg.ok ? <CheckCircle size={15} /> : <XCircle size={15} />} {msg.text}
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] uppercase tracking-wide text-gray-500">{label}</span>
      {children}
    </label>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} className="mt-1" />
      <span>
        <span className="block text-sm text-gray-200">{label}</span>
        <span className="block text-[12px] text-gray-500">{hint}</span>
      </span>
    </label>
  );
}

interface CatalogPiece { name: string; displayName: string }

function ImportanceSettings({ high, medium, enterprise, onHigh, onMedium, onEnterprise }: {
  high: number;
  medium: number;
  enterprise: string[];
  onHigh: (v: number) => void;
  onMedium: (v: number) => void;
  onEnterprise: (v: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const [hint, setHint] = useState('');
  const catalog = useQuery({
    queryKey: ['vw-catalog'],
    queryFn: () => api.listPieces() as Promise<CatalogPiece[]>,
    staleTime: 5 * 60_000,
  });
  const pieces = catalog.data ?? [];
  const displayName = (name: string) => pieces.find(p => p.name === name)?.displayName ?? shortPieceName(name);

  const find = (text: string) => {
    const t = text.trim().toLowerCase();
    return t ? pieces.find(p => [p.name, p.displayName, shortPieceName(p.name)].some(x => x.toLowerCase() === t)) : undefined;
  };
  const add = (text: string, fromEnter: boolean) => {
    const name = find(text)?.name ?? (fromEnter ? toPieceName(text) : null);
    if (!name) {
      if (fromEnter && text.trim()) setHint('Not a piece name. Pick one from the list or type its package name.');
      return;
    }
    if (!enterprise.includes(name)) onEnterprise([...enterprise, name]);
    setDraft('');
    setHint('');
  };

  return (
    <div className="space-y-3 border-t border-gray-800 pt-4">
      <div>
        <span className="block text-sm text-gray-200">Importance</span>
        <span className="block text-[12px] text-gray-500">
          Rates each piece for the Inbox, Watchers and Generate filters. High: on the Enterprise list, or at least {high.toLocaleString('en-US')} Cloud
          projects across all published versions. Medium: at least {medium.toLocaleString('en-US')}. Low: fewer.
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="High from (Cloud projects)">
          <input type="number" min={2} value={high} onChange={e => onHigh(Number(e.target.value))} className={INPUT} />
        </Field>
        <Field label="Medium from (Cloud projects)">
          <input type="number" min={1} value={medium} onChange={e => onMedium(Number(e.target.value))} className={INPUT} />
        </Field>
      </div>
      <div>
        <span className="mb-1 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-gray-500">
          <Building2 size={12} className="text-amber-300" /> Enterprise pieces: always High
        </span>
        <span className="mb-2 block text-[12px] text-gray-500">
          Enterprise customers mostly self-host, so Cloud usage can't see them. List the pieces they depend on.
        </span>
        <div className="flex flex-wrap items-center gap-1.5 rounded border border-gray-700 bg-gray-950 p-1.5">
          {enterprise.map(name => (
            <span key={name} title={name}
              className="inline-flex items-center gap-1 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[12px] text-amber-100">
              {displayName(name)}
              <button onClick={() => onEnterprise(enterprise.filter(n => n !== name))} aria-label={`Remove ${name}`}
                className="text-amber-300/70 hover:text-amber-100">
                <X size={11} />
              </button>
            </span>
          ))}
          <input value={draft} list="vw-enterprise-catalog"
            placeholder={enterprise.length ? 'Add a piece…' : 'Add a piece, e.g. Salesforce'}
            onChange={e => {
              setDraft(e.target.value);
              setHint('');
              const native = e.nativeEvent;
              if (!(native instanceof InputEvent) || native.inputType === 'insertReplacementText') add(e.target.value, false);
            }}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(draft, true); } }}
            className="min-w-[10rem] flex-1 bg-transparent px-1 py-0.5 text-sm text-gray-200 outline-none" />
          <datalist id="vw-enterprise-catalog">
            {pieces.filter(p => !enterprise.includes(p.name)).map(p => <option key={p.name} value={p.displayName}>{shortPieceName(p.name)}</option>)}
          </datalist>
        </div>
        {hint && <span className="mt-1 block text-[11px] text-amber-400">{hint}</span>}
      </div>
      <UsageStatus />
    </div>
  );
}

function UsageStatus() {
  const qc = useQueryClient();
  const [err, setErr] = useState('');
  const usage = useQuery({
    queryKey: ['vw-usage'],
    queryFn: api.vwUsage,
    refetchInterval: (query) => (query.state.data?.refresh.running ? 2000 : false),
  });
  const r = usage.data?.refresh;
  const running = !!r?.running;
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) {
      qc.invalidateQueries({ queryKey: ['vw-findings'] });
      qc.invalidateQueries({ queryKey: ['vw-plans'] });
    }
    wasRunning.current = running;
  }, [running, qc]);

  const refresh = useMutation({
    mutationFn: api.vwRefreshUsage,
    onSuccess: () => { setErr(''); qc.invalidateQueries({ queryKey: ['vw-usage'] }); },
    onError: (e: Error) => setErr(e.message),
  });

  const s = usage.data?.summary;
  const day = (t: string | null) => (t ? t.slice(0, 10) : '');
  const status = !s ? 'Loading…'
    : s.rated === 0 ? 'No usage fetched yet.'
    : `${s.rated.toLocaleString('en-US')} piece${s.rated === 1 ? '' : 's'} rated · usage from ${day(s.oldest_fetched_at)}${day(s.newest_fetched_at) !== day(s.oldest_fetched_at) ? ` to ${day(s.newest_fetched_at)}` : ''}`;
  const button = 'flex items-center gap-1.5 rounded border border-gray-700 px-2.5 py-1 text-[12px] text-gray-300 hover:bg-gray-800 disabled:opacity-50';

  return (
    <div className="rounded border border-gray-800 bg-gray-950/60 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-auto text-[12px] text-gray-400">
          {running && r ? (
            <span className="inline-flex items-center gap-1.5 text-gray-300">
              <Loader2 size={12} className="animate-spin" />
              Fetching {r.scope === 'catalog' ? 'catalog' : 'watched-piece'} usage… {r.done.toLocaleString('en-US')} / {r.total ? r.total.toLocaleString('en-US') : '…'} versions
            </span>
          ) : status}
        </span>
        <button onClick={() => refresh.mutate('watched')} disabled={running || refresh.isPending} className={button}>
          <RefreshCw size={12} /> Watched pieces
        </button>
        <button disabled={running || refresh.isPending} className={button}
          onClick={() => {
            if (window.confirm('Fetch Cloud usage for every piece in the catalog? About 13,000 requests to cloud.activepieces.com, 5–10 minutes.')) {
              refresh.mutate('catalog');
            }
          }}>
          <RefreshCw size={12} /> Whole catalog
        </button>
      </div>
      <p className="mt-1.5 text-[11px] text-gray-500">
        Cloud projects summed over every published version (the catalog's own number counts only the latest).
        Watched pieces refresh by themselves once their numbers are a week old.
      </p>
      {(err || (!running && r?.error)) && <p className="mt-1 text-[11px] text-red-400">Last refresh failed: {err || r?.error}</p>}
    </div>
  );
}

