// ─────────────────────────────────────────────────────────────────────────────
// Customer portal — front-end only (mock data). Renders when the URL path
// starts with /c/<customer-slug>. App.jsx detects this and mounts <PortalApp/>
// instead of the admin Studio.
//
// All data is FAKE in this file. The next chat wires real APIs by replacing
// the `mockClient`, `mockPosts`, etc. constants with fetch calls to
// /api/portal/* endpoints. The component shapes don't change.
//
// Sections:
//   - utility constants & tiny helpers
//   - PortalApp: the route shell + auth gate
//   - PortalLogin: login form
//   - PortalChrome: shared sidebar + header layout used by every authenticated page
//   - PortalPosts: LinkedIn posts grid + edit modal + regen confirmation
//   - PortalInbox: replies table + reply detail + compose
//   - PortalCampaigns: read-only campaign list with stats
//   - PortalSettings: change password, manage users, view branding
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useEffect, useMemo } from 'react';

// Brand colours — match the admin Studio for visual consistency.
const TGA_GREEN     = '#0e3b2d';
const TGA_GREEN_HI  = '#14a37e';
const TGA_GREEN_LO  = '#7fbfa1';
const TEXT          = '#1a1a1a';
const MUTED         = '#5f5e5a';
const TERTIARY_TEXT = '#888780';
const BORDER        = '#e5e3dd';
const CARD          = '#ffffff';
const BG            = '#f5f5f3';
const BLUE          = '#185FA5';
const BLUE_BG       = '#E6F1FB';
const DANGER        = '#A32D2D';
const GREEN         = '#0F6E56';
const GREEN_BG      = '#E1F5EE';
const AMBER         = '#854F0B';
const AMBER_BG      = '#FAEEDA';

// ── MOCK DATA ────────────────────────────────────────────────────────────────
// These get replaced with fetch calls in the backend chat. The shapes here
// are what the API will need to return.

const mockClient = {
  slug: 'tower-leasing',
  name: 'Tower Leasing',
  audience: 'Asset finance · authority brand',
  logo_initial: 'TL',
  logo_color: '#1a4d8c',
};

const mockPosts = Array.from({ length: 12 }).map((_, i) => ({
  id: `post_${i + 1}`,
  order: i + 1,
  scheduled_for: ['Tue 08:00', 'Thu 08:30', 'Fri 09:00', 'Mon 08:00', 'Wed 09:30',
                  'Thu 08:00', 'Mon 09:00', 'Wed 08:30', 'Fri 09:00', 'Tue 08:30',
                  'Thu 09:00', 'Mon 08:30'][i],
  category: ['Authority', 'Authority', 'Education', 'Commercial', 'Education',
             'Authority', 'Commercial', 'Education', 'Authority', 'Commercial',
             'Education', 'Authority'][i],
  title: ['Cost of delay — real numbers',
          'Banks assess SMEs like spreadsheets',
          'How asset finance actually works',
          'Objection handling — debt is risky',
          'Six-month window to act',
          'Hidden cost of waiting',
          'When leasing beats cash',
          'Reading the fine print',
          'What the FD won\'t tell you',
          'A simple test before you sign',
          'The depreciation curve',
          'One question to ask your accountant'][i],
  body: 'A manufacturing business I spoke to last month had a packaging line that kept jamming.\n\nThree months of overtime. Missed delivery windows. A major client starting to look elsewhere.\n\nThey could have replaced it for £80k. They didn\'t. The cost of delay was £500k.\n\nMost SMEs underestimate the cost of doing nothing. The real risk isn\'t the new investment — it\'s the lost revenue from holding off.',
  image_color: ['#1a3a4d', '#4d2a1a', '#2a4d2a', '#4d1a3a', '#3a4d1a',
                '#1a4d3a', '#4d3a1a', '#1a3a4d', '#3a1a4d', '#4d1a2a',
                '#1a4d2a', '#2a1a4d'][i],
  approved: i < 3,  // first 3 are approved in the demo
}));

const mockReplies = [
  { id: 'r1', from_name: 'Nikhil Mundada', from_addr: 'nik@fronthunt-australia.com', subject: 'Streamlining your home sale process — quick question', snippet: 'Thanks for reaching out — could you share a bit more about how this would integrate with our existing CRM?', received_at: '2026-04-29T10:23:00Z', classification: 'positive', auto_unsubscribed: false, campaign_title: 'Q1 Asset finance authority', step_number: 2 },
  { id: 'r2', from_name: 'Jinsong Guo',     from_addr: 'jinsong@unlimidata.co',       subject: 'Logo design process — a few clarifications needed', snippet: 'Yes, very interested. Can we book in a 20 minute call this week?', received_at: '2026-04-29T08:11:00Z', classification: 'positive', auto_unsubscribed: false, campaign_title: 'Q1 Asset finance authority', step_number: 1 },
  { id: 'r3', from_name: 'Cole',             from_addr: 'cole@formspree.io',          subject: 'Route your submissions with form rules', snippet: 'Please remove me from this list. Not interested.', received_at: '2026-05-03T14:50:00Z', classification: 'hard_negative', auto_unsubscribed: true, campaign_title: 'Q1 Asset finance authority', step_number: 1 },
  { id: 'r4', from_name: 'Google',           from_addr: 'no-reply@accounts.google.com',subject: 'Security alert', snippet: 'A new sign-in was detected on your Google account.', received_at: '2026-05-06T07:33:00Z', classification: 'neutral', auto_unsubscribed: false, campaign_title: null, step_number: null },
  { id: 'r5', from_name: 'Lauren Squitieri', from_addr: 'lauren@joincubesoftware.com', subject: 'Boost your lead game — automated emails', snippet: 'Out of office until 8 May.', received_at: '2026-04-30T09:00:00Z', classification: 'auto_reply', auto_unsubscribed: false, campaign_title: 'Q1 Asset finance authority', step_number: 1 },
];

const mockCampaigns = [
  { id: 'c1', title: 'Q1 Asset finance authority', status: 'sending', sent: 412, queued: 123, opens: 12, clicks: 3, replies: 7, tracking_off: false, started_at: '2026-04-12' },
  { id: 'c2', title: 'Q4 Construction sector',     status: 'sent',    sent: 535, queued: 0,   opens: 0,  clicks: 0, replies: 9, tracking_off: true,  started_at: '2026-01-08' },
  { id: 'c3', title: 'Hospitality decision-maker outreach', status: 'sent', sent: 300, queued: 0, opens: 0, clicks: 0, replies: 8, tracking_off: true,  started_at: '2025-11-20' },
];

// Aggregate stats — what the dashboard headline shows.
function aggregateStats(campaigns) {
  const sent = campaigns.reduce((a, c) => a + c.sent, 0);
  const trackable = campaigns.filter(c => !c.tracking_off).reduce((a, c) => a + c.sent, 0);
  const opens = campaigns.reduce((a, c) => a + c.opens, 0);
  const clicks = campaigns.reduce((a, c) => a + c.clicks, 0);
  const replies = campaigns.reduce((a, c) => a + c.replies, 0);
  const untracked = sent - trackable;
  const openRate  = trackable > 0 ? Math.round((opens / trackable) * 1000) / 10 : 0;
  const clickRate = trackable > 0 ? Math.round((clicks / trackable) * 1000) / 10 : 0;
  return { sent, trackable, opens, clicks, replies, untracked, openRate, clickRate };
}

