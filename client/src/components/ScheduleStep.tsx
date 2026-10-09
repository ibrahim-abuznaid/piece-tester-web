import type { ScheduleConfigInput } from '../lib/api';

const CADENCES: { key: ScheduleConfigInput['cadence']; label: string; hint: string }[] = [
  { key: 'monthly', label: 'Monthly (staggered)', hint: 'Each piece runs on a different day of the month' },
  { key: '6h', label: 'Every 6 hours', hint: 'Fast regression signal, heavier load' },
  { key: 'daily', label: 'Daily', hint: 'One run per piece per day' },
  { key: 'weekly', label: 'Weekly', hint: 'Light touch' },
  { key: 'custom', label: 'Custom cron', hint: 'Applied to every piece in the batch' },
];

export function ScheduleStep({ value, onChange }: { value: ScheduleConfigInput; onChange: (v: ScheduleConfigInput) => void }) {
  return (
    <div className="space-y-4">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={value.enabled} onChange={e => onChange({ ...value, enabled: e.target.checked })} />
        Auto-schedule the pieces that got approved plans (pieces already on a schedule are left alone)
      </label>
      {value.enabled && (
        <div className="space-y-2">
          {CADENCES.map(c => (
            <label key={c.key} className={`flex items-start gap-3 px-3 py-2 rounded-lg border cursor-pointer ${value.cadence === c.key ? 'border-primary-600 bg-primary-600/10' : 'border-gray-800'}`}>
              <input type="radio" name="cadence" checked={value.cadence === c.key} onChange={() => onChange({ ...value, cadence: c.key })} className="mt-1" />
              <div>
                <div className="text-sm">{c.label}</div>
                <div className="text-xs text-gray-500">{c.hint}</div>
              </div>
            </label>
          ))}
          {value.cadence === 'custom' && (
            <input
              className="w-full bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 text-sm font-mono"
              placeholder="0 3 * * *"
              value={value.customCron ?? ''}
              onChange={e => onChange({ ...value, customCron: e.target.value })}
            />
          )}
        </div>
      )}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={value.firstRun !== false} onChange={e => onChange({ ...value, firstRun: e.target.checked })} />
        Run every approved plan once right after setup, so results show in Health without waiting for the schedule
      </label>
    </div>
  );
}
