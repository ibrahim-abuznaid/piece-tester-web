import { useState } from 'react';
import { CadencePayload } from '../lib/api';

// ── Cadence config (mirrors the old Schedules form) ──────────────────────────

export type Frequency = 'hourly' | 'daily' | 'weekly' | 'monthly';

export interface ScheduleConfig {
  frequency: Frequency;
  minute: number;    // 0-59
  hour: number;      // 0-23
  dayOfWeek: number; // 0=Sun … 6=Sat (weekly)
  dayOfMonth: number;// 1-28 (monthly)
}

const DAYS_OF_WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const TIMEZONES = [
  'UTC', 'Asia/Amman', 'America/New_York', 'America/Chicago', 'America/Denver',
  'America/Los_Angeles', 'Europe/London', 'Europe/Paris', 'Europe/Berlin',
  'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney',
];

export function defaultCadenceConfig(): ScheduleConfig {
  return { frequency: 'daily', minute: 0, hour: 6, dayOfWeek: 1, dayOfMonth: 1 };
}

export function configToCron(cfg: ScheduleConfig): string {
  const m = cfg.minute, h = cfg.hour;
  switch (cfg.frequency) {
    case 'hourly':  return `${m} * * * *`;
    case 'daily':   return `${m} ${h} * * *`;
    case 'weekly':  return `${m} ${h} * * ${cfg.dayOfWeek}`;
    case 'monthly': return `${m} ${h} ${cfg.dayOfMonth} * *`;
  }
}

export function describeConfig(cfg: ScheduleConfig, tz: string): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const time = `${pad(cfg.hour)}:${pad(cfg.minute)} ${tz}`;
  switch (cfg.frequency) {
    case 'hourly':  return `Every hour at minute :${pad(cfg.minute)} (${tz})`;
    case 'daily':   return `Every day at ${time}`;
    case 'weekly':  return `Every ${DAYS_OF_WEEK[cfg.dayOfWeek]} at ${time}`;
    case 'monthly': return `Day ${cfg.dayOfMonth} of every month at ${time}`;
  }
}

/** Compact cadence label for badges/feeds: "Daily 06:00", "Hourly :00", "Weekly Mon 06:00". */
export function shortLabel(cfg: ScheduleConfig): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const t = `${pad(cfg.hour)}:${pad(cfg.minute)}`;
  switch (cfg.frequency) {
    case 'hourly':  return `Hourly :${pad(cfg.minute)}`;
    case 'daily':   return `Daily ${t}`;
    case 'weekly':  return `Weekly ${DAYS_OF_WEEK[cfg.dayOfWeek].slice(0, 3)} ${t}`;
    case 'monthly': return `Monthly d${cfg.dayOfMonth} ${t}`;
  }
}

/** Turn a config + timezone into the payload the coverage endpoints expect. */
export function buildCadencePayload(cfg: ScheduleConfig, timezone: string): CadencePayload {
  return {
    cron_expression: configToCron(cfg),
    schedule_config: JSON.stringify(cfg),
    timezone,
    label: shortLabel(cfg),
  };
}

/** The default quick-enroll cadence (daily 06:00 UTC). */
export const DEFAULT_CADENCE = buildCadencePayload(defaultCadenceConfig(), 'UTC');
export const DEFAULT_CADENCE_LABEL = 'daily 06:00';

// ── Modal ────────────────────────────────────────────────────────────────────

