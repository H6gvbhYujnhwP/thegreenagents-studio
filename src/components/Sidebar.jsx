import React, { useState, useEffect } from 'react';

const SECTION = { padding:'10px 16px 4px', fontSize:10, fontWeight:700, color:'rgba(255,255,255,0.55)', letterSpacing:'0.08em', textTransform:'uppercase' };
const DIVIDER = { margin:'6px 16px 2px', borderTop:'0.5px solid rgba(255,255,255,0.1)', border:'none' };

export default function Sidebar({ onLogout, activeView, onNavigate }) {
  // Live prospect-count badge for the Mailboxes menu item.
  // Refreshes every 30s while the app is open. Gracefully handles failure
  // (e.g. backend not yet deployed) by hiding the badge.
  const [prospectCount, setProspectCount] = useState(0);
  useEffect(() => {
    let cancelled = false;
    async function fetchCount() {
      try {
        const r = await fetch('/api/email/mailboxes/badge-count');
        if (!r.ok) return;
        const d = await r.json();
        if (!cancelled) setProspectCount(d.new_prospects || 0);
      } catch {} // backend not yet deployed — silently ignore
    }
    fetchCount();
    const t = setInterval(fetchCount, 30_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  return (
    <div style={{ width:210, background:'#0F6E56', display:'flex', flexDirection:'column', flexShrink:0 }}>

      {/* Logo */}
      <div style={{ padding:'16px 14px', borderBottom:'0.5px solid rgba(255,255,255,0.1)', display:'flex', alignItems:'center', gap:10 }}>
        <div style={{ width:30, height:30, background:'#1D9E75', borderRadius:7, display:'flex', alignItems:'center', justifyContent:'center', color:'#fff', fontWeight:600, fontSize:14, flexShrink:0 }}>G</div>
        <div>
          <div style={{ color:'#fff', fontSize:13, fontWeight:500, lineHeight:1.2 }}>The Green Agents</div>
          <div style={{ color:'#9FE1CB', fontSize:11 }}>Studio</div>
        </div>
      </div>

      {/* Nav */}
      <div style={{ flex:1, paddingTop:10 }}>

        <div style={SECTION}>Social Media Posts</div>
        <NavItem id="clients" label="LinkedIn Posts" active={activeView==='clients'} onNavigate={onNavigate} icon={<UsersIcon />} />

        <hr style={DIVIDER} />

        <div style={SECTION}>Email Campaigns</div>
        <SubItem id="email-customers"     label="Customers"     active={activeView==='email-customers'}     onNavigate={onNavigate} icon={<CustomersIcon />} />
        <SubItem id="email-domain-health" label="Domain Health" active={activeView==='email-domain-health'} onNavigate={onNavigate} icon={<DomainIcon />} />
        <SubItem id="email-mailboxes"     label="Mailboxes"     active={activeView==='email-mailboxes'}     onNavigate={onNavigate} icon={<MailboxIcon />} badge={prospectCount} />

        <hr style={DIVIDER} />

        <div style={SECTION}>Customer Portal</div>
        <SubItem id="portal-customers"    label="Portal Customers" active={activeView==='portal-customers'}  onNavigate={onNavigate} icon={<PortalIcon />} />

      </div>

      <div style={{ padding:'14px 16px', borderTop:'0.5px solid rgba(255,255,255,0.1)' }}>
        <button onClick={onLogout} style={{ background:'transparent', border:'none', color:'#9FE1CB', fontSize:12, padding:0, cursor:'pointer' }}>
          Sign out
        </button>
      </div>
    </div>
  );
}

function NavItem({ id, label, active, onNavigate, icon }) {
  return (
    <button onClick={()=>onNavigate(id)} style={{
      display:'flex', alignItems:'center', gap:9, width:'100%',
      padding:'8px 16px', background:active?'rgba(255,255,255,0.12)':'transparent',
      border:'none', color:active?'#fff':'#9FE1CB', fontSize:12, textAlign:'left', cursor:'pointer'
    }}>
      {icon}{label}
    </button>
  );
}

function SubItem({ id, label, active, onNavigate, icon, badge }) {
  return (
    <button onClick={()=>onNavigate(id)} style={{
      display:'flex', alignItems:'center', gap:9, width:'100%',
      padding:'6px 16px 6px 32px',
      background:active?'rgba(255,255,255,0.1)':'transparent',
      borderLeft:active?'2px solid #9FE1CB':'2px solid transparent',
      borderTop:'none', borderRight:'none', borderBottom:'none',
      color:active?'#fff':'rgba(255,255,255,0.65)', fontSize:11, textAlign:'left', cursor:'pointer'
    }}>
      {icon}<span style={{flex:1}}>{label}</span>
      {badge>0 && <span style={{ background:'#1D9E75', color:'#fff', fontSize:10, fontWeight:600, padding:'1px 6px', borderRadius:8, minWidth:14, textAlign:'center', lineHeight:1.4 }}>{badge}</span>}
    </button>
  );
}

function UsersIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 1C4.13 1 1 4.13 1 8s3.13 7 7 7 7-3.13 7-7-3.13-7-7-7zm0 2.5a2 2 0 110 4 2 2 0 010-4zM8 13a5 5 0 01-3.9-1.87C4.1 9.92 6.08 9 8 9s3.9.92 3.9 2.13A5 5 0 018 13z"/>
    </svg>
  );
}

function CustomersIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
      <path d="M6 8a3 3 0 100-6 3 3 0 000 6zm-5 6s-1 0-1-1 1-4 6-4 6 3 6 4-1 1-1 1H1zm11-6a2 2 0 100-4 2 2 0 000 4zm4 6s0 .5-.5.5H13c.12-.5.16-1 .12-1.5.34.15.64.36.88.6.4.45.5.9.5.9a1 1 0 01-1 1z"/>
    </svg>
  );
}

function DomainIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 1.5c.34 0 .9.4 1.4 1.5H6.6c.5-1.1 1.06-1.5 1.4-1.5zm-2.1.4C5.4 3.7 5 4.6 4.8 5.5H3.2A5.53 5.53 0 015.9 2.9zm4.2 0A5.53 5.53 0 0112.8 5.5h-1.6c-.2-.9-.6-1.8-1.1-2.6zM2.8 7h2c-.05.33-.08.66-.08 1s.03.67.08 1H2.8A5.46 5.46 0 012.5 8c0-.34.1-.67.3-1zm2.2 0h6c.06.32.1.65.1 1s-.04.68-.1 1H5c-.06-.32-.1-.65-.1-1s.04-.68.1-1zm6.2 0h2c.2.33.3.66.3 1s-.1.67-.3 1h-2c.05-.33.08-.66.08-1S11.25 7.33 11.2 7zM3.2 10.5h1.6c.2.9.6 1.8 1.1 2.6A5.53 5.53 0 013.2 10.5zm2.8 0h4c-.5 1.1-1.06 1.5-1.4 1.5-.34 0-.9-.4-1.4-1.5H6zm5.2 0h1.6a5.53 5.53 0 01-2.7 2.6c.5-.8.9-1.7 1.1-2.6z"/>
    </svg>
  );
}

function MailboxIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
      <path d="M2 3a1 1 0 00-1 1v8a1 1 0 001 1h12a1 1 0 001-1V4a1 1 0 00-1-1H2zm0 1h12v.4l-6 3.5L2 4.4V4zm0 1.6l5.7 3.3a.6.6 0 00.6 0L14 5.6V12H2V5.6z"/>
    </svg>
  );
}

function PortalIcon() {
  // Door-with-arrow icon — represents a customer "entering" their portal.
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
      <path d="M3 1.5A.5.5 0 013.5 1h6a.5.5 0 01.5.5v3.5h-1V2H4v12h5v-3h1v3.5a.5.5 0 01-.5.5h-6a.5.5 0 01-.5-.5v-13z"/>
      <path d="M11.5 5.5a.5.5 0 01.354.146l2.5 2.5a.5.5 0 010 .708l-2.5 2.5a.5.5 0 11-.708-.708L13.293 8.5H6.5a.5.5 0 010-1h6.793l-1.647-1.646A.5.5 0 0111.5 5.5z"/>
    </svg>
  );
}
