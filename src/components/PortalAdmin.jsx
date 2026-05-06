// ─────────────────────────────────────────────────────────────────────────────
// PortalAdmin.jsx — Admin section for managing the Customer Portal.
//
// Mounted by Dashboard.jsx when activeView === 'portal-customers'. Lists every
// email_client (customer) with their portal stats. Click a row to open a
// "manage" panel with three sections:
//   1. Services — Email enabled (yes/no), LinkedIn account (dropdown), Facebook
//      (greyed-out "coming soon").
//   2. Portal users — table with role, last sign-in, Add/Remove/Reset password
//      actions. Adding/resetting shows the new temporary password ONCE — Wez
//      gives it to the customer out-of-band.
//   3. Portal URL — copy-to-clipboard https://studio.thegreenagents.com/c/<slug>.
//
// All API calls go to /api/portal-admin/* which is gated by the existing
// admin Bearer token (requireAuth in middleware/auth.js).
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useEffect } from 'react';

// Match the existing admin colour palette (Dashboard.jsx, EmailSection.jsx).
const GREEN     = '#1D9E75';
const GREEN_HI  = '#0F6E56';
const GREEN_BG  = '#E1F5EE';
const TEXT      = '#1a1a1a';
const MUTED     = '#666';
const TERTIARY  = '#999';
const BORDER    = '#e0e0dc';
const BG        = '#f5f5f3';
const CARD      = '#ffffff';
const BLUE      = '#185FA5';
const BLUE_BG   = '#E6F1FB';
const AMBER     = '#854F0B';
const AMBER_BG  = '#FAEEDA';
const DANGER    = '#A32D2D';

// ── Top-level list view ─────────────────────────────────────────────────────
export default function PortalAdmin() {
  const [customers, setCustomers] = useState(null);
  const [selected,  setSelected]  = useState(null);  // customer id being managed
  const [error,     setError]     = useState(null);

  async function loadCustomers() {
    try {
      const r = await fetch('/api/portal-admin/customers');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setCustomers(await r.json());
    } catch (e) {
      setError(e.message);
      setCustomers([]);
    }
  }
  useEffect(() => { loadCustomers(); }, []);

  if (selected) {
    return <ManagePanel
      customerId={selected}
      onClose={() => { setSelected(null); loadCustomers(); }}
    />;
  }

  return (
    <div style={{ flex:1, overflow:'auto', padding:28 }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:24 }}>
        <h1 style={{ fontSize:20, fontWeight:500, color:TEXT, margin:0 }}>Customer Portal</h1>
        <div style={{ fontSize:12, color:MUTED }}>
          Manage which customers have a portal at <code style={{ background:'#f0f0ec', padding:'2px 6px', borderRadius:4, fontSize:11 }}>/c/&lt;slug&gt;</code> and which services they see.
        </div>
      </div>

      {error && (
        <div style={{ padding:'10px 14px', background:'#fbe9e9', color:DANGER, borderRadius:6, fontSize:13, marginBottom:16 }}>
          Failed to load customers: {error}
        </div>
      )}

      {customers === null ? (
        <div style={{ color:MUTED, padding:'40px 0', textAlign:'center' }}>Loading…</div>
      ) : customers.length === 0 ? (
        <div style={{ background:CARD, border:`0.5px dashed #d0d0cc`, borderRadius:12, padding:48, textAlign:'center', color:MUTED }}>
          No customers yet. Add one in <strong>Email Campaigns → Customers</strong> first; it'll show up here automatically.
        </div>
      ) : (
        <div style={{ background:CARD, border:`0.5px solid ${BORDER}`, borderRadius:8, overflow:'hidden' }}>
          {/* Header */}
          <div style={{
            display:'grid', gridTemplateColumns:'2fr 1.5fr 1fr 1fr 1.5fr 90px',
            gap:10, padding:'12px 16px', borderBottom:`0.5px solid ${BORDER}`,
            fontSize:11, color:MUTED, textTransform:'uppercase', letterSpacing:'0.05em',
          }}>
            <div>Customer</div>
            <div>Slug / portal URL</div>
            <div>Portal users</div>
            <div>Email</div>
            <div>LinkedIn</div>
            <div style={{ textAlign:'right' }}></div>
          </div>
          {customers.map(c => <CustomerRow key={c.id} customer={c} onManage={() => setSelected(c.id)} />)}
        </div>
      )}
    </div>
  );
}

