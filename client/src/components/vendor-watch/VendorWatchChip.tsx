import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Radar } from 'lucide-react';
import { api } from '../../lib/api';

const CHIP = 'flex items-center gap-1 rounded bg-gray-800 px-2 py-0.5 text-gray-300 hover:bg-gray-700 disabled:opacity-50';

/** PieceDetail header chip: start a watcher for this piece, or jump to its watcher. */
export default function VendorWatchChip({ pieceName }: { pieceName: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const plan = useQuery({
    queryKey: ['vw-plan-by-piece', pieceName],
    queryFn: () => api.vwPlanByPiece(pieceName),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'generating' ? 3000 : status === 'queued' ? 30_000 : false;
    },
  });
  const generate = useMutation({
    mutationFn: () => api.vwGenerate(pieceName),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['vw-plan-by-piece', pieceName] }),
  });

  if (plan.isLoading || plan.isError) return null;
  if (!plan.data) {
    return (
      <span className="flex items-center gap-2">
        <button
          onClick={() => {
            if (window.confirm(`Generate a vendor watcher for ${pieceName}? This runs the AI agent (about $0.20–0.60).`)) generate.mutate();
          }}
          disabled={generate.isPending} className={CHIP}
          title="Watch this piece's vendor API for breaking changes">
          <Radar size={12} /> {generate.isPending ? 'Starting…' : 'Generate watcher'}
        </button>
        {generate.isError && <span className="text-red-400">{generate.error.message}</span>}
      </span>
    );
  }
  const open = plan.data.open_findings ?? 0;
  return (
    <button onClick={() => navigate(`/vendor-watch?tab=watchers&piece=${encodeURIComponent(pieceName)}`)} className={CHIP}>
      <Radar size={12} /> Watcher: {plan.data.status}{open > 0 ? ` · ${open} open` : ''}
    </button>
  );
}
