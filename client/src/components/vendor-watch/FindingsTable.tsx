import { useEffect, useRef, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, ExternalLink, Send, X } from 'lucide-react';
import { api, type VwFinding, type VwImportanceFilter } from '../../lib/api';
import {
  KIND_LABEL, SEVERITY_CLASS, clampOffset, describeTargets, effectiveLabel, pageInfo, shortPieceName,
} from '../../lib/vendorWatch';
import FileFindingModal from './FileFindingModal';
import ImportanceBadge from './ImportanceBadge';
import ImportanceFilter from './ImportanceFilter';

const PAGE_SIZE = 100;
/** Pinned right so File… / Dismiss never scroll away. The edge is a shadow: a collapsed-border table leaves cell borders behind on sticky cells. */
const STICKY_ACTIONS = 'sticky right-0 whitespace-nowrap px-3 py-2 shadow-[inset_1px_0_0_theme(colors.gray.800),-8px_0_8px_-8px_rgba(0,0,0,0.6)]';
const PAGE_BUTTON = 'flex items-center gap-1 rounded border border-gray-700 px-2.5 py-1 text-[12px] text-gray-300 hover:bg-gray-800 disabled:opacity-50';

export default function FindingsTable({ status, piece, importance, onImportanceChange }: {
  status: 'new' | 'filed';
  piece?: string;
  importance: VwImportanceFilter[];
  onImportanceChange: (next: VwImportanceFilter[]) => void;
}) {
  const qc = useQueryClient();
  const [filing, setFiling] = useState<VwFinding | null>(null);
  // The page belongs to one filter: a new tab, piece or importance filter starts again at the first page.
  const filterKey = `${status}|${piece ?? ''}|${importance.join(',')}`;
  const [page, setPage] = useState({ filterKey, offset: 0 });
  if (page.filterKey !== filterKey) setPage({ filterKey, offset: 0 });
  const offset = page.filterKey === filterKey ? page.offset : 0;
  const tableTop = useRef<HTMLDivElement>(null);
  const findings = useQuery({
    queryKey: ['vw-findings', status, piece ?? '', importance.join(','), offset],
    queryFn: () => api.vwFindings(status, piece, importance, { limit: PAGE_SIZE, offset }),
    refetchInterval: 30_000,
    placeholderData: keepPreviousData,
  });
  const dismiss = useMutation({
    mutationFn: (id: number) => api.vwDismissFinding(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vw-findings'] }),
  });
  const current = findings.isPlaceholderData ? undefined : findings.data;
  useEffect(() => {
    if (current && current.offset > 0 && current.offset >= current.total) {
      setPage({ filterKey, offset: clampOffset(current.offset, current.total, current.limit) });
    }
  }, [current, filterKey]);
  const goTo = (next: number) => {
    setPage({ filterKey, offset: next });
    if (tableTop.current && tableTop.current.getBoundingClientRect().top < 0) tableTop.current.scrollIntoView({ block: 'start' });
  };

  if (findings.isLoading) return <div className="text-sm text-gray-400">Loading…</div>;
  if (findings.isError) return <div className="text-sm text-red-400">{(findings.error as Error).message}</div>;
  const rows = findings.data?.findings ?? [];
  const counts = findings.data?.counts ?? { high: 0, medium: 0, low: 0, unrated: 0 };
  if (Object.values(counts).every(n => n === 0)) {
    return <div className="text-sm text-gray-500">{status === 'new' ? 'Nothing waiting. New findings land here.' : 'Nothing filed yet.'}</div>;
  }
  const total = findings.data?.total ?? 0;
  const range = pageInfo({ offset: findings.data?.offset ?? 0, limit: findings.data?.limit ?? PAGE_SIZE, total }, rows.length);

  return (
    <>
      <ImportanceFilter value={importance} counts={counts} onChange={onImportanceChange} />
      {total === 0 ? (
        <div className="text-sm text-gray-500">
          No {status === 'new' ? 'waiting' : 'filed'} findings for pieces of this importance.{' '}
          <button onClick={() => onImportanceChange([])} className="text-primary-400 hover:underline">Show all</button>
        </div>
      ) : (
        <div ref={tableTop} className="overflow-x-auto rounded-lg border border-gray-800">
          <table className="w-full text-sm">
            <thead className="bg-gray-900 text-left text-[11px] uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-3 py-2">Piece</th>
                <th className="px-3 py-2">Importance</th>
                <th className="px-3 py-2">Kind</th>
                <th className="px-3 py-2">Severity</th>
                <th className="px-3 py-2">Finding</th>
                <th className="px-3 py-2">Effective</th>
                <th className="px-3 py-2">Affects</th>
                <th className={`bg-gray-900 ${STICKY_ACTIONS}`} />
              </tr>
            </thead>
            <tbody>
              {rows.map(f => (
                <tr key={f.id} className="border-t border-gray-800 align-top">
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-[12px] text-gray-300">{shortPieceName(f.piece_name)}</td>
                  <td className="px-3 py-2"><ImportanceBadge row={f} /></td>
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
                  <td className="px-3 py-2 text-[12px] text-gray-400">
                    <div className="max-w-[16rem] break-words">{describeTargets(f.affected_targets)}</div>
                  </td>
                  <td className={`bg-gray-950 text-right ${STICKY_ACTIONS}`}>
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
      )}
      {rows.length > 0 && (
        <div className="mt-2 flex items-center justify-between text-[12px] text-gray-400">
          <span>Showing {range.from.toLocaleString('en-US')}–{range.to.toLocaleString('en-US')} of {total.toLocaleString('en-US')}</span>
          <div className="flex gap-2">
            <button onClick={() => range.prevOffset !== null && goTo(range.prevOffset)}
              disabled={range.prevOffset === null || findings.isPlaceholderData} className={PAGE_BUTTON}>
              <ChevronLeft size={12} /> Previous
            </button>
            <button onClick={() => range.nextOffset !== null && goTo(range.nextOffset)}
              disabled={range.nextOffset === null || findings.isPlaceholderData} className={PAGE_BUTTON}>
              Next <ChevronRight size={12} />
            </button>
          </div>
        </div>
      )}
      {filing && <FileFindingModal finding={filing} onClose={() => setFiling(null)} />}
    </>
  );
}
