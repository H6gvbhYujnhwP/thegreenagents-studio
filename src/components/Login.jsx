import React, { useState } from 'react';

export default function Login({ onLogin }) {
  const [password, setPassword] = useState('');
  const [error,    setError]    = useState('');
  const [loading,  setLoading]  = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/auth/login', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ password })
      });

      if (res.ok) {
        const { token } = await res.json();
        onLogin(token);
      } else {
        setError('Incorrect password');
      }
    } catch {
      setError('Could not reach server — try again');
    }

    setLoading(false);
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f5f5f3' }}>
      <div style={{ background: '#fff', border: '0.5px solid #e0e0dc', borderRadius: 12, padding: '40px 36px', width: 360, boxShadow: '0 2px 16px rgba(0,0,0,0.06)' }}>

        {/* Logo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 32 }}>
          <div style={{ width: 36, height: 36, background: '#1D9E75', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: 16 }}>G</div>
          <div>
            <div style={{ fontWeight: 600, fontSize: 15, color: '#1a1a1a' }}>The Green Agents</div>
            <div style={{ fontSize: 12, color: '#888' }}>Studio</div>
          </div>
        </div>

        <form onSubmit={handleSubmit}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: '#555', marginBottom: 6 }}>
            Password
          </label>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="Enter studio password"
            required
            autoFocus
            style={{
              width: '100%', padding: '10px 12px',
              border: `1px solid ${error ? '#e74c3c' : '#d0d0cc'}`,
              borderRadius: 8, outline: 'none', marginBottom: 12,
              fontSize: 14, background: '#fff', boxSizing: 'border-box',
              transition: 'border-color 0.15s'
            }}
            onFocus={e => { if (!error) e.target.style.borderColor = '#1D9E75'; }}
            onBlur={e => { e.target.style.borderColor = error ? '#e74c3c' : '#d0d0cc'; }}
          />

          {error && (
            <div style={{ color: '#c0392b', fontSize: 12, marginBottom: 12 }}>{error}</div>
          )}

          <button
            type="submit"
            disabled={loading || !password}
            style={{
              width: '100%', background: loading ? '#9FE1CB' : '#1D9E75',
              color: '#fff', border: 'none', padding: '11px',
              borderRadius: 8, fontWeight: 600, fontSize: 14,
              cursor: loading || !password ? 'not-allowed' : 'pointer',
              transition: 'background 0.15s'
            }}
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
