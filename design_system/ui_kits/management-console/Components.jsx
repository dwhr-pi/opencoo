function HeartbeatCard({ title, body, meta, audience='ceo · heartbeat' }) {
  return (
    <div style={{ border:'1px solid var(--rule)', borderRadius: 6, background:'var(--paper)', padding:'18px 20px', position:'relative' }}>
      <div style={{ position:'absolute', left:0, top:18, bottom:18, width:3, background:'oklch(0.74 0.13 70)', borderRadius:3 }}/>
      <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:8 }}>
        <Badge tone="adv">{audience}</Badge>
        <span style={{ marginLeft:'auto', fontFamily:'var(--font-mono)', fontSize:11, color:'var(--ink-3)', letterSpacing:'.06em' }}>{meta}</span>
      </div>
      <h3 style={{ fontFamily:'var(--font-sans)', fontWeight:500, fontSize:18, lineHeight:1.35, margin:'0 0 8px', color:'var(--ink)' }}>{title}</h3>
      <p style={{ fontSize:13.5, color:'var(--ink-2)', lineHeight:1.55, margin:0 }}>{body}</p>
    </div>
  );
}

function ReviewRow({ title, source, tone, onApprove, onReject, approved }) {
  return (
    <div style={{ display:'grid', gridTemplateColumns:'auto 1fr auto', gap:16, alignItems:'center', padding:'12px 16px', borderTop:'1px solid var(--rule)' }}>
      <Badge tone={tone}>{tone === 'adv' ? 'automation' : tone === 'alert' ? 'guard' : 'ingestion'}</Badge>
      <div>
        <div style={{ fontFamily:'var(--font-sans)', fontSize:14, color:'var(--ink)' }}>{title}</div>
        <div style={{ fontFamily:'var(--font-mono)', fontSize:11, color:'var(--ink-3)', letterSpacing:'.04em', marginTop:2 }}>{source}</div>
      </div>
      {approved
        ? <Badge tone="ok">approved</Badge>
        : <div style={{ display:'flex', gap:6 }}>
            <Btn variant="primary" onClick={onApprove} kbd="⏎">Approve</Btn>
            <Btn variant="ghost" onClick={onReject} kbd="⌫">Reject</Btn>
          </div>}
    </div>
  );
}

function WikiPeek({ path, children }) {
  return (
    <div style={{ border:'1px solid var(--rule)', borderRadius:6, background:'var(--paper)', overflow:'hidden' }}>
      <div style={{ padding:'10px 14px', background:'var(--paper-2)', borderBottom:'1px solid var(--rule)', fontFamily:'var(--font-mono)', fontSize:11, color:'var(--ink-3)' }}>
        {path}
      </div>
      <div style={{ padding:'14px 16px', fontSize:13, color:'var(--ink-2)', lineHeight:1.55 }}>{children}</div>
    </div>
  );
}

function SourceRow({ name, type, domain, mode, status }) {
  return (
    <div style={{ display:'grid', gridTemplateColumns:'1.4fr 1fr 1.2fr 1fr auto', gap:16, alignItems:'center', padding:'10px 16px', borderTop:'1px solid var(--rule)', fontFamily:'var(--font-mono)', fontSize:12 }}>
      <span style={{ color:'var(--ink)' }}>{name}</span>
      <span style={{ color:'var(--ink-3)' }}>{type}</span>
      <span style={{ color:'var(--ink-3)' }}>{domain}</span>
      <span style={{ color:'var(--ink-2)' }}>{mode}</span>
      <Badge tone={status === 'ok' ? 'ok' : status === 'alert' ? 'alert' : 'neutral'}>
        {status === 'ok' ? 'syncing' : status === 'alert' ? 'dlq 2' : 'paused'}
      </Badge>
    </div>
  );
}

Object.assign(window, { HeartbeatCard, ReviewRow, WikiPeek, SourceRow });
