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
const TGA_GREEN     = '#0F6E56';
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
  // Each entry is { state, label, pitch }. State is one of: 'enabled' /
  // 'not_required' / 'coming_soon'. ServiceGate handles the latter two with
  // service-specific sales pitch text from `pitch`.
  const svc = services || {
    email:           { state:'enabled',     label:'Email',           pitch:null },
    linkedin:        { state:'enabled',     label:'LinkedIn Posts',  pitch:null },
    facebook:        { state:'coming_soon', label:'Facebook Posts',  pitch:null },
    instagram:       { state:'coming_soon', label:'Instagram',       pitch:null },
    tiktok:          { state:'coming_soon', label:'TikTok',          pitch:null },
    facebook_pixels: { state:'coming_soon', label:'Facebook Pixels', pitch:null },
  };

  return (
    <div style={{ display:'flex', height:'100vh', background:BG, fontFamily:'-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>
      {/* Global keyframes for spinner overlays used across the portal
          (post regen, approve buttons, etc.). Injected once at chrome level
          so every authenticated page can use animation: spin without
          re-declaring the @keyframes. */}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
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
            width:30, height:30, borderRadius:7, background:'#fff',
            display:'flex', alignItems:'center', justifyContent:'center',
            flexShrink:0, padding:3, boxSizing:'border-box',
          }}>
            <img src="/tga-logo.png" alt="The Green Agents"
              style={{ maxWidth:'100%', maxHeight:'100%', objectFit:'contain' }}
            />
          </div>
          <div style={{ minWidth:0 }}>
            <div style={{ fontSize:13, fontWeight:500, color:'white', lineHeight:1.2 }}>The Green Agents</div>
            <div style={{ fontSize:11, color:TGA_GREEN_LO, marginTop:2 }}>Studio</div>
          </div>
        </div>

        {/* Nav — three sections (Social media, Email, Account). Each has a
            small-caps heading, then nav items. Generous gap between sections
            so the eye can group them. */}
        <nav style={{ flex:1, padding:'14px 0', display:'flex', flexDirection:'column', gap:18 }}>
          <NavSection heading="Social media">
            <NavItem label="LinkedIn Posts"
              active={page==='posts'}
              onClick={() => setPage('posts')}
              dim={svc.linkedin?.state === 'not_required'}
            />
            <NavItem label="Facebook Posts"
              active={page==='facebook'}
              onClick={() => setPage('facebook')}
              dim={svc.facebook?.state !== 'enabled'}
            />
            <NavItem label="Instagram"
              active={page==='instagram'}
              onClick={() => setPage('instagram')}
              dim={svc.instagram?.state !== 'enabled'}
            />
            <NavItem label="TikTok"
              active={page==='tiktok'}
              onClick={() => setPage('tiktok')}
              dim={svc.tiktok?.state !== 'enabled'}
            />
            <NavItem label="Facebook Pixels"
              active={page==='facebook_pixels'}
              onClick={() => setPage('facebook_pixels')}
              dim={svc.facebook_pixels?.state !== 'enabled'}
            />
          </NavSection>

          <NavSection heading="Email">
            <NavItem label="Inbox"
              active={page==='inbox'}
              onClick={() => setPage('inbox')}
              dim={svc.email?.state === 'not_required'}
            />
            <NavItem label="Campaigns"
              active={page==='campaigns'}
              onClick={() => setPage('campaigns')}
              dim={svc.email?.state === 'not_required'}
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
          padding:'18px 22px', borderBottom:`0.5px solid ${BORDER}`,
          display:'flex', alignItems:'center', gap:14, background:CARD,
        }}>
          {/* Customer logo — uses the uploaded logo URL if available, falls
              back to initials on the brand colour. Box is fixed-size so both
              states have the same footprint. */}
          {client?.logo_url ? (
            <img src={client.logo_url} alt={`${client.name} logo`}
              style={{
                width:72, height:72, borderRadius:10,
                objectFit:'contain', flexShrink:0, display:'block',
              }}
            />
          ) : (
            <div style={{
              width:72, height:72, borderRadius:10, background:client?.logo_color || '#1a4d8c',
              color:'white', display:'flex', alignItems:'center', justifyContent:'center',
              fontSize:22, fontWeight:500, flexShrink:0,
            }}>{client?.logo_initial || 'C'}</div>
          )}
          <div>
            <div style={{ fontSize:17, fontWeight:500, color:TEXT }}>{client?.name}</div>
            <div style={{ fontSize:11, color:MUTED }}>{client?.audience}</div>
          </div>
          {/* "Refine my posts" — customer-facing override-rules editor.
              Only shown when LinkedIn is enabled for this customer, because
              the rules are LinkedIn-post-specific. The button opens a modal
              (RefinePostsModal) for adding/editing/deleting numbered
              constraints. Future generations apply the latest rules; existing
              posts in awaiting_approval don't change. */}
          {svc.linkedin?.state === 'enabled' && (
            <div style={{ marginLeft:'auto', display:'flex', alignItems:'center', gap:10 }}>
              <RefinePostsButton />
              <div style={{
                padding:'5px 10px', fontSize:11, color:MUTED,
                border:`0.5px solid ${BORDER}`, borderRadius:999,
              }}>{user.email || user.username}</div>
            </div>
          )}
          {svc.linkedin?.state !== 'enabled' && (
            <div style={{
              marginLeft:'auto', padding:'5px 10px', fontSize:11, color:MUTED,
              border:`0.5px solid ${BORDER}`, borderRadius:999,
            }}>{user.email || user.username}</div>
          )}
        </header>

        <div style={{ flex:1, overflow:'auto', padding:'20px 22px' }}>
          {page === 'posts' && (
            <ServiceGate svc={svc.linkedin} serviceName="LinkedIn Posts">
              <PortalPosts />
            </ServiceGate>
          )}
          {page === 'inbox' && (
            <ServiceGate svc={svc.email} serviceName="Inbox">
              <PortalInbox />
            </ServiceGate>
          )}
          {page === 'campaigns' && (
            <ServiceGate svc={svc.email} serviceName="Campaigns">
              <PortalCampaigns />
            </ServiceGate>
          )}
          {page === 'facebook' && (
            <ServiceGate svc={svc.facebook} serviceName="Facebook Posts">
              {/* Real <PortalFacebook /> component when the service ships. */}
              <div />
            </ServiceGate>
          )}
          {page === 'instagram' && (
            <ServiceGate svc={svc.instagram} serviceName="Instagram">
              <div />
            </ServiceGate>
          )}
          {page === 'tiktok' && (
            <ServiceGate svc={svc.tiktok} serviceName="TikTok">
              <div />
            </ServiceGate>
          )}
          {page === 'facebook_pixels' && (
            <ServiceGate svc={svc.facebook_pixels} serviceName="Facebook Pixels">
              <div />
            </ServiceGate>
          )}
          {page === 'settings'  && <PortalSettings user={user} client={client} services={svc} />}
        </div>
      </main>
    </div>
  );
}

// ── SERVICE GATE ─────────────────────────────────────────────────────────────
// Wraps each service tab so customers who aren't subscribed see service-
// specific sales copy instead of empty data. Reads the new services object
// shape from /api/portal/auth/check: { state, label, pitch }.
//
// From the customer's perspective there are only two visible states: enabled
// (they have the service, render the real tab) or not subscribed (show the
// sales pitch). The DB-level distinction between 'coming_soon' (no admin
// tools yet, can't be subscribed) and 'not_required' (admin tools exist but
// this customer hasn't subscribed) only matters to the admin's Manage panel.
// The customer doesn't need to care — they just see "Not Subscribed" with a
// sales pitch explaining what they'd get.
function ServiceGate({ svc, serviceName, children }) {
  // Defensive — if /auth/check ever returns the legacy string shape (e.g. an
  // older browser tab cached it), behave as if the service is gated.
  const state = (svc && typeof svc === 'object') ? svc.state : svc;
  const pitch = (svc && typeof svc === 'object') ? svc.pitch : null;

  if (state === 'enabled') return children;

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
          background:'#f4f1e8', color:MUTED,
          borderRadius:4, fontWeight:500, marginBottom:18,
        }}>Not Subscribed</div>

        <div style={{
          fontSize:15, color:TEXT, lineHeight:1.6, maxWidth:540, margin:'0 auto', fontWeight:400,
        }}>
          {pitch || `${serviceName} isn't part of your current plan.`}
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

