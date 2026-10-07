import { useSearchParams } from 'react-router-dom';
import FindingsTable from '../components/vendor-watch/FindingsTable';
import WatchersTab from '../components/vendor-watch/WatchersTab';
import VendorWatchConfigCard from '../components/vendor-watch/VendorWatchConfigCard';
import type { VwImportanceFilter } from '../lib/api';
import { parseImportanceParam } from '../lib/vendorWatch';

const TABS = [
  { id: 'inbox', label: 'Inbox' },
  { id: 'filed', label: 'Filed' },
  { id: 'watchers', label: 'Watchers' },
  { id: 'config', label: 'Config' },
] as const;
type TabId = (typeof TABS)[number]['id'];

export default function VendorWatch() {
  const [params, setParams] = useSearchParams();
  const tab: TabId = TABS.find(t => t.id === params.get('tab'))?.id ?? 'inbox';
  const piece = params.get('piece') || undefined;

  const update = (fn: (p: URLSearchParams) => void) => {
    const next = new URLSearchParams(params);
    fn(next);
    setParams(next, { replace: true });
  };
  const importance = parseImportanceParam(params.get('importance'));
  const setImportance = (v: VwImportanceFilter[]) =>
    update(p => (v.length ? p.set('importance', v.join(',')) : p.delete('importance')));

  return (
    <div>
      <h1 className="mb-1 text-xl font-bold">Vendor Watch</h1>
      <p className="mb-4 text-sm text-gray-400">
        Watches vendor changelogs, OpenAPI specs and API hosts, and files breaking changes in Linear.
      </p>
      {piece && (
        <div className="mb-3 flex items-center gap-2 text-xs text-gray-400">
          Showing <span className="font-mono text-gray-200">{piece}</span>
          <button onClick={() => update(p => p.delete('piece'))} className="text-primary-400 hover:underline">show all</button>
        </div>
      )}
      <div className="mb-4 flex gap-1 border-b border-gray-800">
        {TABS.map(t => (
          <button key={t.id} onClick={() => update(p => p.set('tab', t.id))}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === t.id ? 'border-primary-500 text-gray-100' : 'border-transparent text-gray-400 hover:text-gray-200'}`}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'inbox' && <FindingsTable status="new" piece={piece} importance={importance} onImportanceChange={setImportance} />}
      {tab === 'filed' && <FindingsTable status="filed" piece={piece} importance={importance} onImportanceChange={setImportance} />}
      {tab === 'watchers' && <WatchersTab piece={piece} importance={importance} onImportanceChange={setImportance} />}
      {tab === 'config' && <VendorWatchConfigCard />}
    </div>
  );
}
