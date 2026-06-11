import React, { useState, useEffect, useCallback } from 'react';

// CrmCompanies — Sales CRM company list + profile (Phase 2, admin / TGA box).
// Talks to /api/crm/companies. Self-contained: holds both the list view and
// the single-company profile view, like the other admin screens.

const GREEN = '#1D9E75';
const GREEN_DARK = '#0F6E56';

const STATUSES = [
  { key: 'suspect',      label: 'Suspect',      bg: '#F1EFE8', color: '#444441' },
  { key: 'prospect',     label: 'Prospect',     bg: '#E6F1FB', color: '#0C447C' },
  { key: 'hot_prospect', label: 'Hot prospect', bg: '#FAEEDA', color: '#854F0B' },
  { key: 'customer',     label: 'Customer',     bg: '#E1F5EE', color: '#0F6E56' },
];
const STATUS_MAP = Object.fromEntries(STATUSES.map(s => [s.key, s]));

const card = { background: '#fff', border: '0.5px solid #e0e0dc', borderRadius: 10 };
const btnPrimary = { background: GREEN, color: '#fff', border: 'none', padding: '8px 16px', borderRadius: 8, fontWeight: 500, fontSize: 13, cursor: 'pointer' };
const btnGhost = { background: '#fff', color: '#444', border: '0.5px solid #d0d0cc', padding: '7px 14px', borderRadius: 8, fontWeight: 500, fontSize: 13, cursor: 'pointer' };
const inputStyle = { width: '100%', boxSizing: 'border-box', padding: '9px 11px', border: '1px solid #d0d0cc', borderRadius: 8, fontSize: 14, outline: 'none', background: '#fff' };
const label = { display: 'block', fontSize: 12, fontWeight: 500, color: '#555', marginBottom: 5 };
const sel = { height: 32, border: '0.5px solid #d0d0cc', borderRadius: 8, background: '#fff', fontSize: 13, padding: '0 8px', color: '#1a1a1a' };

function Pill({ status }) {
  const s = STATUS_MAP[status] || STATUSES[0];
  return <span style={{ fontSize: 11, padding: '2px 9px', borderRadius: 8, background: s.bg, color: s.color, fontWeight: 500 }}>{s.label}</span>;
}

