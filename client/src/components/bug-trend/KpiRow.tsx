import type { ReactNode } from 'react';
import type { BugTrendKpis } from '../../lib/api';
import { formatDelta } from '../../lib/bugTrendFormat';

export default function KpiRow({ kpis }: { kpis: BugTrendKpis }) {
  const delta = formatDelta(kpis.openedLast28, kpis.openedPrev28);
  const deltaClass = delta.direction === 'down' ? 'text-green-400' : delta.direction === 'up' ? 'text-red-400' : 'text-gray-400';
  return (
    <div className="grid grid-cols-3 gap-3">
      <Tile label="Open now" value={String(kpis.openNow)} />
      <Tile label="Opened, last 28 days" value={String(kpis.openedLast28)} note={<span className={deltaClass}>{delta.text}</span>} />
      <Tile
        label="Median days to fix"
        value={kpis.medianDaysToFix === null ? '—' : String(kpis.medianDaysToFix)}
        note={<span className="text-gray-400">({kpis.fixedCount} fixed)</span>}
      />
    </div>
  );
}

function Tile({ label, value, note }: { label: string; value: string; note?: ReactNode }) {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-950/40 px-4 py-3">
      <div className="text-[11px] uppercase tracking-wide text-gray-500">{label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-3xl font-semibold tabular-nums text-gray-100">{value}</span>
        {note && <span className="text-[12px]">{note}</span>}
      </div>
    </div>
  );
}
