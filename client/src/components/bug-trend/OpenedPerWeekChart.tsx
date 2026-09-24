import { ComposedChart, Bar, Line, Rectangle, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine, ResponsiveContainer } from 'recharts';
import type { BarShapeProps } from 'recharts';
import type { BugSource, BugTrendWeek } from '../../lib/api';
import { activeSources, formatDay, formatWeekRange, topSourceOf, weekBarOpacity, weekStartOf } from '../../lib/bugTrendFormat';
import { CARD_BG, CHART_MARGIN, GRID, MARKER, NEUTRAL_LINE, SOURCE_META, TICK, TOOLTIP_STYLE, Y_AXIS_WIDTH } from './palette';

/** Only the visible top segment of each week's stack is rounded. */
const TOP_RADIUS: [number, number, number, number] = [4, 4, 0, 0];

export default function OpenedPerWeekChart({ weeks, markerDate }: { weeks: BugTrendWeek[]; markerDate: string }) {
  const sources = activeSources(weeks);
  const markerWeek = weekStartOf(markerDate);
  const showMarker = weeks.some(w => w.weekStart === markerWeek);
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-gray-200">Bugs opened per week</h3>
        <Legend sources={sources} />
      </div>
      <ResponsiveContainer width="100%" height={240}>
        <ComposedChart data={weeks} margin={CHART_MARGIN}>
          <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="weekStart" tickFormatter={formatDay} tick={{ fontSize: 10, fill: TICK }} axisLine={false} tickLine={false} minTickGap={16} />
          <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: TICK }} axisLine={false} tickLine={false} width={Y_AXIS_WIDTH} />
          <Tooltip content={<WeekTooltip sources={sources} />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
          {showMarker && (
            <ReferenceLine x={markerWeek} stroke={MARKER} strokeDasharray="4 4"
              label={{ value: 'Tester at scale', position: 'insideTopLeft', fill: TICK, fontSize: 10 }} />
          )}
          {sources.map(s => (
            <Bar key={s} dataKey={s} stackId="opened" fill={SOURCE_META[s].color} stroke={CARD_BG} strokeWidth={2}
              shape={(p: BarShapeProps) => (
                <Rectangle {...p} fillOpacity={weekBarOpacity(p.payload)} radius={topSourceOf(p.payload, sources) === s ? TOP_RADIUS : 0} />
              )}
              isAnimationActive={false} />
          ))}
          <Line dataKey="rolling4" stroke={NEUTRAL_LINE} strokeWidth={2} dot={false} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function Legend({ sources }: { sources: BugSource[] }) {
  return (
    <div className="flex flex-wrap items-center gap-3 text-[11px] text-gray-400">
      {sources.map(s => (
        <span key={s} className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: SOURCE_META[s].color }} />
          {SOURCE_META[s].label}
        </span>
      ))}
      <span className="flex items-center gap-1.5">
        <span className="inline-block h-0.5 w-4" style={{ background: NEUTRAL_LINE }} />
        4-week average
      </span>
    </div>
  );
}

function WeekTooltip({ active, payload, sources }: any) {
  if (!active || !payload?.length) return null;
  const w: BugTrendWeek = payload[0].payload;
  return (
    <div style={TOOLTIP_STYLE} className="px-3 py-2">
      <div className="mb-1 font-medium text-gray-200">
        {formatWeekRange(w.weekStart)}{w.inProgress ? ' · this week so far' : ''}
      </div>
      {sources.map((s: BugSource) => (
        <div key={s} className="flex justify-between gap-4"><span>{SOURCE_META[s].label}</span><span className="tabular-nums">{w[s]}</span></div>
      ))}
      <div className="mt-1 flex justify-between gap-4 border-t border-gray-700 pt-1"><span>Total</span><span className="tabular-nums">{w.total}</span></div>
      {w.rolling4 !== null && (
        <div className="flex justify-between gap-4 text-gray-400"><span>4-week average</span><span className="tabular-nums">{w.rolling4}</span></div>
      )}
    </div>
  );
}
