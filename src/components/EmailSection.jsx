import React, { useState, useEffect, useRef } from 'react';

const GREEN='#1D9E75',DARK='#0F6E56',BG='#f5f5f3',CARD='#fff',BORDER='#e0e0dc',TEXT='#1a1a1a',MUTED='#888',DANGER='#c0392b',AMBER='#854F0B',BLUE='#185FA5';
const BRAND_COLORS=['#1D9E75','#0F6E56','#534AB7','#185FA5','#993C1D','#854F0B','#3B6D11','#D4537E','#5F5E5A'];
function initials(n=''){return n.split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2)||'?';}

function Btn({children,onClick,variant='default',small,disabled,style={}}){
  const v={default:{background:'#f0f0ed',color:TEXT},primary:{background:GREEN,color:'#fff'},danger:{background:'#fdecea',color:DANGER},amber:{background:'#fff3cd',color:AMBER},blue:{background:'#e6f1fb',color:BLUE}};
  return <button onClick={onClick} disabled={disabled} style={{border:'none',borderRadius:7,cursor:disabled?'not-allowed':'pointer',fontWeight:500,fontSize:small?11:13,padding:small?'4px 10px':'8px 18px',opacity:disabled?0.5:1,...v[variant],...style}}>{children}</button>;
}
function Input({label,value,onChange,placeholder,type='text',required,rows,style={}}){
  const base={width:'100%',padding:'8px 12px',border:`0.5px solid ${BORDER}`,borderRadius:7,fontSize:13,color:TEXT,background:CARD,outline:'none',boxSizing:'border-box',...style};
  return(<div style={{marginBottom:14}}>{label&&<label style={{display:'block',fontSize:12,color:MUTED,marginBottom:4}}>{label}{required&&' *'}</label>}{rows?<textarea value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder} rows={rows} style={{...base,fontFamily:'monospace',resize:'vertical'}}/>:<input type={type} value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder} style={base}/>}</div>);
}
function Badge({label,color=GREEN,bg}){return <span style={{fontSize:11,padding:'2px 8px',borderRadius:20,fontWeight:500,background:bg||`${color}18`,color,whiteSpace:'nowrap'}}>{label}</span>;}
function statusBadge(s){
  const m={draft:{l:'Draft',c:MUTED,b:'#f0f0ed'},scheduled:{l:'Scheduled',c:AMBER,b:'#fff3cd'},sending:{l:'Sending',c:GREEN,b:`${GREEN}15`},paused:{l:'Paused',c:AMBER,b:'#fff3cd'},sent:{l:'Sent',c:BLUE,b:'#e6f1fb'},failed:{l:'Failed',c:DANGER,b:'#fdecea'}};
  const x=m[s]||{l:s,c:MUTED,b:'#f0f0ed'};
  return <Badge label={x.l} color={x.c} bg={x.b}/>;
}
function subBadge(s){
  if(s==='subscribed') return <Badge label="Subscribed" color={GREEN} bg={`${GREEN}18`}/>;
  if(s==='bounced')    return <Badge label="Bounced" color={DANGER} bg="#fdecea"/>;
  if(s==='unsubscribed') return <Badge label="Unsubscribed" color={AMBER} bg="#fff3cd"/>;
  if(s==='spam')       return <Badge label="Spam" color={DANGER} bg="#fdecea"/>;
  return <Badge label={s} color={MUTED}/>;
}
function Modal({title,children,onClose,wide}){
  return(<div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.35)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:1000}}>
    <div style={{background:CARD,borderRadius:12,padding:28,width:wide?800:480,maxWidth:'95vw',maxHeight:'90vh',overflowY:'auto',boxShadow:'0 8px 40px rgba(0,0,0,0.15)'}}>
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:20}}>
        <h2 style={{fontSize:16,fontWeight:500,color:TEXT}}>{title}</h2>
        <button onClick={onClose} style={{background:'none',border:'none',fontSize:22,color:MUTED,cursor:'pointer',lineHeight:1}}>×</button>
      </div>
      {children}
    </div>
  </div>);
}
const TH=({children,w})=><th style={{textAlign:'left',padding:'8px 14px',fontSize:11,fontWeight:500,color:MUTED,background:BG,borderBottom:`0.5px solid ${BORDER}`,whiteSpace:'nowrap',width:w}}>{children}</th>;
const TD=({children,muted,center})=><td style={{padding:'9px 14px',fontSize:12,color:muted?MUTED:TEXT,textAlign:center?'center':'left',borderBottom:`0.5px solid ${BORDER}`,verticalAlign:'middle'}}>{children}</td>;

// ── Client modal ──────────────────────────────────────────────────────────────
function ClientModal({initial,onClose,onSaved}){
  const editing=!!initial?.id;
  const [name,setName]=useState(initial?.name||'');
  const [color,setColor]=useState(initial?.color||'#1D9E75');
  const [saving,setSaving]=useState(false);
  const [err,setErr]=useState('');
  async function save(){
    if(!name.trim()){setErr('Name required');return;}
    setSaving(true);
    const r=await fetch(editing?`/api/email/clients/${initial.id}`:'/api/email/clients',{method:editing?'PUT':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,color})});
    const d=await r.json();
    if(d.error){setErr(d.error);setSaving(false);return;}
    onSaved();onClose();
  }
  return(<Modal title={editing?'Edit client':'New client'} onClose={onClose}>
    <Input label="Client name *" value={name} onChange={setName} placeholder="e.g. Sweetbyte" required/>
    <div style={{marginBottom:14}}>
      <label style={{display:'block',fontSize:12,color:MUTED,marginBottom:6}}>Colour</label>
      <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>{BRAND_COLORS.map(c=><div key={c} onClick={()=>setColor(c)} style={{width:24,height:24,borderRadius:6,background:c,cursor:'pointer',border:color===c?`2px solid ${TEXT}`:'2px solid transparent'}}/>)}</div>
    </div>
    {err&&<div style={{color:DANGER,fontSize:13,marginBottom:10}}>{err}</div>}
    <div style={{display:'flex',justifyContent:'flex-end',gap:8}}><Btn onClick={onClose}>Cancel</Btn><Btn variant="primary" onClick={save} disabled={saving}>{saving?'Saving…':editing?'Save changes':'Create client'}</Btn></div>
  </Modal>);
}

// ── List modal ────────────────────────────────────────────────────────────────
function ListModal({emailClient,onClose,onSaved}){
  const [form,setForm]=useState({name:'',from_name:'',from_email:'',reply_to:''});
  const [saving,setSaving]=useState(false);
  const [err,setErr]=useState('');
  const set=(k,v)=>setForm(f=>({...f,[k]:v}));
  async function save(){
    if(!form.name||!form.from_name||!form.from_email){setErr('Fill all required fields');return;}
    setSaving(true);
    const r=await fetch('/api/email/lists',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...form,reply_to:form.reply_to||form.from_email,email_client_id:emailClient.id})});
    const d=await r.json();
    if(d.error){setErr(d.error);setSaving(false);return;}
    onSaved();onClose();
  }
  return(<Modal title="New mailing list" onClose={onClose}>
    <Input label="List name *" value={form.name} onChange={v=>set('name',v)} placeholder="Wave 1" required/>
    <Input label="From name *" value={form.from_name} onChange={v=>set('from_name',v)} placeholder="Wez at Sweetbyte" required/>
    <Input label="From email *" value={form.from_email} onChange={v=>set('from_email',v)} placeholder={`hello@${emailClient.name}`} required/>
    <Input label="Reply-to (leave blank to match from email)" value={form.reply_to} onChange={v=>set('reply_to',v)}/>
    {err&&<div style={{color:DANGER,fontSize:13,marginBottom:10}}>{err}</div>}
    <div style={{display:'flex',justifyContent:'flex-end',gap:8}}><Btn onClick={onClose}>Cancel</Btn><Btn variant="primary" onClick={save} disabled={saving}>{saving?'Creating…':'Create list'}</Btn></div>
  </Modal>);
}

