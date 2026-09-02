import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { X, Send, Loader2, ExternalLink, AlertTriangle } from 'lucide-react';

export default function ReportToPiecesModal({ pieceName, onClose }: { pieceName: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [err, setErr] = useState('');

  const preview = useQuery({
    queryKey: ['report-preview', pieceName],
    queryFn: () => api.previewReport(pieceName),
    staleTime: Infinity,
  });

  // Seed the editable fields once, so a background refetch never clobbers the user's edits.
  const seeded = useRef(false);
  useEffect(() => {
    if (preview.data && !seeded.current) {
      setTitle(preview.data.draft.title);
      setDescription(preview.data.draft.description);
      seeded.current = true;
    }
  }, [preview.data]);

  const submit = useMutation({
    mutationFn: () => api.submitReport({
      piece_name: pieceName, title, description,
      label: preview.data!.draft.label, priority: preview.data!.draft.priority,
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['reported'] }); onClose(); },
    onError: (e: any) => setErr(e?.message || 'Failed to file the report'),
  });

  const mode = preview.data?.mode ?? 'create';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-lg border border-gray-800 bg-gray-900 p-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-gray-200">Report to Pieces team</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300"><X size={16} /></button>
        </div>

        {preview.isLoading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-gray-400"><Loader2 size={14} className="animate-spin" /> Building draft…</div>
        ) : preview.isError ? (
          <p className="py-6 text-sm text-red-400">Couldn't build a draft: {(preview.error as any)?.message}</p>
        ) : (
          <>
            {mode === 'comment' && preview.data?.existing && (
              <div className="mb-3 flex items-start gap-2 rounded border border-amber-500/25 bg-amber-500/10 p-2 text-[12px] text-amber-200">
                <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                <span>This piece already has an open report. Filing adds a comment to{' '}
                  <a href={preview.data.existing.linear_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 underline">the existing issue <ExternalLink size={11} /></a>.</span>
              </div>
            )}

            <label className="mb-1 block text-[11px] uppercase tracking-wide text-gray-500">Title</label>
            <input value={title} onChange={e => setTitle(e.target.value)}
              className="mb-3 w-full rounded border border-gray-700 bg-gray-950 px-2 py-1.5 text-sm text-gray-200" />

            <label className="mb-1 block text-[11px] uppercase tracking-wide text-gray-500">Description</label>
            <textarea value={description} onChange={e => setDescription(e.target.value)} rows={10}
              className="mb-3 w-full rounded border border-gray-700 bg-gray-950 px-2 py-1.5 font-mono text-[12px] text-gray-200" />

            <div className="mb-3 flex items-center gap-2 text-[11px] text-gray-500">
              <span className="rounded bg-gray-800 px-1.5 py-0.5">{preview.data?.draft.label}</span>
              <span>priority {preview.data?.draft.priority}</span>
            </div>

            {err && <p className="mb-2 text-[12px] text-red-400">{err}</p>}

            <div className="flex justify-end gap-2">
              <button onClick={onClose} className="px-3 py-1.5 text-sm text-gray-400 hover:text-gray-200">Cancel</button>
              <button onClick={() => { setErr(''); submit.mutate(); }} disabled={submit.isPending || !title.trim()}
                className="flex items-center gap-1.5 rounded bg-primary-600 px-3 py-1.5 text-sm text-white hover:bg-primary-500 disabled:opacity-50">
                {submit.isPending ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
                {mode === 'comment' ? 'Add comment in Linear' : 'File in Linear'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