function CustomerRow({ customer, onManage }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        display:'grid', gridTemplateColumns:'2fr 1.5fr 1fr 1fr 1.5fr 90px',
        gap:10, padding:'14px 16px', alignItems:'center',
        borderBottom:`0.5px solid ${BORDER}`, fontSize:12,
        background: hover ? '#fafaf8' : 'transparent',
      }}>
      <div style={{ fontWeight:500, color:TEXT }}>
        {customer.name}
      </div>
      <div style={{ color:MUTED, fontFamily:'monospace', fontSize:11 }}>
        /c/{customer.slug}
      </div>
      <div style={{ color: customer.portal_user_count > 0 ? TEXT : TERTIARY }}>
        {customer.portal_user_count === 0
          ? <span style={{ fontStyle:'italic' }}>No users</span>
          : `${customer.portal_user_count} user${customer.portal_user_count !== 1 ? 's' : ''}`}
      </div>
      <div>
        {customer.service_email_enabled
          ? <Pill bg={GREEN_BG} fg={GREEN_HI}>Enabled</Pill>
          : <Pill bg="#f4f1e8" fg={MUTED}>Not required</Pill>}
      </div>
      <div>
        {customer.linkedin_client_id
          ? <Pill bg={GREEN_BG} fg={GREEN_HI} title={customer.linkedin_client_name}>
              ✓ {customer.linkedin_client_name && customer.linkedin_client_name.length > 18
                  ? customer.linkedin_client_name.slice(0, 18) + '…'
                  : customer.linkedin_client_name}
            </Pill>
          : <Pill bg="#f4f1e8" fg={MUTED}>Not required</Pill>}
      </div>
      <div style={{ textAlign:'right' }}>
        <button onClick={onManage} style={btnSecondary()}>Manage →</button>
      </div>
    </div>
  );
}

// ── Manage Panel ────────────────────────────────────────────────────────────
function ManagePanel({ customerId, onClose }) {
  const [data,    setData]    = useState(null);
  const [error,   setError]   = useState(null);
  const [linkedinClients, setLinkedinClients] = useState([]);

  async function loadAll() {
    try {
      const [c, lc] = await Promise.all([
        fetch(`/api/portal-admin/customers/${customerId}`).then(r => r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`)),
        fetch(`/api/portal-admin/linkedin-clients`).then(r => r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`)),
      ]);
      setData(c);
      setLinkedinClients(lc);
    } catch (e) {
      setError(String(e));
    }
  }
  useEffect(() => { loadAll(); }, [customerId]);

  if (error) {
    return (
      <div style={{ flex:1, padding:28 }}>
        <button onClick={onClose} style={btnSecondary()}>← Back to all customers</button>
        <div style={{ marginTop:16, padding:'10px 14px', background:'#fbe9e9', color:DANGER, borderRadius:6, fontSize:13 }}>
          Failed to load: {error}
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div style={{ flex:1, padding:28, color:MUTED }}>
        Loading…
      </div>
    );
  }

  const { customer, users } = data;
  const portalUrl = `${window.location.origin}/c/${customer.slug}`;

  return (
    <div style={{ flex:1, overflow:'auto', padding:28 }}>
      <button onClick={onClose} style={btnSecondary()}>← Back to all customers</button>

      <h1 style={{ fontSize:20, fontWeight:500, color:TEXT, margin:'18px 0 4px' }}>
        {customer.name}
      </h1>
      <div style={{ fontSize:12, color:MUTED, marginBottom:24 }}>
        Customer portal at <a href={portalUrl} target="_blank" rel="noopener noreferrer" style={{ color:BLUE, textDecoration:'none', fontFamily:'monospace' }}>{portalUrl}</a>
      </div>

      <ServicesPanel
        customer={customer}
        linkedinClients={linkedinClients}
        onUpdated={(updated) => setData(d => ({ ...d, customer: updated }))}
      />

      <UsersPanel
        customer={customer}
        users={users}
        onChange={loadAll}
      />

      <PortalUrlPanel portalUrl={portalUrl} userCount={users.length} />
    </div>
  );
}

