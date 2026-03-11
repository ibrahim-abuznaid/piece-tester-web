import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Pieces from './pages/Pieces';
import PieceDetail from './pages/PieceDetail';
import Connections from './pages/Connections';
import TestRunner from './pages/TestRunner';
import History from './pages/History';
import Schedules from './pages/Schedules';
import Reports from './pages/Reports';
import Settings from './pages/Settings';
import BatchSetup from './pages/BatchSetup';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/pieces" element={<Pieces />} />
            <Route path="/pieces/:name" element={<PieceDetail />} />
            <Route path="/connections" element={<Connections />} />
            <Route path="/test-runner" element={<TestRunner />} />
            <Route path="/history" element={<History />} />
            <Route path="/schedules" element={<Schedules />} />
            <Route path="/reports" element={<Reports />} />
            <Route path="/batch-setup" element={<BatchSetup />} />
            <Route path="/settings" element={<Settings />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