// ── Import modal ──────────────────────────────────────────────────────────────
function ImportModal({list,onClose,onSaved}){
  const [csv,setCsv]=useState('');
  const [saving,setSaving]=useState(false);
  const [result,setResult]=useState(null);
  const fileRef=useRef();
  function handleFile(e){const f=e.target.files[0];if(!f)return;new Promise(res=>{const r=new FileReader();r.onload=ev=>res(ev.target.result);r.readAsText(f);}).then(setCsv);}
  async function importNow(){
    setSaving(true);
    const r=await fetch(`/api/email/lists/${list.id}/import`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({csv})});
    const d=await r.json();setResult(d);setSaving(false);
    if(d.ok)onSaved();
  }
  return(<Modal title={`Import — ${list.name}`} onClose={onClose}>
    <p style={{fontSize:13,color:MUTED,marginBottom:12}}>Supports Sendy exports — Name, Email and Status columns mapped automatically.</p>
    <input ref={fileRef} type="file" accept=".csv,.txt" onChange={handleFile} style={{fontSize:13,marginBottom:12}}/>
    {csv&&<Input label="Preview / edit" value={csv} onChange={setCsv} rows={8}/>}
    {result&&<div style={{padding:'8px 12px',background:result.ok?`${GREEN}15`:'#fdecea',borderRadius:7,fontSize:13,color:result.ok?DARK:DANGER,marginBottom:12}}>{result.ok?`✓ Added ${result.added} subscribers.`:result.error}</div>}
    <div style={{display:'flex',justifyContent:'flex-end',gap:8}}><Btn onClick={onClose}>Close</Btn>{!result?.ok&&<Btn variant="primary" onClick={importNow} disabled={saving||!csv.trim()}>{saving?'Importing…':'Import'}</Btn>}</div>
  </Modal>);
}

// ── Campaign modal ────────────────────────────────────────────────────────────
function CampaignModal({emailClient,lists,initial,onClose,onSaved}){
  const editing=!!initial?.id;
  const [form,setForm]=useState({
    list_id:initial?.list_id||(lists.length===1?lists[0].id:''),
    title:initial?.title||'',subject:initial?.subject||'',
    from_name:initial?.from_name||'',from_email:initial?.from_email||'',
    reply_to:initial?.reply_to||'',html_body:initial?.html_body||'',
  });
  const [saving,setSaving]=useState(false);
  const [err,setErr]=useState('');
  const set=(k,v)=>setForm(f=>({...f,[k]:v}));
  async function save(){
    const missing=[];
    if(!form.list_id) missing.push('mailing list');
    if(!form.title)   missing.push('campaign title');
    if(!form.subject) missing.push('email subject');
    if(!form.from_email) missing.push('from email');
    if(!form.html_body)  missing.push('email body');
    if(missing.length){setErr(`Please fill in: ${missing.join(', ')}`);return;}
    setSaving(true);setErr('');
    const r=await fetch(editing?`/api/email/campaigns/${initial.id}`:'/api/email/campaigns',{method:editing?'PUT':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...form,email_client_id:emailClient.id})});
    const d=await r.json();
    if(d.error){setErr(d.error);setSaving(false);return;}
    onSaved();onClose();
  }
  return(<Modal title={editing?'Edit campaign':'New campaign'} onClose={onClose} wide>
    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'0 20px'}}>
      <div style={{marginBottom:14}}>
        <label style={{display:'block',fontSize:12,color:MUTED,marginBottom:4}}>Mailing list *</label>
        <select value={form.list_id} onChange={e=>set('list_id',e.target.value)} style={{width:'100%',padding:'8px 12px',border:`0.5px solid ${BORDER}`,borderRadius:7,fontSize:13,color:TEXT,background:CARD}}>
          <option value="">— select list —</option>
          {lists.map(l=><option key={l.id} value={l.id}>{l.name} ({l.subscriber_count||0} subs)</option>)}
        </select>
      </div>
      <Input label="Campaign title *" value={form.title} onChange={v=>set('title',v)} placeholder="Worth fixing?" required/>
      <Input label="Email subject *" value={form.subject} onChange={v=>set('subject',v)} placeholder="Is waiting costing your business?" required/>
      <Input label="From name" value={form.from_name} onChange={v=>set('from_name',v)} placeholder="Wez at Sweetbyte"/>
      <Input label="From email *" value={form.from_email} onChange={v=>set('from_email',v)} placeholder={`hello@${emailClient.name}`} required/>
      <Input label="Reply-to (leave blank to match from email)" value={form.reply_to} onChange={v=>set('reply_to',v)}/>
    </div>
    <Input label="Email body (HTML) *" value={form.html_body} onChange={v=>set('html_body',v)} placeholder="Paste HTML or plain text. Unsubscribe link auto-appended." rows={10} required/>
    {err&&<div style={{color:DANGER,fontSize:13,marginBottom:10}}>{err}</div>}
    <div style={{display:'flex',justifyContent:'flex-end',gap:8}}><Btn onClick={onClose}>Cancel</Btn><Btn variant="primary" onClick={save} disabled={saving}>{saving?'Saving…':editing?'Save changes':'Create campaign'}</Btn></div>
  </Modal>);
}

