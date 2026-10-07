import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { api, type VwSource } from '../../lib/api';
import { parseJsonArray, sourceHealth } from '../../lib/vendorWatch';

const HEALTH_DOT = { ok: 'bg-green-500', failing: 'bg-red-500', never: 'bg-gray-600' } as const;

export default function PlanDetail({ planId }: { planId: number }) {
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ['vw-plan', planId], queryFn: () => api.vwPlan(planId), refetchInterval: 15_000 });
  const toggle = useMutation({
    mutationFn: (s: VwSource) => api.vwSetSourceEnabled(s.id, !s.enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vw-plan', planId] }),
  });

  if (detail.isLoading) return <div className="p-3 text-sm text-gray-400">Loading…</div>;
  if (detail.isError || !detail.data) {
    return <div className="p-3 text-sm text-red-400">{(detail.error as Error | null)?.message ?? 'Not found'}</div>;
  }
  const { plan, sources, runs } = detail.data;
  const inventory = parseJsonArray<{ target: string; method: string; path: string }>(plan.endpoint_inventory);

  return (
    <div className="grid gap-4 p-3 md:grid-cols-2">
      <div>
        <h4 className="mb-1 text-[11px] uppercase tracking-wide text-gray-500">Sources</h4>
        <ul className="space-y-1.5">
          {sources.map(s => {
            const health = sourceHealth(s);
            return (
              <li key={s.id} className="text-[12px]">
                <div className="flex items-center gap-2">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${HEALTH_DOT[health]}`} title={health} />
                  <span className="rounded bg-gray-800 px-1 text-[10px] text-gray-400">{s.kind}</span>
                  <a href={s.url} target="_blank" rel="noreferrer"
                    className={`inline-flex items-center gap-1 truncate hover:underline ${s.enabled ? 'text-gray-200' : 'text-gray-500 line-through'}`}>
                    {s.label || s.url} <ExternalLink size={10} />
                  </a>
                  <button onClick={() => toggle.mutate(s)} className="ml-auto text-[11px] text-primary-400 hover:underline">
                    {s.enabled ? 'disable' : 'enable'}
                  </button>
                </div>
                {s.last_error && <div className="ml-4 text-[11px] text-red-400">{s.last_error}</div>}
              </li>
            );
          })}
        </ul>
        {plan.generation_note && <p className="mt-3 whitespace-pre-line text-[12px] text-gray-400">{plan.generation_note}</p>}
        <p className="mt-1 text-[11px] text-gray-500">
          {plan.vendor_name || 'Unknown vendor'} · API {plan.api_version || '—'} · {plan.auth_type || '—'} · generated for ${plan.generation_cost_usd.toFixed(2)}
        </p>
      </div>
      <div>
        <h4 className="mb-1 text-[11px] uppercase tracking-wide text-gray-500">Endpoint inventory ({inventory.length})</h4>
        <ul className="max-h-48 overflow-auto font-mono text-[11px] text-gray-400">
          {inventory.map((e, i) => <li key={i}>{e.target}: {e.method} {e.path}</li>)}
        </ul>
        <h4 className="mb-1 mt-3 text-[11px] uppercase tracking-wide text-gray-500">Last runs</h4>
        <ul className="space-y-0.5 text-[11px] text-gray-400">
          {runs.length === 0 && <li>No runs yet.</li>}
          {runs.map(r => (
            <li key={r.id}>
              {r.started_at} · {r.trigger_type} · {r.status} · {r.sources_changed}/{r.sources_checked} changed · {r.findings_created} finding(s)
              {r.error ? <span className="text-red-400"> · {r.error.split('\n')[0]}</span> : null}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
