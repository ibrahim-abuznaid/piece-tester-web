import { Building2, SignalHigh, SignalLow, SignalMedium, type LucideIcon } from 'lucide-react';
import type { VwImportance, VwImportanceFields } from '../../lib/api';
import { IMPORTANCE_CLASS, IMPORTANCE_LABEL, importanceTitle } from '../../lib/vendorWatch';

export const IMPORTANCE_ICON: Record<VwImportance, LucideIcon> = { high: SignalHigh, medium: SignalMedium, low: SignalLow };

export default function ImportanceBadge({ row }: { row: VwImportanceFields }) {
  const title = importanceTitle(row);
  if (!row.importance) return <span title={title} className="text-[11px] text-gray-600">—</span>;
  const Icon = IMPORTANCE_ICON[row.importance];
  return (
    <span title={title}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 py-0.5 text-[11px] ${IMPORTANCE_CLASS[row.importance]}`}>
      <Icon size={12} strokeWidth={2.5} />
      {IMPORTANCE_LABEL[row.importance]}
      {row.enterprise ? <Building2 size={11} className="text-amber-300" aria-label="Enterprise" /> : null}
    </span>
  );
}