export function CadenceModal({
  title, subtitle, confirmLabel, busy, initialConfig, initialTimezone, onConfirm, onClose,
}: {
  title: string;
  subtitle?: string;
  confirmLabel: string;
  busy?: boolean;
  initialConfig?: ScheduleConfig;
  initialTimezone?: string;
  onConfirm: (cadence: CadencePayload) => void;
  onClose: () => void;
}) {
  const [cfg, setCfg] = useState<ScheduleConfig>(initialConfig ?? defaultCadenceConfig());
  const [tz, setTz] = useState<string>(initialTimezone ?? 'UTC');

  const set = <K extends keyof ScheduleConfig>(k: K, v: ScheduleConfig[K]) =>
    setCfg(prev => ({ ...prev, [k]: v }));

  const previewDesc = describeConfig(cfg, tz);
  const previewCron = configToCron(cfg);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <h3 className="text-lg font-bold">{title}</h3>
          {subtitle && <p className="text-sm text-gray-500 mt-0.5 mb-4">{subtitle}</p>}

          <div className="space-y-4 mt-4">
            {/* Frequency */}
            <div>
              <label className="block text-sm text-gray-400 mb-2">Frequency</label>
              <div className="grid grid-cols-4 gap-2">
                {(['hourly', 'daily', 'weekly', 'monthly'] as Frequency[]).map(f => (
                  <button
                    key={f}
                    onClick={() => set('frequency', f)}
                    className={`py-2 rounded text-sm font-medium border transition-colors ${
                      cfg.frequency === f
                        ? 'bg-primary-600 border-primary-500 text-white'
                        : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-600'
                    }`}
                  >
                    {f.charAt(0).toUpperCase() + f.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            {/* Day of week */}
            {cfg.frequency === 'weekly' && (
              <div>
                <label className="block text-sm text-gray-400 mb-2">Day of week</label>
                <div className="grid grid-cols-7 gap-1">
                  {DAYS_OF_WEEK.map((d, i) => (
                    <button
                      key={i}
                      onClick={() => set('dayOfWeek', i)}
                      className={`py-1.5 rounded text-xs font-medium border transition-colors ${
                        cfg.dayOfWeek === i
                          ? 'bg-primary-600 border-primary-500 text-white'
                          : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-600'
                      }`}
                    >
                      {d.slice(0, 3)}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Day of month */}
            {cfg.frequency === 'monthly' && (
              <div>
                <label className="block text-sm text-gray-400 mb-2">Day of month</label>
                <div className="flex flex-wrap gap-1">
                  {Array.from({ length: 28 }, (_, i) => i + 1).map(d => (
                    <button
                      key={d}
                      onClick={() => set('dayOfMonth', d)}
                      className={`w-9 h-9 rounded text-xs font-medium border transition-colors ${
                        cfg.dayOfMonth === d
                          ? 'bg-primary-600 border-primary-500 text-white'
                          : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-600'
                      }`}
                    >
                      {d}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Hour + Minute */}
            <div className="grid grid-cols-2 gap-4">
              {cfg.frequency !== 'hourly' && (
                <div>
                  <label className="block text-sm text-gray-400 mb-1">Hour (0–23)</label>
                  <input
                    type="number" min={0} max={23}
                    className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-primary-500"
                    value={cfg.hour}
                    onChange={e => set('hour', Math.min(23, Math.max(0, parseInt(e.target.value) || 0)))}
                  />
                </div>
              )}
              <div>
                <label className="block text-sm text-gray-400 mb-1">Minute (0–59)</label>
                <input
                  type="number" min={0} max={59}
                  className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-primary-500"
                  value={cfg.minute}
                  onChange={e => set('minute', Math.min(59, Math.max(0, parseInt(e.target.value) || 0)))}
                />
              </div>
            </div>

            {/* Timezone */}
            <div>
              <label className="block text-sm text-gray-400 mb-1">Timezone</label>
              <select
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-primary-500"
                value={tz}
                onChange={e => setTz(e.target.value)}
              >
                {TIMEZONES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>

            {/* Preview */}
            <div className="bg-gray-800/60 border border-gray-700 rounded-lg p-3 space-y-1">
              <p className="text-xs text-gray-500 font-medium uppercase tracking-wide">Preview</p>
              <p className="text-sm text-white">{previewDesc}</p>
              <p className="text-xs text-gray-500 font-mono">{previewCron}</p>
            </div>
          </div>

          <div className="flex gap-3 mt-6">
            <button
              onClick={() => onConfirm(buildCadencePayload(cfg, tz))}
              disabled={busy}
              className="px-4 py-2 bg-primary-600 hover:bg-primary-700 rounded text-sm font-medium disabled:opacity-50"
            >
              {busy ? 'Saving…' : confirmLabel}
            </button>
            <button
              onClick={onClose}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm font-medium"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
