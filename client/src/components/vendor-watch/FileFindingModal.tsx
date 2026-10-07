import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ExternalLink, Loader2, Send, X } from 'lucide-react';
import { api, type VwFinding } from '../../lib/api';
import { PRIORITY_LABEL } from '../../lib/vendorWatch';

export default function FileFindingModal({ finding, onClose }: { finding: VwFinding; onClose: () => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState(3);
  const [err, setErr] = useState('');

  const preview = useQuery({
    queryKey: ['vw-draft', finding.id],
    queryFn: () => api.vwFindingDraft(finding.id),
    staleTime: Infinity,
    gcTime: 0,
  });

  // Seed the editable fields once, so a background refetch never clobbers the user's edits.
  const seeded = useRef(false);
  useEffect(() => {
    if (preview.data && !seeded.current) {
      setTitle(preview.data.draft.title);
      setDescription(preview.data.draft.description);
      setPriority(preview.data.draft.priority);
      seeded.current = true;
    }
  }, [preview.data]);

  const submit = useMutation({
    mutationFn: () => api.vwFileFinding(finding.id, { title, description, priority }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['vw-findings'] }); onClose(); },
    onError: (e: Error) => setErr(e.message || 'Filing failed'),
  });

  const mode = preview.data?.mode ?? 'create';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-full max-w-2xl rounded-lg border border-gray-800 bg-gray-900 p-4" onClick={e => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-200">File vendor change in Linear</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300"><X size={16} /></button>
        </div>

        {preview.isLoading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-gray-400">
            <Loader2 size={14} className="animate-spin" /> Building draft…
          </div>
        ) : preview.isError ? (
          <p className="py-6 text-sm text-red-400">Couldn't build a draft: {(preview.error as Error).message}</p>
        ) : (
          <>
            {mode === 'comment' && preview.data?.existing && (
              <div className="mb-3 flex items-start gap-2 rounded border border-amber-500/25 bg-amber-500/10 p-2 text-[12px] text-amber-200">
                <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                <span>
                  A ticket for the same change is already filed. Filing adds a comment to{' '}
                  <a href={preview.data.existing.linear_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 underline">
                    {preview.data.existing.linear_identifier || 'the existing issue'} <ExternalLink size={11} />
                  </a>.
                </span>
              </div>
            )}

            {mode === 'create' && (
              <>
                <label className="mb-1 block text-[11px] uppercase tracking-wide text-gray-500">Title</label>
                <input value={title} onChange={e => setTitle(e.target.value)}
                  className="mb-3 w-full rounded border border-gray-700 bg-gray-950 px-2 py-1.5 text-sm text-gray-200" />
              </>
            )}

            <label className="mb-1 block text-[11px] uppercase tracking-wide text-gray-500">{mode === 'create' ? 'Description' : 'Comment'}</label>
            <textarea value={description} onChange={e => setDescription(e.target.value)} rows={12}
              className="mb-3 w-full rounded border border-gray-700 bg-gray-950 px-2 py-1.5 font-mono text-[12px] text-gray-200" />

            {mode === 'create' && (
              <div className="mb-3 flex items-center gap-2 text-[12px] text-gray-400">
                <span>Priority</span>
                <select value={priority} onChange={e => setPriority(Number(e.target.value))}
                  className="rounded border border-gray-700 bg-gray-950 px-2 py-1 text-gray-200">
                  {[1, 2, 3, 4].map(p => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
                </select>
              </div>
            )}

            {err && <p className="mb-2 text-[12px] text-red-400">{err}</p>}

            <div className="flex justify-end gap-2">
              <button onClick={onClose} className="px-3 py-1.5 text-sm text-gray-400 hover:text-gray-200">Cancel</button>
              <button onClick={() => { setErr(''); submit.mutate(); }}
                disabled={submit.isPending || (mode === 'create' && !title.trim())}
                className="flex items-center gap-1.5 rounded bg-primary-600 px-3 py-1.5 text-sm text-white hover:bg-primary-500 disabled:opacity-50">
                {submit.isPending ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
                {mode === 'create' ? 'File in Linear' : 'Add comment in Linear'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