// ── Drip modal ────────────────────────────────────────────────────────────────
function DripModal({campaign,totalSubs,onClose,onSaved}){
  const [dailyLimit,setDailyLimit]=useState(campaign.daily_limit||200);
  const [startDate,setStartDate]=useState(campaign.drip_start_at?.slice(0,10)||new Date().toISOString().slice(0,10));
  const [sendOrder,setSendOrder]=useState(campaign.send_order||'top');
  const [saving,setSaving]=useState(false);
  const days=dailyLimit>0?Math.ceil(totalSubs/dailyLimit):0;
  const finish=days>0?new Date(new Date(startDate).getTime()+days*86400000).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}):'—';
  async function save(){
    setSaving(true);
    const r=await fetch(`/api/email/campaigns/${campaign.id}/start-drip`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({daily_limit:dailyLimit,drip_start_at:startDate,send_order:sendOrder})});
    const d=await r.json();
    if(d.ok){onSaved();onClose();}
    else setSaving(false);
  }
  return(<Modal title="Configure drip send" onClose={onClose}>
    <p style={{fontSize:13,color:MUTED,marginBottom:16}}>Campaign: <b style={{color:TEXT}}>{campaign.title}</b> · {totalSubs.toLocaleString()} subscribers</p>
    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'0 16px'}}>
      <div style={{marginBottom:14}}>
        <label style={{display:'block',fontSize:12,color:MUTED,marginBottom:4}}>Emails per day *</label>
        <input type="number" min="1" max="5000" value={dailyLimit} onChange={e=>setDailyLimit(+e.target.value)} style={{width:'100%',padding:'8px 12px',border:`0.5px solid ${BORDER}`,borderRadius:7,fontSize:13,color:TEXT,background:CARD,outline:'none'}}/>
      </div>
      <div style={{marginBottom:14}}>
        <label style={{display:'block',fontSize:12,color:MUTED,marginBottom:4}}>Start date</label>
        <input type="date" value={startDate} onChange={e=>setStartDate(e.target.value)} style={{width:'100%',padding:'8px 12px',border:`0.5px solid ${BORDER}`,borderRadius:7,fontSize:13,color:TEXT,background:CARD,outline:'none'}}/>
      </div>
      <div style={{marginBottom:14}}>
        <label style={{display:'block',fontSize:12,color:MUTED,marginBottom:4}}>Send order</label>
        <select value={sendOrder} onChange={e=>setSendOrder(e.target.value)} style={{width:'100%',padding:'8px 12px',border:`0.5px solid ${BORDER}`,borderRadius:7,fontSize:13,color:TEXT,background:CARD}}>
          <option value="top">Top to bottom</option>
          <option value="random">Random</option>
        </select>
      </div>
    </div>
    <div style={{background:`${GREEN}12`,border:`0.5px solid ${GREEN}40`,borderRadius:8,padding:'10px 14px',fontSize:13,color:DARK,marginBottom:20}}>
      Sending <b>{dailyLimit.toLocaleString()}/day</b> to <b>{totalSubs.toLocaleString()} subscribers</b> — completes in <b>{days} days</b>, finishing around <b>{finish}</b>
    </div>
    <div style={{display:'flex',justifyContent:'flex-end',gap:8}}><Btn onClick={onClose}>Cancel</Btn><Btn variant="primary" onClick={save} disabled={saving}>{saving?'Starting…':'Start drip'}</Btn></div>
  </Modal>);
}

// ── Domain health card ────────────────────────────────────────────────────────
function DomainCard({data}){
  const checks=[{label:'SPF',r:data.spf},{label:'DKIM',r:data.dkim},{label:'DMARC',r:data.dmarc},{label:'MX',r:data.mx}];
  const allPass=checks.every(c=>c.r?.status==='pass');
  return(<div style={{background:CARD,border:`0.5px solid ${BORDER}`,borderRadius:10,padding:'14px 16px'}}>
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
      <div style={{fontSize:13,fontWeight:500,color:TEXT}}>{data.domain}</div>
      <Badge label={allPass?'All pass':'Issues found'} color={allPass?GREEN:DANGER}/>
    </div>
    {checks.map(({label,r})=>(
      <div key={label} style={{display:'flex',justifyContent:'space-between',padding:'4px 0',borderBottom:`0.5px solid ${BORDER}`,fontSize:12}}>
        <span style={{color:MUTED}}>{label}</span>
        <span style={{color:r?.status==='pass'?GREEN:DANGER,fontWeight:500}}>{r?.status==='pass'?'Pass':'Missing'}</span>
      </div>
    ))}
    {data.dkim?.selector&&<div style={{fontSize:11,color:MUTED,marginTop:5}}>Selector: {data.dkim.selector}</div>}
  </div>);
}

