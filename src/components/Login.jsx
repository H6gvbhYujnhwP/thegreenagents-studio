import React, { useState } from 'react';

export default function Login({ onLogin }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError('');
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    setLoading(false);
    if (res.ok) onLogin();
    else setError('Incorrect password');
  }

  return (
    <div style={{ minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center', background:'#f5f5f3' }}>
      <div style={{ background:'#fff', border:'0.5px solid #e0e0dc', borderRadius:12, padding:'40px 36px', width:360 }}>
        <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:32 }}>
          <div style={{ width:36, height:36, background:'#1D9E75', borderRadius:8, display:'flex', alignItems:'center', justifyContent:'center', color:'#fff', fontWeight:600, fontSize:16 }}>G</div>
          <div>
            <div style={{ fontWeight:500, fontSize:15, color:'#1a1a1a' }}>The Green Agents</div>
            <div style={{ fontSize:12, color:'#888' }}>Studio</div>
          </div>
        </div>
        <form onSubmit={handleSubmit}>
          <label style={{ display:'block', fontSize:12, color:'#666', marginBottom:6 }}>Password</label>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="Enter studio password"
            required
            style={{ width:'100%', padding:'10px 12px', border:'0.5px solid #d0d0cc', borderRadius:8, outline:'none', marginBottom:16, background:'#fff' }}
          />
          {error && <div style={{ color:'#c0392b', fontSize:12, marginBottom:12 }}>{error}</div>}
          <button
            type="submit"
            disabled={loading}
            style={{ width:'100%', background:'#1D9E75', color:'#fff', border:'none', padding:'10px', borderRadius:8, fontWeight:500 }}
          >
            {loading ? 'Signing in...' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
