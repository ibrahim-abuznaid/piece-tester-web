import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { LayoutDashboard, Puzzle, Link2, Play, ScrollText, CalendarClock, BarChart3, Settings, ListChecks, Square } from 'lucide-react';
import { api } from '../lib/api';

const nav = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/pieces', label: 'Pieces', icon: Puzzle },
  { to: '/connections', label: 'Connections', icon: Link2 },
  { to: '/test-runner', label: 'Test Runner', icon: Play },
  { to: '/history', label: 'Test Logs', icon: ScrollText },
  { to: '/schedules', label: 'Schedules', icon: CalendarClock },
  { to: '/reports', label: 'Reports', icon: BarChart3 },
  { to: '/batch-setup', label: 'Batch Setup', icon: ListChecks },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export default function Layout() {
  const [stopNote, setStopNote] = useState('');

  async function stopAllAiJobs() {
    try {
      const r = await api.cancelAllAiPlanJobs();
      setStopNote(r.cancelled > 0 ? `Stopped ${r.cancelled} AI job(s).` : 'No background AI jobs were running.');
      setTimeout(() => setStopNote(''), 5000);
    } catch (e: unknown) {
      setStopNote(e instanceof Error ? e.message : 'Failed to cancel.');
      setTimeout(() => setStopNote(''), 5000);
    }
  }

  return (
    <div className="flex h-screen bg-gray-950 text-gray-100">
      {/* Sidebar */}
      <aside className="w-56 flex-shrink-0 bg-gray-900 border-r border-gray-800 flex flex-col">
        <div className="p-4 border-b border-gray-800">
          <h1 className="text-lg font-bold text-primary-400">Piece Tester</h1>
          <p className="text-xs text-gray-500 mt-0.5">Activepieces QA</p>
        </div>
        <nav className="flex-1 py-2 min-h-0 overflow-y-auto">
          {nav.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-3 px-4 py-2.5 text-sm transition-colors ${
                  isActive
                    ? 'bg-primary-600/20 text-primary-300 border-r-2 border-primary-400'
                    : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'
                }`
              }
            >
              <Icon size={18} />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="p-3 border-t border-gray-800 space-y-2">
          <button
            type="button"
            onClick={stopAllAiJobs}
            className="w-full flex items-center justify-center gap-2 px-2 py-2 text-xs text-red-300 bg-red-500/10 hover:bg-red-500/20 border border-red-500/25 rounded transition-colors"
            title="Abort every running plan-creation job (Claude API + test execution). Does not affect the Piece Detail AI config stream unless you close that panel."
          >
            <Square size={14} />
            Stop all AI jobs
          </button>
          {stopNote && <p className="text-[10px] text-gray-500 text-center leading-tight">{stopNote}</p>}
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        <div className="max-w-6xl mx-auto p-6">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
