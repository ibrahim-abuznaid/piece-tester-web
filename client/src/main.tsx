import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

const RELOADED_AT_KEY = 'stale-chunk-reloaded-at';

/** A redeploy deletes an open tab's lazy chunks: reload once for the new build, never again within 10 s. */
window.addEventListener('vite:preloadError', (event) => {
  if (Date.now() - Number(sessionStorage.getItem(RELOADED_AT_KEY) ?? 0) < 10_000) return;
  sessionStorage.setItem(RELOADED_AT_KEY, String(Date.now()));
  event.preventDefault();
  location.reload();
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
