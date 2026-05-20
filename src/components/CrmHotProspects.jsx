// ─────────────────────────────────────────────────────────────────────────────
// CrmHotProspects.jsx — Admin CRM screen for per-customer Hot Prospects.
//
// Mounted by Dashboard.jsx when activeView === 'crm-hot-prospects'.
//
// Layout, top to bottom:
//   - Page heading "Hot prospects" + currently-selected customer in the
//     strap-line.
//   - Customer-switcher badges row. Selected = solid green pill; others =
//     outlined white. Each badge shows initials + name + prospect-count.
//     The selected customer id is persisted in localStorage so the operator
//     returns to the last-viewed customer.
//   - Search input.
//   - Prospect list table. Click a row → detail modal.
//
// Detail modal:
//   - Header (initials avatar, name, email, "Remove from list" button)
//   - Editable follow-up date (debounced 1s auto-save, Clear button)
//   - Editable notes textarea (debounced 1s auto-save)
//   - Email history thread, built live from email_replies + email_outbound
//     by the /:id/thread endpoint. Inbound and outbound messages tagged with
//     a direction icon and sorted oldest-first.
//
// All endpoints under /api/email/hot-prospects/* and behind the standard
// admin Bearer-token middleware (handled by App.jsx's fetch interceptor).
// ─────────────────────────────────────────────────────────────────────────────
import React, { useState, useEffect, useRef } from 'react';

// Theme — matches PortalAdmin.jsx exactly so the section feels native.
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
const DANGER_BG = '#FCEBEB';

// localStorage key for the last-selected customer id. Scoped so a future
// CRM screen with a different table doesn't collide.
const LAST_CUSTOMER_KEY = 'studio.crm.hot_prospects.last_customer_id';
// One-shot key set by other screens (currently EmailSection.jsx's "Open in
// CRM" link in the Send-to-Hot-Prospects banner). We read it on mount,
// auto-open the matching prospect's detail modal, then clear the key so
// subsequent visits to the CRM screen don't repeatedly auto-open it.
const OPEN_PROSPECT_KEY = 'studio.crm.hot_prospects.open_prospect_id';

// ── Small visual helpers ─────────────────────────────────────────────────────

function initials(name) {
  if (!name) return '?';
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Stable pastel palette for avatar backgrounds. Same name → same colour.
const AVATAR_PALETTE = [
  { bg: '#E1F5EE', fg: '#085041' },
  { bg: '#FAECE7', fg: '#712B13' },
  { bg: '#EEEDFE', fg: '#3C3489' },
  { bg: '#FBEAF0', fg: '#72243E' },
  { bg: '#E6F1FB', fg: '#0C447C' },
  { bg: '#FAEEDA', fg: '#633806' },
  { bg: '#EAF3DE', fg: '#27500A' },
];
function avatarColor(seed) {
  if (!seed) return AVATAR_PALETTE[0];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
}

// Relative time helper. ISO-ish 'YYYY-MM-DD HH:MM:SS' (SQLite's
// datetime('now') format) is treated as UTC — append 'Z' before parsing.
// Browsers otherwise parse the space-format as local time and the "added"
// column reads in the wrong timezone.
function relativeTime(value) {
  if (!value) return '';
  let parsed = value;
  if (typeof parsed === 'string' && /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(parsed)) {
    parsed = parsed.replace(' ', 'T') + 'Z';
  }
  const d = new Date(parsed);
  if (isNaN(d.getTime())) return '';
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60)       return 'just now';
  if (diff < 3600)     return `${Math.floor(diff/60)} min ago`;
  if (diff < 86400)    return `${Math.floor(diff/3600)} hour${Math.floor(diff/3600)===1?'':'s'} ago`;
  if (diff < 86400*7)  return `${Math.floor(diff/86400)} day${Math.floor(diff/86400)===1?'':'s'} ago`;
  if (diff < 86400*30) return `${Math.floor(diff/86400/7)} week${Math.floor(diff/86400/7)===1?'':'s'} ago`;
  return d.toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' });
}

