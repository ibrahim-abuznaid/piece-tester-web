import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Send, X } from 'lucide-react';
import { api, type VwFinding } from '../../lib/api';
import { KIND_LABEL, SEVERITY_CLASS, describeTargets, effectiveLabel, shortPieceName } from '../../lib/vendorWatch';
import FileFindingModal from './FileFindingModal';

export default function FindingsTable({ status, piece }: { status: 'new' | 'filed'; piece?: string }) {
  const qc = useQueryClient();
  const [filing, setFiling] = useState<VwFinding | null>(null);
  const findings = useQuery({
    queryKey: ['vw-findings', status, piece ?? ''],
    queryFn: () => api.vwFindings(status, piece),
    refetchInterval: 30_000,
  });
  const dismiss = useMutation({
    mutationFn: (id: number) => api.vwDismissFinding(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vw-findings'] }),
  });

  if (findings.isLoading) return <div className="text-sm text-gray-400">Loading…</div>;
  if (findings.isError) return <div className="text-sm text-red-400">{(findings.error as Error).message}</div>;
  const rows = findings.data ?? [];
  if (rows.length === 0) {
    return <div className="text-sm text-gray-500">{status === 'new' ? 'Nothing waiting. New findings land here.' : 'Nothing filed yet.'}</div>;
  }

  return (
    <>
      <div className="overflow-x-auto rounded-lg border border-gray-800">
        <table className="w-full text-sm">
          <thead className="bg-gray-900 text-left text-[11px] uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-3 py-2">Piece</th>
              <th className="px-3 py-2">Kind</th>
              <th className="px-3 py-2">Severity</th>
              <th className="px-3 py-2">Finding</th>
              <th className="px-3 py-2">Effective</th>
              <th className="px-3 py-2">Affects</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map(f => (
              <tr key={f.id} className="border-t border-gray-800 align-top">
                <td className="px-3 py-2 font-mono text-[12px] text-gray-300">{shortPieceName(f.piece_name)}</td>
                <td className="whitespace-nowrap px-3 py-2">
                  <span className="rounded border border-gray-600/40 bg-gray-800/60 px-1.5 py-0.5 text-[11px] text-gray-300">{KIND_LABEL[f.kind]}</span>
                  {f.is_baseline ? <span className="ml-1 text-[10px] text-gray-500">baseline</span> : null}
                </td>
                <td className="px-3 py-2">
                  <span className={`rounded border px-1.5 py-0.5 text-[11px] ${SEVERITY_CLASS[f.severity]}`}>{f.severity}</span>
                </td>
                <td className="px-3 py-2">
                  <div className="text-gray-100">{f.title}</div>
                  {f.summary && <div className="mt-0.5 text-[12px] text-gray-400">{f.summary}</div>}
                  <div className="mt-0.5 flex flex-wrap gap-2 text-[11px]">
                    {f.evidence_url && (
                      <a href={f.evidence_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary-400 hover:underline">
                        source <ExternalLink size={10} />
                      </a>
                    )}
                    {!f.evidence_verified && f.evidence_excerpt ? <span className="text-amber-400">quote not found in source</span> : null}
                  </div>
                  {f.file_error && <div className="mt-1 text-[11px] text-red-400">Filing failed: {f.file_error}</div>}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-[12px] text-gray-400">{effectiveLabel(f.effective_date)}</td>
                <td className="px-3 py-2 text-[12px] text-gray-400">{describeTargets(f.affected_targets)}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  {status === 'new' ? (
                    <div className="flex justify-end gap-2">
                      <button onClick={() => setFiling(f)} className="flex items-center gap-1 rounded bg-primary-600 px-2 py-1 text-[12px] text-white hover:bg-primary-500">
                        <Send size={12} /> File…
                      </button>
                      <button onClick={() => dismiss.mutate(f.id)} disabled={dismiss.isPending}
                        className="flex items-center gap-1 rounded px-2 py-1 text-[12px] text-gray-400 hover:text-gray-200">
                        <X size={12} /> Dismiss
                      </button>
                    </div>
                  ) : (
                    <div>
                      {f.linear_url && (
                        <a href={f.linear_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12px] text-primary-400 hover:underline">
                          {f.linear_identifier || 'Linear'} <ExternalLink size={11} />
                        </a>
                      )}
                      <div className="text-[10px] text-gray-500">{f.filed_by === 'auto' ? 'auto-filed' : 'filed by hand'}</div>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {filing && <FileFindingModal finding={filing} onClose={() => setFiling(null)} />}
    </>
  );
}