// ── ROOT ─────────────────────────────────────────────────────────────────────
export default function PortalApp({ slug }) {
  // null = checking session, false = need login, object = authenticated user
  const [authUser, setAuthUser] = useState(null);
  const [client,   setClient]   = useState(null);
  const [services, setServices] = useState(null);

  // If the URL has ?reset=<token>, we're on the reset-password leg of the flow.
  // The reset screen takes priority over login/dashboard until the user either
  // submits successfully (returns to login) or navigates away.
  const [resetToken] = useState(() => {
    const m = window.location.search.match(/[?&]reset=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  });

  // Real auth check — calls /api/portal/auth/check which validates the
  // HttpOnly session cookie set by the login route.
  useEffect(() => {
    if (resetToken) { setAuthUser(false); return; }  // skip; reset screen will mount
    fetch('/api/portal/auth/check', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d && d.user) {
          setAuthUser(d.user);
          setClient(d.client);
          setServices(d.services);
        } else {
          setAuthUser(false);
        }
      })
      .catch(() => setAuthUser(false));
  }, [slug, resetToken]);

  function handleLogin({ user, client, services }) {
    setAuthUser(user);
    setClient(client);
    setServices(services);
  }
  async function handleLogout() {
    try { await fetch('/api/portal/auth/logout', { method:'POST', credentials:'include' }); } catch {}
    setAuthUser(false);
    setClient(null);
    setServices(null);
  }

  if (resetToken) {
    return <PortalResetPassword slug={slug} token={resetToken} />;
  }

  if (authUser === null) {
    return (
      <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100vh', background:BG }}>
        <div style={{ width:32, height:32, border:`3px solid ${TGA_GREEN_HI}`, borderTopColor:'transparent', borderRadius:'50%', animation:'spin 0.8s linear infinite' }} />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  if (!authUser) {
    return <PortalLogin slug={slug} onLogin={handleLogin} />;
  }

  return <PortalChrome user={authUser} client={client} services={services} onLogout={handleLogout} />;
}

// ── LOGIN ────────────────────────────────────────────────────────────────────
function PortalLogin({ slug, onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy]         = useState(false);
  const [err, setErr]           = useState('');
  const [clientName, setClientName] = useState('');
  const [showForgot, setShowForgot] = useState(false);

  // Resolve the slug → client name from /api/portal/by-slug/:slug. If the
  // slug doesn't match any client, fall back to a Title-Case rendering of
  // the slug so the page still looks reasonable. We don't show an explicit
  // "client not found" error here because that would let an attacker probe
  // for valid slugs from outside the portal.
  useEffect(() => {
    fetch(`/api/portal/by-slug/${encodeURIComponent(slug)}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d && d.client_name) setClientName(d.client_name);
        else setClientName(slug.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' '));
      })
      .catch(() => setClientName(slug));
  }, [slug]);

  async function submit(e) {
    e?.preventDefault();
    if (!username || !password) {
      setErr('Username and password required');
      return;
    }
    setBusy(true); setErr('');
    try {
      const r = await fetch('/api/portal/auth/login', {
        method:'POST',
        credentials:'include',
        headers:{ 'Content-Type':'application/json' },
        body: JSON.stringify({ slug, username, password }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) {
        setErr(d.error || 'Invalid credentials');
        setBusy(false);
        return;
      }
      onLogin({ user: d.user, client: d.client, services: d.services });
    } catch (e2) {
      setErr('Network error — try again.');
      setBusy(false);
    }
  }

  return (
    <div style={{ minHeight:'100vh', background:BG, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
      <form onSubmit={submit} style={{
        maxWidth:400, width:'100%', padding:'32px 28px',
        background:CARD, borderRadius:12, border:`0.5px solid ${BORDER}`,
      }}>
        <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:28 }}>
          <div style={{
            width:36, height:36, borderRadius:8, background:TGA_GREEN_HI,
            color:'white', display:'flex', alignItems:'center', justifyContent:'center',
            fontSize:16, fontWeight:500,
          }}>G</div>
          <div>
            <div style={{ fontSize:18, fontWeight:500, color:TEXT }}>The Green Agents</div>
            <div style={{ fontSize:12, color:MUTED, marginTop:2 }}>Studio · {clientName} portal</div>
          </div>
        </div>

        <Field label="Username">
          <input type="text" value={username} onChange={e => setUsername(e.target.value)}
            autoFocus disabled={busy}
            placeholder="your username"
            style={loginInputStyle()}
          />
        </Field>

        <Field label="Password">
          <input type="password" value={password} onChange={e => setPassword(e.target.value)}
            disabled={busy}
            style={loginInputStyle()}
          />
        </Field>

        {err && <div style={{ color:DANGER, fontSize:12, marginTop:8 }}>{err}</div>}

        <button type="submit" disabled={busy} style={{
          width:'100%', padding:10, fontSize:13, fontWeight:500,
          background: busy ? TGA_GREEN_LO : TGA_GREEN_HI, color:'white',
          border:'none', borderRadius:8, cursor: busy ? 'default' : 'pointer',
          marginTop:12,
        }}>{busy ? 'Signing in…' : 'Sign in'}</button>

        <a onClick={() => setShowForgot(true)}
          style={{ display:'block', textAlign:'center', marginTop:14, fontSize:12, color:BLUE, cursor:'pointer' }}
        >Forgot password?</a>
      </form>

      {showForgot && <ForgotPasswordModal slug={slug} onClose={() => setShowForgot(false)} />}
    </div>
  );
}

// ── FORGOT-PASSWORD MODAL ────────────────────────────────────────────────────
// Asks for an email, posts to /api/portal/auth/forgot-password, and shows a
// confirmation message regardless of whether the email matched a real user
// (the backend always returns 200 to avoid leaking whether an email exists).
function ForgotPasswordModal({ slug, onClose }) {
  const [email, setEmail] = useState('');
  const [busy, setBusy]   = useState(false);
  const [done, setDone]   = useState(false);

  async function submit() {
    if (!email.trim()) return;
    setBusy(true);
    try {
      await fetch('/api/portal/auth/forgot-password', {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        body: JSON.stringify({ slug, email: email.trim() }),
      });
    } catch {}
    setBusy(false);
    setDone(true);
  }

  return (
    <Modal title="Reset your password" onClose={onClose}>
      {done ? (
        <div>
          <p style={{ fontSize:13, color:TEXT, lineHeight:1.5, margin:'0 0 16px' }}>
            If an account exists for <strong>{email}</strong>, we've sent a reset link to it.
            Check your inbox in the next minute or two — the link is valid for 1 hour.
          </p>
          <div style={{ display:'flex', justifyContent:'flex-end' }}>
            <BtnPrimary onClick={onClose}>Done</BtnPrimary>
          </div>
        </div>
      ) : (
        <div>
          <p style={{ fontSize:13, color:TEXT, lineHeight:1.5, margin:'0 0 14px' }}>
            Enter the email address tied to your portal account. We'll send a reset link.
          </p>
          <Field label="Email address">
            <input type="email" value={email} onChange={e => setEmail(e.target.value)}
              autoFocus disabled={busy} style={loginInputStyle()}
              placeholder="you@yourcompany.co.uk"
            />
          </Field>
          <div style={{ display:'flex', justifyContent:'flex-end', gap:8, marginTop:14 }}>
            <BtnSecondary onClick={onClose} disabled={busy}>Cancel</BtnSecondary>
            <BtnPrimary onClick={submit} disabled={busy || !email.trim()}>
              {busy ? 'Sending…' : 'Send reset link'}
            </BtnPrimary>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ── RESET-PASSWORD SCREEN ────────────────────────────────────────────────────
// Mounted when the URL is /c/<slug>?reset=<token>. Validates locally that
// the new password meets minimum length, then posts to the backend. On success,
// strips the ?reset= query and reloads to land on the login page so the user
// signs in fresh (per the locked-in pre-decision: reset kills all sessions).
function PortalResetPassword({ slug, token }) {
  const [pw1, setPw1]   = useState('');
  const [pw2, setPw2]   = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr]   = useState('');
  const [done, setDone] = useState(false);

  async function submit(e) {
    e?.preventDefault();
    if (pw1.length < 8) { setErr('Password must be at least 8 characters'); return; }
    if (pw1 !== pw2)    { setErr('Passwords don\'t match'); return; }
    setBusy(true); setErr('');
    try {
      const r = await fetch('/api/portal/auth/reset-password', {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        body: JSON.stringify({ token, new: pw1 }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) {
        setErr(d.error || 'Could not reset password.');
        setBusy(false);
        return;
      }
      setDone(true);
    } catch {
      setErr('Network error — try again.');
      setBusy(false);
    }
  }

  function goToLogin() {
    // Strip the ?reset= param and reload so PortalApp lands on PortalLogin.
    window.location.href = `/c/${encodeURIComponent(slug)}`;
  }

  return (
    <div style={{ minHeight:'100vh', background:BG, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
      <form onSubmit={submit} style={{
        maxWidth:400, width:'100%', padding:'32px 28px',
        background:CARD, borderRadius:12, border:`0.5px solid ${BORDER}`,
      }}>
        <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:24 }}>
          <div style={{
            width:36, height:36, borderRadius:8, background:TGA_GREEN_HI,
            color:'white', display:'flex', alignItems:'center', justifyContent:'center',
            fontSize:16, fontWeight:500,
          }}>G</div>
          <div>
            <div style={{ fontSize:18, fontWeight:500, color:TEXT }}>Set a new password</div>
            <div style={{ fontSize:12, color:MUTED, marginTop:2 }}>The Green Agents Studio portal</div>
          </div>
        </div>

        {done ? (
          <div>
            <div style={{
              padding:'10px 12px', background:GREEN_BG, color:GREEN,
              borderRadius:8, fontSize:13, marginBottom:16, lineHeight:1.5,
            }}>
              Password updated. Sign in with your new password to continue.
            </div>
            <button type="button" onClick={goToLogin} style={{
              width:'100%', padding:10, fontSize:13, fontWeight:500,
              background: TGA_GREEN_HI, color:'white',
              border:'none', borderRadius:8, cursor:'pointer',
            }}>Go to sign in</button>
          </div>
        ) : (
          <>
            <Field label="New password (8+ characters)">
              <input type="password" value={pw1} onChange={e => setPw1(e.target.value)}
                autoFocus disabled={busy} style={loginInputStyle()} />
            </Field>
            <Field label="Confirm new password">
              <input type="password" value={pw2} onChange={e => setPw2(e.target.value)}
                disabled={busy} style={loginInputStyle()} />
            </Field>
            {err && <div style={{ color:DANGER, fontSize:12, marginTop:6 }}>{err}</div>}
            <button type="submit" disabled={busy} style={{
              width:'100%', padding:10, fontSize:13, fontWeight:500,
              background: busy ? TGA_GREEN_LO : TGA_GREEN_HI, color:'white',
              border:'none', borderRadius:8, cursor: busy ? 'default' : 'pointer',
              marginTop:12,
            }}>{busy ? 'Updating…' : 'Set new password'}</button>
          </>
        )}
      </form>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom:12 }}>
      <label style={{ display:'block', fontSize:12, color:MUTED, marginBottom:4 }}>{label}</label>
      {children}
    </div>
  );
}

function loginInputStyle() {
  return {
    width:'100%', boxSizing:'border-box', padding:'9px 10px', fontSize:13,
    border:`0.5px solid ${BORDER}`, borderRadius:8, outline:'none',
    color:TEXT, background:CARD,
  };
}

// ── CHROME (sidebar + header + page router) ──────────────────────────────────
function PortalChrome({ user, client, services, onLogout }) {
  const [page, setPage] = useState('posts');  // posts | inbox | campaigns | settings | facebook (future)

  // The portal sidebar always shows EVERY service (per Wez's locked-in
  // pre-decision — discoverability over hidden tabs). What changes is what
  // each tab renders inside, based on the `services` object from the server.
  // The `services` object has three states per service: 'enabled' /
  // 'not_required' / 'coming_soon'. ServiceGate handles the latter two.
  const svc = services || { email:'enabled', linkedin:'enabled', facebook:'coming_soon' };

  return (
    <div style={{ display:'flex', height:'100vh', background:BG, fontFamily:'-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>
      {/* Sidebar */}
      <aside style={{
        width:220, background:TGA_GREEN, color:TGA_GREEN_LO,
        display:'flex', flexDirection:'column', flexShrink:0,
      }}>
        {/* Brand block — clearly delineated from nav with a divider below */}
        <div style={{
          padding:'20px 18px', borderBottom:'0.5px solid rgba(255,255,255,0.1)',
          display:'flex', alignItems:'center', gap:10,
        }}>
          <div style={{
            width:30, height:30, borderRadius:7, background:TGA_GREEN_HI,
            color:'white', display:'flex', alignItems:'center', justifyContent:'center',
            fontSize:14, fontWeight:500, flexShrink:0,
          }}>G</div>
          <div style={{ minWidth:0 }}>
            <div style={{ fontSize:13, fontWeight:500, color:'white', lineHeight:1.2 }}>The Green Agents</div>
            <div style={{ fontSize:11, color:TGA_GREEN_LO, marginTop:2 }}>Studio</div>
          </div>
        </div>

        {/* Nav — three sections (Social posts, Email, Account). Each has a
            small-caps heading, then nav items. Generous gap between sections
            so the eye can group them. */}
        <nav style={{ flex:1, padding:'14px 0', display:'flex', flexDirection:'column', gap:18 }}>
          <NavSection heading="Social posts">
            <NavItem label="LinkedIn Posts"
              active={page==='posts'}
              onClick={() => setPage('posts')}
              dim={svc.linkedin === 'not_required'}
            />
            <NavItem label="Facebook Posts"
              active={page==='facebook'}
              onClick={() => setPage('facebook')}
              dim={svc.facebook !== 'enabled'}
              suffix={svc.facebook === 'coming_soon' ? 'Soon' : null}
            />
          </NavSection>

          <NavSection heading="Email">
            <NavItem label="Inbox"
              active={page==='inbox'}
              onClick={() => setPage('inbox')}
              dim={svc.email === 'not_required'}
            />
            <NavItem label="Campaigns"
              active={page==='campaigns'}
              onClick={() => setPage('campaigns')}
              dim={svc.email === 'not_required'}
            />
          </NavSection>

          <NavSection heading="Account">
            <NavItem label="Settings"
              active={page==='settings'}
              onClick={() => setPage('settings')}
            />
          </NavSection>
        </nav>

        {/* Sign out — pinned to the bottom, its own visual zone via top border */}
        <div style={{
          padding:'14px 18px', borderTop:'0.5px solid rgba(255,255,255,0.1)',
        }}>
          <button onClick={onLogout} style={{
            background:'transparent', border:'none', color:TGA_GREEN_LO,
            fontSize:12, padding:0, cursor:'pointer',
          }}>Sign out</button>
        </div>
      </aside>

      {/* Workspace */}
      <main style={{ flex:1, display:'flex', flexDirection:'column', minWidth:0 }}>
        <header style={{
          padding:'14px 22px', borderBottom:`0.5px solid ${BORDER}`,
          display:'flex', alignItems:'center', gap:14, background:CARD,
        }}>
          {/* Customer logo — uses the uploaded logo URL if available, falls
              back to initials on the brand colour. Box is fixed-size so both
              states have the same footprint. */}
          {client?.logo_url ? (
            <div style={{
              width:44, height:44, borderRadius:8, background:'#fff',
              border:`0.5px solid ${BORDER}`,
              display:'flex', alignItems:'center', justifyContent:'center',
              flexShrink:0, overflow:'hidden', padding:4, boxSizing:'border-box',
            }}>
              <img src={client.logo_url} alt={`${client.name} logo`}
                style={{ maxWidth:'100%', maxHeight:'100%', objectFit:'contain' }}
              />
            </div>
          ) : (
            <div style={{
              width:44, height:44, borderRadius:8, background:client?.logo_color || '#1a4d8c',
              color:'white', display:'flex', alignItems:'center', justifyContent:'center',
              fontSize:15, fontWeight:500, flexShrink:0,
            }}>{client?.logo_initial || 'C'}</div>
          )}
          <div>
            <div style={{ fontSize:15, fontWeight:500, color:TEXT }}>{client?.name}</div>
            <div style={{ fontSize:11, color:MUTED }}>{client?.audience}</div>
          </div>
          <div style={{
            marginLeft:'auto', padding:'5px 10px', fontSize:11, color:MUTED,
            border:`0.5px solid ${BORDER}`, borderRadius:999,
          }}>{user.email || user.username}</div>
        </header>

        {/* First-login banner — shown until the user changes their password.
            Backend sets must_change_password=true when last_login_at is NULL.
            After they hit Change password in Settings, must_change_password
            stays true until /auth/check returns the latest user row (next
            render after the change-password call). */}
        {user.must_change_password && (
          <div style={{
            background:AMBER_BG, color:AMBER, fontSize:12, padding:'10px 22px',
            borderBottom:`0.5px solid ${BORDER}`, lineHeight:1.5,
          }}>
            <strong style={{ fontWeight:500 }}>Your password is temporary.</strong>
            {' '}Please <a onClick={() => setPage('settings')} style={{ color:AMBER, textDecoration:'underline', cursor:'pointer' }}>change it now</a> in Settings.
          </div>
        )}

        <div style={{ flex:1, overflow:'auto', padding:'20px 22px' }}>
          {page === 'posts' && (
            <ServiceGate state={svc.linkedin} serviceName="LinkedIn Posts">
              <PortalPosts />
            </ServiceGate>
          )}
          {page === 'inbox' && (
            <ServiceGate state={svc.email} serviceName="Inbox">
              <PortalInbox />
            </ServiceGate>
          )}
          {page === 'campaigns' && (
            <ServiceGate state={svc.email} serviceName="Campaigns">
              <PortalCampaigns />
            </ServiceGate>
          )}
          {page === 'facebook' && (
            <ServiceGate state={svc.facebook} serviceName="Facebook Posts">
              {/* Real <PortalFacebook /> component when the service ships. */}
              <div />
            </ServiceGate>
          )}
          {page === 'settings'  && <PortalSettings user={user} services={svc} />}
        </div>
      </main>
    </div>
  );
}

// ── SERVICE GATE ─────────────────────────────────────────────────────────────
// Wraps each service tab so customers who aren't subscribed see a calm
// "Not required" message instead of empty data. Three states from the
// services object on /api/portal/auth/check:
//   'enabled'      — render children (the real tab contents)
//   'not_required' — show "this service isn't part of your current plan"
//   'coming_soon'  — show "coming soon — we'll let you know when ready"
// New services get a dropdown in the admin customer-edit modal that flips
// between enabled and not_required for that customer.
function ServiceGate({ state, serviceName, children }) {
  if (state === 'enabled') return children;

  const isComingSoon = state === 'coming_soon';
  return (
    <div>
      <h2 style={pageTitle()}>{serviceName}</h2>
      <div style={{
        marginTop:18, padding:'40px 32px', background:CARD,
        borderRadius:8, border:`0.5px dashed ${BORDER}`,
        textAlign:'center',
      }}>
        <div style={{
          display:'inline-block', padding:'5px 11px', fontSize:11,
          background: isComingSoon ? BLUE_BG : '#f4f1e8',
          color:      isComingSoon ? BLUE    : MUTED,
          borderRadius:4, fontWeight:500, marginBottom:14,
        }}>{isComingSoon ? 'Coming soon' : 'Not required'}</div>
        <div style={{ fontSize:14, color:TEXT, marginBottom:8, fontWeight:500 }}>
          {isComingSoon
            ? `${serviceName} isn't live yet`
            : `${serviceName} isn't part of your current plan`}
        </div>
        <div style={{ fontSize:13, color:MUTED, lineHeight:1.5, maxWidth:440, margin:'0 auto' }}>
          {isComingSoon
            ? "We'll let you know as soon as it's ready. No action needed from you in the meantime."
            : <>Contact The Green Agents if you'd like to add this service to your account.</>}
        </div>
      </div>
    </div>
  );
}

// ── Sidebar primitives ──────────────────────────────────────────────────────
//
// Three-section layout (Social posts / Email / Account):
//   - NavSection  : section heading + the items beneath it
//   - NavItem     : single nav row, with active accent bar on the left edge
//                   matching the admin sidebar's visual language
//
// `dim` softens an item that's not subscribed (so Andrea sees Inbox/Campaigns
// in the sidebar even when her plan doesn't include email — but they read as
// secondary, with the gate panel explaining "Not required" when she clicks).
// `suffix` appends a small label like "Soon" for coming_soon services.
function NavSection({ heading, children }) {
  return (
    <div>
      <div style={{
        // Bolder section headings — more weight, brighter colour, slightly
        // larger so they read as proper structural labels rather than a hint.
        fontSize:11, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.1em',
        color:'rgba(255,255,255,0.85)', padding:'0 18px', marginBottom:8,
      }}>{heading}</div>
      <div style={{ display:'flex', flexDirection:'column' }}>{children}</div>
    </div>
  );
}

function NavItem({ label, active, onClick, dim, suffix }) {
  const [hover, setHover] = useState(false);
  return (
    <button onClick={onClick}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        display:'flex', alignItems:'center', gap:8,
        padding:'7px 18px',
        background: active ? 'rgba(255,255,255,0.1)' : (hover ? 'rgba(255,255,255,0.04)' : 'transparent'),
        // Left accent bar — matches the admin sidebar style. Always 2px so
        // hover/active don't change layout, just colour.
        borderLeft: active ? '2px solid #9FE1CB' : '2px solid transparent',
        borderTop:'none', borderRight:'none', borderBottom:'none',
        color: active ? '#fff' : (dim ? 'rgba(255,255,255,0.4)' : TGA_GREEN_LO),
        fontSize:12.5, textAlign:'left', cursor:'pointer', userSelect:'none',
        width:'100%',
      }}>
      <span style={{ flex:1 }}>{label}</span>
      {suffix && (
        <span style={{
          fontSize:9, fontWeight:500, padding:'1px 6px',
          background:'rgba(255,255,255,0.12)', color:'rgba(255,255,255,0.7)',
          borderRadius:3, letterSpacing:'0.04em', textTransform:'uppercase',
        }}>{suffix}</span>
      )}
    </button>
  );
}

// ── POSTS PAGE ───────────────────────────────────────────────────────────────
function PortalPosts() {
  // Loading lifecycle: null = not yet loaded, [] = loaded but empty, [...] = posts.
  const [posts, setPosts]               = useState(null);
  const [campaign, setCampaign]         = useState(null);
  const [notSubscribed, setNotSubscribed] = useState(false);
  const [loadError, setLoadError]       = useState(null);
  const [editing, setEditing]           = useState(null);
  const [regenConfirm, setRegenConfirm] = useState(null);

  // Initial load. The ServiceGate upstream usually filters out the
  // not_subscribed case before we even mount, but we still respond cleanly
  // here in case the gate is bypassed or the services state is stale.
  useEffect(() => {
    fetch('/api/portal/posts', { credentials:'include' })
      .then(r => r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`))
      .then(d => {
        setPosts(d.posts || []);
        setCampaign(d.campaign);
        setNotSubscribed(!!d.not_subscribed);
      })
      .catch(e => {
        setLoadError(String(e));
        setPosts([]);
      });
  }, []);

  // ─── Loading / empty / error states ───
  if (loadError) {
    return (
      <div>
        <h2 style={pageTitle()}>LinkedIn Posts</h2>
        <div style={{
          padding:'12px 16px', background:'#fbe9e9', color:DANGER,
          borderRadius:8, fontSize:13, marginTop:18,
        }}>Couldn't load posts: {loadError}</div>
      </div>
    );
  }
  if (posts === null) {
    return (
      <div>
        <h2 style={pageTitle()}>LinkedIn Posts</h2>
        <p style={pageSub()}>Loading your posts…</p>
      </div>
    );
  }
  if (posts.length === 0) {
    return (
      <div>
        <h2 style={pageTitle()}>LinkedIn Posts — review &amp; approve</h2>
        <div style={{
          marginTop:18, padding:'40px 32px', background:CARD,
          borderRadius:8, border:`0.5px dashed ${BORDER}`,
          textAlign:'center',
        }}>
          <div style={{ fontSize:14, color:TEXT, marginBottom:6, fontWeight:500 }}>
            Nothing to review right now
          </div>
          <div style={{ fontSize:13, color:MUTED, lineHeight:1.5, maxWidth:440, margin:'0 auto' }}>
            Your next batch will appear here when it's ready. We'll let you know.
          </div>
        </div>
      </div>
    );
  }

  // ─── Loaded — main review grid ───
  const approvedCount = posts.filter(p => p.approved).length;
  const allApproved   = approvedCount === posts.length;

  function approveOne(id) {
    setPosts(prev => prev.map(p => p.id === id ? { ...p, approved: true } : p));
    // TODO(backend chunk 3b): POST /api/portal/posts/:id/approve
  }
  function approveAllRemaining() {
    if (!confirm(`Approve all ${posts.length - approvedCount} remaining posts?`)) return;
    setPosts(prev => prev.map(p => ({ ...p, approved: true })));
    // TODO(backend chunk 3b): POST /api/portal/campaigns/:id/posts/approve-all
  }
  function saveEdit(id, newBody, newTitle) {
    setPosts(prev => prev.map(p => p.id === id ? { ...p, body: newBody, title: newTitle, approved: true } : p));
    setEditing(null);
    // TODO(backend chunk 3b): PUT /api/portal/posts/:id  body: { title, body }
  }
  function regenPost(id) {
    setPosts(prev => prev.map(p => p.id === id ? {
      ...p,
      title: 'Regenerating…',
      body:  '(new content will appear in a few seconds)',
      approved: false,
    } : p));
    setRegenConfirm(null);
    // TODO(backend chunk 3b): POST /api/portal/posts/:id/regenerate
  }

  return (
    <div>
      <h2 style={pageTitle()}>LinkedIn Posts — review &amp; approve</h2>
      <p style={pageSub()}>
        {posts.length} posts ready for your review. Edit text, regenerate any post, or approve.
        Order shown is the order they'll publish.
      </p>

      {/* Approval progress bar */}
      <div style={{
        display:'flex', alignItems:'center', gap:10, padding:'10px 14px',
        background: allApproved ? GREEN_BG : BLUE_BG,
        color:      allApproved ? GREEN    : BLUE,
        borderRadius:8, marginBottom:16, fontSize:12,
      }}>
        <strong style={{ fontWeight:500 }}>{approvedCount} of {posts.length} approved.</strong>
        {!allApproved && <span>Once all {posts.length} are approved, posts go live in this order.</span>}
        {allApproved  && <span>All posts approved — they'll go live in the scheduled order.</span>}
        {!allApproved && (
          <button onClick={approveAllRemaining} style={{
            marginLeft:'auto', padding:'6px 12px', background:TGA_GREEN_HI, color:'white',
            border:'none', borderRadius:6, fontSize:12, cursor:'pointer', fontWeight:500,
          }}>Approve all remaining</button>
        )}
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
        {posts.map(p => (
          <PostCard key={p.id} post={p} totalPosts={posts.length}
            onEdit={() => setEditing(p)}
            onRegen={() => setRegenConfirm(p)}
            onApprove={() => approveOne(p.id)}
          />
        ))}
      </div>

      {editing && (
        <EditPostModal
          post={editing}
          onClose={() => setEditing(null)}
          onSave={saveEdit}
        />
      )}

      {regenConfirm && (
        <Modal title="Regenerate this post?" onClose={() => setRegenConfirm(null)}>
          <p style={{ fontSize:13, color:TEXT, lineHeight:1.5, margin:'0 0 16px' }}>
            This discards the current text and image and generates fresh ones using AI. The post
            will need re-approval. This can't be undone.
          </p>
          <div style={{ display:'flex', justifyContent:'flex-end', gap:8 }}>
            <BtnSecondary onClick={() => setRegenConfirm(null)}>Cancel</BtnSecondary>
            <BtnPrimary onClick={() => regenPost(regenConfirm.id)}>Regenerate</BtnPrimary>
          </div>
        </Modal>
      )}
    </div>
  );
}

function PostCard({ post, totalPosts, onEdit, onRegen, onApprove }) {
  return (
    <div style={{
      background:CARD, borderRadius:8, border:`0.5px solid ${BORDER}`, overflow:'hidden',
    }}>
      {/* Post image — real image from the campaign's posts_json. Falls back
          to a neutral placeholder block when image_url is missing or generation
          failed (image_error). The 1.91:1 aspect ratio matches LinkedIn. */}
      <div style={{
        aspectRatio:'1.91/1', position:'relative',
        background: post.image_url ? '#f0f0ec' : '#2a4d2a',
        display:'flex', alignItems:'center', justifyContent:'center',
        overflow:'hidden',
      }}>
        {post.image_url ? (
          <img src={post.image_url} alt=""
            style={{ width:'100%', height:'100%', objectFit:'cover', display:'block' }}
          />
        ) : (
          <span style={{ color:'#d0e6f0', fontSize:11 }}>
            {post.image_error ? 'Image generation failed — regenerate to retry' : 'No image yet'}
          </span>
        )}
      </div>
      <div style={{ padding:'11px 12px' }}>
        <div style={{
          display:'flex', justifyContent:'space-between', alignItems:'center',
          marginBottom:4, fontSize:11, color:MUTED,
        }}>
          <span style={{
            padding:'1px 6px', background:BLUE_BG, color:BLUE,
            borderRadius:4, fontSize:10, fontWeight:500,
          }}>Post {post.order} of {totalPosts}</span>
          <span>{post.scheduled_for}</span>
        </div>
        <p style={{ fontSize:13, fontWeight:500, margin:'0 0 4px', lineHeight:1.3, color:TEXT }}>{post.title}</p>
        <p style={{
          fontSize:11, color:MUTED, lineHeight:1.4, margin:'0 0 10px',
          display:'-webkit-box', WebkitLineClamp:2, WebkitBoxOrient:'vertical', overflow:'hidden',
        }}>{(post.body || '').split('\n')[0]}</p>
        <div style={{ display:'flex', gap:5 }}>
          <button onClick={onEdit} style={cardBtn()}>Edit</button>
          <button onClick={onRegen} style={cardBtn(DANGER)}>Regen</button>
          {post.approved
            ? <button disabled style={{ ...cardBtn(), background:TGA_GREEN_HI, color:'white', borderColor:TGA_GREEN_HI, cursor:'default' }}>✓ Approved</button>
            : <button onClick={onApprove} style={cardBtn()}>Approve</button>
          }
        </div>
      </div>
    </div>
  );
}

function cardBtn(color) {
  return {
    flex:1, padding:5, fontSize:11, border:`0.5px solid ${BORDER}`,
    background:'transparent', color: color || TEXT, borderRadius:5, cursor:'pointer',
  };
}

// ── EDIT MODAL ───────────────────────────────────────────────────────────────
function EditPostModal({ post, onClose, onSave }) {
  const [title, setTitle] = useState(post.title);
  const [body, setBody]   = useState(post.body);

  return (
    <Modal title="Edit post" onClose={onClose} wide>
      <div style={{ display:'grid', gridTemplateColumns:'180px 1fr', gap:18 }}>
        <div>
          <div style={{ fontSize:11, color:MUTED, marginBottom:6 }}>Image (read-only)</div>
          <div style={{
            aspectRatio:'1.91/1', borderRadius:6, overflow:'hidden',
            background: post.image_url ? '#f0f0ec' : '#2a4d2a',
            display:'flex', alignItems:'center', justifyContent:'center',
            color:'#d0e6f0', fontSize:11,
          }}>
            {post.image_url
              ? <img src={post.image_url} alt=""
                  style={{ width:'100%', height:'100%', objectFit:'cover', display:'block' }} />
              : 'No image'
            }
          </div>
          <div style={{ fontSize:11, color:TERTIARY_TEXT, marginTop:8, lineHeight:1.4 }}>
            Want a new image? Cancel and click <strong style={{ color:TEXT }}>Regen</strong> on the
            post — that regenerates both text and image.
          </div>
        </div>
        <div>
          <div style={{ fontSize:11, color:MUTED, marginBottom:4 }}>Title</div>
          <input value={title} onChange={e => setTitle(e.target.value)} autoFocus
            style={{ ...loginInputStyle(), marginBottom:14 }}
          />
          <div style={{ fontSize:11, color:MUTED, marginBottom:4 }}>Body</div>
          <textarea value={body} onChange={e => setBody(e.target.value)}
            style={{
              ...loginInputStyle(),
              fontFamily:'inherit', minHeight:240, resize:'vertical', lineHeight:1.5,
            }}
          />
          <div style={{ fontSize:11, color:TERTIARY_TEXT, marginTop:6 }}>
            Saving marks this post approved. To go back to draft, click <strong style={{ color:TEXT }}>Regen</strong> instead.
          </div>
        </div>
      </div>
      <div style={{ display:'flex', justifyContent:'flex-end', gap:8, marginTop:18 }}>
        <BtnSecondary onClick={onClose}>Cancel</BtnSecondary>
        <BtnPrimary onClick={() => onSave(post.id, body, title)}>Save &amp; approve</BtnPrimary>
      </div>
    </Modal>
  );
}

// ── INBOX PAGE ───────────────────────────────────────────────────────────────
function PortalInbox() {
  const stats = aggregateStats(mockCampaigns);
  const [openReply, setOpenReply] = useState(null);
  const [composing, setComposing] = useState(null);  // reply object being replied to

  return (
    <div>
      <h2 style={pageTitle()}>Email campaigns</h2>
      <p style={pageSub()}>Across all campaigns sent for your account.</p>

      {/* Stats */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:10, marginBottom:16 }}>
        <StatCard label="Sent"    value={stats.sent.toLocaleString()} />
        <StatCard label="Opens"   value={stats.opens}   sub={`${stats.openRate}% across ${stats.trackable.toLocaleString()} trackable`} />
        <StatCard label="Clicks"  value={stats.clicks}  sub={`${stats.clickRate}% across ${stats.trackable.toLocaleString()} trackable`} />
        <StatCard label="Replies" value={stats.replies} sub={`${mockReplies.filter(r => r.classification==='positive').length} marked positive`} />
      </div>

      {/* Trackability note */}
      {stats.untracked > 0 && (
        <div style={{
          padding:'10px 12px', background:BLUE_BG, color:BLUE,
          borderRadius:8, fontSize:12, marginBottom:16, lineHeight:1.5,
        }}>
          <strong style={{ fontWeight:500 }}>{stats.untracked.toLocaleString()} sends had tracking disabled to maximise inbox deliverability.</strong>
          {' '}Open and click rates above are calculated from the {stats.trackable.toLocaleString()} trackable sends.
        </div>
      )}

      {/* Replies table */}
      <div style={{
        background:CARD, borderRadius:8, border:`0.5px solid ${BORDER}`, overflow:'hidden',
      }}>
        <div style={{
          fontSize:11, color:MUTED, textTransform:'uppercase', letterSpacing:'0.06em',
          padding:'14px 14px 8px', borderBottom:`0.5px solid ${BORDER}`,
        }}>Recent replies — click to read &amp; reply</div>
        {mockReplies.map(r => (
          <ReplyRow key={r.id} reply={r} onClick={() => setOpenReply(r)} />
        ))}
      </div>

      {openReply && !composing && (
        <ReplyDetailModal reply={openReply}
          onClose={() => setOpenReply(null)}
          onCompose={() => setComposing(openReply)}
        />
      )}
      {composing && (
        <ComposeReplyModal reply={composing}
          onClose={() => setComposing(null)}
          onSend={(payload) => {
            alert(`(Demo) Send: ${payload.body.slice(0,60)}...\nCC: ${payload.cc || '(none)'}`);
            setComposing(null);
            setOpenReply(null);
          }}
        />
      )}
    </div>
  );
}

function StatCard({ label, value, sub }) {
  return (
    <div style={{ padding:'12px 14px', background:'#f1efe8', borderRadius:8 }}>
      <p style={{ fontSize:11, color:MUTED, textTransform:'uppercase', letterSpacing:'0.04em', margin:'0 0 4px' }}>{label}</p>
      <p style={{ fontSize:20, fontWeight:500, margin:0, color:TEXT }}>{value}</p>
      {sub && <p style={{ fontSize:11, color:MUTED, margin:'2px 0 0' }}>{sub}</p>}
    </div>
  );
}

function ReplyRow({ reply, onClick }) {
  const [hover, setHover] = useState(false);
  return (
    <div onClick={onClick}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        display:'grid', gridTemplateColumns:'220px 1fr 90px 90px',
        gap:10, alignItems:'center', padding:'10px 14px',
        borderBottom:`0.5px solid ${BORDER}`, fontSize:12, cursor:'pointer',
        background: hover ? '#fafaf8' : 'transparent',
      }}
    >
      <div style={{ fontWeight:500, color:TEXT, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
        {reply.from_name}
        <div style={{ fontWeight:400, color:TERTIARY_TEXT, fontSize:11 }}>{reply.from_addr}</div>
      </div>
      <div style={{ color:MUTED, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
        <div style={{ color:TEXT, marginBottom:2 }}>{reply.subject}</div>
        <div>{reply.snippet}</div>
      </div>
      <ClassifyBadge reply={reply} />
      <div style={{ color:TERTIARY_TEXT, fontSize:11, textAlign:'right' }}>{relTime(reply.received_at)}</div>
    </div>
  );
}

function ClassifyBadge({ reply }) {
  if (reply.auto_unsubscribed) return <span style={{ ...badgeStyle(), background:AMBER_BG, color:AMBER }}>Unsub'd</span>;
  if (reply.classification === 'positive') return <span style={{ ...badgeStyle(), background:GREEN_BG, color:GREEN }}>Prospect</span>;
  if (reply.classification === 'auto_reply') return <span style={{ ...badgeStyle(), background:'#f4f1e8', color:MUTED }}>OOO</span>;
  return <span style={{ ...badgeStyle(), background:'#f4f1e8', color:MUTED }}>Neutral</span>;
}

function badgeStyle() {
  return {
    fontSize:10, padding:'2px 7px', borderRadius:4, textAlign:'center',
    fontWeight:500, display:'inline-block',
  };
}

// ── REPLY DETAIL MODAL ───────────────────────────────────────────────────────
function ReplyDetailModal({ reply, onClose, onCompose }) {
  return (
    <Modal title="Reply" onClose={onClose} wide>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline', marginBottom:14 }}>
        <div>
          <div style={{ fontSize:14, fontWeight:500, color:TEXT }}>{reply.from_name}</div>
          <div style={{ fontSize:12, color:MUTED }}>{reply.from_addr}</div>
        </div>
        <ClassifyBadge reply={reply} />
      </div>
      <div style={{ fontSize:13, color:TEXT, marginBottom:6 }}>{reply.subject}</div>
      <div style={{ fontSize:11, color:MUTED, marginBottom:14 }}>
        Received {relTime(reply.received_at)}
        {reply.campaign_title && <> · in reply to <em>{reply.campaign_title}</em>{reply.step_number ? ` (step ${reply.step_number})` : ''}</>}
      </div>
      <div style={{
        padding:14, background:'#fafaf8', borderRadius:6, fontSize:13,
        color:TEXT, lineHeight:1.6, marginBottom:18, whiteSpace:'pre-wrap',
      }}>{reply.snippet}{'\n\n— End of message —'}</div>
      <div style={{ display:'flex', justifyContent:'flex-end', gap:8 }}>
        <BtnSecondary onClick={onClose}>Close</BtnSecondary>
        <BtnPrimary onClick={onCompose}>Reply</BtnPrimary>
      </div>
    </Modal>
  );
}

// ── COMPOSE REPLY ────────────────────────────────────────────────────────────
function ComposeReplyModal({ reply, onClose, onSend }) {
  const [cc, setCc]     = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);

  function send() {
    if (!body.trim()) return;
    setBusy(true);
    // TODO(backend): POST /api/portal/replies/:id/send  body: { cc, body }
    //   - server uses SES with proper In-Reply-To / References headers
    //   - server stores the sent reply in email_sends or a new email_outbound table
    //   - on success returns { ok: true }
    setTimeout(() => onSend({ cc: cc.trim(), body }), 400);
  }

  return (
    <Modal title={`Reply to ${reply.from_name}`} onClose={() => !busy && onClose()} wide>
      <div style={{ fontSize:11, color:MUTED, marginBottom:10 }}>
        To: <strong style={{ color:TEXT, fontWeight:500 }}>{reply.from_addr}</strong> ·
        {' '}Subject: <strong style={{ color:TEXT, fontWeight:500 }}>Re: {reply.subject}</strong>
      </div>

      <Field label="CC (optional)">
        <input type="text" value={cc} onChange={e => setCc(e.target.value)}
          placeholder="someone@yourcompany.co.uk"
          disabled={busy}
          style={loginInputStyle()}
        />
      </Field>

      <Field label="Your reply">
        <textarea value={body} onChange={e => setBody(e.target.value)}
          autoFocus disabled={busy}
          placeholder="Type your reply…"
          style={{
            ...loginInputStyle(),
            fontFamily:'inherit', minHeight:200, resize:'vertical', lineHeight:1.5,
          }}
        />
      </Field>

      <div style={{ display:'flex', justifyContent:'flex-end', gap:8, marginTop:14 }}>
        <BtnSecondary onClick={onClose} disabled={busy}>Cancel</BtnSecondary>
        <BtnPrimary onClick={send} disabled={busy || !body.trim()}>{busy ? 'Sending…' : 'Send reply'}</BtnPrimary>
      </div>
    </Modal>
  );
}

// ── CAMPAIGNS PAGE (read-only) ───────────────────────────────────────────────
function PortalCampaigns() {
  const stats = aggregateStats(mockCampaigns);

  return (
    <div>
      <h2 style={pageTitle()}>Campaigns</h2>
      <p style={pageSub()}>Read-only view of every email campaign we've run for your account.</p>

      {/* Aggregate strip — same numbers as Inbox dashboard, shown here for context */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:10, marginBottom:16 }}>
        <StatCard label="Total campaigns"  value={mockCampaigns.length} />
        <StatCard label="Total sent"       value={stats.sent.toLocaleString()} />
        <StatCard label="Replies received" value={stats.replies} />
        <StatCard label="Currently sending" value={mockCampaigns.filter(c => c.status === 'sending').length} />
      </div>

      <div style={{
        background:CARD, borderRadius:8, border:`0.5px solid ${BORDER}`, overflow:'hidden',
      }}>
        <div style={{
          display:'grid', gridTemplateColumns:'2fr 100px 80px 80px 80px 80px 100px',
          gap:10, alignItems:'center', padding:'10px 14px',
          borderBottom:`0.5px solid ${BORDER}`,
          fontSize:11, color:MUTED, textTransform:'uppercase', letterSpacing:'0.04em',
        }}>
          <div>Campaign</div>
          <div>Status</div>
          <div style={{ textAlign:'right' }}>Sent</div>
          <div style={{ textAlign:'right' }}>Opens</div>
          <div style={{ textAlign:'right' }}>Clicks</div>
          <div style={{ textAlign:'right' }}>Replies</div>
          <div style={{ textAlign:'right' }}>Started</div>
        </div>
        {mockCampaigns.map(c => (
          <div key={c.id} style={{
            display:'grid', gridTemplateColumns:'2fr 100px 80px 80px 80px 80px 100px',
            gap:10, alignItems:'center', padding:'10px 14px',
            borderBottom:`0.5px solid ${BORDER}`, fontSize:12, color:TEXT,
          }}>
            <div style={{ fontWeight:500 }}>{c.title}</div>
            <div>
              <span style={{
                ...badgeStyle(),
                background: c.status === 'sending' ? BLUE_BG : '#f4f1e8',
                color:      c.status === 'sending' ? BLUE : MUTED,
              }}>{c.status === 'sending' ? 'Sending' : 'Sent'}</span>
            </div>
            <div style={{ textAlign:'right' }}>{c.sent.toLocaleString()}</div>
            <div style={{ textAlign:'right', color: c.tracking_off ? TERTIARY_TEXT : TEXT }}>
              {c.tracking_off ? '—' : c.opens}
            </div>
            <div style={{ textAlign:'right', color: c.tracking_off ? TERTIARY_TEXT : TEXT }}>
              {c.tracking_off ? '—' : c.clicks}
            </div>
            <div style={{ textAlign:'right', color: c.replies > 0 ? GREEN : TEXT, fontWeight: c.replies > 0 ? 500 : 400 }}>
              {c.replies}
            </div>
            <div style={{ textAlign:'right', color:MUTED, fontSize:11 }}>
              {new Date(c.started_at).toLocaleDateString('en-GB', { day:'numeric', month:'short' })}
            </div>
          </div>
        ))}
      </div>

      {mockCampaigns.some(c => c.tracking_off) && (
        <div style={{
          marginTop:12, padding:'10px 12px', background:BLUE_BG, color:BLUE,
          borderRadius:8, fontSize:12, lineHeight:1.5,
        }}>
          <strong style={{ fontWeight:500 }}>—</strong>{' '}
          means open/click tracking was disabled for that campaign to maximise inbox deliverability.
          Reply numbers are still accurate for those campaigns.
        </div>
      )}
    </div>
  );
}

// ── SETTINGS PAGE ────────────────────────────────────────────────────────────
function PortalSettings({ user, services }) {
  const [pw1, setPw1]       = useState('');
  const [pw2, setPw2]       = useState('');
  const [pwOld, setPwOld]   = useState('');
  const [savingPw, setSavingPw] = useState(false);
  const [pwMsg, setPwMsg]   = useState(null);

  async function changePassword() {
    if (!pwOld || !pw1 || !pw2) { setPwMsg({ ok:false, text:'All fields required' }); return; }
    if (pw1 !== pw2) { setPwMsg({ ok:false, text:'New passwords don\'t match' }); return; }
    if (pw1.length < 8) { setPwMsg({ ok:false, text:'Password must be at least 8 characters' }); return; }
    setSavingPw(true); setPwMsg(null);
    try {
      const r = await fetch('/api/portal/auth/change-password', {
        method:'POST',
        credentials:'include',
        headers:{ 'Content-Type':'application/json' },
        body: JSON.stringify({ old: pwOld, new: pw1 }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) {
        setPwMsg({ ok:false, text: d.error || 'Could not update password' });
        setSavingPw(false);
        return;
      }
      setSavingPw(false);
      setPwOld(''); setPw1(''); setPw2('');
      setPwMsg({ ok:true, text:'Password updated. Other sessions have been signed out.' });
    } catch {
      setSavingPw(false);
      setPwMsg({ ok:false, text:'Network error — try again.' });
    }
  }

  return (
    <div>
      <h2 style={pageTitle()}>Settings</h2>
      <p style={pageSub()}>Manage your account and your organisation's users.</p>

      <SettingsCard title="Change password">
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
          <Field label="Current password">
            <input type="password" value={pwOld} onChange={e => setPwOld(e.target.value)} disabled={savingPw} style={loginInputStyle()} />
          </Field>
          <div />
          <Field label="New password">
            <input type="password" value={pw1} onChange={e => setPw1(e.target.value)} disabled={savingPw} style={loginInputStyle()} />
          </Field>
          <Field label="Confirm new password">
            <input type="password" value={pw2} onChange={e => setPw2(e.target.value)} disabled={savingPw} style={loginInputStyle()} />
          </Field>
        </div>
        {pwMsg && (
          <div style={{ fontSize:12, color: pwMsg.ok ? GREEN : DANGER, marginBottom:10 }}>{pwMsg.text}</div>
        )}
        <BtnPrimary onClick={changePassword} disabled={savingPw}>{savingPw ? 'Saving…' : 'Update password'}</BtnPrimary>
      </SettingsCard>

      {user.role === 'admin' && (
        <SettingsCard title="Organisation users">
          <p style={{ fontSize:12, color:MUTED, margin:'0 0 12px' }}>
            People at your company who can sign in to this portal. Only admins can add or remove users.
          </p>
          <div style={{ border:`0.5px solid ${BORDER}`, borderRadius:6, overflow:'hidden' }}>
            {/* Until the data routes ship (next chunk), we just show the
                signed-in user themselves. Once GET /api/portal/users is wired
                up this becomes a real list with Add / Remove controls. */}
            <UserRow username={user.username} email={user.email || ''} role={user.role} isYou />
          </div>
          <div style={{ marginTop:12, fontSize:11, color:TERTIARY_TEXT }}>
            Adding more users from this portal is coming soon. In the meantime, contact The Green Agents to add a teammate.
          </div>
        </SettingsCard>
      )}

      <SettingsCard title="Branding">
        <p style={{ fontSize:12, color:MUTED, margin:'0 0 12px' }}>
          Your logo and audience profile are managed by The Green Agents. Contact us if you need them updated.
        </p>
        <div style={{ display:'flex', alignItems:'center', gap:14, padding:'10px 12px', border:`0.5px solid ${BORDER}`, borderRadius:6 }}>
          <div style={{
            width:48, height:48, borderRadius:8, background:'#1a4d8c', color:'white',
            display:'flex', alignItems:'center', justifyContent:'center', fontSize:16, fontWeight:500,
          }}>TL</div>
          <div>
            <div style={{ fontSize:13, fontWeight:500, color:TEXT }}>Tower Leasing</div>
            <div style={{ fontSize:11, color:MUTED }}>Asset finance · authority brand</div>
          </div>
        </div>
      </SettingsCard>
    </div>
  );
}

function SettingsCard({ title, children }) {
  return (
    <div style={{
      background:CARD, borderRadius:8, border:`0.5px solid ${BORDER}`,
      padding:'16px 18px', marginBottom:12,
    }}>
      <div style={{ fontSize:13, fontWeight:500, color:TEXT, marginBottom:12 }}>{title}</div>
      {children}
    </div>
  );
}

function UserRow({ username, email, role, isYou }) {
  return (
    <div style={{
      display:'grid', gridTemplateColumns:'1fr 1fr 80px 80px',
      gap:10, alignItems:'center', padding:'10px 12px',
      borderBottom:`0.5px solid ${BORDER}`, fontSize:12,
    }}>
      <div>
        <span style={{ color:TEXT, fontWeight:500 }}>{username}</span>
        {isYou && <span style={{ color:TERTIARY_TEXT, fontSize:11, marginLeft:6 }}>(you)</span>}
      </div>
      <div style={{ color:MUTED }}>{email}</div>
      <div>
        <span style={{
          ...badgeStyle(),
          background: role === 'admin' ? BLUE_BG : '#f4f1e8',
          color:      role === 'admin' ? BLUE : MUTED,
        }}>{role}</span>
      </div>
      <div style={{ textAlign:'right' }}>
        {!isYou && (
          <a onClick={() => alert('(Demo) Remove user flow.')} style={{ color:DANGER, fontSize:11, cursor:'pointer' }}>Remove</a>
        )}
      </div>
    </div>
  );
}

// ── SHARED PRIMITIVES ────────────────────────────────────────────────────────
function pageTitle() { return { fontSize:18, fontWeight:500, margin:'0 0 4px', color:TEXT }; }
function pageSub()   { return { fontSize:12, color:MUTED, margin:'0 0 16px' }; }

function Modal({ title, onClose, children, wide }) {
  return (
    <div onClick={onClose} style={{
      position:'fixed', inset:0, background:'rgba(0,0,0,0.45)',
      display:'flex', alignItems:'center', justifyContent:'center',
      zIndex:50, padding:20,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background:CARD, borderRadius:12, padding:'22px 26px',
        maxWidth: wide ? 720 : 460, width:'100%',
        maxHeight:'90vh', overflow:'auto',
      }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:14 }}>
          <h3 style={{ fontSize:15, fontWeight:500, margin:0, color:TEXT }}>{title}</h3>
          <button onClick={onClose} style={{
            background:'transparent', border:'none', fontSize:20, color:MUTED,
            cursor:'pointer', lineHeight:1, padding:0,
          }}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function BtnPrimary({ children, onClick, disabled }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      padding:'8px 14px', fontSize:13, fontWeight:500,
      background: disabled ? TGA_GREEN_LO : TGA_GREEN_HI,
      color:'white', border:'none', borderRadius:6,
      cursor: disabled ? 'default' : 'pointer',
    }}>{children}</button>
  );
}
function BtnSecondary({ children, onClick, disabled }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      padding:'8px 14px', fontSize:13,
      background:CARD, color:TEXT, border:`0.5px solid ${BORDER}`, borderRadius:6,
      cursor: disabled ? 'default' : 'pointer',
    }}>{children}</button>
  );
}

function relTime(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day:'numeric', month:'short' });
}