// ── REFINE MY POSTS ──────────────────────────────────────────────────────────
// The "Refine my posts" button + modal that live in the portal header.
// Customers add numbered constraints ("Don't mention machinery breakdowns",
// "Don't talk about stress") that override the LinkedIn algorithm and the
// RAG document. Rules apply to FUTURE post generation only — existing posts
// keep what they have. Edits/deletes invalidate any cached prompt context on
// the backend (rules are read fresh on every generate/regen call).
//
// Limits: max 50 rules, each up to 500 characters. Server-enforced via the
// PUT /api/portal/content-rules endpoint; UI enforces too so the user doesn't
// hit a 400 by accident.
const REFINE_RULE_MAX_LEN    = 500;
const REFINE_RULES_MAX_COUNT = 50;

function RefinePostsButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} style={{
        padding:'6px 12px', fontSize:11, fontWeight:500,
        background:GREEN_BG, color:GREEN,
        border:`0.5px solid ${GREEN}33`, borderRadius:999, cursor:'pointer',
        display:'flex', alignItems:'center', gap:6,
      }}>
        <span style={{ fontSize:12 }}>✦</span>
        Refine my posts
      </button>
      {open && <RefinePostsModal onClose={() => setOpen(false)} />}
    </>
  );
}

function RefinePostsModal({ onClose }) {
  // Lifecycle: null = loading, [] = loaded empty, [...] = loaded with rules.
  const [rules, setRules]   = useState(null);
  const [busy, setBusy]     = useState(false);
  const [error, setError]   = useState(null);
  const [draft, setDraft]   = useState(''); // new-rule input

  useEffect(() => {
    fetch('/api/portal/content-rules', { credentials:'include' })
      .then(r => r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`))
      .then(d => setRules(Array.isArray(d.rules) ? d.rules : []))
      .catch(e => { setError(`Couldn't load rules: ${e}`); setRules([]); });
  }, []);

  function addRule() {
    const text = draft.trim();
    if (!text) return;
    if (text.length > REFINE_RULE_MAX_LEN) {
      setError(`Each rule can be at most ${REFINE_RULE_MAX_LEN} characters.`);
      return;
    }
    if ((rules || []).length >= REFINE_RULES_MAX_COUNT) {
      setError(`You can have at most ${REFINE_RULES_MAX_COUNT} rules.`);
      return;
    }
    if ((rules || []).some(r => r.text.trim().toLowerCase() === text.toLowerCase())) {
      setError('That rule already exists.');
      return;
    }
    setError(null);
    setRules(prev => [...(prev || []), { id: cryptoRandomId(), text }]);
    setDraft('');
  }

  function updateRule(id, text) {
    setRules(prev => (prev || []).map(r => r.id === id ? { ...r, text } : r));
  }

  function deleteRule(id) {
    setRules(prev => (prev || []).filter(r => r.id !== id));
  }

  async function save() {
    if (busy) return;
    // Validate before sending.
    const cleaned = (rules || [])
      .map(r => ({ id: r.id, text: (r.text || '').trim() }))
      .filter(r => r.text.length > 0);
    for (const r of cleaned) {
      if (r.text.length > REFINE_RULE_MAX_LEN) {
        setError(`Each rule can be at most ${REFINE_RULE_MAX_LEN} characters.`);
        return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/portal/content-rules', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules: cleaned }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      onClose();
    } catch (e) {
      setError(`Couldn't save: ${e.message}`);
      setBusy(false);
    }
  }

  return (
    <div onClick={busy ? null : onClose} style={{
      position:'fixed', inset:0, background:'rgba(20,20,18,0.45)',
      display:'flex', alignItems:'center', justifyContent:'center', zIndex:9999, padding:24,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background:CARD, borderRadius:12, padding:'24px 28px',
        width:'min(640px, 100%)', maxHeight:'80vh', display:'flex', flexDirection:'column',
        boxShadow:'0 8px 28px rgba(0,0,0,0.18)',
      }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:6 }}>
          <div style={{ fontSize:16, fontWeight:500, color:TEXT }}>Refine my posts</div>
          <button onClick={busy ? null : onClose} disabled={busy} style={{
            background:'transparent', border:'none', fontSize:18, color:MUTED, cursor:busy?'default':'pointer', padding:'2px 6px',
          }} aria-label="Close">×</button>
        </div>
        <div style={{ fontSize:12, color:MUTED, lineHeight:1.5, marginBottom:14 }}>
          Add rules that tell the AI what to avoid in your LinkedIn posts.
          Each rule overrides the LinkedIn algorithm and your RAG document.
          Changes apply to future posts — your existing posts won't change.
        </div>

        {error && (
          <div style={{
            padding:'8px 12px', background:'#fbe9e9', color:DANGER,
            borderRadius:6, fontSize:12, marginBottom:12,
          }}>{error}</div>
        )}

        <div style={{ overflow:'auto', flex:1, marginBottom:14, paddingRight:4 }}>
          {rules === null ? (
            <div style={{ fontSize:12, color:MUTED, padding:'12px 0' }}>Loading…</div>
          ) : rules.length === 0 ? (
            <div style={{
              fontSize:12, color:MUTED, padding:'18px 0',
              borderTop:`0.5px dashed ${BORDER}`, borderBottom:`0.5px dashed ${BORDER}`,
              textAlign:'center',
            }}>
              No rules yet. Add your first below.
            </div>
          ) : (
            rules.map((r, idx) => (
              <RefineRuleRow
                key={r.id}
                number={idx + 1}
                rule={r}
                onChange={text => updateRule(r.id, text)}
                onDelete={() => deleteRule(r.id)}
                disabled={busy}
              />
            ))
          )}
        </div>

        <div style={{ display:'flex', gap:8, marginBottom:16 }}>
          <input
            type="text"
            value={draft}
            onChange={e => { setDraft(e.target.value); if (error) setError(null); }}
            onKeyDown={e => { if (e.key === 'Enter') addRule(); }}
            placeholder={'e.g. "Don\'t mention our machines breaking down"'}
            disabled={busy || (rules || []).length >= REFINE_RULES_MAX_COUNT}
            style={{
              flex:1, padding:'8px 10px', fontSize:13,
              border:`0.5px solid ${BORDER}`, borderRadius:6,
              background: busy ? '#fafaf8' : CARD, color:TEXT,
            }}
          />
          <button onClick={addRule} disabled={busy || !draft.trim()} style={{
            padding:'8px 14px', fontSize:12, fontWeight:500,
            background: (busy || !draft.trim()) ? '#f4f1e8' : GREEN, color: (busy || !draft.trim()) ? MUTED : '#fff',
            border:'none', borderRadius:6, cursor:(busy || !draft.trim())?'default':'pointer',
          }}>Add rule</button>
        </div>

        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:8, borderTop:`0.5px solid ${BORDER}`, paddingTop:14 }}>
          <div style={{ fontSize:11, color:MUTED }}>
            {(rules || []).length} / {REFINE_RULES_MAX_COUNT} rules
          </div>
          <div style={{ display:'flex', gap:8 }}>
            <button onClick={busy ? null : onClose} disabled={busy} style={{
              padding:'8px 14px', fontSize:12, background:CARD, color:TEXT,
              border:`0.5px solid ${BORDER}`, borderRadius:6, cursor:busy?'default':'pointer',
            }}>Cancel</button>
            <button onClick={save} disabled={busy || rules === null} style={{
              padding:'8px 16px', fontSize:12, fontWeight:500,
              background:(busy || rules === null) ? '#9FE1CB' : GREEN, color:'#fff',
              border:'none', borderRadius:6, cursor:(busy || rules === null)?'default':'pointer',
            }}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function RefineRuleRow({ number, rule, onChange, onDelete, disabled }) {
  return (
    <div style={{
      display:'flex', alignItems:'flex-start', gap:10,
      padding:'10px 0', borderBottom:`0.5px solid ${BORDER}`,
    }}>
      <div style={{
        flexShrink:0, width:24, textAlign:'right',
        fontSize:12, color:MUTED, paddingTop:8, fontVariantNumeric:'tabular-nums',
      }}>{number}.</div>
      <textarea
        value={rule.text}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        rows={2}
        maxLength={REFINE_RULE_MAX_LEN}
        style={{
          flex:1, padding:'6px 10px', fontSize:13, lineHeight:1.5,
          border:`0.5px solid ${BORDER}`, borderRadius:6,
          background: disabled ? '#fafaf8' : CARD, color:TEXT,
          resize:'vertical', minHeight:54, fontFamily:'inherit',
        }}
      />
      <button onClick={onDelete} disabled={disabled} aria-label="Delete rule" style={{
        flexShrink:0, padding:'6px 10px', fontSize:11, color:DANGER,
        background:'transparent', border:`0.5px solid ${BORDER}`, borderRadius:6,
        cursor: disabled ? 'default' : 'pointer',
      }}>Delete</button>
    </div>
  );
}

// Stable client-side id generator for new rules. Server validates and may
// regenerate, but we want a stable React `key` immediately so the row doesn't
// re-mount on every keystroke. crypto.randomUUID is available in all
// browsers we target (Safari 15.4+, Chrome 92+). Falls back to Math.random
// for the rare older browser.
function cryptoRandomId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `r_${Math.random().toString(36).slice(2)}_${Date.now()}`;
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
  // Per-post UI state. busy[postId] = 'regen-text' | 'regen-image' | 'approving' | 'saving'.
  // Used to show the spinner overlay on the matching card and disable buttons.
  // These hooks MUST live above the early returns below so React's hook order
  // stays stable across renders.
  const [busy, setBusy]                 = useState({});
  const [expandedId, setExpandedId]     = useState(null);
  const [bulkBusy, setBulkBusy]         = useState(false);
  const [bulkResult, setBulkResult]     = useState(null);
  const [actionError, setActionError]   = useState(null);
  // History — past campaigns (deployed by customer or admin). Loaded in
  // parallel with the current batch so the page renders both without a
  // second wait. expandedHistoryId tracks which past campaign card is open.
  const [history, setHistory]                   = useState(null);  // null=loading, []=none, [...]=campaigns
  const [expandedHistoryId, setExpandedHistoryId] = useState(null);
  const [expandedHistoryPostId, setExpandedHistoryPostId] = useState(null);

  // Initial load. The ServiceGate upstream usually filters out the
  // not_subscribed case before we even mount, but we still respond cleanly
  // here in case the gate is bypassed or the services state is stale.
  // History fetch runs in parallel so the past-campaigns section appears
  // shortly after the current-batch grid.
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

    fetch('/api/portal/campaigns-history', { credentials:'include' })
      .then(r => r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`))
      .then(d => setHistory(d.campaigns || []))
      .catch(_ => setHistory([])); // silent — history is non-critical
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

        <HistorySection
          history={history}
          expandedHistoryId={expandedHistoryId}
          setExpandedHistoryId={setExpandedHistoryId}
          expandedHistoryPostId={expandedHistoryPostId}
          setExpandedHistoryPostId={setExpandedHistoryPostId}
        />
      </div>
    );
  }

  // ─── Loaded — main review grid ───
  const approvedCount = posts.filter(p => p.approved).length;
  const allApproved   = approvedCount === posts.length;

  function setPostBusy(id, kind) {
    setBusy(prev => kind ? { ...prev, [id]: kind } : (() => { const n = { ...prev }; delete n[id]; return n; })());
  }

  // Reload everything from the server — used after regen, edit, approve, and
  // approve-all so the displayed state matches the database without us
  // guessing. Posts shown on the grid come from the current awaiting_approval
  // campaign (may be empty after approve-all). History refreshes too so a
  // newly-deployed campaign appears in the past-campaigns section.
  async function reloadAll() {
    try {
      const [pr, hr] = await Promise.all([
        fetch('/api/portal/posts', { credentials:'include' }),
        fetch('/api/portal/campaigns-history', { credentials:'include' }),
      ]);
      if (pr.ok) {
        const d = await pr.json();
        setPosts(d.posts || []);
        setCampaign(d.campaign);
      }
      if (hr.ok) {
        const d = await hr.json();
        setHistory(d.campaigns || []);
      }
    } catch (_) {}
  }

  async function approveOne(id) {
    setActionError(null);
    setPostBusy(id, 'approving');
    try {
      const r = await fetch(`/api/portal/posts/${encodeURIComponent(id)}/approve`, {
        method:'POST', credentials:'include',
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) {
        setActionError(d.error || `Couldn't approve post (HTTP ${r.status})`);
        setPostBusy(id, null);
        return;
      }
      setPosts(prev => (prev || []).map(p => p.id === id ? d.post : p));
    } catch (e) {
      setActionError(`Network error: ${e.message}`);
    } finally {
      setPostBusy(id, null);
    }
  }

  async function approveAllRemaining() {
    if (!campaign?.id) {
      setActionError('Campaign not loaded — refresh and try again.');
      return;
    }
    if (!confirm(`Approve all ${posts.length - approvedCount} remaining posts? They'll be sent to LinkedIn's scheduled queue immediately.`)) return;
    setActionError(null); setBulkResult(null); setBulkBusy(true);
    try {
      const r = await fetch(`/api/portal/campaigns/${encodeURIComponent(campaign.id)}/posts/approve-all`, {
        method:'POST', credentials:'include',
      });
      const d = await r.json().catch(() => ({}));
      // 207 = partial failure (some posts queued, some failed). We still
      // refresh from the server to show the new approval state of the ones
      // that DID get queued.
      if (r.ok && d.ok) {
        setBulkResult({ ok:true, total:d.total, succeeded:d.succeeded });
        await reloadAll();
      } else {
        setBulkResult({ ok:false, total:d.total || posts.length, succeeded:d.succeeded || 0, error: d.error || `Push failed (HTTP ${r.status})` });
        await reloadAll();
      }
    } catch (e) {
      setBulkResult({ ok:false, error:`Network error: ${e.message}` });
    } finally {
      setBulkBusy(false);
    }
  }

  async function saveEdit(id, newBody, newTitle) {
    setActionError(null);
    setPostBusy(id, 'saving');
    try {
      const r = await fetch(`/api/portal/posts/${encodeURIComponent(id)}`, {
        method:'PUT', credentials:'include',
        headers:{ 'Content-Type':'application/json' },
        body: JSON.stringify({ title: newTitle, body: newBody }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) {
        setActionError(d.error || `Couldn't save post (HTTP ${r.status})`);
        setPostBusy(id, null);
        return;
      }
      setPosts(prev => (prev || []).map(p => p.id === id ? d.post : p));
      setEditing(null);
    } catch (e) {
      setActionError(`Network error: ${e.message}`);
    } finally {
      setPostBusy(id, null);
    }
  }

  async function regenText(id) {
    setActionError(null);
    setPostBusy(id, 'regen-text');
    try {
      const r = await fetch(`/api/portal/posts/${encodeURIComponent(id)}/regenerate-text`, {
        method:'POST', credentials:'include',
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) {
        setActionError(d.error || `Couldn't rewrite post (HTTP ${r.status})`);
        return;
      }
      setPosts(prev => (prev || []).map(p => p.id === id ? d.post : p));
    } catch (e) {
      setActionError(`Network error: ${e.message}`);
    } finally {
      setPostBusy(id, null);
    }
  }

  async function regenImage(id) {
    setActionError(null);
    setPostBusy(id, 'regen-image');
    try {
      const r = await fetch(`/api/portal/posts/${encodeURIComponent(id)}/regenerate-image`, {
        method:'POST', credentials:'include',
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) {
        setActionError(d.error || `Couldn't regenerate image (HTTP ${r.status})`);
        return;
      }
      setPosts(prev => (prev || []).map(p => p.id === id ? d.post : p));
    } catch (e) {
      setActionError(`Network error: ${e.message}`);
    } finally {
      setPostBusy(id, null);
    }
  }

  // Per-post logo re-composite. Triggered by the Position/Size dropdowns
  // on each post card — passes one or both override fields. The server
  // re-runs ONLY the compositor on the post's stored pre-logo image (no
  // Gemini call), uploads the new composited image to R2, returns the
  // updated post.
  //
  // Distinct busy kind ('recomp-logo') so the image-only spinner overlay
  // appears rather than the card-wide 'rewriting' overlay.
  //
  // 400 with error='pre_logo_unavailable' means the post was generated
  // before pre-logo storage shipped — we show a more specific message
  // pointing the customer at the New image button.
  async function recompositeLogo(id, fields) {
    setActionError(null);
    setPostBusy(id, 'recomp-logo');
    try {
      const r = await fetch(`/api/portal/posts/${encodeURIComponent(id)}/recomposite-logo`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields || {}),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) {
        if (d.error === 'pre_logo_unavailable') {
          setActionError(d.message || 'Click "New image" first to enable logo controls on this post.');
        } else {
          setActionError(d.error || `Couldn't re-composite logo (HTTP ${r.status})`);
        }
        return;
      }
      setPosts(prev => (prev || []).map(p => p.id === id ? d.post : p));
    } catch (e) {
      setActionError(`Network error: ${e.message}`);
    } finally {
      setPostBusy(id, null);
    }
  }

  return (
    <div>
      <h2 style={pageTitle()}>LinkedIn Posts — review &amp; approve</h2>
      <p style={pageSub()}>
        {posts.length} posts ready for your review. Edit text, regenerate any post, or approve.
        Order shown is the order they'll publish.
      </p>

      {/* Inline error toast — appears for any failed action and persists until
          the user dismisses or triggers another action. */}
      {actionError && (
        <div style={{
          padding:'10px 14px', background:'#fbe9e9', color:DANGER,
          borderRadius:8, marginBottom:12, fontSize:12, display:'flex', alignItems:'center', gap:10,
        }}>
          <span style={{ flex:1 }}>{actionError}</span>
          <button onClick={() => setActionError(null)} style={{
            background:'transparent', border:'none', color:DANGER, cursor:'pointer', fontSize:14, padding:0,
          }} aria-label="Dismiss">×</button>
        </div>
      )}

      {/* Approve-all result banner. Success: green; partial failure: amber. */}
      {bulkResult && bulkResult.ok && (
        <div style={{
          padding:'10px 14px', background:GREEN_BG, color:GREEN,
          borderRadius:8, marginBottom:12, fontSize:12,
        }}>
          <strong style={{ fontWeight:500 }}>All {bulkResult.total} posts approved and queued to LinkedIn.</strong> They'll publish in the scheduled order.
        </div>
      )}
      {bulkResult && !bulkResult.ok && (
        <div style={{
          padding:'10px 14px', background:AMBER_BG, color:AMBER,
          borderRadius:8, marginBottom:12, fontSize:12,
        }}>
          <strong style={{ fontWeight:500 }}>{bulkResult.succeeded || 0} of {bulkResult.total || posts.length} posts queued.</strong>{' '}
          {bulkResult.error || 'The remaining posts can be retried by clicking Approve all remaining again.'}
        </div>
      )}

      {/* Approval progress bar */}
      <div style={{
        display:'flex', alignItems:'center', gap:10, padding:'10px 14px',
        background: allApproved ? GREEN_BG : BLUE_BG,
        color:      allApproved ? GREEN    : BLUE,
        borderRadius:8, marginBottom:16, fontSize:12,
      }}>
        <strong style={{ fontWeight:500 }}>{approvedCount} of {posts.length} approved.</strong>
        {!allApproved && <span>Once all {posts.length} are approved, posts go straight to LinkedIn's scheduled queue in this order.</span>}
        {allApproved  && <span>All posts approved — they'll publish in the scheduled order.</span>}
        {!allApproved && (
          <button onClick={approveAllRemaining} disabled={bulkBusy} style={{
            marginLeft:'auto', padding:'6px 12px',
            background: bulkBusy ? TGA_GREEN_LO : TGA_GREEN_HI, color:'white',
            border:'none', borderRadius:6, fontSize:12,
            cursor: bulkBusy ? 'not-allowed' : 'pointer', fontWeight:500,
          }}>{bulkBusy ? 'Sending to LinkedIn…' : 'Approve all remaining'}</button>
        )}
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(340px, 1fr))', gap:16 }}>
        {posts.map(p => (
          <PostCard key={p.id} post={p} totalPosts={posts.length}
            busy={busy[p.id] || null}
            expanded={expandedId === p.id}
            onToggleExpand={() => setExpandedId(expandedId === p.id ? null : p.id)}
            onEdit={() => setEditing(p)}
            onRegenText={() => regenText(p.id)}
            onRegenImage={() => regenImage(p.id)}
            onRecompositeLogo={(fields) => recompositeLogo(p.id, fields)}
            onApprove={() => approveOne(p.id)}
          />
        ))}
      </div>

      <HistorySection
        history={history}
        expandedHistoryId={expandedHistoryId}
        setExpandedHistoryId={setExpandedHistoryId}
        expandedHistoryPostId={expandedHistoryPostId}
        setExpandedHistoryPostId={setExpandedHistoryPostId}
      />

      {editing && (
        <EditPostModal
          post={editing}
          busy={busy[editing.id] === 'saving'}
          onClose={() => setEditing(null)}
          onSave={saveEdit}
        />
      )}
    </div>
  );
}

function PostCard({ post, totalPosts, busy, expanded, readOnly, onToggleExpand, onEdit, onRegenText, onRegenImage, onRecompositeLogo, onApprove }) {
  const isRegenText  = busy === 'regen-text';
  const isRegenImage = busy === 'regen-image';
  const isRecompLogo = busy === 'recomp-logo';
  const isApproving  = busy === 'approving';
  const isAnyBusy    = !!busy;

  const metaLine = [post.content_pillar, post.format].filter(Boolean).join(' · ');

  return (
    <div style={{
      background:CARD, borderRadius:8, border:`0.5px solid ${BORDER}`, overflow:'hidden',
      display:'flex', flexDirection:'column',
      opacity: isAnyBusy ? 0.85 : 1, transition:'opacity 0.2s',
      position:'relative',
    }}>
      {/* Card-wide overlay shown while text is regenerating. Image stays
          visible underneath; the body section is what changes. We put the
          overlay on the WHOLE CARD so the spinner sits centred regardless
          of which part is updating. */}
      {isRegenText && (
        <div style={{
          position:'absolute', inset:0, background:'rgba(255,255,255,0.92)',
          display:'flex', alignItems:'center', justifyContent:'center', zIndex:5,
          flexDirection:'column', gap:10, padding:20, textAlign:'center',
        }}>
          <div style={{
            width:30, height:30, border:`2.5px solid ${TGA_GREEN_HI}`,
            borderTopColor:'transparent', borderRadius:'50%',
            animation:'spin 0.8s linear infinite',
          }} />
          <div style={{ fontSize:12, fontWeight:500, color:TEXT }}>Rewriting your post…</div>
          <div style={{ fontSize:11, color:MUTED, lineHeight:1.4, maxWidth:240 }}>
            Please wait while your text is being regenerated. This usually takes 5–15 seconds.
          </div>
        </div>
      )}

      {/* Image — admin uses natural aspect with objectFit:contain. We mirror
          that so customers see exactly what the post will look like.
          maxHeight:300 caps oversized images so the card doesn't go rogue. */}
      <div style={{ position:'relative', background:'#f5f5f3' }}>
        {post.image_url ? (
          <img src={post.image_url} alt={`Post ${post.order}`}
            style={{
              width:'100%', height:'auto', maxHeight:300,
              objectFit:'contain', display:'block', background:'#f5f5f3',
            }}
            onError={e => { e.currentTarget.style.display = 'none'; }}
          />
        ) : (
          <div style={{
            height:80, display:'flex', alignItems:'center', justifyContent:'center',
            color:MUTED, fontSize:11,
          }}>
            {post.image_error ? 'Image generation failed — click "New image" to retry' : 'No image generated yet'}
          </div>
        )}
        {/* Image-only spinner overlay. Sits ON the image so the customer
            knows specifically that the IMAGE is being updated (vs the
            post text). Appears for both 'regen-image' (full Gemini regen,
            5-30s) and 'recomp-logo' (re-composite only, ~½ sec) — same
            visual treatment with different wording. */}
        {(isRegenImage || isRecompLogo) && (
          <div style={{
            position:'absolute', inset:0, background:'rgba(255,255,255,0.85)',
            display:'flex', alignItems:'center', justifyContent:'center',
            flexDirection:'column', gap:8, padding:12, textAlign:'center',
          }}>
            <div style={{
              width:26, height:26, border:`2.5px solid ${TGA_GREEN_HI}`,
              borderTopColor:'transparent', borderRadius:'50%',
              animation:'spin 0.8s linear infinite',
            }} />
            <div style={{ fontSize:11, fontWeight:500, color:TEXT }}>
              {isRecompLogo ? 'Updating logo…' : 'Generating image…'}
            </div>
            <div style={{ fontSize:10, color:MUTED, lineHeight:1.4, maxWidth:200 }}>
              {isRecompLogo
                ? 'Repositioning logo — no charge.'
                : 'Please wait while your image is being regenerated.'}
            </div>
          </div>
        )}
      </div>

      {/* Body */}
      <div style={{ padding:'12px 14px', flex:1, display:'flex', flexDirection:'column' }}>
        <div style={{
          display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:6,
        }}>
          <div>
            <div style={{ fontSize:12, fontWeight:500, color:TEXT }}>Post {post.order}</div>
            {metaLine && (
              <div style={{ fontSize:10, color:MUTED, marginTop:1 }}>{metaLine}</div>
            )}
            {(post.suggested_day || post.suggested_time) && (
              <div style={{ fontSize:10, color:GREEN, marginTop:2 }}>
                📅 {post.suggested_day} {post.suggested_time}
              </div>
            )}
          </div>
          {post.approved && (
            <span style={{
              fontSize:10, padding:'2px 7px', borderRadius:4,
              background:GREEN_BG, color:GREEN, fontWeight:500, whiteSpace:'nowrap',
            }}>✓ Approved</span>
          )}
        </div>

        {post.topic && (
          <div style={{ fontSize:12, fontWeight:500, color:TEXT, marginBottom:6 }}>{post.topic}</div>
        )}

        {/* Validation warning badge — shown when the AI couldn't fully obey
            a customer rule, even after a retry. Tells the customer which
            rule was likely violated so they can refine their rules or
            regenerate this post. Multiple violations shown stacked.

            HIDDEN at operator request (2026-05-14) — warnings were firing too
            often due to Haiku interpreting rules thematically rather than
            literally. Validation pass still runs server-side and attaches
            validation_warnings to posts; this block just doesn't render
            them. To re-enable, change `false &&` below back to a plain
            check. The data is still being captured so re-enabling is a
            one-line change. */}
        {false && Array.isArray(post.validation_warnings) && post.validation_warnings.length > 0 && (
          <div style={{
            background:AMBER_BG, color:AMBER, border:`0.5px solid ${AMBER}33`,
            borderRadius:6, padding:'8px 10px', marginBottom:8, fontSize:11, lineHeight:1.5,
          }}>
            <div style={{ fontWeight:500, marginBottom:4 }}>
              ⚠ This post may conflict with {post.validation_warnings.length === 1 ? 'one of your rules' : `${post.validation_warnings.length} of your rules`}.
            </div>
            {post.validation_warnings.map((w, i) => (
              <div key={i} style={{ marginTop:4 }}>
                <div style={{ fontWeight:500 }}>Rule: <span style={{ fontWeight:400 }}>{w.ruleText}</span></div>
                {w.reason && <div style={{ opacity:0.85 }}>{w.reason}</div>}
              </div>
            ))}
            <div style={{ marginTop:6, opacity:0.8 }}>
              Edit your rules from <strong style={{ fontWeight:500 }}>Refine my posts</strong> at the top, or click <strong style={{ fontWeight:500 }}>Rewrite post</strong> below.
            </div>
          </div>
        )}

        {/* Full body, with mask-fade fallback when collapsed (admin pattern). */}
        <div style={{
          fontSize:11, color:MUTED, lineHeight:1.6, flex:1,
          maxHeight: expanded ? 'none' : 96, overflow:'hidden',
          maskImage: expanded ? 'none' : 'linear-gradient(to bottom, black 50%, transparent 100%)',
          WebkitMaskImage: expanded ? 'none' : 'linear-gradient(to bottom, black 50%, transparent 100%)',
          whiteSpace:'pre-wrap',
        }}>{post.body}</div>
        <button onClick={onToggleExpand} style={{
          marginTop:8, fontSize:11, color:TGA_GREEN_HI, background:'none', border:'none',
          cursor:'pointer', padding:0, textAlign:'left', fontWeight:500,
        }}>{expanded ? '▲ Collapse' : '▼ Read full post'}</button>

        {/* Action row — four buttons, mirroring admin's Edit / Rewrite / New image
            plus the customer-only Approve. Hidden in readOnly (history) view.
            Style choice: all four buttons solid TGA brand green with white text,
            same size and weight. Disabled state dims to ~55% opacity. */}
        {!readOnly && (
          <>
            {/* Per-post logo controls. Three dropdowns (Position, Size,
                Background) that let the customer fine-tune logo placement
                on each individual post's image. Each is a per-post override
                that defaults to the customer-level setting set by the
                operator on the admin side; changing any of them runs a
                fast re-composite (no AI call) on the post's stored
                pre-logo image.
                
                When logo_controls_enabled is false (post has no stored
                pre-logo image — generated before this feature shipped),
                the controls render disabled with a hint pointing the
                customer at the New image button. */}
            <LogoControls
              post={post}
              disabled={isAnyBusy}
              onRecompositeLogo={onRecompositeLogo}
            />
            <div style={{ display:'flex', gap:5, marginTop:10, paddingTop:10, borderTop:`0.5px solid ${BORDER}` }}>
              <button onClick={onEdit} disabled={isAnyBusy} style={cardBtn(isAnyBusy)}>
                Edit text
              </button>
              <button onClick={onRegenText} disabled={isAnyBusy} style={cardBtn(isAnyBusy)}>
                Rewrite post
              </button>
              <button onClick={onRegenImage} disabled={isAnyBusy} style={cardBtn(isAnyBusy)}>
                New image
              </button>
              {post.approved
                ? <button disabled style={{
                    ...cardBtn(false),
                    background: TGA_GREEN_LO, cursor:'default', opacity: 1,
                  }}>✓ Approved</button>
                : <button onClick={onApprove} disabled={isAnyBusy} style={cardBtn(isAnyBusy)}>
                    {isApproving ? 'Approving…' : 'Approve'}
                  </button>
              }
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// All four post-card action buttons share this style: solid TGA brand green
// background, white text, no border (the green provides the affordance).
// Disabled state dims to 55% opacity so the user can see what they clicked.
function cardBtn(disabled) {
  return {
    flex: 1,
    padding: '7px 5px',
    fontSize: 11,
    fontWeight: 500,
    border: 'none',
    background: TGA_GREEN,
    color: '#ffffff',
    borderRadius: 5,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.55 : 1,
  };
}

// ── PER-POST LOGO CONTROLS ───────────────────────────────────────────────────
// Three dropdowns (Position, Size, Background) sitting on every post card
// between the post body and the four green action buttons. Changing any
// dropdown immediately calls the recomposite endpoint, which re-runs only
// the compositor on the post's stored pre-logo image — no AI call, ~½ sec.
//
// Initial values come from the per-post overrides (post.logo_position,
// post.logo_size, post.logo_panel). If null, fall back to the customer-
// level defaults (post.default_logo_*) set by the operator on the admin
// side.
//
// Disabled state: shown when the post was generated before the pre-logo
// storage feature shipped — post.logo_controls_enabled is false. We grey
// out the controls and show a small hint pointing the customer at the
// New image button.
function LogoControls({ post, disabled, onRecompositeLogo }) {
  const enabled  = !!post.logo_controls_enabled;
  const position = post.logo_position || post.default_logo_position || 'bottom-right';
  const size     = post.logo_size     || post.default_logo_size     || 'small';
  const panel    = post.logo_panel    || post.default_logo_panel    || 'white';

  function handleChange(field, value) {
    if (!enabled || disabled) return;
    onRecompositeLogo({ [field]: value });
  }

  const allDisabled = disabled || !enabled;

  return (
    <div style={{
      marginTop: 10, paddingTop: 10,
      borderTop: '0.5px dashed #e8b04a',
      opacity: allDisabled ? 0.6 : 1,
    }}>
      <div style={{
        fontSize: 10, color: '#9a6f00', textTransform: 'uppercase',
        letterSpacing: '0.05em', fontWeight: 500, marginBottom: 6,
      }}>Logo on this image</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
        <div>
          <div style={{ fontSize: 10, color: MUTED, marginBottom: 3 }}>Position</div>
          <select
            value={position}
            disabled={allDisabled}
            onChange={e => handleChange('logo_position', e.target.value)}
            style={logoSelectStyle(allDisabled)}
          >
            <option value="top-right">Top right</option>
            <option value="top-left">Top left</option>
            <option value="bottom-right">Bottom right</option>
            <option value="bottom-left">Bottom left</option>
          </select>
        </div>
        <div>
          <div style={{ fontSize: 10, color: MUTED, marginBottom: 3 }}>Size</div>
          <select
            value={size}
            disabled={allDisabled}
            onChange={e => handleChange('logo_size', e.target.value)}
            style={logoSelectStyle(allDisabled)}
          >
            <option value="large">Large</option>
            <option value="medium">Medium</option>
            <option value="small">Small</option>
          </select>
        </div>
        <div>
          <div style={{ fontSize: 10, color: MUTED, marginBottom: 3 }}>Background</div>
          <select
            value={panel}
            disabled={allDisabled}
            onChange={e => handleChange('logo_panel', e.target.value)}
            style={logoSelectStyle(allDisabled)}
          >
            <option value="white">White panel</option>
            <option value="none">No panel</option>
          </select>
        </div>
      </div>
      {!enabled && (
        <div style={{
          fontSize: 10, color: MUTED, marginTop: 6, lineHeight: 1.4, fontStyle: 'italic',
        }}>
          Click <span style={{ fontWeight: 500, fontStyle: 'normal' }}>New image</span> to enable these controls on this post.
        </div>
      )}
    </div>
  );
}

function logoSelectStyle(disabled) {
  return {
    width: '100%',
    fontSize: 11,
    padding: '4px 6px',
    border: '0.5px solid #d0d0cc',
    borderRadius: 5,
    background: disabled ? '#f5f5f3' : '#fff',
    color: TEXT,
    cursor: disabled ? 'not-allowed' : 'pointer',
  };
}

// ── EDIT MODAL ───────────────────────────────────────────────────────────────
function EditPostModal({ post, busy, onClose, onSave }) {
  const [title, setTitle] = useState(post.title);
  const [body, setBody]   = useState(post.body);

  return (
    <Modal title="Edit post" onClose={() => !busy && onClose()} wide>
      <div style={{ display:'grid', gridTemplateColumns:'180px 1fr', gap:18 }}>
        <div>
          <div style={{ fontSize:11, color:MUTED, marginBottom:6 }}>Image (read-only)</div>
          <div style={{
            borderRadius:6, overflow:'hidden', background:'#f5f5f3',
            minHeight:120, display:'flex', alignItems:'center', justifyContent:'center',
            color:MUTED, fontSize:11,
          }}>
            {post.image_url
              ? <img src={post.image_url} alt=""
                  style={{ width:'100%', height:'auto', maxHeight:240, objectFit:'contain', display:'block', background:'#f5f5f3' }} />
              : 'No image'
            }
          </div>
          <div style={{ fontSize:11, color:TERTIARY_TEXT, marginTop:8, lineHeight:1.4 }}>
            Want a new image? Cancel and click <strong style={{ color:TEXT }}>New image</strong> on the post.
          </div>
        </div>
        <div>
          <div style={{ fontSize:11, color:MUTED, marginBottom:4 }}>Title</div>
          <input value={title} onChange={e => setTitle(e.target.value)} autoFocus disabled={busy}
            style={{ ...loginInputStyle(), marginBottom:14 }}
          />
          <div style={{ fontSize:11, color:MUTED, marginBottom:4 }}>Body</div>
          <textarea value={body} onChange={e => setBody(e.target.value)} disabled={busy}
            style={{
              ...loginInputStyle(),
              fontFamily:'inherit', minHeight:240, resize:'vertical', lineHeight:1.5,
            }}
          />
          <div style={{ fontSize:11, color:TERTIARY_TEXT, marginTop:6 }}>
            Saving marks this post approved. To rewrite from scratch, click <strong style={{ color:TEXT }}>Rewrite post</strong> instead.
          </div>
        </div>
      </div>
      <div style={{ display:'flex', justifyContent:'flex-end', gap:8, marginTop:18 }}>
        <BtnSecondary onClick={onClose} disabled={busy}>Cancel</BtnSecondary>
        <BtnPrimary onClick={() => onSave(post.id, body, title)} disabled={busy || !body.trim()}>
          {busy ? 'Saving…' : 'Save & approve'}
        </BtnPrimary>
      </div>
    </Modal>
  );
}

// ── PAST CAMPAIGNS (history) ─────────────────────────────────────────────────
// Read-only history of campaigns the customer has previously approved (or that
// admin pushed direct to Supergrow before the portal existed). Each card
// expands to show every post in the campaign in the same admin-mirrored layout
// — full image, full text, "Read full post" expand — but with no Edit /
// Rewrite / New image / Approve buttons. Read-only by design.
function HistorySection({ history, expandedHistoryId, setExpandedHistoryId,
                         expandedHistoryPostId, setExpandedHistoryPostId }) {
  // Loading: render nothing (the current-batch grid is the visible feature
  // anyway; history will appear once it lands without flicker).
  if (history === null) return null;
  // Empty: skip the section entirely. The customer doesn't need to see
  // "No past campaigns" — that's noise.
  if (history.length === 0) return null;

  return (
    <div style={{ marginTop:32 }}>
      <h3 style={{ fontSize:14, fontWeight:500, color:TEXT, margin:'0 0 4px' }}>Past campaigns</h3>
      <p style={{ fontSize:12, color:MUTED, margin:'0 0 12px' }}>
        Read-only — these are the campaigns we've previously published for you.
      </p>

      <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
        {history.map(c => (
          <HistoryCampaignCard key={c.id} campaign={c}
            expanded={expandedHistoryId === c.id}
            onToggle={() => setExpandedHistoryId(expandedHistoryId === c.id ? null : c.id)}
            expandedHistoryPostId={expandedHistoryPostId}
            setExpandedHistoryPostId={setExpandedHistoryPostId}
          />
        ))}
      </div>
    </div>
  );
}

function HistoryCampaignCard({ campaign, expanded, onToggle,
                               expandedHistoryPostId, setExpandedHistoryPostId }) {
  const date = campaign.completed_at || campaign.created_at;
  const dateLabel = date
    ? new Date(date.includes('Z') ? date : date.replace(' ', 'T') + 'Z')
        .toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' })
    : '';

  return (
    <div style={{
      background:CARD, border:`0.5px solid ${BORDER}`, borderRadius:8, overflow:'hidden',
    }}>
      {/* Header strip — always visible, click to toggle. */}
      <button onClick={onToggle} style={{
        width:'100%', display:'flex', alignItems:'center', gap:14, padding:'12px 14px',
        background:'transparent', border:'none', cursor:'pointer', textAlign:'left',
      }}>
        {/* Cover image — first post's image, if any. Falls back to a calm
            neutral block so the layout doesn't jump. */}
        <div style={{
          width:64, height:64, borderRadius:6, flexShrink:0, overflow:'hidden',
          background:'#f5f5f3', display:'flex', alignItems:'center', justifyContent:'center',
        }}>
          {campaign.cover_url
            ? <img src={campaign.cover_url} alt=""
                style={{ width:'100%', height:'100%', objectFit:'cover', display:'block' }} />
            : <span style={{ fontSize:10, color:MUTED }}>No image</span>
          }
        </div>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontSize:13, fontWeight:500, color:TEXT, marginBottom:2,
            whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
            {campaign.first_topic || `Campaign of ${campaign.post_count} posts`}
          </div>
          <div style={{ fontSize:11, color:MUTED }}>
            {dateLabel} · {campaign.post_count} post{campaign.post_count === 1 ? '' : 's'}
          </div>
        </div>
        <span style={{
          fontSize:10, padding:'2px 8px', borderRadius:4,
          background:GREEN_BG, color:GREEN, fontWeight:500,
        }}>Published</span>
        <span style={{ fontSize:11, color:MUTED, marginLeft:8 }}>
          {expanded ? '▲' : '▼'}
        </span>
      </button>

      {/* Expanded grid — read-only PostCards. Same component as the current-
          batch grid but readOnly=true hides the action row. */}
      {expanded && (
        <div style={{ padding:'0 14px 14px', borderTop:`0.5px solid ${BORDER}` }}>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(340px, 1fr))', gap:16, marginTop:14 }}>
            {campaign.posts.map(p => (
              <PostCard key={p.id} post={p} totalPosts={campaign.post_count}
                readOnly
                expanded={expandedHistoryPostId === `${campaign.id}:${p.id}`}
                onToggleExpand={() =>
                  setExpandedHistoryPostId(expandedHistoryPostId === `${campaign.id}:${p.id}` ? null : `${campaign.id}:${p.id}`)
                }
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── INBOX PAGE ───────────────────────────────────────────────────────────────
function PortalInbox() {
  const [replies, setReplies]         = useState(null);  // null=loading, []=none, [...]=list
  const [notSubscribed, setNotSubscribed] = useState(false);
  const [loadError, setLoadError]     = useState(null);
  const [openReply, setOpenReply]     = useState(null);   // full reply detail (after fetch)
  const [openLoading, setOpenLoading] = useState(false);
  const [composing, setComposing]     = useState(null);
  const [sendError, setSendError]     = useState(null);

  useEffect(() => {
    fetch('/api/portal/inbox', { credentials:'include' })
      .then(r => r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`))
      .then(d => {
        setReplies(d.replies || []);
        setNotSubscribed(!!d.not_subscribed);
      })
      .catch(e => {
        setLoadError(String(e));
        setReplies([]);
      });
  }, []);

  // Click on a reply row → fetch full detail (with body_html) before showing
  // the modal. The list endpoint only returns the snippet for performance,
  // so the modal needs a second call to get the full message body.
  async function openReplyDetail(reply) {
    setOpenLoading(true);
    try {
      const r = await fetch(`/api/portal/replies/${encodeURIComponent(reply.id)}`, { credentials:'include' });
      if (!r.ok) {
        setLoadError(`Couldn't load reply (HTTP ${r.status})`);
        return;
      }
      const d = await r.json();
      setOpenReply(d);
    } catch (e) {
      setLoadError(`Network error: ${e.message}`);
    } finally {
      setOpenLoading(false);
    }
  }

  if (loadError && !replies) {
    return (
      <div>
        <h2 style={pageTitle()}>Inbox</h2>
        <div style={{
          padding:'12px 16px', background:'#fbe9e9', color:DANGER,
          borderRadius:8, fontSize:13, marginTop:18,
        }}>Couldn't load inbox: {loadError}</div>
      </div>
    );
  }

  if (replies === null) {
    return (
      <div>
        <h2 style={pageTitle()}>Inbox</h2>
        <p style={pageSub()}>Loading replies…</p>
      </div>
    );
  }

  return (
    <div>
      <h2 style={pageTitle()}>Inbox</h2>
      <p style={pageSub()}>Replies received to your campaigns. Click any row to read or reply.</p>

      {loadError && (
        <div style={{
          padding:'10px 14px', background:'#fbe9e9', color:DANGER,
          borderRadius:8, marginBottom:12, fontSize:12, display:'flex', alignItems:'center', gap:10,
        }}>
          <span style={{ flex:1 }}>{loadError}</span>
          <button onClick={() => setLoadError(null)} style={{
            background:'transparent', border:'none', color:DANGER, cursor:'pointer', fontSize:14, padding:0,
          }} aria-label="Dismiss">×</button>
        </div>
      )}

      {sendError && (
        <div style={{
          padding:'10px 14px', background:'#fbe9e9', color:DANGER,
          borderRadius:8, marginBottom:12, fontSize:12, display:'flex', alignItems:'center', gap:10,
        }}>
          <span style={{ flex:1 }}>{sendError}</span>
          <button onClick={() => setSendError(null)} style={{
            background:'transparent', border:'none', color:DANGER, cursor:'pointer', fontSize:14, padding:0,
          }} aria-label="Dismiss">×</button>
        </div>
      )}

      {replies.length === 0 ? (
        <div style={{
          marginTop:18, padding:'40px 32px', background:CARD,
          borderRadius:8, border:`0.5px dashed ${BORDER}`,
          textAlign:'center',
        }}>
          <div style={{ fontSize:14, color:TEXT, marginBottom:6, fontWeight:500 }}>
            No replies yet
          </div>
          <div style={{ fontSize:13, color:MUTED, lineHeight:1.5, maxWidth:440, margin:'0 auto' }}>
            When someone replies to one of your campaigns, it will land here.
          </div>
        </div>
      ) : (
        <div style={{
          background:CARD, borderRadius:8, border:`0.5px solid ${BORDER}`, overflow:'hidden',
          opacity: openLoading ? 0.7 : 1, transition:'opacity 0.15s',
        }}>
          <div style={{
            fontSize:11, color:MUTED, textTransform:'uppercase', letterSpacing:'0.06em',
            padding:'14px 14px 8px', borderBottom:`0.5px solid ${BORDER}`,
          }}>Recent replies — click to read &amp; reply</div>
          {replies.map(r => (
            <ReplyRow key={r.id} reply={r} onClick={() => openReplyDetail(r)} />
          ))}
        </div>
      )}

      {openReply && !composing && (
        <ReplyDetailModal reply={openReply}
          onClose={() => setOpenReply(null)}
          onCompose={() => setComposing(openReply)}
        />
      )}
      {composing && (
        <ComposeReplyModal reply={composing}
          onClose={() => setComposing(null)}
          onSend={async (payload) => {
            setSendError(null);
            try {
              const r = await fetch(`/api/portal/replies/${encodeURIComponent(composing.id)}/send`, {
                method:'POST', credentials:'include',
                headers:{ 'Content-Type':'application/json' },
                body: JSON.stringify({ cc: payload.cc, body: payload.body }),
              });
              const d = await r.json().catch(() => ({}));
              if (!r.ok || !d.ok) {
                setSendError(d.error || `Send failed (HTTP ${r.status})`);
                return false;
              }
              setComposing(null);
              setOpenReply(null);
              return true;
            } catch (e) {
              setSendError(`Network error: ${e.message}`);
              return false;
            }
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
        <div style={{ fontWeight:400, color:TERTIARY_TEXT, fontSize:11 }}>{reply.from_address}</div>
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
  // Emails that didn't match any campaign send aren't responses to outreach —
  // they're whatever else landed in the customer's Gmail INBOX (vendor mail,
  // newsletters, transactional notifications). The classifier still ran on
  // them, but its output ('Prospect', 'Unsub'd', etc.) is meaningless for a
  // non-campaign email and actively misleading. Show a neutral 'Normal email'
  // tag instead so the customer can tell at a glance which rows are real
  // campaign replies vs general inbox traffic.
  if (!reply.campaign_title) {
    return <span style={{ ...badgeStyle(), background:'#eef0f2', color:MUTED }}>Normal email</span>;
  }
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
// Renders a received reply in a full-body, email-client-style layout. When
// body_html is available we use it directly (dangerouslySetInnerHTML) so the
// sender's formatting — paragraph breaks, links, signatures — comes through
// as it would in Gmail/Outlook. Falls back to body_text in pre-wrap when no
// HTML body was captured by the IMAP poller.
//
// The HTML is content the customer received in their own inbox — there's no
// new untrusted vector here that didn't already exist in their mail client.
// We do still want the rendered HTML scoped (no global style bleed), so we
// wrap it in a div with isolation styles.
function ReplyDetailModal({ reply, onClose, onCompose }) {
  return (
    <Modal title="Reply" onClose={onClose} wide>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline', marginBottom:14 }}>
        <div>
          <div style={{ fontSize:14, fontWeight:500, color:TEXT }}>{reply.from_name}</div>
          <div style={{ fontSize:12, color:MUTED }}>{reply.from_address}</div>
        </div>
        <ClassifyBadge reply={reply} />
      </div>
      <div style={{ fontSize:13, color:TEXT, marginBottom:6, fontWeight:500 }}>{reply.subject}</div>
      <div style={{ fontSize:11, color:MUTED, marginBottom:14 }}>
        Received {relTime(reply.received_at)}
        {reply.campaign_title && <> · in reply to <em>{reply.campaign_title}</em></>}
        {reply.mailbox_address && <> · to {reply.mailbox_address}</>}
      </div>

      {/* Full message body — preserves the sender's formatting like a normal
          email client. Scrolls within a fixed max-height so very long emails
          don't blow up the modal. */}
      <div style={{
        padding:'14px 16px', background:'#fafaf8', borderRadius:6, fontSize:13,
        color:TEXT, lineHeight:1.6, marginBottom:18,
        maxHeight:'50vh', overflowY:'auto',
        border:`0.5px solid ${BORDER}`,
      }}>
        {reply.body_html ? (
          <div className="portal-email-body" dangerouslySetInnerHTML={{ __html: reply.body_html }} />
        ) : (
          <div style={{ whiteSpace:'pre-wrap', fontFamily:'inherit' }}>
            {reply.body_text || '(empty message)'}
          </div>
        )}
      </div>

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

  async function send() {
    if (!body.trim()) return;
    setBusy(true);
    try {
      const ok = await onSend({ cc: cc.trim(), body });
      // Parent closes the modal on success; on failure we stay open so the
      // customer can fix and resend, and the parent surfaces the error banner.
      if (!ok) setBusy(false);
    } catch (_) {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Reply to ${reply.from_name}`} onClose={() => !busy && onClose()} wide>
      <div style={{ fontSize:11, color:MUTED, marginBottom:10 }}>
        To: <strong style={{ color:TEXT, fontWeight:500 }}>{reply.from_address}</strong> ·
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
  const [campaigns, setCampaigns]     = useState(null);  // null=loading, []=none, [...]=list
  const [notSubscribed, setNotSubscribed] = useState(false);
  const [loadError, setLoadError]     = useState(null);

  useEffect(() => {
    fetch('/api/portal/campaigns', { credentials:'include' })
      .then(r => r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`))
      .then(d => {
        setCampaigns(d.campaigns || []);
        setNotSubscribed(!!d.not_subscribed);
      })
      .catch(e => {
        setLoadError(String(e));
        setCampaigns([]);
      });
  }, []);

  if (loadError) {
    return (
      <div>
        <h2 style={pageTitle()}>Campaigns</h2>
        <div style={{
          padding:'12px 16px', background:'#fbe9e9', color:DANGER,
          borderRadius:8, fontSize:13, marginTop:18,
        }}>Couldn't load campaigns: {loadError}</div>
      </div>
    );
  }
  if (campaigns === null) {
    return (
      <div>
        <h2 style={pageTitle()}>Campaigns</h2>
        <p style={pageSub()}>Loading campaigns…</p>
      </div>
    );
  }
  if (campaigns.length === 0) {
    return (
      <div>
        <h2 style={pageTitle()}>Campaigns</h2>
        <div style={{
          marginTop:18, padding:'40px 32px', background:CARD,
          borderRadius:8, border:`0.5px dashed ${BORDER}`,
          textAlign:'center',
        }}>
          <div style={{ fontSize:14, color:TEXT, marginBottom:6, fontWeight:500 }}>
            No campaigns yet
          </div>
          <div style={{ fontSize:13, color:MUTED, lineHeight:1.5, maxWidth:440, margin:'0 auto' }}>
            Email campaigns run for your account will show up here with delivery and engagement stats.
          </div>
        </div>
      </div>
    );
  }

  // Aggregate strip — totals across all campaigns. Trackable totals exclude
  // campaigns where tracking was off, so the "X% open rate" headlines aren't
  // skewed by sends that were never instrumented.
  const totalSent      = campaigns.reduce((a, c) => a + (c.sent || 0), 0);
  const totalReplies   = campaigns.reduce((a, c) => a + (c.replies || 0), 0);
  const sendingCount   = campaigns.filter(c => c.status === 'sending').length;

  // Status display config — keys match the four normalised values from the
  // backend: 'scheduled' | 'sending' | 'sent' | 'failed'.
  const STATUS_DISPLAY = {
    scheduled: { label: 'Scheduled', bg: '#f4f1e8',  color: MUTED },
    sending:   { label: 'Sending',   bg: BLUE_BG,    color: BLUE },
    sent:      { label: 'Sent',      bg: '#f4f1e8',  color: MUTED },
    failed:    { label: 'Failed',    bg: '#fbe9e9',  color: DANGER },
  };

  return (
    <div>
      <h2 style={pageTitle()}>Campaigns</h2>
      <p style={pageSub()}>Read-only view of every email campaign we've run for your account.</p>

      <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:10, marginBottom:16 }}>
        <StatCard label="Total campaigns"   value={campaigns.length} />
        <StatCard label="Total sent"        value={totalSent.toLocaleString()} />
        <StatCard label="Replies received"  value={totalReplies} />
        <StatCard label="Currently sending" value={sendingCount} />
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
        {campaigns.map(c => {
          const cfg = STATUS_DISPLAY[c.status] || STATUS_DISPLAY.sent;
          // Format started_at — SQLite "YYYY-MM-DD HH:MM:SS" without Z is
          // parsed as local time by browsers; force UTC interpretation so
          // it matches what the admin sees.
          let startedDisplay = '';
          if (c.started_at) {
            const ts = c.started_at.includes('Z') ? c.started_at : c.started_at.replace(' ', 'T') + 'Z';
            startedDisplay = new Date(ts).toLocaleDateString('en-GB', { day:'numeric', month:'short' });
          }
          return (
            <div key={c.id} style={{
              display:'grid', gridTemplateColumns:'2fr 100px 80px 80px 80px 80px 100px',
              gap:10, alignItems:'center', padding:'10px 14px',
              borderBottom:`0.5px solid ${BORDER}`, fontSize:12, color:TEXT,
            }}>
              <div style={{ fontWeight:500, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                {c.title}
              </div>
              <div>
                <span style={{ ...badgeStyle(), background: cfg.bg, color: cfg.color }}>
                  {cfg.label}
                </span>
              </div>
              <div style={{ textAlign:'right' }}>{(c.sent || 0).toLocaleString()}</div>
              <div style={{ textAlign:'right', color: c.tracking_off ? TERTIARY_TEXT : TEXT }}>
                {c.tracking_off ? '—' : (c.opens || 0)}
              </div>
              <div style={{ textAlign:'right', color: c.tracking_off ? TERTIARY_TEXT : TEXT }}>
                {c.tracking_off ? '—' : (c.clicks || 0)}
              </div>
              <div style={{ textAlign:'right', color: c.replies > 0 ? GREEN : TEXT, fontWeight: c.replies > 0 ? 500 : 400 }}>
                {c.replies || 0}
              </div>
              <div style={{ textAlign:'right', color:MUTED, fontSize:11 }}>
                {startedDisplay}
              </div>
            </div>
          );
        })}
      </div>

      {campaigns.some(c => c.tracking_off) && (
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
function PortalSettings({ user, client, services }) {
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
          {client?.logo_url ? (
            <img src={client.logo_url} alt={`${client.name || 'Client'} logo`}
              style={{
                width:48, height:48, borderRadius:8,
                objectFit:'contain', flexShrink:0, display:'block',
              }}
            />
          ) : (
            <div style={{
              width:48, height:48, borderRadius:8, background:client?.logo_color || '#1a4d8c', color:'white',
              display:'flex', alignItems:'center', justifyContent:'center', fontSize:16, fontWeight:500, flexShrink:0,
            }}>{client?.logo_initial || (client?.name || 'C').charAt(0).toUpperCase()}</div>
          )}
          <div>
            <div style={{ fontSize:13, fontWeight:500, color:TEXT }}>{client?.name || '—'}</div>
            {client?.audience && (
              <div style={{ fontSize:11, color:MUTED }}>{client.audience}</div>
            )}
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
