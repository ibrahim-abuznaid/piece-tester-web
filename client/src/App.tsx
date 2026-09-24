import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from './lib/api';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Connections from './pages/Connections';
import TestRunner from './pages/TestRunner';
import History from './pages/History';
import Schedules from './pages/Schedules';
import Settings from './pages/Settings';
import BatchSetup from './pages/BatchSetup';

/** Heavy pages load on first visit: the chart pages carry recharts and html-to-image, and PieceDetail is the largest page. */
const Reports = lazy(() => import('./pages/Reports'));
const BugTrend = lazy(() => import('./pages/BugTrend'));
const PieceDetail = lazy(() => import('./pages/PieceDetail'));

/** Shows the pages' usual loading line while a lazy page's chunk downloads. */
function LazyPage({ children }: { children: ReactNode }) {
  return <Suspense fallback={<div className="text-gray-400">Loading…</div>}>{children}</Suspense>;
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    api.authStatus().then((s) => setAuthed(s.authenticated)).catch(() => setAuthed(false));
    const onUnauthorized = () => setAuthed(false);
    window.addEventListener('auth:unauthorized', onUnauthorized);
    return () => window.removeEventListener('auth:unauthorized', onUnauthorized);
  }, []);

  if (authed === null) {
    return <div className="flex h-screen items-center justify-center bg-gray-950 text-gray-400">Loading…</div>;
  }
  if (!authed) {
    return <Login onSuccess={() => setAuthed(true)} />;
  }

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/pieces" element={<Navigate to="/schedules" replace />} />
            <Route path="/pieces/:name" element={<LazyPage><PieceDetail /></LazyPage>} />
            <Route path="/connections" element={<Connections />} />
            <Route path="/test-runner" element={<TestRunner />} />
            <Route path="/history" element={<History />} />
            <Route path="/schedules" element={<Schedules />} />
            <Route path="/reports" element={<LazyPage><Reports /></LazyPage>} />
            <Route path="/bug-trend" element={<LazyPage><BugTrend /></LazyPage>} />
            <Route path="/batch-setup" element={<BatchSetup />} />
            <Route path="/settings" element={<Settings />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