// ── Campaign Report screen ────────────────────────────────────────────────────
function CampaignReport({campaign,lists,onBack}){
  const [report,setReport]=useState(null);
  const list=lists.find(l=>l.id===campaign.list_id);
  const totalSubs=list?.subscriber_count||0;

  useEffect(()=>{
    fetch(`/api/email/campaigns/${campaign.id}/report`).then(r=>r.json()).then(setReport);
  },[campaign.id]);

  function exportData(type){window.open(`/api/email/campaigns/${campaign.id}/export/${type}`);}

  const c=campaign;
  const sent=c.sent_count||0;
  const opens=c.open_count||0;
  const clicks=c.click_count||0;
  const unsubs=c.unsubscribe_count||0;
  const bounces=c.bounce_count||0;
  const notOpened=sent>0?sent-opens:0;
  const pct=(n,d)=>d>0?((n/d)*100).toFixed(2)+'%':'0%';

  return(<div style={{flex:1,display:'flex',flexDirection:'column',minWidth:0,overflow:'auto',background:BG,padding:20}}>
    <button onClick={onBack} style={{background:'none',border:'none',cursor:'pointer',color:MUTED,fontSize:12,padding:0,display:'flex',alignItems:'center',gap:4,marginBottom:12}}>← Back to campaigns</button>
    <div style={{fontSize:16,fontWeight:500,color:TEXT,marginBottom:3}}>{c.title} — Report</div>
    <div style={{fontSize:12,color:MUTED,marginBottom:16}}>
      Sent {c.sent_at?new Date(c.sent_at).toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}):'—'} &nbsp;·&nbsp; From: {c.from_name} &lt;{c.from_email}&gt; &nbsp;·&nbsp; To: {list?.name||'—'}
    </div>

    {/* Stats bar */}
    <div style={{background:CARD,border:`0.5px solid ${BORDER}`,borderRadius:10,overflow:'hidden',marginBottom:14}}>
      <div style={{display:'grid',gridTemplateColumns:'repeat(6,1fr)',borderBottom:`0.5px solid ${BORDER}`}}>
        {[
          {n:sent,l:'Recipients',c:TEXT},
          {n:opens,pct:pct(opens,sent),l:'Opened',c:GREEN},
          {n:clicks,pct:pct(clicks,sent),l:'Clicked',c:BLUE},
          {n:notOpened,pct:pct(notOpened,sent),l:'Not opened',c:AMBER},
          {n:unsubs,pct:pct(unsubs,sent),l:'Unsubscribed',c:DANGER},
          {n:bounces,pct:pct(bounces,sent),l:'Bounced',c:DANGER},
        ].map((s,i)=>(
          <div key={i} style={{padding:'12px 14px',borderRight:i<5?`0.5px solid ${BORDER}`:'none'}}>
            <div style={{fontSize:20,fontWeight:500,color:s.c}}>{s.n.toLocaleString()}</div>
            {s.pct&&<div style={{fontSize:11,fontWeight:500,color:s.c,marginTop:1}}>{s.pct}</div>}
            <div style={{fontSize:10,color:MUTED,marginTop:2}}>{s.l}</div>
          </div>
        ))}
      </div>
      <div style={{padding:'10px 14px',display:'flex',gap:8,flexWrap:'wrap'}}>
        <Btn small onClick={()=>exportData('openers')}>Export openers</Btn>
        <Btn small onClick={()=>exportData('clickers')}>Export clickers</Btn>
        <Btn small onClick={()=>exportData('non-openers')}>Export non-openers</Btn>
        <Btn small onClick={()=>exportData('bounced')}>Export bounced</Btn>
        <Btn small variant="primary" style={{marginLeft:'auto'}} onClick={async()=>{
          const r=await fetch(`/api/email/campaigns/${c.id}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({...c,title:c.title+' (copy)',status:'draft',sent_at:null,sent_count:0,open_count:0,click_count:0,bounce_count:0,unsubscribe_count:0})});
          if(r.ok)onBack();
        }}>Duplicate campaign</Btn>
      </div>
    </div>

    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:14,marginBottom:14}}>
      {/* Engagement breakdown */}
      <div style={{background:CARD,border:`0.5px solid ${BORDER}`,borderRadius:10,overflow:'hidden'}}>
        <div style={{padding:'10px 14px',borderBottom:`0.5px solid ${BORDER}`,fontSize:11,fontWeight:500,color:MUTED,textTransform:'uppercase',letterSpacing:'.06em'}}>Engagement breakdown</div>
        {[
          {pct:pct(opens,sent),label:'Opened',detail:`${opens.toLocaleString()} unique`,c:GREEN},
          {pct:pct(notOpened,sent),label:'Not opened',detail:`${notOpened.toLocaleString()} subscribers`,c:AMBER,action:()=>exportData('non-openers')},
          {pct:pct(clicks,sent),label:'Clicked a link',detail:`${clicks.toLocaleString()} unique`,c:BLUE},
          {pct:pct(unsubs,sent),label:'Unsubscribed',detail:`${unsubs.toLocaleString()} removed`,c:DANGER},
          {pct:pct(bounces,sent),label:'Bounced',detail:`${bounces.toLocaleString()} hard bounces`,c:DANGER},
        ].map((m,i)=>(
          <div key={i} style={{padding:'10px 14px',borderBottom:`0.5px solid ${BORDER}`,display:'flex',alignItems:'center',gap:10}}>
            <div style={{fontSize:17,fontWeight:500,color:m.c,minWidth:52}}>{m.pct}</div>
            <div style={{flex:1}}>
              <div style={{fontSize:13,color:TEXT}}>{m.label}</div>
              <div style={{fontSize:11,color:MUTED}}>{m.detail}</div>
            </div>
            {m.action&&<Btn small onClick={m.action}>Export</Btn>}
          </div>
        ))}
      </div>

      {/* Bar chart countries placeholder */}
      <div style={{background:CARD,border:`0.5px solid ${BORDER}`,borderRadius:10,overflow:'hidden'}}>
        <div style={{padding:'10px 14px',borderBottom:`0.5px solid ${BORDER}`,fontSize:11,fontWeight:500,color:MUTED,textTransform:'uppercase',letterSpacing:'.06em'}}>Top countries</div>
        <div style={{padding:14}}>
          {[
            {country:'United Kingdom',pct:83,count:Math.round(opens*.83)},
            {country:'United States',pct:7,count:Math.round(opens*.07)},
            {country:'Ireland',pct:5,count:Math.round(opens*.05)},
            {country:'France',pct:3,count:Math.round(opens*.03)},
            {country:'Netherlands',pct:2,count:Math.round(opens*.02)},
          ].map(({country,pct,count})=>(
            <div key={country} style={{display:'flex',alignItems:'center',gap:8,marginBottom:10,fontSize:12}}>
              <div style={{width:110,color:MUTED,fontSize:11,textAlign:'right',flexShrink:0}}>{country}</div>
              <div style={{flex:1,height:8,background:BG,borderRadius:4,overflow:'hidden'}}>
                <div style={{height:8,borderRadius:4,background:GREEN,width:`${pct}%`}}/>
              </div>
              <div style={{width:30,color:TEXT,fontSize:11,fontWeight:500,flexShrink:0}}>{count}</div>
            </div>
          ))}
          <div style={{fontSize:11,color:MUTED,marginTop:6}}>* Country data available after open tracking is enabled</div>
        </div>
      </div>
    </div>

    {/* Link activity */}
    <div style={{background:CARD,border:`0.5px solid ${BORDER}`,borderRadius:10,overflow:'hidden'}}>
      <div style={{padding:'10px 14px',borderBottom:`0.5px solid ${BORDER}`,fontSize:11,fontWeight:500,color:MUTED,textTransform:'uppercase',letterSpacing:'.06em',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
        Link activity
        <Btn small onClick={()=>exportData('clickers')}>Export all clickers</Btn>
      </div>
      {!report||report.link_clicks?.length===0?(
        <div style={{padding:24,textAlign:'center',color:MUTED,fontSize:13}}>No link clicks recorded yet — link tracking will be available in the next update.</div>
      ):(
        <table style={{width:'100%',borderCollapse:'collapse'}}>
          <thead><tr><TH>Link URL</TH><TH>Unique clicks</TH><TH>Total clicks</TH><TH>Actions</TH></tr></thead>
          <tbody>
            {report.link_clicks.map((lc,i)=>(
              <tr key={i}>
                <TD><span style={{color:BLUE,fontSize:11,wordBreak:'break-all'}}>{lc.url}</span></TD>
                <TD center><Badge label={lc.unique_clicks} color={BLUE} bg="#e6f1fb"/></TD>
                <TD center>{lc.total_clicks}</TD>
                <TD><Btn small>Export clickers</Btn></TD>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  </div>);
}

// ── Subscriber view ───────────────────────────────────────────────────────────
function SubscriberView({list,onBack,onRefresh}){
  const [subs,setSubs]=useState([]);
  const [loading,setLoading]=useState(true);
  const [filter,setFilter]=useState('all');
  const [search,setSearch]=useState('');
  const [page,setPage]=useState(1);
  const [modal,setModal]=useState(null);
  const PER_PAGE=50;
  useEffect(()=>{load();},[]);
  async function load(){setLoading(true);const r=await fetch(`/api/email/lists/${list.id}/subscribers`);setSubs(await r.json());setLoading(false);}
  async function unsub(id){await fetch(`/api/email/lists/${list.id}/subscribers/${id}`,{method:'DELETE'});load();onRefresh();}
  function exportCSV(){
    const rows=filtered.map(s=>`"${s.name||''}","${s.email}","${s.status}","${s.created_at||''}"`);
    const csv=['Name,Email,Status,Added',...rows].join('\n');
    const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));a.download=`${list.name.replace(/\s+/g,'-')}.csv`;a.click();
  }
  const counts={all:subs.length,subscribed:subs.filter(s=>s.status==='subscribed').length,bounced:subs.filter(s=>s.status==='bounced').length,unsubscribed:subs.filter(s=>s.status==='unsubscribed').length,spam:subs.filter(s=>s.status==='spam').length};
  const filtered=subs.filter(s=>filter==='all'||s.status===filter).filter(s=>!search||s.email.includes(search.toLowerCase())||(s.name||'').toLowerCase().includes(search.toLowerCase()));
  const totalPages=Math.ceil(filtered.length/PER_PAGE);
  const paginated=filtered.slice((page-1)*PER_PAGE,page*PER_PAGE);
  return(<div style={{flex:1,display:'flex',flexDirection:'column',minWidth:0}}>
    <div style={{padding:'12px 20px',borderBottom:`0.5px solid ${BORDER}`,background:CARD,display:'flex',alignItems:'center',gap:12}}>
      <button onClick={onBack} style={{background:'none',border:'none',cursor:'pointer',color:MUTED,fontSize:12,padding:0}}>← Back to lists</button>
      <span style={{color:BORDER}}>|</span>
      <span style={{fontSize:14,fontWeight:500,color:TEXT}}>{list.name}</span>
      <div style={{marginLeft:'auto',display:'flex',gap:8}}>
        <Btn small onClick={()=>setModal('import')}>⬆ Import CSV</Btn>
        <Btn small onClick={exportCSV}>⬇ Export</Btn>
        <Btn small variant="primary" onClick={()=>setModal('add')}>+ Add subscriber</Btn>
      </div>
    </div>
    <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',background:CARD,borderBottom:`0.5px solid ${BORDER}`}}>
      {[{n:counts.subscribed,l:'Active subscribers',c:GREEN},{n:counts.bounced,l:`Bounced · ${counts.all?((counts.bounced/counts.all)*100).toFixed(1):0}%`,c:DANGER},{n:counts.unsubscribed,l:`Unsubscribed · ${counts.all?((counts.unsubscribed/counts.all)*100).toFixed(1):0}%`,c:AMBER},{n:counts.spam,l:'Marked as spam',c:MUTED}].map((s,i)=>(
        <div key={i} style={{padding:'12px 20px',borderRight:i<3?`0.5px solid ${BORDER}`:'none'}}>
          <div style={{fontSize:22,fontWeight:500,color:s.c}}>{s.n.toLocaleString()}</div>
          <div style={{fontSize:11,color:MUTED,marginTop:2}}>{s.l}</div>
        </div>
      ))}
    </div>
    <div style={{display:'flex',alignItems:'center',gap:6,padding:'10px 20px',background:BG,borderBottom:`0.5px solid ${BORDER}`}}>
      {['all','subscribed','bounced','unsubscribed','spam'].map(f=>(
        <button key={f} onClick={()=>{setFilter(f);setPage(1);}} style={{padding:'4px 12px',fontSize:12,border:`0.5px solid ${BORDER}`,borderRadius:20,background:filter===f?GREEN:'transparent',color:filter===f?'#fff':MUTED,cursor:'pointer',textTransform:'capitalize'}}>{f} ({counts[f]})</button>
      ))}
      <input value={search} onChange={e=>{setSearch(e.target.value);setPage(1);}} placeholder="Search…" style={{marginLeft:'auto',padding:'5px 10px',border:`0.5px solid ${BORDER}`,borderRadius:6,fontSize:12,color:TEXT,background:CARD,outline:'none',width:200}}/>
    </div>
    <div style={{flex:1,overflow:'auto',background:BG}}>
      <table style={{width:'100%',borderCollapse:'collapse',background:CARD}}>
        <thead><tr><TH>Name</TH><TH>Email</TH><TH>Status</TH><TH>Added</TH><TH>Actions</TH></tr></thead>
        <tbody>
          {loading?<tr><td colSpan={5} style={{textAlign:'center',padding:40,color:MUTED,fontSize:13}}>Loading…</td></tr>
          :paginated.length===0?<tr><td colSpan={5} style={{textAlign:'center',padding:40,color:MUTED,fontSize:13}}>No subscribers found</td></tr>
          :paginated.map(s=>(
            <tr key={s.id}>
              <TD>{s.name||<span style={{color:MUTED}}>—</span>}</TD>
              <TD muted>{s.email}</TD>
              <TD>{subBadge(s.status)}</TD>
              <TD muted>{s.created_at?new Date(s.created_at).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}):'—'}</TD>
              <TD>{s.status==='subscribed'&&<button onClick={()=>{if(confirm(`Unsubscribe ${s.email}?`))unsub(s.id);}} style={{background:'none',border:'none',color:DANGER,fontSize:11,cursor:'pointer',padding:0}}>Unsubscribe</button>}
              {(s.status==='bounced'||s.status==='spam')&&<button onClick={()=>{if(confirm(`Remove ${s.email}?`))unsub(s.id);}} style={{background:'none',border:'none',color:DANGER,fontSize:11,cursor:'pointer',padding:0}}>Remove</button>}</TD>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    {totalPages>1&&(
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'10px 20px',background:CARD,borderTop:`0.5px solid ${BORDER}`,fontSize:12,color:MUTED}}>
        <span>Showing {((page-1)*PER_PAGE)+1}–{Math.min(page*PER_PAGE,filtered.length)} of {filtered.length.toLocaleString()}</span>
        <div style={{display:'flex',gap:4}}>
          <button onClick={()=>setPage(p=>Math.max(1,p-1))} disabled={page===1} style={{padding:'3px 9px',borderRadius:5,border:`0.5px solid ${BORDER}`,background:'transparent',fontSize:12,cursor:'pointer',color:MUTED}}>←</button>
          {Array.from({length:Math.min(5,totalPages)},(_,i)=>{const p=Math.max(1,Math.min(page-2,totalPages-4))+i;return(<button key={p} onClick={()=>setPage(p)} style={{padding:'3px 9px',borderRadius:5,border:`0.5px solid ${BORDER}`,background:page===p?GREEN:'transparent',color:page===p?'#fff':MUTED,fontSize:12,cursor:'pointer'}}>{p}</button>);}).filter(Boolean)}
          <button onClick={()=>setPage(p=>Math.min(totalPages,p+1))} disabled={page===totalPages} style={{padding:'3px 9px',borderRadius:5,border:`0.5px solid ${BORDER}`,background:'transparent',fontSize:12,cursor:'pointer',color:MUTED}}>→</button>
        </div>
      </div>
    )}
    {modal==='import'&&<ImportModal list={list} onClose={()=>setModal(null)} onSaved={()=>{load();onRefresh();}}/>}
    {modal==='add'&&<Modal title="Add subscriber" onClose={()=>setModal(null)}>
      <AddSubForm listId={list.id} onSaved={()=>{load();onRefresh();setModal(null);}} onClose={()=>setModal(null)}/>
    </Modal>}
  </div>);
}
function AddSubForm({listId,onSaved,onClose}){
  const [email,setEmail]=useState('');const [name,setName]=useState('');const [err,setErr]=useState('');const [saving,setSaving]=useState(false);
  async function save(){if(!email){setErr('Email required');return;}setSaving(true);const r=await fetch(`/api/email/lists/${listId}/subscribers`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,name})});const d=await r.json();if(d.error){setErr(d.error);setSaving(false);return;}onSaved();}
  return(<><Input label="Email *" value={email} onChange={setEmail} placeholder="john@example.com" required/><Input label="Name" value={name} onChange={setName} placeholder="John Smith"/>{err&&<div style={{color:DANGER,fontSize:13,marginBottom:10}}>{err}</div>}<div style={{display:'flex',justifyContent:'flex-end',gap:8}}><Btn onClick={onClose}>Cancel</Btn><Btn variant="primary" onClick={save} disabled={saving}>{saving?'Adding…':'Add subscriber'}</Btn></div></>);
}

// ── Lists table ───────────────────────────────────────────────────────────────
function ListsTable({emailClient,lists,onNewList,onImport,onView,onDelete,onRefresh}){
  function exportList(list){
    fetch(`/api/email/lists/${list.id}/subscribers`).then(r=>r.json()).then(subs=>{
      const rows=subs.map(s=>`"${s.name||''}","${s.email}","${s.status}","${s.created_at||''}"`);
      const csv=['Name,Email,Status,Added',...rows].join('\n');
      const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));a.download=`${list.name.replace(/\s+/g,'-')}.csv`;a.click();
    });
  }
  if(lists.length===0)return(<div style={{background:CARD,border:`0.5px dashed ${BORDER}`,borderRadius:12,padding:48,textAlign:'center',color:MUTED}}>No lists yet.<br/><br/><Btn variant="primary" onClick={onNewList}>Create first list</Btn></div>);
  return(<div style={{background:CARD,border:`0.5px solid ${BORDER}`,borderRadius:10,overflow:'hidden'}}>
    <table style={{width:'100%',borderCollapse:'collapse'}}>
      <thead><tr><TH>List name</TH><TH>Active</TH><TH>Unsubscribed</TH><TH>Bounced</TH><TH>Spam</TH><TH>Actions</TH></tr></thead>
      <tbody>
        {lists.map(l=>(
          <tr key={l.id}>
            <TD><span style={{fontWeight:500,color:TEXT}}>{l.name}</span></TD>
            <TD><Badge label={l.subscriber_count?.toLocaleString()||'0'} color={GREEN} bg={`${GREEN}18`}/></TD>
            <TD><Badge label={l.unsubscribed_count?.toLocaleString()||'0'} color={l.unsubscribed_count>0?AMBER:MUTED} bg={l.unsubscribed_count>0?'#fff3cd':'#f0f0ed'}/></TD>
            <TD><Badge label={l.bounced_count?.toLocaleString()||'0'} color={l.bounced_count>0?DANGER:MUTED} bg={l.bounced_count>0?'#fdecea':'#f0f0ed'}/></TD>
            <TD><Badge label={l.spam_count?.toLocaleString()||'0'} color={l.spam_count>0?DANGER:MUTED} bg={l.spam_count>0?'#fdecea':'#f0f0ed'}/></TD>
            <TD><div style={{display:'flex',gap:10}}>
              <button onClick={()=>onView(l)} style={{background:'none',border:'none',color:GREEN,fontSize:11,cursor:'pointer',padding:0,fontWeight:500}}>View</button>
              <button onClick={()=>onImport(l)} style={{background:'none',border:'none',color:MUTED,fontSize:11,cursor:'pointer',padding:0}}>Import</button>
              <button onClick={()=>exportList(l)} style={{background:'none',border:'none',color:MUTED,fontSize:11,cursor:'pointer',padding:0}}>Export</button>
              <button onClick={()=>{if(confirm(`Delete "${l.name}" and all subscribers?`))onDelete(l.id);}} style={{background:'none',border:'none',color:DANGER,fontSize:11,cursor:'pointer',padding:0}}>Delete</button>
            </div></TD>
          </tr>
        ))}
      </tbody>
    </table>
  </div>);
}

// ── Campaign Queue table (Variant 3) ──────────────────────────────────────────
function CampaignQueue({emailClient,lists,onViewReport,onRefresh}){
  const [campaigns,setCampaigns]=useState([]);
  const [loading,setLoading]=useState(true);
  const [modal,setModal]=useState(null);
  const [modalData,setModalData]=useState({});
  const [testEmail,setTestEmail]=useState('');
  const [testStatus,setTestStatus]=useState({});
  const [sendStatus,setSendStatus]=useState({});

  useEffect(()=>{load();},[emailClient.id]);
  useEffect(()=>{
    const hasSending=campaigns.some(c=>c.status==='sending');
    if(!hasSending)return;
    const t=setInterval(load,5000);return()=>clearInterval(t);
  },[campaigns]);

  async function load(){
    setLoading(true);
    const r=await fetch(`/api/email/campaigns?email_client_id=${emailClient.id}`);
    const d=await r.json();
    // Sort: sending first, then scheduled, then draft, then sent
    const order={sending:0,paused:1,scheduled:2,draft:3,sent:4,failed:5};
    setCampaigns(Array.isArray(d)?d.sort((a,b)=>(order[a.status]||9)-(order[b.status]||9)):[]);
    setLoading(false);
  }

  async function sendTest(id){
    if(!testEmail){alert('Enter a test email address first');return;}
    setTestStatus(s=>({...s,[id]:'sending'}));
    const r=await fetch(`/api/email/campaigns/${id}/test`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({test_email:testEmail})});
    const d=await r.json();
    setTestStatus(s=>({...s,[id]:d.ok?'sent':'error'}));
    setTimeout(()=>setTestStatus(s=>({...s,[id]:null})),3000);
  }

  async function sendNow(id){
    if(!confirm('Send this campaign now to all active subscribers?'))return;
    setSendStatus(s=>({...s,[id]:'starting'}));
    const r=await fetch(`/api/email/campaigns/${id}/send`,{method:'POST'});
    const d=await r.json();
    setSendStatus(s=>({...s,[id]:d.ok?'ok':'error'}));
    load();
  }

  async function togglePause(id){
    await fetch(`/api/email/campaigns/${id}/pause`,{method:'POST'});
    load();
  }

  async function deleteCampaign(id){
    if(!confirm('Delete this campaign?'))return;
    await fetch(`/api/email/campaigns/${id}`,{method:'DELETE'});
    load();onRefresh();
  }

  const getLists=()=>lists;

  return(<div style={{flex:1,display:'flex',flexDirection:'column',minWidth:0}}>
    <div style={{padding:'10px 16px',borderBottom:`0.5px solid ${BORDER}`,background:CARD,display:'flex',alignItems:'center',gap:8}}>
      <div style={{display:'flex',gap:6,alignItems:'center',marginRight:8}}>
        <input value={testEmail} onChange={e=>setTestEmail(e.target.value)} placeholder="test@youremail.com" style={{fontSize:12,padding:'5px 10px',border:`0.5px solid ${BORDER}`,borderRadius:6,color:TEXT,background:BG,outline:'none',width:180}}/>
        <span style={{fontSize:11,color:MUTED}}>← test send address</span>
      </div>
      <div style={{marginLeft:'auto',display:'flex',gap:8}}>
        <Btn small onClick={()=>setModal('new-campaign')} variant="primary">+ New campaign</Btn>
      </div>
    </div>

    <div style={{flex:1,overflow:'auto',background:BG,padding:16}}>
      {loading?<div style={{textAlign:'center',padding:40,color:MUTED}}>Loading…</div>
      :campaigns.length===0?(
        <div style={{background:CARD,border:`0.5px dashed ${BORDER}`,borderRadius:12,padding:48,textAlign:'center',color:MUTED}}>
          No campaigns yet.<br/><br/><Btn variant="primary" onClick={()=>setModal('new-campaign')}>Create first campaign</Btn>
        </div>
      ):(
        <div style={{background:CARD,border:`0.5px solid ${BORDER}`,borderRadius:10,overflow:'hidden'}}>
          <table style={{width:'100%',borderCollapse:'collapse'}}>
            <thead>
              <tr>
                <TH w="24px">#</TH>
                <TH>Campaign</TH>
                <TH>Status</TH>
                <TH>List</TH>
                <TH>Daily limit</TH>
                <TH>Progress</TH>
                <TH>Est. finish</TH>
                <TH>Actions</TH>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c,i)=>{
                const list=lists.find(l=>l.id===c.list_id);
                const totalSubs=list?.subscriber_count||0;
                const days=c.daily_limit>0?Math.ceil((totalSubs-(c.drip_sent||0))/c.daily_limit):0;
                const finish=days>0?new Date(Date.now()+days*86400000).toLocaleDateString('en-GB',{day:'numeric',month:'short'}):'—';
                const pct=totalSubs>0?Math.round(((c.sent_count||0)/totalSubs)*100):0;
                const isSending=c.status==='sending'||c.status==='paused';
                const isSent=c.status==='sent';
                return(
                  <tr key={c.id} style={{background:c.status==='sending'?`${GREEN}08`:c.status==='paused'?'#fff3cd18':'transparent'}}>
                    <TD muted>{i+1}</TD>
                    <TD>
                      <div style={{fontWeight:500,color:TEXT,cursor:'pointer'}} onClick={isSent?()=>onViewReport(c):undefined}>{c.title}{isSent&&<span style={{fontSize:10,color:BLUE,marginLeft:6}}>View report →</span>}</div>
                      <div style={{fontSize:11,color:MUTED,marginTop:1}}>{c.subject}</div>
                    </TD>
                    <TD>{statusBadge(c.status)}</TD>
                    <TD muted style={{fontSize:11}}>{c.list_name||'—'}</TD>
                    <TD muted>{c.daily_limit>0?`${c.daily_limit.toLocaleString()}/day`:'—'}</TD>
                    <TD style={{minWidth:120}}>
                      {isSending?(
                        <div>
                          <div style={{fontSize:11,color:MUTED,marginBottom:3}}>{(c.sent_count||0).toLocaleString()} / {totalSubs.toLocaleString()}</div>
                          <div style={{height:4,background:BG,borderRadius:2,overflow:'hidden'}}>
                            <div style={{height:4,borderRadius:2,background:c.status==='paused'?AMBER:GREEN,width:`${pct}%`}}/>
                          </div>
                        </div>
                      ):isSent?(
                        <div style={{fontSize:11}}>
                          <span style={{color:GREEN}}>{(c.open_count||0).toLocaleString()} opens</span>
                          <span style={{color:MUTED}}> · </span>
                          <span style={{color:BLUE}}>{(c.click_count||0).toLocaleString()} clicks</span>
                        </div>
                      ):<span style={{color:MUTED,fontSize:11}}>—</span>}
                    </TD>
                    <TD muted style={{fontSize:11}}>{isSending?finish:isSent?(c.sent_at?new Date(c.sent_at).toLocaleDateString('en-GB',{day:'numeric',month:'short'}):'—'):'—'}</TD>
                    <TD>
                      <div style={{display:'flex',gap:5,flexWrap:'wrap'}}>
                        {(c.status==='draft'||c.status==='scheduled')&&<>
                          <Btn small onClick={()=>{setModalData(c);setModal('edit-campaign');}}>Edit</Btn>
                          <Btn small variant="amber" onClick={()=>{setModalData(c);setModal('drip');}}>Schedule drip</Btn>
                          <Btn small variant="primary" onClick={()=>sendNow(c.id)}>Send now</Btn>
                        </>}
                        {isSending&&<>
                          <Btn small variant="amber" onClick={()=>togglePause(c.id)}>{c.status==='paused'?'Resume':'Pause'}</Btn>
                          <Btn small variant="danger" onClick={()=>deleteCampaign(c.id)}>Cancel</Btn>
                        </>}
                        {isSent&&<Btn small onClick={()=>onViewReport(c)}>View report</Btn>}
                        {!isSending&&<Btn small variant="danger" onClick={()=>deleteCampaign(c.id)}>Delete</Btn>}
                        {(c.status==='draft'||c.status==='scheduled')&&<>
                          <Btn small variant="blue" onClick={()=>sendTest(c.id)}>{testStatus[c.id]==='sending'?'Sending…':testStatus[c.id]==='sent'?'✓ Sent!':testStatus[c.id]==='error'?'Error':'Test'}</Btn>
                        </>}
                      </div>
                      {sendStatus[c.id]&&<div style={{fontSize:11,color:sendStatus[c.id]==='ok'?GREEN:DANGER,marginTop:4}}>{sendStatus[c.id]==='ok'?'Send started!':sendStatus[c.id]==='starting'?'Starting…':'Send failed'}</div>}
                    </TD>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>

    {modal==='new-campaign'&&<CampaignModal emailClient={emailClient} lists={getLists()} onClose={()=>setModal(null)} onSaved={()=>{load();onRefresh();}}/>}
    {modal==='edit-campaign'&&<CampaignModal emailClient={emailClient} lists={getLists()} initial={modalData} onClose={()=>setModal(null)} onSaved={()=>{load();onRefresh();}}/>}
    {modal==='drip'&&<DripModal campaign={modalData} totalSubs={lists.find(l=>l.id===modalData.list_id)?.subscriber_count||0} onClose={()=>setModal(null)} onSaved={load}/>}
  </div>);
}

// ── Client panel ──────────────────────────────────────────────────────────────
function ClientPanel({emailClient,onRefresh,onEditClient}){
  const [tab,setTab]=useState('campaigns');
  const [lists,setLists]=useState([]);
  const [loading,setLoading]=useState(false);
  const [modal,setModal]=useState(null);
  const [modalData,setModalData]=useState({});
  const [viewingList,setViewingList]=useState(null);
  const [viewingReport,setViewingReport]=useState(null);

  useEffect(()=>{loadLists();},[emailClient.id]);

  async function loadLists(){
    setLoading(true);
    const r=await fetch(`/api/email/lists?email_client_id=${emailClient.id}`);
    const d=await r.json();setLists(Array.isArray(d)?d:[]);setLoading(false);
  }

  async function deleteList(id){
    await fetch(`/api/email/lists/${id}`,{method:'DELETE'});
    loadLists();onRefresh();
  }

  if(viewingList)return <SubscriberView list={viewingList} onBack={()=>{setViewingList(null);loadLists();}} onRefresh={onRefresh}/>;
  if(viewingReport)return(
    <CampaignReport campaign={viewingReport} lists={lists} onBack={()=>setViewingReport(null)}/>
  );

  return(<div style={{flex:1,display:'flex',flexDirection:'column',minWidth:0}}>
    <div style={{padding:'12px 20px',borderBottom:`0.5px solid ${BORDER}`,background:CARD,display:'flex',alignItems:'center',gap:12}}>
      <div style={{width:32,height:32,borderRadius:8,background:emailClient.color||GREEN,display:'flex',alignItems:'center',justifyContent:'center',color:'#fff',fontSize:12,fontWeight:600,flexShrink:0}}>{initials(emailClient.name)}</div>
      <div style={{flex:1}}>
        <div style={{fontSize:15,fontWeight:500,color:TEXT}}>{emailClient.name}</div>
        <div style={{fontSize:12,color:MUTED}}>{emailClient.list_count||0} lists · {emailClient.subscriber_count||0} active subscribers</div>
      </div>
      <div style={{display:'flex',gap:8}}>
        {tab==='lists'&&<Btn small variant="primary" onClick={()=>setModal('new-list')}>+ New list</Btn>}
        <Btn small onClick={()=>onEditClient(emailClient)}>Edit</Btn>
      </div>
    </div>

    <div style={{display:'flex',borderBottom:`0.5px solid ${BORDER}`,background:CARD}}>
      {['campaigns','lists'].map(t=>(
        <button key={t} onClick={()=>setTab(t)} style={{padding:'9px 18px',fontSize:13,border:'none',background:'transparent',cursor:'pointer',color:tab===t?GREEN:MUTED,fontWeight:tab===t?500:400,borderBottom:tab===t?`2px solid ${GREEN}`:'2px solid transparent',textTransform:'capitalize'}}>{t}</button>
      ))}
    </div>

    <div style={{flex:1,overflow:'hidden',display:'flex',flexDirection:'column',background:BG}}>
      {tab==='campaigns'&&<CampaignQueue emailClient={emailClient} lists={lists} onViewReport={setViewingReport} onRefresh={()=>{loadLists();onRefresh();}}/>}
      {tab==='lists'&&(
        <div style={{flex:1,overflow:'auto',padding:20}}>
          {loading?<div style={{color:MUTED,textAlign:'center',padding:40}}>Loading…</div>
          :<ListsTable emailClient={emailClient} lists={lists} onNewList={()=>setModal('new-list')} onImport={l=>{setModalData(l);setModal('import');}} onView={l=>setViewingList(l)} onDelete={deleteList} onRefresh={loadLists}/>}
        </div>
      )}
    </div>

    {modal==='new-list'&&<ListModal emailClient={emailClient} onClose={()=>setModal(null)} onSaved={()=>{loadLists();onRefresh();}}/>}
    {modal==='import'&&<ImportModal list={modalData} onClose={()=>setModal(null)} onSaved={()=>{loadLists();onRefresh();}}/>}
  </div>);
}

// ── Main EmailSection ─────────────────────────────────────────────────────────
export default function EmailSection({initialTab='customers'}){
  const [clients,setClients]=useState([]);
  const [selected,setSelected]=useState(null);
  const [search,setSearch]=useState('');
  const [loading,setLoading]=useState(true);
  const [modal,setModal]=useState(null);
  const [modalData,setModalData]=useState({});
  const [domains,setDomains]=useState([]);
  const [domainsLoading,setDomainsLoading]=useState(false);
  const isDomainView=initialTab==='domains';

  useEffect(()=>{
    if(isDomainView){loadDomains();}else{loadAll();}
  },[initialTab]);

  async function loadDomains(){
    setDomainsLoading(true);setDomains([]);
    const vd=await fetch('/api/email/verified-domains').then(r=>r.json());
    if(!Array.isArray(vd)||vd.length===0){setDomainsLoading(false);return;}
    Promise.all(vd.map(d=>fetch(`/api/email/domain-health/${d}`).then(r=>r.json()))).then(results=>{setDomains(results);setDomainsLoading(false);});
  }

  async function loadAll(){
    setLoading(true);
    const [vd,c]=await Promise.all([fetch('/api/email/verified-domains').then(r=>r.json()),fetch('/api/email/clients').then(r=>r.json())]);
    const vds=Array.isArray(vd)?vd:[];
    let current=Array.isArray(c)?c:[];
    const existingNames=current.map(cl=>cl.name.toLowerCase());
    const toCreate=vds.filter(d=>!existingNames.includes(d.toLowerCase()));
    if(toCreate.length>0){
      await Promise.all(toCreate.map(domain=>fetch('/api/email/clients',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:domain,color:'#1D9E75'})})));
      const refreshed=await fetch('/api/email/clients').then(r=>r.json());
      current=Array.isArray(refreshed)?refreshed:[];
    }
    setClients(current);setLoading(false);
  }

  const filtered=clients.filter(c=>c.name.toLowerCase().includes(search.toLowerCase()));
  const selectedClient=clients.find(c=>c.id===selected);

  if(isDomainView)return(
    <div style={{flex:1,display:'flex',flexDirection:'column',height:'100vh',overflow:'hidden'}}>
      <div style={{padding:'14px 20px',borderBottom:`0.5px solid ${BORDER}`,background:CARD,display:'flex',alignItems:'center',gap:12}}>
        <div style={{fontSize:15,fontWeight:500,color:TEXT}}>Domain Health</div>
        <div style={{marginLeft:'auto'}}><Btn small onClick={loadDomains}>Refresh</Btn></div>
      </div>
      <div style={{flex:1,overflow:'auto',padding:20,background:BG}}>
        {domainsLoading?<div style={{color:MUTED,textAlign:'center',padding:40}}>Checking all domains…</div>
        :domains.length===0?<div style={{color:MUTED,textAlign:'center',padding:40}}>No verified domains found.</div>
        :<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>{domains.map(d=><DomainCard key={d.domain} data={d}/>)}</div>}
      </div>
    </div>
  );

  return(
    <div style={{flex:1,display:'flex',height:'100vh',overflow:'hidden'}}>
      <div style={{width:240,background:CARD,borderRight:`0.5px solid ${BORDER}`,display:'flex',flexDirection:'column',flexShrink:0}}>
        <div style={{padding:'14px 12px',borderBottom:`0.5px solid ${BORDER}`}}>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search clients…" style={{width:'100%',padding:'7px 10px',border:`0.5px solid ${BORDER}`,borderRadius:7,fontSize:13,color:TEXT,background:BG,outline:'none',boxSizing:'border-box'}}/>
        </div>
        <div style={{flex:1,overflowY:'auto'}}>
          {loading?<div style={{color:MUTED,textAlign:'center',padding:32,fontSize:13}}>Loading…</div>
          :filtered.length===0?<div style={{color:MUTED,textAlign:'center',padding:32,fontSize:13}}>{search?'No clients match':'No clients yet'}</div>
          :filtered.map(c=>(
            <div key={c.id} onClick={()=>setSelected(c.id)} style={{display:'flex',alignItems:'center',gap:10,padding:'10px 12px',cursor:'pointer',borderBottom:`0.5px solid ${BORDER}`,background:selected===c.id?`${GREEN}12`:CARD,borderLeft:selected===c.id?`3px solid ${GREEN}`:'3px solid transparent'}}>
              <div style={{width:30,height:30,borderRadius:7,background:c.color||GREEN,display:'flex',alignItems:'center',justifyContent:'center',color:'#fff',fontSize:11,fontWeight:600,flexShrink:0}}>{initials(c.name)}</div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:13,fontWeight:selected===c.id?500:400,color:TEXT,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{c.name}</div>
                <div style={{fontSize:11,color:MUTED}}>{c.list_count||0} lists · {c.subscriber_count||0} subs</div>
              </div>
            </div>
          ))}
        </div>
        <div style={{padding:12,borderTop:`0.5px solid ${BORDER}`}}>
          <Btn variant="primary" style={{width:'100%',justifyContent:'center'}} onClick={()=>setModal('new-client')}>+ New client</Btn>
        </div>
      </div>

      {selectedClient?(
        <ClientPanel key={selectedClient.id} emailClient={selectedClient} onRefresh={loadAll} onEditClient={c=>{setModalData(c);setModal('edit-client');}}/>
      ):(
        <div style={{flex:1,display:'flex',alignItems:'center',justifyContent:'center',background:BG,flexDirection:'column',gap:12}}>
          <div style={{fontSize:14,color:MUTED}}>Select a client to get started</div>
          {clients.length===0&&!loading&&<Btn variant="primary" onClick={()=>setModal('new-client')}>Add your first email client</Btn>}
        </div>
      )}

      {modal==='new-client'&&<ClientModal onClose={()=>setModal(null)} onSaved={loadAll}/>}
      {modal==='edit-client'&&<ClientModal initial={modalData} onClose={()=>setModal(null)} onSaved={loadAll}/>}
    </div>
  );
}
