import type { BugSource } from '../../lib/api';

/** Dark steps of the dataviz reference palette, validated against the card color #111827. */
export const CARD_BG = '#111827';
export const SOURCE_META: Record<BugSource, { label: string; color: string }> = {
  support: { label: 'Reported by support', color: '#3987e5' },
  internal: { label: 'Found internally', color: '#d95926' },
  tester: { label: 'Caught by the tester', color: '#199e70' },
};
export const NEUTRAL_LINE = '#d1d5db';
export const GRID = '#1f2937';
export const TICK = '#6b7280';
export const MARKER = '#6b7280';
export const TOOLTIP_STYLE = { background: '#0e131b', border: '1px solid #2a2f3a', borderRadius: 6, fontSize: 11, color: '#e5e7eb' };
/** Shared by both charts so their plot areas line up; the y-axis width fits two-digit tick labels inside the svg. */
export const CHART_MARGIN = { top: 16, right: 12, left: 0, bottom: 0 };
export const Y_AXIS_WIDTH = 28;
