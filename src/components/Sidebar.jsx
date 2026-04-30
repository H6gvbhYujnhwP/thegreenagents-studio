import React from 'react';

const navItems = [
  { id: 'dashboard', label: 'Dashboard', icon: <GridIcon /> },
  { id: 'clients',   label: 'Clients',   icon: <UsersIcon /> },
];

const emailItems = [
  { id: 'email', label: 'Email', icon: <EmailIcon /> },
];

export default function Sidebar({ onLogout, activeView, onNavigate }) {
  return (
    <div style={{ width:200, background:'#0F6E56', display:'flex', flexDirection:'column', flexShrink:0 }}>
      <div style={{ padding:'20px 20px 20px', borderBottom:'0.5px solid rgba(255,255,255,0.1)' }}>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <div style={{ width:30, height:30, background:'#1D9E75', borderRadius:7, display:'flex', alignItems:'center', justifyContent:'center', color:'#fff', fontWeight:600, fontSize:14, flexShrink:0 }}>G</div>
          <div>
            <div style={{ color:'#fff', fontSize:13, fontWeight:500, lineHeight:1.2 }}>The Green Agents</div>
            <div style={{ color:'#9FE1CB', fontSize:11 }}>Studio</div>
          </div>
        </div>
      </div>

      <div style={{ flex:1, padding:'12px 0' }}>
        {navItems.map(item => (
          <NavBtn key={item.id} item={item} active={activeView === item.id} onNavigate={onNavigate} />
        ))}

        <div style={{ margin:'8px 16px', borderTop:'0.5px solid rgba(255,255,255,0.1)' }} />

        {emailItems.map(item => (
          <NavBtn key={item.id} item={item} active={activeView === item.id} onNavigate={onNavigate} />
        ))}
      </div>

      <div style={{ padding:'16px 20px', borderTop:'0.5px solid rgba(255,255,255,0.1)' }}>
        <button
          onClick={onLogout}
          style={{ background:'transparent', border:'none', color:'#9FE1CB', fontSize:12, padding:0, cursor:'pointer' }}
        >
          Sign out
        </button>
      </div>
    </div>
  );
}

function NavBtn({ item, active, onNavigate }) {
  return (
    <button
      onClick={() => onNavigate(item.id)}
      style={{
        display:'flex', alignItems:'center', gap:10, width:'100%',
        padding:'9px 20px', background: active ? 'rgba(255,255,255,0.12)' : 'transparent',
        border:'none', color: active ? '#fff' : '#9FE1CB',
        fontSize:13, textAlign:'left', cursor:'pointer'
      }}
    >
      {item.icon}
      {item.label}
    </button>
  );
}

function GridIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
      <rect x="1" y="1" width="6" height="6" rx="1"/>
      <rect x="9" y="1" width="6" height="6" rx="1"/>
      <rect x="1" y="9" width="6" height="6" rx="1"/>
      <rect x="9" y="9" width="6" height="6" rx="1"/>
    </svg>
  );
}

function UsersIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
      <path d="M6 8a3 3 0 100-6 3 3 0 000 6zm-5 6s-1 0-1-1 1-4 6-4 6 3 6 4-1 1-1 1H1zm11-6a2 2 0 100-4 2 2 0 000 4zm4 6s0 .5-.5.5H13c.12-.5.16-1 .12-1.5.34.15.64.36.88.6.4.45.5.9.5.9a1 1 0 01-1 1z"/>
    </svg>
  );
}

function EmailIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
      <path d="M2 2h12a1 1 0 011 1v1.5L8 9 1 4.5V3a1 1 0 011-1zm-1 3.8V13a1 1 0 001 1h12a1 1 0 001-1V5.8L8 10.9 1 5.8z"/>
    </svg>
  );
}
