import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle, Loader2, XCircle } from 'lucide-react';
import { api, type VwConfig } from '../../lib/api';

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
    }),
    onSuccess: (row) => { setForm(row); qc.setQueryData(['vw-config'], row); setMsg({ ok: true, text: 'Saved.' }); },
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