// ── Services panel ──────────────────────────────────────────────────────────
function ServicesPanel({ customer, linkedinClients, onUpdated }) {
  const [emailEnabled, setEmailEnabled]   = useState(customer.service_email_enabled);
  const [linkedinId,   setLinkedinId]     = useState(customer.linkedin_client_id || '');
  const [saving, setSaving] = useState(false);
  const [msg,    setMsg]    = useState(null);

  // Detect dirty state — only enable Save if at least one field changed.
  const dirty = (emailEnabled !== customer.service_email_enabled)
             || ((linkedinId || null) !== (customer.linkedin_client_id || null));

  async function save() {
    setSaving(true); setMsg(null);
    try {
      const r = await fetch(`/api/portal-admin/customers/${customer.id}/services`, {
        method:'PUT',
        headers:{ 'Content-Type':'application/json' },
        body: JSON.stringify({
          service_email_enabled: emailEnabled,
          linkedin_client_id:    linkedinId || null,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      onUpdated(d);
      setMsg({ ok:true, text:'Saved.' });
    } catch (e) {
      setMsg({ ok:false, text: e.message });
    }
    setSaving(false);
  }

  return (
    <Card title="Services" subtitle="Which services this customer sees in their portal. Each tab in the customer portal renders either real data, a 'Not required' panel, or a 'Coming soon' panel based on these settings.">

      {/* Email */}
      <ServiceRow
        label="Email (Inbox + Campaigns)"
        description="Inbox replies and email-campaign stats from your cold-outreach system."
      >
        <select value={emailEnabled ? 'enabled' : 'not_required'}
          onChange={e => setEmailEnabled(e.target.value === 'enabled')}
          disabled={saving}
          style={selectStyle()}
        >
          <option value="enabled">Enabled — show inbox + campaigns</option>
          <option value="not_required">Not required — hide with message</option>
        </select>
      </ServiceRow>

      {/* LinkedIn */}
      <ServiceRow
        label="LinkedIn Posts"
        description="Customers see their LinkedIn posts pending approval, drawn from the linked LinkedIn account."
      >
        <select value={linkedinId}
          onChange={e => setLinkedinId(e.target.value)}
          disabled={saving}
          style={selectStyle()}
        >
          <option value="">Not required — hide with message</option>
          {linkedinClients.map(lc => {
            const linkedElsewhere = lc.linked_to_id && lc.linked_to_id !== customer.id;
            return (
              <option key={lc.id} value={lc.id} disabled={linkedElsewhere}>
                {lc.name}{linkedElsewhere ? ` — already linked to ${lc.linked_to_name}` : ''}
              </option>
            );
          })}
        </select>
      </ServiceRow>

      {/* Facebook (placeholder) */}
      <ServiceRow
        label="Facebook Posts"
        description="Coming soon — once Facebook posting is wired up, you'll be able to link a Facebook page here."
        comingSoon
      >
        <select disabled style={{ ...selectStyle(), color:TERTIARY }}>
          <option>Coming soon</option>
        </select>
      </ServiceRow>

      {/* Save */}
      <div style={{ display:'flex', alignItems:'center', gap:10, marginTop:6 }}>
        <button onClick={save} disabled={!dirty || saving} style={btnPrimary(!dirty || saving)}>
          {saving ? 'Saving…' : 'Save services'}
        </button>
        {msg && <span style={{ fontSize:12, color: msg.ok ? GREEN_HI : DANGER }}>{msg.text}</span>}
      </div>
    </Card>
  );
}

function ServiceRow({ label, description, comingSoon, children }) {
  return (
    <div style={{
      display:'grid', gridTemplateColumns:'1fr 320px', gap:18, alignItems:'start',
      padding:'14px 0', borderBottom:`0.5px solid ${BORDER}`,
    }}>
      <div>
        <div style={{ fontSize:13, fontWeight:500, color: comingSoon ? TERTIARY : TEXT, marginBottom:4 }}>
          {label}
          {comingSoon && (
            <span style={{
              marginLeft:8, padding:'1px 6px', fontSize:10, fontWeight:500,
              background:BLUE_BG, color:BLUE, borderRadius:4,
            }}>Coming soon</span>
          )}
        </div>
        <div style={{ fontSize:11, color:MUTED, lineHeight:1.5 }}>{description}</div>
      </div>
      <div>{children}</div>
    </div>
  );
}

// ── Users panel ─────────────────────────────────────────────────────────────
function UsersPanel({ customer, users, onChange }) {
  const [showAdd,  setShowAdd]  = useState(false);
  const [newCreds, setNewCreds] = useState(null);   // { username, temp_password } shown ONCE after add or reset

  return (
    <Card
      title="Portal users"
      subtitle="People at this customer who can sign in to their portal. Usernames are scoped to this customer — two different customers can both have a user called 'admin'."
      action={<button onClick={() => setShowAdd(true)} style={btnPrimary()}>+ Add user</button>}
    >
      {users.length === 0 ? (
        <div style={{
          padding:'24px 18px', textAlign:'center',
          background:'#fafaf8', borderRadius:6, color:MUTED, fontSize:13,
        }}>
          No portal users yet. Click <strong>+ Add user</strong> to create one — you'll get a temporary password to share with the customer.
        </div>
      ) : (
        <div style={{ border:`0.5px solid ${BORDER}`, borderRadius:6, overflow:'hidden' }}>
          <div style={{
            display:'grid', gridTemplateColumns:'1.5fr 1.5fr 80px 110px 200px',
            gap:10, padding:'10px 14px', borderBottom:`0.5px solid ${BORDER}`,
            fontSize:11, color:MUTED, textTransform:'uppercase', letterSpacing:'0.04em',
          }}>
            <div>Username</div>
            <div>Email</div>
            <div>Role</div>
            <div>Last sign-in</div>
            <div></div>
          </div>
          {users.map(u => (
            <UserRow key={u.id} user={u} onChange={onChange} onResetShown={(creds) => setNewCreds(creds)} />
          ))}
        </div>
      )}

      {showAdd && (
        <AddUserModal
          customerId={customer.id}
          existingUsernames={users.map(u => u.username)}
          onClose={() => setShowAdd(false)}
          onCreated={(creds) => {
            setShowAdd(false);
            setNewCreds(creds);
            onChange();
          }}
        />
      )}

      {newCreds && (
        <TempPasswordModal
          creds={newCreds}
          customerName={customer.name}
          portalSlug={customer.slug}
          onClose={() => setNewCreds(null)}
        />
      )}
    </Card>
  );
}

function UserRow({ user, onChange, onResetShown }) {
  const [busy, setBusy] = useState(null);   // 'reset' | 'delete' | null

  async function reset() {
    if (!confirm(`Reset ${user.username}'s password?\n\nThis kills any active sign-ins they have and shows you a new temporary password to give them.`)) return;
    setBusy('reset');
    try {
      const r = await fetch(`/api/portal-admin/users/${user.id}/reset-password`, { method:'POST' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      onResetShown({
        username: user.username,
        temporary_password: d.temporary_password,
        kind: 'reset',
      });
    } catch (e) {
      alert(`Reset failed: ${e.message}`);
    }
    setBusy(null);
  }

  async function remove() {
    if (!confirm(`Remove ${user.username}?\n\nThey'll be signed out immediately and won't be able to sign in again. This can't be undone.`)) return;
    setBusy('delete');
    try {
      const r = await fetch(`/api/portal-admin/users/${user.id}`, { method:'DELETE' });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${r.status}`);
      }
      onChange();
    } catch (e) {
      alert(`Remove failed: ${e.message}`);
    }
    setBusy(null);
  }

  return (
    <div style={{
      display:'grid', gridTemplateColumns:'1.5fr 1.5fr 80px 110px 200px',
      gap:10, padding:'10px 14px', borderBottom:`0.5px solid ${BORDER}`,
      fontSize:12, alignItems:'center',
    }}>
      <div style={{ fontWeight:500, color:TEXT }}>{user.username}</div>
      <div style={{ color:MUTED }}>{user.email || <span style={{ color:TERTIARY, fontStyle:'italic' }}>(none)</span>}</div>
      <div>
        <Pill bg={user.role === 'admin' ? BLUE_BG : '#f4f1e8'} fg={user.role === 'admin' ? BLUE : MUTED}>
          {user.role}
        </Pill>
      </div>
      <div style={{ color: user.last_login_at ? MUTED : AMBER, fontSize:11 }}>
        {user.last_login_at ? formatRelative(user.last_login_at) : <em>Never</em>}
      </div>
      <div style={{ display:'flex', gap:6, justifyContent:'flex-end' }}>
        <button onClick={reset}  disabled={busy} style={btnSecondary(busy === 'reset')}>
          {busy === 'reset' ? 'Resetting…' : 'Reset password'}
        </button>
        <button onClick={remove} disabled={busy} style={{ ...btnSecondary(busy === 'delete'), color:DANGER, borderColor:'#f0c4c4' }}>
          {busy === 'delete' ? 'Removing…' : 'Remove'}
        </button>
      </div>
    </div>
  );
}

function AddUserModal({ customerId, existingUsernames, onClose, onCreated }) {
  const [username, setUsername] = useState('');
  const [email,    setEmail]    = useState('');
  const [role,     setRole]     = useState('viewer');
  const [busy, setBusy] = useState(false);
  const [err,  setErr]  = useState('');

  async function submit() {
    const u = username.trim().toLowerCase();
    if (!u) { setErr('Username is required'); return; }
    if (existingUsernames.includes(u)) { setErr('That username is already in use for this customer'); return; }
    if (!/^[a-z0-9][a-z0-9._-]{1,30}$/.test(u)) {
      setErr('Username must be 2–31 chars: lowercase letters, digits, dots, underscores, dashes');
      return;
    }
    setBusy(true); setErr('');
    try {
      const r = await fetch(`/api/portal-admin/customers/${customerId}/users`, {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        body: JSON.stringify({ username: u, email: email.trim(), role }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      onCreated({
        username: d.user.username,
        temporary_password: d.temporary_password,
        kind: 'create',
      });
    } catch (e) {
      setErr(e.message);
      setBusy(false);
    }
  }

  return (
    <ModalShell title="Add portal user" onClose={busy ? null : onClose}>
      <div style={{ fontSize:13, color:TEXT, lineHeight:1.5, marginBottom:14 }}>
        We'll generate a temporary password for them. You'll see it once on the next screen — copy it and give it to the customer over the phone or your usual secure channel.
      </div>

      <Field label="Username">
        <input value={username} onChange={e => setUsername(e.target.value)} disabled={busy}
          autoFocus placeholder="andrea-tower"
          style={inputStyle()}
        />
      </Field>

      <Field label="Email (for password resets)">
        <input value={email} onChange={e => setEmail(e.target.value)} disabled={busy}
          type="email" placeholder="andrea@tower.co.uk"
          style={inputStyle()}
        />
      </Field>

      <Field label="Role">
        <select value={role} onChange={e => setRole(e.target.value)} disabled={busy} style={selectStyle()}>
          <option value="viewer">Viewer — read only</option>
          <option value="admin">Admin — can manage other portal users at this customer</option>
        </select>
      </Field>

      {err && <div style={{ color:DANGER, fontSize:12, marginTop:6 }}>{err}</div>}

      <div style={{ display:'flex', justifyContent:'flex-end', gap:8, marginTop:16 }}>
        <button onClick={onClose} disabled={busy} style={btnSecondary()}>Cancel</button>
        <button onClick={submit} disabled={busy || !username.trim()} style={btnPrimary(busy || !username.trim())}>
          {busy ? 'Creating…' : 'Create user'}
        </button>
      </div>
    </ModalShell>
  );
}

function TempPasswordModal({ creds, customerName, portalSlug, onClose }) {
  const [copied, setCopied] = useState(false);
  const portalUrl = `${window.location.origin}/c/${portalSlug}`;
  const blob = `Portal: ${portalUrl}\nUsername: ${creds.username}\nTemporary password: ${creds.temporary_password}`;

  function copyAll() {
    navigator.clipboard.writeText(blob).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }
  function copyPw() {
    navigator.clipboard.writeText(creds.temporary_password).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <ModalShell title={creds.kind === 'reset' ? 'Password reset' : 'User created'} onClose={onClose}>
      <div style={{
        padding:'10px 12px', background:AMBER_BG, color:AMBER,
        borderRadius:6, fontSize:12, lineHeight:1.5, marginBottom:14,
      }}>
        <strong style={{ fontWeight:500 }}>This is the only time you'll see this password.</strong>
        {' '}Copy it now and give it to the customer. They'll be prompted to change it on their first sign-in.
      </div>

      <div style={{
        background:'#fafaf8', border:`0.5px solid ${BORDER}`, borderRadius:6,
        padding:'14px 16px', marginBottom:14,
      }}>
        <Row label="Customer" value={customerName} />
        <Row label="Portal URL" value={portalUrl} mono link />
        <Row label="Username" value={creds.username} mono />
        <Row label="Temporary password" value={creds.temporary_password} mono bold />
      </div>

      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:8 }}>
        <div style={{ fontSize:11, color: copied ? GREEN_HI : MUTED }}>
          {copied ? '✓ Copied to clipboard' : ''}
        </div>
        <div style={{ display:'flex', gap:8 }}>
          <button onClick={copyPw} style={btnSecondary()}>Copy password only</button>
          <button onClick={copyAll} style={btnPrimary()}>Copy all details</button>
          <button onClick={onClose} style={btnSecondary()}>Done</button>
        </div>
      </div>
    </ModalShell>
  );
}

function Row({ label, value, mono, bold, link }) {
  return (
    <div style={{ display:'grid', gridTemplateColumns:'140px 1fr', gap:10, padding:'4px 0', fontSize:12 }}>
      <div style={{ color:MUTED }}>{label}</div>
      <div style={{
        color: TEXT, fontWeight: bold ? 500 : 400,
        fontFamily: mono ? 'monospace' : 'inherit',
        wordBreak: 'break-all',
      }}>
        {link
          ? <a href={value} target="_blank" rel="noopener noreferrer" style={{ color:BLUE, textDecoration:'none' }}>{value}</a>
          : value}
      </div>
    </div>
  );
}

// ── Portal URL panel ────────────────────────────────────────────────────────
function PortalUrlPanel({ portalUrl, userCount }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(portalUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <Card title="Portal URL" subtitle="Send this to the customer along with their username and password.">
      <div style={{
        display:'flex', gap:10, alignItems:'center',
        padding:'12px 14px', background:'#fafaf8', borderRadius:6,
        border:`0.5px solid ${BORDER}`,
      }}>
        <code style={{ flex:1, fontSize:12, color:TEXT, wordBreak:'break-all' }}>{portalUrl}</code>
        <button onClick={copy} style={btnSecondary()}>
          {copied ? '✓ Copied' : 'Copy'}
        </button>
        <a href={portalUrl} target="_blank" rel="noopener noreferrer" style={btnSecondary()}>
          Open ↗
        </a>
      </div>
      {userCount === 0 && (
        <div style={{ marginTop:10, fontSize:12, color:AMBER }}>
          ⚠️ No portal users created yet — the customer can't sign in until you add at least one user above.
        </div>
      )}
    </Card>
  );
}

// ── Reusable bits ───────────────────────────────────────────────────────────
function Card({ title, subtitle, action, children }) {
  return (
    <div style={{
      background:CARD, border:`0.5px solid ${BORDER}`, borderRadius:8,
      padding:'18px 20px', marginBottom:16,
    }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:14 }}>
        <div>
          <div style={{ fontSize:14, fontWeight:500, color:TEXT, marginBottom:4 }}>{title}</div>
          {subtitle && <div style={{ fontSize:12, color:MUTED, lineHeight:1.5 }}>{subtitle}</div>}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

function Pill({ bg, fg, children, title }) {
  return (
    <span title={title || undefined} style={{
      display:'inline-block', padding:'2px 8px', fontSize:11, fontWeight:500,
      background:bg, color:fg, borderRadius:4, whiteSpace:'nowrap',
    }}>{children}</span>
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

function ModalShell({ title, onClose, children }) {
  return (
    <div onClick={onClose ? onClose : undefined} style={{
      position:'fixed', inset:0, background:'rgba(0,0,0,0.4)', zIndex:9999,
      display:'flex', alignItems:'center', justifyContent:'center', padding:20,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background:CARD, borderRadius:12, padding:'22px 26px',
        maxWidth:540, width:'100%', maxHeight:'90vh', overflow:'auto',
      }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:14 }}>
          <h3 style={{ fontSize:15, fontWeight:500, margin:0, color:TEXT }}>{title}</h3>
          {onClose && (
            <button onClick={onClose} style={{
              background:'transparent', border:'none', fontSize:20, color:MUTED,
              cursor:'pointer', lineHeight:1, padding:0,
            }}>×</button>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}

function inputStyle() {
  return {
    width:'100%', boxSizing:'border-box', padding:'9px 10px', fontSize:13,
    border:`0.5px solid ${BORDER}`, borderRadius:6, outline:'none',
    color:TEXT, background:CARD, fontFamily:'inherit',
  };
}
function selectStyle() {
  return {
    ...inputStyle(),
    cursor:'pointer',
    appearance:'auto',
  };
}
function btnPrimary(disabled) {
  return {
    padding:'8px 14px', fontSize:13, fontWeight:500,
    background: disabled ? '#9FE1CB' : GREEN, color:'white',
    border:'none', borderRadius:6,
    cursor: disabled ? 'default' : 'pointer',
  };
}
function btnSecondary(disabled) {
  return {
    padding:'7px 12px', fontSize:12,
    background:CARD, color:TEXT,
    border:`0.5px solid ${BORDER}`, borderRadius:6,
    cursor: disabled ? 'default' : 'pointer',
    textDecoration:'none', display:'inline-block',
  };
}

function formatRelative(iso) {
  if (!iso) return '';
  // SQLite returns 'YYYY-MM-DD HH:MM:SS' (UTC, no timezone marker). Browsers
  // parse that as local — append Z to force UTC. (Same fix as EmailSection's relTime.)
  const fixed = iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z';
  const ms = Date.now() - new Date(fixed).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1)   return 'just now';
  if (m < 60)  return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7)   return `${d}d ago`;
  return new Date(fixed).toLocaleDateString('en-GB', { day:'numeric', month:'short' });
}
