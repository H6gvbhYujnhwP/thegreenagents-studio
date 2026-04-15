import React, { useState, useEffect } from 'react';
import Login     from './components/Login.jsx';
import Dashboard from './components/Dashboard.jsx';

// ─── Global fetch patch ───────────────────────────────────────────────────────
// Automatically adds Authorization: Bearer <token> to every /api/ request.
// This means Dashboard, CampaignProgress, ClientDetail etc. need zero changes.
const _originalFetch = window.fetch.bind(window);
window.fetch = function (url, opts = {}) {
  if (typeof url === 'string' && url.startsWith('/api/')) {
    const token = localStorage.getItem('studioToken') || '';
    opts = {
      ...opts,
      headers: {
        ...(opts.headers || {}),
        ...(token ? { 'Authorization': `Bearer ${token}` } : {})
      }
    };
  }
  return _originalFetch(url, opts);
};

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [auth, setAuth] = useState(null); // null = checking, true = in, false = out

  useEffect(() => {
    // Fast local check — if no token stored, skip the server round-trip
    const token = localStorage.getItem('studioToken');
    if (!token) { setAuth(false); return; }

    // Validate token is still correct against server
    fetch('/api/auth/check')
      .then(r => r.json())
      .then(d => setAuth(d.authenticated))
      .catch(() => setAuth(false));
  }, []);

  function handleLogin(token) {
    localStorage.setItem('studioToken', token);
    setAuth(true);
  }

  function handleLogout() {
    localStorage.removeItem('studioToken');
    setAuth(false);
  }

  if (auth === null) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#f5f5f3' }}>
      <div style={{ width: 32, height: 32, border: '3px solid #1D9E75', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );

  if (!auth) return <Login onLogin={handleLogin} />;
  return <Dashboard onLogout={handleLogout} />;
}
