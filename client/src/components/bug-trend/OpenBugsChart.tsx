import { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine, ResponsiveContainer } from 'recharts';
import type { BugTrendDay } from '../../lib/api';
import { formatDay } from '../../lib/bugTrendFormat';
import { CHART_MARGIN, GRID, MARKER, NEUTRAL_LINE, TICK, TOOLTIP_STYLE, Y_AXIS_WIDTH } from './palette';

export default function OpenBugsChart({ days, markerDate }: { days: BugTrendDay[]; markerDate: string }) {
  const showMarker = days.some(d => d.date === markerDate);
  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold text-gray-200">Open bugs at end of day</h3>
      <ResponsiveContainer width="100%" height={160}>
        <LineChart data={days} margin={CHART_MARGIN}>
          <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="date" tickFormatter={formatDay} tick={{ fontSize: 10, fill: TICK }} axisLine={false} tickLine={false} minTickGap={24} />
          <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: TICK }} axisLine={false} tickLine={false} width={Y_AXIS_WIDTH} />
          <Tooltip content={<DayTooltip />} />
          {showMarker && (
            <ReferenceLine x={markerDate} stroke={MARKER} strokeDasharray="4 4"
              label={{ value: 'Tester at scale', position: 'insideTopLeft', fill: TICK, fontSize: 10 }} />
          )}
          <Line type="stepAfter" dataKey="open" stroke={NEUTRAL_LINE} strokeWidth={2} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function DayTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const d: BugTrendDay = payload[0].payload;
  return (
    <div style={TOOLTIP_STYLE} className="px-3 py-2">
      <div className="font-medium text-gray-200">{formatDay(d.date)}</div>
      <div>{d.open} open{d.openIds.length ? `: ${d.openIds.join(', ')}` : ''}</div>
    </div>
  );
}
