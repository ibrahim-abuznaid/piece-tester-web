import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { Puzzle, Link2, Search } from 'lucide-react';

export default function Pieces() {
  const navigate = useNavigate();
  const { data: pieces, isLoading, error } = useQuery({ queryKey: ['pieces'], queryFn: api.listPieces });
  const { data: connections } = useQuery({ queryKey: ['connections'], queryFn: api.listConnections });
  const [search, setSearch] = useState('');

  const connectedPieces = new Set(connections?.map((c: any) => c.piece_name) ?? []);

  const filtered = pieces?.filter((p: any) =>
    p.displayName.toLowerCase().includes(search.toLowerCase()) ||
    p.name.toLowerCase().includes(search.toLowerCase())
  );

  if (isLoading) return <div className="text-gray-400">Loading pieces from Activepieces...</div>;
  if (error) return <div className="text-red-400">Error: {(error as Error).message}<br /><span className="text-sm text-gray-500">Make sure your Settings are configured correctly.</span></div>;

  return (
    <div>
      <h2 className="text-2xl font-bold mb-2">Pieces</h2>
      <p className="text-gray-400 text-sm mb-4">
        {pieces?.length ?? 0} pieces available. Click a piece to connect, configure actions, and test.
        {connectedPieces.size > 0 && <> <span className="text-green-400">{connectedPieces.size} connected</span> for testing.</>}
      </p>

      {/* Search */}
      <div className="relative mb-6">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
        <input
          className="w-full max-w-md bg-gray-900 border border-gray-800 rounded-lg pl-10 pr-3 py-2 text-sm focus:outline-none focus:border-primary-600"
          placeholder="Search pieces... (e.g. Google Sheets, Slack, Trello)"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {filtered?.map((piece: any) => {
          const isConnected = connectedPieces.has(piece.name);
          return (
            <div
              key={piece.name}
              onClick={() => navigate(`/pieces/${encodeURIComponent(piece.name)}`)}
              className={`bg-gray-900 border rounded-lg p-4 transition-colors cursor-pointer hover:ring-1 hover:ring-primary-500/40 ${isConnected ? 'border-green-500/40' : 'border-gray-800 hover:border-gray-700'}`}
            >
              <div className="flex items-start gap-3">
                {piece.logoUrl ? (
                  <img src={piece.logoUrl} alt="" className="w-10 h-10 rounded-lg" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                ) : (
                  <div className="w-10 h-10 rounded-lg bg-gray-800 flex items-center justify-center"><Puzzle size={20} className="text-gray-600" /></div>
                )}
                <div className="flex-1 min-w-0">
                  <h3 className="font-medium text-sm truncate">{piece.displayName}</h3>
                  <p className="text-xs text-gray-500 truncate mt-0.5">{piece.name}</p>
                </div>
                {isConnected && (
                  <span className="flex items-center gap-1 text-xs text-green-400">
                    <Link2 size={12} /> Connected
                  </span>
                )}
              </div>
              <p className="text-xs text-gray-500 mt-2 line-clamp-2">{piece.description || 'No description'}</p>
              <div className="flex gap-3 mt-3 text-xs text-gray-500">
                <span>{piece.actions} actions</span>
                <span>{piece.triggers} triggers</span>
                {piece.version && <span>v{piece.version}</span>}
              </div>
            </div>
          );
        })}
      </div>
      {filtered?.length === 0 && <p className="text-gray-500 text-sm mt-4">No pieces match "{search}".</p>}
    </div>
  );
}
