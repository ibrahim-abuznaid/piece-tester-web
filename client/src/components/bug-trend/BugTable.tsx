import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { TrackedBug } from '../../lib/api';
import { formatDaysToFix } from '../../lib/bugTrendFormat';
import { SOURCE_META } from './palette';

const HEADERS = ['ID', 'Title', 'Source', 'Assignee', 'Opened', 'Fixed', 'Days to fix'];

export default function BugTable({ issues }: { issues: TrackedBug[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-4">
      <button onClick={() => setOpen(o => !o)} className="flex items-center gap-1 text-sm text-gray-400 hover:text-gray-200">
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {open ? 'Hide' : 'Show'} the {issues.length} bugs
      </button>
      {open && (
        <table className="mt-2 w-full text-left text-[12px]">
          <thead className="text-gray-500">
            <tr>{HEADERS.map(h => <th key={h} className="px-2 py-1 font-medium">{h}</th>)}</tr>
          </thead>
          <tbody>
            {issues.map(b => (
              <tr key={b.identifier} className="border-t border-gray-800 text-gray-300">
                <td className="px-2 py-1 font-mono">
                  <a href={b.url} target="_blank" rel="noreferrer" className="text-primary-400 hover:underline">{b.identifier}</a>
                </td>
                <td className="px-2 py-1">{b.title}</td>
                <td className="px-2 py-1">{SOURCE_META[b.source].label}</td>
                <td className="px-2 py-1">{b.assigneeName ?? '—'}</td>
                <td className="px-2 py-1 tabular-nums">{b.createdAt.slice(0, 10)}</td>
                <td className="px-2 py-1 tabular-nums">{b.completedAt ? b.completedAt.slice(0, 10) : 'open'}</td>
                <td className="px-2 py-1 tabular-nums">{formatDaysToFix(b.createdAt, b.completedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
