import { CircleDashed } from 'lucide-react';
import type { VwImportanceFilter } from '../../lib/api';
import { IMPORTANCE_CLASS, IMPORTANCE_FILTERS, IMPORTANCE_LABEL, toggleImportance } from '../../lib/vendorWatch';
import { IMPORTANCE_ICON } from './ImportanceBadge';

const CHIP = 'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition-colors';
const IDLE = 'border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200';

/** Toggle chips; several tiers can be on at once, and none on means every tier. */
export default function ImportanceFilter({ value, counts, onChange }: {
  value: VwImportanceFilter[];
  counts: Record<VwImportanceFilter, number>;
  onChange: (next: VwImportanceFilter[]) => void;
}) {
  const total = IMPORTANCE_FILTERS.reduce((n, t) => n + counts[t], 0);
  const shown = IMPORTANCE_FILTERS.filter(t => t !== 'unrated' || counts.unrated > 0 || value.includes('unrated'));
  return (
    <div className="mb-3 flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by piece importance">
      <span className="mr-1 text-[11px] uppercase tracking-wide text-gray-500"
        title="How much the piece matters: Cloud projects using it (all versions), or the Enterprise list in Config">
        Importance
      </span>
      <button onClick={() => onChange([])} aria-pressed={value.length === 0}
        className={`${CHIP} ${value.length === 0 ? 'border-gray-500 bg-gray-800 text-gray-100' : IDLE}`}>
        All <span className="tabular-nums text-gray-500">{total}</span>
      </button>
      {shown.map(t => {
        const on = value.includes(t);
        const Icon = t === 'unrated' ? CircleDashed : IMPORTANCE_ICON[t];
        return (
          <button key={t} onClick={() => onChange(toggleImportance(value, t))} aria-pressed={on}
            className={`${CHIP} ${on ? IMPORTANCE_CLASS[t] : IDLE}`}>
            <Icon size={12} strokeWidth={2.5} />
            {IMPORTANCE_LABEL[t]}
            <span className={`tabular-nums ${on ? 'opacity-80' : 'text-gray-500'}`}>{counts[t]}</span>
          </button>
        );
      })}
    </div>
  );
}
