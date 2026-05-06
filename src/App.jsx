import React, { useState, useEffect } from 'react';
import Login     from './components/Login.jsx';
import Dashboard from './components/Dashboard.jsx';
import PortalApp from './components/customer-portal/PortalApp.jsx';

// ─── Global fetch patch ───────────────────────────────────────────────────────
// Automatically adds Authorization: Bearer <token> to every /api/ request.
// This means Dashboard, CampaignProgress, ClientDetail etc. need zero changes.
//
// Customer-portal endpoints (/api/portal/*) are EXCLUDED from this — they use
// their own session cookie set by the portal login route. Including the admin
// token on portal calls would be a privilege-escalation risk.
const _originalFetch = window.fetch.bind(window);
window.fetch = function (url, opts = {}) {
  if (typeof url === 'string' && url.startsWith('/api/') && !url.startsWith('/api/portal/')) {
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

// ─── Route resolution ─────────────────────────────────────────────────────────
// Hand-rolled route detection: if the URL path starts with /c/<slug>, mount
// the customer portal. Otherwise fall through to the existing admin auth flow.
// This is set ONCE at mount time — full page reload to switch between modes,
// which is exactly what we want (admin and customer auth must not bleed).
function getPortalSlug() {
  const m = window.location.pathname.match(/^\/c\/([^\/]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  // Decide ONCE at mount whether this is a portal session or admin session.
  // Stored in state so it doesn't recompute on every render.
  const [portalSlug] = useState(() => getPortalSlug());

  // ── Portal mode ────────────────────────────────────────────────────────────
  if (portalSlug) {
    return <PortalApp slug={portalSlug} />;
  }

  // ── Admin Studio mode (existing) ───────────────────────────────────────────
  return <AdminApp />;
}

function AdminApp() {
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