// Format a 'YYYY-MM-DD' follow-up date with today/overdue colouring.
function formatFollowUp(value) {
  if (!value) return { label: 'Not set', color: TERTIARY, urgent: false };
  // Parse as local-midnight so timezone slop doesn't shift the day.
  const d = new Date(value + 'T00:00:00');
  if (isNaN(d.getTime())) return { label: value, color: TEXT, urgent: false };
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((d - today) / 86400000);
  if (days < 0)  return { label: `${Math.abs(days)} day${Math.abs(days)===1?'':'s'} overdue`, color: DANGER, urgent: true };
  if (days === 0) return { label: 'Today',    color: AMBER, urgent: true };
  if (days === 1) return { label: 'Tomorrow', color: AMBER, urgent: true };
  if (days <= 7)  return { label: d.toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short' }), color: TEXT, urgent: false };
  return { label: d.toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' }), color: TEXT, urgent: false };
}

// ── Top-level screen ────────────────────────────────────────────────────────

export default function CrmHotProspects() {
  const [customers, setCustomers] = useState(null);   // null = loading, [] = none, [...] = list
  const [selectedCustomerId, setSelectedCustomerId] = useState(null);
  const [prospects, setProspects] = useState(null);   // null = loading, [] = none
  const [hasLinkedInboxes, setHasLinkedInboxes] = useState(false); // server signal: show Inbox column?
  // Sidebar/top-panel due counts — total across all customers. Refreshed
  // alongside the prospect list and any mutation in the detail modal so
  // marking-as-converted updates the panel without a page refresh.
  const [dueCounts, setDueCounts] = useState({ overdue: 0, due_today: 0, total: 0 });
  const [search, setSearch] = useState('');
  const [openProspectId, setOpenProspectId] = useState(null);
  const [error, setError] = useState(null);

  // Load the customer roster once on mount. Restore last-selected customer
  // from localStorage if present, otherwise pick the first one. Also handle
  // the one-shot OPEN_PROSPECT_KEY — if set by another screen (e.g.
  // EmailSection's "Open in CRM" link) we auto-open that prospect's detail
  // modal and clear the key so it only triggers once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/email/hot-prospects/customers');
        const d = await r.json();
        if (cancelled) return;
        if (!r.ok || d.error) { setError(d.error || `HTTP ${r.status}`); setCustomers([]); return; }
        const list = d.customers || [];
        setCustomers(list);
        // Fire the due-counts fetch in parallel — independent of the
        // customer-roster fetch above, so a slow roster query doesn't hold
        // up the panel. Failure silently leaves dueCounts at zero.
        fetchDueCounts();
        if (list.length === 0) return;
        const stored = localStorage.getItem(LAST_CUSTOMER_KEY);
        const found  = stored && list.find(c => c.id === stored);
        setSelectedCustomerId(found ? stored : list[0].id);

        // Consume the one-shot open-prospect handoff. Clear the key as soon
        // as we read it so a later navigation back to this screen doesn't
        // re-open the same prospect.
        try {
          const openId = localStorage.getItem(OPEN_PROSPECT_KEY);
          if (openId) {
            localStorage.removeItem(OPEN_PROSPECT_KEY);
            setOpenProspectId(openId);
          }
        } catch {}
      } catch (e) {
        if (!cancelled) { setError(String(e.message || e)); setCustomers([]); }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch the global due-counts (overdue + today) used by the top panel.
  // Same endpoint feeds the sidebar badge but the sidebar polls separately;
  // here we call it directly so the panel updates the instant a mutation
  // refreshes the screen.
  async function fetchDueCounts() {
    try {
      const r = await fetch('/api/email/hot-prospects/due-counts');
      if (!r.ok) return;
      const d = await r.json();
      setDueCounts({
        overdue: Number(d.overdue || 0),
        due_today: Number(d.due_today || 0),
        total: Number(d.total || 0),
      });
    } catch {}
  }

  // Re-load prospects whenever the selected customer changes.
  useEffect(() => {
    if (!selectedCustomerId) return;
    localStorage.setItem(LAST_CUSTOMER_KEY, selectedCustomerId);
    setProspects(null);
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/email/hot-prospects?email_client_id=${encodeURIComponent(selectedCustomerId)}`);
        const d = await r.json();
        if (cancelled) return;
        if (!r.ok || d.error) { setProspects([]); setHasLinkedInboxes(false); return; }
        setProspects(d.prospects || []);
        setHasLinkedInboxes(!!d.has_linked_inboxes);
      } catch (e) {
        if (!cancelled) { setProspects([]); setHasLinkedInboxes(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [selectedCustomerId]);

  // Refresh both badges (for prospect_count) and prospect list after any
  // detail-modal mutation (add / update / delete / mark-converted / reopen).
  // Also re-fetches the global due-counts AND dispatches a cross-component
  // event so the sidebar badge updates the moment the mutation lands —
  // without waiting for the sidebar's own 30s poll.
  async function refreshAll() {
    try {
      const [cR, pR] = await Promise.all([
        fetch('/api/email/hot-prospects/customers'),
        selectedCustomerId
          ? fetch(`/api/email/hot-prospects?email_client_id=${encodeURIComponent(selectedCustomerId)}`)
          : Promise.resolve(null),
      ]);
      const cD = await cR.json();
      if (cR.ok && !cD.error) setCustomers(cD.customers || []);
      if (pR) {
        const pD = await pR.json();
        if (pR.ok && !pD.error) {
          setProspects(pD.prospects || []);
          setHasLinkedInboxes(!!pD.has_linked_inboxes);
        }
      }
      fetchDueCounts();
      try { window.dispatchEvent(new CustomEvent('studio:hot-prospects-changed')); } catch {}
    } catch {}
  }

  const selectedCustomer = customers?.find(c => c.id === selectedCustomerId) || null;

  const filteredProspects = (() => {
    if (!prospects) return null;
    const q = search.trim().toLowerCase();
    if (!q) return prospects;
    return prospects.filter(p =>
      (p.prospect_name || '').toLowerCase().includes(q)
      || (p.prospect_email || '').toLowerCase().includes(q)
    );
  })();

  return (
    <div style={{ flex:1, overflow:'auto', padding:28 }}>

      <div style={{ marginBottom:18 }}>
        <div style={{ fontSize:11, color:TERTIARY, textTransform:'uppercase', letterSpacing:'0.5px', marginBottom:4 }}>
          CRM {selectedCustomer ? `· ${selectedCustomer.name}` : ''}
        </div>
        <h1 style={{ fontSize:20, fontWeight:500, color:TEXT, margin:0 }}>Hot prospects</h1>
      </div>

      {/* Customer-switcher badges */}
      <CustomerBadges
        customers={customers}
        selectedId={selectedCustomerId}
        onSelect={setSelectedCustomerId}
      />

      {/* Search input */}
      <div style={{ marginTop:18, marginBottom:14, display:'flex', alignItems:'center', justifyContent:'space-between', gap:12 }}>
        <input
          type="text"
          placeholder="Search prospects by name or email…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{
            width:300, maxWidth:'100%', padding:'8px 12px',
            border:`0.5px solid ${BORDER}`, borderRadius:7, fontSize:13,
            color:TEXT, background:CARD, outline:'none',
          }}
        />
        {filteredProspects && (
          <div style={{ fontSize:12, color:MUTED }}>
            {filteredProspects.length} prospect{filteredProspects.length===1?'':'s'}
            {search.trim() && prospects && prospects.length !== filteredProspects.length && (
              <> (of {prospects.length})</>
            )}
          </div>
        )}
      </div>

      {/* Prospect list */}
      {error && (
        <div style={{ background:'#fdecea', borderLeft:`3px solid ${DANGER}`, borderRadius:6, padding:'10px 14px', marginBottom:14, fontSize:13, color:DANGER, lineHeight:1.5 }}>
          Couldn't load CRM: {error}
        </div>
      )}

      {/* Top-of-CRM follow-up panel. Only renders when there are active
          follow-ups due today or overdue across all customers — invisible
          when there's nothing urgent. Aggregated count from the same
          endpoint that drives the sidebar badge. */}
      <FollowUpPanel counts={dueCounts} />

      <ProspectList
        prospects={filteredProspects}
        onOpen={setOpenProspectId}
        empty={prospects && prospects.length === 0}
        showInboxColumn={hasLinkedInboxes}
      />

      {/* Detail modal */}
      {openProspectId && (
        <ProspectDetailModal
          prospectId={openProspectId}
          onClose={() => setOpenProspectId(null)}
          onChange={refreshAll}
        />
      )}

    </div>
  );
}

// ── Customer-switcher badges ─────────────────────────────────────────────────

function CustomerBadges({ customers, selectedId, onSelect }) {
  if (customers === null) {
    return <div style={{ fontSize:13, color:MUTED }}>Loading customers…</div>;
  }
  if (customers.length === 0) {
    return (
      <div style={{
        background:CARD, border:`0.5px dashed ${BORDER}`, borderRadius:8,
        padding:20, fontSize:13, color:MUTED, textAlign:'center',
      }}>
        No customers yet. Add an AWS-verified domain or enable a portal customer first.
      </div>
    );
  }
  return (
    <div style={{ display:'flex', flexWrap:'wrap', gap:8 }}>
      {customers.map(c => {
        const isSelected = c.id === selectedId;
        const av = avatarColor(c.name || c.id);
        return (
          <button
            key={c.id}
            onClick={() => onSelect(c.id)}
            style={{
              display:'flex', alignItems:'center', gap:8,
              padding:'7px 14px 7px 10px',
              background: isSelected ? GREEN_HI : CARD,
              border: isSelected ? `0.5px solid ${GREEN_HI}` : `0.5px solid ${BORDER}`,
              borderRadius:999,
              fontSize:13, fontWeight: isSelected ? 500 : 400,
              color: isSelected ? '#fff' : TEXT,
              cursor:'pointer',
              fontFamily:'inherit',
            }}
            title={c.name}
          >
            <div style={{
              width:22, height:22, borderRadius:'50%',
              background: isSelected ? 'rgba(255,255,255,0.18)' : av.bg,
              color: isSelected ? '#fff' : av.fg,
              display:'flex', alignItems:'center', justifyContent:'center',
              fontSize:10, fontWeight:500,
            }}>{initials(c.name)}</div>
            <span>{c.name}</span>
            <span style={{
              background: isSelected ? 'rgba(255,255,255,0.22)' : BG,
              color: isSelected ? '#fff' : MUTED,
              fontSize:11, padding:'1px 7px', borderRadius:999,
            }}>{c.prospect_count || 0}</span>
          </button>
        );
      })}
    </div>
  );
}

// ── Prospect list (table) ────────────────────────────────────────────────────

function ProspectList({ prospects, onOpen, empty, showInboxColumn }) {
  if (prospects === null) {
    return <div style={{ fontSize:13, color:MUTED, padding:'20px 0' }}>Loading prospects…</div>;
  }
  if (empty) {
    return (
      <div style={{
        background:CARD, border:`0.5px dashed ${BORDER}`, borderRadius:8,
        padding:'48px 24px', textAlign:'center', fontSize:14, color:MUTED,
      }}>
        <div style={{ fontSize:15, color:TEXT, marginBottom:6 }}>No prospects yet</div>
        <div style={{ fontSize:13, color:MUTED, lineHeight:1.5, maxWidth:480, margin:'0 auto' }}>
          Open an email in the Mailboxes inbox and click <strong style={{ fontWeight:500 }}>Send to Hot Prospects</strong> to add the sender here.
        </div>
      </div>
    );
  }
  if (prospects.length === 0) {
    return <div style={{ fontSize:13, color:MUTED, padding:'20px 0' }}>No matches.</div>;
  }
  // Grid template: when the Inbox column is visible we add a 1.2fr column
  // between Email and Added, and trim Name/Email slightly so the row still
  // fits at the standard CRM screen width.
  const gridCols = showInboxColumn
    ? '1.7fr 1.6fr 1.3fr 0.9fr 0.9fr 32px'
    : '2fr 1.8fr 1.2fr 1.2fr 32px';
  return (
    <div style={{
      background:CARD, border:`0.5px solid ${BORDER}`, borderRadius:8,
      overflow:'hidden',
    }}>
      {/* Header row */}
      <div style={{
        display:'grid',
        gridTemplateColumns: gridCols,
        gap:12, padding:'10px 16px',
        background:BG, borderBottom:`0.5px solid ${BORDER}`,
        fontSize:11, fontWeight:500, color:MUTED,
        textTransform:'uppercase', letterSpacing:'0.5px',
      }}>
        <div>Name</div>
        <div>Email</div>
        {showInboxColumn && <div>Inbox</div>}
        <div>Added</div>
        <div>Follow up</div>
        <div />
      </div>

      {(() => {
        // Find the index of the first converted prospect — server already
        // orders converted rows last, so this is just the first row with
        // closed_at !== null. If none are converted, firstClosed === -1 and
        // the divider isn't rendered.
        const firstClosed = prospects.findIndex(p => p.closed_at);
        const convertedCount = firstClosed >= 0 ? (prospects.length - firstClosed) : 0;
        return prospects.map((p, idx) => {
          const showDividerBefore = firstClosed >= 0 && idx === firstClosed;
          return (
            <React.Fragment key={p.id}>
              {showDividerBefore && (
                <div style={{
                  padding:'8px 16px',
                  background:'#f9faf7',
                  fontSize:11,
                  textTransform:'uppercase',
                  letterSpacing:'0.5px',
                  color:TERTIARY,
                  borderTop:`0.5px solid ${BORDER}`,
                  borderBottom:`0.5px solid ${BORDER}`,
                }}>Converted ({convertedCount})</div>
              )}
              <ProspectRow
                prospect={p}
                isLast={idx === prospects.length - 1}
                onOpen={() => onOpen(p.id)}
                showInboxColumn={showInboxColumn}
                gridCols={gridCols}
              />
            </React.Fragment>
          );
        });
      })()}
    </div>
  );
}

function ProspectRow({ prospect, isLast, onOpen, showInboxColumn, gridCols }) {
  const av = avatarColor(prospect.prospect_name || prospect.prospect_email);
  const fu = formatFollowUp(prospect.follow_up_date);
  const isConverted = !!prospect.closed_at;
  return (
    <div
      onClick={onOpen}
      style={{
        display:'grid',
        gridTemplateColumns: gridCols,
        gap:12, padding:'14px 16px', alignItems:'center',
        borderBottom: isLast ? 'none' : `0.5px solid ${BORDER}`,
        cursor:'pointer',
        // Faint tint on converted rows so they're visually de-emphasised
        // without being hidden. Matches the mockup.
        background: isConverted ? '#f9faf7' : 'transparent',
      }}
    >
      <div style={{ display:'flex', alignItems:'center', gap:10, minWidth:0 }}>
        <div style={{
          width:32, height:32, borderRadius:'50%',
          background: av.bg, color: av.fg,
          display:'flex', alignItems:'center', justifyContent:'center',
          fontSize:12, fontWeight:500, flexShrink:0,
        }}>{initials(prospect.prospect_name || prospect.prospect_email)}</div>
        <div style={{
          display:'flex', alignItems:'center', gap:8, minWidth:0, flex:1,
        }}>
          <div style={{
            fontSize:14, fontWeight:500, color:TEXT,
            overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',
            minWidth:0, flex:'0 1 auto',
          }}>{prospect.prospect_name || <span style={{ color:MUTED, fontWeight:400 }}>(no name)</span>}</div>
          {isConverted && (
            <span style={{
              background: GREEN_BG, color: GREEN_HI,
              fontSize:11, padding:'1px 7px', borderRadius:999,
              fontWeight:500, flexShrink:0,
            }}>✓ Converted</span>
          )}
        </div>
      </div>
      <div style={{
        fontSize:13, color:MUTED,
        overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',
      }}>{prospect.prospect_email}</div>
      {showInboxColumn && (
        <div style={{ minWidth:0 }}>
          {prospect.source_inbox_name && (
            <span style={{
              background: GREEN_BG, color: GREEN_HI,
              fontSize:11, padding:'2px 8px', borderRadius:999,
              overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',
              display:'inline-block', maxWidth:'100%',
            }}>{prospect.source_inbox_name}</span>
          )}
        </div>
      )}
      <div style={{ fontSize:13, color:MUTED }}>{relativeTime(prospect.added_at)}</div>
      <div style={{ fontSize:13, color: fu.color, fontWeight: fu.urgent ? 500 : 400 }}>{fu.label}</div>
      <div style={{ textAlign:'right', color:TERTIARY, fontSize:18 }}>›</div>
    </div>
  );
}

// ── Top-of-CRM follow-up panel ───────────────────────────────────────────────
// Renders the urgent-count summary above the prospect list. Hidden entirely
// when there's nothing to action — no value in showing "0 follow-ups". Counts
// here are global (across all customers) to match the sidebar badge.

function FollowUpPanel({ counts }) {
  const { overdue, due_today: dueToday, total } = counts || { overdue:0, due_today:0, total:0 };
  if (!total) return null;
  // Color: red if anything overdue, amber if only-today.
  const urgent = overdue > 0;
  const bg = urgent ? DANGER_BG : AMBER_BG;
  const borderColor = urgent ? '#F09595' : '#EF9F27';
  const textColor = urgent ? '#501313' : '#412402';
  // Compose a single sentence describing the state.
  const parts = [];
  if (overdue > 0)  parts.push(`${overdue} overdue`);
  if (dueToday > 0) parts.push(`${dueToday} due today`);
  return (
    <div style={{
      background: bg, border:`0.5px solid ${borderColor}`,
      borderRadius:8, padding:'12px 16px', marginBottom:14,
      fontSize:13, color: textColor,
    }}>
      <strong style={{ fontWeight:500 }}>{total} follow-up{total===1?'':'s'} need{total===1?'s':''} attention.</strong>{' '}
      {parts.join(', ')}.
    </div>
  );
}

// ── Prospect detail modal ────────────────────────────────────────────────────

function ProspectDetailModal({ prospectId, onClose, onChange }) {
  const [data, setData] = useState(null);   // { prospect, thread }
  const [busy, setBusy] = useState(false);
  const [followUp, setFollowUp] = useState('');
  const [notes, setNotes] = useState('');
  const [savingState, setSavingState] = useState(''); // '', 'saving', 'saved'
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState(null);
  // Tracks the mark-as-converted / reopen network call. Single state — only
  // one of the two buttons is visible at a time (depends on closed_at), so
  // one busy flag covers both transitions.
  const [markBusy, setMarkBusy] = useState(false);
  const [markError, setMarkError] = useState(null);

  // Fetch the prospect + its thread on open.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/email/hot-prospects/${encodeURIComponent(prospectId)}/thread`);
        const d = await r.json();
        if (cancelled) return;
        if (!r.ok || d.error) { setData({ error: d.error || `HTTP ${r.status}` }); return; }
        setData(d);
        setFollowUp(d.prospect.follow_up_date || '');
        setNotes(d.prospect.notes || '');
      } catch (e) {
        if (!cancelled) setData({ error: String(e.message || e) });
      }
    })();
    return () => { cancelled = true; };
  }, [prospectId]);

  // Debounced auto-save for follow-up date and notes. 1-second window —
  // generous enough that the operator can finish typing a date or sentence
  // without spamming the API.
  const initialLoadRef = useRef(true);
  useEffect(() => {
    if (!data || data.error) return;
    if (initialLoadRef.current) {
      // First effect fires from the initial setFollowUp/setNotes inside the
      // fetch — skip that so we don't no-op-save the values we just loaded.
      initialLoadRef.current = false;
      return;
    }
    const original = data.prospect;
    const nextFollowUp = followUp || null;
    const nextNotes    = notes    || null;
    const fuChanged    = (original.follow_up_date || null) !== nextFollowUp;
    const noteChanged  = (original.notes          || null) !== nextNotes;
    if (!fuChanged && !noteChanged) return;

    setSavingState('saving');
    const t = setTimeout(async () => {
      try {
        const body = {};
        if (fuChanged)   body.follow_up_date = nextFollowUp;
        if (noteChanged) body.notes          = nextNotes;
        const r = await fetch(`/api/email/hot-prospects/${encodeURIComponent(prospectId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const d = await r.json();
        if (!r.ok || d.error) {
          setSavingState('error');
          return;
        }
        // Update the local data so the change-detect on the next keystroke
        // compares against the saved value, not the original-load value.
        setData(prev => prev ? { ...prev, prospect: d.prospect } : prev);
        setSavingState('saved');
        onChange();   // refresh badges + list underneath
        // Clear the "Saved" indicator after a moment.
        setTimeout(() => setSavingState(s => s === 'saved' ? '' : s), 1500);
      } catch (e) {
        setSavingState('error');
      }
    }, 1000);
    return () => clearTimeout(t);
  }, [followUp, notes, prospectId, data, onChange]);

  async function markAsConverted() {
    if (markBusy) return;
    setMarkBusy(true);
    setMarkError(null);
    try {
      const r = await fetch(`/api/email/hot-prospects/${encodeURIComponent(prospectId)}/mark-converted`, { method: 'POST' });
      const d = await r.json();
      if (!r.ok || d.error) {
        setMarkError(d.error || `HTTP ${r.status}`);
        setMarkBusy(false);
        return;
      }
      // Update the local data in-place so the modal swaps to its converted
      // state (banner + Reopen button) without re-fetching.
      setData(prev => prev ? { ...prev, prospect: d.prospect } : prev);
      setMarkBusy(false);
      onChange();   // refresh badges + list + sidebar event
    } catch (e) {
      setMarkError(String(e.message || e));
      setMarkBusy(false);
    }
  }

  async function reopenAsActive() {
    if (markBusy) return;
    setMarkBusy(true);
    setMarkError(null);
    try {
      const r = await fetch(`/api/email/hot-prospects/${encodeURIComponent(prospectId)}/reopen`, { method: 'POST' });
      const d = await r.json();
      if (!r.ok || d.error) {
        setMarkError(d.error || `HTTP ${r.status}`);
        setMarkBusy(false);
        return;
      }
      setData(prev => prev ? { ...prev, prospect: d.prospect } : prev);
      setMarkBusy(false);
      onChange();
    } catch (e) {
      setMarkError(String(e.message || e));
      setMarkBusy(false);
    }
  }

  async function removeFromList() {
    if (!confirm('Remove this prospect from your Hot Prospects list?')) return;
    setRemoveBusy(true);
    setRemoveError(null);
    try {
      const r = await fetch(`/api/email/hot-prospects/${encodeURIComponent(prospectId)}`, { method: 'DELETE' });
      const d = await r.json();
      if (!r.ok || d.error) {
        setRemoveError(d.error || `HTTP ${r.status}`);
        setRemoveBusy(false);
        return;
      }
      onChange();
      onClose();
    } catch (e) {
      setRemoveError(String(e.message || e));
      setRemoveBusy(false);
    }
  }

  return (
    <ModalShell onClose={onClose} wide>
      {!data ? (
        <div style={{ textAlign:'center', padding:30, color:MUTED, fontSize:13 }}>Loading prospect…</div>
      ) : data.error ? (
        <div style={{ background:'#fdecea', borderLeft:`3px solid ${DANGER}`, borderRadius:6, padding:'10px 14px', fontSize:13, color:DANGER }}>
          Couldn't load prospect: {data.error}
        </div>
      ) : (
        <DetailBody
          data={data}
          followUp={followUp} setFollowUp={setFollowUp}
          notes={notes} setNotes={setNotes}
          savingState={savingState}
          onRemove={removeFromList}
          removeBusy={removeBusy}
          removeError={removeError}
          onMarkConverted={markAsConverted}
          onReopen={reopenAsActive}
          markBusy={markBusy}
          markError={markError}
        />
      )}
    </ModalShell>
  );
}

function DetailBody({ data, followUp, setFollowUp, notes, setNotes, savingState, onRemove, removeBusy, removeError, onMarkConverted, onReopen, markBusy, markError }) {
  const p = data.prospect;
  const av = avatarColor(p.prospect_name || p.prospect_email);
  const isConverted = !!p.closed_at;

  // Pretty-print the closed_at for the banner. Stored as 'YYYY-MM-DD HH:MM:SS'
  // in UTC; the relativeTime helper already handles that format gracefully.
  // We also include a friendly absolute date.
  function formatClosedAt(s) {
    if (!s) return '';
    try {
      const d = new Date(String(s).replace(' ', 'T') + 'Z');
      if (isNaN(d.getTime())) return s;
      return d.toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short' }) +
             ' at ' +
             d.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });
    } catch { return s; }
  }

  return (
    <div>
      {/* Converted banner — only when the prospect is closed. Shows when +
          by whom. Hidden while active. */}
      {isConverted && (
        <div style={{
          background: GREEN_BG, border:`0.5px solid #9FE1CB`,
          borderRadius:8, padding:'10px 14px', marginBottom:14,
          fontSize:13, color: GREEN_HI,
        }}>
          <strong style={{ fontWeight:500 }}>✓ Converted</strong> on {formatClosedAt(p.closed_at)}
          {p.closed_by && (
            <> by {(p.closed_by || '').startsWith('portal:') ? 'customer' : 'admin'}</>
          )}.
        </div>
      )}

      {/* Header */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:16, marginBottom:16 }}>
        <div style={{ display:'flex', alignItems:'center', gap:14, minWidth:0 }}>
          <div style={{
            width:48, height:48, borderRadius:'50%',
            background: av.bg, color: av.fg,
            display:'flex', alignItems:'center', justifyContent:'center',
            fontSize:16, fontWeight:500, flexShrink:0,
          }}>{initials(p.prospect_name || p.prospect_email)}</div>
          <div style={{ minWidth:0 }}>
            <div style={{ fontSize:17, fontWeight:500, color:TEXT, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
              {p.prospect_name || <span style={{ color:MUTED, fontWeight:400 }}>(no name)</span>}
            </div>
            <div style={{ fontSize:13, color:MUTED, marginTop:2 }}>{p.prospect_email}</div>
            {/* Source-inbox subtitle: only shown when this prospect is part
                of a linked-inbox customer (i.e. there's something useful to
                disambiguate). Hidden for single-inbox customers. */}
            {p.has_linked_inboxes && p.source_inbox_name && (
              <div style={{ marginTop:4 }}>
                <span style={{
                  background: GREEN_BG, color: GREEN_HI,
                  fontSize:11, padding:'2px 7px', borderRadius:999,
                }}>From {p.source_inbox_name}</span>
              </div>
            )}
          </div>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:8, flexShrink:0 }}>
          {isConverted ? (
            <button
              onClick={onReopen}
              disabled={markBusy}
              style={{
                background:'transparent', color: GREEN_HI,
                border:`0.5px solid ${GREEN_HI}`,
                borderRadius:7, padding:'7px 12px', fontSize:13, fontWeight:500,
                cursor: markBusy ? 'not-allowed' : 'pointer',
                opacity: markBusy ? 0.6 : 1,
                fontFamily:'inherit',
              }}
            >
              {markBusy ? 'Reopening…' : 'Reopen as active'}
            </button>
          ) : (
            <button
              onClick={onMarkConverted}
              disabled={markBusy}
              style={{
                background: GREEN_HI, color:'#fff',
                border:'none',
                borderRadius:7, padding:'7px 12px', fontSize:13, fontWeight:500,
                cursor: markBusy ? 'not-allowed' : 'pointer',
                opacity: markBusy ? 0.6 : 1,
                display:'flex', alignItems:'center', gap:6,
                fontFamily:'inherit',
              }}
            >
              {markBusy ? 'Saving…' : '✓ Mark as converted'}
            </button>
          )}
          <button
            onClick={onRemove}
            disabled={removeBusy}
            style={{
              background:'#fdecea', color:DANGER, border:'none',
              borderRadius:7, padding:'7px 14px', fontSize:13, fontWeight:500,
              cursor: removeBusy ? 'not-allowed' : 'pointer',
              opacity: removeBusy ? 0.6 : 1,
              display:'flex', alignItems:'center', gap:6,
              fontFamily:'inherit',
            }}
          >
            🗑 Remove
          </button>
        </div>
      </div>

      {markError && (
        <div style={{ background:'#fdecea', borderLeft:`3px solid ${DANGER}`, borderRadius:6, padding:'8px 12px', marginBottom:12, fontSize:12, color:DANGER }}>
          {markError}
        </div>
      )}

      {removeError && (
        <div style={{ background:'#fdecea', borderLeft:`3px solid ${DANGER}`, borderRadius:6, padding:'8px 12px', marginBottom:12, fontSize:12, color:DANGER }}>
          {removeError}
        </div>
      )}

      {/* Meta row: added / follow-up */}
      <div style={{
        display:'grid', gridTemplateColumns:'1fr 1fr', gap:16,
        padding:'14px 0', borderTop:`0.5px solid ${BORDER}`, borderBottom:`0.5px solid ${BORDER}`,
        marginBottom:16,
      }}>
        <div>
          <div style={{ fontSize:11, color:TERTIARY, marginBottom:6, textTransform:'uppercase', letterSpacing:'0.5px' }}>Added to list</div>
          <div style={{ fontSize:14, color:TEXT }}>
            {relativeTime(p.added_at)}
            <span style={{ color:MUTED, marginLeft:6, fontSize:12 }}>
              ({(p.added_by || '').startsWith('portal:') ? 'by customer' : 'by admin'})
            </span>
          </div>
        </div>
        <div>
          <div style={{ fontSize:11, color:TERTIARY, marginBottom:6, textTransform:'uppercase', letterSpacing:'0.5px' }}>Follow up on</div>
          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
            <input
              type="date"
              value={followUp}
              onChange={e => setFollowUp(e.target.value)}
              style={{
                fontSize:13, padding:'6px 10px',
                border:`0.5px solid ${BORDER}`, borderRadius:6,
                color:TEXT, background:CARD, outline:'none',
                fontFamily:'inherit',
              }}
            />
            {followUp && (
              <button
                onClick={() => setFollowUp('')}
                style={{
                  fontSize:12, padding:'6px 10px',
                  background:BG, color:MUTED, border:`0.5px solid ${BORDER}`,
                  borderRadius:6, cursor:'pointer', fontFamily:'inherit',
                }}
              >Clear</button>
            )}
          </div>
        </div>
      </div>

      {/* Notes */}
      <div style={{ marginBottom:18 }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:6 }}>
          <div style={{ fontSize:11, color:TERTIARY, textTransform:'uppercase', letterSpacing:'0.5px' }}>Notes</div>
          <div style={{ fontSize:11, color: savingState==='error' ? DANGER : savingState==='saving' ? AMBER : savingState==='saved' ? GREEN : 'transparent' }}>
            {savingState === 'saving' && 'Saving…'}
            {savingState === 'saved'  && '✓ Saved'}
            {savingState === 'error'  && 'Save failed — will retry on next change'}
          </div>
        </div>
        <textarea
          value={notes}
          onChange={e => setNotes(e.target.value)}
          placeholder="Add a note about this prospect…"
          style={{
            width:'100%', minHeight:80, padding:'10px 12px',
            border:`0.5px solid ${BORDER}`, borderRadius:7,
            fontSize:13, color:TEXT, background:CARD, outline:'none',
            boxSizing:'border-box', fontFamily:'inherit',
            resize:'vertical', lineHeight:1.5,
          }}
        />
      </div>

      {/* Thread */}
      <ThreadList thread={data.thread || []} />

    </div>
  );
}