export default function CrmCompanies({ user }) {
  const isSuper = !user || user.is_super || user.access === 'ALL';
  const canTasks = isSuper || !!(user && user.access && user.access.crm_tasks);

  const [companies, setCompanies] = useState([]);
  const [counts, setCounts] = useState({ all: 0 });
  const [statusFilter, setStatusFilter] = useState('all');
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [assignees, setAssignees] = useState([]);

  const [selectedId, setSelectedId] = useState(null);
  const [company, setCompany] = useState(null); // profile
  const [modal, setModal] = useState(null); // 'new' | companyObj | null
  const [tab, setTab] = useState('details');
  const [contacts, setContacts] = useState([]);
  const [contactModal, setContactModal] = useState(null); // 'new' | contactObj | null
  const [history, setHistory] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [taskModal, setTaskModal] = useState(null); // 'new' | taskObj | null

  const loadContacts = useCallback(async (companyId) => {
    try { const r = await fetch('/api/crm/contacts?company_id=' + companyId); if (r.ok) { const d = await r.json(); setContacts(d.contacts || []); } } catch {}
  }, []);
  const loadHistory = useCallback(async (companyId) => {
    try { const r = await fetch('/api/crm/history?company_id=' + companyId); if (r.ok) { const d = await r.json(); setHistory(d.history || []); } } catch {}
  }, []);
  const loadTasks = useCallback(async (companyId) => {
    try { const r = await fetch('/api/crm/tasks?company_id=' + companyId); if (r.ok) { const d = await r.json(); setTasks(d.tasks || []); } } catch {}
  }, []);
  useEffect(() => { if (company) { loadContacts(company.id); loadHistory(company.id); if (canTasks) loadTasks(company.id); } }, [company, canTasks, loadContacts, loadHistory, loadTasks]);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (q.trim()) params.set('q', q.trim());
      const r = await fetch('/api/crm/companies?' + params.toString());
      if (r.ok) { const d = await r.json(); setCompanies(d.companies || []); setCounts(d.counts || { all: 0 }); }
    } catch {}
    setLoading(false);
  }, [statusFilter, q]);

  useEffect(() => { const t = setTimeout(loadList, q ? 250 : 0); return () => clearTimeout(t); }, [loadList, q]);

  useEffect(() => {
    fetch('/api/crm/companies/assignees').then(r => r.ok ? r.json() : null).then(d => { if (d) setAssignees(d.assignees || []); }).catch(() => {});
  }, []);

  async function openCompany(id) {
    setSelectedId(id); setCompany(null); setTab('details'); setContacts([]); setHistory([]); setTasks([]);
    try { const r = await fetch('/api/crm/companies/' + id); if (r.ok) { const d = await r.json(); setCompany(d.company); } } catch {}
  }

  async function patchCompany(id, patch) {
    try {
      const r = await fetch('/api/crm/companies/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
      if (r.ok) { const d = await r.json(); setCompany(d.company); }
    } catch {}
  }

  async function removeCompany(c) {
    if (!window.confirm(`Delete ${c.name}? This can't be undone.`)) return;
    await fetch('/api/crm/companies/' + c.id, { method: 'DELETE' });
    setSelectedId(null); setCompany(null); loadList();
  }

  // ── Profile view ────────────────────────────────────────────────────────
  if (selectedId) {
    return (
      <div style={{ flex: 1, overflow: 'auto', padding: 28 }}>
        <button style={{ background: 'none', border: 'none', color: '#666', fontSize: 13, cursor: 'pointer', padding: 0, marginBottom: 12 }} onClick={() => { setSelectedId(null); setCompany(null); loadList(); }}>← Companies</button>
        {!company ? <div style={{ ...card, padding: 32, color: '#888' }}>Loading…</div> : (
          <div style={{ ...card, padding: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: 19, fontWeight: 500, color: '#1a1a1a' }}>{company.name}</div>
                <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>{company.category ? company.category + ' · ' : ''}added {new Date(company.created_at.replace(' ', 'T') + 'Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</div>
              </div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <div><div style={{ fontSize: 11, color: '#999', marginBottom: 2 }}>Status</div>
                  <select style={sel} value={company.status} onChange={e => patchCompany(company.id, { status: e.target.value })}>
                    {STATUSES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
                  </select>
                </div>
                <div><div style={{ fontSize: 11, color: '#999', marginBottom: 2 }}>Account manager</div>
                  <select style={sel} value={company.account_manager_id || ''} onChange={e => patchCompany(company.id, { account_manager_id: e.target.value || null })}>
                    <option value="">Unassigned</option>
                    {assignees.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </div>
                <button style={btnGhost} onClick={() => setModal(company)}>Edit</button>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 4, borderBottom: '0.5px solid #eee', margin: '16px 0 16px', flexWrap: 'wrap' }}>
              {[
                { key: 'details', label: 'Details', on: true },
                { key: 'contacts', label: 'Contacts', on: true },
                { key: 'history', label: 'History', on: true },
                { key: 'tasks', label: 'Tasks', on: canTasks },
                { key: 'deals', label: 'Deals', on: false },
                { key: 'orders', label: 'Orders', on: false },
              ].map(t => t.on ? (
                <span key={t.key} onClick={() => setTab(t.key)} style={{ fontSize: 12, padding: '6px 12px', cursor: 'pointer', fontWeight: tab === t.key ? 500 : 400, color: tab === t.key ? GREEN_DARK : '#666', borderBottom: '2px solid ' + (tab === t.key ? GREEN_DARK : 'transparent') }}>{t.label}{t.key === 'contacts' && contacts.length ? ` (${contacts.length})` : ''}</span>
              ) : (
                <span key={t.key} style={{ fontSize: 12, padding: '6px 12px', color: '#bbb' }}>{t.label}</span>
              ))}
            </div>

            {tab === 'details' && <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '8px 24px' }}>
                <Field label="Website" value={company.website} />
                <Field label="Phone" value={company.phone} />
                <Field label="Address" value={[company.address, company.town, company.postcode].filter(Boolean).join(', ')} />
                <Field label="Category / industry" value={company.category} />
                <Field label="Source" value={company.source} />
              </div>
              <div style={{ marginTop: 6 }}>
                <div style={{ fontSize: 12, color: '#999', marginBottom: 2 }}>Notes</div>
                <div style={{ fontSize: 13, color: '#333', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{company.notes || '—'}</div>
              </div>
            </>}

            {tab === 'contacts' && (
              <ContactsPanel
                contacts={contacts}
                onAdd={() => setContactModal('new')}
                onEdit={(c) => setContactModal(c)}
                onDelete={async (c) => { if (window.confirm(`Remove ${c.name}?`)) { await fetch('/api/crm/contacts/' + c.id, { method: 'DELETE' }); loadContacts(company.id); } }}
              />
            )}

            {tab === 'history' && (
              <HistoryPanel
                history={history}
                onAdd={async (kind, body) => { await fetch('/api/crm/history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ company_id: company.id, kind, body }) }); loadHistory(company.id); }}
                onDelete={async (e) => { if (window.confirm('Delete this entry?')) { await fetch('/api/crm/history/' + e.id, { method: 'DELETE' }); loadHistory(company.id); } }}
              />
            )}

            {tab === 'tasks' && (
              <TasksPanel
                tasks={tasks}
                onAdd={() => setTaskModal('new')}
                onEdit={(t) => setTaskModal(t)}
                onToggle={async (t) => { await fetch('/api/crm/tasks/' + t.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: t.status === 'done' ? 'open' : 'done' }) }); loadTasks(company.id); loadHistory(company.id); }}
                onDelete={async (t) => { if (window.confirm('Delete this task?')) { await fetch('/api/crm/tasks/' + t.id, { method: 'DELETE' }); loadTasks(company.id); } }}
              />
            )}

            <div style={{ borderTop: '0.5px solid #eee', marginTop: 16, paddingTop: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: '#aaa' }}>Deals and Orders activate as we build the later phases.</span>
              <button style={{ ...btnGhost, color: '#A32D2D', borderColor: '#F0997B' }} onClick={() => removeCompany(company)}>Delete</button>
            </div>
          </div>
        )}
        {modal && <CompanyModal mode="edit" company={modal} assignees={assignees} onClose={() => setModal(null)} onSaved={(c) => { setModal(null); setCompany(c); }} />}
        {contactModal && company && <ContactModal mode={contactModal === 'new' ? 'new' : 'edit'} contact={contactModal === 'new' ? null : contactModal} companyId={company.id} onClose={() => setContactModal(null)} onSaved={() => { setContactModal(null); loadContacts(company.id); }} />}
        {taskModal && company && <TaskModal mode={taskModal === 'new' ? 'new' : 'edit'} task={taskModal === 'new' ? null : taskModal} companyId={company.id} assignees={assignees} onClose={() => setTaskModal(null)} onSaved={() => { setTaskModal(null); loadTasks(company.id); }} />}
      </div>
    );
  }

  // ── List view ───────────────────────────────────────────────────────────
  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 28 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <h1 style={{ fontSize: 20, fontWeight: 500, color: '#1a1a1a' }}>Sales CRM</h1>
        <button style={btnPrimary} onClick={() => setModal('new')}>+ Add company</button>
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        <Tab label="All" n={counts.all} on={statusFilter === 'all'} onClick={() => setStatusFilter('all')} />
        {STATUSES.map(s => <Tab key={s.key} label={s.label} n={counts[s.key] || 0} on={statusFilter === s.key} onClick={() => setStatusFilter(s.key)} />)}
      </div>

      <input style={{ ...inputStyle, width: 280, marginBottom: 14 }} placeholder="Search name, town, postcode or account manager…" value={q} onChange={e => setQ(e.target.value)} />

      <div style={{ ...card, overflow: 'hidden' }}>
        {loading ? <div style={{ padding: 32, textAlign: 'center', color: '#888' }}>Loading…</div>
          : companies.length === 0 ? <div style={{ padding: 32, textAlign: 'center', color: '#888' }}>No companies{q || statusFilter !== 'all' ? ' match this filter' : ' yet — click “Add company”'}.</div>
          : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead><tr style={{ textAlign: 'left', color: '#888', fontSize: 12 }}>
                <th style={{ padding: '10px 16px', fontWeight: 500 }}>Company</th>
                <th style={{ padding: '10px 16px', fontWeight: 500 }}>Status</th>
                <th style={{ padding: '10px 16px', fontWeight: 500 }}>Account manager</th>
                <th style={{ padding: '10px 16px', fontWeight: 500 }}>Location</th>
                <th style={{ padding: '10px 16px', fontWeight: 500 }}>Source</th>
              </tr></thead>
              <tbody>
                {companies.map(c => (
                  <tr key={c.id} style={{ borderTop: '0.5px solid #eee', cursor: 'pointer' }} onClick={() => openCompany(c.id)}>
                    <td style={{ padding: '11px 16px', color: '#1a1a1a' }}>{c.name}</td>
                    <td style={{ padding: '11px 16px' }}><Pill status={c.status} /></td>
                    <td style={{ padding: '11px 16px', color: '#666' }}>{c.account_manager_name || '—'}</td>
                    <td style={{ padding: '11px 16px', color: '#666' }}>{[c.town, c.postcode].filter(Boolean).join(', ') || '—'}</td>
                    <td style={{ padding: '11px 16px', color: '#666' }}>{c.source || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>

      {modal && <CompanyModal mode="new" assignees={assignees} onClose={() => setModal(null)} onSaved={() => { setModal(null); loadList(); }} />}
    </div>
  );
}

function Field({ label, value }) {
  return <div><div style={{ fontSize: 12, color: '#999', marginBottom: 2 }}>{label}</div><div style={{ fontSize: 13, color: '#1a1a1a', marginBottom: 12 }}>{value || '—'}</div></div>;
}

function Tab({ label, n, on, onClick }) {
  return (
    <button onClick={onClick} style={{
      fontSize: 12, padding: '6px 12px', borderRadius: 8, cursor: 'pointer',
      border: '0.5px solid ' + (on ? GREEN_DARK : '#d0d0cc'),
      background: on ? GREEN_DARK : '#fff', color: on ? '#fff' : '#666', fontWeight: 500,
    }}>{label} {n}</button>
  );
}

// ── Add / edit modal ──────────────────────────────────────────────────────
function CompanyModal({ mode, company, assignees, onClose, onSaved }) {
  const [f, setF] = useState({
    name: company?.name || '', status: company?.status || 'suspect',
    account_manager_id: company?.account_manager_id || '',
    website: company?.website || '', phone: company?.phone || '',
    address: company?.address || '', town: company?.town || '', postcode: company?.postcode || '',
    category: company?.category || '', source: company?.source || '', notes: company?.notes || '',
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF(s => ({ ...s, [k]: e.target.value }));

  async function save() {
    if (!f.name.trim()) { setErr('Company name is required'); return; }
    setBusy(true); setErr('');
    try {
      const body = { ...f, account_manager_id: f.account_manager_id || null };
      const r = mode === 'new'
        ? await fetch('/api/crm/companies', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        : await fetch('/api/crm/companies/' + company.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json();
      if (!r.ok) { setErr(d.error || 'Could not save'); setBusy(false); return; }
      onSaved(d.company);
    } catch { setErr('Could not reach the server'); setBusy(false); }
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: 20 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 12, padding: 26, width: 'min(620px, 94vw)', maxHeight: '88vh', overflow: 'auto', boxShadow: '0 4px 24px rgba(0,0,0,0.15)' }}>
        <div style={{ fontSize: 16, fontWeight: 500, color: '#1a1a1a', marginBottom: 16 }}>{mode === 'new' ? 'Add company' : 'Edit ' + company.name}</div>

        <div style={{ marginBottom: 12 }}><label style={label}>Company name *</label><input style={inputStyle} value={f.name} onChange={set('name')} autoFocus /></div>

        <div style={{ display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 150 }}><label style={label}>Status</label>
            <select style={{ ...inputStyle, height: 38 }} value={f.status} onChange={set('status')}>{STATUSES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}</select>
          </div>
          <div style={{ flex: 1, minWidth: 150 }}><label style={label}>Account manager</label>
            <select style={{ ...inputStyle, height: 38 }} value={f.account_manager_id} onChange={set('account_manager_id')}>
              <option value="">Unassigned</option>
              {assignees.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 150 }}><label style={label}>Website</label><input style={inputStyle} value={f.website} onChange={set('website')} /></div>
          <div style={{ flex: 1, minWidth: 150 }}><label style={label}>Phone</label><input style={inputStyle} value={f.phone} onChange={set('phone')} /></div>
        </div>

        <div style={{ marginBottom: 12 }}><label style={label}>Address</label><input style={inputStyle} value={f.address} onChange={set('address')} placeholder="Street / building" /></div>
        <div style={{ display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 150 }}><label style={label}>Town</label><input style={inputStyle} value={f.town} onChange={set('town')} /></div>
          <div style={{ flex: 1, minWidth: 150 }}><label style={label}>Postcode</label><input style={inputStyle} value={f.postcode} onChange={set('postcode')} /></div>
        </div>

        <div style={{ display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 150 }}><label style={label}>Category / industry</label><input style={inputStyle} value={f.category} onChange={set('category')} /></div>
          <div style={{ flex: 1, minWidth: 150 }}><label style={label}>Source</label><input style={inputStyle} value={f.source} onChange={set('source')} placeholder="Website, referral, cold email…" /></div>
        </div>

        <div style={{ marginBottom: 12 }}><label style={label}>Notes</label><textarea style={{ ...inputStyle, minHeight: 80, resize: 'vertical', fontFamily: 'inherit' }} value={f.notes} onChange={set('notes')} /></div>

        {err && <div style={{ color: '#c0392b', fontSize: 13, marginBottom: 10 }}>{err}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button style={btnGhost} onClick={onClose}>Cancel</button>
          <button style={{ ...btnPrimary, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={save}>{busy ? 'Saving…' : (mode === 'new' ? 'Add company' : 'Save changes')}</button>
        </div>
      </div>
    </div>
  );
}

// ── Contacts tab panel ────────────────────────────────────────────────────
function ContactsPanel({ contacts, onAdd, onEdit, onDelete }) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 13, color: '#666' }}>{contacts.length} contact{contacts.length === 1 ? '' : 's'}</span>
        <button style={{ ...btnPrimary, height: 30, padding: '0 12px', fontSize: 12 }} onClick={onAdd}>+ Add contact</button>
      </div>
      {contacts.length === 0 ? (
        <div style={{ padding: '24px 0', textAlign: 'center', color: '#999', fontSize: 13 }}>No contacts yet — add the people you deal with at this company.</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead><tr style={{ textAlign: 'left', color: '#888', fontSize: 12 }}>
            <th style={{ padding: '8px 8px', fontWeight: 500 }}>Name</th>
            <th style={{ padding: '8px 8px', fontWeight: 500 }}>Role</th>
            <th style={{ padding: '8px 8px', fontWeight: 500 }}>Email</th>
            <th style={{ padding: '8px 8px', fontWeight: 500 }}>Phone</th>
            <th style={{ padding: '8px 8px', fontWeight: 500 }}></th>
          </tr></thead>
          <tbody>
            {contacts.map(c => (
              <tr key={c.id} style={{ borderTop: '0.5px solid #eee' }}>
                <td style={{ padding: '10px 8px', color: '#1a1a1a' }}>{c.name}{c.is_decision_maker ? <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 8, background: '#E1F5EE', color: GREEN_DARK, fontWeight: 500, marginLeft: 8 }}>Decision-maker</span> : null}</td>
                <td style={{ padding: '10px 8px', color: '#666' }}>{c.role || '—'}</td>
                <td style={{ padding: '10px 8px', color: '#666' }}>{c.email || '—'}</td>
                <td style={{ padding: '10px 8px', color: '#666' }}>{c.phone || '—'}</td>
                <td style={{ padding: '10px 8px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button style={{ ...btnGhost, padding: '4px 10px' }} onClick={() => onEdit(c)}>Edit</button>
                  <button style={{ ...btnGhost, padding: '4px 10px', marginLeft: 6, color: '#A32D2D', borderColor: '#F0997B' }} onClick={() => onDelete(c)}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── Add / edit contact modal ──────────────────────────────────────────────
function ContactModal({ mode, contact, companyId, onClose, onSaved }) {
  const [f, setF] = useState({
    name: contact?.name || '', role: contact?.role || '', email: contact?.email || '',
    phone: contact?.phone || '', is_decision_maker: contact ? !!contact.is_decision_maker : false,
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF(s => ({ ...s, [k]: e.target.value }));

  async function save() {
    if (!f.name.trim()) { setErr('Contact name is required'); return; }
    setBusy(true); setErr('');
    try {
      const body = { ...f, company_id: companyId };
      const r = mode === 'new'
        ? await fetch('/api/crm/contacts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        : await fetch('/api/crm/contacts/' + contact.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json();
      if (!r.ok) { setErr(d.error || 'Could not save'); setBusy(false); return; }
      onSaved();
    } catch { setErr('Could not reach the server'); setBusy(false); }
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: 20 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 12, padding: 26, width: 'min(520px, 94vw)', maxHeight: '88vh', overflow: 'auto', boxShadow: '0 4px 24px rgba(0,0,0,0.15)' }}>
        <div style={{ fontSize: 16, fontWeight: 500, color: '#1a1a1a', marginBottom: 16 }}>{mode === 'new' ? 'Add contact' : 'Edit contact'}</div>
        <div style={{ marginBottom: 12 }}><label style={label}>Name *</label><input style={inputStyle} value={f.name} onChange={set('name')} autoFocus /></div>
        <div style={{ marginBottom: 12 }}><label style={label}>Role / job title</label><input style={inputStyle} value={f.role} onChange={set('role')} /></div>
        <div style={{ display: 'flex', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 150 }}><label style={label}>Email</label><input style={inputStyle} value={f.email} onChange={set('email')} /></div>
          <div style={{ flex: 1, minWidth: 150 }}><label style={label}>Phone</label><input style={inputStyle} value={f.phone} onChange={set('phone')} /></div>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 14, cursor: 'pointer', marginBottom: 4 }}>
          <input type="checkbox" checked={f.is_decision_maker} onChange={e => setF(s => ({ ...s, is_decision_maker: e.target.checked }))} style={{ accentColor: GREEN_DARK, width: 16, height: 16 }} />
          Decision-maker
        </label>
        {err && <div style={{ color: '#c0392b', fontSize: 13, marginTop: 10 }}>{err}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
          <button style={btnGhost} onClick={onClose}>Cancel</button>
          <button style={{ ...btnPrimary, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={save}>{busy ? 'Saving…' : (mode === 'new' ? 'Add contact' : 'Save changes')}</button>
        </div>
      </div>
    </div>
  );
}

// ── History tab panel ─────────────────────────────────────────────────────
const KIND_META = {
  note:          { label: 'Note',          color: '#555' },
  call:          { label: 'Call',          color: '#2E7D32' },
  email:         { label: 'Email',         color: '#0C447C' },
  meeting:       { label: 'Meeting',       color: '#9333EA' },
  status_change: { label: 'Status change', color: '#999' },
  system:        { label: 'Update',        color: '#999' },
};
function fmtWhen(ts) {
  try { return new Date(ts.replace(' ', 'T') + 'Z').toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  catch { return ts; }
}
function HistoryPanel({ history, onAdd, onDelete }) {
  const [kind, setKind] = useState('note');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  async function log() {
    if (!body.trim() || busy) return;
    setBusy(true);
    await onAdd(kind, body.trim());
    setBody(''); setBusy(false);
  }
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
        <select style={{ ...sel, height: 34 }} value={kind} onChange={e => setKind(e.target.value)}>
          <option value="note">Note</option><option value="call">Call</option><option value="email">Email</option><option value="meeting">Meeting</option>
        </select>
        <input style={{ ...inputStyle, height: 34, flex: 1 }} placeholder="What happened?" value={body} onChange={e => setBody(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') log(); }} />
        <button style={{ ...btnPrimary, height: 34, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={log}>Log</button>
      </div>
      {history.length === 0 ? (
        <div style={{ padding: '24px 0', textAlign: 'center', color: '#999', fontSize: 13 }}>No activity yet — log a call, email, meeting or note above.</div>
      ) : (
        <div style={{ marginTop: 8 }}>
          {history.map(e => {
            const m = KIND_META[e.kind] || KIND_META.note;
            return (
              <div key={e.id} style={{ display: 'flex', gap: 11, padding: '12px 0', borderBottom: '0.5px solid #eee' }}>
                <div style={{ width: 9, height: 9, borderRadius: '50%', flex: 'none', marginTop: 5, background: m.color }} />
                <div style={{ flex: 1 }}>
                  <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.03em', color: m.color }}>{m.label}</span>
                  <span style={{ fontSize: 11, color: '#aaa' }}> · {e.author || 'Unknown'} · {fmtWhen(e.created_at)}</span>
                  <div style={{ fontSize: 13, color: '#1a1a1a', lineHeight: 1.5, marginTop: 2, whiteSpace: 'pre-wrap' }}>{e.body}</div>
                </div>
                <button title="Delete" onClick={() => onDelete(e)} style={{ background: 'none', border: 'none', color: '#ccc', cursor: 'pointer', fontSize: 15, lineHeight: 1, alignSelf: 'flex-start' }}>×</button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Tasks tab panel + shared task bits ────────────────────────────────────
const PRIORITY_META = {
  high:   { label: 'High',   bg: '#FBE6E2', color: '#9E2A1E' },
  normal: { label: 'Normal', bg: '#E6F1FB', color: '#0C447C' },
  low:    { label: 'Low',    bg: '#F1EFE8', color: '#5b5b57' },
};
export function PriorityPill({ priority }) {
  const m = PRIORITY_META[priority] || PRIORITY_META.normal;
  return <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 8, background: m.bg, color: m.color, fontWeight: 500 }}>{m.label}</span>;
}
export function fmtDue(due, overdue) {
  if (!due) return { text: '—', over: false };
  let text = due;
  try { text = new Date(due + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); } catch {}
  return { text: overdue ? text + ' (overdue)' : text, over: !!overdue };
}

function TasksPanel({ tasks, onAdd, onEdit, onToggle, onDelete }) {
  const open = tasks.filter(t => t.status !== 'done').length;
  const done = tasks.length - open;
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 13, color: '#666' }}>{open} open · {done} done</span>
        <button style={{ ...btnPrimary, height: 30, padding: '0 12px', fontSize: 12 }} onClick={onAdd}>+ Add task</button>
      </div>
      {tasks.length === 0 ? (
        <div style={{ padding: '24px 0', textAlign: 'center', color: '#999', fontSize: 13 }}>No tasks yet — add one to track the next step.</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead><tr style={{ textAlign: 'left', color: '#888', fontSize: 12 }}>
            <th style={{ padding: '8px 8px', width: 26 }}></th>
            <th style={{ padding: '8px 8px', fontWeight: 500 }}>Task</th>
            <th style={{ padding: '8px 8px', fontWeight: 500 }}>Assignee</th>
            <th style={{ padding: '8px 8px', fontWeight: 500 }}>Due</th>
            <th style={{ padding: '8px 8px', fontWeight: 500 }}>Priority</th>
            <th style={{ padding: '8px 8px', fontWeight: 500 }}></th>
          </tr></thead>
          <tbody>
            {tasks.map(t => {
              const done = t.status === 'done';
              const due = fmtDue(t.due_date, t.overdue);
              return (
                <tr key={t.id} style={{ borderTop: '0.5px solid #eee' }}>
                  <td style={{ padding: '10px 8px' }}><input type="checkbox" checked={done} onChange={() => onToggle(t)} style={{ width: 15, height: 15, accentColor: GREEN_DARK }} /></td>
                  <td style={{ padding: '10px 8px', color: done ? '#aaa' : '#1a1a1a', textDecoration: done ? 'line-through' : 'none' }}>{t.title}</td>
                  <td style={{ padding: '10px 8px', color: '#888' }}>{t.assignee_name || '—'}</td>
                  <td style={{ padding: '10px 8px', color: due.over ? '#9E2A1E' : '#888', fontWeight: due.over ? 500 : 400 }}>{due.text}</td>
                  <td style={{ padding: '10px 8px' }}>{done ? null : <PriorityPill priority={t.priority} />}</td>
                  <td style={{ padding: '10px 8px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button style={{ ...btnGhost, padding: '4px 10px' }} onClick={() => onEdit(t)}>Edit</button>
                    <button style={{ ...btnGhost, padding: '4px 10px', marginLeft: 6, color: '#A32D2D', borderColor: '#F0997B' }} onClick={() => onDelete(t)}>Remove</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── Add / edit task modal ─────────────────────────────────────────────────
export function TaskModal({ mode, task, companyId, assignees, onClose, onSaved }) {
  const [f, setF] = useState({
    title: task?.title || '', assignee_id: task?.assignee_id || '',
    due_date: task?.due_date || '', priority: task?.priority || 'normal',
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF(s => ({ ...s, [k]: e.target.value }));

  async function save() {
    if (!f.title.trim()) { setErr('Task title is required'); return; }
    setBusy(true); setErr('');
    try {
      const body = { ...f, company_id: companyId, assignee_id: f.assignee_id || null };
      const r = mode === 'new'
        ? await fetch('/api/crm/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        : await fetch('/api/crm/tasks/' + task.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json();
      if (!r.ok) { setErr(d.error || 'Could not save'); setBusy(false); return; }
      onSaved();
    } catch { setErr('Could not reach the server'); setBusy(false); }
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: 20 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 12, padding: 26, width: 'min(520px, 94vw)', maxHeight: '88vh', overflow: 'auto', boxShadow: '0 4px 24px rgba(0,0,0,0.15)' }}>
        <div style={{ fontSize: 16, fontWeight: 500, color: '#1a1a1a', marginBottom: 16 }}>{mode === 'new' ? 'Add task' : 'Edit task'}</div>
        <div style={{ marginBottom: 12 }}><label style={label}>Task *</label><input style={inputStyle} value={f.title} onChange={set('title')} autoFocus placeholder="e.g. Send catalogue pricing" /></div>
        <div style={{ display: 'flex', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 140 }}><label style={label}>Assignee</label>
            <select style={{ ...inputStyle, height: 38 }} value={f.assignee_id} onChange={set('assignee_id')}>
              <option value="">Unassigned</option>
              {(assignees || []).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
          <div style={{ flex: 1, minWidth: 140 }}><label style={label}>Due date</label><input type="date" style={{ ...inputStyle, height: 38 }} value={f.due_date} onChange={set('due_date')} /></div>
          <div style={{ flex: 1, minWidth: 110 }}><label style={label}>Priority</label>
            <select style={{ ...inputStyle, height: 38 }} value={f.priority} onChange={set('priority')}>
              <option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option>
            </select>
          </div>
        </div>
        {err && <div style={{ color: '#c0392b', fontSize: 13, marginBottom: 10 }}>{err}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button style={btnGhost} onClick={onClose}>Cancel</button>
          <button style={{ ...btnPrimary, opacity: busy ? 0.6 : 1 }} disabled={busy} onClick={save}>{busy ? 'Saving…' : (mode === 'new' ? 'Add task' : 'Save changes')}</button>
        </div>
      </div>
    </div>
  );
}