// ── Email thread ─────────────────────────────────────────────────────────────

function ThreadList({ thread }) {
  return (
    <div>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10 }}>
        <div style={{ fontSize:13, fontWeight:500, color:TEXT }}>Email history with this prospect</div>
        <div style={{ fontSize:11, color:TERTIARY }}>
          {thread.length} message{thread.length===1?'':'s'} · auto-updates
        </div>
      </div>
      {thread.length === 0 ? (
        <div style={{
          background:CARD, border:`0.5px dashed ${BORDER}`, borderRadius:7,
          padding:'20px 14px', fontSize:13, color:MUTED, textAlign:'center',
        }}>
          No messages found. The thread builds itself from inbox replies and
          sent replies — new mail will appear here automatically.
        </div>
      ) : (
        thread.map(msg => <ThreadMessage key={`${msg.direction}-${msg.id}`} msg={msg} />)
      )}
    </div>
  );
}

function ThreadMessage({ msg }) {
  const isInbound = msg.direction === 'inbound';
  const arrow = isInbound ? '↩' : '↑';
  const label = isInbound
    ? `From ${msg.from_name || msg.from_address} · ${relativeTime(msg.at)}`
    : `From us · ${relativeTime(msg.at)}`;
  const date = (() => {
    if (!msg.at) return '';
    let v = msg.at;
    if (typeof v === 'string' && /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v)) v = v.replace(' ', 'T') + 'Z';
    const d = new Date(v);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short' })
      + ', ' + d.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });
  })();

  return (
    <div style={{
      border:`0.5px solid ${BORDER}`, borderRadius:7,
      padding:'12px 14px', marginBottom:10,
    }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:6, gap:8 }}>
        <div style={{ display:'flex', alignItems:'center', gap:8, fontSize:12, color:MUTED }}>
          <span style={{ color: isInbound ? BLUE : GREEN }}>{arrow}</span>
          <span>{label}</span>
        </div>
        <div style={{ fontSize:11, color:TERTIARY, whiteSpace:'nowrap' }}>{date}</div>
      </div>
      {msg.subject && (
        <div style={{ fontSize:12, color:TEXT, fontWeight:500, marginBottom:6 }}>{msg.subject}</div>
      )}
      <div style={{
        fontSize:13, color:MUTED, lineHeight:1.6,
        whiteSpace:'pre-wrap',
        maxHeight:240, overflowY:'auto',
      }}>
        {msg.body_text || <em style={{ color:TERTIARY }}>(no plain text body)</em>}
      </div>
      {msg.error && (
        <div style={{ marginTop:8, fontSize:11, color:DANGER }}>
          Send failed: {msg.error}
        </div>
      )}
    </div>
  );
}

// ── Local modal shell ────────────────────────────────────────────────────────
// Self-contained so this file doesn't reach into EmailSection.jsx for its
// Modal primitive — same visual style though.

function ModalShell({ children, onClose, wide }) {
  return (
    <div style={{
      position:'fixed', inset:0, background:'rgba(0,0,0,0.35)',
      display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000,
    }}>
      <div style={{
        background:CARD, borderRadius:12, padding:28,
        width: wide ? 800 : 480, maxWidth:'95vw', maxHeight:'90vh',
        overflowY:'auto', boxShadow:'0 8px 40px rgba(0,0,0,0.15)',
      }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:20 }}>
          <h2 style={{ fontSize:16, fontWeight:500, color:TEXT, margin:0 }}>Hot prospect</h2>
          <button
            onClick={onClose}
            style={{ background:'none', border:'none', fontSize:22, color:MUTED, cursor:'pointer', lineHeight:1 }}
          >×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
